import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  APP_PREFERENCES_FILENAME,
  SETTINGS_UNREADABLE,
  autoStartDecision,
  createAppPreferences,
  validateSettingsUpdate,
} from "../src/desktop/app-preferences.js";

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "app-prefs-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const DEFAULT = "deepseek-flash-thinking";

test("first run (no file) means auto-start on and the default answer model (DeepSeek V4.1 Flash, thinking on)", () =>
  withDir(async (dir) => {
    assert.deepEqual(await createAppPreferences({ userDataDir: dir }).load(), { autoStart: true, answerModel: DEFAULT, windowOpacity: 1, repContext: true, highlights: true, answerCards: true, glossary: true, readError: null });
  }));

test("save persists and reloads; the file holds only version, autoStart, answerModel, windowOpacity, repContext, highlights, answerCards and glossary", () =>
  withDir(async (dir) => {
    const prefs = createAppPreferences({ userDataDir: dir });
    assert.deepEqual(await prefs.save({ autoStart: false }), { autoStart: false, answerModel: DEFAULT, windowOpacity: 1, repContext: true, highlights: true, answerCards: true, glossary: true, readError: null });
    assert.deepEqual(await createAppPreferences({ userDataDir: dir }).load(), { autoStart: false, answerModel: DEFAULT, windowOpacity: 1, repContext: true, highlights: true, answerCards: true, glossary: true, readError: null });
    const stored = JSON.parse(await readFile(path.join(dir, APP_PREFERENCES_FILENAME), "utf8"));
    assert.deepEqual(stored, { version: 1, autoStart: false, answerModel: DEFAULT, windowOpacity: 1, repContext: true, highlights: true, answerCards: true, glossary: true });
  }));

test("saving one setting keeps the other", () =>
  withDir(async (dir) => {
    const prefs = createAppPreferences({ userDataDir: dir });
    await prefs.load();
    await prefs.save({ answerModel: "cerebras-qwen-thinking" });
    assert.deepEqual(await prefs.save({ autoStart: false }), { autoStart: false, answerModel: "cerebras-qwen-thinking", windowOpacity: 1, repContext: true, highlights: true, answerCards: true, glossary: true, readError: null });
    assert.deepEqual(await createAppPreferences({ userDataDir: dir }).load(), { autoStart: false, answerModel: "cerebras-qwen-thinking", windowOpacity: 1, repContext: true, highlights: true, answerCards: true, glossary: true, readError: null });
  }));

test("a value an earlier build saved migrates to a listed choice; an unknown one reads as the default", () =>
  withDir(async (dir) => {
    const file = path.join(dir, APP_PREFERENCES_FILENAME);
    const cases = [
      ["", DEFAULT], // old Automatic
      ["deepseek-v4-pro", "deepseek-flash"], // Pro answered with thinking off
      ["deepseek-flash", "deepseek-flash"], // same id, same meaning (thinking off)
      ["deepseek-flash-thinking", "deepseek-flash-thinking"],
      ["cerebras-qwen", "cerebras-qwen-thinking"], // Qwen answers only with thinking
      ["cerebras-qwen-thinking", "cerebras-qwen-thinking"],
      ["gpt-9", DEFAULT],
      ["deepseek-v4.1", DEFAULT],
      ["__proto__", DEFAULT],
      [42, DEFAULT],
      [null, DEFAULT],
    ];
    for (const [saved, expected] of cases) {
      await writeFile(file, JSON.stringify({ version: 1, autoStart: true, answerModel: saved }));
      assert.deepEqual(await createAppPreferences({ userDataDir: dir }).load(), { autoStart: true, answerModel: expected, windowOpacity: 1, repContext: true, highlights: true, answerCards: true, glossary: true, readError: null }, `saved ${JSON.stringify(saved)}`);
    }
    // A file written before the answer model existed is still valid.
    await writeFile(file, JSON.stringify({ version: 1, autoStart: false }));
    assert.deepEqual(await createAppPreferences({ userDataDir: dir }).load(), { autoStart: false, answerModel: DEFAULT, windowOpacity: 1, repContext: true, highlights: true, answerCards: true, glossary: true, readError: null });
    // The migrated value is what the next save writes.
    await writeFile(file, JSON.stringify({ version: 1, autoStart: true, answerModel: "deepseek-v4-pro" }));
    const prefs = createAppPreferences({ userDataDir: dir });
    await prefs.load();
    await prefs.save({ autoStart: false });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, autoStart: false, answerModel: "deepseek-flash", windowOpacity: 1, repContext: true, highlights: true, answerCards: true, glossary: true });
  }));

test("a damaged or wrong-shaped file never auto-starts", () =>
  withDir(async (dir) => {
    for (const body of ["{", "[]", '{"autoStart":"yes"}', "x".repeat(5000)]) {
      await writeFile(path.join(dir, APP_PREFERENCES_FILENAME), body);
      assert.deepEqual(await createAppPreferences({ userDataDir: dir }).load(), {
        autoStart: false,
        answerModel: DEFAULT,
        windowOpacity: 1,
        repContext: true,
        highlights: true,
        answerCards: true,
        glossary: true,
        readError: SETTINGS_UNREADABLE,
      });
    }
    assert.equal(SETTINGS_UNREADABLE, "Settings couldn't be read, so listening didn't start automatically.");
  }));

test("window opacity persists beside the other settings and is clamped to 30-100%", () =>
  withDir(async (dir) => {
    const file = path.join(dir, APP_PREFERENCES_FILENAME);
    const prefs = createAppPreferences({ userDataDir: dir });
    await prefs.load();
    assert.equal((await prefs.save({ windowOpacity: 0.55 })).windowOpacity, 0.55);
    assert.deepEqual(await prefs.save({ autoStart: false }), { autoStart: false, answerModel: DEFAULT, windowOpacity: 0.55, repContext: true, highlights: true, answerCards: true, glossary: true, readError: null });
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).windowOpacity, 0.55);
    assert.equal((await prefs.save({ windowOpacity: 0 })).windowOpacity, 0.3, "never invisible");
    assert.equal((await prefs.save({ windowOpacity: 7 })).windowOpacity, 1);
    for (const [saved, expected] of [[0.05, 0.3], [2, 1], ["0.5", 1], [null, 1], [0.704, 0.7]]) {
      await writeFile(file, JSON.stringify({ version: 1, autoStart: true, answerModel: DEFAULT, windowOpacity: saved }));
      assert.equal((await createAppPreferences({ userDataDir: dir }).load()).windowOpacity, expected, `saved ${JSON.stringify(saved)}`);
    }
  }));

test("validateSettingsUpdate takes autoStart and/or a listed answerModel, nothing else", () => {
  assert.deepEqual(validateSettingsUpdate({ autoStart: true }), { autoStart: true });
  assert.deepEqual(validateSettingsUpdate({ windowOpacity: 0.1 }), { windowOpacity: 0.3 });
  for (const id of ["deepseek-flash-thinking", "deepseek-flash", "cerebras-qwen-thinking"]) {
    assert.deepEqual(validateSettingsUpdate({ answerModel: id }), { answerModel: id });
  }
  assert.deepEqual(validateSettingsUpdate({ answerModel: "cerebras-qwen-thinking", autoStart: false }), { answerModel: "cerebras-qwen-thinking", autoStart: false });
  for (const bad of [
    null,
    [],
    {},
    { autoStart: "no" },
    { autoStart: true, extra: 1 },
    { path: "C:\\x" },
    // Legacy ids are read and migrated, never written.
    { answerModel: "" },
    { answerModel: "deepseek-v4-pro" },
    { answerModel: "cerebras-qwen" },
    { answerModel: "deepseek-v4.1" },
    { answerModel: "deepseek-v4.1-flash" },
    { answerModel: null },
    { windowOpacity: "0.5" },
    { windowOpacity: Number.NaN },
    { windowOpacity: null },
  ]) {
    assert.throws(() => validateSettingsUpdate(bad), (error) => error.code === "E_INVALID_PAYLOAD");
  }
});

test("autoStartDecision", () => {
  const on = { autoStart: true, readError: null };
  assert.deepEqual(autoStartDecision({ env: {}, preferences: on }), { start: true, reason: "enabled" });
  assert.deepEqual(autoStartDecision({ env: { COPILOT_AUTOSTART: "0" }, preferences: on }), { start: false, reason: "disabled-by-env" });
  assert.deepEqual(autoStartDecision({ env: {}, preferences: on, realtimeUrlError: "refused" }), { start: false, reason: "realtime-url" });
  assert.deepEqual(autoStartDecision({ env: {}, preferences: { autoStart: false, readError: null } }), { start: false, reason: "disabled" });
  assert.deepEqual(
    autoStartDecision({ env: {}, preferences: { autoStart: false, readError: SETTINGS_UNREADABLE } }),
    { start: false, reason: "settings-unreadable" },
  );
  assert.deepEqual(autoStartDecision({ env: {}, preferences: null }), { start: false, reason: "disabled" });
});

test("the store refuses a relative user-data directory", () => {
  assert.throws(() => createAppPreferences({ userDataDir: "relative" }), /absolute/);
});
