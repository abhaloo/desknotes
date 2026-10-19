"use strict";

/**
 * Shared contract helpers for native audio capture.
 *
 * This module is CommonJS on purpose: the utility-process worker
 * (`audio-capture-worker.cjs`) must synchronously `require` the same rules
 * the ESM host validates, and an ESM module cannot be required under
 * Electron's Node. `audio-capture-contract.js` re-exports this file, so the
 * host, the worker, the preferences store and the audio adapter all read one
 * implementation: one device-choice rule, one error factory, one private-key
 * filter, one PCM copy, one terminal-state predicate and one audio-packet
 * field list. No Electron import so `node --test` can load it directly.
 */

const AUDIO_SOURCES = Object.freeze(["microphone", "system"]);
const DEFAULT_ROLES = Object.freeze(["multimedia", "communications"]);

const MAX_ENDPOINT_ID_LENGTH = 512;
const MAX_SAMPLES_PER_PACKET = 8192;
const MAX_ADMITTED_AGE_MS = 200;

// QPC values on the wire are 100 ns ticks. 1 ms = 10_000 ticks.
const QPC_TICKS_PER_MS = 10_000;

// "On long idle loopback periods, maintain a source health heartbeat"
// (the WASAPI capture design). The
// design names no explicit period, so this reuses the existing 1 Hz status
// cadence already used for VAD stats; a health tick is cheap metadata, and
// any shorter interval would just be chatter.
const HEALTH_HEARTBEAT_MS = 1000;

const PRIVATE_KEYS = Object.freeze([
  "handle",
  "pointer",
  "nativeHandle",
  "bufferPointer",
  "client",
]);
const PRIVATE_KEY_SET = new Set(PRIVATE_KEYS);

const FLAG_KEYS = Object.freeze([
  "silent",
  "discontinuity",
  "timestampError",
  "syntheticIdleSilence",
]);

// Terminal source outcomes. Kept in one place so the adapter, the worker and
// the host cannot drift on a state name.
const TERMINAL_STATES = Object.freeze(["ended", "failed"]);
const TERMINAL_CODES = Object.freeze(["endpoint_invalidated", "default_role_changed"]);

// The one audio-packet field list. `audioPacket` is the only serializer, so
// the worker's outbound packet and the host's validated packet cannot drift.
const AUDIO_PACKET_KEYS = Object.freeze([
  "type",
  "source",
  "generation",
  "endpointId",
  "pcm",
  "sampleRate",
  "sampleIndex",
  "qpcTimestamp100ns",
  "clockOriginQpc100ns",
  "flags",
  "sequence",
  "encoding",
  "timestampMs",
]);

function makeCodedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * One device-choice rule. Returns a result object so a preference file can
 * surface the failure; `assertDeviceChoice` is the throwing form the host
 * uses at the open boundary. The extra-key/length checks come from the
 * preferences store, so a renderer cannot smuggle arbitrary fields through.
 *
 * @param {unknown} choice
 * @returns {{ ok: true, choice: object } | { ok: false, code: string, message: string }}
 */
function validateDeviceChoice(choice) {
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    return { ok: false, code: "INVALID_DEVICE_CHOICE", message: "Device choice must be an object." };
  }
  const keys = Object.keys(choice);
  if (choice.kind === "endpoint") {
    if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("id")) {
      return {
        ok: false,
        code: "INVALID_DEVICE_CHOICE",
        message: "Endpoint choice only allows kind and id.",
      };
    }
    if (
      typeof choice.id !== "string" ||
      choice.id.trim().length === 0 ||
      choice.id.length > MAX_ENDPOINT_ID_LENGTH ||
      choice.id.includes("\0")
    ) {
      return {
        ok: false,
        code: "INVALID_DEVICE_CHOICE",
        message: "endpoint choice requires a non-empty id of at most 512 characters.",
      };
    }
    return { ok: true, choice: Object.freeze({ kind: "endpoint", id: choice.id }) };
  }
  if (choice.kind === "default") {
    if (
      keys.length !== 2 ||
      !keys.includes("kind") ||
      !keys.includes("role") ||
      !DEFAULT_ROLES.includes(choice.role)
    ) {
      return {
        ok: false,
        code: "INVALID_DEVICE_CHOICE",
        message: "default choice role must be multimedia or communications.",
      };
    }
    return { ok: true, choice: Object.freeze({ kind: "default", role: choice.role }) };
  }
  return {
    ok: false,
    code: "INVALID_DEVICE_CHOICE",
    message: "device choice kind must be endpoint or default.",
  };
}

function assertDeviceChoice(choice) {
  const result = validateDeviceChoice(choice);
  if (!result.ok) throw makeCodedError("invalid-choice", result.message);
  return result.choice;
}

/** Deep-copy without native handles. Arrays and typed arrays keep identity. */
function stripPrivate(value) {
  if (!value || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map((item) => stripPrivate(item));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEY_SET.has(key)) continue;
    out[key] = stripPrivate(item);
  }
  return out;
}

/**
 * Copy any Float32-representable payload. Throws on an unusable buffer so
 * callers decide whether that is a rejection or an overload drop.
 */
function coerceFloat32(pcm) {
  if (pcm instanceof Float32Array) return new Float32Array(pcm);
  if (pcm instanceof ArrayBuffer) {
    if (pcm.byteLength % 4 !== 0) {
      throw makeCodedError("invalid-audio", "audio buffer is not a Float32 payload");
    }
    return new Float32Array(pcm.slice(0));
  }
  if (ArrayBuffer.isView(pcm)) {
    if (pcm instanceof Float64Array) {
      const out = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) out[i] = pcm[i];
      return out;
    }
    if (pcm.byteLength % 4 !== 0) {
      throw makeCodedError("invalid-audio", "audio buffer is not a Float32 payload");
    }
    const copy = new ArrayBuffer(pcm.byteLength);
    new Uint8Array(copy).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    return new Float32Array(copy);
  }
  throw makeCodedError("invalid-audio", "audio pcm must be a Float32Array or a convertible buffer");
}

function normalizeFlags(flags) {
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
    throw makeCodedError("invalid-audio", "audio flags are required");
  }
  const out = {};
  for (const key of FLAG_KEYS) {
    if (typeof flags[key] !== "boolean") {
      throw makeCodedError("invalid-audio", `audio flag ${key} must be a boolean`);
    }
    out[key] = flags[key];
  }
  return Object.freeze(out);
}

/**
 * The single audio-packet serializer. Callers pass the raw event plus any
 * normalized overrides (copied PCM, normalized flags); only known fields
 * travel.
 */
function audioPacket(event, overrides = {}) {
  const merged = { ...event, ...overrides };
  const out = {};
  for (const key of AUDIO_PACKET_KEYS) {
    if (merged[key] !== undefined) out[key] = merged[key];
  }
  return out;
}

/**
 * `timestampMs` is captured time on the session's shared monotonic base,
 * never IPC arrival time: QPC ticks since the capture-host origin. The raw
 * QPC fields stay on the packet as extras. Falls back to sample position and
 * then to zero so every backend can satisfy the module contract.
 */
function deriveTimestampMs(event, { timeBaseQpc100ns } = {}) {
  if (Number.isFinite(event?.timestampMs)) return event.timestampMs;
  const qpc = event?.qpcTimestamp100ns;
  const origin =
    Number.isFinite(timeBaseQpc100ns) && timeBaseQpc100ns >= 0
      ? timeBaseQpc100ns
      : event?.clockOriginQpc100ns;
  if (Number.isFinite(qpc) && Number.isFinite(origin)) {
    return Math.max(0, (qpc - origin) / QPC_TICKS_PER_MS);
  }
  if (Number.isFinite(event?.sampleIndex) && Number.isFinite(event?.sampleRate) && event.sampleRate > 0) {
    return (event.sampleIndex / event.sampleRate) * 1000;
  }
  return 0;
}

/**
 * Normalize one worker audio packet. Age is checked only when the caller
 * supplies the host clock (`nowQpc100ns`) and the packet carries
 * `clockOriginQpc100ns` — arrival time is never invented here.
 *
 * @param {object} event
 * @param {{ expectedSource?: string, expectedGeneration?: number, maxSamples?: number,
 *           maxAgeMs?: number, nowQpc100ns?: number, timeBaseQpc100ns?: number }} [options]
 */
function validateWorkerAudioEvent(
  event,
  {
    expectedSource,
    expectedGeneration,
    maxSamples = MAX_SAMPLES_PER_PACKET,
    maxAgeMs = MAX_ADMITTED_AGE_MS,
    nowQpc100ns,
    timeBaseQpc100ns,
  } = {},
) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw makeCodedError("invalid-audio", "audio event must be an object");
  }
  if (event.type !== undefined && event.type !== "audio") {
    throw makeCodedError("invalid-audio", "audio event type must be audio");
  }
  if (!AUDIO_SOURCES.includes(event.source)) {
    throw makeCodedError("invalid-audio", "unrecognized audio source");
  }
  if (expectedSource !== undefined && event.source !== expectedSource) {
    throw makeCodedError("invalid-audio", "audio source does not match the open source");
  }
  if (!Number.isInteger(event.generation) || event.generation < 0) {
    throw makeCodedError("invalid-audio", "unrecognized audio generation");
  }
  if (expectedGeneration !== undefined && event.generation !== expectedGeneration) {
    throw makeCodedError("invalid-audio", "audio generation does not match the open generation");
  }
  if (typeof event.endpointId !== "string" || event.endpointId.trim() === "") {
    throw makeCodedError("invalid-audio", "audio endpointId is required");
  }
  if (event.encoding !== undefined && event.encoding !== "float32") {
    throw makeCodedError("invalid-audio", "unrecognized audio encoding");
  }

  const pcm = coerceFloat32(event.pcm);
  if (pcm.length < 1 || pcm.length > maxSamples) {
    throw makeCodedError("invalid-audio", `audio packet length must be 1..${maxSamples}`);
  }
  for (let i = 0; i < pcm.length; i++) {
    if (!Number.isFinite(pcm[i])) {
      throw makeCodedError("invalid-audio", "audio samples must be finite");
    }
  }
  if (!Number.isFinite(event.sampleRate) || event.sampleRate < 8000 || event.sampleRate > 192000) {
    throw makeCodedError("invalid-audio", "audio sampleRate is outside 8000..192000");
  }
  if (!Number.isInteger(event.sampleIndex) || event.sampleIndex < 0) {
    throw makeCodedError("invalid-audio", "audio sampleIndex must be a non-negative integer");
  }
  if (!Number.isFinite(event.qpcTimestamp100ns) || event.qpcTimestamp100ns < 0) {
    throw makeCodedError("invalid-audio", "audio qpcTimestamp100ns must be a non-negative finite number");
  }
  if (!Number.isFinite(event.clockOriginQpc100ns)) {
    throw makeCodedError("invalid-audio", "audio clockOriginQpc100ns is required");
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 0) {
    throw makeCodedError("invalid-audio", "audio sequence must be a non-negative integer");
  }

  const flags = normalizeFlags(event.flags);
  if (nowQpc100ns != null) {
    if (!Number.isFinite(nowQpc100ns)) {
      throw makeCodedError("invalid-audio", "nowQpc100ns must be finite");
    }
    if (event.qpcTimestamp100ns < event.clockOriginQpc100ns) {
      throw makeCodedError("invalid-audio", "audio timestamp precedes the capture clock origin");
    }
    const ageTicks = nowQpc100ns - event.qpcTimestamp100ns;
    if (ageTicks > maxAgeMs * QPC_TICKS_PER_MS) {
      throw makeCodedError("stale-packet", "audio packet exceeds the admitted age limit");
    }
  }

  return audioPacket(event, {
    type: "audio",
    pcm,
    flags,
    encoding: "float32",
    timestampMs: deriveTimestampMs(event, { timeBaseQpc100ns }),
  });
}

/**
 * One terminal-state rule shared by the adapter, the worker and the host.
 * "ended" only ever arrives from the native adapter, but keeping the list in
 * one place is what stops the three copies from drifting again.
 */
function isTerminalCaptureEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (event.terminal === true) return true;
  if (event.type === "ended") return true;
  if (TERMINAL_STATES.includes(event.state)) return true;
  return TERMINAL_CODES.includes(event.code);
}

/**
 * @param {object} manifest
 * @param {{ expectedArch?: string, expectedElectronTarget?: string }} [options]
 */
function validateNativeManifest(
  manifest,
  { expectedArch = "x64", expectedElectronTarget = "44.9.0" } = {},
) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw makeCodedError("invalid-manifest", "native manifest must be an object");
  }
  const sha256 = typeof manifest.sha256 === "string" ? manifest.sha256.toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw makeCodedError("invalid-manifest", "native manifest sha256 must be 64 hex characters");
  }
  if (typeof manifest.sourceDigest !== "string" || manifest.sourceDigest.trim() === "") {
    throw makeCodedError("invalid-manifest", "native manifest sourceDigest is required");
  }
  if (manifest.apiVersion !== 1) {
    throw makeCodedError("invalid-manifest", "native manifest apiVersion must be 1");
  }
  if (manifest.napiVersion !== 8) {
    throw makeCodedError("invalid-manifest", "native manifest napiVersion must be 8");
  }
  if (manifest.arch !== expectedArch) {
    throw makeCodedError("invalid-manifest", `native manifest arch must be ${expectedArch}`);
  }
  if (manifest.electronTarget !== expectedElectronTarget) {
    throw makeCodedError(
      "invalid-manifest",
      `native manifest electronTarget must be ${expectedElectronTarget}`,
    );
  }
  const validated = {
    sha256,
    sourceDigest: manifest.sourceDigest,
    apiVersion: 1,
    napiVersion: 8,
    arch: expectedArch,
    electronTarget: expectedElectronTarget,
  };
  // Optional build/test evidence recorded by the native scripts. Unknown
  // shapes are dropped rather than rejected: older manifests predate them.
  const buildOutcome = outcomeOf(manifest.buildOutcome);
  if (buildOutcome) validated.buildOutcome = buildOutcome;
  const testOutcome = outcomeOf(manifest.testOutcome);
  if (testOutcome) validated.testOutcome = testOutcome;
  return Object.freeze(validated);
}

function outcomeOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.ok !== "boolean") return null;
  if (typeof value.at !== "string" || value.at.trim() === "") return null;
  return Object.freeze({ ok: value.ok, at: value.at });
}

module.exports = {
  AUDIO_SOURCES,
  DEFAULT_ROLES,
  HEALTH_HEARTBEAT_MS,
  MAX_SAMPLES_PER_PACKET,
  MAX_ADMITTED_AGE_MS,
  QPC_TICKS_PER_MS,
  PRIVATE_KEYS,
  FLAG_KEYS,
  AUDIO_PACKET_KEYS,
  TERMINAL_STATES,
  TERMINAL_CODES,
  makeCodedError,
  validateDeviceChoice,
  assertDeviceChoice,
  stripPrivate,
  coerceFloat32,
  normalizeFlags,
  audioPacket,
  deriveTimestampMs,
  validateWorkerAudioEvent,
  isTerminalCaptureEvent,
  validateNativeManifest,
};
