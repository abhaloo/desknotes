/**
 * Renderer bridge (Electron preload), sandboxed.
 *
 * WHY CommonJS with inlined channel tables: the windows run with
 * `sandbox: true`, and a sandboxed preload is plain script. It cannot be ESM
 * and can `require` only `electron` (plus a few Node built-ins), not
 * `./ipc-gateway.js`. The tables below are a copy of ipc-gateway.js's
 * IPC / QUERY / COMMAND / BROADCAST exports, and
 * test/sec-preload-sandbox.test.js fails if they ever drift.
 *
 * WHY an allowlist: `contextIsolation` alone still lets a compromised renderer
 * probe arbitrary channels. This surface exposes exactly the query, command and
 * broadcast channels the overlay UI needs, and `request()` unwraps the
 * gateway's error envelope so renderer code sees normal promises while the IPC
 * boundary itself never rejects with a raw error.
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const IPC = Object.freeze({
  SPEECH_START: "speech:start",
  SPEECH_STOP: "speech:stop",
  SPEECH_RECONNECT: "speech:reconnect",
  SPEECH_DISCONNECT: "speech:disconnect",
  SPEECH_REQUEST_ANSWER: "speech:requestAnswer",
  SPEECH_SET_VAD_ENABLED: "speech:setVadEnabled",
  SPEECH_GET_VAD_ENABLED: "speech:getVadEnabled",
  SPEECH_GET_REALTIME_STATUS: "speech:getRealtimeStatus",
  SPEECH_TRANSCRIPT_RECEIVED: "speech:transcript:received",
  SPEECH_REALTIME_FRAME_RECEIVED: "speech:realtime-frame:received",
  SPEECH_ERRORED: "speech:errored",
  SPEECH_STATUS_CHANGED: "speech:status:changed",
  SPEECH_REALTIME_STATUS_CHANGED: "speech:realtime-status:changed",
  SPEECH_VAD_STATS: "speech:vad:stats",
  COACH_SAY: "coach:say",
  COACH_SAY_ECHOED: "coach:sayEchoed",
  COACH_AVATAR_READY: "coach:avatarReady",
  COACH_GET_CURRENT_CONVERSATION: "coach:getCurrentConversation",
  COACH_CONVERSATION_RECEIVED: "coach:conversation:received",
  SCREEN_ANALYSE: "screen:analyse",
  SCREEN_PERMISSION_CHANGED: "screen:permission:changed",
  SCREEN_PREFS_CHANGED: "screen:prefs:changed",
  SESSION_START: "session:start",
  SESSION_END: "session:end",
  SESSION_CAPTURE_FULLSCREEN: "session:captureFullscreen",
  SESSION_STATE_CHANGED: "session:state:changed",
  SHORTCUTS_LIST: "shortcuts:list",
  SHORTCUTS_TRIGGERED: "shortcuts:triggered",
  SHELL_ACTION: "shell:action",
  PANELS_SET: "panels:set",
  PANELS_CHANGED: "panels:changed",
  DISPLAY_CLEARED: "display:cleared",
  SCREEN_ANALYSIS_STATE: "screen:analysis-state",
  WINDOW_SHOW: "window:show",
  WINDOW_HIDE: "window:hide",
  WINDOW_TOGGLE: "window:toggle",
  WINDOW_SET_CLICK_THROUGH: "window:setClickThrough",
  WINDOW_SET_OPACITY: "window:setOpacity",
  WINDOW_GET_STATE: "window:getState",
  WINDOW_STATE_CHANGED: "window:state:changed",
  CONFIG_GET: "config:get",
  AUDIO_LIST_DEVICES: "audio:listDevices",
  AUDIO_GET_CAPABILITIES: "audio:getCapabilities",
  AUDIO_GET_STATUS: "audio:getStatus",
  AUDIO_SET_DEVICE: "audio:setDevice",
  AUDIO_EXPORT_DIAGNOSTICS: "audio:exportDiagnostics",
  AUDIO_STATUS_CHANGED: "audio:status:changed",
  GROUNDING_GET: "grounding:get",
  GROUNDING_LOAD: "grounding:load",
  GROUNDING_CLEAR: "grounding:clear",
  SETTINGS_GET: "settings:get",
  SETTINGS_SET: "settings:set",
  SETTINGS_OPEN_FOLDER: "settings:openFolder",
  SETTINGS_OPEN_KNOWN_TERMS: "settings:openKnownTerms",
  SETTINGS_OPEN_KEYS: "settings:openKeys",

  // customer profiles (additive)
  PROFILES_LIST: "profiles:list",
  PROFILES_CREATE: "profiles:create",
  PROFILES_SELECT: "profiles:select",
  PROFILES_ADD_DOCUMENT: "profiles:addDocument",
  PROFILES_REMOVE_DOCUMENT: "profiles:removeDocument",
  PROFILES_DELETE: "profiles:delete",

  // practice / rehearsal (additive)
  PRACTICE_GET: "practice:get",
  PRACTICE_SET_MATERIAL: "practice:setMaterial",
  PRACTICE_START: "practice:start",
  PRACTICE_END: "practice:end",
  PRACTICE_OPEN: "practice:open",
  PRACTICE_EVENT: "practice:event",

  // session recap (additive)
  RECAP_LIST: "recap:list",
  RECAP_GET: "recap:get",
  RECAP_OPEN: "recap:open",
  RECAP_DELETE: "recap:delete",
  RECAP_READY: "recap:ready",
  RECAP_SEARCH: "recap:search",
  RECAP_SEARCH_STATUS: "recap:search-status",
});

const QUERY_CHANNELS = Object.freeze([
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
  IPC.PROFILES_LIST,
  IPC.SETTINGS_GET,
  IPC.PRACTICE_GET,
  IPC.RECAP_LIST,
  IPC.RECAP_GET,
  IPC.RECAP_SEARCH,
]);

const COMMAND_CHANNELS = Object.freeze([
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
  IPC.PROFILES_CREATE,
  IPC.PROFILES_SELECT,
  IPC.PROFILES_ADD_DOCUMENT,
  IPC.PROFILES_REMOVE_DOCUMENT,
  IPC.PROFILES_DELETE,
  IPC.SHELL_ACTION,
  IPC.PANELS_SET,
  IPC.PRACTICE_SET_MATERIAL,
  IPC.PRACTICE_START,
  IPC.PRACTICE_END,
  IPC.PRACTICE_OPEN,
  IPC.RECAP_OPEN,
  IPC.RECAP_DELETE,
]);

const BROADCAST_CHANNELS = Object.freeze([
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
  IPC.RECAP_READY,
  IPC.RECAP_SEARCH_STATUS,
]);

const QUERIES = new Set(QUERY_CHANNELS);
const COMMANDS = new Set(COMMAND_CHANNELS);
const BROADCASTS = new Set(BROADCAST_CHANNELS);

function unwrap(envelope) {
  if (envelope && typeof envelope === "object" && "ok" in envelope) {
    if (envelope.ok) return envelope.value ?? null;
    // contextBridge clones only `message` off a rejected Error (custom
    // properties such as `code` are dropped), so reject with a plain,
    // cloneable object: the renderer can branch on `code` without parsing
    // human messages.
    throw Object.freeze({
      name: "IpcError",
      code: envelope.error?.code ?? "E_IPC",
      message: envelope.error?.message ?? "IPC request failed",
    });
  }
  return envelope;
}

/** Renderer -> main request; resolves with the value or rejects with a coded Error. */
async function request(channel, payload = null) {
  if (!QUERIES.has(channel)) throw new Error(`channel "${channel}" is not a query channel`);
  return unwrap(await ipcRenderer.invoke(channel, payload));
}

/**
 * Renderer -> main command; resolves with the value or rejects with a coded
 * Error. The gateway passes handler envelopes through unwrapped, so one
 * unwrap level is the whole contract: a command failure always rejects.
 */
async function command(channel, payload = null) {
  if (!COMMANDS.has(channel)) throw new Error(`channel "${channel}" is not a command channel`);
  return unwrap(await ipcRenderer.invoke(channel, payload));
}

const api = {
  channels: IPC,
  request,
  command,

  /** Single shell-action entry point; buttons and accelerators cannot drift (R5). */
  shellAction(action) {
    return command(IPC.SHELL_ACTION, { action });
  },

  /** Open the data folder (answer instructions, settings) in the file manager. */
  openSettingsFolder() {
    return command(IPC.SETTINGS_OPEN_FOLDER, null);
  },

  /** Open known-terms.txt (terms Terms never explains) in the default editor. */
  openKnownTerms() {
    return command(IPC.SETTINGS_OPEN_KNOWN_TERMS, null);
  },

  /** Open keys.env (the provider keys read at launch) for editing. */
  openKeysFile() {
    return command(IPC.SETTINGS_OPEN_KEYS, null);
  },

  /** Enable/disable the multi-answer panel windows (R1). */
  panelsSet(enabled) {
    return command(IPC.PANELS_SET, { enabled: Boolean(enabled) });
  },

  /**
   * Subscribe to a main -> renderer broadcast.
   * @returns {() => void} unsubscribe
   */
  on(channel, listener) {
    if (!BROADCASTS.has(channel)) throw new Error(`channel "${channel}" is not a broadcast channel`);
    if (typeof listener !== "function") throw new Error("listener must be a function");
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld("copilot", Object.freeze(api));
