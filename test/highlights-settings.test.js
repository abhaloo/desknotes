import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_PREFERENCES_FILENAME, createAppPreferences, validateSettingsUpdate } from "../src/desktop/app-preferences.js";
import { buildEngineConfig } from "../src/server/engines/index.js";
import { HIGHLIGHTS_ENV, HIGHLIGHTS_SETTING, parseHighlightsSwitch } from "../src/shared/highlights.js";

/** The three off switches: createPipelineEngine({highlights}), HIGHLIGHTS, Settings. */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop");
const read = (relative) => readFileSync(join(desktop, relative), "utf8");

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "highlights-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("HIGHLIGHTS: unset is on, 0/false/off is off, 1/true/on is on, junk keeps the default", () => {
  assert.equal(HIGHLIGHTS_ENV, "HIGHLIGHTS");
  assert.equal(buildEngineConfig({}, { mode: "demo" }).highlights, true);
  for (const value of ["0", "false", "off", "OFF", " 0 "]) {
    assert.equal(buildEngineConfig({ HIGHLIGHTS: value }, { mode: "demo" }).highlights, false, value);
  }
  for (const value of ["1", "true", "on", "", "maybe"]) {
    assert.equal(buildEngineConfig({ HIGHLIGHTS: value }, { mode: "demo" }).highlights, true, value);
  }
  assert.equal(parseHighlightsSwitch("maybe"), null, "junk is reported, not guessed");
});

test("settings:set takes highlights as a boolean and refuses anything else", () => {
  assert.equal(HIGHLIGHTS_SETTING, "highlights");
  assert.deepEqual(validateSettingsUpdate({ highlights: false }), { highlights: false });
  assert.deepEqual(validateSettingsUpdate({ highlights: true, repContext: false }), { highlights: true, repContext: false });
  for (const bad of [{ highlights: "false" }, { highlights: 0 }, { highlights: 1 }, { highlights: null }, { highlights: {} }]) {
    assert.throws(() => validateSettingsUpdate(bad), (error) => error.code === "E_INVALID_PAYLOAD", JSON.stringify(bad));
  }
});

test("highlights persists in the settings file, defaults on, and an older file reads as on", () =>
  withDir(async (dir) => {
    const file = path.join(dir, APP_PREFERENCES_FILENAME);
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).highlights, true, "first run");
    const prefs = createAppPreferences({ userDataDir: dir });
    await prefs.load();
    assert.equal((await prefs.save({ highlights: false })).highlights, false);
    assert.equal(JSON.parse(await readFile(file, "utf8")).highlights, false);
    assert.equal((await prefs.save({ repContext: false })).highlights, false, "saving another setting keeps it");
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).highlights, false);
    for (const [saved, expected] of [[undefined, true], ["no", true], [0, true], [true, true], [false, false]]) {
      await writeFile(file, JSON.stringify({ version: 1, autoStart: true, ...(saved === undefined ? {} : { highlights: saved }) }));
      assert.equal((await createAppPreferences({ userDataDir: dir }).load()).highlights, expected, `saved ${JSON.stringify(saved)}`);
    }
    await writeFile(file, "{");
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).highlights, true, "a damaged file keeps the default");
  }));

test("Settings: the checkbox sits in Answer quality, saves through settings:set, and main reads it per answer", () => {
  const html = read("renderer/index.html");
  const section = /<section class="settings-section" aria-label="Answer quality">[\s\S]*?<\/section>\s*<section class="settings-section" aria-label="Grounding">/.exec(html)?.[0] ?? "";
  assert.match(section, /<input id="highlights" type="checkbox" \/>\s*<span>Highlight key phrases<\/span>/);
  const app = read("renderer/app.js");
  assert.match(app, /highlights: el\("highlights"\)/);
  assert.match(app, /CH\.SETTINGS_SET, \{ highlights: els\.highlights\.checked \}/);
  assert.match(app, /els\.highlights\.checked = highlights/);
  const main = read("main.mjs");
  assert.match(main, /highlightsResolver: \(\) => currentHighlights\(\)/, "the embedded server reads the setting for every answer");
  assert.match(main, /highlights: currentHighlights\(\)/, "settings:get reports it");
});
