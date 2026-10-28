/**
 * Session recap store: one JSON file per session under
 * <userData>/sessions/, named <startedAt with ":" -> "-">-<session id>.json.
 *
 * The folder is the only source of truth: list() reads the files, so a recap
 * dropped in or removed by hand is simply seen, and there is no index to
 * drift. Same discipline as practice-debrief.js / grounding-document.js:
 * absolute main-owned userDataDir, injected fs, atomicReplace, size cap
 * before write and on read, a corrupt file -> readError (never a throw from
 * list()), and the renderer never supplies a path: ids are validated and
 * resolved to files here.
 *
 * Each file holds the built recap (build.js) plus `savedAt` and `text`, the
 * readable document formatRecap() wrote, so what the window shows is exactly
 * what is on disk.
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicReplace } from "../atomic-file.js";
import { formatRecap } from "./build.js";

export const RECAP_DIRNAME = "sessions";
export const RECAP_FILE_VERSION = 1;
export const MAX_RECAP_BYTES = 8 * 1024 * 1024;
export const STORED_RECAP_UNREADABLE = "This session recap couldn't be read.";
export const RECAP_FOLDER_UNREADABLE = "The saved session recaps couldn't be listed.";

/** Session ids are `session-<uuid>`: no separators, no dots, bounded. */
const ID_RULE = /^[A-Za-z0-9_-]{1,120}$/;
/** <YYYY-MM-DDTHH>-<MM>-<SS.mmmZ>-<id>.json */
const FILE_RULE = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d\.\d{3}Z)-([A-Za-z0-9_-]+)\.json$/;

const defaultFs = Object.freeze({ mkdir, readdir, readFile, rename, stat, unlink, writeFile });

export class RecapStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecapStoreError";
    this.code = code;
  }
}

export function isRecapId(id) {
  return typeof id === "string" && ID_RULE.test(id);
}

export function recapFileName(recap = {}) {
  return `${String(recap.startedAt ?? "").replaceAll(":", "-")}-${recap.id}.json`;
}

/** The id and start time a recap file name carries, or null for any other file. */
export function parseRecapFileName(name) {
  const match = typeof name === "string" ? FILE_RULE.exec(name) : null;
  if (!match) return null;
  return { id: match[4], startedAt: `${match[1]}:${match[2]}:${match[3]}` };
}

/** The list entry: when, how long, how it ended, the counts. Never the transcript. */
export function summarizeRecap(stored = {}) {
  return {
    id: stored.id,
    startedAt: stored.startedAt,
    endedAt: stored.endedAt ?? null,
    durationMs: stored.durationMs ?? null,
    endReason: stored.endReason ?? null,
    stats: stored.stats ?? null,
    savedAt: stored.savedAt ?? null,
  };
}

/**
 * @param {{ userDataDir: string, fs?: object, now?: () => Date, maxBytes?: number }} options
 */
export function createRecapStore({ userDataDir, fs, now = () => new Date(), maxBytes = MAX_RECAP_BYTES } = {}) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
    throw new RecapStoreError("E_RECAP_USER_DATA", "userDataDir must be an absolute main-owned directory.");
  }
  const io = fs ?? defaultFs;
  const dir = path.join(userDataDir, RECAP_DIRNAME);

  function assertId(id) {
    if (!isRecapId(id)) throw new RecapStoreError("E_RECAP_INVALID_ID", "That is not a session recap id.");
  }

  /** Recap file names in the folder; an absent folder is an empty one. */
  async function names() {
    try {
      return (await io.readdir(dir)).filter((name) => parseRecapFileName(name) !== null);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function fileFor(id) {
    const name = (await names()).find((candidate) => parseRecapFileName(candidate).id === id);
    return name ? path.join(dir, name) : null;
  }

  /** The parsed file, or a readError: oversized, not JSON, or not a recap. */
  async function readStored(filePath) {
    try {
      const info = await io.stat(filePath);
      if (typeof info?.size === "number" && info.size > maxBytes) return { stored: null, readError: STORED_RECAP_UNREADABLE };
      const parsed = JSON.parse(await io.readFile(filePath, "utf8"));
      const valid =
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        isRecapId(parsed.id) &&
        typeof parsed.startedAt === "string" &&
        Array.isArray(parsed.lines) &&
        typeof parsed.text === "string";
      return valid ? { stored: parsed, readError: null } : { stored: null, readError: STORED_RECAP_UNREADABLE };
    } catch {
      return { stored: null, readError: STORED_RECAP_UNREADABLE };
    }
  }

  /** Persists the recap plus the exact document text the window shows; replaces an earlier save of the same id. */
  async function save(recap = {}) {
    assertId(recap.id);
    if (typeof recap.startedAt !== "string" || Number.isNaN(Date.parse(recap.startedAt))) {
      throw new RecapStoreError("E_RECAP_SAVE", "A session recap needs a start time.");
    }
    const stored = { version: RECAP_FILE_VERSION, ...recap, savedAt: now().toISOString(), text: formatRecap(recap) };
    const body = `${JSON.stringify(stored)}\n`;
    // Cap BEFORE writing: an oversized file would only read back as unreadable.
    if (Buffer.byteLength(body) > maxBytes) {
      throw new RecapStoreError("E_RECAP_TOO_LARGE", "This session recap is too large to save.");
    }
    const target = path.join(dir, recapFileName(stored));
    let previous = null;
    try {
      previous = await fileFor(stored.id);
      await atomicReplace(io, target, body);
    } catch {
      throw new RecapStoreError("E_RECAP_SAVE", "Couldn't save the session recap.");
    }
    if (previous && previous !== target) await io.unlink(previous).catch(() => undefined);
    return summarizeRecap(stored);
  }

  async function get(id) {
    assertId(id);
    const file = await fileFor(id);
    if (!file) return { recap: null, readError: null };
    const { stored, readError } = await readStored(file);
    return { recap: stored, readError };
  }

  /** Newest first. A damaged file is listed from its name, marked unreadable, so it can still be deleted. */
  async function list() {
    let found;
    try {
      found = await names();
    } catch {
      return { sessions: [], readError: RECAP_FOLDER_UNREADABLE };
    }
    const sessions = [];
    for (const name of found) {
      const { id, startedAt } = parseRecapFileName(name);
      const { stored, readError } = await readStored(path.join(dir, name));
      sessions.push(stored ? summarizeRecap(stored) : { id, startedAt, readError });
    }
    sessions.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.id < b.id ? 1 : -1));
    return { sessions, readError: null };
  }

  async function remove(id) {
    assertId(id);
    const file = await fileFor(id);
    if (!file) return { removed: false };
    try {
      await io.unlink(file);
    } catch (error) {
      if (error?.code === "ENOENT") return { removed: false };
      throw new RecapStoreError("E_RECAP_SAVE", "Couldn't remove the session recap.");
    }
    return { removed: true };
  }

  /** Removes every session recap; other files in the folder are left alone. */
  async function clear() {
    let removed = 0;
    for (const name of await names()) {
      try {
        await io.unlink(path.join(dir, name));
        removed += 1;
      } catch (error) {
        if (error?.code !== "ENOENT") throw new RecapStoreError("E_RECAP_SAVE", "Couldn't remove the session recaps.");
      }
    }
    return { removed };
  }

  return { save, get, list, remove, clear };
}
