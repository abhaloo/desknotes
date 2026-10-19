/**
 * Frozen wire protocol for the DeskNotes realtime voice/vision
 * answer pipeline. See docs/protocol.md for the full contract.
 */

export const PROTOCOL_VERSION = 1;

/** All uplink audio is gated/resampled to this format before it is framed. */
export const SAMPLE_RATE = 16000;
export const BYTES_PER_SAMPLE = 2;
/** stream_idx (1 byte) + seq (4 bytes). PCM16LE payload follows. */
export const FRAME_HEADER_BYTES = 5;

/**
 * Bounded audio gap ring: 12 s of 16 kHz mono PCM16. Frames captured while the
 * socket is down are held here (drop-oldest) and replayed on reconnect so a
 * transient network blip costs bounded audio instead of an ASR hole. This is
 * CLIENT-side recovery: the server never replays uplink audio.
 */
export const RING_MAX_BYTES = 16000 * 2 * 12;

/** Internal capture-source names -> uplink stream index. */
export const STREAM = { MICROPHONE: 0, SYSTEM: 1 };
export const SOURCE_TO_STREAM = { microphone: 0, system: 1 };
export const STREAM_TO_SOURCE = { 0: "microphone", 1: "system" };

/**
 * Topology "general" as it appears on the wire:
 * `stream_id` is "rep"/"prospect" and `source` is "mic"/"system".
 * The client's internal source vocabulary ("microphone"/"system") maps onto
 * these via SOURCE_TO_WIRE; the wire values never leak into internal APIs.
 */
export const SOURCE_TO_WIRE = { microphone: "mic", system: "system" };

export const TOPOLOGY_WIRING = {
  general: {
    streams: [
      { stream_id: "rep", source: "mic", role: "rep", encoding: "pcm16", sample_rate: SAMPLE_RATE },
      { stream_id: "prospect", source: "system", role: "prospect", encoding: "pcm16", sample_rate: SAMPLE_RATE },
    ],
    streamIdx: { microphone: 0, system: 1 },
  },
};

export const CAPABILITIES = {
  SCREEN_ANALYSE: "screen_analyse",
  ANSWER_REQUEST: "answer_request",
  REPLAY: "replay",
  SESSION_COMMANDS: "session_commands",
  /** Server accepts `turn_hint` (client VAD end-of-turn hints). Additive. */
  TURN_HINT: "turn_hint",
  /** Server accepts `session_context` (the rep's grounding document). Additive. */
  SESSION_CONTEXT: "session_context",
  /** Server accepts `screen_clear` (drop the screen context on Clear). Additive. */
  SCREEN_CLEAR: "screen_clear",
};

/**
 * Downlink frame vocabulary. Answers are server-initiated "turns":
 * `gate.verdict` announces the gate's decision, `turn.started` opens the turn
 * (carrying `gate_seq` so the client can render it under its question),
 * `turn.token` streams text, `turn.done` completes it, `turn.superseded`
 * retires an in-flight turn that a newer one replaced. `terms` follows a
 * finished turn: the jargon in that card, explained (glossary.js).
 */
export const FRAME = {
  // client -> server
  HELLO: "hello",
  FINALIZE: "finalize",
  ANSWER_REQUEST: "answer_request",
  SCREEN_ANALYSE: "screen_analyse",
  SET_CAPTURE_AUTH: "set_capture_auth",
  TURN_HINT: "turn_hint",
  SESSION_CONTEXT: "session_context",
  SCREEN_CLEAR: "screen_clear",
  PING: "ping",
  // server -> client
  SESSION_STATE: "session.state",
  SESSION_ENDED: "session.ended",
  TRANSCRIPT: "transcript",
  TRANSCRIPTION_STATE: "transcription.state",
  GATE_VERDICT: "gate.verdict",
  TURN_STARTED: "turn.started",
  TURN_TOKEN: "turn.token",
  TURN_DONE: "turn.done",
  TURN_SUPERSEDED: "turn.superseded",
  TERMS: "terms",
  SAY: "say",
  SCREEN_RESULT: "screen.result",
  ERROR: "error",
  ERROR_RETRY: "error.retry",
  PONG: "pong",
};

/** `screen.result.solve` is an enum; anything else normalizes to this. */
export const SOLVE_NOT_REQUESTED = "not_requested";
export const SOLVE_STATES = ["solving", "busy", "duplicate", "unsolvable"];

/** `screen.result.status` is a closed set (the transport drops others). */
export const SCREEN_STATUSES = ["ok", "empty", "failed"];

/**
 * Typed transport failures carry a STRING tag on `result.failure`,
 * not an object: consumers switch on the tag.
 */
export const SCREEN_FAILURES = ["upload", "timeout", "unreachable"];

/** `transcription.state` values: ASR degradation signal per stream. */
export const TRANSCRIPTION_STATES = ["degraded", "live"];

/** `error.data.code` values that latch the session as dead. */
export const SESSION_DEAD_ERROR_CODES = ["session_ended", "session_not_found"];

// ── connection semantics ──────────────────────────────
/** Client-initiated close for `disconnect()` (session kept alive server-side). */
export const CLOSE_DISCONNECT = 4001;
/** Client-initiated close for `stop()` (normal closure). */
export const CLOSE_STOP = 1000;
/** Server auth close; one refresh-then-retry grace, then terminal. */
export const CLOSE_AUTH = 4401;
/** Server close codes that never retry. */
export const TERMINAL_CLOSE_CODES = [4400, 4404, 4409];
/** Transport-level close codes (classified `initiated_by: "transport"`). */
export const TRANSPORT_CLOSE_CODES = [0, 1005, 1006];

/** Reconnect backoff: full jitter `random() * min(MAX, BASE * 2^attempt)`. */
export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 15000;
/** A link open this long resets the attempt counter. */
export const STABLE_RESET_MS = 30000;
/**
 * Heartbeat cadence and the silence deadline armed after each ping. A
 * half-open link swallows audio silently (send() does not throw), so these
 * bound how much speech a dead link can eat: worst case ping + deadline
 * (10 s; it was 35 s at 15 s / 20 s), and the client resends what it sent
 * since the last answered ping (see realtime-client.js).
 */
export const PING_INTERVAL_MS = 5000;
export const HEARTBEAT_TIMEOUT_MS = 5000;
/**
 * Speech-time liveness: audio is being sent but nothing has come back for
 * this long, so probe now (ping + short deadline) instead of waiting for the
 * next heartbeat tick. A live server answers a ping within one round trip.
 */
export const LIVENESS_PROBE_IDLE_MS = 1500;
export const LIVENESS_PROBE_DEADLINE_MS = 2500;
/**
 * Uplink backpressure on the socket bufferedAmount (hysteresis): above HIGH
 * (~2 s of PCM16) new audio waits in the gap ring instead of piling up in an
 * unbounded socket buffer; sending resumes below LOW.
 */
export const UPLINK_HIGH_WATER_BYTES = 64 * 1024;
export const UPLINK_LOW_WATER_BYTES = 16 * 1024;

/** `turn_hint.state` values: probable end of turn / the speaker kept going. */
export const TURN_HINT_STATES = ["pause", "resume"];

/** Screenshot capture settings. */
export const SCREEN_MAX_WIDTH = 1920;
export const SCREEN_JPEG_QUALITY = 85;

/**
 * Binary uplink frame: [u8 streamIdx][u32le seq][pcm16le payload].
 * @param {number} streamIdx
 * @param {number} seq
 * @param {Uint8Array|Int16Array} pcm
 * @returns {ArrayBuffer}
 */
export function encodeAudioFrame(streamIdx, seq, pcm) {
  const bytes =
    pcm instanceof Int16Array
      ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      : pcm;
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + bytes.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, streamIdx);
  view.setUint32(1, seq >>> 0, true);
  new Uint8Array(buffer).set(bytes, FRAME_HEADER_BYTES);
  return buffer;
}

/**
 * NOTE: the payload starts at byte 5 (odd), so Int16Array views over the
 * returned subarray will throw on alignment. Copy first
 * (new Int16Array(pcm.slice().buffer)) or read via DataView.
 *
 * @param {ArrayBuffer|Buffer|Uint8Array} data
 * @returns {{ streamIdx: number, seq: number, pcm: Uint8Array }}
 */
export function decodeAudioFrame(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    streamIdx: view.getUint8(0),
    seq: view.getUint32(1, true),
    pcm: bytes.subarray(FRAME_HEADER_BYTES),
  };
}

/**
 * @param {string} type
 * @param {object} [fields]
 * @returns {string} JSON control frame with version + type stamped in.
 */
export function makeFrame(type, fields = {}) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, ...fields });
}

/**
 * @param {string} raw
 * @returns {object|null} parsed control frame, or null for binary/garbage.
 */
export function parseFrame(raw) {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    if (value.v !== PROTOCOL_VERSION || typeof value.type !== "string") return null;
    return value;
  } catch {
    return null;
  }
}
