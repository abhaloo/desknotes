import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Session recap end to end, through the REAL main module under a fake
 * Electron (test/fixtures/main-shell-driver.mjs, DRIVER_MODE=recap): frames
 * injected on a real socket, the recorder's own subscriptions, the store on
 * disk, the recap:* channels, the recap window, and the quit path saving the
 * recap before app.quit(). Skips without the Electron binary, like
 * practice-main-wiring.test.js.
 */
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

const UNSET = [
  "REALTIME_URL",
  "JWT",
  "SESSION_ID",
  "CAPTURE_BACKEND",
  "VAD_ENABLED",
  "EMBEDDED_SERVER",
  "REALTIME_PORT",
  "COPILOT_MODE",
  "COPILOT_AUTOSTART",
  "ANSWER_PROVIDER",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "ASR_PROVIDER",
  "ASR_BASE_URL",
  "ASR_API_KEY",
  "VISION_API_KEY",
  "TYPESAFE_API_KEY",
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
];

function runDriver(mode) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DRIVER_MODE: mode };
  for (const key of UNSET) delete env[key];
  const result = spawnSync(electron, ["--no-experimental-websocket", driver], { cwd: root, env, encoding: "utf8", timeout: 150_000, windowsHide: true });
  const line = String(result.stdout ?? "")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("RESULT "));
  assert.ok(line, `driver produced no result (status ${result.status}): ${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(line.slice("RESULT ".length));
  assert.equal(report.error, undefined, report.error);
  return report.steps;
}

test("session recap: recorded, saved on end and on quit, listed, opened and deleted through the real main module", { skip, timeout: 180_000 }, () => {
  const steps = runDriver("recap");

  // On by default, nothing saved yet.
  assert.deepEqual(steps.defaults, {
    sessionRecap: true,
    list: { enabled: true, latest: null, sessions: [], readError: null },
    files: 0,
  });

  // One call -> one recap, announced once to every app window, on disk, listed as latest.
  const r = steps.recorded;
  assert.match(r.sessionId, /^session-/);
  assert.equal(r.readyCount, 1);
  assert.deepEqual(r.ready, { id: r.sessionId, saveError: null, questions: 1 });
  assert.ok(r.readyWindows >= 2, "control and overlay both hear recap:ready");
  assert.equal(r.files, 1);
  assert.equal(r.fileHasId, true);
  assert.deepEqual(r.listIds, [r.sessionId]);
  assert.equal(r.latestId, r.sessionId);
  assert.equal(r.enabled, true);
  // Every turn frame type is its own line; interims are not lines; one turn.token line.
  assert.deepEqual(r.lineTypes, ["transcript", "gate.verdict", "turn.started", "turn.token", "turn.done", "terms", "transcript"]);
  assert.equal(r.stamped, true, "every line carries at + offsetMs");
  assert.equal(r.ordered, true);
  assert.equal(r.heardBeforeFinal, true, "the first interim stamps heardAt");
  assert.equal(r.endReason, "user");
  assert.equal(r.startedBeforeEnded, true);
  assert.deepEqual(r.questions, [["t1", "How does SSO work?", "done"]], "joined by turn_id from turn.started.question");
  assert.deepEqual(r.terms, ["OIDC"]);
  assert.deepEqual(r.gaps, []);
  assert.equal(r.textMatchesFile, true, "recap:get text is byte-identical to the saved text");

  assert.deepEqual(steps.getErrors, {
    unknown: "E_RECAP_NOT_FOUND",
    unsafe: "E_INVALID_PAYLOAD",
    missing: "E_INVALID_PAYLOAD",
    openUnknown: "E_RECAP_NOT_FOUND",
    deleteBad: "E_INVALID_PAYLOAD",
  });

  // Off: nothing new is recorded; old recaps are kept and still listed.
  assert.deepEqual(steps.settingOff, { saved: false, readyCount: 0, files: 1, enabled: false, kept: 1 });

  // Practice in the middle of a live call: its frames are left out, the call is kept.
  const p = steps.practice;
  assert.equal(p.started, true);
  assert.equal(p.readyCount, 1);
  assert.match(p.sessionId, /^session-/);
  assert.equal(p.files, 2);
  assert.deepEqual(p.transcript, ["How does SSO work?", "We support both.", "After practice."]);
  assert.deepEqual(p.turns, ["t1"], "the practice question opened no recorded turn");

  // Nothing said, no answers: no recap.
  assert.deepEqual(steps.silent, { readyCount: 0, files: 2 });

  // The recap window: its own pinned page, one window, least privilege.
  const w = steps.window;
  assert.deepEqual(w.opened, { opened: true, id: r.sessionId });
  assert.equal(w.title, "DeskNotes — Session recap");
  assert.equal(w.alwaysOnTop, null);
  assert.equal(w.queryId, r.sessionId);
  assert.equal(w.latestOpenId, p.sessionId, "recap:open without an id opens the latest (the practice-in-a-call session)");
  assert.equal(w.queryIdAfterLatest, p.sessionId, "the same window switches to it");
  assert.equal(w.extraWindows, 0, "re-open reuses the window");
  assert.equal(w.navigateRecap, true);
  assert.equal(w.navigateIndex, false);
  assert.equal(w.get, true, "the recap page may read a recap");
  for (const key of ["list", "del", "open", "settings", "session"]) {
    assert.equal(w[key], "E_FORBIDDEN_SENDER", `the recap page is refused ${key}`);
  }

  // Per-session delete, then Delete all.
  const d = steps.delete;
  assert.equal(d.secondReady, true);
  assert.equal(d.beforeDelete, 3);
  assert.deepEqual(d.one, { removed: 1 });
  assert.deepEqual(d.listAfterOne, [d.secondId, p.sessionId]);
  assert.equal(d.filesAfterOne, 2);
  assert.deepEqual(d.all, { removed: 2 });
  assert.deepEqual(d.listAfterAll, []);
  assert.equal(d.filesAfterAll, 0);

  // Quitting mid-call: the recap was already on disk when app.quit() ran.
  assert.equal(steps.quit.quitCalled, true);
  assert.deepEqual(steps.quit.atQuit, [{ endReason: "quit", lines: 7 }]);
});
