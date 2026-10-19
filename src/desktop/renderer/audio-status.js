/**
 * Selector and status view model for microphone, playback, and ASR.
 *
 * This module does not touch the DOM. The renderer paints the objects it
 * returns. Endpoint identity stays on the saved id when the Windows default
 * device changes, and a quiet running input stays live.
 */

export const ROUTING_GUIDANCE = "Set your call application's output to the playback device selected here.";
export const HEADPHONES_REQUIREMENT = "Use headphones. Speaker playback is unqualified when echo cancellation is unavailable or speaker echo is unresolved.";
// The design's exact denial guidance for the microphone lane.
export const MICROPHONE_DENIAL_GUIDANCE = "Check Windows microphone privacy permissions and the selected device.";
export const LEVEL_INTERVAL_MS = 100;
export const MAX_DIAGNOSTICS_BYTES = 64 * 1024;
export const QUIET_LEVEL = 0.02;

const SELECTOR_TITLES = Object.freeze({
  microphone: "Microphone",
  system: "Playback device",
});

const TRANSCRIPTION_LABELS = Object.freeze({
  unconfigured: "ASR unconfigured",
  connecting: "ASR connecting",
  live: "ASR live",
  degraded: "ASR degraded",
  demo: "ASR demo",
});

const DIAGNOSTIC_KEYS = Object.freeze([
  "native",
  "endpoints",
  "selected",
  "resolved",
  "capture",
  "counters",
  "timing",
  "worker",
  "providerMode",
  "supportsAec",
  "tests",
  "runtime",
]);

const FORBIDDEN_KEY = /pcm|waveform|transcript|utterance|hypothesis|caption|credential|secret|password|api[-_]?key|token|authorization|cookie|^path$|filepath|workerpath|addonpath|userdata|nativepath|reportpath|diagnosticspath|^text$|^words$|^audio$|^buffer$|^frames$|^chunks?$|^raw$|^float32$|^int16$/i;

const OMIT = Symbol("omit");

export function buildDeviceSelectors({ devices, selected } = {}) {
  return {
    microphone: buildSelector("microphone", devices, selected?.microphone),
    system: buildSelector("system", devices, selected?.system),
  };
}

export function presentAudioStatus(update = {}) {
  const microphone = presentSource(update.sources?.microphone, "microphone");
  const system = presentSource(update.sources?.system, "system");
  const failedCount = [microphone, system].filter((source) => source.failed).length;
  return {
    generation: update.generation,
    microphone,
    system,
    transcription: presentTranscription(update.transcription),
    partial: failedCount === 1,
    // A denied microphone is the one failure the design requires an explicit
    // remedy for; it stays on the status surface, not only a transient toast.
    warning: microphone.guidance ?? null,
    selectorsEnabled: update.capturing !== true && update.phase !== "starting" && update.phase !== "capturing",
    routingGuidance: ROUTING_GUIDANCE,
    headphonesRequired: requiresHeadphones(update),
    headphonesMessage: HEADPHONES_REQUIREMENT,
    supportsAec: update.supportsAec === true,
  };
}

export function createStatusGate() {
  let generation = null;
  let view = null;
  return {
    apply(update) {
      if (!update || typeof update.generation !== "number" || !Number.isFinite(update.generation)) {
        return { applied: false, stale: false, view };
      }
      if (generation !== null && update.generation < generation) {
        return { applied: false, stale: true, view };
      }
      generation = update.generation;
      view = presentAudioStatus(update);
      return { applied: true, stale: false, view };
    },
  };
}

export function createLevelThrottle({ intervalMs = LEVEL_INTERVAL_MS, now = () => Date.now() } = {}) {
  let lastEmitAt = null;
  return {
    intervalMs,
    shouldEmit(at = now()) {
      if (lastEmitAt !== null && at - lastEmitAt < intervalMs) return false;
      lastEmitAt = at;
      return true;
    },
  };
}

/**
 * Capture section of the diagnostics report: format/rate per source plus the
 * gap/drop/synthetic counters the design requires. Pure so the shape is
 * testable without booting the shell.
 */
export function summariseCaptureDiagnostics({ backend, sources = {} } = {}) {
  const perSource = {};
  let dropped = 0;
  let discontinuities = 0;
  let syntheticIdleSilence = 0;
  for (const source of ["microphone", "system"]) {
    const slot = sources?.[source] ?? {};
    const entry = {
      state: slot.state ?? "idle",
      endpointId: slot.endpointId ?? null,
      endpointName: slot.endpointName ?? null,
      sampleRate: Number.isFinite(slot.sampleRate) ? slot.sampleRate : null,
      nativeChannels: Number.isFinite(slot.nativeChannels) ? slot.nativeChannels : null,
      encoding: typeof slot.encoding === "string" ? slot.encoding : null,
      dropped: slot.dropped ?? 0,
      discontinuities: slot.discontinuities ?? 0,
      syntheticIdleSilence: slot.syntheticIdleSilence ?? 0,
      delivered: slot.delivered ?? 0,
      lastPacketAgeMs: Number.isFinite(slot.lastPacketAgeMs) ? slot.lastPacketAgeMs : null,
    };
    perSource[source] = entry;
    dropped += entry.dropped;
    discontinuities += entry.discontinuities;
    syntheticIdleSilence += entry.syntheticIdleSilence;
  }
  return {
    backend: typeof backend === "string" ? backend : null,
    sources: perSource,
    counters: {
      dropped,
      discontinuities,
      gaps: discontinuities,
      syntheticIdleSilence,
    },
  };
}

export function buildDiagnosticsExport(input) {
  const sanitized = sanitize(input, 0);
  const safe = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized : {};
  let truncated = false;
  let payload = safe;
  let body = JSON.stringify(payload);
  if (utf8Size(body) > MAX_DIAGNOSTICS_BYTES) {
    truncated = true;
    payload = { truncated: true, reason: "diagnostics exceeded 64 KiB" };
    for (const key of DIAGNOSTIC_KEYS) {
      if (safe[key] !== undefined) payload[key] = safe[key];
    }
    body = JSON.stringify(payload);
    if (utf8Size(body) > MAX_DIAGNOSTICS_BYTES) {
      payload = { truncated: true, reason: "diagnostics exceeded 64 KiB" };
      body = JSON.stringify(payload);
    }
  }
  return { bytes: utf8Size(body), body, payload, truncated };
}

function buildSelector(source, devices, selected) {
  const list = sourceDevices(devices, source);
  const nameCounts = new Map();
  for (const device of list) {
    const name = device?.name || "";
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const options = [
    defaultOption("multimedia"),
    defaultOption("communications"),
  ];
  for (const device of list) {
    if (!device?.id) continue;
    const duplicate = (nameCounts.get(device.name || "") ?? 0) > 1;
    options.push({
      value: `endpoint:${device.id}`,
      kind: "endpoint",
      id: device.id,
      name: device.name || device.id,
      label: duplicate ? `${device.name || "Device"} — ${device.id}` : (device.name || device.id),
      isDefault: Boolean(device.isDefault),
      unavailable: false,
      unavailableSavedEndpoint: false,
    });
  }
  if (selected?.kind === "endpoint" && selected.id && !list.some((device) => device?.id === selected.id)) {
    const name = selected.name || "Saved device";
    options.push({
      value: `endpoint:${selected.id}`,
      kind: "endpoint",
      id: selected.id,
      name,
      label: `${name} — ${selected.id} (unavailable)`,
      isDefault: false,
      unavailable: true,
      unavailableSavedEndpoint: true,
    });
  }
  const selectedValue = choiceValue(selected);
  return {
    source,
    title: SELECTOR_TITLES[source],
    options,
    selectedValue,
    selectedOption: options.find((option) => option.value === selectedValue) ?? null,
  };
}

function defaultOption(role) {
  return {
    value: `default:${role}`,
    kind: "default",
    role,
    label: role === "multimedia" ? "Default multimedia" : "Default communications",
    unavailable: false,
    unavailableSavedEndpoint: false,
  };
}

function sourceDevices(devices, source) {
  if (!devices) return [];
  if (Array.isArray(devices)) return devices.filter((device) => device?.source === source);
  if (Array.isArray(devices[source])) return devices[source];
  return [];
}

function choiceValue(choice) {
  if (!choice) return null;
  if (choice.kind === "default" && (choice.role === "multimedia" || choice.role === "communications")) {
    return `default:${choice.role}`;
  }
  if (choice.kind === "endpoint" && choice.id) return `endpoint:${choice.id}`;
  return null;
}

function presentSource(status = {}, source = "microphone") {
  const identity = {
    endpointId: status.endpointId ?? null,
    endpointName: status.endpointName ?? null,
  };
  const denialGuidance = denialGuidanceFor(status, source);
  if (status.invalidPreference || status.state === "unconfigured") {
    return { state: "unconfigured", label: "Not configured", failed: false, quiet: false, guidance: null, ...identity };
  }
  if (status.state === "demo") {
    return { state: "demo", label: "Demo", failed: false, quiet: false, guidance: null, ...identity };
  }
  if (status.state === "starting" || status.state === "connecting") {
    return { state: "connecting", label: "Connecting", failed: false, quiet: false, guidance: null, ...identity };
  }
  if (status.state === "failed" || status.state === "error") {
    const message = status.error?.message || "Failed";
    return {
      state: "degraded",
      label: denialGuidance ? `${message} ${denialGuidance}` : message,
      failed: true,
      quiet: false,
      guidance: denialGuidance,
      ...identity,
    };
  }
  if (status.state === "running" || status.state === "live") {
    const quiet = isQuiet(status);
    return {
      state: "live",
      label: quiet ? "Running (quiet)" : "Live",
      failed: false,
      quiet,
      guidance: null,
      ...identity,
    };
  }
  if (status.error) {
    const message = status.error.message || "Failed";
    return {
      state: "degraded",
      label: denialGuidance ? `${message} ${denialGuidance}` : message,
      failed: true,
      quiet: false,
      guidance: denialGuidance,
      ...identity,
    };
  }
  if (status.state === "stopped" || status.state === "idle") {
    return { state: "unconfigured", label: "Stopped", failed: false, quiet: false, guidance: null, ...identity };
  }
  return { state: "unconfigured", label: "Not configured", failed: false, quiet: false, guidance: null, ...identity };
}

function denialGuidanceFor(status, source) {
  if (source !== "microphone") return null;
  const code = status?.error?.code;
  if (code === "E_AUDIO_DEVICE_DENIED") return MICROPHONE_DENIAL_GUIDANCE;
  const message = String(status?.error?.message ?? "");
  return /microphone\s+(access\s+)?(was\s+)?denied/i.test(message) ? MICROPHONE_DENIAL_GUIDANCE : null;
}

function isQuiet(status) {
  if (status.signal === "silent") return true;
  return typeof status.level === "number" && Number.isFinite(status.level) && status.level <= QUIET_LEVEL;
}

function presentTranscription(transcription = {}) {
  const state = TRANSCRIPTION_LABELS[transcription.state] ? transcription.state : "unconfigured";
  return {
    state,
    label: TRANSCRIPTION_LABELS[state],
    distinctFromCapture: true,
  };
}

function requiresHeadphones(update) {
  if (update.supportsAec === false) return true;
  const qualification = update.speakerQualification;
  if (!qualification) return false;
  if (qualification.qualified === false || qualification.passed === false) return true;
  return qualification.status === "failed" || qualification.status === "unresolved";
}

function sanitize(value, depth) {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : OMIT;
  if (typeof value === "string") {
    if (isFilePath(value) || value.length > 2048) return "[redacted]";
    return value;
  }
  if (typeof ArrayBuffer !== "undefined" && (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)) return OMIT;
  if (depth > 8) return OMIT;
  if (Array.isArray(value)) {
    if (value.length > 32 && value.every((item) => typeof item === "number")) return OMIT;
    const items = [];
    for (const item of value.slice(0, 64)) {
      const next = sanitize(item, depth + 1);
      if (next !== OMIT) items.push(next);
    }
    return items;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) continue;
      if (/^samples$/i.test(key) && typeof child !== "number") continue;
      const next = sanitize(child, depth + 1);
      if (next === OMIT) continue;
      out[key] = next;
    }
    return out;
  }
  return OMIT;
}

function isFilePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value)
    || value.startsWith("\\\\")
    || value.includes("file://")
    || (value.startsWith("/") && value.split("/").length > 2);
}

function utf8Size(value) {
  return new TextEncoder().encode(value).length;
}
