/**
 * Qualification checks for captured hardware evidence.
 *
 * UI state, synthetic padding, duplicated PCM, the Windows default device,
 * and canned transcription do not count as proof that the selected endpoint
 * was captured.
 */

export const DUPLICATE_CORRELATION_THRESHOLD = 0.98;

export const EvidenceFailure = Object.freeze({
  SELECTION_WITHOUT_CAPTURE: "SELECTION_WITHOUT_CAPTURE",
  ENDPOINT_MISMATCH: "ENDPOINT_MISMATCH",
  DUPLICATED_SOURCE_PCM: "DUPLICATED_SOURCE_PCM",
  SYNTHETIC_IDLE_ONLY: "SYNTHETIC_IDLE_ONLY",
  DEFAULT_DEVICE_ONLY: "DEFAULT_DEVICE_ONLY",
  ISOLATION_SIGNAL_MISSING: "ISOLATION_SIGNAL_MISSING",
  ISOLATION_SIGNAL_LEAK: "ISOLATION_SIGNAL_LEAK",
  DEFAULT_REDIRECT: "DEFAULT_REDIRECT",
  CANNED_ASR: "CANNED_ASR",
  TRANSCRIPT_COUNT_ONLY: "TRANSCRIPT_COUNT_ONLY",
  TRANSCRIPT_PHRASE_MISSING: "TRANSCRIPT_PHRASE_MISSING",
  HEADPHONE_ECHO: "HEADPHONE_ECHO",
  SPEAKER_ECHO: "SPEAKER_ECHO",
});

export function summarizeHardwareOrigin(packets = []) {
  let samples = 0;
  let energy = 0;
  let syntheticPackets = 0;
  let hardwarePackets = 0;
  for (const packet of packets) {
    if (packet?.flags?.syntheticIdleSilence === true) {
      syntheticPackets += 1;
      continue;
    }
    const pcm = finitePcm(packet?.pcm);
    if (!pcm) continue;
    hardwarePackets += 1;
    samples += pcm.length;
    for (const sample of pcm) energy += sample * sample;
  }
  return { samples, energy, syntheticPackets, hardwarePackets };
}

export function qualifyEvidence(evidence = {}) {
  const failures = [];
  checkSourceCapture(failures, "microphone", evidence.selection?.microphone, evidence.captured?.microphone);
  checkSourceCapture(failures, "system", evidence.selection?.system, evidence.captured?.system);
  checkDuplicate(failures, evidence);
  checkIsolation(failures, evidence);
  checkTranscription(failures, evidence.transcription);
  const echo = qualifyEcho(evidence.echo);
  return {
    qualified: failures.length === 0,
    failures,
    headphones: echo.headphones,
    speakers: echo.speakers,
    hardwareOriginSamples: {
      microphone: summarizeHardwareOrigin(evidence.captured?.microphone?.packets).samples,
      system: summarizeHardwareOrigin(evidence.captured?.system?.packets).samples,
    },
  };
}

function checkSourceCapture(failures, source, selection, captured) {
  if (!selection) return;
  const packets = captured?.packets ?? [];
  const summary = summarizeHardwareOrigin(packets);
  if (selection.kind === "endpoint") {
    if (captured?.endpointId !== selection.id) {
      failures.push(failure(
        EvidenceFailure.ENDPOINT_MISMATCH,
        `${labelFor(source)} capture did not use the selected endpoint.`,
      ));
    }
    const fromSelection = summarizeHardwareOrigin(packets.filter((packet) => packet?.endpointId === selection.id));
    if (fromSelection.samples === 0) {
      failures.push(failure(
        EvidenceFailure.SELECTION_WITHOUT_CAPTURE,
        `${labelFor(source)} selection has no hardware audio from the resolved endpoint.`,
      ));
    }
  } else if (summary.samples === 0) {
    failures.push(failure(
      EvidenceFailure.SELECTION_WITHOUT_CAPTURE,
      `${labelFor(source)} selection has no hardware audio.`,
    ));
  }
  if (summary.samples === 0 && summary.syntheticPackets > 0) {
    failures.push(failure(
      EvidenceFailure.SYNTHETIC_IDLE_ONLY,
      `${labelFor(source)} audio is only synthetic idle silence.`,
    ));
  }
}

function checkDuplicate(failures, evidence) {
  const microphone = hardwarePcm(evidence.captured?.microphone?.packets);
  const system = hardwarePcm(evidence.captured?.system?.packets);
  if (microphone.length === 0 || system.length === 0) return;
  if (samePcm(microphone, system) || peakCorrelation(microphone, system) >= DUPLICATE_CORRELATION_THRESHOLD) {
    failures.push(failure(
      EvidenceFailure.DUPLICATED_SOURCE_PCM,
      "Microphone and system PCM match, so the sources are not independent.",
    ));
  }
}

function checkIsolation(failures, evidence) {
  const isolation = evidence.isolation;
  if (!isolation?.required) return;
  const selection = evidence.selection?.system;
  if (selection?.kind !== "endpoint" || isolation.mode === "default-device") {
    failures.push(failure(
      EvidenceFailure.DEFAULT_DEVICE_ONLY,
      "Explicit output isolation requires a selected endpoint, not the Windows default device.",
    ));
  }
  for (const side of [isolation.outputA, isolation.outputB]) {
    if (!side) {
      failures.push(failure(EvidenceFailure.ISOLATION_SIGNAL_MISSING, "Output isolation is missing an endpoint observation."));
      continue;
    }
    if (side.capturedEndpointId !== side.selectedId) {
      failures.push(failure(
        EvidenceFailure.ENDPOINT_MISMATCH,
        `Capture used ${side.capturedEndpointId || "no endpoint"} instead of selected ${side.selectedId}.`,
      ));
    }
    const detected = new Set(side.detectedSignals ?? []);
    for (const signal of side.requirePresent ?? []) {
      if (!detected.has(signal)) {
        failures.push(failure(EvidenceFailure.ISOLATION_SIGNAL_MISSING, `Signal ${signal} was absent on ${side.selectedId}.`));
      }
    }
    for (const signal of side.requireAbsent ?? []) {
      if (detected.has(signal)) {
        failures.push(failure(EvidenceFailure.ISOLATION_SIGNAL_LEAK, `Signal ${signal} leaked into ${side.selectedId}.`));
      }
    }
  }
  const change = isolation.defaultChange;
  if (!change || change.capturedEndpointId !== change.selectedId) {
    failures.push(failure(
      EvidenceFailure.DEFAULT_REDIRECT,
      "Capture followed a different endpoint when the Windows default changed.",
    ));
    return;
  }
  if (change.windowsDefaultId !== change.selectedId && change.capturedEndpointId === change.windowsDefaultId) {
    failures.push(failure(
      EvidenceFailure.DEFAULT_REDIRECT,
      "Capture followed the Windows default instead of the explicit endpoint.",
    ));
  }
}

function checkTranscription(failures, transcription) {
  if (!transcription) return;
  if (transcription.mode === "demo" || transcription.provider === "mock") {
    failures.push(failure(EvidenceFailure.CANNED_ASR, "Demo or mock transcription cannot prove live ASR."));
    return;
  }
  const expected = transcription.expectedPhrases;
  const observed = transcription.observedPhrases;
  if (!Array.isArray(expected) || expected.length === 0 || !Array.isArray(observed)) {
    failures.push(failure(EvidenceFailure.TRANSCRIPT_COUNT_ONLY, "Transcript event counts are not phrase proof."));
    return;
  }
  const haystack = observed.map((line) => String(line).toLowerCase());
  const missing = expected.some((phrase) => !haystack.some((line) => line.includes(String(phrase).toLowerCase())));
  if (missing) {
    failures.push(failure(EvidenceFailure.TRANSCRIPT_PHRASE_MISSING, "A required phrase was not in the live transcript."));
  }
}

function qualifyEcho(echo) {
  return {
    headphones: assessEcho(echo?.headphones, EvidenceFailure.HEADPHONE_ECHO, "Headphone playback leaked into the microphone."),
    speakers: assessEcho(echo?.speakers, EvidenceFailure.SPEAKER_ECHO, "Speaker playback leaked into the microphone."),
  };
}

function assessEcho(environment, code, leakedMessage) {
  if (!environment || typeof environment.leaked !== "boolean") {
    return {
      qualified: false,
      notRun: true,
      headphonesRequired: true,
      failures: [failure(code, "Echo qualification was not run.")],
    };
  }
  if (environment.leaked) {
    return {
      qualified: false,
      notRun: false,
      headphonesRequired: code === EvidenceFailure.SPEAKER_ECHO,
      failures: [failure(code, leakedMessage)],
    };
  }
  return { qualified: true, notRun: false, headphonesRequired: false, failures: [] };
}

function hardwarePcm(packets = []) {
  const samples = [];
  for (const packet of packets) {
    if (packet?.flags?.syntheticIdleSilence === true) continue;
    const pcm = finitePcm(packet?.pcm);
    if (!pcm) continue;
    samples.push(...pcm);
  }
  return samples;
}

function finitePcm(pcm) {
  if (!pcm || typeof pcm === "string" || typeof pcm.length !== "number") return null;
  const samples = [];
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = pcm[index];
    if (typeof sample === "number" && Number.isFinite(sample)) samples.push(sample);
  }
  return samples.length > 0 ? samples : null;
}

function samePcm(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function peakCorrelation(left, right) {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  const maxLag = Math.min(64, Math.floor(length / 4));
  let peak = 0;
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const value = Math.abs(correlationAt(left, right, lag));
    if (value > peak) peak = value;
  }
  return peak;
}

function correlationAt(left, right, lag) {
  let dot = 0;
  let energyLeft = 0;
  let energyRight = 0;
  const start = Math.max(0, -lag);
  const end = Math.min(left.length, right.length - lag);
  for (let index = start; index < end; index += 1) {
    const a = left[index];
    const b = right[index + lag];
    dot += a * b;
    energyLeft += a * a;
    energyRight += b * b;
  }
  if (energyLeft === 0 || energyRight === 0) return 0;
  return dot / Math.sqrt(energyLeft * energyRight);
}

function failure(code, message) {
  return { code, message };
}

function labelFor(source) {
  return source === "system" ? "Playback" : "Microphone";
}
