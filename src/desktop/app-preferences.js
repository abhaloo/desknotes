/**
 * Small app-wide settings: auto-start, the answer model and the window opacity
 * (window-opacity.js; a missing or bad value reads as fully opaque, and any
 * number is clamped to 0.3..1 so no window can be made invisible). A missing file is
 * a first run and gets the defaults. A damaged file must never turn listening
 * on, so it reads as auto-start OFF and says why. The answer model always
 * reads as a listed choice (answer-models.js normalizeAnswerModel): an id an
 * earlier build saved migrates ("" Automatic -> the default, "deepseek-v4-pro"
 * -> "deepseek-flash", "cerebras-qwen" -> "cerebras-qwen-thinking"), and an
 * unknown one reads as the default. It is not a safety setting. Rep context
 * ("Use what I say in answers",
 * conversation-context.js), highlights ("Highlight key phrases",
 * src/shared/highlights.js), answer cards ("Short answer cards",
 * src/shared/answer-cards.js) and terms ("Explain terms",
 * src/server/engines/glossary.js) are on unless the file says false: a file
 * from an earlier build, or a damaged one, keeps the default.
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicReplace } from "./atomic-file.js";
import { DEFAULT_ANSWER_MODEL, isAnswerModelChoice, normalizeAnswerModel } from "../server/engines/answer-models.js";
import { WINDOW_OPACITY, clampWindowOpacity } from "./window-opacity.js";

export const APP_PREFERENCES_FILENAME = "app-preferences.json";
export const APP_PREFERENCES_VERSION = 1;
export const MAX_APP_PREFERENCES_BYTES = 4 * 1024;
export const SETTINGS_UNREADABLE = "Settings couldn't be read, so listening didn't start automatically.";
const SETTINGS_SHAPE =
  "settings:set takes { autoStart?: boolean, answerModel?: string, windowOpacity?: number, repContext?: boolean, highlights?: boolean, answerCards?: boolean, glossary?: boolean } with at least one of them.";
const FIELDS = Object.freeze(["autoStart", "answerModel", "windowOpacity", "repContext", "highlights", "answerCards", "glossary"]);

const defaultFs = Object.freeze({ mkdir, stat, readFile, writeFile, rename, unlink });

export class AppPreferenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AppPreferenceError";
    this.code = code;
  }
}

export function createAppPreferences({ userDataDir, fs } = {}) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
    throw new AppPreferenceError("E_PREFS_USER_DATA", "userDataDir must be an absolute main-owned directory.");
  }
  const io = fs ?? defaultFs;
  const filePath = path.join(userDataDir, APP_PREFERENCES_FILENAME);
  /** Last loaded or saved values: saving one field keeps the others. */
  let current = { autoStart: true, answerModel: DEFAULT_ANSWER_MODEL, windowOpacity: WINDOW_OPACITY.default, repContext: true, highlights: true, answerCards: true, glossary: true };

  async function load() {
    const loaded = await read();
    current = {
      autoStart: loaded.autoStart,
      answerModel: loaded.answerModel,
      windowOpacity: loaded.windowOpacity,
      repContext: loaded.repContext,
      highlights: loaded.highlights,
      answerCards: loaded.answerCards,
      glossary: loaded.glossary,
    };
    return loaded;
  }

  async function read() {
    let info;
    try {
      info = await io.stat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { autoStart: true, answerModel: DEFAULT_ANSWER_MODEL, windowOpacity: WINDOW_OPACITY.default, repContext: true, highlights: true, answerCards: true, glossary: true, readError: null };
      }
      return unreadableSettings();
    }
    if (typeof info?.size === "number" && info.size > MAX_APP_PREFERENCES_BYTES) return unreadableSettings();
    try {
      const parsed = JSON.parse(await io.readFile(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.autoStart !== "boolean") {
        return unreadableSettings();
      }
      const answerModel = normalizeAnswerModel(parsed.answerModel);
      const windowOpacity = clampWindowOpacity(parsed.windowOpacity);
      const repContext = parsed.repContext !== false;
      const highlights = parsed.highlights !== false;
      const answerCards = parsed.answerCards !== false;
      const glossary = parsed.glossary !== false;
      return { autoStart: parsed.autoStart, answerModel, windowOpacity, repContext, highlights, answerCards, glossary, readError: null };
    } catch {
      return unreadableSettings();
    }
  }

  async function save(update) {
    const next = { ...current, ...validateSettingsUpdate(update) };
    const body = {
      version: APP_PREFERENCES_VERSION,
      autoStart: next.autoStart,
      answerModel: next.answerModel,
      windowOpacity: next.windowOpacity,
      repContext: next.repContext,
      highlights: next.highlights,
      answerCards: next.answerCards,
      glossary: next.glossary,
    };
    await atomicReplace(io, filePath, `${JSON.stringify(body, null, 2)}\n`);
    current = next;
    return {
      autoStart: next.autoStart,
      answerModel: next.answerModel,
      windowOpacity: next.windowOpacity,
      repContext: next.repContext,
      highlights: next.highlights,
      answerCards: next.answerCards,
      glossary: next.glossary,
      readError: null,
    };
  }

  return { load, save };
}

/**
 * settings:set takes { autoStart?: boolean, answerModel?: a listed choice,
 * windowOpacity?: a finite number (clamped to 0.3..1), repContext?: boolean,
 * highlights?: boolean, answerCards?: boolean, glossary?: boolean }, at least one.
 */
export function validateSettingsUpdate(update) {
  const keys = update && typeof update === "object" && !Array.isArray(update) ? Object.keys(update) : null;
  const valid =
    keys &&
    keys.length > 0 &&
    keys.every((key) => FIELDS.includes(key)) &&
    (!("autoStart" in update) || typeof update.autoStart === "boolean") &&
    (!("answerModel" in update) || isAnswerModelChoice(update.answerModel)) &&
    (!("windowOpacity" in update) || (typeof update.windowOpacity === "number" && Number.isFinite(update.windowOpacity))) &&
    (!("repContext" in update) || typeof update.repContext === "boolean") &&
    (!("highlights" in update) || typeof update.highlights === "boolean") &&
    (!("answerCards" in update) || typeof update.answerCards === "boolean") &&
    (!("glossary" in update) || typeof update.glossary === "boolean");
  if (!valid) throw new AppPreferenceError("E_INVALID_PAYLOAD", SETTINGS_SHAPE);
  const out = {};
  if ("autoStart" in update) out.autoStart = update.autoStart;
  if ("answerModel" in update) out.answerModel = update.answerModel;
  if ("windowOpacity" in update) out.windowOpacity = clampWindowOpacity(update.windowOpacity);
  if ("repContext" in update) out.repContext = update.repContext;
  if ("highlights" in update) out.highlights = update.highlights;
  if ("answerCards" in update) out.answerCards = update.answerCards;
  if ("glossary" in update) out.glossary = update.glossary;
  return out;
}

/**
 * Whether opening the app should start a session. COPILOT_AUTOSTART=0 wins
 * (tests, scripted runs); a refused REALTIME_URL is already reported at boot.
 */
export function autoStartDecision({ env = {}, preferences = null, realtimeUrlError = null } = {}) {
  if (env?.COPILOT_AUTOSTART === "0") return { start: false, reason: "disabled-by-env" };
  if (realtimeUrlError) return { start: false, reason: "realtime-url" };
  if (!preferences || preferences.autoStart !== true) {
    return { start: false, reason: preferences?.readError ? "settings-unreadable" : "disabled" };
  }
  return { start: true, reason: "enabled" };
}

function unreadableSettings() {
  return {
    autoStart: false,
    answerModel: DEFAULT_ANSWER_MODEL,
    windowOpacity: WINDOW_OPACITY.default,
    repContext: true,
    highlights: true,
    answerCards: true,
    glossary: true,
    readError: SETTINGS_UNREADABLE,
  };
}
