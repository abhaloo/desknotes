/**
 * Provider keys from keys.env in the data folder.
 *
 * Setting Windows environment variables is a chore, and a terminal opened
 * before a change keeps the old value (user-env.js). keys.env is the other
 * way: a plain NAME=value file beside app-preferences.json that main reads
 * once at launch, after the Windows user environment, so a key in the file
 * wins. Only the provider key names in USER_SCOPE_KEYS count: a line naming
 * anything else (PATH, NODE_OPTIONS...) is ignored, so the file can never
 * change how the app itself runs. An empty value means "not set here", which
 * is how the template lists every key.
 *
 * Log lines and `ignored` reasons carry line numbers and key names only,
 * never what a line says: a key pasted on the wrong line must not reach a log.
 * The file is never copied between data folders (data-dir.js DATA_FILES).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { USER_SCOPE_KEYS, resolveSystemTool } from "./user-env.js";

export const KEYS_FILENAME = "keys.env";
/** Four keys fit in a few hundred characters; anything this large is not a keys file. */
export const MAX_KEYS_FILE_CHARS = 64 * 1024;

export const KEYS_TEMPLATE = [
  "# DeskNotes API keys. DeskNotes reads this file when it starts.",
  "# Paste each key after its = sign, save the file, then restart DeskNotes.",
  "# A key here wins over the same Windows environment variable;",
  "# leave a line empty to use the environment variable instead.",
  "# This is plain text: keep it out of shared and synced folders.",
  "",
  "# Answers, screen analysis and terms (DeepSeek V4.1 Flash)",
  "DEEPSEEK_API_KEY=",
  "# Qwen 27B answers (Cerebras)",
  "CEREBRAS_API_KEY=",
  "# Speech to text (Groq)",
  "GROQ_API_KEY=",
  "# When the prospect is done and whether they asked something (TypeSafe Jev)",
  "TYPESAFE_API_KEY=",
  "",
].join("\n");

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const NOT_A_KEY = `not one of ${USER_SCOPE_KEYS.join(", ")}`;

/**
 * The keys a keys.env text sets. `#` lines and blank lines are skipped, one
 * pair of surrounding quotes comes off, ` # comment` after an unquoted value
 * comes off, names are case-insensitive, and a later line wins.
 * @returns {{ values: Record<string, string>, ignored: { line: number, reason: string }[] }}
 */
export function parseKeysFile(text) {
  const values = {};
  const ignored = [];
  if (typeof text !== "string") return { values, ignored };
  text.replace(/^﻿/, "").split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const match = LINE.exec(line);
    if (!match) {
      ignored.push({ line: index + 1, reason: "not NAME=value" });
      return;
    }
    const name = match[1].toUpperCase();
    if (!USER_SCOPE_KEYS.includes(name)) {
      ignored.push({ line: index + 1, reason: NOT_A_KEY });
      return;
    }
    const value = valueOf(match[2]);
    if (!value) return;
    if (/\s/.test(value)) {
      ignored.push({ line: index + 1, reason: `${name} has a space in it` });
      return;
    }
    values[name] = value;
  });
  return { values, ignored };
}

/**
 * The file now. A missing file is no keys and no error; an unreadable or
 * oversized one is no keys and an error code to log.
 * @returns {Promise<{ values: Record<string, string>, ignored: { line: number, reason: string }[], error: string | null }>}
 */
export async function readKeysFile(file, { readFileImpl = readFile } = {}) {
  let text;
  try {
    text = String(await readFileImpl(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { values: {}, ignored: [], error: null };
    return { values: {}, ignored: [], error: String(error?.code ?? error?.message ?? error) };
  }
  if (text.length > MAX_KEYS_FILE_CHARS) {
    return { values: {}, ignored: [], error: `too large (over ${MAX_KEYS_FILE_CHARS} characters)` };
  }
  return { ...parseKeysFile(text), error: null };
}

/** Create the file from the template when it is missing; an existing file is never touched. */
export async function ensureKeysFile(file, { writeFileImpl = writeFile, mkdirImpl = mkdir } = {}) {
  try {
    await mkdirImpl(dirname(file), { recursive: true });
    await writeFileImpl(file, KEYS_TEMPLATE, { flag: "wx", mode: 0o600 });
    return { created: true, error: null };
  } catch (error) {
    if (error?.code === "EEXIST") return { created: false, error: null };
    return { created: false, error: String(error?.code ?? error?.message ?? error) };
  }
}

/**
 * Where each key the app uses came from, for Settings: "keys.env" for a name
 * the file set, "environment" for one that was already there, null when the
 * app has none. Never a value.
 * @param {Record<string, string | undefined>} env
 * @param {Iterable<string>} fromFile the names keys.env set at launch
 */
export function keySources(env, fromFile = []) {
  const file = new Set(fromFile);
  const out = {};
  for (const key of USER_SCOPE_KEYS) {
    const present = typeof env?.[key] === "string" && env[key].length > 0;
    out[key] = !present ? null : file.has(key) ? "keys.env" : "environment";
  }
  return out;
}

/**
 * Open the file in the system Notepad. Windows has no default app for .env
 * files, so the shell would ask the rep which app to use. Notepad is started
 * by its fixed path (never one PATH points at), detached, with no provider
 * keys in its environment. Resolves "" once it started and an error message
 * otherwise, like shell.openPath.
 */
export function openInNotepad(file, { env = process.env, exists = existsSync, spawnImpl = spawn } = {}) {
  const notepad = resolveSystemTool("\\System32\\notepad.exe", { env, exists });
  if (!notepad) return Promise.resolve("Notepad was not found");
  const childEnv = Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => !/_API_KEY$/i.test(name)));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(notepad, [file], { detached: true, stdio: "ignore", windowsHide: false, env: childEnv });
    } catch (error) {
      resolve(messageOf(error));
      return;
    }
    child.once("error", (error) => resolve(messageOf(error)));
    child.once("spawn", () => {
      child.unref();
      resolve("");
    });
  });
}

function valueOf(raw) {
  const text = raw.trim();
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.length >= 2 && text.endsWith(quote)) return text.slice(1, -1).trim();
  return text.replace(/\s+#.*$/, "").trim();
}

function messageOf(error) {
  return error instanceof Error ? error.message || error.name : String(error);
}
