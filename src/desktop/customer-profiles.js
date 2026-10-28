/**
 * Customer profiles: a named set of up to PROFILE_MAX_DOCUMENTS documents
 * (Markdown, text or a CSV export) about the account on the call. The
 * selected profile is sent with the grounding document as the session's
 * customer context, so answers draw on that account's history.
 *
 * Layout under the app's user-data directory:
 *   profiles/<id>.json      one profile: name, documents with their text
 *   profiles/selected.json  which profile is selected, or none
 *
 * Same discipline as grounding-document.js: main owns the directory and the
 * file names; documents come in only through main's own file picker
 * (document-import.js); the text leaves this store only towards the realtime
 * session (renderProfileText); renderers get profileMetadata(), never text.
 * A damaged file reads as absent plus a readError and never throws at boot.
 *
 * Limits (shared/context-budget.js): at most PROFILE_MAX_DOCUMENTS documents
 * and PROFILE_CHARS characters per profile, and the profile plus the grounding
 * document (read through `groundingChars` when a document is added) within
 * DOCUMENTS_CHARS. A document that would break one is refused, so what is
 * loaded is never trimmed per answer.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DOCUMENTS_CHARS, PROFILE_CHARS, PROFILE_MAX_DOCUMENTS, profileOverflow, profileRoom } from "../shared/context-budget.js";
import { atomicReplace } from "./atomic-file.js";
import { importDocument } from "./document-import.js";

export const PROFILES_DIRNAME = "profiles";
export const PROFILE_SELECTION_FILENAME = "selected.json";
export const PROFILE_VERSION = 1;
export const MAX_PROFILE_NAME_CHARS = 80;
export const STORED_PROFILE_UNREADABLE = "A saved customer profile couldn't be read. Create it again.";
export const STORED_SELECTION_UNREADABLE = "The selected customer profile couldn't be read. Select it again.";
/** A profile's text plus its JSON envelope; anything far larger is not ours. */
const MAX_STORED_BYTES = 128 * 1024;
const ID_PATTERN = /^[0-9a-f]{12}$/;
const PROFILE_FILE_PATTERN = /^([0-9a-f]{12})\.json$/;
const KINDS = Object.freeze(["markdown", "text", "csv"]);

const defaultFs = Object.freeze({ mkdir, readdir, readFile, rename, stat, unlink, writeFile });
const formatCount = (value) => value.toLocaleString("en-US");
const plural = (count, word) => `${formatCount(count)} ${word}${count === 1 ? "" : "s"}`;

export class CustomerProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CustomerProfileError";
    this.code = code;
  }
}

/**
 * @param {{userDataDir: string, fs?: object, now?: () => Date, groundingChars?: () => number}} options
 *   groundingChars: the grounding document's length now (main reads its
 *   state); read when a document is added, so a document loaded later in the
 *   run counts. Absent, no grounding document is assumed.
 */
export function createCustomerProfileStore({ userDataDir, fs, now = () => new Date(), groundingChars = () => 0 } = {}) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
    throw new CustomerProfileError("E_PROFILE_USER_DATA", "userDataDir must be an absolute main-owned directory.");
  }
  const io = fs ?? defaultFs;
  const dir = path.join(userDataDir, PROFILES_DIRNAME);
  const profilePath = (id) => path.join(dir, `${id}.json`);
  const selectionPath = path.join(dir, PROFILE_SELECTION_FILENAME);

  /* ------------------------------------------------------------ files */

  /** @returns {Promise<{profile: object|null, readError: string|null}>} */
  async function readProfile(id) {
    if (!ID_PATTERN.test(String(id))) return { profile: null, readError: null };
    const file = profilePath(id);
    let info;
    try {
      info = await io.stat(file);
    } catch (error) {
      if (error?.code === "ENOENT") return { profile: null, readError: null };
      return { profile: null, readError: STORED_PROFILE_UNREADABLE };
    }
    if (typeof info?.isFile === "function" && !info.isFile()) return { profile: null, readError: null };
    if (typeof info?.size === "number" && info.size > MAX_STORED_BYTES) return { profile: null, readError: STORED_PROFILE_UNREADABLE };
    try {
      const profile = storedProfile(JSON.parse(await io.readFile(file, "utf8")), id);
      return profile ? { profile, readError: null } : { profile: null, readError: STORED_PROFILE_UNREADABLE };
    } catch {
      return { profile: null, readError: STORED_PROFILE_UNREADABLE };
    }
  }

  /** Every readable profile (full text), plus one readError when any file is damaged. */
  async function readProfiles() {
    let names;
    try {
      names = await io.readdir(dir);
    } catch (error) {
      if (error?.code === "ENOENT") return { profiles: [], readError: null };
      return { profiles: [], readError: STORED_PROFILE_UNREADABLE };
    }
    const profiles = [];
    let readError = null;
    for (const name of names) {
      const match = PROFILE_FILE_PATTERN.exec(String(name));
      if (!match) continue;
      const read = await readProfile(match[1]);
      if (read.profile) profiles.push(read.profile);
      else if (read.readError) readError = read.readError;
    }
    profiles.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id));
    return { profiles, readError };
  }

  /** @returns {Promise<{selectedId: string|null, readError: string|null}>} the saved id, unchecked against the files. */
  async function readSelection() {
    let raw;
    try {
      raw = await io.readFile(selectionPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { selectedId: null, readError: null };
      return { selectedId: null, readError: STORED_SELECTION_UNREADABLE };
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      const id = parsed.selectedId;
      if (id !== null && !(typeof id === "string" && ID_PATTERN.test(id))) throw new Error("shape");
      return { selectedId: id, readError: null };
    } catch {
      return { selectedId: null, readError: STORED_SELECTION_UNREADABLE };
    }
  }

  async function writeSelection(selectedId) {
    try {
      await atomicReplace(io, selectionPath, `${JSON.stringify({ version: PROFILE_VERSION, selectedId })}\n`);
    } catch {
      throw new CustomerProfileError("E_PROFILE_SAVE", "Couldn't save the selected profile.");
    }
  }

  async function writeProfile(profile) {
    try {
      await atomicReplace(io, profilePath(profile.id), `${JSON.stringify({ version: PROFILE_VERSION, ...profile })}\n`);
    } catch {
      throw new CustomerProfileError("E_PROFILE_SAVE", "Couldn't save the profile.");
    }
  }

  async function requireProfile(id) {
    const { profile } = await readProfile(id);
    if (!profile) throw new CustomerProfileError("E_PROFILE_NOT_FOUND", "That profile no longer exists.");
    return profile;
  }

  /** The validated name, unique among the other profiles (case-insensitive). */
  async function checkName(name, { exceptId = null } = {}) {
    const clean = validateName(name);
    const { profiles } = await readProfiles();
    const clash = profiles.find((profile) => profile.id !== exceptId && sameName(profile.name, clean));
    if (clash) throw new CustomerProfileError("E_PROFILE_NAME_TAKEN", `There is already a profile named "${clash.name}".`);
    return clean;
  }

  /* -------------------------------------------------------------- api */

  /** Metadata of every profile, by name, and the selected id (null when its file is gone). */
  async function list() {
    const [{ profiles, readError }, selection] = await Promise.all([readProfiles(), readSelection()]);
    const selectedId = profiles.some((profile) => profile.id === selection.selectedId) ? selection.selectedId : null;
    return { profiles: profiles.map(profileMetadata), selectedId, readError: readError ?? selection.readError };
  }

  /** One profile with its documents' text (main only), or null. */
  async function get(id) {
    return (await readProfile(id)).profile;
  }

  /** The selected profile with its text, or null. */
  async function selected() {
    const { selectedId } = await readSelection();
    return selectedId ? get(selectedId) : null;
  }

  async function create({ name } = {}) {
    const clean = await checkName(name);
    const at = now().toISOString();
    const profile = { id: newId(), name: clean, documents: [], createdAt: at, updatedAt: at };
    await writeProfile(profile);
    return profileMetadata(profile);
  }

  async function rename(id, name) {
    const profile = await requireProfile(id);
    profile.name = await checkName(name, { exceptId: profile.id });
    profile.updatedAt = now().toISOString();
    await writeProfile(profile);
    return profileMetadata(profile);
  }

  /** @returns {Promise<{selectedId: string|null}>} */
  async function select(id) {
    if (id === null || id === undefined) {
      await writeSelection(null);
      return { selectedId: null };
    }
    const profile = await requireProfile(id);
    await writeSelection(profile.id);
    return { selectedId: profile.id };
  }

  /** @returns {Promise<{removed: boolean, selectedId: string|null}>} never an error for a profile already gone. */
  async function remove(id) {
    const selection = await readSelection();
    if (!ID_PATTERN.test(String(id))) return { removed: false, selectedId: selection.selectedId };
    try {
      await io.unlink(profilePath(id));
    } catch (error) {
      if (error?.code === "ENOENT") return { removed: false, selectedId: selection.selectedId };
      throw new CustomerProfileError("E_PROFILE_SAVE", "Couldn't remove the profile.");
    }
    let selectedId = selection.selectedId;
    if (selectedId === id) {
      await writeSelection(null);
      selectedId = null;
    }
    return { removed: true, selectedId };
  }

  /**
   * Import a file into the profile. A file with the name of a document already
   * in the profile replaces it in place (same id and slot), so a re-exported
   * CSV takes no extra slot and counts only its net size.
   */
  async function addDocument(id, sourcePath) {
    const profile = await requireProfile(id);
    const imported = await importDocument(sourcePath, { fs: io, now, maxChars: PROFILE_CHARS });
    const index = profile.documents.findIndex((document) => sameName(document.name, imported.name));
    if (index < 0 && profile.documents.length >= PROFILE_MAX_DOCUMENTS) {
      throw new CustomerProfileError(
        "E_PROFILE_DOCUMENTS",
        `This profile already has ${PROFILE_MAX_DOCUMENTS} files. Remove one and load it again.`,
      );
    }
    const profileChars = textChars(profile) - (index < 0 ? 0 : profile.documents[index].text.length);
    const grounding = currentGroundingChars();
    const overflow = profileOverflow({ groundingChars: grounding, profileChars, addChars: imported.text.length });
    if (overflow) {
      const room = formatCount(profileRoom({ groundingChars: grounding, profileChars }));
      const size = plural(imported.text.length, "character");
      throw overflow.limit === "profile"
        ? new CustomerProfileError(
            "E_PROFILE_TOO_LARGE",
            `This file has ${size}. The profile has ${room} of ${formatCount(PROFILE_CHARS)} left. Remove a file or trim this one and load it again.`,
          )
        : new CustomerProfileError(
            "E_PROFILE_BUDGET",
            `This file has ${size}. With the grounding document (${plural(grounding, "character")}) this profile has ${room} left of the ${formatCount(DOCUMENTS_CHARS)} answers can use. Trim one of them and load it again.`,
          );
    }
    const document = { id: index < 0 ? newId() : profile.documents[index].id, ...imported };
    if (index < 0) profile.documents.push(document);
    else profile.documents[index] = document;
    profile.updatedAt = now().toISOString();
    await writeProfile(profile);
    return profileMetadata(profile);
  }

  async function removeDocument(id, documentId) {
    const profile = await requireProfile(id);
    const index = profile.documents.findIndex((document) => document.id === documentId);
    if (index < 0) throw new CustomerProfileError("E_PROFILE_DOCUMENT_NOT_FOUND", "That file is no longer in the profile.");
    profile.documents.splice(index, 1);
    profile.updatedAt = now().toISOString();
    await writeProfile(profile);
    return profileMetadata(profile);
  }

  function currentGroundingChars() {
    try {
      const value = groundingChars();
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    } catch {
      return 0;
    }
  }

  return { list, get, selected, create, rename, select, remove, addDocument, removeDocument };
}

/** What the renderer may see: names and counts, never text. */
export function profileMetadata(profile) {
  if (!profile) return null;
  const documents = (profile.documents ?? []).map((document) => ({
    id: document.id,
    name: document.name,
    kind: document.kind,
    chars: document.text.length,
    words: wordCount(document.text),
    ...(typeof document.rows === "number" && { rows: document.rows, columns: document.columns }),
    loadedAt: document.loadedAt ?? null,
  }));
  return {
    id: profile.id,
    name: profile.name,
    chars: documents.reduce((sum, document) => sum + document.chars, 0),
    words: documents.reduce((sum, document) => sum + document.words, 0),
    documents,
    createdAt: profile.createdAt ?? null,
    updatedAt: profile.updatedAt ?? null,
  };
}

/** The profile as the session's customer text: each document under a `File:` line. */
export function renderProfileText(profile) {
  if (!profile || !Array.isArray(profile.documents)) return "";
  return profile.documents.map((document) => `File: ${document.name}\n\n${document.text}`).join("\n\n");
}

/** Trimmed, plain, one line, at most MAX_PROFILE_NAME_CHARS. */
export function validateName(name) {
  const clean = typeof name === "string" ? name.trim() : "";
  if (!clean) throw new CustomerProfileError("E_PROFILE_NAME", "Give the profile a name.");
  if (clean.length > MAX_PROFILE_NAME_CHARS) {
    throw new CustomerProfileError("E_PROFILE_NAME", `The name can have at most ${MAX_PROFILE_NAME_CHARS} characters.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(clean)) throw new CustomerProfileError("E_PROFILE_NAME", "The name must be plain text, on one line.");
  return clean;
}

function sameName(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function textChars(profile) {
  return profile.documents.reduce((sum, document) => sum + document.text.length, 0);
}

function wordCount(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function newId() {
  return randomBytes(6).toString("hex");
}

/** The file's content as a profile, or null when it is not one of ours. The file name is the id. */
function storedProfile(parsed, id) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { name, documents, createdAt, updatedAt } = parsed;
  if (typeof name !== "string" || !name || name.length > MAX_PROFILE_NAME_CHARS) return null;
  if (!Array.isArray(documents) || documents.length > PROFILE_MAX_DOCUMENTS) return null;
  const kept = [];
  for (const document of documents) {
    if (!document || typeof document !== "object") return null;
    const { id: documentId, name: documentName, kind, text, loadedAt, rows, columns } = document;
    if (typeof documentId !== "string" || !documentId || typeof documentName !== "string" || !documentName) return null;
    if (!KINDS.includes(kind) || typeof text !== "string" || !text || text.length > PROFILE_CHARS) return null;
    kept.push({
      id: documentId,
      name: documentName,
      kind,
      text,
      ...(typeof rows === "number" && typeof columns === "number" && { rows, columns }),
      loadedAt: typeof loadedAt === "string" ? loadedAt : null,
    });
  }
  if (kept.reduce((sum, document) => sum + document.text.length, 0) > PROFILE_CHARS) return null;
  return {
    id,
    name,
    documents: kept,
    createdAt: typeof createdAt === "string" ? createdAt : null,
    updatedAt: typeof updatedAt === "string" ? updatedAt : null,
  };
}
