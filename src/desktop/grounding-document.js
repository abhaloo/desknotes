/**
 * The rep's grounding document: one Markdown or text file, copied into the
 * app's user-data directory so it survives restarts and the original moving.
 *
 * Main owns the file name and the directory; the renderer never supplies a
 * path. The text leaves this module only towards the realtime session; the
 * renderer gets documentMetadata() (name and counts), never the text.
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicReplace } from "./atomic-file.js";

export const GROUNDING_FILENAME = "grounding-document.json";
export const GROUNDING_VERSION = 1;
export const MAX_DOCUMENT_CHARS = 30_000;
export const MAX_DOCUMENT_BYTES = 128 * 1024;
/** Text plus a short JSON envelope; anything far larger is not ours. */
const MAX_STORED_BYTES = 512 * 1024;
export const DOCUMENT_EXTENSIONS = Object.freeze([".md", ".markdown", ".txt"]);
export const STORED_DOCUMENT_UNREADABLE = "The saved document couldn't be read. Load it again.";

const defaultFs = Object.freeze({ mkdir, stat, readFile, writeFile, rename, unlink });
const formatCount = (value) => value.toLocaleString("en-US");

export class GroundingDocumentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GroundingDocumentError";
    this.code = code;
  }
}

export function createGroundingDocumentStore({ userDataDir, fs, now = () => new Date() } = {}) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
    throw new GroundingDocumentError("E_DOC_USER_DATA", "userDataDir must be an absolute main-owned directory.");
  }
  const io = fs ?? defaultFs;
  const filePath = path.join(userDataDir, GROUNDING_FILENAME);

  async function load() {
    let info;
    try {
      info = await io.stat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return { document: null, readError: null };
      return { document: null, readError: STORED_DOCUMENT_UNREADABLE };
    }
    if (typeof info?.size === "number" && info.size > MAX_STORED_BYTES) {
      return { document: null, readError: STORED_DOCUMENT_UNREADABLE };
    }
    try {
      const document = storedDocument(JSON.parse(await io.readFile(filePath, "utf8")));
      return document ? { document, readError: null } : { document: null, readError: STORED_DOCUMENT_UNREADABLE };
    } catch {
      return { document: null, readError: STORED_DOCUMENT_UNREADABLE };
    }
  }

  async function importFile(sourcePath) {
    if (typeof sourcePath !== "string" || sourcePath.length === 0) {
      throw new GroundingDocumentError("E_DOC_UNREADABLE", "Couldn't read this file.");
    }
    const name = path.basename(sourcePath);
    if (!DOCUMENT_EXTENSIONS.includes(path.extname(name).toLowerCase())) {
      throw new GroundingDocumentError("E_DOC_TYPE", "Only .md and .txt files can be loaded. Save it as .md or .txt and load it again.");
    }
    let info;
    try {
      info = await io.stat(sourcePath);
    } catch (error) {
      throw unreadable(error);
    }
    if (typeof info?.size === "number" && info.size > MAX_DOCUMENT_BYTES) {
      throw new GroundingDocumentError(
        "E_DOC_TOO_LARGE",
        `This file is ${formatCount(Math.ceil(info.size / 1024))} KB. The limit is ${formatCount(MAX_DOCUMENT_CHARS)} characters. Trim it and load it again.`,
      );
    }
    let bytes;
    try {
      bytes = await io.readFile(sourcePath);
    } catch (error) {
      throw unreadable(error);
    }
    const document = { name, text: decodeDocument(bytes), loadedAt: now().toISOString() };
    try {
      await atomicReplace(io, filePath, `${JSON.stringify({ version: GROUNDING_VERSION, ...document })}\n`);
    } catch {
      throw new GroundingDocumentError("E_DOC_SAVE", "Couldn't save the document.");
    }
    return document;
  }

  async function clear() {
    try {
      await io.unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new GroundingDocumentError("E_DOC_SAVE", "Couldn't remove the saved document.");
    }
  }

  return { load, importFile, clear };
}

/** UTF-8 only (BOM stripped), no NUL, CRLF normalized, trimmed, at most MAX_DOCUMENT_CHARS. */
export function decodeDocument(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw notText();
  }
  if (text.includes("\u0000")) throw notText();
  text = text.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new GroundingDocumentError("E_DOC_EMPTY", "This file is empty.");
  if (text.length > MAX_DOCUMENT_CHARS) {
    throw new GroundingDocumentError(
      "E_DOC_TOO_LARGE",
      `This file has ${formatCount(text.length)} characters. The limit is ${formatCount(MAX_DOCUMENT_CHARS)}. Trim it and load it again.`,
    );
  }
  return text;
}

/** What the renderer may see: never the text. */
export function documentMetadata(document) {
  if (!document) return null;
  const text = String(document.text ?? "");
  return {
    name: document.name,
    words: text ? text.split(/\s+/).filter(Boolean).length : 0,
    chars: text.length,
    loadedAt: document.loadedAt ?? null,
  };
}

function storedDocument(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { name, text, loadedAt } = parsed;
  if (typeof name !== "string" || !name || typeof text !== "string" || !text || text.length > MAX_DOCUMENT_CHARS) return null;
  return { name, text, loadedAt: typeof loadedAt === "string" ? loadedAt : null };
}

function notText() {
  return new GroundingDocumentError("E_DOC_NOT_TEXT", "This file isn't plain text. Save it as .md or .txt and load it again.");
}

function unreadable(error) {
  const reason = error?.code ? ` (${error.code})` : "";
  return new GroundingDocumentError("E_DOC_UNREADABLE", `Couldn't read this file${reason}.`);
}
