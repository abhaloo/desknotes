/**
 * The saved debrief: the readable document plus its structured record, one
 * file in the app's user-data directory (the grounding-document.js pattern:
 * fixed name, atomic replace, injected fs, size-capped reads).
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicReplace } from "./atomic-file.js";
import { formatDebrief } from "./practice/debrief.js";

export const PRACTICE_DEBRIEF_FILENAME = "practice-debrief.json";
export const PRACTICE_DEBRIEF_VERSION = 1;
export const MAX_DEBRIEF_BYTES = 512 * 1024;
export const STORED_DEBRIEF_UNREADABLE = "The saved debrief couldn't be read.";

const defaultFs = Object.freeze({ mkdir, stat, readFile, writeFile, rename, unlink });

export class PracticeDebriefError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PracticeDebriefError";
    this.code = code;
  }
}

export function createPracticeDebriefStore({ userDataDir, fs, now = () => new Date() } = {}) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
    throw new PracticeDebriefError("E_PRACTICE_SAVE", "userDataDir must be an absolute main-owned directory.");
  }
  const io = fs ?? defaultFs;
  const filePath = path.join(userDataDir, PRACTICE_DEBRIEF_FILENAME);

  async function load() {
    let info;
    try {
      info = await io.stat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return { debrief: null, readError: null };
      return { debrief: null, readError: STORED_DEBRIEF_UNREADABLE };
    }
    if (typeof info?.size === "number" && info.size > MAX_DEBRIEF_BYTES) {
      return { debrief: null, readError: STORED_DEBRIEF_UNREADABLE };
    }
    try {
      const parsed = JSON.parse(await io.readFile(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || typeof parsed.text !== "string" || typeof parsed.title !== "string") {
        return { debrief: null, readError: STORED_DEBRIEF_UNREADABLE };
      }
      return { debrief: parsed, readError: null };
    } catch {
      return { debrief: null, readError: STORED_DEBRIEF_UNREADABLE };
    }
  }

  /** Persists the record plus the exact document text the window shows. */
  async function save(debrief = {}) {
    const savedAt = debrief.savedAt ?? now().toISOString();
    const stored = { ...debrief, savedAt, text: formatDebrief({ ...debrief, savedAt }) };
    const body = `${JSON.stringify({ version: PRACTICE_DEBRIEF_VERSION, ...stored })}\n`;
    // Cap BEFORE writing: an oversized file would immediately read back as
    // readError, so refusing the save is strictly more honest than storing it.
    if (Buffer.byteLength(body) > MAX_DEBRIEF_BYTES) {
      throw new PracticeDebriefError("E_PRACTICE_SAVE", "The debrief is too large to save.");
    }
    try {
      await atomicReplace(io, filePath, body);
    } catch {
      throw new PracticeDebriefError("E_PRACTICE_SAVE", "Couldn't save the debrief.");
    }
    return { savedAt };
  }

  async function clear() {
    try {
      await io.unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new PracticeDebriefError("E_PRACTICE_SAVE", "Couldn't remove the saved debrief.");
    }
  }

  return { load, save, clear };
}
