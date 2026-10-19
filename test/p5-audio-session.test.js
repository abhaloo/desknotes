import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Session wiring for selected-device capture. The real main module boots
 * under Electron's Node with a deferred fake host.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const driver = join(here, "fixtures", "main-shell-driver.mjs");
const mainSource = readFileSync(join(root, "src", "desktop", "main.mjs"), "utf8");

function electronBinary() {
  try {
    const path = createRequire(import.meta.url)("electron");
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}
const electron = electronBinary();

function runDriver(mode = "audio-session") {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DRIVER_MODE: mode };
  // Provider keys in the ambient environment auto-configure live engines
  // (e.g. GROQ_API_KEY flips ASR to openai-compatible STT). This scenario
  // asserts the mock/demo path, so the whole resolution surface is cleared.
  for (const key of ["REALTIME_URL", "JWT", "SESSION_ID", "CAPTURE_BACKEND", "VAD_ENABLED", "EMBEDDED_SERVER", "REALTIME_PORT", "COPILOT_MODE", "GROQ_API_KEY", "CEREBRAS_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "ASR_PROVIDER", "ASR_BASE_URL", "ASR_API_KEY", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "ANSWER_PROVIDER", "VISION_PROVIDER", "VISION_BASE_URL", "VISION_API_KEY", "VISION_MODEL"]) {
    delete env[key];
  }
  const result = spawnSync(electron, [driver], { cwd: root, env, encoding: "utf8", timeout: 45_000, windowsHide: true });
  const line = String(result.stdout ?? "")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("RESULT "));
  assert.ok(line, `driver produced no result (status ${result.status}): ${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(line.slice("RESULT ".length));
  assert.equal(report.error, undefined, report.error);
  return report.steps;
}

test("quit cleanup waits at most two seconds", () => {
  assert.match(mainSource, /const QUIT_STOP_TIMEOUT_MS = 2000/);
});

const skip = !electron && "electron binary not installed";

test("selected-device session keeps partial capture, cancellation, and forced cleanup", { skip, timeout: 60_000 }, () => {
  const steps = runDriver();

  assert.equal(steps.rejectedStopHelper.resolved, true);
  assert.equal(steps.rejectedStopHelper.revoked, true);
  assert.equal(steps.engineMode.native, "live");
  assert.equal(steps.engineMode.simulated, "demo");
  assert.equal(steps.engineMode.override, "demo");

  assert.equal(steps.listDoesNotRecord.ok, true);
  assert.equal(steps.listDoesNotRecord.opens, 0);
  assert.ok(steps.listDoesNotRecord.devices > 0);

  assert.equal(steps.selectors.badSource, "E_INVALID_PAYLOAD");
  assert.deepEqual(steps.selectors.saved, { kind: "endpoint", id: "spk-a" });
  assert.equal(steps.selectors.supportsAec, false);
  assert.equal(steps.selectors.transcription, "unconfigured");
  assert.deepEqual(steps.selectors.savedSystem, { kind: "endpoint", id: "spk-a" });

  assert.equal(steps.diagnostics.pathRejected, "E_INVALID_PAYLOAD");
  assert.equal(typeof steps.diagnostics.bytes, "number");
  assert.ok(steps.diagnostics.bytes <= 64 * 1024);
  assert.equal(steps.diagnostics.underUserData, true);
  // The design requires format/rate/counters, gaps/drops/synthetic counts and
  // native build/test outcomes in the exported report.
  assert.equal(steps.diagnostics.payload.capture.backend, "native");
  assert.equal(typeof steps.diagnostics.payload.capture.sources.microphone, "object");
  assert.equal(typeof steps.diagnostics.payload.counters.dropped, "number");
  assert.equal(typeof steps.diagnostics.payload.counters.discontinuities, "number");
  assert.equal(typeof steps.diagnostics.payload.counters.syntheticIdleSilence, "number");
  assert.equal(typeof steps.diagnostics.payload.timing.quality, "string");
  assert.equal(typeof steps.diagnostics.payload.tests.native, "object");
  assert.equal(typeof steps.diagnostics.payload.worker, "object");

  assert.equal(steps.cancel.endOk, true);
  assert.ok(steps.cancel.stops >= 1);
  assert.equal(steps.cancel.stops, steps.cancel.opens);

  assert.equal(steps.selectedOpen.speechOk, true);
  assert.deepEqual([...(steps.selectedOpen.sources ?? [])].sort(), ["microphone", "system"]);
  assert.deepEqual(steps.selectedOpen.systemChoice, { kind: "endpoint", id: "spk-a" });
  assert.deepEqual(steps.selectedOpen.micChoice, { kind: "default", role: "communications" });
  assert.equal(steps.selectedOpen.transcription, "demo");

  assert.ok(steps.levels.broadcasts >= 1);
  assert.ok(steps.levels.broadcasts <= 10, `level broadcasts ${steps.levels.broadcasts} exceed 10 per second`);

  assert.equal(steps.defaultPin.conflict, "AUDIO_CAPTURE_ACTIVE");
  assert.equal(steps.defaultPin.conflictType, "CONFLICT");
  assert.equal(steps.defaultPin.systemOpens, 0);
  assert.ok(steps.defaultPin.micOpens >= 1);

  assert.equal(steps.pinnedLoss.code, "E_AUDIO_DEVICE_INVALID");
  assert.equal(steps.pinnedLoss.systemState, "failed");
  assert.equal(steps.pinnedLoss.endpointId, "spk-a");
  assert.equal(steps.pinnedLoss.systemOpens, 0);
  assert.equal(steps.pinnedLoss.micState, "running");

  assert.ok(steps.rejectedStop.revoked >= 1);
  assert.equal(steps.rejectedStop.deliveredAfter, steps.rejectedStop.deliveredBefore);
  assert.equal(steps.rejectedStop.systemState, "failed");

  assert.equal(steps.workerExit.microphone, "E_AUDIO_WORKER");
  assert.equal(steps.workerExit.system, "E_AUDIO_WORKER");

  assert.equal(steps.deniedMic.ok, true);
  assert.deepEqual(steps.deniedMic.started, ["system"]);
  assert.equal(steps.deniedMic.failed[0].source, "microphone");
  assert.equal(steps.deniedMic.failed[0].code, "E_AUDIO_DEVICE_DENIED");
  assert.equal(steps.deniedMic.failed[0].message.includes("0x"), false);
  assert.deepEqual(steps.deniedMic.sources, ["system"]);

  assert.equal(steps.invalidSystem.ok, true);
  assert.deepEqual(steps.invalidSystem.started, ["microphone"]);
  assert.equal(steps.invalidSystem.failed[0].code, "E_AUDIO_DEVICE_INVALID");
  assert.deepEqual(steps.invalidSystem.sources, ["microphone"]);

  assert.deepEqual(steps.typedFailures.codes.sort(), ["E_AUDIO_FORMAT", "E_AUDIO_HRESULT"]);
  for (const message of steps.typedFailures.messages) {
    assert.equal(message.includes("0x"), false);
  }

  assert.equal(steps.forcedCleanup.forced, true);
  assert.ok(steps.forcedCleanup.terminated >= 1);
});

test("missing addon is an error, not an empty device list", { skip, timeout: 60_000 }, () => {
  const steps = runDriver("audio-missing");
  assert.equal(steps.missingAddon.listOk, false);
  assert.equal(steps.missingAddon.listCode, "E_CAPTURE_UNAVAILABLE");
  assert.equal(steps.missingAddon.listValue, null);
  assert.equal(steps.missingAddon.capsOk, false);
  assert.equal(steps.missingAddon.capsCode, "E_CAPTURE_UNAVAILABLE");
});
