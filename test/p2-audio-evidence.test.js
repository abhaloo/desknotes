import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EvidenceFailure,
  qualifyEvidence,
  summarizeHardwareOrigin,
} from "./live/audio-evidence.js";
import { createProbeController } from "./live/wasapi-audio-probe.js";
import { isDirectProbe, packagedAppSteps, parseProbeArgs } from "./live/wasapi-audio-probe.mjs";

const liveDir = path.dirname(fileURLToPath(import.meta.url));

function validEvidence() {
  return {
    selection: {
      microphone: { kind: "endpoint", id: "MIC" },
      system: { kind: "endpoint", id: "OUT-A" },
    },
    captured: {
      microphone: {
        endpointId: "MIC",
        packets: [{ endpointId: "MIC", pcm: [1, 0, 0, 0, 0, 0, 0, 0] }],
      },
      system: {
        endpointId: "OUT-A",
        packets: [{ endpointId: "OUT-A", pcm: [0, 0, 0, 0, 1, 0, 0, 0] }],
      },
    },
    isolation: {
      required: true,
      outputA: {
        selectedId: "OUT-A",
        capturedEndpointId: "OUT-A",
        detectedSignals: ["signal-a"],
        requirePresent: ["signal-a"],
        requireAbsent: ["signal-b"],
      },
      outputB: {
        selectedId: "OUT-B",
        capturedEndpointId: "OUT-B",
        detectedSignals: ["signal-b"],
        requirePresent: ["signal-b"],
        requireAbsent: ["signal-a"],
      },
      defaultChange: {
        selectedId: "OUT-A",
        windowsDefaultId: "OUT-B",
        capturedEndpointId: "OUT-A",
      },
    },
    transcription: {
      mode: "live",
      provider: "configured",
      expectedPhrases: ["hello from the call"],
      observedPhrases: ["hello from the call"],
    },
    echo: {
      headphones: { leaked: false },
      speakers: { leaked: false },
    },
  };
}

function codes(result) {
  return result.failures.map((failure) => failure.code);
}

test("matching hardware, isolation, and live phrases qualify capture", () => {
  const result = qualifyEvidence(validEvidence());
  assert.equal(result.qualified, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.headphones.qualified, true);
  assert.equal(result.speakers.qualified, true);
  assert.equal(result.hardwareOriginSamples.microphone, 8);
  assert.equal(result.hardwareOriginSamples.system, 8);
});

test("UI selection without captured audio from the resolved endpoint fails", () => {
  const evidence = validEvidence();
  evidence.captured.system = { endpointId: "OUT-A", packets: [] };
  const empty = qualifyEvidence(evidence);
  assert.equal(empty.qualified, false);
  assert.equal(codes(empty).includes(EvidenceFailure.SELECTION_WITHOUT_CAPTURE), true);
  assert.equal(codes(empty).includes(EvidenceFailure.DUPLICATED_SOURCE_PCM), false);

  const mismatched = validEvidence();
  mismatched.captured.system = {
    endpointId: "OUT-B",
    packets: [{ endpointId: "OUT-B", pcm: [0, 1, 0, 1, 0, 1, 0, 1] }],
  };
  const wrong = qualifyEvidence(mismatched);
  assert.equal(wrong.qualified, false);
  assert.equal(codes(wrong).includes(EvidenceFailure.ENDPOINT_MISMATCH), true);
});

test("identical and highly correlated source PCM is rejected, and distinct PCM is not", () => {
  const identical = validEvidence();
  const shared = [0.2, 0.4, 0.6, 0.8, 1, 0.8, 0.6, 0.4];
  identical.captured.microphone.packets = [{ endpointId: "MIC", pcm: shared }];
  identical.captured.system.packets = [{ endpointId: "OUT-A", pcm: shared.slice() }];
  assert.equal(codes(qualifyEvidence(identical)).includes(EvidenceFailure.DUPLICATED_SOURCE_PCM), true);

  const correlated = validEvidence();
  const signal = [0.2, 0.4, 0.6, 0.8, 1, 0.8, 0.6, 0.4];
  correlated.captured.microphone.packets = [{ endpointId: "MIC", pcm: signal }];
  correlated.captured.system.packets = [{ endpointId: "OUT-A", pcm: signal.map((sample) => sample * 0.5) }];
  assert.equal(codes(qualifyEvidence(correlated)).includes(EvidenceFailure.DUPLICATED_SOURCE_PCM), true);

  const shifted = validEvidence();
  shifted.captured.microphone.packets = [{ endpointId: "MIC", pcm: [0, 0, 1, 0, 1, 0, 1, 0] }];
  shifted.captured.system.packets = [{ endpointId: "OUT-A", pcm: [1, 0, 1, 0, 1, 0, 0, 0] }];
  assert.equal(codes(qualifyEvidence(shifted)).includes(EvidenceFailure.DUPLICATED_SOURCE_PCM), true);

  assert.equal(codes(qualifyEvidence(validEvidence())).includes(EvidenceFailure.DUPLICATED_SOURCE_PCM), false);
});

test("synthetic idle packets are excluded from hardware sample counts and energy", () => {
  const packets = [
    { endpointId: "MIC", flags: { syntheticIdleSilence: true }, pcm: [1, 1, 1, 1] },
    { endpointId: "MIC", pcm: [0.2, -0.2, 0.2, -0.2] },
  ];
  const summary = summarizeHardwareOrigin(packets);
  assert.equal(summary.samples, 4);
  assert.equal(summary.syntheticPackets, 1);
  assert.ok(Math.abs(summary.energy - 0.16) < 1e-9);
  assert.equal(summarizeHardwareOrigin([{ samples: 99999 }]).samples, 0);

  const onlySynthetic = validEvidence();
  onlySynthetic.captured.microphone.packets = [
    { endpointId: "MIC", flags: { syntheticIdleSilence: true }, pcm: [1, 1, 1, 1] },
  ];
  onlySynthetic.captured.system.packets = [
    { endpointId: "OUT-A", flags: { syntheticIdleSilence: true }, pcm: [1, 1, 1, 1] },
  ];
  const rejected = qualifyEvidence(onlySynthetic);
  assert.equal(rejected.hardwareOriginSamples.microphone, 0);
  assert.equal(rejected.hardwareOriginSamples.system, 0);
  assert.equal(codes(rejected).includes(EvidenceFailure.SYNTHETIC_IDLE_ONLY), true);
  assert.equal(rejected.qualified, false);

  const padding = validEvidence();
  padding.captured.microphone.packets.push({
    endpointId: "MIC",
    flags: { syntheticIdleSilence: true },
    pcm: padding.captured.system.packets[0].pcm.slice(),
  });
  assert.equal(codes(qualifyEvidence(padding)).includes(EvidenceFailure.DUPLICATED_SOURCE_PCM), false);
  assert.equal(qualifyEvidence(padding).hardwareOriginSamples.microphone, 8);
});

test("default-device-only capture cannot satisfy explicit output A versus B isolation", () => {
  const evidence = validEvidence();
  evidence.selection.system = { kind: "default", role: "multimedia" };
  evidence.isolation.mode = "default-device";
  const result = qualifyEvidence(evidence);
  assert.equal(result.qualified, false);
  assert.equal(codes(result).includes(EvidenceFailure.DEFAULT_DEVICE_ONLY), true);
});

test("output A must contain signal A only, and output B must contain signal B only", () => {
  const leak = validEvidence();
  leak.isolation.outputA.detectedSignals = ["signal-a", "signal-b"];
  assert.equal(codes(qualifyEvidence(leak)).includes(EvidenceFailure.ISOLATION_SIGNAL_LEAK), true);

  const missing = validEvidence();
  missing.isolation.outputB.detectedSignals = [];
  assert.equal(codes(qualifyEvidence(missing)).includes(EvidenceFailure.ISOLATION_SIGNAL_MISSING), true);

  const swapped = validEvidence();
  swapped.isolation.outputA.capturedEndpointId = "OUT-B";
  const wrongEndpoint = qualifyEvidence(swapped);
  assert.equal(wrongEndpoint.qualified, false);
  assert.equal(codes(wrongEndpoint).includes(EvidenceFailure.ENDPOINT_MISMATCH), true);
});

test("changing the Windows default while A is selected must not redirect capture to B", () => {
  const redirected = validEvidence();
  redirected.isolation.defaultChange.capturedEndpointId = "OUT-B";
  const failed = qualifyEvidence(redirected);
  assert.equal(failed.qualified, false);
  assert.equal(codes(failed).includes(EvidenceFailure.DEFAULT_REDIRECT), true);

  const pinned = qualifyEvidence(validEvidence());
  assert.equal(codes(pinned).includes(EvidenceFailure.DEFAULT_REDIRECT), false);
  assert.equal(pinned.qualified, true);
});

test("demo mode, mock provider, count-only transcripts, and missing phrases cannot prove live ASR", () => {
  const demo = validEvidence();
  demo.transcription = {
    mode: "demo",
    provider: "mock",
    expectedPhrases: ["hello from the call"],
    observedPhrases: ["hello from the call"],
    eventCount: 5,
  };
  assert.equal(codes(qualifyEvidence(demo)).includes(EvidenceFailure.CANNED_ASR), true);

  const mockProvider = validEvidence();
  mockProvider.transcription.provider = "mock";
  assert.equal(codes(qualifyEvidence(mockProvider)).includes(EvidenceFailure.CANNED_ASR), true);

  const counted = validEvidence();
  counted.transcription = { mode: "live", provider: "configured", eventCount: 12 };
  assert.equal(codes(qualifyEvidence(counted)).includes(EvidenceFailure.TRANSCRIPT_COUNT_ONLY), true);

  const partial = validEvidence();
  partial.transcription.observedPhrases = ["a different sentence"];
  assert.equal(codes(qualifyEvidence(partial)).includes(EvidenceFailure.TRANSCRIPT_PHRASE_MISSING), true);
});

test("headphone and speaker echo qualifications are independent", () => {
  const speakers = validEvidence();
  speakers.echo.speakers.leaked = true;
  const speakerResult = qualifyEvidence(speakers);
  assert.equal(speakerResult.qualified, true);
  assert.equal(speakerResult.headphones.qualified, true);
  assert.equal(speakerResult.speakers.qualified, false);
  assert.equal(speakerResult.speakers.headphonesRequired, true);
  assert.equal(speakerResult.headphones.failures.length, 0);
  assert.equal(speakerResult.speakers.failures[0].code, EvidenceFailure.SPEAKER_ECHO);

  const headphones = validEvidence();
  headphones.echo.headphones.leaked = true;
  const headphoneResult = qualifyEvidence(headphones);
  assert.equal(headphoneResult.headphones.qualified, false);
  assert.equal(headphoneResult.speakers.qualified, true);
  assert.equal(headphoneResult.headphones.failures[0].code, EvidenceFailure.HEADPHONE_ECHO);

  const notRun = validEvidence();
  delete notRun.echo;
  const missing = qualifyEvidence(notRun);
  assert.equal(missing.headphones.notRun, true);
  assert.equal(missing.speakers.notRun, true);
  assert.equal(missing.speakers.headphonesRequired, true);
  assert.equal(missing.headphones.qualified, false);
  assert.equal(missing.speakers.qualified, false);
});

test("the live probe parses catalog and qualification cases and does not record on load", async () => {
  const qualification = parseProbeArgs([
    "electron",
    "wasapi-audio-probe.mjs",
    "--case",
    "qualification",
    "--app",
    "dist/win-unpacked/DeskNotes.exe",
  ]);
  assert.equal(qualification.caseName, "qualification");
  assert.equal(qualification.app, "dist/win-unpacked/DeskNotes.exe");
  assert.throws(() => parseProbeArgs(["node", "probe", "--case", "record"]), /Unknown probe case/);

  const steps = packagedAppSteps(qualification.app);
  assert.equal(steps.some((step) => step.includes("dist/win-unpacked/DeskNotes.exe")), true);
  assert.equal(steps.some((step) => /does not start the microphone/i.test(step)), true);
  assert.equal(steps.some((step) => /Start/.test(step)), true);

  const probeUrl = pathToFileURL("C:/Users/probe/wasapi-audio-probe.mjs").href;
  assert.equal(isDirectProbe(["electron", fileURLToPath(probeUrl)], probeUrl), true);
  assert.equal(isDirectProbe(["node", "test/p2-audio-evidence.test.js"], probeUrl), false);

  let catalogStarts = 0;
  let qualificationStarts = 0;
  const controller = createProbeController({
    startCatalog() {
      catalogStarts += 1;
    },
    startQualification() {
      qualificationStarts += 1;
    },
  });
  assert.equal(controller.started, false);
  assert.equal(catalogStarts, 0);
  controller.start("catalog");
  assert.equal(catalogStarts, 1);
  assert.equal(qualificationStarts, 0);
  assert.equal(controller.started, true);

  const html = await readFile(path.join(liveDir, "live", "wasapi-audio-probe.html"), "utf8");
  const script = await readFile(path.join(liveDir, "live", "wasapi-audio-probe.js"), "utf8");
  assert.match(html, /id="start-catalog"/);
  assert.match(html, /Start catalog/);
  assert.match(html, /id="start-qualification"/);
  assert.match(html, /Start qualification/);
  assert.doesNotMatch(html, /getUserMedia|mediaDevices|MediaRecorder/);
  assert.doesNotMatch(script, /getUserMedia|mediaDevices|MediaRecorder/);
  assert.match(script, /addEventListener\(\s*"click"/);
});
