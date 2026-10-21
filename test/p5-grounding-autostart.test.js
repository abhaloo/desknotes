import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCaptureToggle, sessionIsLive, startListening } from "../src/desktop/renderer/capture-start.js";

/** Auto-start and the grounding document, through the real main module under a fake Electron. */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const driver = join(here, "fixtures", "main-shell-driver.mjs");

function electronBinary() {
  try {
    const path = createRequire(import.meta.url)("electron");
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}
const electron = electronBinary();
const skip = !electron && "electron binary not installed";

function runDriver(mode) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DRIVER_MODE: mode };
  // Provider keys too: a developer shell that has them must not reach the driver.
  for (const key of ["REALTIME_URL", "JWT", "SESSION_ID", "CAPTURE_BACKEND", "VAD_ENABLED", "EMBEDDED_SERVER", "REALTIME_PORT", "COPILOT_MODE", "COPILOT_AUTOSTART",
    "DEEPSEEK_API_KEY", "CEREBRAS_API_KEY", "GROQ_API_KEY", "TYPESAFE_API_KEY", "LLM_API_KEY", "VISION_API_KEY", "ANSWER_MODEL", "REP_CONTEXT", "HIGHLIGHTS", "ANSWER_CARDS"]) {
    delete env[key];
  }
  const result = spawnSync(electron, [driver], { cwd: root, env, encoding: "utf8", timeout: 45_000, windowsHide: true });
  const line = String(result.stdout ?? "").split(/\r?\n/).find((entry) => entry.startsWith("RESULT "));
  assert.ok(line, `driver produced no result (status ${result.status}): ${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(line.slice("RESULT ".length));
  assert.equal(report.error, undefined, report.error);
  return report.steps;
}

const RESUME = "# Pat Doe\n\nLed the Acme migration in 2021.";

test("opening the app starts listening; the document loads, applies live, survives a restart and clears", { skip, timeout: 60_000 }, () => {
  const steps = runDriver("grounding");
  assert.deepEqual(steps.autoStart, { started: true, starts: 1, lifecycle: "active" });
  assert.deepEqual(steps.emptyDocument, { ok: true, document: null, readError: null });
  assert.deepEqual(steps.cancelled, { ok: true, cancelled: true, contexts: 0 });

  assert.equal(steps.loaded.ok, true);
  assert.equal(steps.loaded.document.name, "resume.md");
  assert.equal(steps.loaded.document.words, 9);
  assert.equal(steps.loaded.document.chars, RESUME.length);
  assert.equal(steps.loaded.applied, true);
  assert.equal(steps.loaded.textLeaked, false, "the IPC reply carries metadata only");
  assert.deepEqual(steps.loaded.context, { docs: RESUME, name: "resume.md" });
  assert.equal(steps.loaded.dialogHasParent, true);
  assert.deepEqual(steps.loaded.filters, [{ name: "Text", extensions: ["md", "markdown", "txt"] }]);

  assert.equal(steps.tooBig.ok, false);
  assert.equal(steps.tooBig.code, "E_DOC_TOO_LARGE");
  assert.match(steps.tooBig.message, /30,001 characters/);
  assert.equal(steps.tooBig.kept, "resume.md");

  assert.equal(steps.resentOnStart.ok, true);
  assert.deepEqual(steps.resentOnStart.context, { docs: RESUME, name: "resume.md" });

  assert.equal(steps.cleared.ok, true);
  assert.deepEqual(steps.cleared.context, { docs: "", name: "" });
  assert.equal(steps.cleared.document, null);
  assert.equal(steps.cleared.fileGone, true);

  assert.equal(steps.openFolder.ok, true);
  assert.equal(steps.openFolder.path, steps.openFolder.expected, "the folder opened is userData");
  assert.deepEqual(steps.openFolder.calls, [steps.openFolder.expected, steps.openFolder.expected]);
  assert.equal(steps.openFolder.failCode, "E_OPEN_FOLDER");
  assert.match(steps.openFolder.failMessage, /Couldn't open the settings folder: Failed to open path/);

  // First run: the default answer model, DeepSeek V4.1 Flash with thinking on.
  assert.deepEqual(prefsOf(steps.settings.initial), { autoStart: true, answerModel: "deepseek-flash-thinking", readError: null });
  assert.match(steps.settings.initial.answerInstructionsPath, /[\\/]answer-instructions\.txt$/);
  assert.equal(steps.settings.initial.deepseekAvailable, false, "the driver env carries no DeepSeek key");
  assert.equal(steps.settings.initial.cerebrasAvailable, false, "...and no Cerebras key");
  assert.equal(steps.settings.badCode, "E_INVALID_PAYLOAD");
  assert.deepEqual(prefsOf(steps.settings.saved), { autoStart: false, answerModel: "deepseek-flash-thinking", readError: null });
  assert.deepEqual(steps.settings.stored, { version: 1, autoStart: false, answerModel: "deepseek-flash-thinking", windowOpacity: 1, repContext: true, highlights: true, answerCards: true, glossary: true });

  // Settings > Answer model persists beside autoStart; an invented model id is refused.
  assert.deepEqual(prefsOf(steps.answerModel.saved), { autoStart: false, answerModel: "deepseek-flash", readError: null });
  assert.equal(steps.answerModel.badCode, "E_INVALID_PAYLOAD");
  assert.deepEqual(steps.answerModel.stored, { version: 1, autoStart: false, answerModel: "deepseek-flash", windowOpacity: 1, repContext: true, highlights: true, answerCards: true, glossary: true });

  // Settings > "Use what I say in answers": on by default, a boolean persists, junk is refused.
  assert.equal(steps.settings.initial.repContext, true, "on by default");
  assert.equal(steps.repContext.off, false);
  assert.equal(steps.repContext.badCode, "E_INVALID_PAYLOAD");
  assert.deepEqual(steps.repContext.storedOff, { version: 1, autoStart: false, answerModel: "deepseek-flash", windowOpacity: 1, repContext: false, highlights: true, answerCards: true, glossary: true });
  assert.equal(steps.repContext.on, true);
  assert.equal(steps.repContext.settings, true);

  // Settings > "Highlight key phrases": on by default, a boolean persists, junk is refused.
  assert.equal(steps.settings.initial.highlights, true, "on by default");
  assert.equal(steps.highlights.off, false);
  assert.equal(steps.highlights.badCode, "E_INVALID_PAYLOAD");
  assert.deepEqual(steps.highlights.storedOff, { version: 1, autoStart: false, answerModel: "deepseek-flash", windowOpacity: 1, repContext: true, highlights: false, answerCards: true, glossary: true });
  assert.equal(steps.highlights.on, true);
  assert.equal(steps.highlights.settings, true);

  // Settings > "Short answer cards": on by default, a boolean persists, junk is refused.
  assert.equal(steps.settings.initial.answerCards, true, "on by default");
  assert.equal(steps.answerCards.off, false);
  assert.equal(steps.answerCards.badCode, "E_INVALID_PAYLOAD");
  assert.deepEqual(steps.answerCards.storedOff, { version: 1, autoStart: false, answerModel: "deepseek-flash", windowOpacity: 1, repContext: true, highlights: true, answerCards: false, glossary: true });
  assert.equal(steps.answerCards.on, true);
  assert.equal(steps.answerCards.settings, true);

  // Settings > "Explain terms": on by default, a boolean persists, junk is refused.
  assert.equal(steps.settings.initial.glossary, true, "on by default");
  assert.equal(steps.glossary.off, false);
  assert.equal(steps.glossary.badCode, "E_INVALID_PAYLOAD");
  assert.deepEqual(steps.glossary.storedOff, { version: 1, autoStart: false, answerModel: "deepseek-flash", windowOpacity: 1, repContext: true, highlights: true, answerCards: true, glossary: false });
  assert.equal(steps.glossary.on, true);
  assert.equal(steps.glossary.settings, true);

  // known-terms.txt is seeded empty next to app-preferences.json; "Known terms…" opens it.
  assert.equal(steps.knownTerms.seeded, "", "created empty");
  assert.equal(steps.knownTerms.settingsPath, steps.knownTerms.expected, "settings:get names the file");
  assert.equal(steps.knownTerms.ok, true);
  assert.equal(steps.knownTerms.path, steps.knownTerms.expected);
  assert.deepEqual(steps.knownTerms.calls, [steps.knownTerms.expected, steps.knownTerms.expected]);
  assert.equal(steps.knownTerms.recreated, "", "a deleted file is created again before it opens");
  assert.equal(steps.knownTerms.failCode, "E_OPEN_FILE");
  assert.match(steps.knownTerms.failMessage, /Couldn't open the known-terms file: Failed to open path/);

  // keys.env is only made by "Edit keys…"; an edited file is never rewritten, and a driver never reads it.
  assert.equal(steps.keysFile.atBoot, false, "boot never creates a keys file");
  assert.equal(steps.keysFile.ok, true);
  assert.equal(steps.keysFile.path, steps.keysFile.expected);
  assert.deepEqual(steps.keysFile.calls, [steps.keysFile.expected, steps.keysFile.expected, steps.keysFile.expected]);
  assert.match(steps.keysFile.template, /^DEEPSEEK_API_KEY=$/m, "the template lists the keys, empty");
  assert.equal(steps.keysFile.kept, "DEEPSEEK_API_KEY=sk-driver-edit\n");
  assert.equal(steps.keysFile.failCode, "E_OPEN_FILE");
  assert.match(steps.keysFile.failMessage, /Couldn't open the keys file: Failed to open path/);
  assert.deepEqual(Object.keys(steps.keysFile.sources).sort(), ["CEREBRAS_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "TYPESAFE_API_KEY"]);
  assert.equal(Object.values(steps.keysFile.sources).includes("keys.env"), false, "settings:get never reports a key a driver did not read");

  // The title-row opacity slider: live while dragging, saved on release, never below 30%.
  assert.deepEqual(steps.windowOpacity.live, { windowOpacity: 0.6 });
  assert.equal(steps.windowOpacity.storedAfterLive.windowOpacity, 1, "a drag step is not written to disk");
  assert.deepEqual(steps.windowOpacity.saved, { windowOpacity: 0.3 });
  assert.equal(steps.windowOpacity.badCode, "E_INVALID_PAYLOAD");
  assert.equal(steps.windowOpacity.settings, 0.3);
  assert.equal(steps.windowOpacity.state, 0.3);
  assert.deepEqual(steps.windowOpacity.stored, { version: 1, autoStart: false, answerModel: "deepseek-flash", windowOpacity: 0.3, repContext: true, highlights: true, answerCards: true, glossary: true });

  // The editable prompt file is seeded next to app-preferences.json with the four sections.
  assert.equal(steps.instructions.exists, true);
  assert.deepEqual(steps.instructions.headers, [
    "1. Tone and writing style",
    "2. Role",
    "3. Answers to produce for detected questions",
    "4. Answers to produce for screenshots",
  ]);

  // Clear reaches every answer window (control + overlay here; panels when on)
  // and the session keeps listening.
  assert.equal(steps.clear.ok, true);
  assert.equal(steps.clear.windows, steps.clear.broadcastTargets);
  assert.ok(steps.clear.windows >= 2);
  assert.equal(steps.clear.lifecycle, "active");

  // Quit is in-app Ctrl+Q only: other keys pass through and nothing global claims Ctrl+Q.
  assert.equal(steps.quit.plainPrevented, false, "plain q still types");
  assert.equal(steps.quit.shiftPrevented, false);
  assert.equal(steps.quit.quitsFromOthers, 0);
  assert.equal(steps.quit.ctrlPrevented, true);
  assert.equal(steps.quit.quitsFromCtrlQ, 1);
  assert.deepEqual(steps.quit.globalQuit, [], "Ctrl+Q must never be a global shortcut");
  assert.deepEqual(steps.quit.hint, { accelerator: "Ctrl+Q", action: "quit" });
});

/** The persisted preference fields of a settings:get / settings:set value. */
function prefsOf(value) {
  return { autoStart: value?.autoStart, answerModel: value?.answerModel, readError: value?.readError };
}

test("auto-start off in settings: nothing starts", { skip, timeout: 60_000 }, () => {
  const steps = runDriver("autostart-pref-off");
  assert.deepEqual(steps.autoStartOff.starts, 0);
  assert.deepEqual(steps.autoStartOff.lifecycle, "idle");
  assert.deepEqual(prefsOf(steps.autoStartOff.settings), { autoStart: false, answerModel: "deepseek-flash-thinking", readError: null });
});

test("COPILOT_AUTOSTART=0: nothing starts even with the setting on", { skip, timeout: 60_000 }, () => {
  const steps = runDriver("autostart-env-off");
  assert.deepEqual(steps.autoStartOff.starts, 0);
  assert.deepEqual(steps.autoStartOff.lifecycle, "idle");
  assert.deepEqual(prefsOf(steps.autoStartOff.settings), { autoStart: true, answerModel: "deepseek-flash-thinking", readError: null });
});

test("a failed auto-start reports why, and a later Start works", { skip, timeout: 60_000 }, () => {
  const steps = runDriver("autostart-fail");
  assert.equal(steps.autoStartFail.failed, true);
  assert.match(steps.autoStartFail.lastError, /session start failed/);
  assert.equal(steps.autoStartFail.manualOk, true);
  assert.equal(steps.autoStartFail.starts, 1);
});

/* The driver tests above prove main's side over IPC. These prove the renderer's
   side of the same states: the window must not ask main to start when it still
   holds a session, and a window that booted without one must open it first, so
   the capture checkbox is a recovery path rather than another dead end. */
test("renderer recovery: the checkbox opens a session when the boot left none", async () => {
  const calls = [];
  const started = await startListening({
    lifecycle: "idle",
    startSession: async () => {
      calls.push("session:start");
      return { sessionId: "s1" };
    },
    startSpeech: async () => {
      calls.push("speech:start");
      return { sources: ["microphone"] };
    },
  });
  assert.deepEqual(calls, ["session:start", "speech:start"], "speech:start alone would answer E_NOT_ACTIVE");
  assert.deepEqual(started, { sources: ["microphone"] });
  assert.equal(sessionIsLive("idle"), false);
  assert.equal(sessionIsLive("failed"), false);
});

test("renderer recovery: a live session is not reopened", async () => {
  const calls = [];
  const started = await startListening({
    lifecycle: "active",
    startSession: async () => {
      calls.push("session:start");
      return { sessionId: "s1" };
    },
    startSpeech: async () => {
      calls.push("speech:start");
      return { sources: ["system"] };
    },
  });
  assert.deepEqual(calls, ["speech:start"]);
  assert.deepEqual(started, { sources: ["system"] });
  assert.equal(sessionIsLive("launching"), true);
  assert.equal(sessionIsLive("ended"), false);
});

test("renderer recovery: a failed boot retries, a refused start persists nothing", async () => {
  // The autostart-fail and autostart-off states, from the renderer's side: the
  // session:start the driver makes over IPC is the call the checkbox makes here.
  const calls = [];
  const retried = await applyCaptureToggle({
    lifecycle: "failed",
    checked: true,
    startSession: async () => {
      calls.push("session:start");
      return { sessionId: "s2" };
    },
    startSpeech: async () => {
      calls.push("speech:start");
      return { sources: ["microphone"] };
    },
    stopSpeech: async () => null,
    saveAutoStart: async (value) => calls.push(`autoStart:${value}`),
  });
  assert.deepEqual(calls, ["session:start", "speech:start", "autoStart:true"]);
  assert.deepEqual(retried, { capture: true, applied: true });

  const refusedCalls = [];
  const refused = await applyCaptureToggle({
    lifecycle: "idle",
    checked: true,
    startSession: async () => {
      refusedCalls.push("session:start");
      return null; // call() already toasted main's reason
    },
    startSpeech: async () => {
      refusedCalls.push("speech:start");
      return null;
    },
    stopSpeech: async () => null,
    saveAutoStart: async (value) => refusedCalls.push(`autoStart:${value}`),
  });
  assert.deepEqual(refusedCalls, ["session:start"], "a failed session start must not reach capture, nor be persisted");
  assert.deepEqual(refused, { capture: false, applied: false });
});

test("renderer recovery: turning capture off persists the off preference", async () => {
  const saved = [];
  const stopped = await applyCaptureToggle({
    lifecycle: "active",
    checked: false,
    startSession: async () => null,
    startSpeech: async () => null,
    stopSpeech: async () => ({ stopped: true }),
    saveAutoStart: async (value) => saved.push(value),
  });
  assert.deepEqual(stopped, { capture: false, applied: true });
  assert.deepEqual(saved, [false], "the app-open preference round-trips through speech:stop");

  // A refused stop (e.g. mid-session) keeps the box on: capture is still running.
  const refused = await applyCaptureToggle({
    lifecycle: "active",
    checked: false,
    startSession: async () => null,
    startSpeech: async () => null,
    stopSpeech: async () => null,
    saveAutoStart: async (value) => saved.push(value),
  });
  assert.deepEqual(refused, { capture: true, applied: false });
  assert.deepEqual(saved, [false]);
});
