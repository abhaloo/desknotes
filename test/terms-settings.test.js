import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_PREFERENCES_FILENAME, createAppPreferences, validateSettingsUpdate } from "../src/desktop/app-preferences.js";
import { COMMAND_CHANNELS, IPC } from "../src/desktop/ipc-gateway.js";
import { ErrorCode } from "../src/desktop/ipc-error-codes.js";
import { buildEngineConfig, createEngineFactory } from "../src/server/engines/index.js";
import { GLOSSARY_ENV, GLOSSARY_SETTING, KNOWN_TERMS_FILENAME, parseGlossarySwitch } from "../src/server/engines/glossary.js";

/** The three off switches: createPipelineEngine({glossary}), GLOSSARY, Settings. */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop");
const read = (relative) => readFileSync(join(desktop, relative), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "terms-settings-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("GLOSSARY: unset is on, 0/false/off is off, 1/true/on is on, junk keeps the default", () => {
  assert.equal(GLOSSARY_ENV, "GLOSSARY");
  assert.equal(buildEngineConfig({}, { mode: "demo" }).glossary, true);
  for (const value of ["0", "false", "off", "OFF", " 0 "]) {
    assert.equal(buildEngineConfig({ GLOSSARY: value }, { mode: "demo" }).glossary, false, value);
  }
  for (const value of ["1", "true", "on", "", "maybe"]) {
    assert.equal(buildEngineConfig({ GLOSSARY: value }, { mode: "demo" }).glossary, true, value);
  }
  assert.equal(parseGlossarySwitch("maybe"), null, "junk is reported, not guessed");
});

test("the glossary runs only with DEEPSEEK_API_KEY: no other key or engine stands in", () => {
  const none = [{}, { CEREBRAS_API_KEY: "c" }, { LLM_BASE_URL: "https://api.deepseek.com", LLM_API_KEY: "l", ANSWER_PROVIDER: "openai-compatible" }];
  for (const env of none) assert.equal(buildEngineConfig(env, { mode: "demo" }).glossaryOptions, null, JSON.stringify(Object.keys(env)));
  assert.deepEqual(buildEngineConfig({ DEEPSEEK_API_KEY: "d", CEREBRAS_API_KEY: "c" }, { mode: "demo" }).glossaryOptions, {
    apiKey: "d",
    knownTermsPath: null,
  });
  assert.equal(
    buildEngineConfig({ DEEPSEEK_API_KEY: "d", KNOWN_TERMS_PATH: "C:\\env\\known-terms.txt" }, { mode: "demo" }).glossaryOptions.knownTermsPath,
    "C:\\env\\known-terms.txt",
  );
  assert.equal(
    buildEngineConfig({ DEEPSEEK_API_KEY: "d", KNOWN_TERMS_PATH: "C:\\env\\x.txt" }, { mode: "demo", knownTermsPath: "C:\\app\\known-terms.txt" }).glossaryOptions
      .knownTermsPath,
    "C:\\app\\known-terms.txt",
    "the desktop shell's path wins",
  );
});

/** End to end: the engine factory, one glossary per session, the resolver, the frame. */
async function factoryTerms(config) {
  const frames = [];
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    const card = body.messages[1].content.split("CARD:\n")[1] ?? "";
    const word = card.match(/[A-Za-z]{6,}/)?.[0] ?? "nothing";
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ terms: [{ term: word, full_name: null, what: "A word from the card." }] }) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const factory = createEngineFactory({
    answerProvider: "mock",
    answererOptions: { deltaMinMs: 0, deltaMaxMs: 0 },
    telemetryOptions: { enabled: false },
    glossaryOptions: { apiKey: "sk-test-glossary", fetchImpl },
    ...config,
  });
  const engine = factory({ emit: (frame) => frames.push(frame), log: () => {} });
  engine.onSessionStart({ sessionId: "t" });
  engine.onAnswerRequest({ utterance: "How would you design the ingestion pipeline?" });
  for (let i = 0; i < 300 && !frames.some((frame) => frame.type === "turn.done"); i += 1) await sleep(5);
  for (let i = 0; i < 40 && !frames.some((frame) => frame.type === "terms"); i += 1) await sleep(5);
  engine.dispose();
  return { frames, requests };
}

test("the engine factory explains the card with a per-session glossary; the resolver and the switch turn it off", async () => {
  const on = await factoryTerms({});
  assert.equal(on.requests.length, 1);
  assert.equal(on.requests[0].url, "https://api.deepseek.com/chat/completions");
  const terms = on.frames.find((frame) => frame.type === "terms");
  assert.ok(terms, "a terms frame");
  assert.equal(terms.data.turn_id, on.frames.find((frame) => frame.type === "turn.done").data.turn_id);
  for (const config of [{ glossary: false }, { glossary: true, glossaryResolver: () => false }, { glossaryOptions: null }]) {
    const off = await factoryTerms(config);
    assert.equal(off.requests.length, 0, JSON.stringify(Object.keys(config)));
    assert.equal(off.frames.some((frame) => frame.type === "terms"), false);
  }
});

test("settings:set takes glossary as a boolean and refuses anything else", () => {
  assert.equal(GLOSSARY_SETTING, "glossary");
  assert.deepEqual(validateSettingsUpdate({ glossary: false }), { glossary: false });
  assert.deepEqual(validateSettingsUpdate({ glossary: true, answerCards: false }), { glossary: true, answerCards: false });
  for (const bad of [{ glossary: "false" }, { glossary: 0 }, { glossary: 1 }, { glossary: null }, { glossary: {} }]) {
    assert.throws(() => validateSettingsUpdate(bad), (error) => error.code === "E_INVALID_PAYLOAD", JSON.stringify(bad));
  }
});

test("glossary persists in the settings file, defaults on, and an older or damaged file reads as on", () =>
  withDir(async (dir) => {
    const file = path.join(dir, APP_PREFERENCES_FILENAME);
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).glossary, true, "first run");
    const prefs = createAppPreferences({ userDataDir: dir });
    await prefs.load();
    assert.equal((await prefs.save({ glossary: false })).glossary, false);
    assert.equal(JSON.parse(await readFile(file, "utf8")).glossary, false);
    assert.equal((await prefs.save({ highlights: false })).glossary, false, "saving another setting keeps it");
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).glossary, false);
    for (const [saved, expected] of [[undefined, true], ["no", true], [0, true], [true, true], [false, false]]) {
      await writeFile(file, JSON.stringify({ version: 1, autoStart: true, ...(saved === undefined ? {} : { glossary: saved }) }));
      assert.equal((await createAppPreferences({ userDataDir: dir }).load()).glossary, expected, `saved ${JSON.stringify(saved)}`);
    }
    await writeFile(file, "{");
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).glossary, true, "a damaged file keeps the default");
  }));

test("main reads the setting once per turn, seeds known-terms.txt and reports both in settings:get", () => {
  const main = read("main.mjs");
  assert.match(main, /function currentGlossary\(\) \{[\s\S]*?parseGlossarySwitch\(process\.env\.GLOSSARY\) !== false;/);
  assert.match(main, /glossaryResolver: \(\) => currentGlossary\(\)/, "the embedded server reads the setting for every turn");
  assert.match(main, /glossary: currentGlossary\(\),/, "settings:get reports it");
  assert.match(main, /knownTermsPath: knownTermsPath\(\),[\s\S]*?knownTermsPath: knownTermsPath\(\),/, "the engine and settings:get get the path");
  assert.match(main, /join\(userDataDirectory\(\), KNOWN_TERMS_FILENAME\)/);
  assert.match(main, /await ensureKnownTermsFile\(knownTermsPath\(\)\)/, "seeded empty at boot");
  assert.equal(KNOWN_TERMS_FILENAME, "known-terms.txt");
});

test("settings:openKnownTerms is a command wired end to end", () => {
  assert.equal(IPC.SETTINGS_OPEN_KNOWN_TERMS, "settings:openKnownTerms");
  assert.ok(COMMAND_CHANNELS.includes(IPC.SETTINGS_OPEN_KNOWN_TERMS));
  assert.equal(ErrorCode.OPEN_FILE, "E_OPEN_FILE");

  const preload = read("preload.cjs");
  assert.match(preload, /SETTINGS_OPEN_KNOWN_TERMS: "settings:openKnownTerms"/);
  assert.match(preload, /const COMMAND_CHANNELS = Object\.freeze\(\[[\s\S]*?IPC\.SETTINGS_OPEN_KNOWN_TERMS,[\s\S]*?\]\);/);
  assert.match(preload, /openKnownTerms\(\) \{\s*return command\(IPC\.SETTINGS_OPEN_KNOWN_TERMS, null\);/);

  const main = read("main.mjs");
  assert.match(main, /\[IPC\.SETTINGS_OPEN_KNOWN_TERMS\]: \(\) => commandOpenKnownTerms\(\),/);
  const handler = /async function commandOpenKnownTerms\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
  assert.match(handler, /await ensureKnownTermsFile\(file\)/, "a deleted file is created again before it opens");
  assert.match(handler, /await shell\.openPath\(file\)/);
  assert.match(handler, /failEnvelope\(ErrorCode\.OPEN_FILE,/);

  const app = read("renderer/app.js");
  assert.match(app, /btnOpenKnownTerms: el\("btn-open-known-terms"\)/);
  assert.match(app, /els\.btnOpenKnownTerms\?\.addEventListener\("click", onOpenKnownTerms\)/);
  assert.match(app, /async function onOpenKnownTerms\(\) \{[\s\S]*?await bridge\.openKnownTerms\(\);[\s\S]*?showToast\(/);
});

test("Settings: the checkbox sits in Answer quality, the link beside the answer instructions, and a missing key is named", () => {
  const html = read("renderer/index.html");
  const section = /<section class="settings-section" aria-label="Answer quality">[\s\S]*?<\/section>\s*<section class="settings-section" aria-label="Grounding">/.exec(html)?.[0] ?? "";
  assert.match(section, /<input id="glossary" type="checkbox" \/>\s*<span>Explain terms<\/span>/);
  assert.match(section, /<p id="glossary-note" class="meta" hidden><\/p>/);
  const field = /<span class="field-label">Answer instructions file<\/span>[\s\S]*?<\/div>\s*<\/div>/.exec(html)?.[0] ?? "";
  const button = /<button id="btn-open-known-terms"[^>]*>[^<]*<\/button>/.exec(field)?.[0] ?? "";
  assert.ok(button, "the known-terms button is beside Open settings folder");
  assert.match(button, /type="button" class="btn">Known terms…</);
  assert.doesNotMatch(button, /\stitle=/, "no tooltips");

  const app = read("renderer/app.js");
  assert.match(app, /glossary: el\("glossary"\)/);
  assert.match(app, /CH\.SETTINGS_SET, \{ glossary: els\.glossary\.checked \}/);
  assert.match(app, /els\.glossary\.checked = glossary/);
  const note = /function glossaryMissingKey\([\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(note, /DEEPSEEK_API_KEY was not found, so terms are not explained\./);
});
