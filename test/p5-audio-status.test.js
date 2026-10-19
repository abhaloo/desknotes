import test from "node:test";
import assert from "node:assert/strict";
import {
  HEADPHONES_REQUIREMENT,
  LEVEL_INTERVAL_MS,
  MAX_DIAGNOSTICS_BYTES,
  MICROPHONE_DENIAL_GUIDANCE,
  QUIET_LEVEL,
  ROUTING_GUIDANCE,
  buildDeviceSelectors,
  buildDiagnosticsExport,
  createLevelThrottle,
  createStatusGate,
  presentAudioStatus,
  summariseCaptureDiagnostics,
} from "../src/desktop/renderer/audio-status.js";

const devices = [
  { id: "MIC-A", name: "Headset Mic", source: "microphone", isDefault: true },
  { id: "MIC-B", name: "Headset Mic", source: "microphone", isDefault: false },
  { id: "OUT-A", name: "Speakers", source: "system", isDefault: false },
  { id: "OUT-B", name: "Headphones", source: "system", isDefault: true },
  { id: "OUT-C", name: "Speakers", source: "system", isDefault: false },
];

test("selectors name Microphone and Playback device and include both default roles", () => {
  const selectors = buildDeviceSelectors({
    devices,
    selected: {
      microphone: { kind: "default", role: "communications" },
      system: { kind: "default", role: "multimedia" },
    },
  });
  assert.equal(selectors.microphone.title, "Microphone");
  assert.equal(selectors.system.title, "Playback device");
  for (const selector of [selectors.microphone, selectors.system]) {
    const values = selector.options.map((option) => option.value);
    assert.ok(values.includes("default:multimedia"));
    assert.ok(values.includes("default:communications"));
  }
  assert.equal(selectors.microphone.selectedValue, "default:communications");
  assert.equal(selectors.system.selectedValue, "default:multimedia");
  assert.deepEqual(
    selectors.microphone.options.filter((option) => option.kind === "endpoint").map((option) => option.id),
    ["MIC-A", "MIC-B"],
  );
  assert.deepEqual(
    selectors.system.options.filter((option) => option.kind === "endpoint").map((option) => option.id),
    ["OUT-A", "OUT-B", "OUT-C"],
  );
});

test("duplicate friendly names include the endpoint id and unique names stay plain", () => {
  const selectors = buildDeviceSelectors({ devices, selected: {} });
  const mics = selectors.microphone.options.filter((option) => option.kind === "endpoint");
  assert.equal(mics[0].label.includes("Headset Mic"), true);
  assert.equal(mics[0].label.includes("MIC-A"), true);
  assert.equal(mics[1].label.includes("MIC-B"), true);
  assert.notEqual(mics[0].label, mics[1].label);
  const headphones = selectors.system.options.find((option) => option.id === "OUT-B");
  assert.equal(headphones.label, "Headphones");
});

test("a saved endpoint missing from the catalog stays visible and selected", () => {
  const selectors = buildDeviceSelectors({
    devices,
    selected: { system: { kind: "endpoint", id: "OUT-GONE", name: "Dock Speakers" } },
  });
  const missing = selectors.system.options.find((option) => option.id === "OUT-GONE");
  assert.equal(missing.unavailableSavedEndpoint, true);
  assert.equal(missing.unavailable, true);
  assert.equal(missing.label.includes("Dock Speakers"), true);
  assert.equal(missing.label.includes("OUT-GONE"), true);
  assert.equal(selectors.system.selectedValue, "endpoint:OUT-GONE");
  assert.equal(selectors.system.selectedOption.id, "OUT-GONE");
});

test("selected output A keeps its name and id when Windows default moves to B", () => {
  const before = buildDeviceSelectors({
    devices,
    selected: { system: { kind: "endpoint", id: "OUT-A" } },
  });
  const afterDefaultChange = devices.map((device) => {
    if (device.id === "OUT-A") return { ...device, isDefault: false };
    if (device.id === "OUT-B") return { ...device, isDefault: true };
    return device;
  });
  const after = buildDeviceSelectors({
    devices: afterDefaultChange,
    selected: { system: { kind: "endpoint", id: "OUT-A" } },
  });
  assert.equal(before.system.selectedOption.id, "OUT-A");
  assert.equal(after.system.selectedOption.id, "OUT-A");
  assert.equal(after.system.selectedOption.name, "Speakers");
  assert.equal(after.system.selectedOption.label.includes("Speakers"), true);
  assert.equal(after.system.selectedOption.isDefault, false);
  assert.equal(after.system.options.find((option) => option.id === "OUT-B").isDefault, true);
  assert.equal(after.system.selectedValue, "endpoint:OUT-A");
});

test("one source failure stays failed while the other source stays live", () => {  const view = presentAudioStatus({
    generation: 4,
    capturing: true,
    phase: "running",
    supportsAec: false,
    sources: {
      microphone: { state: "failed", error: { message: "Microphone denied" }, signal: "silent", level: 0 },
      system: { state: "running", signal: "active", level: 0.4, endpointId: "OUT-A", endpointName: "Speakers" },
    },
    transcription: { state: "live" },
  });
  assert.equal(view.microphone.failed, true);
  assert.equal(view.microphone.state, "degraded");
  assert.notEqual(view.microphone.label, "Running (quiet)");
  assert.equal(view.system.failed, false);
  assert.equal(view.system.state, "live");
  assert.equal(view.system.endpointId, "OUT-A");
  assert.equal(view.system.endpointName, "Speakers");
  assert.equal(view.partial, true);
});

test("quiet running input renders Running (quiet) and is not a failure", () => {
  const silent = presentAudioStatus({
    generation: 1,
    capturing: true,
    phase: "running",
    sources: {
      microphone: { state: "running", signal: "silent", level: 0.8 },
      system: { state: "running", signal: "active", level: 0 },
    },
    transcription: { state: "unconfigured" },
  });
  assert.equal(silent.microphone.label, "Running (quiet)");
  assert.equal(silent.microphone.failed, false);
  assert.equal(silent.microphone.state, "live");
  assert.equal(silent.system.label, "Running (quiet)");
  assert.equal(silent.system.failed, false);
  assert.ok(QUIET_LEVEL > 0);

  const loud = presentAudioStatus({
    generation: 1,
    capturing: true,
    phase: "running",
    sources: {
      microphone: { state: "running", signal: "active", level: 0.5 },
      system: { state: "running" },
    },
    transcription: { state: "unconfigured" },
  });
  assert.equal(loud.microphone.label, "Live");
  assert.equal(loud.microphone.quiet, false);
  assert.equal(loud.system.failed, false);
  assert.equal(loud.system.state, "live");
});

test("ASR unconfigured is distinct from healthy capture", () => {
  const view = presentAudioStatus({
    generation: 2,
    capturing: true,
    phase: "running",
    sources: {
      microphone: { state: "running", signal: "active", level: 0.4 },
      system: { state: "running", signal: "active", level: 0.4 },
    },
    transcription: { state: "unconfigured" },
  });
  assert.equal(view.transcription.state, "unconfigured");
  assert.equal(view.transcription.label, "ASR unconfigured");
  assert.equal(view.transcription.distinctFromCapture, true);
  assert.equal(view.microphone.state, "live");
  assert.notEqual(view.transcription.label, view.microphone.label);
});

test("selectors are disabled while capturing or starting and enabled when stopped", () => {
  const starting = presentAudioStatus({
    generation: 1,
    capturing: false,
    phase: "starting",
    sources: {},
    transcription: { state: "connecting" },
  });
  const capturing = presentAudioStatus({
    generation: 1,
    capturing: true,
    phase: "running",
    sources: {},
    transcription: { state: "live" },
  });
  const stopped = presentAudioStatus({
    generation: 1,
    capturing: false,
    phase: "stopped",
    sources: {},
    transcription: { state: "unconfigured" },
  });
  assert.equal(starting.selectorsEnabled, false);
  assert.equal(capturing.selectorsEnabled, false);
  assert.equal(stopped.selectorsEnabled, true);
});

test("routing guidance is shown, and headphones are required when AEC is absent or speakers fail", () => {
  assert.equal(ROUTING_GUIDANCE, "Set your call application's output to the playback device selected here.");
  const noAec = presentAudioStatus({
    generation: 1,
    capturing: false,
    phase: "stopped",
    supportsAec: false,
    sources: {},
    transcription: { state: "unconfigured" },
  });
  assert.equal(noAec.routingGuidance, ROUTING_GUIDANCE);
  assert.equal(noAec.headphonesRequired, true);
  assert.equal(noAec.headphonesMessage, HEADPHONES_REQUIREMENT);

  const speakerFailed = presentAudioStatus({
    generation: 1,
    capturing: false,
    phase: "stopped",
    supportsAec: true,
    speakerQualification: { qualified: false },
    sources: {},
    transcription: { state: "unconfigured" },
  });
  assert.equal(speakerFailed.headphonesRequired, true);

  const unresolved = presentAudioStatus({
    generation: 1,
    capturing: false,
    phase: "stopped",
    supportsAec: true,
    speakerQualification: { status: "unresolved" },
    sources: {},
    transcription: { state: "unconfigured" },
  });
  assert.equal(unresolved.headphonesRequired, true);

  const qualified = presentAudioStatus({
    generation: 1,
    capturing: false,
    phase: "stopped",
    supportsAec: true,
    speakerQualification: { qualified: true, status: "passed" },
    sources: {},
    transcription: { state: "unconfigured" },
  });
  assert.equal(qualified.headphonesRequired, false);
});

test("status updates from a stale generation are ignored", () => {
  const gate = createStatusGate();
  const first = gate.apply({
    generation: 2,
    capturing: true,
    phase: "running",
    sources: {
      microphone: { state: "running", signal: "active", level: 0.4 },
      system: { state: "failed", error: { message: "Output unplugged" } },
    },
    transcription: { state: "degraded" },
  });
  const stale = gate.apply({
    generation: 1,
    capturing: false,
    phase: "stopped",
    sources: {
      microphone: { state: "running", signal: "active", level: 0.4 },
      system: { state: "running", signal: "active", level: 0.4 },
    },
    transcription: { state: "live" },
  });
  assert.equal(first.applied, true);
  assert.equal(stale.applied, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.view.system.failed, true);
  assert.equal(stale.view.generation, 2);
  const same = gate.apply({
    generation: 2,
    capturing: true,
    phase: "running",
    sources: {
      microphone: { state: "running", signal: "silent", level: 0 },
      system: { state: "failed", error: { message: "Output unplugged" } },
    },
    transcription: { state: "degraded" },
  });
  assert.equal(same.applied, true);
  assert.equal(same.view.microphone.label, "Running (quiet)");
});

test("level updates are throttled to 10 Hz", () => {
  assert.equal(LEVEL_INTERVAL_MS, 100);
  const throttle = createLevelThrottle({ intervalMs: LEVEL_INTERVAL_MS });
  assert.equal(throttle.shouldEmit(1_000), true);
  assert.equal(throttle.shouldEmit(1_050), false);
  assert.equal(throttle.shouldEmit(1_099), false);
  assert.equal(throttle.shouldEmit(1_100), true);
  assert.equal(throttle.shouldEmit(1_199), false);
});

test("diagnostics export keeps metadata and strips PCM, transcript, credentials, and paths", () => {
  const result = buildDiagnosticsExport({
    native: { apiVersion: 1, backend: "wasapi-loopback" },
    endpoints: [{ id: "OUT-A", name: "Speakers", source: "system" }],
    counters: { droppedSamples: 3 },
    providerMode: "live",
    supportsAec: false,
    pcm: [0.42424242, -0.42424242],
    sources: {
      microphone: { pcm: new Float32Array([0.42424242, -0.11122233]) },
    },
    transcript: "TRANSCRIPT_SENTINEL_do_not_leak",
    nested: { apiKey: "sk-live-SENTINEL-KEY", text: "TRANSCRIPT_SENTINEL_do_not_leak" },
    reportPath: "C:\\Users\\someone\\secret-audio-path\\clip.wav",
  });
  assert.equal(result.bytes <= MAX_DIAGNOSTICS_BYTES, true);
  assert.equal(MAX_DIAGNOSTICS_BYTES, 65536);
  assert.equal(result.body.includes("TRANSCRIPT_SENTINEL_do_not_leak"), false);
  assert.equal(result.body.includes("sk-live-SENTINEL-KEY"), false);
  assert.equal(result.body.includes("secret-audio-path"), false);
  assert.equal(result.body.includes("0.42424242"), false);
  assert.equal(result.body.includes("0.11122233"), false);
  assert.equal(result.payload.providerMode, "live");
  assert.equal(result.payload.counters.droppedSamples, 3);
  assert.equal(result.payload.endpoints[0].id, "OUT-A");
  assert.equal(result.payload.native.backend, "wasapi-loopback");
});

test("diagnostics export stays within 64 KiB when the input is oversized", () => {
  const input = {};
  for (let index = 0; index < 200; index += 1) input[`field${index}`] = "m".repeat(400);
  input.native = { apiVersion: 1 };
  const result = buildDiagnosticsExport(input);
  assert.equal(result.bytes <= MAX_DIAGNOSTICS_BYTES, true);
  assert.equal(result.truncated, true);
  assert.equal(result.payload.native.apiVersion, 1);
});

test("microphone denial carries Windows privacy and selected-device guidance", () => {
  assert.match(MICROPHONE_DENIAL_GUIDANCE, /Windows microphone privacy permissions/);
  assert.match(MICROPHONE_DENIAL_GUIDANCE, /selected device/);
  const view = presentAudioStatus({
    generation: 3,
    capturing: true,
    phase: "running",
    sources: {
      microphone: {
        state: "failed",
        error: { code: "E_AUDIO_DEVICE_DENIED", message: "Microphone access was denied." },
      },
      system: { state: "running", signal: "active", level: 0.3 },
    },
    transcription: { state: "live" },
  });
  assert.equal(view.microphone.failed, true);
  assert.match(view.microphone.label, /Microphone access was denied\./);
  assert.match(view.microphone.label, /Windows microphone privacy permissions/);
  assert.equal(view.microphone.guidance, MICROPHONE_DENIAL_GUIDANCE);
  assert.equal(view.warning, MICROPHONE_DENIAL_GUIDANCE);

  // A system-only failure never shows microphone guidance.
  const systemOnly = presentAudioStatus({
    generation: 4,
    capturing: true,
    phase: "running",
    sources: {
      microphone: { state: "running", signal: "active", level: 0.4 },
      system: {
        state: "failed",
        error: { code: "E_AUDIO_DEVICE_INVALID", message: "The selected audio device is not available." },
      },
    },
    transcription: { state: "live" },
  });
  assert.equal(systemOnly.microphone.guidance, null);
  assert.equal(systemOnly.warning, null);
  assert.equal(systemOnly.system.failed, true);
});

test("capture diagnostics summarise format, drops, gaps and synthetic counts", () => {
  const summary = summariseCaptureDiagnostics({
    backend: "native",
    sources: {
      microphone: {
        state: "running",
        endpointId: "MIC-A",
        endpointName: "Headset Mic",
        sampleRate: 48000,
        nativeChannels: 1,
        encoding: "float32",
        dropped: 2,
        discontinuities: 3,
        syntheticIdleSilence: 4,
        delivered: 10,
        lastPacketAgeMs: 250,
      },
      system: { state: "failed", dropped: 1, discontinuities: 0, syntheticIdleSilence: 0 },
    },
  });
  assert.equal(summary.backend, "native");
  assert.equal(summary.sources.microphone.sampleRate, 48000);
  assert.equal(summary.sources.microphone.nativeChannels, 1);
  assert.equal(summary.sources.microphone.encoding, "float32");
  assert.equal(summary.sources.microphone.lastPacketAgeMs, 250);
  assert.equal(summary.sources.system.sampleRate, null);
  assert.deepEqual(summary.counters, {
    dropped: 3,
    discontinuities: 3,
    gaps: 3,
    syntheticIdleSilence: 4,
  });
  const exported = buildDiagnosticsExport({
    capture: summary,
    counters: summary.counters,
    tests: { native: { ok: false, at: "2026-10-14T00:00:00.000Z" } },
  });
  assert.equal(exported.payload.capture.sources.microphone.encoding, "float32");
  assert.equal(exported.payload.counters.syntheticIdleSilence, 4);
  assert.equal(exported.payload.tests.native.ok, false);
});
