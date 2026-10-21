import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Behavioral test of the desktop shell's session wiring: the REAL main.mjs
 * boots under Electron's bundled Node (24.x with --no-experimental-websocket: no global WebSocket) with a fake
 * `electron` module (test/fixtures/fake-electron.mjs), and the driver invokes
 * IPC handlers exactly like the preload bridge. p5-shell-wiring.test.js only
 * pattern-matches source; this one runs it.
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

function runDriver(mode) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DRIVER_MODE: mode };
  // Provider keys too: a developer shell that has them must not turn the
  // default-config run into real provider calls.
  for (const key of ["REALTIME_URL", "JWT", "SESSION_ID", "CAPTURE_BACKEND", "VAD_ENABLED", "EMBEDDED_SERVER", "REALTIME_PORT",
    "DEEPSEEK_API_KEY", "CEREBRAS_API_KEY", "GROQ_API_KEY", "TYPESAFE_API_KEY", "LLM_API_KEY", "VISION_API_KEY", "ANSWER_MODEL"]) {
    delete env[key];
  }
  // The flag hides Node 24's global WebSocket, so the driver runs the no-global path the ws fallback exists for.
  const result = spawnSync(electron, ["--no-experimental-websocket", driver], { cwd: root, env, encoding: "utf8", timeout: 45_000, windowsHide: true });
  const line = String(result.stdout ?? "")
    .split(/\r?\n/)
    .find((l) => l.startsWith("RESULT "));
  assert.ok(line, `driver produced no result (status ${result.status}): ${result.stderr}`);
  const report = JSON.parse(line.slice("RESULT ".length));
  assert.equal(report.error, undefined, report.error);
  assert.equal(report.globalWebSocket, "undefined", "runs where WebSocket is not a global");
  return report.steps;
}

/** One envelope, never `{ok, value: {ok, ...}}`. */
function assertSingleEnvelope(envelope, label) {
  assert.equal(typeof envelope?.ok, "boolean", `${label}: not an envelope`);
  if (envelope.ok) {
    assert.ok(!(envelope.value && typeof envelope.value === "object" && "ok" in envelope.value), `${label}: double-wrapped`);
  }
}

const skip = !electron && "electron binary not installed";

test("main.mjs (embedded server, default config): sessions start, failures surface, renderer can't redirect", { skip, timeout: 60_000 }, () => {
  const steps = runDriver("embedded");

  // Port: random unless REALTIME_PORT pins it; never the guessable fixed default.
  assert.notEqual(steps.config.realtimeUrl, "ws://127.0.0.1:8787");
  assert.equal(steps.config.engineMode, "live");
  assert.ok(!steps.config.keys.some((k) => /jwt|token|secret/i.test(k) && k !== "hasJwt"), "no credential reaches the renderer");

  // S2: a renderer-supplied url/jwt is rejected and never dialled.
  assertSingleEnvelope(steps.hijack.envelope, "hijack");
  assert.equal(steps.hijack.envelope.ok, false);
  assert.equal(steps.hijack.envelope.error.code, "E_INVALID_PAYLOAD");
  assert.equal(steps.hijack.attackerConnections, 0);

  // #1: the session actually starts under Electron's Node 24 and frames flow.
  assertSingleEnvelope(steps.start1, "start1");
  assert.equal(steps.start1.ok, true, JSON.stringify(steps.start1));
  assert.ok(steps.session1.frameTypes.includes("session.state"));

  // #2: the default backend cannot capture: say so, don't report success.
  assert.equal(steps.start1.value.speech.ok, false);
  assert.equal(steps.start1.value.speech.error.code, "E_CAPTURE_UNAVAILABLE");
  assert.ok(steps.session1.errored.length > 0, "the renderer is told capture failed");
  assertSingleEnvelope(steps.speechStart, "speech:start");
  assert.equal(steps.speechStart.ok, false);
  assert.equal(steps.speechStart.error.code, "E_CAPTURE_UNAVAILABLE");

  // S1: the embedded server refuses browsers and unauthenticated clients. It
  // authenticates at the handshake (security audit F8 follow-up), so a client
  // without the per-launch secret never gets a socket: 401, zero frames.
  assert.equal(steps.security.originUpgrade, 403);
  for (const probe of [steps.security.wrongToken, steps.security.noToken]) {
    assert.equal(probe.code, 401);
    assert.deepEqual(probe.frames, [], "nothing of the session leaks, not even capabilities");
  }

  // #9: screen analysis reaches the embedded server and comes back. Default
  // config is live mode with no keys, so the reading is a typed failure that
  // names the missing key, never a stub reading.
  assertSingleEnvelope(steps.screen, "screen");
  assert.equal(steps.screen.ok, true, JSON.stringify(steps.screen));
  assert.equal(steps.screen.value.status, "failed", JSON.stringify(steps.screen.value));
  assert.match(steps.screen.value.error, /no vision model is set up: add DEEPSEEK_API_KEY/);
  // Every window hears "busy" the instant the capture starts and "idle" once the reading is back.
  assert.deepEqual(steps.screenState, [true, false]);

  // #3: Start -> End -> Start gets a fresh session id and a live link.
  assert.equal(steps.end1.ok, true);
  assert.equal(steps.start2.ok, true);
  assert.notEqual(steps.start2.value.sessionId, steps.start1.value.sessionId);
  assert.ok(steps.session2.frameTypes.includes("session.state"));
});

test("main.mjs (external server, simulated capture): audio survives Start->End->Start, remote end tears down once", { skip, timeout: 60_000 }, () => {
  const steps = runDriver("external");
  assert.equal(steps.hijack.envelope.ok, false);
  assert.equal(steps.hijack.attackerConnections, 0);

  assert.equal(steps.start1.ok, true);
  assert.deepEqual(steps.start1.value.speech.value.sources.sort(), ["microphone", "system"]);
  assert.ok(steps.session1.transcripts > 0, "session 1 transcribes");

  assert.equal(steps.start2.ok, true);
  assert.notEqual(steps.start2.value.sessionId, steps.start1.value.sessionId);
  assert.ok(steps.session2.transcripts > 0, "session 2 transcribes too (audio not dropped as duplicates)");

  assert.deepEqual(steps.remoteEnd.lifecycle, ["ending", "ended"]);
  assert.equal(steps.remoteEnd.stopSpeechBroadcasts, 1, "remote end runs the teardown exactly once");
  assert.equal(steps.remoteEnd.dupLogs, 0);
});
