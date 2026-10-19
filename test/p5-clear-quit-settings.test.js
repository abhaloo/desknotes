import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnswerBuffer, ScreenCards, TranscriptLanes, LANE } from "../src/desktop/renderer/answer-buffer.js";
import { BROADCAST_CHANNELS, IPC } from "../src/desktop/ipc-gateway.js";
import { ANSWER_MODEL_CHOICES } from "../src/server/engines/answer-models.js";
import { USER_SCOPE_KEYS, fillMissingUserEnv, parseRegQuery, readUserEnvironmentVariable, resolveRegPath } from "../src/desktop/user-env.js";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop");
const read = (relative) => readFileSync(join(desktop, relative), "utf8");

/* ------------------------------------------------------------------ Clear */

test("clear() drops the answer, and a turn cleared mid-stream never repaints", () => {
  const buffer = new AnswerBuffer();
  buffer.start({ turn_id: "t1" }, 1);
  buffer.append({ turn_id: "t1", delta: "Half an ans" }, 2);
  buffer.clear();
  assert.equal(buffer.active, null);
  // Late frames of the cleared turn are dropped: no half answer comes back.
  buffer.append({ turn_id: "t1", delta: "wer." }, 3);
  buffer.done({ turn_id: "t1", text: "Half an answer." }, 4);
  assert.equal(buffer.active, null);
  // The next turn renders normally.
  buffer.append({ turn_id: "t2", delta: "Fresh." }, 5);
  assert.equal(buffer.active.text, "Fresh.");
  // A finished turn is just dropped; nothing is remembered for it.
  buffer.done({ turn_id: "t2", text: "Fresh." }, 6);
  buffer.clear();
  buffer.done({ turn_id: "t2", text: "Fresh again." }, 7);
  assert.equal(buffer.active.text, "Fresh again.");
});

test("lanes and screen cards reset to empty for Clear", () => {
  const lanes = new TranscriptLanes();
  lanes.ingest({ role: "prospect", text: "What does it cost?", final: true });
  lanes.ingest({ role: "rep", text: "It depends", final: false });
  lanes.reset();
  for (const lane of [LANE.PROSPECT, LANE.REP]) {
    assert.deepEqual(lanes.lines(lane), []);
    assert.equal(lanes.current(lane), null);
  }
  const cards = new ScreenCards();
  cards.ingest({ commandId: "c1", status: "ok", kind: "question", summary: "s" });
  cards.reset();
  assert.equal(cards.count, 0);
  assert.equal(cards.ingest({ commandId: "c2", status: "ok" }).card.number, 1, "numbering restarts");
});

test("Clear is one shell action broadcast to every window, and every renderer listens", () => {
  assert.equal(IPC.DISPLAY_CLEARED, "display:cleared");
  assert.ok(BROADCAST_CHANNELS.includes(IPC.DISPLAY_CLEARED));
  assert.match(read("preload.cjs"), /DISPLAY_CLEARED: "display:cleared"/);
  const main = read("main.mjs");
  assert.match(main, /case "clear-display":/);
  assert.match(main, /broadcast\(IPC\.DISPLAY_CLEARED/);
  const html = read("renderer/index.html");
  const actions = /<div class="card-actions panel-hidden">[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
  assert.match(actions, /id="btn-clear"/, "Clear sits with Answer now and Analyse screen");
  const app = read("renderer/app.js");
  assert.match(app, /runShellAction\("clear-display"\)/);
  // Registered for every mode (control, overlay, panel): not inside `if (isControl)`.
  assert.match(app, /bridge\?\.on\(CH\.DISPLAY_CLEARED \?\? IPC\.DISPLAY_CLEARED, clearDisplay\)/);
  for (const call of ["answers.clear()", "transcripts.reset()", "screenCards.reset()", 'view.prospectText = ""']) {
    assert.ok(app.includes(call), `clearDisplay must run ${call}`);
  }
});

/* ------------------------------------------------------------------- Quit */

test("quit is an in-app Ctrl+Q, listed as a clickable hint, and never a global shortcut", () => {
  const main = read("main.mjs");
  assert.match(main, /const QUIT_ACCELERATOR = "Ctrl\+Q";/);
  assert.match(main, /if \(isQuitChord\(input\)\)/, "handled in before-input-event, i.e. only while our window has focus");
  assert.match(main, /state\.shortcuts\.push\(\{ accelerator: QUIT_ACCELERATOR, action: "quit" \}\)/);
  assert.match(main, /case "quit":/);
  assert.ok(!/globalShortcut\.register\([^)]*Q["'`]/i.test(main), "no global Q accelerator");
  for (const binding of main.match(/\["CommandOrControl\+[^"]+"/g) ?? []) {
    assert.ok(!/\+Q"$/i.test(binding), `${binding} must not claim Ctrl+Q system-wide`);
  }
  const app = read("renderer/app.js");
  assert.match(app, /button\.className = "hint-btn"/, "each shortcut hint is a button");
  assert.match(app, /runShellAction\(action\)/);
  assert.match(app, /quit: "quit"/);
  // ...and it looks like one: a bordered chip with a hover fill (no hand cursor).
  const css = read("renderer/styles.css");
  const chip = /\n\.hint-btn \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(chip, /border: 1px solid/);
  assert.match(css, /\.hint-btn:hover \{[^}]*background:/);
});

/* ----------------------------------------------------------- Answer model */

test("the Answer model select lists exactly the engine's choices, in the Answer quality section", () => {
  const html = read("renderer/index.html");
  const section = /<section class="settings-section" aria-label="Answer quality">[\s\S]*?<\/section>\s*<section class="settings-section" aria-label="Grounding">/.exec(html)?.[0] ?? "";
  const select = /<select id="answer-model">([\s\S]*?)<\/select>/.exec(section)?.[1] ?? "";
  const options = [...select.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => ({ id: m[1], label: m[2] }));
  assert.deepEqual(options, ANSWER_MODEL_CHOICES.map(({ id, label }) => ({ id, label })));
  assert.match(section, /id="answer-instructions-path"/, "the prompt file path is shown read-only");
  const app = read("renderer/app.js");
  assert.match(app, /CH\.SETTINGS_SET, \{ answerModel: els\.answerModel\.value \}/);
  assert.equal(options[0].label, "DeepSeek V4.1 Flash", "the default is listed first");
});

test("the Answer model note names the missing key for every choice", () => {
  const app = read("renderer/app.js");
  const body = /function answerModelMissingKey\([\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(body, /"cerebras-qwen-thinking"/);
  assert.doesNotMatch(body, /"cerebras-qwen"/, "Qwen without thinking is not a choice");
  assert.match(body, /CEREBRAS_API_KEY was not found/);
  assert.match(body, /DEEPSEEK_API_KEY was not found, so answers use Qwen 27B thinking \(Cerebras\)/);
  assert.match(body, /DEEPSEEK_API_KEY and CEREBRAS_API_KEY were not found/);
  assert.match(app, /renderSettings\(\{ readError = null, answerModel, answerInstructionsPath, deepseekAvailable, cerebrasAvailable, repContext, highlights, answerCards, glossary \}/);
  const main = read("main.mjs");
  assert.match(main, /cerebrasAvailable: typeof process\.env\.CEREBRAS_API_KEY === "string"/);
  assert.match(main, /answerModel: normalizeAnswerModel\(/, "settings:get always reports a listed choice");
});

/* ----------------------------------------------------- user-scope env key */

test("reg query output parses to the value of the requested name only", () => {
  const out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    DEEPSEEK_API_KEY    REG_SZ    sk-abc 123\r\n\r\n";
  assert.equal(parseRegQuery(out, "DEEPSEEK_API_KEY"), "sk-abc 123");
  assert.equal(parseRegQuery(out, "GROQ_API_KEY"), null);
  assert.equal(parseRegQuery("    DEEPSEEK_API_KEY    REG_EXPAND_SZ    v\n", "DEEPSEEK_API_KEY"), "v");
  assert.equal(parseRegQuery("", "DEEPSEEK_API_KEY"), null);
});

test("the registry is read with the pinned reg.exe and a secret-free environment, listed names only", async () => {
  assert.deepEqual(USER_SCOPE_KEYS, ["DEEPSEEK_API_KEY", "CEREBRAS_API_KEY", "GROQ_API_KEY", "TYPESAFE_API_KEY"]);
  const exists = (p) => p === "C:\\Windows\\System32\\reg.exe";
  assert.equal(resolveRegPath({ env: { SystemRoot: "D:\\Evil" }, exists }), "C:\\Windows\\System32\\reg.exe");
  assert.equal(resolveRegPath({ env: { SystemRoot: "\\\\server\\share" }, exists: () => false }), null);
  const calls = [];
  const execFileImpl = (cmd, args, options, done) => {
    calls.push({ cmd, args, options });
    done(null, "    DEEPSEEK_API_KEY    REG_SZ    sk-registry\r\n");
  };
  const value = await readUserEnvironmentVariable("DEEPSEEK_API_KEY", { platform: "win32", env: {}, exists, execFileImpl });
  assert.equal(value, "sk-registry");
  assert.deepEqual(calls[0].args, ["query", "HKCU\\Environment", "/v", "DEEPSEEK_API_KEY"]);
  assert.deepEqual(calls[0].options.env, { SystemRoot: "C:\\Windows" }, "no inherited secrets");
  assert.equal(await readUserEnvironmentVariable("PATH", { platform: "win32", exists, execFileImpl }), null, "unlisted names are never read");
  assert.equal(await readUserEnvironmentVariable("DEEPSEEK_API_KEY", { platform: "linux", exists, execFileImpl }), null);
  const failing = (_c, _a, _o, done) => done(new Error("ERROR: The system was unable to find the specified registry key"));
  assert.equal(await readUserEnvironmentVariable("DEEPSEEK_API_KEY", { platform: "win32", exists, execFileImpl: failing }), null);
});

test("fillMissingUserEnv fills only missing keys and reports names, never values", async () => {
  const env = {};
  assert.deepEqual(await fillMissingUserEnv(env, { read: async (name) => `sk-${name}` }), ["DEEPSEEK_API_KEY", "CEREBRAS_API_KEY", "GROQ_API_KEY", "TYPESAFE_API_KEY"]);
  assert.equal(env.DEEPSEEK_API_KEY, "sk-DEEPSEEK_API_KEY");
  assert.equal(env.CEREBRAS_API_KEY, "sk-CEREBRAS_API_KEY");
  // A key the process already has is never read, let alone replaced.
  const preset = { DEEPSEEK_API_KEY: "from-process" };
  const read = [];
  assert.deepEqual(await fillMissingUserEnv(preset, { read: async (name) => (read.push(name), "sk-y") }), ["CEREBRAS_API_KEY", "GROQ_API_KEY", "TYPESAFE_API_KEY"]);
  assert.equal(preset.DEEPSEEK_API_KEY, "from-process");
  assert.deepEqual(read, ["CEREBRAS_API_KEY", "GROQ_API_KEY", "TYPESAFE_API_KEY"]);
  assert.deepEqual(await fillMissingUserEnv({}, { read: async () => null }), []);
});

test("main fills the user-scope key only in a real Electron app, before the embedded server starts", () => {
  const main = read("main.mjs");
  assert.match(main, /process\.versions\?\.electron && !process\.env\.ELECTRON_RUN_AS_NODE \? fillMissingUserEnv\(process\.env\)/);
  assert.ok(main.indexOf("fillMissingUserEnv(process.env)") < main.indexOf(".then(bootstrap)"), "the key is in place before bootstrap builds the engines");
});

test("Clear has a global Ctrl+Shift+X shortcut, listed as a clickable hint", () => {
  const main = read("main.mjs");
  assert.match(main, /const CLEAR_ACCELERATOR = "CommandOrControl\+Shift\+X";/);
  const bindings = /function registerShortcuts\(\) \{[\s\S]*?\n {2}\];/.exec(main)?.[0] ?? "";
  assert.match(bindings, /\[CLEAR_ACCELERATOR, "clear-display", \(\) => triggerShellAction\("clear-display"\)\]/, "registered with the global bindings");
  assert.match(read("renderer/app.js"), /"clear-display": "clear",/, "the hints row names it");
});

test("no hand cursor anywhere: buttons, toggles and hints keep the default arrow", () => {
  for (const file of ["renderer/styles.css", "renderer/index.html", "renderer/practice.html", "renderer/app.js", "renderer/practice.js"]) {
    assert.ok(!/cursor:\s*pointer/.test(read(file)), `${file} must not set cursor: pointer`);
  }
});
