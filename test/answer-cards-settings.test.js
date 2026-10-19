import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_PREFERENCES_FILENAME, createAppPreferences, validateSettingsUpdate } from "../src/desktop/app-preferences.js";
import { buildEngineConfig } from "../src/server/engines/index.js";
import { ANSWER_CARDS_ENV, ANSWER_CARDS_SETTING, parseAnswerCardsSwitch } from "../src/shared/answer-cards.js";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop");
const read = (relative) => readFileSync(join(desktop, relative), "utf8");

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "answer-cards-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ANSWER_CARDS: default true; ANSWER_CARDS=0 gives engine config answerCards: false", () => {
  assert.equal(ANSWER_CARDS_ENV, "ANSWER_CARDS");
  assert.equal(buildEngineConfig({}, { mode: "demo" }).answerCards, true);
  for (const value of ["0", "false", "off", "OFF", " 0 "]) {
    assert.equal(buildEngineConfig({ ANSWER_CARDS: value }, { mode: "demo" }).answerCards, false, value);
  }
  for (const value of ["1", "true", "on", "", "maybe"]) {
    assert.equal(buildEngineConfig({ ANSWER_CARDS: value }, { mode: "demo" }).answerCards, true, value);
  }
  assert.equal(parseAnswerCardsSwitch("maybe"), null, "junk is reported, not guessed");
});

test("settings:set takes answerCards as a boolean and validateSettingsUpdate({answerCards: 'no'}) throws E_INVALID_PAYLOAD", () => {
  assert.equal(ANSWER_CARDS_SETTING, "answerCards");
  assert.deepEqual(validateSettingsUpdate({ answerCards: false }), { answerCards: false });
  assert.deepEqual(validateSettingsUpdate({ answerCards: true, highlights: false }), { answerCards: true, highlights: false });
  for (const bad of [{ answerCards: "no" }, { answerCards: "false" }, { answerCards: 0 }, { answerCards: 1 }, { answerCards: null }, { answerCards: {} }]) {
    assert.throws(() => validateSettingsUpdate(bad), (error) => error.code === "E_INVALID_PAYLOAD", JSON.stringify(bad));
  }
});

test("answerCards defaults true; false persists and loads", () =>
  withDir(async (dir) => {
    const file = path.join(dir, APP_PREFERENCES_FILENAME);
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).answerCards, true, "first run");
    const prefs = createAppPreferences({ userDataDir: dir });
    await prefs.load();
    assert.equal((await prefs.save({ answerCards: false })).answerCards, false);
    assert.equal(JSON.parse(await readFile(file, "utf8")).answerCards, false);
    assert.equal((await prefs.save({ highlights: false })).answerCards, false, "saving another setting keeps it");
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).answerCards, false);
    for (const [saved, expected] of [[undefined, true], ["no", true], [0, true], [true, true], [false, false]]) {
      await writeFile(file, JSON.stringify({ version: 1, autoStart: true, ...(saved === undefined ? {} : { answerCards: saved }) }));
      assert.equal((await createAppPreferences({ userDataDir: dir }).load()).answerCards, expected, `saved ${JSON.stringify(saved)}`);
    }
    await writeFile(file, "{");
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).answerCards, true, "a damaged file keeps the default");
  }));

test("main passes cards: true and highlights: true to practice answers when each is on", () => {
  const main = read("main.mjs");
  assert.match(main, /currentAnswerCards\(\)/, "main has currentAnswerCards helper");
  assert.match(main, /answerCardsResolver:\s*\(\)\s*=>\s*currentAnswerCards\(\)/, "the embedded server reads the setting for every answer");
  assert.match(main, /answerCards:\s*currentAnswerCards\(\)/, "settings:get reports it");
  assert.match(
    main,
    /streamAnswer:\s*\(args\)\s*=>\s*engine\.answerer\.streamAnswer\(practiceAnswerArgs\(args\)\)/,
    "practice streamAnswer goes through practiceAnswerArgs",
  );
  const helper = /function practiceAnswerArgs\(args\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
  assert.match(helper, /currentAnswerCards\(\)\s*\?\s*\{\s*cards:\s*true\s*\}\s*:\s*\{\s*\}/, "cards: true only when cards are on");
  assert.match(helper, /currentHighlights\(\)\s*\?\s*\{\s*highlights:\s*true\s*\}\s*:\s*\{\s*\}/, "highlights: true only when highlights are on");
});

test("practice paints highlights in the same color as the overlay", () => {
  const css = read("renderer/styles.css");
  const rule = /([^{}]*)\{\s*color:\s*var\(--highlight\);/.exec(css)?.[1] ?? "";
  assert.match(rule, /\.answer-text \.hl/);
  assert.match(rule, /\.practice-prose \.hl/);
});
