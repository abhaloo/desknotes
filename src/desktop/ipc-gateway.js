/**
 * Pure renderer<->main IPC gateway.
 *
 * WHY pure: `ipcMain`/`contextBridge` are Electron-only, but the routing,
 * payload guard and error mapping are the parts worth unit-testing. This module
 * therefore deals in plain envelopes and buses; `main.mjs` wires it to
 * `ipcMain.handle` and `preload.mjs` unwraps it.
 *
 * Error mapping rule: no handler rejection ever escapes as a raw throw. Every
 * call resolves to `{ok:true,value}` or `{ok:false,error:{code,message}}` so a
 * throwing engine can never kill an IPC round trip (or leak stack traces into
 * the renderer).
 */

import { ErrorCode } from "./ipc-error-codes.js";

export { ErrorCode };

/** Channel names from docs/module-contracts.md (+ additive ones, marked). */
export const IPC = Object.freeze({
  // speech uplink control
  SPEECH_START: "speech:start",
  SPEECH_STOP: "speech:stop",
  SPEECH_RECONNECT: "speech:reconnect",
  SPEECH_DISCONNECT: "speech:disconnect",
  SPEECH_REQUEST_ANSWER: "speech:requestAnswer",
  SPEECH_SET_VAD_ENABLED: "speech:setVadEnabled",
  SPEECH_GET_VAD_ENABLED: "speech:getVadEnabled",
  SPEECH_GET_REALTIME_STATUS: "speech:getRealtimeStatus",

  // main -> renderer streams (names follow the documented surface)
  SPEECH_TRANSCRIPT_RECEIVED: "speech:transcript:received",
  SPEECH_REALTIME_FRAME_RECEIVED: "speech:realtime-frame:received",
  SPEECH_ERRORED: "speech:errored",
  SPEECH_STATUS_CHANGED: "speech:status:changed",
  SPEECH_REALTIME_STATUS_CHANGED: "speech:realtime-status:changed",
  SPEECH_VAD_STATS: "speech:vad:stats",

  // say lane / coach: delivery handshake channels
  COACH_SAY: "coach:say",
  COACH_SAY_ECHOED: "coach:sayEchoed",
  COACH_AVATAR_READY: "coach:avatarReady",
  COACH_GET_CURRENT_CONVERSATION: "coach:getCurrentConversation",
  COACH_CONVERSATION_RECEIVED: "coach:conversation:received",

  // vision
  SCREEN_ANALYSE: "screen:analyse",
  SCREEN_PERMISSION_CHANGED: "screen:permission:changed",
  SCREEN_PREFS_CHANGED: "screen:prefs:changed",

  // session
  SESSION_START: "session:start",
  SESSION_END: "session:end",
  SESSION_CAPTURE_FULLSCREEN: "session:captureFullscreen",
  SESSION_STATE_CHANGED: "session:state:changed", // additive

  // shortcuts
  SHORTCUTS_LIST: "shortcuts:list", // additive
  SHORTCUTS_TRIGGERED: "shortcuts:triggered", // additive

  // shell actions: one dispatcher behind accelerators and buttons (R5)
  SHELL_ACTION: "shell:action", // additive

  // multi-answer panels (R1, R9)
  PANELS_SET: "panels:set", // additive
  PANELS_CHANGED: "panels:changed", // additive

  // display: Clear wipes what every window shows (the session keeps listening)
  DISPLAY_CLEARED: "display:cleared", // additive
  // screen: {busy} the instant a capture starts and again when its reading lands
  SCREEN_ANALYSIS_STATE: "screen:analysis-state", // additive

  // window
  WINDOW_SHOW: "window:show",
  WINDOW_HIDE: "window:hide",
  WINDOW_TOGGLE: "window:toggle",
  WINDOW_SET_CLICK_THROUGH: "window:setClickThrough",
  WINDOW_SET_OPACITY: "window:setOpacity", // additive: { opacity: 0.3..1, persist?: boolean }
  WINDOW_GET_STATE: "window:getState",
  WINDOW_STATE_CHANGED: "window:state:changed", // additive

  // misc
  CONFIG_GET: "config:get",

  // selected-device audio (listing does not start capture)
  AUDIO_LIST_DEVICES: "audio:listDevices",
  AUDIO_GET_CAPABILITIES: "audio:getCapabilities",
  AUDIO_GET_STATUS: "audio:getStatus",
  AUDIO_SET_DEVICE: "audio:setDevice",
  AUDIO_EXPORT_DIAGNOSTICS: "audio:exportDiagnostics",
  AUDIO_STATUS_CHANGED: "audio:status:changed",

  // grounding document + app settings (additive)
  GROUNDING_GET: "grounding:get",
  GROUNDING_LOAD: "grounding:load",
  GROUNDING_CLEAR: "grounding:clear",
  SETTINGS_GET: "settings:get",
  SETTINGS_SET: "settings:set",
  SETTINGS_OPEN_FOLDER: "settings:openFolder", // additive: opens the data folder in the file manager
  SETTINGS_OPEN_KNOWN_TERMS: "settings:openKnownTerms", // additive: opens known-terms.txt in the default editor
  SETTINGS_OPEN_KEYS: "settings:openKeys", // additive: opens keys.env (provider keys) for editing

  // practice / rehearsal (additive)
  PRACTICE_GET: "practice:get",
  PRACTICE_SET_MATERIAL: "practice:setMaterial",
  PRACTICE_START: "practice:start",
  PRACTICE_END: "practice:end",
  PRACTICE_OPEN: "practice:open",
  PRACTICE_EVENT: "practice:event",
});

export const QUERY_CHANNELS = Object.freeze([
  IPC.SPEECH_GET_VAD_ENABLED,
  IPC.SPEECH_GET_REALTIME_STATUS,
  IPC.SHORTCUTS_LIST,
  IPC.WINDOW_GET_STATE,
  IPC.COACH_GET_CURRENT_CONVERSATION,
  IPC.CONFIG_GET,
  IPC.AUDIO_LIST_DEVICES,
  IPC.AUDIO_GET_CAPABILITIES,
  IPC.AUDIO_GET_STATUS,
  IPC.GROUNDING_GET,
  IPC.SETTINGS_GET,
  IPC.PRACTICE_GET,
]);

export const COMMAND_CHANNELS = Object.freeze([
  IPC.SPEECH_START,
  IPC.SPEECH_STOP,
  IPC.SPEECH_RECONNECT,
  IPC.SPEECH_DISCONNECT,
  IPC.SPEECH_REQUEST_ANSWER,
  IPC.SPEECH_SET_VAD_ENABLED,
  IPC.SCREEN_ANALYSE,
  IPC.COACH_AVATAR_READY,
  IPC.COACH_SAY_ECHOED,
  IPC.SESSION_START,
  IPC.SESSION_END,
  IPC.SESSION_CAPTURE_FULLSCREEN,
  IPC.WINDOW_SHOW,
  IPC.WINDOW_HIDE,
  IPC.WINDOW_TOGGLE,
  IPC.WINDOW_SET_CLICK_THROUGH,
  IPC.WINDOW_SET_OPACITY,
  IPC.AUDIO_SET_DEVICE,
  IPC.AUDIO_EXPORT_DIAGNOSTICS,
  IPC.GROUNDING_LOAD,
  IPC.GROUNDING_CLEAR,
  IPC.SETTINGS_SET,
  IPC.SETTINGS_OPEN_FOLDER,
  IPC.SETTINGS_OPEN_KNOWN_TERMS,
  IPC.SETTINGS_OPEN_KEYS,
  IPC.SHELL_ACTION,
  IPC.PANELS_SET,
  IPC.PRACTICE_SET_MATERIAL,
  IPC.PRACTICE_START,
  IPC.PRACTICE_END,
  IPC.PRACTICE_OPEN,
]);

export const BROADCAST_CHANNELS = Object.freeze([
  IPC.SPEECH_TRANSCRIPT_RECEIVED,
  IPC.SPEECH_REALTIME_FRAME_RECEIVED,
  IPC.SPEECH_ERRORED,
  IPC.SPEECH_STATUS_CHANGED,
  IPC.SPEECH_REALTIME_STATUS_CHANGED,
  IPC.SPEECH_VAD_STATS,
  IPC.COACH_SAY,
  IPC.COACH_CONVERSATION_RECEIVED,
  IPC.SCREEN_PERMISSION_CHANGED,
  IPC.SCREEN_PREFS_CHANGED,
  IPC.SESSION_STATE_CHANGED,
  IPC.SHORTCUTS_TRIGGERED,
  IPC.WINDOW_STATE_CHANGED,
  IPC.AUDIO_STATUS_CHANGED,
  IPC.PANELS_CHANGED,
  IPC.PRACTICE_EVENT,
  IPC.DISPLAY_CLEARED,
  IPC.SCREEN_ANALYSIS_STATE,
]);

export function okEnvelope(value = null) {
  return { ok: true, value: value === undefined ? null : value };
}

export function failEnvelope(code, message, extra = null) {
  const error = { code: String(code), message: String(message ?? code) };
  if (extra && typeof extra === "object") {
    for (const [key, val] of Object.entries(extra)) {
      if (key !== "code" && key !== "message" && val !== undefined) error[key] = val;
    }
  }
  return { ok: false, error };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function messageOf(error) {
  if (error instanceof Error) return error.message || error.name || "error";
  if (error === undefined) return "handler failed";
  if (error === null) return "null thrown";
  if (typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return "unserializable error";
    }
  }
  return String(error);
}

/**
 * A handler may return a finished envelope (`okEnvelope(...)` /
 * `failEnvelope(...)`). Those pass through unchanged: wrapping them again
 * produced `{ok:true, value:{ok:false, error}}`, which the preload unwraps
 * into a "successful" failure the renderer never notices. The shape check is
 * strict so ordinary values that happen to carry an `ok` field still wrap.
 */
function isEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (value.ok === true) return keys.length === 2 && keys.includes("value");
  if (value.ok === false) {
    return (
      keys.length === 2 &&
      value.error !== null &&
      typeof value.error === "object" &&
      typeof value.error.code === "string" &&
      typeof value.error.message === "string"
    );
  }
  return false;
}

const encoder = new TextEncoder();

/**
 * Electron moves IPC payloads through structured clone, so cloneability — not
 * JSON shape — is the real boundary. JSON.stringify is then the byte measure.
 * (`{fn: () => {}}` stringifies to `"{}"` but cannot cross the boundary.)
 */
function checkCloneable(value) {
  if (typeof structuredClone !== "function") return true;
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * JSON-byte measure. Everything this app sends is plain JSON, so
 * stringification is both the cheapest guard and the honest one: it rejects
 * exactly the values a renderer could never usefully send (functions, cycles,
 * BigInt) on runtimes without `structuredClone`.
 */
function measure(payload) {
  if (payload === undefined) return { ok: true, bytes: 0 };
  if (!checkCloneable(payload)) {
    return { ok: false, code: ErrorCode.PAYLOAD_NOT_SERIALIZABLE };
  }
  try {
    const json = JSON.stringify(payload);
    if (json === undefined) {
      return { ok: false, code: ErrorCode.PAYLOAD_NOT_SERIALIZABLE };
    }
    return { ok: true, bytes: encoder.encode(json).length };
  } catch {
    return { ok: false, code: ErrorCode.PAYLOAD_NOT_SERIALIZABLE };
  }
}

export class IpcGateway {
  #queries = new Map();
  #commands = new Map();
  #listeners = new Set();
  #maxPayloadBytes;
  #now;
  #onError;

  constructor({ maxPayloadBytes = 256 * 1024, now = () => Date.now(), onError = null } = {}) {
    this.#maxPayloadBytes = maxPayloadBytes;
    this.#now = now;
    this.#onError = typeof onError === "function" ? onError : null;
  }

  /**
   * @param {string} channel
   * @param {(payload: any, meta: any) => any|Promise<any>} handler
   * @returns {() => void} unregister
   */
  registerQuery(channel, handler) {
    return this.#register(this.#queries, "query", channel, handler);
  }

  /**
   * @param {string} channel
   * @param {(payload: any, meta: any) => any|Promise<any>} handler
   * @returns {() => void} unregister
   */
  registerCommand(channel, handler) {
    return this.#register(this.#commands, "command", channel, handler);
  }

  /** @returns {boolean} true when a handler was removed */
  unregisterQuery(channel) {
    return this.#queries.delete(channel);
  }

  /** @returns {boolean} true when a handler was removed */
  unregisterCommand(channel) {
    return this.#commands.delete(channel);
  }

  hasQuery(channel) {
    return this.#queries.has(channel);
  }

  hasCommand(channel) {
    return this.#commands.has(channel);
  }

  getChannels() {
    return { queries: [...this.#queries.keys()], commands: [...this.#commands.keys()] };
  }

  /** Renderer -> main request. Never rejects. */
  async handleQuery(channel, payload = null, meta = null) {
    return this.#dispatch(this.#queries, channel, payload, meta);
  }

  /** Renderer -> main fire-and-forget (still acked for error reporting). */
  async handleCommand(channel, payload = null, meta = null) {
    return this.#dispatch(this.#commands, channel, payload, meta);
  }

  /**
   * Main -> renderer(s). Fan-out is synchronous and isolated per listener:
   * one renderer bridge throwing must not stop the others from updating.
   * Never throws.
   *
   * @returns {{ok: boolean, delivered: number, error?: object}}
   */
  broadcast(channel, payload = null, meta = null) {
    if (typeof channel !== "string" || channel.length === 0) {
      return this.#record(failEnvelope(ErrorCode.INVALID_CHANNEL, "broadcast needs a channel name"));
    }
    const guarded = this.#guardPayload(payload);
    if (!guarded.ok) return { ...this.#record(guarded), delivered: 0 };
    const message = Object.freeze({
      channel,
      payload: payload === undefined ? null : payload,
      meta: meta ?? null,
      at: this.#now(),
    });
    let delivered = 0;
    for (const listener of [...this.#listeners]) {
      try {
        listener(message);
        delivered += 1;
      } catch (error) {
        this.#record(failEnvelope(ErrorCode.LISTENER_FAILED, messageOf(error), { channel }));
      }
    }
    return { ok: true, delivered };
  }

  /** @param {(message: {channel: string, payload: any, meta: any, at: number}) => void} listener */
  subscribe(listener) {
    if (typeof listener !== "function") {
      throw codedError(ErrorCode.INVALID_LISTENER, "subscribe(listener) requires a function");
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #register(map, kind, channel, handler) {
    if (typeof channel !== "string" || !channel.includes(":")) {
      throw codedError(ErrorCode.INVALID_CHANNEL, `${kind} channel must be a namespaced string`);
    }
    if (typeof handler !== "function") {
      throw codedError(ErrorCode.INVALID_HANDLER, `${kind} ${channel} requires a function handler`);
    }
    if (map.has(channel)) {
      throw codedError(ErrorCode.DUPLICATE_CHANNEL, `${kind} ${channel} is already registered`);
    }
    map.set(channel, handler);
    return () => map.delete(channel);
  }

  async #dispatch(map, channel, payload, meta) {
    const guarded = this.#guardPayload(payload);
    if (!guarded.ok) return this.#record(guarded);
    const handler = typeof channel === "string" ? map.get(channel) : undefined;
    if (!handler) {
      return this.#record(
        failEnvelope(ErrorCode.UNKNOWN_CHANNEL, `no handler registered for "${String(channel)}"`, {
          channel: String(channel),
        }),
      );
    }
    try {
      const value = await handler(payload, meta);
      if (value === undefined) return this.#record(okEnvelope(null));
      const result = measure(value);
      if (!result.ok) {
        return this.#record(
          failEnvelope(ErrorCode.RESULT_NOT_SERIALIZABLE, `handler for "${channel}" returned a non-serializable value`, {
            channel,
          }),
        );
      }
      return this.#record(isEnvelope(value) ? value : okEnvelope(value));
    } catch (error) {
      return this.#record(
        failEnvelope(ErrorCode.HANDLER_FAILED, messageOf(error), {
          channel,
          handlerCode: error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined,
        }),
      );
    }
  }

  #guardPayload(payload) {
    const result = measure(payload);
    if (!result.ok) {
      return failEnvelope(result.code, "payload is not JSON-serializable");
    }
    if (result.bytes > this.#maxPayloadBytes) {
      return failEnvelope(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `payload is ${result.bytes} bytes, limit is ${this.#maxPayloadBytes}`,
        { bytes: result.bytes, limit: this.#maxPayloadBytes },
      );
    }
    return okEnvelope(null);
  }

  #record(envelope) {
    if (!envelope.ok && this.#onError) {
      try {
        this.#onError(envelope);
      } catch {
        // Logging must not change control flow.
      }
    }
    return envelope;
  }
}
