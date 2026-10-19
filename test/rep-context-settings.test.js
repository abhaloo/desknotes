import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_PREFERENCES_FILENAME, createAppPreferences, validateSettingsUpdate } from "../src/desktop/app-preferences.js";
import { buildEngineConfig, createEngineFactory } from "../src/server/engines/index.js";
import { CONVERSATION_HEADING } from "../src/server/engines/conversation-context.js";

/** The three off switches: createPipelineEngine({repContext}), REP_CONTEXT, Settings. */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop");
const read = (relative) => readFileSync(join(desktop, relative), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "rep-context-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------- env ---- */

test("REP_CONTEXT: unset is on, 0/false/off is off, 1/true/on is on, junk keeps the default", () => {
  assert.equal(buildEngineConfig({}, { mode: "demo" }).repContext, true);
  for (const value of ["0", "false", "off", "OFF", " 0 "]) {
    assert.equal(buildEngineConfig({ REP_CONTEXT: value }, { mode: "demo" }).repContext, false, value);
  }
  for (const value of ["1", "true", "on", "", "maybe"]) {
    assert.equal(buildEngineConfig({ REP_CONTEXT: value }, { mode: "demo" }).repContext, true, value);
  }
});

/** One rep line, then a prospect question, through the factory with the real answerer (fetch faked). */
async function factoryContext(config) {
  const contexts = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    contexts.push(JSON.parse(init.body).messages[0].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: "- Yes." } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const factory = createEngineFactory({
      asrOptions: { provider: "mock-scripted", script: { 0: ["It's fifty-five a seat since the October update."], 1: ["And what about volume discounts for us?"] } },
      answerProvider: "openai-compatible",
      answererOptions: { baseUrl: "https://llm.test/v1", apiKey: "k", model: "m" },
      ...config,
    });
    const engine = factory({ emit: () => {}, log: () => {} });
    engine.onSessionStart({ sessionId: "f" });
    const chunk = new Int16Array(4800).fill(9000);
    for (const streamIdx of [0, 1]) {
      for (let i = 0; i < 12; i += 1) engine.onAudio({ streamIdx, seq: i, pcm16: chunk });
      engine.onFinalize({ streamIdx });
      await sleep(80);
    }
    for (let i = 0; i < 100 && contexts.length === 0; i += 1) await sleep(5);
    engine.dispose();
    return contexts[0] ?? "";
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("the engine factory forwards the switch: the fixed value, or a resolver read per answer", async () => {
  assert.ok((await factoryContext({})).includes("REP: It's fifty-five a seat since the October update."), "default on");
  assert.ok(!(await factoryContext({ repContext: false })).includes(CONVERSATION_HEADING), "REP_CONTEXT=0");
  assert.ok(!(await factoryContext({ repContext: true, repContextResolver: () => false })).includes(CONVERSATION_HEADING), "Settings off wins");
});

/* -------------------------------------------------------- settings ---- */

test("settings:set takes repContext as a boolean and refuses anything else", () => {
  assert.deepEqual(validateSettingsUpdate({ repContext: false }), { repContext: false });
  assert.deepEqual(validateSettingsUpdate({ repContext: true, autoStart: true }), { repContext: true, autoStart: true });
  for (const bad of [{ repContext: "false" }, { repContext: 0 }, { repContext: 1 }, { repContext: null }, { repContext: {} }]) {
    assert.throws(() => validateSettingsUpdate(bad), (error) => error.code === "E_INVALID_PAYLOAD", JSON.stringify(bad));
  }
});

test("repContext persists in the settings file, defaults on, and an older file reads as on", () =>
  withDir(async (dir) => {
    const file = path.join(dir, APP_PREFERENCES_FILENAME);
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).repContext, true, "first run");
    const prefs = createAppPreferences({ userDataDir: dir });
    await prefs.load();
    assert.equal((await prefs.save({ repContext: false })).repContext, false);
    assert.equal(JSON.parse(await readFile(file, "utf8")).repContext, false);
    assert.equal((await prefs.save({ autoStart: false })).repContext, false, "saving another setting keeps it");
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).repContext, false);
    for (const [saved, expected] of [[undefined, true], ["no", true], [0, true], [true, true], [false, false]]) {
      await writeFile(file, JSON.stringify({ version: 1, autoStart: true, ...(saved === undefined ? {} : { repContext: saved }) }));
      assert.equal((await createAppPreferences({ userDataDir: dir }).load()).repContext, expected, `saved ${JSON.stringify(saved)}`);
    }
    await writeFile(file, "{");
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).repContext, true, "a damaged file keeps the default");
  }));

test("Settings: the checkbox sits in Answer quality, saves through settings:set, and main reads it per answer", () => {
  const html = read("renderer/index.html");
  const section = /<section class="settings-section" aria-label="Answer quality">[\s\S]*?<\/section>\s*<section class="settings-section" aria-label="Grounding">/.exec(html)?.[0] ?? "";
  assert.match(section, /<input id="rep-context" type="checkbox" \/>\s*<span>Use what I say in answers<\/span>/);
  const app = read("renderer/app.js");
  assert.match(app, /repContext: el\("rep-context"\)/);
  assert.match(app, /CH\.SETTINGS_SET, \{ repContext: els\.repContext\.checked \}/);
  assert.match(app, /els\.repContext\.checked = repContext/);
  const main = read("main.mjs");
  assert.match(main, /repContextResolver: \(\) =>/, "the embedded server reads the setting for every answer");
  assert.match(main, /repContext: currentRepContext\(\)/, "settings:get reports it");
});
