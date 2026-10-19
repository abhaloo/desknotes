/**
 * The practice problem statement: pasted text, saved under the app's
 * user-data directory so it survives restarts (same store discipline as
 * grounding-document.js). The renderer supplies the TEXT it pasted (that is
 * its job); it never supplies a path. Unlike the grounding document this
 * text is shown back in the practice window — it is the user's own paste.
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicReplace } from "../atomic-file.js";

export const PRACTICE_MATERIAL_FILENAME = "practice-material.json";
export const PRACTICE_MATERIAL_VERSION = 1;
export const MAX_PROBLEM_STATEMENT_CHARS = 8_000;
/** Text plus a short JSON envelope; anything far larger is not ours. */
const MAX_STORED_BYTES = 64 * 1024;
export const STORED_MATERIAL_UNREADABLE = "The saved practice material couldn't be read. Paste it again.";

const defaultFs = Object.freeze({ mkdir, stat, readFile, writeFile, rename, unlink });

export class PracticeMaterialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PracticeMaterialError";
    this.code = code;
  }
}

/** Trimmed, LF-normalized, NUL-free, at most MAX_PROBLEM_STATEMENT_CHARS. */
export function validateProblemStatement(value) {
  let text = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (text.includes("\u0000")) {
    throw new PracticeMaterialError("E_PRACTICE_MATERIAL_NOT_TEXT", "The problem statement must be plain text.");
  }
  if (!text) throw new PracticeMaterialError("E_PRACTICE_MATERIAL_EMPTY", "Paste a problem statement first.");
  if (text.length > MAX_PROBLEM_STATEMENT_CHARS) {
    throw new PracticeMaterialError(
      "E_PRACTICE_MATERIAL_TOO_LARGE",
      `This problem statement has ${text.length.toLocaleString("en-US")} characters. The limit is ${MAX_PROBLEM_STATEMENT_CHARS.toLocaleString("en-US")}. Trim it and save it again.`,
    );
  }
  return text;
}

export function createPracticeMaterialStore({ userDataDir, fs, now = () => new Date() } = {}) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
    throw new PracticeMaterialError("E_PRACTICE_MATERIAL_USER_DATA", "userDataDir must be an absolute main-owned directory.");
  }
  const io = fs ?? defaultFs;
  const filePath = path.join(userDataDir, PRACTICE_MATERIAL_FILENAME);

  async function load() {
    let info;
    try {
      info = await io.stat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return { material: null, readError: null };
      return { material: null, readError: STORED_MATERIAL_UNREADABLE };
    }
    if (typeof info?.size === "number" && info.size > MAX_STORED_BYTES) {
      return { material: null, readError: STORED_MATERIAL_UNREADABLE };
    }
    try {
      const parsed = JSON.parse(await io.readFile(filePath, "utf8"));
      const statement = typeof parsed?.problemStatement === "string" ? parsed.problemStatement : "";
      if (!statement || statement.length > MAX_PROBLEM_STATEMENT_CHARS) {
        return { material: null, readError: STORED_MATERIAL_UNREADABLE };
      }
      return {
        material: { problemStatement: statement, savedAt: typeof parsed?.savedAt === "string" ? parsed.savedAt : null },
        readError: null,
      };
    } catch {
      return { material: null, readError: STORED_MATERIAL_UNREADABLE };
    }
  }

  async function save({ problemStatement } = {}) {
    const text = validateProblemStatement(problemStatement);
    const material = { problemStatement: text, savedAt: now().toISOString() };
    try {
      await atomicReplace(io, filePath, `${JSON.stringify({ version: PRACTICE_MATERIAL_VERSION, ...material })}\n`);
    } catch {
      throw new PracticeMaterialError("E_PRACTICE_SAVE", "Couldn't save the practice material.");
    }
    return material;
  }

  async function clear() {
    try {
      await io.unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new PracticeMaterialError("E_PRACTICE_SAVE", "Couldn't remove the saved practice material.");
    }
  }

  return { load, save, clear };
}
