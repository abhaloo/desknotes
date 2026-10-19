/**
 * Provider keys from the Windows user environment.
 *
 * Windows keeps a user's environment variables in HKCU\Environment, but a
 * process only sees the variables that existed when its parent started: a
 * terminal or Explorer opened before the user set a key passes it on to nobody.
 * A key that is missing from process.env is therefore read from the registry
 * once at launch, with the pinned reg.exe and an environment that carries no
 * secrets.
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

/** The system reg.exe, never one an environment variable or PATH points at. */
export function resolveRegPath({ env = {}, exists = existsSync } = {}) {
  const fixed = `${WIN_DIR}${REG_RELATIVE}`;
  if (exists(fixed)) return fixed;
  const root = env.SystemRoot;
  if (typeof root === "string" && LOCAL_WINDOWS_DIR.test(root) && exists(`${root}${REG_RELATIVE}`)) return `${root}${REG_RELATIVE}`;
  return null;
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
 * Fill each listed key that `env` lacks from the user environment.
 * @returns {Promise<string[]>} the names that were filled (never the values)
 */
export async function fillMissingUserEnv(env = process.env, { keys = USER_SCOPE_KEYS, read = readUserEnvironmentVariable } = {}) {
  const filled = [];
  for (const key of keys) {
    if (typeof env[key] === "string" && env[key].length > 0) continue;
    const value = await read(key);
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
      filled.push(key);
    }
  }
  return filled;
}
