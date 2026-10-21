/**
 * Provider keys from the Windows user environment.
 *
 * Windows keeps a user's environment variables in HKCU\Environment, but a
 * process only sees the variables that existed when its parent started: a
 * terminal or Explorer opened before the user set a key passes the OLD value
 * on to every app it launches, and no amount of relaunching fixes it while
 * that shell lives. So the registry is read once at launch and wins: a key
 * that is missing from process.env is filled in, and one whose value differs
 * is replaced, because the user typed the newer value into Windows. The read
 * uses the pinned reg.exe and an environment that carries no secrets.
 * keys.env in the data folder (keys-file.js) is read after the registry and
 * wins over both.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Only these names are ever looked up: the provider keys the app answers with.
 * DeepSeek (default answers, vision), Cerebras (the Qwen choice and the
 * DeepSeek fallback), Groq (speech to text) and TypeSafe (the Jev judge that
 * decides when the prospect is done and whether they asked something).
 */
export const USER_SCOPE_KEYS = Object.freeze(["DEEPSEEK_API_KEY", "CEREBRAS_API_KEY", "GROQ_API_KEY", "TYPESAFE_API_KEY"]);

const WIN_DIR = "C:\\Windows";
const LOCAL_WINDOWS_DIR = /^[A-Za-z]:\\Windows$/i;
const REG_RELATIVE = "\\System32\\reg.exe";

/**
 * A program under the local Windows folder (`relative` like
 * "\\System32\\reg.exe"), never one an environment variable or PATH points at.
 */
export function resolveSystemTool(relative, { env = {}, exists = existsSync } = {}) {
  const fixed = `${WIN_DIR}${relative}`;
  if (exists(fixed)) return fixed;
  const root = env?.SystemRoot;
  if (typeof root === "string" && LOCAL_WINDOWS_DIR.test(root) && exists(`${root}${relative}`)) return `${root}${relative}`;
  return null;
}

/** The system reg.exe. */
export function resolveRegPath({ env = {}, exists = existsSync } = {}) {
  return resolveSystemTool(REG_RELATIVE, { env, exists });
}

/** The value of `name` in `reg query` output, or null. */
export function parseRegQuery(stdout, name) {
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
    if (match && match[1].toUpperCase() === name.toUpperCase()) return match[2].trim() || null;
  }
  return null;
}

/** One user-scope variable, or null (not Windows, not set, reg.exe failed). */
export function readUserEnvironmentVariable(
  name,
  { platform = process.platform, env = process.env, exists = existsSync, execFileImpl = execFile, timeoutMs = 3000 } = {},
) {
  if (platform !== "win32" || !USER_SCOPE_KEYS.includes(name)) return Promise.resolve(null);
  const reg = resolveRegPath({ env, exists });
  if (!reg) return Promise.resolve(null);
  const options = { windowsHide: true, timeout: timeoutMs, env: { SystemRoot: WIN_DIR } };
  return new Promise((resolve) => {
    try {
      execFileImpl(reg, ["query", "HKCU\\Environment", "/v", name], options, (error, stdout) =>
        resolve(error ? null : parseRegQuery(stdout, name)),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * The head and the tail of a key, for a log line: enough to tell two keys
 * apart, never enough to use one.
 * @param {unknown} value
 */
export function keyFingerprint(value) {
  const text = String(value ?? "");
  return text.length > 12 ? `${text.slice(0, 7)}\u2026${text.slice(-4)}` : "";
}

/**
 * Take each listed key from the user environment: fill a key `env` lacks and
 * replace one whose inherited value differs (a shell opened before the key was
 * changed holds the old one forever). An equal value is left alone.
 * @returns {Promise<{filled: string[], replaced: {key: string, before: string, after: string}[]}>}
 *   the names that changed, with fingerprints (never the values)
 */
export async function adoptUserEnvironment(env = process.env, { keys = USER_SCOPE_KEYS, read = readUserEnvironmentVariable } = {}) {
  const values = {};
  for (const key of keys) values[key] = await read(key);
  return adoptKeyValues(env, values, { keys });
}

/**
 * Put each listed key from `values` into `env` (the registry above, keys.env
 * in keys-file.js): fill a missing one and replace one whose value differs.
 * An equal, empty or missing value changes nothing, and a name outside `keys`
 * is never set.
 * @returns {{filled: string[], replaced: {key: string, before: string, after: string}[]}}
 *   the names that changed, with fingerprints (never the values)
 */
export function adoptKeyValues(env, values, { keys = USER_SCOPE_KEYS } = {}) {
  const filled = [];
  const replaced = [];
  for (const key of keys) {
    const value = values?.[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const inherited = env[key];
    if (typeof inherited === "string" && inherited.length > 0) {
      if (inherited === value) continue;
      replaced.push({ key, before: keyFingerprint(inherited), after: keyFingerprint(value) });
    } else {
      filled.push(key);
    }
    env[key] = value;
  }
  return { filled, replaced };
}
