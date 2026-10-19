/**
 * One data folder for every build. Electron names userData after the launcher:
 * a dev run (`electron src/desktop/main.mjs`) gets %APPDATA%\Electron, a name
 * any Electron app can share, and the packaged exe gets
 * %APPDATA%\mock-sales-copilot (package.json `name`). Edits made in one build
 * never reached the other. main.mjs now pins userData to %APPDATA%\DeskNotes
 * (or DESKNOTES_DATA_DIR) before the single-instance lock, which is keyed on
 * userData, and before `ready`.
 *
 * DESKNOTES_DATA_DIR is read from process.env only. A user environment
 * variable set after the launching shell or Explorer started is not seen
 * until a fresh sign-in (or an Explorer restart), the same as the provider
 * keys. Only an absolute path counts: a relative one would move with the
 * working directory, so it is ignored with a warning. One pair of surrounding
 * double quotes is removed (the Windows variable dialog keeps them). A custom
 * folder that does not exist is created; if it cannot be created the default
 * folder is used instead.
 *
 * The first launch copies the app's own data files from the old folders.
 * It runs at most once per folder: a marker file records what was copied from
 * where. A file the folder already has is never overwritten, and the old
 * folders are never changed (they stay as a backup). Chromium's own profile
 * files (Local State, Preferences, caches...) are not app data and stay put.
 * The marker is written even when nothing was copied: without it, a later
 * Clear (which deletes grounding-document.json) would bring an old document
 * back from a legacy folder on the next launch.
 */
import { constants, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_PREFERENCES_FILENAME } from "./app-preferences.js";
import { PREFERENCES_FILENAME as AUDIO_DEVICE_PREFERENCES_FILENAME } from "./audio-device-preferences.js";
import { GROUNDING_FILENAME } from "./grounding-document.js";
import { PANEL_BOUNDS_FILE } from "./panel-manager.js";
import { PRACTICE_DEBRIEF_FILENAME } from "./practice-debrief.js";
import { PRACTICE_MATERIAL_FILENAME } from "./practice/material.js";
import { ANSWER_INSTRUCTIONS_FILENAME } from "../server/engines/answer-instructions.js";
import { KNOWN_TERMS_FILENAME } from "../server/engines/glossary.js";

export const DATA_DIR_ENV = "DESKNOTES_DATA_DIR";
export const DATA_DIR_NAME = "DeskNotes";
/** Siblings under %APPDATA% that earlier builds used as userData. */
export const LEGACY_DATA_DIR_NAMES = Object.freeze(["Electron", "mock-sales-copilot"]);
export const MIGRATION_MARKER_FILENAME = ".migrated-from-legacy.json";
/** The app's own files in userData. Nothing else is carried over. */
export const DATA_FILES = Object.freeze([
  ANSWER_INSTRUCTIONS_FILENAME,
  APP_PREFERENCES_FILENAME,
  AUDIO_DEVICE_PREFERENCES_FILENAME,
  GROUNDING_FILENAME,
  KNOWN_TERMS_FILENAME,
  PANEL_BOUNDS_FILE,
  PRACTICE_MATERIAL_FILENAME,
  PRACTICE_DEBRIEF_FILENAME,
]);

const defaultFs = Object.freeze({ copyFileSync, existsSync, mkdirSync, statSync, writeFileSync });

export function defaultDataDir(appData) {
  return path.join(appData, DATA_DIR_NAME);
}

/**
 * @returns {{ dir: string, custom: boolean, warning: string | null }}
 *   `custom` is true when DESKNOTES_DATA_DIR chose the folder.
 */
export function resolveDataDir({ env = process.env, appData } = {}) {
  const fallback = defaultDataDir(appData);
  const raw = typeof env?.[DATA_DIR_ENV] === "string" ? unquote(env[DATA_DIR_ENV].trim()) : "";
  if (raw.length === 0) return { dir: fallback, custom: false, warning: null };
  if (!path.isAbsolute(raw)) {
    return { dir: fallback, custom: false, warning: `${DATA_DIR_ENV} must be an absolute path; ignored "${raw}", using ${fallback}` };
  }
  const dir = path.resolve(raw);
  return { dir, custom: !samePath(dir, fallback), warning: null };
}

/**
 * Folders a first launch may copy from, in order. A custom folder also takes
 * the default %APPDATA%\DeskNotes first, so a move to (say) OneDrive keeps the
 * rep's files. When the default folder has already migrated (it has the
 * marker), it alone is the truth: the legacy folders are not read again.
 */
export function migrationSources({ target, appData, custom = false, fs } = {}) {
  const io = fs ?? defaultFs;
  const legacy = LEGACY_DATA_DIR_NAMES.map((name) => path.join(appData, name));
  let sources = legacy;
  if (custom) {
    const fallback = defaultDataDir(appData);
    sources = exists(io, path.join(fallback, MIGRATION_MARKER_FILENAME)) ? [fallback] : [fallback, ...legacy];
  }
  return sources.filter((source) => !samePath(source, target));
}

/**
 * Copies each data file the target lacks from the source where that file is
 * newest. Synchronous: it runs before `app.ready`. Never throws.
 * @returns {{ copied: {file: string, from: string}[], skipped: {file: string, reason: string}[], errors: {file: string, message: string}[], alreadyMigrated: boolean, targetReady: boolean }}
 */
export function migrateLegacyData({ target, sources = [], fs, now = () => new Date() } = {}) {
  const io = fs ?? defaultFs;
  const summary = { copied: [], skipped: [], errors: [], alreadyMigrated: false, targetReady: false };
  try {
    io.mkdirSync(target, { recursive: true });
    summary.targetReady = true;
  } catch (error) {
    summary.errors.push({ file: target, message: messageOf(error) });
    return summary;
  }
  const markerPath = path.join(target, MIGRATION_MARKER_FILENAME);
  if (exists(io, markerPath)) {
    summary.alreadyMigrated = true;
    return summary;
  }
  const from = sources.filter((source) => typeof source === "string" && source.length > 0 && !samePath(source, target));
  for (const file of DATA_FILES) {
    try {
      const destination = path.join(target, file);
      if (exists(io, destination)) {
        summary.skipped.push({ file, reason: "present" });
        continue;
      }
      const source = newestSource(io, from, file);
      if (!source) {
        summary.skipped.push({ file, reason: "absent" });
        continue;
      }
      // COPYFILE_EXCL: a file that appeared meanwhile is still never overwritten.
      io.copyFileSync(path.join(source, file), destination, constants.COPYFILE_EXCL);
      summary.copied.push({ file, from: source });
    } catch (error) {
      summary.errors.push({ file, message: messageOf(error) });
    }
  }
  try {
    const marker = { version: 1, migratedAt: now().toISOString(), sources: from, copied: summary.copied, errors: summary.errors };
    io.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  } catch (error) {
    summary.errors.push({ file: MIGRATION_MARKER_FILENAME, message: messageOf(error) });
  }
  return summary;
}

/**
 * The whole launch step: pick the folder, fall back to the default when a
 * custom one cannot be created, and migrate into it. Never throws.
 * @returns {{ dir: string, custom: boolean, warnings: string[], migration: ReturnType<typeof migrateLegacyData> }}
 */
export function prepareDataDir({ env = process.env, appData, fs, now } = {}) {
  const resolved = resolveDataDir({ env, appData });
  const warnings = resolved.warning ? [resolved.warning] : [];
  let { dir, custom } = resolved;
  let migration = migrateLegacyData({ target: dir, sources: migrationSources({ target: dir, appData, custom, fs }), fs, now });
  if (!migration.targetReady && custom) {
    warnings.push(`couldn't create ${dir} (${migration.errors[0]?.message ?? "error"}); using ${defaultDataDir(appData)}`);
    dir = defaultDataDir(appData);
    custom = false;
    migration = migrateLegacyData({ target: dir, sources: migrationSources({ target: dir, appData, custom, fs }), fs, now });
  }
  return { dir, custom, warnings, migration };
}

function newestSource(io, sources, file) {
  let best = null;
  let bestMtime = -Infinity;
  for (const source of sources) {
    let info;
    try {
      info = io.statSync(path.join(source, file));
    } catch {
      continue; // a missing folder or file is fine
    }
    if (!info?.isFile?.()) continue;
    const mtime = Number(info.mtimeMs ?? 0);
    // Strictly newer: on a tie the earlier source wins.
    if (mtime > bestMtime) {
      best = source;
      bestMtime = mtime;
    }
  }
  return best;
}

function exists(io, file) {
  try {
    return io.existsSync(file);
  } catch {
    return false;
  }
}

function unquote(value) {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).trim() : value;
}

/** Windows paths compare case-insensitively. */
function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function messageOf(error) {
  return error instanceof Error ? error.message || error.name : String(error);
}
