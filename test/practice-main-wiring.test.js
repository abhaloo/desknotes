import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 4 wiring, through the real main module under a fake Electron
 * (test/fixtures/main-shell-driver.mjs): the practice IPC channels, the
 * practice window, the gated transcript tap and the debrief round trip.
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

/** Provider keys are deleted so the practice answerer is the local mock: no network. */
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
  "GROQ_API_KEY",
  "JEV_JUDGMENTS",
];

function runDriver(mode) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DRIVER_MODE: mode };
  for (const key of UNSET) delete env[key];
  const result = spawnSync(electron, [driver], { cwd: root, env, encoding: "utf8", timeout: 90_000, windowsHide: true });
  const line = String(result.stdout ?? "")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("RESULT "));
  assert.ok(line, `driver produced no result (status ${result.status}): ${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(line.slice("RESULT ".length));
  assert.equal(report.error, undefined, report.error);
  return report.steps;
}

test("practice: channels, transcript tap and debrief through the real main module", { skip, timeout: 120_000 }, () => {
  const steps = runDriver("practice");

  // Empty store: no material, no session, no debrief.
  assert.deepEqual(steps.empty, {
    ok: true,
    material: null,
    session: null,
    debrief: null,
    materialReadError: null,
  });
  // Answering without material is refused with the practice code.
  assert.deepEqual(steps.startWithoutMaterial, { ok: false, code: "E_PRACTICE_NO_MATERIAL" });

  // Material round trip, and a blank statement is refused with its own code.
  assert.equal(steps.material.ok, true);
  assert.equal(steps.material.saved.problemStatement, "Design a rate limiter.");
  assert.equal(typeof steps.material.saved.savedAt, "string");
  assert.deepEqual(steps.material.readBack, steps.material.saved);
  assert.equal(steps.material.readError, null);
  assert.equal(steps.blankMaterial.code, "E_PRACTICE_MATERIAL_EMPTY");
  assert.equal(steps.blankMaterial.kept, "Design a rate limiter.");

  // The practice window is the honest surface: framed, never always-on-top,
  // in the taskbar.
  assert.equal(steps.window.opened, true);
  assert.equal(steps.window.exists, true);
  assert.equal(steps.window.samePage, true);
  assert.equal(steps.window.title, "DeskNotes — Practice");
  assert.equal(steps.window.frame, null);
  assert.equal(steps.window.alwaysOnTop, null);
  assert.equal(steps.window.skipTaskbar, false);
  // Navigation pin: practice.html only — never the overlay page, whose bridge
  // is wider and which this unguarded window must never render.
  assert.equal(steps.window.navigatePractice, true);
  assert.equal(steps.window.navigateIndex, false);
  assert.equal(steps.window.controlNavigateIndex, true, "the app windows keep their own page");

  // Sender trust: the practice page calls practice:* (every call below is
  // made from it) and is refused everything else on the bridge.
  assert.deepEqual(steps.trust, {
    config: "E_FORBIDDEN_SENDER",
    session: "E_FORBIDDEN_SENDER",
    shell: "E_FORBIDDEN_SENDER",
    open: "E_FORBIDDEN_SENDER",
  });

  // practice:start opens a real session (practice drives startSession itself).
  assert.equal(steps.started.ok, true);
  assert.equal(typeof steps.started.startedAt, "string");
  assert.equal(steps.started.lifecycle, "active");
  assert.equal(steps.started.starts, 1);
  assert.deepEqual(steps.started.session, {
    active: true,
    startedAt: steps.started.startedAt,
    questions: 0,
    skipped: 0,
  });
  assert.deepEqual(steps.secondStart, { ok: false, code: "E_PRACTICE_ACTIVE" });
  // The practice window stays in the taskbar while the call runs.
  assert.equal(steps.started.practiceSkipTaskbar, false);

  // One final transcript (injected on the socket) becomes exactly one question
  // and one streamed answer, delivered to the practice window only.
  assert.equal(steps.transcript.emitted, true);
  assert.equal(steps.transcript.question.question, "How would you shard it?");
  assert.equal(steps.transcript.question.band, "question");
  assert.equal(steps.transcript.question.source, "fallback");
  assert.equal(steps.transcript.answerDone.id, steps.transcript.question.id);
  assert.ok(steps.transcript.answerDone.chars > 0);
  assert.ok(steps.transcript.types.includes("answer-start"));
  assert.ok(steps.transcript.types.includes("answer-delta"));
  assert.equal(steps.transcript.types.filter((type) => type === "question").length, 1);
  assert.ok(steps.transcript.appWindows >= 2, "control and overlay windows exist");
  assert.equal(steps.transcript.leakedToApp, 0, "practice events must not reach the app windows");

  // practice:end saves and returns the debrief, and emits the ended event.
  assert.equal(steps.ended.ok, true);
  assert.equal(typeof steps.ended.savedAt, "string");
  assert.equal(steps.ended.hasNote, true);
  assert.equal(steps.ended.hasQuestion, true);
  assert.deepEqual(steps.ended.stats, { questions: 1, answered: 1, skipped: 0, maybe: 0 });
  assert.equal(steps.ended.endedEvents, 1);
  assert.deepEqual(steps.secondEnd, { ok: false, code: "E_PRACTICE_NOT_ACTIVE" });

  // The debrief and material are on disk under the temp userData dir.
  assert.deepEqual(steps.persisted.session, {
    active: false,
    startedAt: steps.started.startedAt,
    questions: 1,
    skipped: 0,
  });
  assert.match(steps.persisted.title, /^Practice session — /);
  assert.deepEqual(steps.persisted.stats, { questions: 1, answered: 1, skipped: 0, maybe: 0 });
  assert.equal(steps.persisted.debriefFile, true);
  assert.equal(steps.persisted.materialFile, true);
  assert.equal(steps.persisted.textMatchesFile, true, "shown debrief text is byte-identical to the saved text");

  // Re-open focuses the existing window instead of opening a second one.
  assert.deepEqual(steps.reopen, { opened: true, extraWindows: 0 });

  // The tap is gated on session.isActive(): after end, an utterance is ignored.
  assert.deepEqual(steps.gatedAfterEnd, { newEvents: 0 });

  // Closing the practice window mid-session ends it and saves its debrief.
  assert.deepEqual(steps.closeEnds, { restarted: true, active: false, debriefIsNew: true, windowCleared: true });

  // A practice window reopened while the call is live is still in the taskbar.
  assert.deepEqual(steps.reopenDuringCall, {
    exists: true,
    skipTaskbar: false,
  });
});
