import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync as copyFileSyncReal, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATA_DIR_ENV,
  DATA_FILES,
  LEGACY_DATA_DIR_NAMES,
  MIGRATION_MARKER_FILENAME,
  defaultDataDir,
  migrateLegacyData,
  migrationSources,
  prepareDataDir,
  resolveDataDir,
} from "../src/desktop/data-dir.js";

function tempAppData(t) {
  const dir = mkdtempSync(join(tmpdir(), "desknotes-data-dir-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(dir, file, body, mtimeSeconds) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
  if (mtimeSeconds !== undefined) utimesSync(join(dir, file), mtimeSeconds, mtimeSeconds);
}

const read = (dir, file) => readFileSync(join(dir, file), "utf8");

/* ------------------------------------------------------------ resolveDataDir */

test("the default folder is %APPDATA%\\DeskNotes", () => {
  const appData = join(tmpdir(), "AppDataRoaming");
  assert.deepEqual(resolveDataDir({ env: {}, appData }), { dir: join(appData, "DeskNotes"), custom: false, warning: null });
  assert.equal(resolveDataDir({ env: { [DATA_DIR_ENV]: "   " }, appData }).dir, join(appData, "DeskNotes"), "blank is unset");
  assert.equal(defaultDataDir(appData), join(appData, "DeskNotes"));
});

test("DESKNOTES_DATA_DIR picks an absolute custom folder (trimmed, one pair of quotes removed)", () => {
  const appData = join(tmpdir(), "AppDataRoaming");
  const custom = join(tmpdir(), "OneDrive", "DeskNotes");
  assert.deepEqual(resolveDataDir({ env: { [DATA_DIR_ENV]: `  ${custom}  ` }, appData }), { dir: custom, custom: true, warning: null });
  assert.equal(resolveDataDir({ env: { [DATA_DIR_ENV]: `"${custom}"` }, appData }).dir, custom);
  // Pointing it at the default folder is not "custom".
  assert.equal(resolveDataDir({ env: { [DATA_DIR_ENV]: join(appData, "DeskNotes") }, appData }).custom, false);
});

test("a relative DESKNOTES_DATA_DIR is ignored with a warning", () => {
  const appData = join(tmpdir(), "AppDataRoaming");
  const resolved = resolveDataDir({ env: { [DATA_DIR_ENV]: "notes\\here" }, appData });
  assert.equal(resolved.dir, join(appData, "DeskNotes"));
  assert.equal(resolved.custom, false);
  assert.match(resolved.warning, /DESKNOTES_DATA_DIR must be an absolute path/);
});

/* ---------------------------------------------------------- migrationSources */

test("sources: the two legacy siblings; a custom folder takes the default folder first", (t) => {
  const appData = tempAppData(t);
  const legacy = LEGACY_DATA_DIR_NAMES.map((name) => join(appData, name));
  assert.deepEqual(LEGACY_DATA_DIR_NAMES, ["Electron", "mock-sales-copilot"]);
  assert.deepEqual(migrationSources({ target: join(appData, "DeskNotes"), appData }), legacy);
  const custom = join(appData, "elsewhere");
  assert.deepEqual(migrationSources({ target: custom, appData, custom: true }), [join(appData, "DeskNotes"), ...legacy]);
  // Once the default folder has migrated, it alone is the truth.
  put(join(appData, "DeskNotes"), MIGRATION_MARKER_FILENAME, "{}");
  assert.deepEqual(migrationSources({ target: custom, appData, custom: true }), [join(appData, "DeskNotes")]);
});

/* ---------------------------------------------------------- migrateLegacyData */

test("the data files are the app's own, never Chromium profile files", () => {
  assert.deepEqual([...DATA_FILES].sort(), [
    "answer-instructions.txt",
    "app-preferences.json",
    "audio-device-preferences.json",
    "grounding-document.json",
    "known-terms.txt",
    "panel-bounds.json",
    "practice-debrief.json",
    "practice-material.json",
  ]);
});

test("each missing file comes from the source where it is newest; legacy folders are untouched", (t) => {
  const appData = tempAppData(t);
  const dev = join(appData, "Electron");
  const exe = join(appData, "mock-sales-copilot");
  const target = join(appData, "DeskNotes");
  put(dev, "answer-instructions.txt", "dev instructions", 2_000_000_000);
  put(exe, "answer-instructions.txt", "exe instructions", 1_000_000_000);
  put(dev, "app-preferences.json", '{"autoStart":true}', 1_000_000_000);
  put(exe, "app-preferences.json", '{"autoStart":false}', 2_000_000_000);
  put(exe, "grounding-document.json", "{}", 1_500_000_000);
  put(dev, "Local State", "chromium");
  put(dev, "Preferences", "chromium");
  const devBefore = readdirSync(dev).sort();

  const result = migrateLegacyData({ target, sources: [dev, exe], now: () => new Date("2026-10-16T09:00:00Z") });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.copied, [
    { file: "answer-instructions.txt", from: dev },
    { file: "app-preferences.json", from: exe },
    { file: "grounding-document.json", from: exe },
  ]);
  assert.equal(read(target, "answer-instructions.txt"), "dev instructions");
  assert.equal(read(target, "app-preferences.json"), '{"autoStart":false}');
  assert.equal(existsSync(join(target, "Local State")), false, "Chromium profile files stay behind");
  assert.equal(existsSync(join(target, "Preferences")), false);
  assert.deepEqual(readdirSync(dev).sort(), devBefore, "the legacy folder keeps everything");
  assert.equal(read(dev, "answer-instructions.txt"), "dev instructions");

  const marker = JSON.parse(read(target, MIGRATION_MARKER_FILENAME));
  assert.equal(marker.migratedAt, "2026-10-16T09:00:00.000Z");
  assert.deepEqual(marker.sources, [dev, exe]);
  assert.deepEqual(marker.copied, result.copied);
});

test("a file the target already has is never overwritten", (t) => {
  const appData = tempAppData(t);
  const dev = join(appData, "Electron");
  const target = join(appData, "DeskNotes");
  put(dev, "answer-instructions.txt", "old", 2_000_000_000);
  put(target, "answer-instructions.txt", "mine", 1_000_000_000);
  const result = migrateLegacyData({ target, sources: [dev] });
  assert.deepEqual(result.copied, []);
  assert.ok(result.skipped.some((s) => s.file === "answer-instructions.txt" && s.reason === "present"));
  assert.equal(read(target, "answer-instructions.txt"), "mine");
});

test("missing sources are fine and still write the marker", (t) => {
  const appData = tempAppData(t);
  const target = join(appData, "DeskNotes");
  const result = migrateLegacyData({ target, sources: [join(appData, "Electron"), join(appData, "mock-sales-copilot")] });
  assert.deepEqual(result.copied, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.skipped.length, DATA_FILES.length);
  assert.ok(existsSync(join(target, MIGRATION_MARKER_FILENAME)));
});

test("it runs once: a Clear after migration does not bring the old document back", (t) => {
  const appData = tempAppData(t);
  const exe = join(appData, "mock-sales-copilot");
  const target = join(appData, "DeskNotes");
  put(exe, "grounding-document.json", '{"name":"old.md"}');
  const first = migrateLegacyData({ target, sources: [exe] });
  assert.deepEqual(first.copied, [{ file: "grounding-document.json", from: exe }]);

  rmSync(join(target, "grounding-document.json")); // the rep pressed Clear
  const second = migrateLegacyData({ target, sources: [exe] });
  assert.equal(second.alreadyMigrated, true);
  assert.deepEqual(second.copied, []);
  assert.equal(existsSync(join(target, "grounding-document.json")), false, "the cleared document stays cleared");
  assert.ok(existsSync(join(exe, "grounding-document.json")), "the backup stays");
});

test("a marker written when nothing was copied also stops a later resurrection", (t) => {
  const appData = tempAppData(t);
  const dev = join(appData, "Electron");
  const target = join(appData, "DeskNotes");
  migrateLegacyData({ target, sources: [dev] }); // nothing to copy yet
  put(dev, "grounding-document.json", "{}"); // an old dev build writes later
  const again = migrateLegacyData({ target, sources: [dev] });
  assert.equal(again.alreadyMigrated, true);
  assert.equal(existsSync(join(target, "grounding-document.json")), false);
});

test("one failing file does not stop the others, and nothing throws", (t) => {
  const appData = tempAppData(t);
  const dev = join(appData, "Electron");
  const target = join(appData, "DeskNotes");
  put(dev, "answer-instructions.txt", "a");
  put(dev, "app-preferences.json", "{}");
  const fs = {
    mkdirSync: (...args) => mkdirSync(...args),
    existsSync: (...args) => existsSync(...args),
    statSync: (...args) => statSync(...args),
    writeFileSync: (...args) => writeFileSync(...args),
    copyFileSync(from, to, mode) {
      if (from.endsWith("answer-instructions.txt")) throw new Error("EBUSY: locked");
      return Reflect.apply(copyFileSyncReal, null, [from, to, mode]);
    },
  };
  const result = migrateLegacyData({ target, sources: [dev], fs });
  assert.deepEqual(result.errors, [{ file: "answer-instructions.txt", message: "EBUSY: locked" }]);
  assert.deepEqual(result.copied, [{ file: "app-preferences.json", from: dev }]);
  assert.ok(existsSync(join(target, MIGRATION_MARKER_FILENAME)));
});

test("a target that cannot be created is reported, not thrown", () => {
  const fs = {
    mkdirSync() {
      throw new Error("EACCES");
    },
    existsSync: () => false,
    statSync: () => {
      throw new Error("no");
    },
    copyFileSync() {},
    writeFileSync() {},
  };
  const result = migrateLegacyData({ target: join(tmpdir(), "nope"), sources: [], fs });
  assert.equal(result.targetReady, false);
  assert.equal(result.errors.length, 1);
});

/* ------------------------------------------------------------ prepareDataDir */

test("a custom folder is created and filled from the default folder first", (t) => {
  const appData = tempAppData(t);
  const custom = join(appData, "OneDrive", "Notes", "DeskNotes");
  put(join(appData, "DeskNotes"), "answer-instructions.txt", "from default", 2_000_000_000);
  put(join(appData, "Electron"), "answer-instructions.txt", "from dev", 1_000_000_000);
  const prepared = prepareDataDir({ env: { [DATA_DIR_ENV]: custom }, appData });
  assert.equal(prepared.dir, custom);
  assert.equal(prepared.custom, true);
  assert.deepEqual(prepared.warnings, []);
  assert.equal(read(custom, "answer-instructions.txt"), "from default");
});

test("a custom folder that cannot be created falls back to the default folder", (t) => {
  const appData = tempAppData(t);
  const blocker = join(appData, "blocker");
  writeFileSync(blocker, "a file, so no folder can be made under it");
  const prepared = prepareDataDir({ env: { [DATA_DIR_ENV]: join(blocker, "DeskNotes") }, appData });
  assert.equal(prepared.dir, join(appData, "DeskNotes"));
  assert.equal(prepared.custom, false);
  assert.match(prepared.warnings[0], /couldn't create/);
  assert.ok(existsSync(join(appData, "DeskNotes", MIGRATION_MARKER_FILENAME)));
});
