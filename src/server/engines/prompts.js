/**
 * Prompt store: every prompt the app sends is a text file under
 * prompts/<set>/. A set is loaded into memory once and reloaded when its files
 * change, so the answer path never reads the disk.
 *
 * A file of the same path under <overrideDir>/<set>/ replaces the shipped one,
 * unless it is blank or (for .json) invalid. A file may include another with
 * {{rules/no-chatbot}}; an included file may not include. {{max_chars}} is a
 * variable, filled at get() time in one pass, so a value that contains braces
 * is sent as written.
 */
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo's prompts/ folder. */
export const PROMPTS_ROOT = fileURLToPath(new URL("../../../prompts/", import.meta.url));

/** Prompt id -> file path inside a set folder. */
export const PROMPT_FILES = Object.freeze({
  "rules/no-chatbot": "rules/no-chatbot.md",
  "rules/surface": "rules/surface.md",
  "answer/spoken": "answer/spoken.md",
  "answer/technical": "answer/technical.md",
  "answer/technical-card": "answer/technical-card.md",
  "rules/grounding": "rules/grounding.md",
  "rules/grounding-technical": "rules/grounding-technical.md",
  "rules/screen": "rules/screen.md",
  "rules/screen-turn": "rules/screen-turn.md",
  "rules/highlight": "rules/highlight.md",
  "rules/rep-context": "rules/rep-context.md",
  "cards/card": "cards/card.md",
  "cards/detail-card": "cards/detail-card.md",
  "cards/card-highlight": "cards/card-highlight.md",
  "cards/reminder": "cards/reminder.md",
  "cards/retry": "cards/retry.md",
  "terms/system": "terms/system.md",
  "terms/user": "terms/user.md",
  "vision/interpret": "vision/interpret.md",
  judge: "judge.json",
});

const INCLUDE = /\{\{([a-z0-9-]+(?:\/[a-z0-9-]+)+)\}\}/g;
const HAS_INCLUDE = new RegExp(INCLUDE.source);
const VARIABLE = /\{\{([a-z_]+)\}\}/g;
const SET_NAME = /^[A-Za-z0-9_-]+$/;

let active = null;
let shippedStore = null;

const isJson = (id) => PROMPT_FILES[id].endsWith(".json");

/** File text, or null when the file does not exist. */
function readIfExists(fs, file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** CRLF becomes LF, and the one newline an editor adds at the end goes. */
function normalize(text) {
  const lf = text.replace(/\r\n/g, "\n");
  return lf.endsWith("\n") ? lf.slice(0, -1) : lf;
}

/** The override's normalized text, or null to use the shipped file. */
function readOverride({ fs, log }, file, id) {
  let text;
  try {
    text = readIfExists(fs, file);
  } catch {
    log({ type: "prompts.override_invalid", id });
    return null;
  }
  if (text === null) return null;
  const normalized = normalize(text);
  // A half-saved empty file must not send an empty prompt.
  if (normalized.trim() === "") return null;
  if (isJson(id)) {
    try {
      JSON.parse(normalized);
    } catch {
      log({ type: "prompts.override_invalid", id });
      return null;
    }
  }
  return normalized;
}

/** Every id's text before includes are resolved: override first, then shipped. */
function readRaw({ root, set, overrideDir, fs, log }) {
  const raw = {};
  for (const [id, rel] of Object.entries(PROMPT_FILES)) {
    const override = overrideDir ? readOverride({ fs, log }, join(overrideDir, set, rel), id) : null;
    if (override !== null) {
      raw[id] = override;
      continue;
    }
    const file = join(root, set, rel);
    const shipped = readIfExists(fs, file);
    if (shipped === null) throw new Error(`prompt file missing: ${file}`);
    raw[id] = normalize(shipped);
  }
  return raw;
}

function resolveIncludes(text, id, raw) {
  return text.replace(INCLUDE, (_, name) => {
    if (!Object.hasOwn(PROMPT_FILES, name)) throw new Error(`unknown prompt include: ${name} in ${id}`);
    if (HAS_INCLUDE.test(raw[name])) throw new Error(`nested prompt include in ${id}`);
    return raw[name];
  });
}

/** Freezes a parsed JSON tree so a caller cannot change the stored prompt. */
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function loadRecord(options) {
  const raw = readRaw(options);
  const texts = {};
  const json = {};
  for (const id of Object.keys(PROMPT_FILES)) {
    if (isJson(id)) {
      texts[id] = raw[id];
      try {
        json[id] = deepFreeze(JSON.parse(raw[id]));
      } catch {
        throw new Error(`prompt is not valid JSON: ${id}`);
      }
    } else {
      texts[id] = resolveIncludes(raw[id], id, raw);
    }
  }
  return { texts: Object.freeze(texts), json: Object.freeze(json) };
}

/**
 * One set's final texts: every id of PROMPT_FILES. JSON ids keep their raw
 * text. Throws when a shipped file is missing or an include is bad.
 * @returns {Readonly<Record<string, string>>}
 */
export function loadPromptSet({ root = PROMPTS_ROOT, set, overrideDir = null, fs = nodeFs, log = () => {} }) {
  return loadRecord({ root, set, overrideDir, fs, log }).texts;
}

/**
 * The catalog in <root>/sets.json: `{ default, sets }`.
 * @returns {{default: string, sets: Record<string, string>}}
 */
export function readPromptSets({ root = PROMPTS_ROOT, fs = nodeFs } = {}) {
  return JSON.parse(fs.readFileSync(join(root, "sets.json"), "utf8"));
}

/**
 * A store for one set. It loads on creation and throws if that fails.
 * `reload` keeps the previous texts when a reload fails.
 * `watch` reloads after a change in the shipped or override folder, debounced.
 * @returns {{set: string, overrideDir: string|null, get: Function, json: Function, reload: () => boolean, watch: () => void, close: () => void}}
 */
export function createPromptStore({
  root = PROMPTS_ROOT,
  set,
  overrideDir = null,
  fs = nodeFs,
  log = () => {},
  watchFn = nodeFs.watch,
  debounceMs = 250,
}) {
  const options = { root, set, overrideDir, fs, log };
  let loaded = loadRecord(options);
  let timer = null;
  const watchers = [];

  function reload() {
    try {
      loaded = loadRecord(options);
      return true;
    } catch (error) {
      log({ type: "prompts.reload_failed", message: error.message });
      return false;
    }
  }

  // One timer: a save that touches several files reloads once.
  function onChange() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      reload();
    }, debounceMs);
  }

  function watchDir(dir, create = false) {
    try {
      if (create) fs.mkdirSync(dir, { recursive: true });
      watchers.push(watchFn(dir, { recursive: true }, onChange));
    } catch {
      // A packaged app cannot watch inside app.asar; the store still works.
      log({ type: "prompts.watch_failed", dir });
    }
  }

  return {
    set,
    overrideDir,
    /**
     * The text of one prompt, with {{name}} variables filled from `vars`.
     * Unknown variables stay as written.
     */
    get(id, vars = {}) {
      if (!Object.hasOwn(loaded.texts, id)) throw new Error(`unknown prompt: ${id}`);
      const text = loaded.texts[id];
      // Most prompts have no variables: the answer path skips the regex.
      if (!text.includes("{{")) return text;
      return text.replace(VARIABLE, (match, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : match));
    },
    /** A JSON prompt, parsed and frozen. */
    json(id) {
      if (!Object.hasOwn(loaded.json, id)) throw new Error(`not a JSON prompt: ${id}`);
      return loaded.json[id];
    },
    reload,
    watch() {
      watchDir(join(root, set));
      if (overrideDir) watchDir(join(overrideDir, set), true);
    },
    close() {
      clearTimeout(timer);
      timer = null;
      for (const watcher of watchers.splice(0)) watcher?.close?.();
    },
  };
}

/** A set is a folder under root; a name that is not a plain word is unknown. */
function resolveSet({ root, fs, requested, log }) {
  if (requested) {
    if (SET_NAME.test(requested) && fs.existsSync(join(root, requested))) return requested;
    log({ type: "prompts.unknown_set", set: requested });
  }
  return readPromptSets({ root, fs }).default;
}

/**
 * Makes the active store from `options` and returns it. An unknown `set` logs
 * `prompts.unknown_set` and the default set is used. The previous active store
 * is closed once the new one has loaded, so a failed load keeps the old one.
 */
export function configurePrompts(options = {}) {
  const root = options.root ?? PROMPTS_ROOT;
  const fs = options.fs ?? nodeFs;
  const log = options.log ?? (() => {});
  const set = resolveSet({ root, fs, requested: options.set, log });
  const next = createPromptStore({ ...options, root, fs, log, set });
  active?.close();
  active = next;
  return next;
}

function shipped() {
  shippedStore ??= createPromptStore({ set: readPromptSets().default });
  return shippedStore;
}

/** Until configurePrompts runs, the active store is the shipped one, already in memory. */
function activeStore() {
  return active ?? shipped();
}

/** The text of a prompt from the active store. */
export function prompt(id, vars) {
  return activeStore().get(id, vars);
}

/** A JSON prompt from the active store. */
export function promptJson(id) {
  return activeStore().json(id);
}

/**
 * The default set's shipped text, never overridden. The exported constants of
 * the engines use this, so they keep their values whatever the store holds.
 */
export function shippedPrompt(id, vars) {
  return shipped().get(id, vars);
}
