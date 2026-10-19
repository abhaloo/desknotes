/**
 * Desktop shell entry (Electron main process).
 *
 * WHY this file is the only `electron` importer: everything else in
 * `src/desktop/` must stay unit-testable under `bun test`; here we can wire
 * real windows, global shortcuts and OS capture without contaminating the
 * pure modules.
 *
 * The transport, audio and vision modules are imported lazily per feature,
 * and their absence degrades the shell instead of crashing it: a missing transport blocks session start, a missing audio module leaves
 * the transcript server-only, a missing vision module disables screen analysis.
 */
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, screen, session as electronSession, shell } from "electron";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionLifecycle, SESSION_STATES } from "./session-lifecycle.js";
import { CAPTURE_PARTITION, createScreenGrabber } from "./screen-grabber.js";
import { IpcGateway, IPC, ErrorCode, okEnvelope, failEnvelope } from "./ipc-gateway.js";
import { createPanelManager } from "./panel-manager.js";
import { resolveDevFlags } from "./dev-flags.js";
import { createWindowPresenter } from "./window-presenter.js";
import { withAppWindowsHidden } from "./capture-visibility.js";
import {
  capturePermissionPolicy,
  forbiddenDebugSwitches,
  guardIpcHandler,
  hardenWebContents,
  lockDownSession,
} from "./web-hardening.js";
import { checkRealtimeUrl } from "../security/url-policy.js";
import { createAudioDevicePreferences } from "./audio-device-preferences.js";
import { createGroundingDocumentStore, documentMetadata, STORED_DOCUMENT_UNREADABLE } from "./grounding-document.js";
import { createPracticeMaterialStore } from "./practice/material.js";
import { createPracticeDebriefStore } from "./practice-debrief.js";
import { createQuestionSegmenter } from "./practice/segmenter.js";
import { createPracticeSession } from "./practice/session.js";
import { buildDebrief, formatDebrief } from "./practice/debrief.js";
import { autoStartDecision, createAppPreferences, SETTINGS_UNREADABLE, validateSettingsUpdate } from "./app-preferences.js";
import { selectNativeAddonLocation, validateNativeManifest } from "./audio-capture-contract.js";
import { fillMissingUserEnv } from "./user-env.js";
import { prepareDataDir } from "./data-dir.js";
import { ANSWER_INSTRUCTIONS_FILENAME, ensureAnswerInstructionsFile } from "../server/engines/answer-instructions.js";
import { normalizeAnswerModel } from "../server/engines/answer-models.js";
import { parseRepContextSwitch } from "../server/engines/conversation-context.js";
import { KNOWN_TERMS_FILENAME, ensureKnownTermsFile, parseGlossarySwitch } from "../server/engines/glossary.js";
import { parseHighlightsSwitch } from "../shared/highlights.js";
import { parseAnswerCardsSwitch } from "../shared/answer-cards.js";
import { WINDOW_OPACITY, clampWindowOpacity } from "./window-opacity.js";
import { buildDiagnosticsExport, createLevelThrottle, summariseCaptureDiagnostics } from "./renderer/audio-status.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = join(__dirname, "renderer");
const RENDERER_PAGE = join(RENDERER_DIR, "index.html");
const CAPTURE_PAGE = join(__dirname, "capture", "capture.html");
const PRACTICE_PAGE = join(RENDERER_DIR, "practice.html");
/** The practice page may call only the practice:* channels it uses, nothing else on the bridge. */
const PRACTICE_SENDER_PAGES = Object.freeze(["index.html", "practice.html"]);
const APP_TITLE = "DeskNotes";

/**
 * A shipped build never runs with a debugger attached. The fuses already kill
 * Node's --inspect and NODE_OPTIONS, but Chromium's --remote-debugging-port
 * would still expose every window over CDP on loopback (any local user can
 * attach, read transcripts and drive the bridge), and --no-sandbox would undo
 * the renderer sandbox. Refused before any window or session exists. Dev runs
 * are unaffected.
 */
const REFUSED_SWITCHES = app.isPackaged
  ? forbiddenDebugSwitches({ argv: process.argv, hasSwitch: (name) => app.commandLine?.hasSwitch?.(name) })
  : [];
if (REFUSED_SWITCHES.length > 0) {
  console.error(`[desktop] refusing to start: debug switches are not allowed in packaged builds (${REFUSED_SWITCHES.join(", ")})`);
  if (typeof app.exit === "function") app.exit(1);
  else process.exit(1);
}

/* ------------------------------------------------------------- runtime flags */

const FLAGS = resolveDevFlags({ env: process.env, isPackaged: app.isPackaged });
for (const message of FLAGS.warnings) console.warn(`[desktop] ${message}`);

// UI automation reads the page on its first query.
if (FLAGS.allowAccessibility) app.commandLine.appendSwitch("force-renderer-accessibility");

/**
 * Electron's default handler for an uncaught main-process error shows a native
 * dialog mid-call. Errors are logged to the console instead.
 */
function onFatal(kind, error) {
  try {
    console.error(`[desktop] ${kind}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  } catch {
    /* logging must never throw from here */
  }
}
process.on("uncaughtException", (error) => onFatal("uncaughtException", error));
process.on("unhandledRejection", (reason) => onFatal("unhandledRejection", reason));

const REALTIME_URL_ENV = process.env.REALTIME_URL || "";
/** Filled at boot: the embedded server's URL unless REALTIME_URL overrides it. */
let REALTIME_URL = REALTIME_URL_ENV || "ws://localhost:8787";
/**
 * Optional fixed session id (debugging only). By default every session:start
 * mints a fresh unguessable id: reusing one id across Start -> End -> Start
 * collided with the server's per-session seq accounting, and a predictable
 * id is half of a session-hijack.
 */
const SESSION_ID = process.env.SESSION_ID || "";
const JWT = process.env.JWT || "";
/**
 * Per-launch credential for the embedded server: the in-app client presents
 * it as its jwt and the server checks it in constant time. It lives only in
 * this process — never in IPC payloads, never in the renderer.
 */
const EMBEDDED_SECRET = randomBytes(32).toString("hex");
/**
 * "native" stays the default: real WASAPI/CoreAudio capture is the product,
 * and silently substituting synthetic audio in a live call would be worse
 * than an explicit failure. When the backend cannot start, speech:start and
 * session:start report E_CAPTURE_UNAVAILABLE and the UI shows it. Use
 * CAPTURE_BACKEND=simulated (or file) to run the loop without devices.
 */
const CAPTURE_BACKEND = process.env.CAPTURE_BACKEND || "native";
const VAD_DISABLED = process.env.VAD_ENABLED === "0" || process.env.VAD_ENABLED === "false";

/** Side-panel geometry: the overlay should never cover the call controls. */
const OVERLAY = Object.freeze({ width: 424, height: 860, margin: 16, top: 24 });
const SPEECH_STATS_INTERVAL_MS = 1000;
/** before-quit waits this long for a normal stop, then kills a stuck worker. */
const QUIT_STOP_TIMEOUT_MS = 2000;
const AUDIO_SOURCES = Object.freeze(["microphone", "system"]);
const boundAudioHosts = new WeakSet();

const state = {
  windows: { main: null, overlay: null, panels: [], practice: null },
  lifecycle: null,
  gateway: null,
  transport: null,
  transportModule: null,
  audioModule: null,
  visionModule: null,
  vadProbe: null,
  vision: { capture: null, analyser: null, analyserTransport: null, grabber: null },
  /** Id of the live session (fresh per session:start). */
  sessionId: null,
  /** Credential for REALTIME_URL: the embedded secret, or JWT for an external server. */
  credential: JWT,
  endingPromise: null,
  pipelines: new Map(),
  unsubscribers: [],
  vadEnabled: !VAD_DISABLED,
  clickThrough: false,
  /** Shows, hides and fades app windows (window-presenter.js). Created at boot. */
  presenter: null,
  lastVadStatsJson: "",
  status: { lifecycle: SESSION_STATES.IDLE, realtime: "idle", lastError: null },
  lastUtterance: "",
  statsTimer: null,
  shortcuts: [],
  /** Set at boot when REALTIME_URL fails the transport policy. */
  realtimeUrlError: null,
  /** Grounding document (grounding-document.js): the text stays in main; renderers get metadata. */
  grounding: { store: null, document: null, readError: null },
  /** Practice / rehearsal (src/desktop/practice/). */
  practice: {
    materialStore: null,
    material: null,
    materialReadError: null,
    debriefStore: null,
    debrief: null,
    debriefReadError: null,
    session: null,
    answerer: null,
    segmenter: null,
  },
  /** App settings (app-preferences.js). OFF until loaded: nothing auto-starts on a read we never did. */
  appPreferences: null,
  settings: { autoStart: false, answerModel: "", windowOpacity: WINDOW_OPACITY.default, readError: null },
  /** Mode passed to buildEngineConfig. Native capture uses live unless overridden. */
  engineMode: null,
  audio: {
    generation: 0,
    phase: "idle",
    speechChain: Promise.resolve(),
    speechDepth: 0,
    preferences: null,
    sessionHost: null,
    hostOwned: false,
    hostPromise: null,
    choices: { microphone: null, system: null },
    sources: {
      microphone: emptySourceStatus(),
      system: emptySourceStatus(),
    },
    transcription: {
      state: (process.env.CAPTURE_BACKEND || "native") === "native" ? "unconfigured" : "demo",
    },
    levelThrottle: null,
    forcedCleanup: false,
    quitSettled: false,
    quitTask: null,
    lastCleanup: null,
  },
};

let panelManager = null;

/**
 * Practice runs on the desktop product state, so it builds its own answerer
 * from the same env config the embedded server uses. Lazy: practice must not
 * cost anything at boot, and it must work even when the embedded server
 * failed to start (external REALTIME_URL).
 */
async function ensurePracticeEngine() {
  if (state.practice.segmenter) return state.practice;
  const engines = await import("../server/engines/index.js");
  const config = engines.buildEngineConfig(process.env, {
    mode: state.engineMode ?? captureEngineMode(process.env, CAPTURE_BACKEND),
    answerInstructionsPath: answerInstructionsPath(),
    telemetryDir: join(userDataDirectory(), "logs", "telemetry"),
  });
  // Follows Settings > Answer model like live answers do (read per answer).
  state.practice.answerer = engines.createSelectableAnswerer({
    options: { provider: config.answerProvider, ...config.answererOptions },
    selectModel: () => state.settings?.answerModel || config.answerModel || null,
    deepseekApiKey: config.deepseekApiKey,
    cerebrasAvailable: config.cerebrasAvailable,
  });
  // Question detection is the local heuristic only (no model call, no network
  // round trip on the transcript path), so no judge is built here.
  state.practice.segmenter = createQuestionSegmenter({ ask: null });
  return state.practice;
}

function errorText(error) {
  if (error instanceof Error) return error.message || error.name;
  return String(error ?? "unknown error");
}

function warn(...args) {
  // The shell must keep running with partial feature sets; warnings are the
  // only signal that a parallel package is absent.
  console.warn("[desktop]", ...args);
}

async function optionalImport(specifier, label) {
  try {
    return await import(specifier);
  } catch (error) {
    warn(`optional module "${label}" unavailable: ${errorText(error)}`);
    return null;
  }
}

function broadcast(channel, payload) {
  state.gateway?.broadcast(channel, payload);
}

/** Practice events reach the practice window ONLY — never the overlay or panels. */
function sendToPractice(event) {
  state.windows.practice?.webContents.send(IPC.PRACTICE_EVENT, event);
}

/* ------------------------------------------------------------------ windows */

function windowState() {
  const main = state.windows.main;
  const overlay = state.windows.overlay;
  return {
    mainVisible: Boolean(main && !main.isDestroyed() && main.isVisible()),
    overlayVisible: Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible()),
    clickThrough: state.clickThrough,
    // The title-row slider's value, shared by every app window.
    windowOpacity: currentWindowOpacity(),
  };
}

function currentWindowOpacity() {
  return clampWindowOpacity(state.settings?.windowOpacity);
}

/**
 * Settings > "Use what I say in answers" (rep context), read for every answer.
 * Loaded settings always hold a boolean; the env REP_CONTEXT only applies
 * while they are not loaded, like ANSWER_MODEL.
 */
function currentRepContext() {
  if (typeof state.settings?.repContext === "boolean") return state.settings.repContext;
  return parseRepContextSwitch(process.env.REP_CONTEXT) !== false;
}

/**
 * Settings > "Highlight key phrases" (src/shared/highlights.js), read for
 * every answer. Like rep context, the env HIGHLIGHTS only applies while the
 * settings are not loaded.
 */
function currentHighlights() {
  if (typeof state.settings?.highlights === "boolean") return state.settings.highlights;
  return parseHighlightsSwitch(process.env.HIGHLIGHTS) !== false;
}

/**
 * Settings > "Short answer cards" (src/shared/answer-cards.js), read for
 * every answer. Like rep context and highlights, the env ANSWER_CARDS only
 * applies while the settings are not loaded.
 */
function currentAnswerCards() {
  if (typeof state.settings?.answerCards === "boolean") return state.settings.answerCards;
  return parseAnswerCardsSwitch(process.env.ANSWER_CARDS) !== false;
}

/**
 * Settings > "Explain terms" (src/server/engines/glossary.js), read once per
 * answer turn. Like the other answer switches, the env GLOSSARY only applies
 * while the settings are not loaded.
 */
function currentGlossary() {
  if (typeof state.settings?.glossary === "boolean") return state.settings.glossary;
  return parseGlossarySwitch(process.env.GLOSSARY) !== false;
}

/** A practice answer follows the same card and highlight settings as a live one. */
function practiceAnswerArgs(args) {
  return {
    ...args,
    ...(currentAnswerCards() ? { cards: true } : {}),
    ...(currentHighlights() ? { highlights: true } : {}),
  };
}

/**
 * Title-row transparency slider. The value is live for every app window
 * (control, overlay, panels); `persist` (sent when the drag ends) also saves
 * it to app-preferences.json. Windows opened later take it when they show.
 */
async function commandSetWindowOpacity(payload) {
  const valid =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload).every((key) => key === "opacity" || key === "persist") &&
    typeof payload.opacity === "number" &&
    Number.isFinite(payload.opacity) &&
    (!("persist" in payload) || typeof payload.persist === "boolean");
  if (!valid) {
    return failEnvelope(ErrorCode.INVALID_PAYLOAD, "window:setOpacity takes { opacity: number, persist?: boolean }.");
  }
  const windowOpacity = clampWindowOpacity(payload.opacity);
  state.settings = { ...state.settings, windowOpacity };
  for (const win of [state.windows.main, state.windows.overlay, ...state.windows.panels]) state.presenter?.applyOpacity(win);
  broadcast(IPC.WINDOW_STATE_CHANGED, windowState());
  if (payload.persist === true) {
    if (!state.appPreferences) return failEnvelope("E_SETTINGS_SAVE", "Couldn't save the setting.");
    try {
      state.settings = { ...(await state.appPreferences.save({ windowOpacity })), windowOpacity: currentWindowOpacity() };
    } catch (error) {
      warn(`settings save failed: ${errorText(error)}`);
      return failEnvelope("E_SETTINGS_SAVE", "Couldn't save the setting.");
    }
  }
  return okEnvelope({ windowOpacity: currentWindowOpacity() });
}

function broadcastWindowState() {
  broadcast(IPC.WINDOW_STATE_CHANGED, windowState());
}

function baseWebPreferences() {
  return {
    // CommonJS: a sandboxed preload cannot be ESM or import local modules.
    preload: join(__dirname, "preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    // OS-level renderer sandbox: a renderer compromise stays inside it.
    sandbox: true,
    webSecurity: true,
    // DevTools opens as a separate, unprotected window: never in packaged builds.
    devTools: !app.isPackaged,
  };
}

/* -------------------------------------------------- analyse chord (m then ,) */
// In-app ONLY bare-key chord for "analyse the screen in focus": bare "m" then
// "," (800 ms) inside our own windows. The GLOBAL trigger is the
// Ctrl+Shift+M accelerator registered in registerShortcuts() below.
// Bare keys must NEVER be registered as OS hotkeys: RegisterHotKey swallows
// them system-wide - including while the rep is typing in their CRM during a
// call, which is exactly when the m key matters.
let analyseChordArmedAt = 0;
const ANALYSE_CHORD_WINDOW_MS = 800;

function armAnalyseChord() {
  analyseChordArmedAt = Date.now();
}

function consumeAnalyseChord() {
  const armed = analyseChordArmedAt !== 0 && Date.now() - analyseChordArmedAt <= ANALYSE_CHORD_WINDOW_MS;
  analyseChordArmedAt = 0;
  return armed;
}

/*
 * Quit is an in-app Ctrl+Q: it only fires while one of our windows has the
 * keyboard. It is never a globalShortcut, which would claim Ctrl+Q from every
 * other application.
 */
const QUIT_ACCELERATOR = "Ctrl+Q";

/** Clear the answer, lanes and screen context: global, like Answer now and Analyse screen. */
const CLEAR_ACCELERATOR = "CommandOrControl+Shift+X";

function isQuitChord(input) {
  const key = typeof input.key === "string" ? input.key.toLowerCase() : "";
  return key === "q" && (input.control || input.meta) && !input.alt && !input.shift;
}

/** Wires one app window: the in-app keys, the link policy, renderer recovery and DevTools. */
function wireWindow(win) {
  const wc = win.webContents;
  // In-app chord: bare "m" then "," (800 ms) runs analyse-screen. Bare keys
  // are never consumed for plain "m" - the window must keep accepting typing
  // (device <select> type-ahead, future text fields).
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    if (isQuitChord(input)) {
      event.preventDefault();
      broadcast(IPC.SHORTCUTS_TRIGGERED, { action: "quit", accelerator: QUIT_ACCELERATOR });
      void triggerShellAction("quit");
      return;
    }
    if (input.control || input.alt || input.shift || input.meta) return;
    const key = typeof input.key === "string" ? input.key.toLowerCase() : "";
    if (key === "m") {
      armAnalyseChord();
      return;
    }
    if (key === "," || key === "comma") {
      if (consumeAnalyseChord()) {
        event.preventDefault();
        broadcast(IPC.SHORTCUTS_TRIGGERED, { action: "analyse-screen", accelerator: "m ," });
        void triggerShellAction("analyse-screen");
      }
    }
  });
  // Links and window.open never open new app windows.
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("render-process-gone", (_event, details) => {
    warn(`renderer gone (${details?.reason ?? "unknown"}); reloading`);
    const now = Date.now();
    win.__reloads = (win.__reloads ?? []).filter((t) => now - t < 60_000);
    if (win.__reloads.length < 3) {
      win.__reloads.push(now);
      setTimeout(() => {
        if (!win.isDestroyed()) wc.reload();
      }, 250);
    }
  });
  wc.on("devtools-opened", () => {
    if (app.isPackaged) {
      wc.closeDevTools();
      return;
    }
    // Dev: keep DevTools docked inside the window.
    if (win.__devtoolsDocked) return;
    wc.closeDevTools();
    setImmediate(() => {
      if (win.isDestroyed()) return;
      win.__devtoolsDocked = true;
      wc.openDevTools({ mode: "bottom", activate: false });
    });
  });
  wc.on("devtools-closed", () => {
    win.__devtoolsDocked = false;
  });
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 420,
    minHeight: 620,
    show: false,
    title: APP_TITLE,
    backgroundColor: "#0b0d12",
    webPreferences: baseWebPreferences(),
  });
  wireWindow(win);
  win.loadFile(RENDERER_PAGE, { query: { mode: "control" } });
  win.once("ready-to-show", () => state.presenter.show(win, { inactive: false }));
  win.on("closed", () => {
    state.windows.main = null;
  });
  return win;
}

function createOverlayWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const height = Math.max(320, Math.min(OVERLAY.height, workArea.height - OVERLAY.top - OVERLAY.margin));
  const win = new BrowserWindow({
    width: OVERLAY.width,
    height,
    x: Math.round(workArea.x + workArea.width - OVERLAY.width - OVERLAY.margin),
    y: Math.round(workArea.y + OVERLAY.top),
    minWidth: 320,
    minHeight: 260,
    show: false,
    title: APP_TITLE,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: baseWebPreferences(),
  });
  // "screen-saver" outranks normal always-on-top apps (calls, browsers) without
  // fighting OS-level overlays; visible on all workspaces so full-screen
  // meeting windows do not hide it.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  wireWindow(win);
  win.loadFile(RENDERER_PAGE, { query: { mode: "overlay" } });
  win.once("ready-to-show", () => state.presenter.show(win, { inactive: true })); // never steal focus from the call
  win.on("closed", () => {
    state.windows.overlay = null;
  });
  return win;
}

/**
 * The practice window is a normal window: framed, resizable, in Alt-Tab, never always-on-top.
 */
function createPracticeWindow() {
  const win = new BrowserWindow({
    width: 880,
    height: 720,
    title: "DeskNotes — Practice",
    webPreferences: baseWebPreferences(),
  });
  // The default session lets app windows show index.html or practice.html;
  // this window narrows itself to practice.html alone, so it can never turn
  // into an unprotected copy of the overlay page (which holds the whole bridge).
  hardenWebContents(win.webContents, { pages: [PRACTICE_PAGE], log: (entry) => warn(`practice blocked: ${entry.type}`) });
  win.loadFile(PRACTICE_PAGE);
  win.on("closed", () => {
    state.windows.practice = null;
    // Practice answers are delivered to this window only. With it gone there
    // is nobody to read them: end the session (debrief saved) instead of
    // streaming answers into nothing.
    if (state.practice.session?.isActive()) {
      void commandEndPractice().catch((error) => warn(`practice end on close failed: ${errorText(error)}`));
    }
  });
  return win;
}

/**
 * Bring the existing practice window forward. restore()+focus(), not show():
 * the practice window is never hidden, only minimized.
 */
function openPracticeWindow() {
  const existing = state.windows.practice;
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }
  state.windows.practice = createPracticeWindow();
  return state.windows.practice;
}

/**
 * One of exactly two extra answer surfaces (R1/R2/R9). Same window recipe as
 * the overlay: frameless, always-on-top, panel renderer mode. The
 * manager supplies clamped bounds and owns the closed/move listeners.
 */
function createPanelWindow(bounds) {
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 320,
    minHeight: 260,
    show: false,
    title: APP_TITLE,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: baseWebPreferences(),
  });
  // Same screen-saver level / all-workspaces shape as the overlay.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  wireWindow(win);
  win.loadFile(RENDERER_PAGE, { query: { mode: "panel" } });
  win.once("ready-to-show", () => state.presenter.show(win, { inactive: true })); // never steal focus from the call
  return win;
}

function setOverlayVisible(visible) {
  const win = state.windows.overlay;
  if (!win || win.isDestroyed()) return false;
  if (visible) state.presenter.show(win, { inactive: true }); // the call keeps focus
  else state.presenter.hide(win);
  broadcastWindowState();
  return true;
}

function toggleOverlay() {
  const win = state.windows.overlay;
  if (!win || win.isDestroyed()) return false;
  return setOverlayVisible(!win.isVisible());
}

function setClickThrough(enabled) {
  const win = state.windows.overlay;
  state.clickThrough = Boolean(enabled);
  if (win && !win.isDestroyed()) {
    // `forward: true` keeps mouse-move forwarding alive so hover UI can still
    // light up while clicks pass through to the app underneath.
    win.setIgnoreMouseEvents(state.clickThrough, { forward: true });
  }
  // Panels follow the global toggle exactly like the overlay (R6).
  panelManager?.applyClickThrough(state.clickThrough);
  broadcastWindowState();
  return state.clickThrough;
}

/* ----------------------------------------------------------------- shortcuts */

/**
 * Run an action thunk and normalise its result to an envelope, so the
 * accelerator path (result ignored) and the IPC path (result returned) share
 * one dispatcher without double-wrapping the envelopes actions already return.
 */
function envelope(run) {
  try {
    const value = run();
    if (value && typeof value === "object" && typeof value.ok === "boolean") return value;
    return okEnvelope(value === undefined ? null : value);
  } catch (error) {
    return failEnvelope(ErrorCode.HANDLER_FAILED, errorText(error));
  }
}

/** Single entry point for every shell action: accelerators and buttons converge here (R4/R5). */
function triggerShellAction(action) {
  switch (action) {
    case "answer-now":
      return envelope(() => requestAnswerFromShortcut());
    case "analyse-screen":
      // analyseScreen already returns an envelope, and the server's
      // `screen.result` frame reaches every window through the wire relay.
      return analyseScreen({ purpose: "context", origin: "manual" });
    case "toggle-click-through":
      return envelope(() => setClickThrough(!state.clickThrough));
    case "toggle-overlay":
      return envelope(() => toggleOverlay());
    case "clear-display":
      return envelope(() => clearDisplay());
    case "quit":
      return envelope(() => quitApp());
    default:
      return failEnvelope(ErrorCode.INVALID_PAYLOAD, `unknown shell action: ${String(action)}`);
  }
}

function registerShortcuts() {
  const bindings = [
    ["CommandOrControl+Shift+Space", "toggle-click-through", () => setClickThrough(!state.clickThrough)],
    ["CommandOrControl+Shift+H", "toggle-overlay", () => toggleOverlay()],
    ["CommandOrControl+Shift+A", "answer-now", () => triggerShellAction("answer-now")],
    // Global analyse trigger. Must carry modifiers: a bare key registered as an
    // OS hotkey is swallowed system-wide and breaks typing in every app.
    ["CommandOrControl+Shift+M", "analyse-screen", () => triggerShellAction("analyse-screen")],
    // Global like Answer now: the rep clears mid-call without leaving the call app.
    [CLEAR_ACCELERATOR, "clear-display", () => triggerShellAction("clear-display")],
  ];
  for (const [accelerator, action, run] of bindings) {
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, () => {
        broadcast(IPC.SHORTCUTS_TRIGGERED, { action, accelerator });
        run();
      });
    } catch (error) {
      warn(`shortcut ${accelerator} failed: ${errorText(error)}`);
    }
    if (registered) state.shortcuts.push({ accelerator, action });
  }
  // The in-app bare-key chord (m then ,) is not a global registration; list it
  // for the hints UI. The global Ctrl+Shift+M binding above is listed on its own.
  state.shortcuts.push({ accelerator: "m ,", action: "analyse-screen" });
  // In-app only (wireWindow): a global Ctrl+Q would quit this app whenever
  // the rep quit any other app.
  state.shortcuts.push({ accelerator: QUIT_ACCELERATOR, action: "quit" });
}

/**
 * Clear: every window (control, overlay, panels) drops the answer, both lanes
 * and the screen cards. The session keeps listening, and the next question
 * opens a fresh answer. The server also drops its screen context, so a
 * cleared screen never shapes a later answer.
 */
function clearDisplay() {
  state.lastUtterance = "";
  try {
    state.transport?.clearScreenContext?.();
  } catch (error) {
    warn(`screen context clear failed: ${errorText(error)}`);
  }
  broadcast(IPC.DISPLAY_CLEARED, { at: Date.now() });
}

/** Ctrl+Q and the Quit hint: a real exit, through the same audio-safe quit path as closing the app. */
function quitApp() {
  setImmediate(() => app.quit());
  return { quitting: true };
}

function requestAnswerFromShortcut() {
  const client = state.transport;
  if (!client) return;
  try {
    // Reuse the prospect's latest utterance: the whole point of the shortcut
    // is "answer what was just asked" without opening the panel.
    client.requestAnswer(state.lastUtterance || "", "manual");
  } catch (error) {
    warn(`answer shortcut ignored: ${errorText(error)}`);
  }
}

/* ------------------------------------------------------------------ transport */

async function loadTransport() {
  if (!state.transportModule) {
    state.transportModule = await optionalImport("../transport/realtime-client.js", "transport");
  }
  return state.transportModule;
}

async function loadAudio() {
  if (!state.audioModule) {
    state.audioModule = await optionalImport("../audio/index.js", "audio");
  }
  return state.audioModule;
}

async function loadVision() {
  if (!state.visionModule) {
    state.visionModule = await optionalImport("../vision/index.js", "vision");
  }
  return state.visionModule;
}

/**
 * Silero when its ONNX asset is present, energy VAD otherwise. The probe shape
 * is what `createSpeechPipeline` expects, so the shell never needs to know
 * which fallback is active.
 */
async function loadVadProbe() {
  if (state.vadProbe || !state.vadEnabled) return state.vadProbe;
  const vad = await optionalImport("../vad/index.js", "vad");
  if (!vad) return null;
  try {
    if (typeof vad.SileroVad?.create === "function") {
      const silero = await vad.SileroVad.create({});
      state.vadProbe = {
        probe: (frame, carry) => silero.process(frame, carry),
        initialState: () => new Float32Array(0),
      };
      return state.vadProbe;
    }
  } catch (error) {
    warn(`silero vad unavailable, falling back to energy: ${errorText(error)}`);
  }
  if (typeof vad.EnergyVad === "function") {
    const energy = new vad.EnergyVad();
    state.vadProbe = {
      probe: (frame, carry) => energy.process(frame, carry),
      initialState: () => new Float32Array(0),
    };
  }
  return state.vadProbe;
}

function emptySourceStatus() {
  return {
    state: "idle",
    endpointId: null,
    endpointName: null,
    level: 0,
    dropped: 0,
    discontinuities: 0,
    syntheticIdleSilence: 0,
    delivered: 0,
    sampleRate: null,
    nativeChannels: null,
    encoding: null,
    lastPacketAgeMs: null,
    error: null,
  };
}

function readShellOptions() {
  const value = globalThis.__COPILOT_SHELL_OPTIONS__;
  return value && typeof value === "object" ? value : {};
}

/**
 * Native capture uses live ASR unless COPILOT_MODE is set. Simulated and
 * file demos stay on demo so canned audio can still be labeled.
 */
export function captureEngineMode(env = process.env, backend = CAPTURE_BACKEND) {
  if (typeof env?.COPILOT_MODE === "string" && env.COPILOT_MODE.length > 0) return env.COPILOT_MODE;
  return backend === "native" ? "live" : "demo";
}

function userDataDirectory() {
  const injected = readShellOptions().userDataDir;
  if (typeof injected === "string" && injected.length > 0) return injected;
  if (typeof app.getPath === "function") {
    try {
      return app.getPath("userData");
    } catch {
      /* a test double may not implement the path */
    }
  }
  return join(tmpdir(), "mock-sales-copilot-userdata");
}

function quitStopTimeoutMs() {
  const value = readShellOptions().quitStopTimeoutMs;
  return Number.isFinite(value) && value > 0 ? value : QUIT_STOP_TIMEOUT_MS;
}

function levelThrottle() {
  if (!state.audio.levelThrottle) state.audio.levelThrottle = createLevelThrottle();
  return state.audio.levelThrottle;
}

function invalidateAudioGeneration() {
  state.audio.generation += 1;
}

function audioCapturing() {
  return state.audio.phase === "starting" || state.audio.phase === "capturing" || state.pipelines.size > 0;
}

function sourceStatusMap() {
  const out = {};
  for (const source of AUDIO_SOURCES) {
    const slot = state.audio.sources[source] ?? emptySourceStatus();
    out[source] = {
      state: slot.state,
      endpointId: slot.endpointId ?? null,
      endpointName: slot.endpointName ?? null,
      level: slot.level ?? 0,
      dropped: slot.dropped ?? 0,
      discontinuities: slot.discontinuities ?? 0,
      syntheticIdleSilence: slot.syntheticIdleSilence ?? 0,
      delivered: slot.delivered ?? 0,
      sampleRate: Number.isFinite(slot.sampleRate) ? slot.sampleRate : null,
      nativeChannels: Number.isFinite(slot.nativeChannels) ? slot.nativeChannels : null,
      encoding: typeof slot.encoding === "string" ? slot.encoding : null,
      lastPacketAgeMs: Number.isFinite(slot.lastPacketAgeMs) ? slot.lastPacketAgeMs : null,
      ...(slot.error ? { error: { code: slot.error.code, message: slot.error.message } } : {}),
    };
  }
  return out;
}

/**
 * Typed codes for the renderer. The text never includes an HRESULT, a
 * filesystem path, or the original exception text.
 */
export function mapCaptureError(error) {
  const code = String(error?.code ?? "");
  const blob = `${code} ${error?.hresult ?? ""} ${error?.name ?? ""}`.toUpperCase();
  if (/ACCESS_DENIED|E_ACCESSDENIED|0X80070005|DENIED/.test(blob)) {
    return { code: ErrorCode.AUDIO_DEVICE_DENIED, message: "Microphone access was denied." };
  }
  if (/DEVICE_INVALID|DEVICE_INVALIDATED|ENDPOINT_INVALIDATED|0X88890004|INVALID_ENDPOINT|INVALID-CHOICE|INVALID_PREFERENCE|INVALID-PREFERENCE|NOT_FOUND/.test(blob)) {
    return { code: ErrorCode.AUDIO_DEVICE_INVALID, message: "The selected audio device is not available." };
  }
  if (/UNSUPPORTED_FORMAT|0X88890008|FORMAT/.test(blob)) {
    return { code: ErrorCode.AUDIO_FORMAT, message: "The audio format is not supported." };
  }
  if (/WORKER/.test(blob)) {
    return { code: ErrorCode.AUDIO_WORKER, message: "The audio capture worker stopped." };
  }
  if (/HRESULT|0X8/.test(blob)) {
    return { code: ErrorCode.AUDIO_HRESULT, message: "Audio capture failed." };
  }
  return { code: ErrorCode.CAPTURE_UNAVAILABLE, message: "Audio capture is unavailable." };
}

/**
 * Stop one source. A rejected native stop still revokes callbacks, so a
 * stopCapture that throws never leaves them attached.
 */
export async function settleCaptureStop(entry) {
  try {
    await entry?.pipeline?.stop?.();
  } catch (error) {
    warn(`pipeline stop failed: ${mapCaptureError(error).code}`);
    return error;
  } finally {
    if (entry) entry.revoked = true;
    try {
      entry?.revoke?.();
    } catch {
      /* revoke is mandatory even when stop rejects */
    }
  }
  return null;
}

function enqueueSpeech(task) {
  const run = state.audio.speechChain.then(async () => {
    state.audio.speechDepth += 1;
    try {
      return await task();
    } finally {
      state.audio.speechDepth -= 1;
    }
  });
  state.audio.speechChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Bind the pipeline to this session's transport object. A later session
 * replaces `state.transport`; packets from this generation must not follow it.
 */
function transportSink(sessionTransport, generation) {
  return {
    sendAudio: (source, pcm16) => {
      if (generation !== state.audio.generation) return;
      const entry = state.pipelines.get(source);
      if (!entry || entry.revoked || entry.generation !== generation) return;
      noteLevel(source, pcm16);
      const slot = state.audio.sources[source];
      if (slot) slot.delivered = (slot.delivered ?? 0) + 1;
      sessionTransport?.sendAudio?.(source, pcm16);
    },
    finalizeStream: (source) => {
      if (generation !== state.audio.generation) return;
      sessionTransport?.finalizeStream?.(source);
    },
    hintStream: (source, hint) => {
      if (generation !== state.audio.generation) return;
      sessionTransport?.sendTurnHint?.(source, hint);
    },
  };
}

function noteLevel(source, pcm) {
  if (!pcm || typeof pcm.length !== "number" || pcm.length === 0) return;
  let sum = 0;
  const n = Math.min(pcm.length, 256);
  for (let i = 0; i < n; i += 1) {
    const sample = Number(pcm[i]) / 32768;
    if (!Number.isFinite(sample)) continue;
    sum += sample * sample;
  }
  const slot = state.audio.sources[source];
  if (!slot) return;
  slot.level = Math.sqrt(sum / n);
  publishAudioStatus({ level: true });
}

function publishAudioStatus({ level = false } = {}) {
  if (level && !levelThrottle().shouldEmit()) return;
  broadcast(IPC.AUDIO_STATUS_CHANGED, {
    generation: state.audio.generation,
    sources: sourceStatusMap(),
    transcription: publicTranscription(),
  });
}

function publicTranscription() {
  const value = state.audio.transcription ?? { state: "unconfigured" };
  return {
    state: value.state,
    ...(typeof value.mode === "string" ? { mode: value.mode } : {}),
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(value.stream_id !== undefined ? { stream_id: value.stream_id } : {}),
  };
}

async function ensurePreferences() {
  if (!state.audio.preferences) {
    state.audio.preferences = createAudioDevicePreferences({
      userDataDir: userDataDirectory(),
      isCapturing: audioCapturing,
      log: (event) => warn(`audio-preferences ${event?.event ?? "event"}`),
    });
  }
  return state.audio.preferences;
}

function locateNativeAddon() {
  const location = selectNativeAddonLocation({
    isPackaged: Boolean(app.isPackaged),
    resourcesPath: process.resourcesPath,
    moduleDir: __dirname,
  });
  if (!existsSync(location.addonPath) || !existsSync(location.manifestPath)) return null;
  try {
    const manifest = validateNativeManifest(JSON.parse(readFileSync(location.manifestPath, "utf8")));
    return {
      addonPath: location.addonPath,
      manifest,
      workerPath: join(__dirname, "audio-capture-worker.cjs"),
    };
  } catch (error) {
    warn(`native audio manifest refused: ${mapCaptureError(error).code}`);
    return null;
  }
}

function bindAudioHost(host) {
  if (!host || boundAudioHosts.has(host)) return;
  boundAudioHosts.add(host);
  if (typeof host.onWorkerExit === "function") {
    host.onWorkerExit((error) => {
      onWorkerFault(error);
    });
  }
  if (typeof host.onDefaultDeviceChanged === "function") {
    host.onDefaultDeviceChanged((event) => {
      onDefaultDeviceChanged(event);
    });
  }
  if (typeof host.onDeviceLoss === "function") {
    host.onDeviceLoss((event) => {
      onExplicitDeviceLost(event);
    });
  }
}
/**
 * One audio host per app run. Several callers race here at launch (the
 * control window's device list and capabilities, and auto-start); each
 * used to pass the cache check before the first finished its imports and
 * spawn its own worker. They now share the in-flight promise.
 */
function resolveNativeHost() {
  if (state.audio.sessionHost) return Promise.resolve(state.audio.sessionHost);
  if (!state.audio.hostPromise) {
    state.audio.hostPromise = createNativeHostOnce().finally(() => {
      state.audio.hostPromise = null;
    });
  }
  return state.audio.hostPromise;
}

async function createNativeHostOnce() {
  if (state.audio.sessionHost) return state.audio.sessionHost;
  const options = readShellOptions();
  if (typeof options.createNativeHost === "function") {
    state.audio.sessionHost = options.createNativeHost();
    state.audio.hostOwned = true;
    bindAudioHost(state.audio.sessionHost);
    return state.audio.sessionHost;
  }
  if (options.nativeHost) {
    state.audio.sessionHost = options.nativeHost;
    state.audio.hostOwned = false;
    bindAudioHost(state.audio.sessionHost);
    return state.audio.sessionHost;
  }
  if (CAPTURE_BACKEND !== "native") return null;
  const located = locateNativeAddon();
  if (!located) return null;
  const { createNativeAudioHost } = await import("./audio-capture-host.js");
  const electron = await import("electron");
  if (typeof electron.utilityProcess?.fork !== "function") return null;
  state.audio.sessionHost = createNativeAudioHost({
    utilityProcess: electron.utilityProcess,
    workerPath: located.workerPath,
    addonPath: located.addonPath,
    manifest: located.manifest,
    log: (event) => warn(`audio-host ${event?.type ?? "event"}`),
  });
  state.audio.hostOwned = true;
  bindAudioHost(state.audio.sessionHost);
  return state.audio.sessionHost;
}

async function choiceFor(source) {
  const prefs = await ensurePreferences();
  const snapshot = await prefs.load();
  state.audio.choices = {
    microphone: snapshot.microphone?.choice ?? null,
    system: snapshot.system?.choice ?? null,
  };
  const entry = snapshot[source];
  if (!entry || entry.invalidPreference || !entry.choice) {
    const error = new Error("saved audio selection is invalid");
    error.code = "invalid-preference";
    throw error;
  }
  return entry.choice;
}

function isHealthy(source, generation) {
  const entry = state.pipelines.get(source);
  if (!entry || entry.revoked || entry.generation !== generation) return false;
  return state.audio.sources[source]?.state === "running";
}

async function openSource({ source, audio, probe, sessionTransport, generation, nativeHost }) {
  let choice;
  if (CAPTURE_BACKEND === "native") {
    if (!nativeHost) {
      const error = new Error("native audio capture is unsupported on this platform");
      error.code = "native-unavailable";
      throw error;
    }
    choice = await choiceFor(source);
  }
  const capture = audio.createCapture({
    backend: CAPTURE_BACKEND,
    source,
    ...(choice ? { choice, generation, nativeHost } : {}),
  });
  const sink = transportSink(sessionTransport, generation);
  const pipeline = audio.createSpeechPipeline({ capture, vad: probe, sink, source, log: warn });
  let unsubscribe = null;
  let unsubscribeCounters = null;
  let unsubscribeState = null;
  const entry = {
    capture,
    pipeline,
    generation,
    sessionTransport,
    revoked: false,
    revoke: () => {
      entry.revoked = true;
      try {
        unsubscribe?.();
      } catch {
        /* listener already gone */
      }
      try {
        unsubscribeCounters?.();
      } catch {
        /* listener already gone */
      }
      try {
        unsubscribeState?.();
      } catch {
        /* listener already gone */
      }
      try {
        nativeHost?.revokeCallback?.(source);
      } catch {
        /* host revoke is best-effort */
      }
    },
  };
  if (typeof pipeline.onEvent === "function") {
    unsubscribe = pipeline.onEvent((event) => onSpeechEvent(source, event));
  }
  if (typeof capture.onChunk === "function") {
    unsubscribeCounters = capture.onChunk((chunk) => countCaptureFlags(source, chunk));
  }
  if (typeof capture.onState === "function") {
    unsubscribeState = capture.onState((event) => onCaptureState(source, event));
  }
  state.audio.sources[source] = { ...emptySourceStatus(), state: "starting" };
  try {
    await pipeline.start();
  } catch (error) {
    entry.revoke();
    throw error;
  }
  if (generation !== state.audio.generation || state.transport !== sessionTransport) {
    await settleCaptureStop(entry);
    state.audio.sources[source] = { ...emptySourceStatus(), state: "stopped" };
    return { abandoned: true };
  }
  const info = typeof capture.info === "function" ? capture.info() : {};
  state.pipelines.set(source, entry);
  state.audio.sources[source] = {
    ...emptySourceStatus(),
    state: "running",
    endpointId: info.endpointId ?? (choice?.kind === "endpoint" ? choice.id : null),
    endpointName: info.endpointName ?? null,
    sampleRate: Number.isFinite(info.sampleRate) ? info.sampleRate : null,
    nativeChannels: Number.isFinite(info.nativeChannels) ? info.nativeChannels : null,
    encoding: typeof info.encoding === "string" ? info.encoding : null,
  };
  return { started: true };
}

function onWorkerFault(error) {
  if (state.audio.quitTask) return;
  const mapped = mapCaptureError(error ?? { code: "worker-exit" });
  for (const source of AUDIO_SOURCES) {
    state.audio.sources[source] = {
      ...(state.audio.sources[source] ?? emptySourceStatus()),
      state: "failed",
      error: mapped,
    };
  }
  publishAudioStatus();
  warn(`audio-session worker-exit ${mapped.code}`);
  if (state.audio.speechDepth > 0) {
    state.audio.speechChain = state.audio.speechChain.then(() => stopSpeechBody());
    return;
  }
  void stopSpeech();
}

function onExplicitDeviceLost(event) {
  if (state.audio.quitTask) return;
  const source = event?.source;
  if (!AUDIO_SOURCES.includes(source)) return;
  const mapped = mapCaptureError({ code: event?.code || "endpoint_invalidated" });
  const previous = state.audio.sources[source] ?? emptySourceStatus();
  state.audio.sources[source] = {
    ...previous,
    state: "failed",
    endpointId: event?.endpointId ?? previous.endpointId ?? null,
    error: mapped,
  };
  publishAudioStatus();
  const entry = state.pipelines.get(source);
  if (!entry) return;
  void enqueueSpeech(async () => {
    if (state.audio.quitTask) return;
    if (state.pipelines.get(source) !== entry) return;
    state.pipelines.delete(source);
    await settleCaptureStop(entry);
    state.audio.phase = state.pipelines.size > 0 ? "capturing" : "idle";
    publishAudioStatus();
  });
}

function onDefaultDeviceChanged(event) {
  const source = event?.source;
  const role = event?.role;
  if (!AUDIO_SOURCES.includes(source)) return;
  const choice = state.audio.choices?.[source];
  // An explicit endpoint stays pinned. Only a source on this default role restarts.
  if (!choice || choice.kind !== "default" || choice.role !== role) return;
  if (!state.pipelines.has(source)) return;
  void enqueueSpeech(() => restartSourceBody(source));
}

async function restartSourceBody(source) {
  const sessionTransport = state.transport;
  if (!sessionTransport) return;
  const generation = state.audio.generation;
  const entry = state.pipelines.get(source);
  if (entry) {
    state.pipelines.delete(source);
    await settleCaptureStop(entry);
  }
  if (generation !== state.audio.generation || state.transport !== sessionTransport) return;
  const audio = await loadAudio();
  if (!audio?.createCapture) return;
  const probe = state.vadEnabled ? await loadVadProbe() : null;
  const nativeHost = CAPTURE_BACKEND === "native" ? await resolveNativeHost() : null;
  try {
    await openSource({ source, audio, probe, sessionTransport, generation, nativeHost });
  } catch (error) {
    const mapped = mapCaptureError(error);
    state.audio.sources[source] = { ...emptySourceStatus(), state: "failed", error: mapped };
    warn(`audio-session default-change ${source} ${mapped.code}`);
  }
  state.audio.phase = state.pipelines.size > 0 ? "capturing" : "idle";
  publishAudioStatus();
}

/* ----------------------------------------------------------------- say lane */

/** Bounded: the backend voices one question at a time, so the cap only guards
 * a pathological flood. */
const PENDING_SAYS_MAX = 8;

/**
 * Delivery handshake for the server's `say` lane. A say stays pending until
 * the renderer ACKs it (`coach:sayEchoed`) — covering both drop windows an
 * opening say can hit (window still mounting, delivery room not joined) —
 * and every un-acked say is re-sent at each `coach:avatarReady` join boundary
 * so a renderer reload never loses a question. Says are re-sent verbatim (same
 * say_id), so the single last DELIVERED id is a complete dedupe slate.
 */
const sayLane = {
  pending: new Map(),
  lastEchoedSayId: null,
  avatarReady: false,
  lastConversation: null,
  seq: 0,

  enqueue(data = {}) {
    const text = typeof data.text === "string" ? data.text : "";
    if (!text) return;
    const sayId = typeof data.say_id === "string" && data.say_id ? data.say_id : `say_${++this.seq}`;
    if (sayId === this.lastEchoedSayId) return; // already delivered + acked
    this.pending.set(sayId, { say_id: sayId, text });
    while (this.pending.size > PENDING_SAYS_MAX) {
      this.pending.delete(this.pending.keys().next().value); // drop-oldest
    }
    broadcast(IPC.COACH_SAY, { say_id: sayId, text });
  },

  onAvatarReady() {
    this.avatarReady = true;
    for (const say of this.pending.values()) broadcast(IPC.COACH_SAY, say);
  },

  onSayEchoed(sayId) {
    if (typeof sayId !== "string" || !sayId) return;
    this.lastEchoedSayId = sayId;
    this.pending.delete(sayId);
  },

  openConversation(handle) {
    this.lastConversation = handle;
    this.lastEchoedSayId = null;
    this.avatarReady = false;
    broadcast(IPC.COACH_CONVERSATION_RECEIVED, handle);
  },

  reset() {
    this.pending.clear();
    this.lastEchoedSayId = null;
    this.avatarReady = false;
    this.lastConversation = null;
  },
};

function handleServerFrame(raw, frame) {
  if (!frame || typeof frame.type !== "string") return;
  const data = frame.data ?? {};
  // Raw wire relay: the renderer consumes the full downlink stream
  // (turn.*, gate.verdict, ...) off the socket, as docs/protocol.md defines it.
  if (typeof raw === "string") broadcast(IPC.SPEECH_REALTIME_FRAME_RECEIVED, raw);
  switch (frame.type) {
    case "transcript":
      // Remember the PROSPECT's latest text (the question being asked) so
      // the global answer shortcut can fire without a renderer round trip.
      if (typeof data.text === "string" && data.text && (data.source === "system" || data.role === "prospect")) {
        state.lastUtterance = data.text;
      }
      broadcast(IPC.SPEECH_TRANSCRIPT_RECEIVED, data);
      // Practice segmentation runs ONLY while the user's practice session is
      // active (boundary: no question-triggered answering outside practice).
      if (state.practice.session?.isActive()) void state.practice.session.onUtterance(data);
      break;
    case "say":
      sayLane.enqueue(data);
      break;
    case "transcription.state": {
      const next = data.state ?? data.status;
      if (typeof next === "string" && next.length > 0) {
        state.audio.transcription = {
          state: next,
          ...(typeof data.mode === "string" ? { mode: data.mode } : {}),
          ...(typeof data.provider === "string" ? { provider: data.provider } : {}),
          ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
          ...(data.stream_id !== undefined ? { stream_id: data.stream_id } : {}),
        };
        publishAudioStatus();
      }
      break;
    }
    // `session.ended` needs no case: the client latches it into status
    // "ended", and handleRealtimeStatus runs the (single) teardown.
    default:
      break;
  }
}

function handleRealtimeStatus(status = {}) {
  const next = status.state ?? "unknown";
  state.status.realtime = next;
  broadcast(IPC.SPEECH_REALTIME_STATUS_CHANGED, { ...status, stats: realtimeSnapshot().stats });
  if (next === "failed") {
    broadcast(IPC.SPEECH_ERRORED, { message: "realtime connection failed", state: next });
    state.lifecycle?.send("CONNECTION_FAILED", { reason: "transport failed" });
  } else if (next === "ended") {
    // Terminal for the link: run the full local teardown (lifecycle + capture).
    void endSession("remote");
  }
}

function realtimeSnapshot() {
  let stats = null;
  try {
    stats = state.transport?.getStats?.() ?? null;
  } catch {
    stats = null;
  }
  return {
    lifecycle: state.lifecycle?.getState() ?? SESSION_STATES.IDLE,
    realtime: state.status.realtime,
    lastError: state.status.lastError,
    sessionId: state.sessionId,
    url: REALTIME_URL,
    stats,
    vad: vadStatusSnapshot(),
  };
}

/* --------------------------------------------------------------------- speech */

function startStatsTimer() {
  if (state.statsTimer !== null) return;
  state.statsTimer = setInterval(() => {
    // Change-gated at 1 Hz: status surfaces need freshness, not churn.
    const snap = vadStatusSnapshot();
    const encoded = JSON.stringify(snap);
    if (encoded !== state.lastVadStatsJson) {
      state.lastVadStatsJson = encoded;
      broadcast(IPC.SPEECH_VAD_STATS, snap);
    }
  }, SPEECH_STATS_INTERVAL_MS);
}

function stopStatsTimer() {
  if (state.statsTimer === null) return;
  clearInterval(state.statsTimer);
  state.statsTimer = null;
}

/** Aggregate gate stats across sources, in the `getVadStatus` shape. */
function vadStatusSnapshot() {
  let forwarded = 0;
  let gated = 0;
  let dropped = 0;
  let failedOpen = false;
  for (const { pipeline } of state.pipelines.values()) {
    const s = pipeline?.stats?.() ?? {};
    forwarded += s.forwarded ?? 0;
    gated += s.gated ?? 0;
    dropped += s.dropped ?? 0;
    if (s.failedOpen) failedOpen = true;
  }
  return {
    enabled: state.vadEnabled,
    active: state.pipelines.size > 0,
    failedOpen,
    forwarded,
    gated,
    dropped,
  };
}

function onSpeechEvent(source, event = {}) {
  if (event.type === "error") {
    const mapped = mapCaptureError(event.error);
    warn(`speech ${source} error: ${mapped.code}`);
    broadcast(IPC.SPEECH_ERRORED, { message: mapped.message, code: mapped.code, source });
    broadcast(IPC.SPEECH_STATUS_CHANGED, { state: state.lifecycle?.getState(), error: mapped.message, code: mapped.code, source });
    const slot = state.audio.sources[source];
    if (slot && slot.state !== "failed") {
      slot.state = "failed";
      slot.error = mapped;
      publishAudioStatus();
    }
  }
  if (event?.flags?.discontinuity || event?.discontinuity) {
    const slot = state.audio.sources[source];
    if (slot) slot.discontinuities = (slot.discontinuities ?? 0) + 1;
  }
  if (typeof event?.dropped === "number" && event.dropped > 0) {
    const slot = state.audio.sources[source];
    if (slot) slot.dropped = (slot.dropped ?? 0) + event.dropped;
  }
  // vad/audio events feed the 1 Hz change-gated snapshot; pushing a
  // frame per event would repaint status surfaces at capture rate.
}

/**
 * Flag counters for diagnostics. Discontinuity and synthetic-idle are
 * worker properties; this is the only place they are counted.
 */
function countCaptureFlags(source, chunk) {
  const slot = state.audio.sources[source];
  if (!slot || !chunk?.flags) return;
  if (chunk.flags.discontinuity) slot.discontinuities = (slot.discontinuities ?? 0) + 1;
  if (chunk.flags.syntheticIdleSilence) {
    slot.syntheticIdleSilence = (slot.syntheticIdleSilence ?? 0) + 1;
  }
}

/**
 * Native source state. Health events carry the capture-time age of the last
 * packet so a quiet source stays visibly alive before its first packet.
 */
function onCaptureState(source, event = {}) {
  const slot = state.audio.sources[source];
  if (!slot || event.type !== "health") return;
  if (Number.isFinite(event.lastPacketAgeMs)) slot.lastPacketAgeMs = event.lastPacketAgeMs;
}

async function startSpeech() {
  return enqueueSpeech(() => startSpeechBody());
}

async function startSpeechBody() {
  if (!state.transport) {
    return failEnvelope(ErrorCode.NOT_ACTIVE, "no realtime session is open");
  }
  // The sink closes over this object, not the mutable `state.transport` slot.
  const sessionTransport = state.transport;
  const generation = state.audio.generation;
  state.audio.phase = "starting";
  const audio = await loadAudio();
  if (!audio?.createCapture || !audio?.createSpeechPipeline) {
    state.audio.phase = state.pipelines.size > 0 ? "capturing" : "idle";
    return failEnvelope(ErrorCode.MODULE_UNAVAILABLE, "audio module unavailable; transcript stays server-side");
  }
  const probe = state.vadEnabled ? await loadVadProbe() : null;
  const nativeHost = CAPTURE_BACKEND === "native" ? await resolveNativeHost() : null;
  const started = [];
  const failed = [];
  for (const source of AUDIO_SOURCES) {
    if (generation !== state.audio.generation || state.transport !== sessionTransport) break;
    if (isHealthy(source, generation)) continue;
    try {
      const opened = await openSource({ source, audio, probe, sessionTransport, generation, nativeHost });
      if (opened?.started) started.push(source);
    } catch (error) {
      // One failed device must not abort the other stream.
      const mapped = mapCaptureError(error);
      warn(`capture "${source}" unavailable: ${mapped.code}`);
      broadcast(IPC.SPEECH_ERRORED, { message: mapped.message, code: mapped.code, source });
      failed.push({ source, code: mapped.code, message: mapped.message });
      state.audio.sources[source] = { ...emptySourceStatus(), state: "failed", error: mapped };
    }
  }
  const running = [...state.pipelines.keys()];
  state.audio.phase = running.length > 0 ? "capturing" : "idle";
  publishAudioStatus();
  if (running.length === 0) {
    return failEnvelope(
      ErrorCode.CAPTURE_UNAVAILABLE,
      `audio capture unavailable (backend "${CAPTURE_BACKEND}")`,
      { backend: CAPTURE_BACKEND, failed, started, sources: running, status: sourceStatusMap() },
    );
  }
  startStatsTimer();
  return okEnvelope({
    sources: running,
    started,
    failed,
    status: sourceStatusMap(),
    generation,
  });
}

async function stopSpeech() {
  return enqueueSpeech(() => stopSpeechBody());
}

async function stopSpeechBody() {
  invalidateAudioGeneration();
  stopStatsTimer();
  const entries = [...state.pipelines.entries()];
  state.pipelines.clear();
  state.audio.phase = "idle";
  await Promise.all(entries.map(async ([source, entry]) => {
    await settleCaptureStop(entry);
    const slot = state.audio.sources[source] ?? emptySourceStatus();
    // The worker's overload counter arrives only with the stop result.
    let dropped = slot.dropped ?? 0;
    try {
      const info = typeof entry.capture?.info === "function" ? entry.capture.info() : null;
      if (Number.isFinite(info?.droppedSamples)) dropped += info.droppedSamples;
    } catch {
      /* counters are best-effort */
    }
    state.audio.sources[source] = { ...slot, state: "stopped", dropped };
    return null; // side-effecting settle; Promise.all awaits every entry
  }));
  if (state.audio.hostOwned && state.audio.sessionHost) {
    const host = state.audio.sessionHost;
    state.audio.sessionHost = null;
    try {
      await host.close?.();
    } catch (error) {
      warn(`audio-host close failed: ${mapCaptureError(error).code}`);
    }
  }
  broadcast(IPC.SPEECH_VAD_STATS, vadStatusSnapshot());
  publishAudioStatus();
  return okEnvelope({
    stopped: entries.length,
    forcedCleanup: Boolean(state.audio.forcedCleanup),
  });
}

function revokePipelineCallbacks() {
  for (const entry of state.pipelines.values()) {
    entry.revoked = true;
    try {
      entry.revoke?.();
    } catch {
      /* already revoked */
    }
  }
  try {
    state.audio.sessionHost?.revokeAll?.();
  } catch {
    /* host may already be gone */
  }
}

function onBeforeQuit(event) {
  if (state.audio.quitSettled) return;
  if (event && typeof event.preventDefault === "function") event.preventDefault();
  if (state.audio.quitTask) return;
  state.audio.quitTask = (async () => {
    invalidateAudioGeneration();
    const stop = stopSpeech();
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), quitStopTimeoutMs());
    });
    const outcome = await Promise.race([stop.then(() => "stopped", () => "stopped"), timeout]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") {
      try {
        state.audio.sessionHost?.terminate?.();
      } catch {
        /* already gone */
      }
      revokePipelineCallbacks();
      state.audio.forcedCleanup = true;
      state.audio.lastCleanup = { forcedCleanup: true };
      warn("audio-session forced-cleanup");
    } else {
      state.audio.lastCleanup = { forcedCleanup: false };
    }
    state.audio.quitSettled = true;
    state.audio.phase = "idle";
    publishAudioStatus();
    try {
      app.quit();
    } catch {
      /* shutdown already started */
    }
  })();
}

/* -------------------------------------------------------------------- session */

/**
 * Electron 33's main process runs Node 20, which has no global WebSocket, so
 * the client gets an explicit `ws` factory (the transport also falls back to
 * `ws` on its own; being explicit keeps the shell independent of that).
 */
async function socketFactory() {
  const ws = await optionalImport("ws", "ws");
  const Ctor = ws?.WebSocket ?? ws?.default;
  return typeof Ctor === "function" ? (target) => new Ctor(target, upgradeOptions()) : undefined;
}

/**
 * The embedded server authenticates at the WebSocket handshake, so a socket
 * without the per-launch secret never exists (no lockout by idle sockets).
 * Sent as a header: never in the URL, never logged. The hello frame still
 * carries it too (defence in depth). External servers are unchanged.
 */
function upgradeOptions() {
  if (!state.embeddedServer || !state.credential) return undefined;
  return { headers: { authorization: `Bearer ${state.credential}` } };
}

function constantTimeEqual(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Off-main-thread screenshots (screen-grabber.js): one hidden renderer holds
 * a low-rate display stream per session, so a screenshot no longer blocks
 * this process (VAD, uplink, token relay) for ~350 ms (1.9 s the first time).
 * Opened at session start so the first screenshot is fast too.
 * SCREEN_GRABBER=0 keeps the thumbnail path only.
 */
function startScreenGrabber() {
  if (process.env.SCREEN_GRABBER === "0" || state.vision.grabber) return;
  try {
    state.vision.grabber = createScreenGrabber({
      BrowserWindow,
      desktopCapturer,
      session: electronSession,
      app,
      pagePath: join(__dirname, "capture", "capture.html"),
      log: warn,
    });
    void state.vision.grabber.warm();
  } catch (error) {
    warn(`screen grabber unavailable: ${errorText(error)}`);
    state.vision.grabber = null;
  }
}

function closeScreenGrabber() {
  try {
    state.vision.grabber?.close();
  } catch {
    /* already closed */
  }
  state.vision.grabber = null;
}

function closeAnalyser() {
  try {
    state.vision.analyser?.close?.();
  } catch {
    /* already closed */
  }
  state.vision.analyser = null;
  state.vision.analyserTransport = null;
}

async function startSession(payload = {}) {
  // The endpoint and the credential are main-process configuration. A
  // renderer that could pick them could ship the call audio (and the token)
  // to any server, so supplying either is a validation error.
  if (payload && typeof payload === "object" && ("url" in payload || "jwt" in payload)) {
    return failEnvelope(ErrorCode.INVALID_PAYLOAD, "session:start does not accept url or jwt from the renderer");
  }
  const current = state.lifecycle.getState();
  if (current === SESSION_STATES.ACTIVE || current === SESSION_STATES.LAUNCHING) {
    return okEnvelope({ state: current, already: true, sessionId: state.sessionId });
  }
  // Call audio, transcripts and the credential never cross a plaintext hop.
  if (state.realtimeUrlError) {
    return failEnvelope(ErrorCode.SESSION_START, state.realtimeUrlError);
  }
  if (!state.lifecycle.send("START").ok) {
    return failEnvelope(ErrorCode.SESSION_STATE, `cannot start a session from ${current}`);
  }
  const sessionId = SESSION_ID || `session-${randomUUID()}`;
  const url = REALTIME_URL;
  const transportModule = await loadTransport();
  if (!transportModule?.RealtimeClient) {
    const message = "transport module unavailable; start the realtime server first";
    state.status.lastError = message;
    state.lifecycle.send("LAUNCH_FAILED", { reason: message });
    return failEnvelope(ErrorCode.MODULE_UNAVAILABLE, message);
  }
  let client = null;
  try {
    const createSocket = await socketFactory();
    client = new transportModule.RealtimeClient({ baseUrl: url, ...(createSocket && { createSocket }) });
    if (typeof client.onFrame === "function") state.unsubscribers.push(client.onFrame(handleServerFrame));
    if (typeof client.onStatus === "function") state.unsubscribers.push(client.onStatus(handleRealtimeStatus));
    await client.start({ sessionId, jwt: state.credential, topology: "general", captureAuthorized: true, context: sessionContext() });
    state.transport = client;
    // start() captured the document before the link opened, and grounding:load
    // only reaches a session once state.transport is set: a load or clear in
    // between must still reach this session.
    const latest = sessionContext();
    const held = client.session?.context ?? null;
    if ((held?.docs ?? "") !== (latest?.docs ?? "") || (held?.name ?? "") !== (latest?.name ?? "")) {
      client.setSessionContext?.(latest);
    }
    state.sessionId = sessionId;
    state.status.lastError = null;
    state.lifecycle.send("LAUNCHED");
    startScreenGrabber();
    // Speech failure keeps the session (transcripts can still arrive from
    // the server side, screen analysis works) but is reported as the coded
    // envelope it is, so the UI can show it instead of a silent success.
    const speech = await startSpeech();
    return okEnvelope({ sessionId, url, speech });
  } catch (error) {
    for (const unsubscribe of state.unsubscribers.splice(0)) {
      try {
        unsubscribe?.();
      } catch {
        /* listener already gone */
      }
    }
    try {
      client?.stop?.();
    } catch {
      /* never connected */
    }
    const message = `session start failed: ${errorText(error)}`;
    state.status.lastError = message;
    state.lifecycle.send("LAUNCH_FAILED", { reason: message, error });
    return failEnvelope(ErrorCode.SESSION_START, message);
  }
}

/**
 * Idempotent: a remote end can arrive through more than one path (status
 * "ended", app quit, the user), and teardown must run exactly once.
 */
function endSession(reason = "user") {
  if (state.endingPromise) return state.endingPromise;
  const lifecycle = state.lifecycle;
  const current = lifecycle.getState();
  if (current === SESSION_STATES.ENDED || current === SESSION_STATES.IDLE) {
    return Promise.resolve(okEnvelope({ state: current, already: true }));
  }
  // Drop in-flight captures before stop runs, so a late start cannot attach.
  invalidateAudioGeneration();
  state.endingPromise = (async () => {
    lifecycle.send("END", { reason });
    await stopSpeech();
    for (const unsubscribe of state.unsubscribers.splice(0)) {
      try {
        unsubscribe?.();
      } catch {
        /* listener already gone */
      }
    }
    closeAnalyser();
    closeScreenGrabber();
    const client = state.transport;
    state.transport = null;
    state.sessionId = null;
    try {
      client?.stop?.();
    } catch (error) {
      warn(`transport stop failed: ${errorText(error)}`);
    }
    if (lifecycle.getState() === SESSION_STATES.ENDING) lifecycle.send("ENDED");
    return okEnvelope({ state: lifecycle.getState() });
  })().finally(() => {
    state.endingPromise = null;
  });
  return state.endingPromise;
}

/* ----------------------------------------------------------------------- vision */

/**
 * The screen the user is working on: the display under the cursor (the focus
 * proxy at press time), then the focused window's display, then primary.
 * Deliberately ignores the overlay's position (R: analyse always picks the
 * screen in focus).
 */
function resolveFocusDisplay() {
  try {
    const point = screen.getCursorScreenPoint?.();
    if (point) return screen.getDisplayNearestPoint(point);
  } catch {
    /* fall through */
  }
  const focused = BrowserWindow.getFocusedWindow?.();
  if (focused && !focused.isDestroyed()) return screen.getDisplayMatching(focused.getBounds());
  return screen.getPrimaryDisplay();
}

/**
 * Every capture path (button, Ctrl+Shift+M, the m-, chord) lands here, so
 * this is where every window learns, the instant a capture starts, that a
 * screen is being read, and again when the reading is back. A counter keeps
 * overlapping captures busy until the last one lands.
 */
let screenAnalysesInFlight = 0;

async function analyseScreen(payload = {}) {
  screenAnalysesInFlight += 1;
  broadcast(IPC.SCREEN_ANALYSIS_STATE, { busy: true, at: Date.now() });
  try {
    return await analyseScreenBody(payload);
  } finally {
    screenAnalysesInFlight -= 1;
    if (screenAnalysesInFlight === 0) broadcast(IPC.SCREEN_ANALYSIS_STATE, { busy: false, at: Date.now() });
  }
}

async function analyseScreenBody(payload = {}) {
  const vision = await loadVision();
  if (!vision?.ScreenCapture || !vision?.ScreenAnalyser) {
    return failEnvelope(ErrorCode.MODULE_UNAVAILABLE, "vision module unavailable");
  }
  if (!state.transport) {
    return failEnvelope(ErrorCode.NOT_ACTIVE, "start a session before analysing the screen");
  }
  try {
    state.vision.capture ??= new vision.ScreenCapture({ desktopCapturer });
    // One analyser per session link: a cached analyser would keep the
    // previous session's (stopped) transport and subscriptions.
    if (!state.vision.analyser || state.vision.analyserTransport !== state.transport) {
      closeAnalyser();
      state.vision.analyser = new vision.ScreenAnalyser({
        transport: state.transport,
        // Control-plane mint + signed PUT against the same server
        // (protocol.md upload contract). The token stays in this process.
        http:
          typeof vision.createHttpClient === "function"
            ? vision.createHttpClient({ baseUrl: REALTIME_URL, getToken: () => state.credential })
            : null,
        sessionIdProvider: () => state.sessionId,
        log: warn,
      });
      state.vision.analyserTransport = state.transport;
    }
    // Off-main-thread grab first; the thumbnail path is the fallback.
    // The screen the user is working on (focus display), never the overlay's.
    const display = resolveFocusDisplay();
    // The overlay would otherwise appear in its own screenshot.
    const shot = await withAppWindowsHidden(
      [state.windows.overlay, ...state.windows.panels].filter(Boolean),
      async () =>
        (await state.vision.grabber?.capture({ display })) ??
        (await state.vision.capture.capture({ display })),
    );
    if (!shot) return failEnvelope(ErrorCode.CAPTURE_EMPTY, "screen capture returned no frame");
    const result = await state.vision.analyser.analyse({
      bytes: shot.bytes,
      contentType: shot.contentType,
      purpose: payload.purpose ?? "context",
      origin: payload.origin ?? "manual",
    });
    // The command reply IS the result (a typed `failure` tag included); the
    // raw `screen.result` frame also reaches every window via the wire relay.
    return okEnvelope({ ...(result ?? {}), width: shot.width, height: shot.height });
  } catch (error) {
    return failEnvelope(ErrorCode.SCREEN_ANALYSE, errorText(error));
  }
}

/* ------------------------------------------------------------------------- IPC */

function configSnapshot() {
  return {
    realtimeUrl: REALTIME_URL,
    sessionId: state.sessionId,
    hasJwt: Boolean(state.credential), // never ship the token itself into the renderer
    captureBackend: CAPTURE_BACKEND,
    engineMode: state.engineMode ?? captureEngineMode(process.env, CAPTURE_BACKEND),
    vadEnabled: state.vadEnabled,
    clickThrough: state.clickThrough,
    versions: { electron: process.versions.electron ?? null, node: process.versions.node ?? null },
  };
}

/* --------------------------------------------- grounding + app settings */

/** The realtime client's view of the document, or null. */
function sessionContext() {
  const doc = state.grounding.document;
  return doc ? { docs: doc.text, name: doc.name } : null;
}

/** Push the current document into a live session. True when a session holds it now. */
function applyGroundingToSession() {
  const client = state.transport;
  if (!client || typeof client.setSessionContext !== "function") return false;
  client.setSessionContext(sessionContext());
  return true;
}

async function loadDesktopSettings() {
  const userDataDir = userDataDirectory();
  try {
    state.grounding.store = createGroundingDocumentStore({ userDataDir });
    const loaded = await state.grounding.store.load();
    state.grounding.document = loaded.document;
    state.grounding.readError = loaded.readError;
  } catch (error) {
    warn(`grounding load failed: ${errorText(error)}`);
    state.grounding.readError = STORED_DOCUMENT_UNREADABLE;
  }
  try {
    state.appPreferences = createAppPreferences({ userDataDir });
    state.settings = await state.appPreferences.load();
  } catch (error) {
    warn(`settings load failed: ${errorText(error)}`);
    state.settings = { autoStart: false, answerModel: "", windowOpacity: WINDOW_OPACITY.default, readError: SETTINGS_UNREADABLE };
  }
  state.practice.materialStore = createPracticeMaterialStore({ userDataDir });
  const loadedMaterial = await state.practice.materialStore.load();
  state.practice.material = loadedMaterial.material;
  state.practice.materialReadError = loadedMaterial.readError;
  state.practice.debriefStore = createPracticeDebriefStore({ userDataDir });
  const loadedDebrief = await state.practice.debriefStore.load();
  state.practice.debrief = loadedDebrief.debrief;
  state.practice.debriefReadError = loadedDebrief.readError;
  // Seeded once; the user's edits are read again for every answer.
  const seeded = await ensureAnswerInstructionsFile(answerInstructionsPath());
  if (seeded.error) warn(`answer instructions not created (${seeded.error})`);
  console.log(`[app] answer instructions: ${answerInstructionsPath()}`);
  // Created empty once; the glossary reads it again for every request.
  const knownTerms = await ensureKnownTermsFile(knownTermsPath());
  if (knownTerms.error) warn(`known terms file not created (${knownTerms.error})`);
}

/** The user-editable prompt file, next to app-preferences.json. */
function answerInstructionsPath() {
  return join(userDataDirectory(), ANSWER_INSTRUCTIONS_FILENAME);
}

/** Terms the rep already knows (never explained), next to app-preferences.json. */
function knownTermsPath() {
  return join(userDataDirectory(), KNOWN_TERMS_FILENAME);
}

function queryGrounding() {
  return { document: documentMetadata(state.grounding.document), readError: state.grounding.readError };
}

async function commandLoadGrounding() {
  if (!state.grounding.store) return failEnvelope("E_DOC_UNREADABLE", "Couldn't read this file.");
  // The payload is ignored on purpose: the path comes only from the picker.
  const options = {
    title: "Load grounding document",
    properties: ["openFile"],
    filters: [{ name: "Text", extensions: ["md", "markdown", "txt"] }],
  };
  const parent = state.windows.main && !state.windows.main.isDestroyed() ? state.windows.main : null;
  let picked;
  try {
    picked = await dialog.showOpenDialog(...(parent ? [parent, options] : [options]));
  } catch (error) {
    return failEnvelope("E_DOC_UNREADABLE", `Couldn't open the file picker (${errorText(error)}).`);
  }
  if (picked?.canceled || !Array.isArray(picked?.filePaths) || picked.filePaths.length === 0) {
    return okEnvelope({ cancelled: true, document: documentMetadata(state.grounding.document) });
  }
  try {
    const doc = await state.grounding.store.importFile(picked.filePaths[0]);
    state.grounding.document = doc;
    state.grounding.readError = null;
    const applied = applyGroundingToSession();
    return okEnvelope({ cancelled: false, document: documentMetadata(doc), applied });
  } catch (error) {
    return failEnvelope(error?.code ?? "E_DOC_UNREADABLE", error?.message ?? "Couldn't read this file.");
  }
}

async function commandClearGrounding() {
  try {
    await state.grounding.store?.clear();
  } catch (error) {
    return failEnvelope(error?.code ?? "E_DOC_SAVE", error?.message ?? "Couldn't remove the saved document.");
  }
  const had = Boolean(state.grounding.document);
  state.grounding.document = null;
  state.grounding.readError = null;
  if (had) applyGroundingToSession();
  return okEnvelope({ document: null });
}

/**
 * "Open settings folder": shows the data folder (data-dir.js) in the file
 * manager so the rep can edit answer-instructions.txt. shell.openPath resolves
 * with "" on success and with an error message otherwise.
 */
async function commandOpenSettingsFolder() {
  const dir = userDataDirectory();
  let problem;
  try {
    problem = await shell.openPath(dir);
  } catch (error) {
    problem = errorText(error);
  }
  if (typeof problem === "string" && problem.length > 0) {
    return failEnvelope(ErrorCode.OPEN_FOLDER, `Couldn't open the settings folder: ${problem}`);
  }
  return okEnvelope({ opened: true, path: dir });
}

/**
 * "Known terms…": opens known-terms.txt in the default editor, creating it
 * empty first when the rep deleted it. shell.openPath resolves with "" on
 * success and with an error message otherwise.
 */
async function commandOpenKnownTerms() {
  const file = knownTermsPath();
  await ensureKnownTermsFile(file);
  let problem;
  try {
    problem = await shell.openPath(file);
  } catch (error) {
    problem = errorText(error);
  }
  if (typeof problem === "string" && problem.length > 0) {
    return failEnvelope(ErrorCode.OPEN_FILE, `Couldn't open the known-terms file: ${problem}`);
  }
  return okEnvelope({ opened: true, path: file });
}

function querySettings() {
  return {
    autoStart: state.settings.autoStart,
    // Always a listed choice: what the next answer uses (answer-models.js).
    answerModel: normalizeAnswerModel(state.settings.answerModel || process.env.ANSWER_MODEL),
    answerInstructionsPath: answerInstructionsPath(),
    // A DeepSeek choice needs this key (read from the user environment at launch).
    deepseekAvailable: typeof process.env.DEEPSEEK_API_KEY === "string" && process.env.DEEPSEEK_API_KEY.length > 0,
    // The Qwen choice, and the fallback without a DeepSeek key, need this one.
    cerebrasAvailable: typeof process.env.CEREBRAS_API_KEY === "string" && process.env.CEREBRAS_API_KEY.length > 0,
    windowOpacity: currentWindowOpacity(),
    repContext: currentRepContext(),
    highlights: currentHighlights(),
    answerCards: currentAnswerCards(),
    // Terms needs DEEPSEEK_API_KEY (deepseekAvailable); the Settings note says so.
    glossary: currentGlossary(),
    knownTermsPath: knownTermsPath(),
    readError: state.settings.readError,
  };
}

async function commandSetSettings(payload) {
  let update;
  try {
    update = validateSettingsUpdate(payload);
  } catch (error) {
    return failEnvelope(ErrorCode.INVALID_PAYLOAD, error?.message ?? "settings:set takes exactly { autoStart: boolean }.");
  }
  if (!state.appPreferences) return failEnvelope("E_SETTINGS_SAVE", "Couldn't save the setting.");
  try {
    state.settings = await state.appPreferences.save(update);
  } catch (error) {
    warn(`settings save failed: ${errorText(error)}`);
    return failEnvelope("E_SETTINGS_SAVE", "Couldn't save the setting.");
  }
  return okEnvelope(querySettings());
}

/* ------------------------------------------------------------------ practice */

function practiceSnapshot() {
  const session = state.practice.session;
  const record = session?.record() ?? null;
  return session && record
    ? {
        active: session.isActive(),
        startedAt: record.startedAt,
        questions: record.questions.length,
        skipped: record.skipped.length,
      }
    : null;
}

function queryPractice() {
  const debrief = state.practice.debrief;
  return {
    material: state.practice.material,
    materialReadError: state.practice.materialReadError,
    session: practiceSnapshot(),
    debrief: debrief
      ? { savedAt: debrief.savedAt, title: debrief.title, text: debrief.text, stats: debrief.stats }
      : null,
    debriefReadError: state.practice.debriefReadError,
  };
}

async function commandSetPracticeMaterial(payload = {}) {
  try {
    state.practice.material = await state.practice.materialStore.save({
      problemStatement: payload?.problemStatement,
    });
    state.practice.materialReadError = null;
    return okEnvelope({ material: state.practice.material });
  } catch (error) {
    const code = error?.code ?? "E_PRACTICE_SAVE";
    return failEnvelope(code, errorText(error));
  }
}

async function commandStartPractice() {
  if (state.practice.session?.isActive()) {
    return failEnvelope("E_PRACTICE_ACTIVE", "a practice session is already running");
  }
  const material = state.practice.material;
  if (!material?.problemStatement) {
    return failEnvelope("E_PRACTICE_NO_MATERIAL", "Paste a problem statement first.");
  }
  if (state.lifecycle.getState() !== "active") {
    const started = await startSession({});
    if (!started || started.ok === false) return started ?? failEnvelope(ErrorCode.SESSION_START, "couldn't start listening");
  }
  const engine = await ensurePracticeEngine();
  const doc = state.grounding.document;
  state.practice.session = createPracticeSession({
    material: {
      problemStatement: material.problemStatement,
      docsName: doc?.name ?? null,
      docsText: doc?.text ?? "",
    },
    segmenter: engine.segmenter,
    streamAnswer: (args) => engine.answerer.streamAnswer(practiceAnswerArgs(args)),
    onEvent: sendToPractice,
  });
  state.practice.session.start();
  return okEnvelope({ startedAt: state.practice.session.record().startedAt });
}

async function commandEndPractice() {
  const session = state.practice.session;
  if (!session?.isActive()) return failEnvelope("E_PRACTICE_NOT_ACTIVE", "no practice session is running");
  const debrief = buildDebrief(session.end());
  debrief.text = formatDebrief(debrief);
  let saveError = null;
  try {
    debrief.savedAt = (await state.practice.debriefStore.save(debrief)).savedAt;
    state.practice.debriefReadError = null;
  } catch (error) {
    saveError = errorText(error);
    warn(`practice debrief save failed: ${saveError}`);
  }
  state.practice.debrief = debrief;
  const payload = { savedAt: debrief.savedAt, title: debrief.title, text: debrief.text, stats: debrief.stats };
  sendToPractice({ type: "ended", debrief: payload, ...(saveError ? { saveError } : {}) });
  return okEnvelope({ debrief: payload, ...(saveError ? { saveError } : {}) });
}

/**
 * Listen as soon as the app opens. Runs once at boot, after the windows exist
 * and protection is enforced, through the same startSession() path as the
 * Start button. A failure is reported like a failed Start (lastError plus
 * lifecycle FAILED) and is never retried.
 */
async function runAutoStart() {
  const decision = autoStartDecision({
    env: process.env,
    preferences: state.settings,
    realtimeUrlError: state.realtimeUrlError,
  });
  if (!decision.start) {
    if (decision.reason !== "disabled") warn(`auto-start skipped: ${decision.reason}`);
    return decision;
  }
  try {
    const result = await startSession({});
    if (!result?.ok) warn(`auto-start failed: ${result?.error?.message ?? "unknown error"}`);
    return result;
  } catch (error) {
    warn(`auto-start failed: ${errorText(error)}`);
    return null;
  }
}

function registerIpcRoutes() {
  const queries = {
    [IPC.CONFIG_GET]: () => configSnapshot(),
    [IPC.SPEECH_GET_VAD_ENABLED]: () => ({ enabled: state.vadEnabled }),
    [IPC.SPEECH_GET_REALTIME_STATUS]: () => realtimeSnapshot(),
    [IPC.SHORTCUTS_LIST]: () => ({ bindings: state.shortcuts.map(({ accelerator, action }) => ({ accelerator, action })) }),
    [IPC.WINDOW_GET_STATE]: () => windowState(),
    [IPC.COACH_GET_CURRENT_CONVERSATION]: () => sayLane.lastConversation,
    [IPC.AUDIO_LIST_DEVICES]: (payload) => queryListDevices(payload),
    [IPC.AUDIO_GET_CAPABILITIES]: () => queryCapabilities(),
    [IPC.AUDIO_GET_STATUS]: () => queryAudioStatus(),
    [IPC.GROUNDING_GET]: () => queryGrounding(),
    [IPC.SETTINGS_GET]: () => querySettings(),
    [IPC.PRACTICE_GET]: () => queryPractice(),
  };
  const commands = {
    [IPC.SPEECH_START]: () => startSpeech(),
    [IPC.SPEECH_STOP]: () => stopSpeech(),
    [IPC.SPEECH_RECONNECT]: async () => {
      if (!state.transport) return failEnvelope(ErrorCode.NOT_ACTIVE, "no realtime session is open");
      await state.transport.reconnect();
      return okEnvelope({ state: state.lifecycle.getState() });
    },
    [IPC.SPEECH_DISCONNECT]: async () => {
      if (!state.transport) return failEnvelope(ErrorCode.NOT_ACTIVE, "no realtime session is open");
      await stopSpeech();
      state.transport.disconnect(); // server keeps the session alive for reconnect
      broadcast(IPC.SPEECH_REALTIME_STATUS_CHANGED, { state: "disconnected" });
      return okEnvelope({ state: "disconnected" });
    },
    [IPC.SPEECH_REQUEST_ANSWER]: (payload = {}) => {
      if (!state.transport) return failEnvelope(ErrorCode.NOT_ACTIVE, "no realtime session is open");
      const utterance = String(payload?.utterance ?? "").trim();
      if (!utterance) return failEnvelope(ErrorCode.INVALID_PAYLOAD, "nothing to answer yet");
      state.transport.requestAnswer(utterance, payload?.intent ?? "manual", payload?.gateSeq);
      return okEnvelope({ requested: true });
    },
    [IPC.SPEECH_SET_VAD_ENABLED]: async (payload = {}) => {
      state.vadEnabled = Boolean(payload?.enabled);
      if (!state.vadEnabled) state.vadProbe = null;
      // Restarting the pipelines is the only way to swap the probe; a live VAD
      // toggle is rare enough that a short capture gap is acceptable.
      if (state.pipelines.size > 0) {
        await stopSpeech();
        const restarted = await startSpeech();
        if (!restarted.ok) return restarted;
      }
      broadcast(IPC.SPEECH_STATUS_CHANGED, { vadEnabled: state.vadEnabled });
      return okEnvelope({ enabled: state.vadEnabled });
    },
    [IPC.SCREEN_ANALYSE]: (payload = {}) => analyseScreen(payload),
    [IPC.COACH_AVATAR_READY]: (payload = {}) => {
      sayLane.onAvatarReady(payload);
      return okEnvelope({ pending: sayLane.pending.size });
    },
    [IPC.COACH_SAY_ECHOED]: (payload = {}) => {
      sayLane.onSayEchoed(payload?.say_id);
      return okEnvelope({ lastEchoedSayId: sayLane.lastEchoedSayId });
    },
    [IPC.SESSION_START]: (payload = {}) => startSession(payload),
    [IPC.SESSION_END]: () => endSession("user"),
    [IPC.SESSION_CAPTURE_FULLSCREEN]: (payload = {}) => analyseScreen({ ...payload, purpose: payload.purpose ?? "fullscreen" }),
    [IPC.WINDOW_SHOW]: () => okEnvelope({ visible: setOverlayVisible(true) }),
    [IPC.WINDOW_HIDE]: () => okEnvelope({ visible: !setOverlayVisible(false) }),
    [IPC.WINDOW_TOGGLE]: () => okEnvelope({ visible: toggleOverlay() }),
    [IPC.WINDOW_SET_CLICK_THROUGH]: (payload = {}) => okEnvelope({ clickThrough: setClickThrough(payload?.enabled) }),
    [IPC.WINDOW_SET_OPACITY]: (payload) => commandSetWindowOpacity(payload),
    [IPC.AUDIO_SET_DEVICE]: (payload) => commandSetDevice(payload),
    [IPC.AUDIO_EXPORT_DIAGNOSTICS]: (payload) => commandExportDiagnostics(payload),
    [IPC.GROUNDING_LOAD]: () => commandLoadGrounding(),
    [IPC.GROUNDING_CLEAR]: () => commandClearGrounding(),
    [IPC.SETTINGS_SET]: (payload) => commandSetSettings(payload),
    [IPC.SETTINGS_OPEN_FOLDER]: () => commandOpenSettingsFolder(),
    [IPC.SETTINGS_OPEN_KNOWN_TERMS]: () => commandOpenKnownTerms(),
    [IPC.PRACTICE_SET_MATERIAL]: (payload = {}) => commandSetPracticeMaterial(payload),
    [IPC.PRACTICE_START]: () => commandStartPractice(),
    [IPC.PRACTICE_END]: () => commandEndPractice(),
    [IPC.PRACTICE_OPEN]: () => okEnvelope({ opened: Boolean(openPracticeWindow()) }),
  };

  // Only the app's own top-level page may call in: a navigated window, a
  // subframe or the capture page gets E_FORBIDDEN_SENDER (web-hardening.js).
  // The practice page is trusted for the practice channels it uses and no
  // others: it can never reach session or shell commands.
  const practiceChannels = new Set([IPC.PRACTICE_GET, IPC.PRACTICE_SET_MATERIAL, IPC.PRACTICE_START, IPC.PRACTICE_END]);
  const guard = (fn, channel) =>
    guardIpcHandler(fn, {
      rendererDir: RENDERER_DIR,
      ...(practiceChannels.has(channel) ? { trustedPages: PRACTICE_SENDER_PAGES } : {}),
      log: (entry) => warn(`ipc refused: ${entry.type}`),
    });
  for (const [channel, handler] of Object.entries(queries)) {
    state.gateway.registerQuery(channel, handler);
    ipcMain.handle(channel, guard((event, payload) => state.gateway.handleQuery(channel, payload, { senderId: event.sender.id }), channel));
  }
  for (const [channel, handler] of Object.entries(commands)) {
    state.gateway.registerCommand(channel, handler);
    ipcMain.handle(channel, guard((event, payload) => state.gateway.handleCommand(channel, payload, { senderId: event.sender.id }), channel));
  }

  // Multi-answer panels (R1/R9): the manager is the single feature state
  // machine, so this handler computes, applies and broadcasts in one place.
  ipcMain.handle(
    IPC.PANELS_SET,
    guard((_event, payload = {}) => {
      if (!payload || typeof payload !== "object" || typeof payload.enabled !== "boolean") {
        return failEnvelope(ErrorCode.INVALID_PAYLOAD, "panels:set needs {enabled: boolean}");
      }
      const manager = ensurePanelManager();
      const result = manager.ensurePanels(payload.enabled);
      manager.applyClickThrough(state.clickThrough);
      broadcast(IPC.PANELS_CHANGED, result);
      return okEnvelope(result);
    }),
  );

  // Buttons and accelerators share exactly one action dispatcher (R4/R5).
  ipcMain.handle(
    IPC.SHELL_ACTION,
    guard((_event, payload = {}) =>
      triggerShellAction(payload && typeof payload.action === "string" ? payload.action : ""),
    ),
  );
}

/* ------------------------------------------------------------------------ boot */

let booted = false;

/**
 * Renderer containment (web-hardening.js), installed before any window:
 * - every webContents is pinned to its own page (app windows: index.html;
 *   the practice window: practice.html; the hidden capture window:
 *   capture.html), with popups and webviews denied;
 * - the default session (both app windows) grants no permission and loads
 *   nothing remote;
 * - the capture partition grants screen capture to capture.html only, so the
 *   display-media grant is unreachable from the app windows (other session).
 */
function hardenSessions() {
  const captureSession = electronSession.fromPartition(CAPTURE_PARTITION);
  app.on("web-contents-created", (_event, contents) => {
    // App windows: index.html, plus practice.html for the practice window
    // (which narrows itself further in createPracticeWindow).
    const pages = contents.session === captureSession ? [CAPTURE_PAGE] : [RENDERER_PAGE, PRACTICE_PAGE];
    hardenWebContents(contents, { pages, log: (entry) => warn(`blocked: ${entry.type}`) });
  });
  lockDownSession(electronSession.defaultSession);
  lockDownSession(captureSession, { allowPermission: capturePermissionPolicy([CAPTURE_PAGE]) });
}

/** Lifecycle snapshots carry raw Errors (stack traces): the renderer gets code + message only. */
function rendererSnapshot(snapshot) {
  if (!snapshot?.error) return snapshot;
  return { ...snapshot, error: { code: typeof snapshot.error.code === "string" ? snapshot.error.code : null, message: errorText(snapshot.error) } };
}

/**
 * Start the realtime server inside the app process so a packaged build is a
 * single double-clickable executable (no terminal, no second process).
 * EMBEDDED_SERVER=0 or a REALTIME_URL override runs against an external one.
 */
async function startEmbeddedServer() {
  try {
    const [{ RealtimeServer }, engines] = await Promise.all([
      import("../server/ws-server.js"),
      import("../server/engines/index.js"),
    ]);
    // Random port unless pinned: a fixed well-known port is an invitation
    // for any local web page to try the socket.
    const requested = Number.parseInt(process.env.REALTIME_PORT ?? "0", 10);
    const answerRoles = process.env.ANSWER_ROLES
      ? process.env.ANSWER_ROLES.split(",").map((role) => role.trim()).filter(Boolean)
      : undefined;
    state.engineMode = captureEngineMode(process.env, CAPTURE_BACKEND);
    const engineConfig = engines.buildEngineConfig(process.env, {
      mode: state.engineMode,
      answerInstructionsPath: answerInstructionsPath(),
      telemetryDir: join(userDataDirectory(), "logs", "telemetry"),
      knownTermsPath: knownTermsPath(),
    });
    try {
      // Prompts load once into memory and reload on change; a file of the same
      // path in <data folder>\prompts\<set>\ overrides the shipped one.
      const prompts = engines.configurePrompts({
        set: process.env.PROMPT_SET || undefined,
        overrideDir: join(userDataDirectory(), "prompts"),
        log: (event) => warn(`prompts: ${JSON.stringify(event)}`),
      });
      prompts.watch();
      console.log(`[app] prompts: ${prompts.set} (overrides in ${join(userDataDirectory(), "prompts", prompts.set)})`);
    } catch (error) {
      warn(`prompts failed to load: ${errorText(error)}`);
    }
    const server = new RealtimeServer({
      port: Number.isFinite(requested) ? requested : 0,
      createEngine: engines.createEngineFactory({
        ...engineConfig,
        ...(answerRoles ? { answerRoles } : {}),
        // Settings > Answer model, read for every answer (no restart). Loaded
        // settings always hold a listed choice; the env ANSWER_MODEL only
        // applies while they are not loaded (or failed to load).
        answerModelResolver: () => state.settings?.answerModel || engineConfig.answerModel || null,
        // Settings > "Use what I say in answers", read for every answer too.
        repContextResolver: () => currentRepContext(),
        // Settings > "Highlight key phrases", read for every answer too.
        highlightsResolver: () => currentHighlights(),
        // Settings > "Short answer cards", read for every answer too.
        answerCardsResolver: () => currentAnswerCards(),
        // Settings > "Explain terms", read once per answer turn.
        glossaryResolver: () => currentGlossary(),
      }),
      // Only this process's own client holds the per-launch secret; the
      // server's Origin gate additionally refuses every browser upgrade.
      verifyToken: (jwt) => constantTimeEqual(jwt, EMBEDDED_SECRET),
      // ...and it is checked at the handshake, before a socket exists.
      requireUpgradeAuth: true,
    });
    const { url } = await server.start();
    REALTIME_URL = url;
    state.credential = EMBEDDED_SECRET;
    state.embeddedServer = server;
    console.log(`[app] embedded realtime server at ${REALTIME_URL}`);
  } catch (error) {
    warn(`embedded server failed to start: ${errorText(error)} — set REALTIME_URL to use an external server`);
    // Refuse sessions instead of falling back to the default URL: whatever
    // listens there would receive the call audio without a credential.
    state.realtimeUrlError = "The built-in realtime server failed to start. Restart DeskNotes, or set REALTIME_URL to use an external server.";
    state.status.lastError = state.realtimeUrlError;
  }
}

/**
 * The panel manager owns `state.windows.panels` in place. Lazy so the IPC
 * handlers and display listeners can reference it regardless of boot order.
 */
function ensurePanelManager() {
  if (panelManager) return panelManager;
  panelManager = createPanelManager({
    panels: state.windows.panels,
    createPanelWindow,
    screen,
    userDataDir: () => userDataDirectory(),
    overlay: OVERLAY,
    getClickThrough: () => state.clickThrough,
    onPanelsDisabled: () => {
      // R10: one manual close is a feature-level OFF; close the sibling too.
      panelManager?.closeAll();
      broadcast(IPC.PANELS_CHANGED, { enabled: false, count: 0 });
    },
    log: (message) => warn(message),
  });
  return panelManager;
}

/** Display topology changed: pull panels back on-screen (R7). */
function onDisplayChanged() {
  panelManager?.reclampAll();
}

const RENDERER_PATH_KEYS = Object.freeze([
  "path",
  "filePath",
  "reportPath",
  "diagnosticsPath",
  "workerPath",
  "addonPath",
  "nativeOptions",
  "preferencesPath",
  "filename",
]);

function rejectRendererPath(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of RENDERER_PATH_KEYS) {
    if (key in payload) {
      return failEnvelope(ErrorCode.INVALID_PAYLOAD, "The renderer cannot supply a path or native option.");
    }
  }
  return null;
}

function publicDevice(device) {
  if (!device || typeof device !== "object") return null;
  return {
    id: device.id ?? null,
    name: device.name ?? "",
    source: device.source ?? null,
    type: device.type ?? null,
    isDefault: Boolean(device.isDefault),
    ...(device.channels !== undefined ? { channels: device.channels } : {}),
    ...(device.sampleRate !== undefined ? { sampleRate: device.sampleRate } : {}),
  };
}

async function queryListDevices(payload = {}) {
  const refused = rejectRendererPath(payload);
  if (refused) return refused;
  const source = payload?.source;
  if (!AUDIO_SOURCES.includes(source)) {
    return failEnvelope(ErrorCode.INVALID_PAYLOAD, "Audio source must be microphone or system.");
  }
  if (!nativeCaptureRequested()) return okEnvelope([]);
  const host = await resolveNativeHost();
  if (!host) {
    return failEnvelope(ErrorCode.CAPTURE_UNAVAILABLE, "Audio capture addon is unavailable.");
  }
  try {
    const listed = await host.listDevices(source);
    const devices = Array.isArray(listed) ? listed.map(publicDevice).filter(Boolean) : [];
    return okEnvelope(devices);
  } catch (error) {
    const mapped = mapCaptureError(error);
    return failEnvelope(mapped.code, mapped.message);
  }
}

function nativeCaptureRequested() {
  const options = readShellOptions();
  return CAPTURE_BACKEND === "native" || Boolean(options.nativeHost) || typeof options.createNativeHost === "function";
}

async function queryCapabilities() {
  if (!nativeCaptureRequested()) {
    return okEnvelope({
      supportsAec: false,
      backend: CAPTURE_BACKEND,
      platform: process.platform,
      nativeAvailable: false,
    });
  }
  const host = state.audio.sessionHost ?? (await resolveNativeHost());
  if (!host) {
    return failEnvelope(ErrorCode.CAPTURE_UNAVAILABLE, "Audio capture addon is unavailable.");
  }
  let native = null;
  try {
    if (typeof host.getCapabilities === "function") native = await host.getCapabilities();
  } catch {
    native = null;
  }
  return okEnvelope({
    supportsAec: false,
    backend: CAPTURE_BACKEND,
    platform: process.platform,
    nativeAvailable: true,
    ...(native && typeof native === "object" ? { reportedAec: false } : {}),
  });
}

async function queryAudioStatus() {
  let preferences = null;
  try {
    const prefs = await ensurePreferences();
    preferences = await prefs.load();
  } catch {
    preferences = null;
  }
  const capabilities = (await queryCapabilities()).value;
  return okEnvelope({
    generation: state.audio.generation,
    sources: sourceStatusMap(),
    transcription: publicTranscription(),
    preferences,
    capabilities,
    cleanup: state.audio.lastCleanup,
  });
}

async function commandSetDevice(payload = {}) {
  const refused = rejectRendererPath(payload);
  if (refused) return refused;
  try {
    const prefs = await ensurePreferences();
    const saved = await prefs.save(payload?.source, payload?.choice);
    state.audio.choices = {
      ...state.audio.choices,
      [payload.source]: saved,
    };
    return okEnvelope(saved);
  } catch (error) {
    if (error?.code === "AUDIO_CAPTURE_ACTIVE" || error?.type === "CONFLICT") {
      return failEnvelope(ErrorCode.AUDIO_CAPTURE_ACTIVE, "Audio device cannot change while capture is active.", {
        type: ErrorCode.CONFLICT,
      });
    }
    const safe = {
      INVALID_SOURCE: "Audio source must be microphone or system.",
      INVALID_DEVICE_CHOICE: "Device choice is not valid.",
      RENDERER_PATH_REJECTED: "The renderer cannot supply a path or native option.",
      PREFERENCES_TOO_LARGE: "Preferences exceed 16 KiB.",
    };
    const message = safe[error?.code] ?? "Device choice is not valid.";
    const code = error?.code === "INVALID_SOURCE" || error?.code === "INVALID_DEVICE_CHOICE"
      ? ErrorCode.INVALID_PAYLOAD
      : (error?.code ?? ErrorCode.INVALID_PAYLOAD);
    return failEnvelope(code, message);
  }
}

function diagnosticsInput() {
  const located = locateNativeAddon();
  const capture = summariseCaptureDiagnostics({
    backend: CAPTURE_BACKEND,
    sources: state.audio.sources,
  });
  const native = located
    ? {
        apiVersion: located.manifest.apiVersion,
        napiVersion: located.manifest.napiVersion,
        arch: located.manifest.arch,
        electronTarget: located.manifest.electronTarget,
        build: located.manifest.buildOutcome ?? { status: "not-run" },
        tests: located.manifest.testOutcome ?? { status: "not-run" },
      }
    : { available: false, build: { status: "not-run" }, tests: { status: "not-run" } };
  return {
    native,
    selected: state.audio.choices,
    resolved: sourceStatusMap(),
    capture,
    counters: capture.counters,
    timing: {
      quality: "qpc",
      base: "session-monotonic-qpc",
      lastPacketAgeMs: {
        microphone: state.audio.sources.microphone?.lastPacketAgeMs ?? null,
        system: state.audio.sources.system?.lastPacketAgeMs ?? null,
      },
    },
    worker: state.audio.lastCleanup ?? { forcedCleanup: false },
    providerMode: state.engineMode ?? captureEngineMode(process.env, CAPTURE_BACKEND),
    supportsAec: false,
    tests: { native: native.tests },
    runtime: {
      electron: process.versions.electron ?? null,
      node: process.versions.node ?? null,
    },
  };
}

async function commandExportDiagnostics(payload = {}) {
  const refused = rejectRendererPath(payload);
  if (refused) return refused;
  const report = buildDiagnosticsExport(diagnosticsInput());
  const dir = join(userDataDirectory(), "diagnostics");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "audio-diagnostics.json");
  await writeFile(filePath, report.body);
  return okEnvelope({ path: filePath, bytes: report.bytes });
}

/**
 * Test and production entry. Options set the user-data directory and the
 * native host before bootstrap. The packaged process boots itself.
 */
export function createMainShell(options = {}) {
  globalThis.__COPILOT_SHELL_OPTIONS__ = { ...readShellOptions(), ...options };
  if (booted) return Promise.resolve({ already: true });
  return bootstrap();
}

async function bootstrap() {
  if (!state.engineMode) state.engineMode = captureEngineMode(process.env, CAPTURE_BACKEND);
  state.presenter = createWindowPresenter({ getOpacity: () => currentWindowOpacity() });
  if (booted) {
    // macOS re-activation after all windows closed: handlers/bus are still
    // live, only the windows need rebuilding.
    if (!state.windows.main) state.windows.main = createMainWindow();
    if (!state.windows.overlay) state.windows.overlay = createOverlayWindow();
    broadcastWindowState();
    return;
  }
  booted = true;
  hardenSessions();
  // No application menu: its View menu offers "Toggle Developer Tools", which
  // opens an unprotected window, and a menu bar has no place on the overlay.
  Menu.setApplicationMenu(null);
  if (REALTIME_URL_ENV) {
    const policy = checkRealtimeUrl(REALTIME_URL_ENV);
    if (!policy.ok) {
      state.realtimeUrlError = `REALTIME_URL refused (${policy.reason}): use wss://, or ws:// to loopback only`;
      state.status.lastError = state.realtimeUrlError;
      warn(state.realtimeUrlError);
    }
  }
  // One executable, one process: the realtime server ships in-app.
  if (!REALTIME_URL_ENV && process.env.EMBEDDED_SERVER !== "0") {
    await startEmbeddedServer();
  }
  state.gateway = new IpcGateway({
    maxPayloadBytes: 512 * 1024, // transcripts+deltas are tiny; screenshots never cross this boundary
    onError: (envelope) => warn(`ipc ${envelope.error.code}: ${envelope.error.message}`),
  });
  state.gateway.subscribe(({ channel, payload }) => {
    for (const win of [state.windows.main, state.windows.overlay, ...state.windows.panels]) {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    }
  });

  state.lifecycle = new SessionLifecycle();
  state.lifecycle.subscribe((snapshot) => {
    state.status.lifecycle = snapshot.state;
    if (snapshot.state === SESSION_STATES.FAILED) {
      state.status.lastError = snapshot.error?.message ?? snapshot.reason ?? "session failed";
    }
    broadcast(IPC.SESSION_STATE_CHANGED, rendererSnapshot(snapshot));
    broadcast(IPC.SPEECH_STATUS_CHANGED, {
      state: snapshot.state,
      previous: snapshot.previous,
      reason: snapshot.reason,
      error: snapshot.error ? errorText(snapshot.error) : null,
    });
    if (snapshot.state === SESSION_STATES.FAILED) {
      // Release capture devices and the socket as soon as the fault latches.
      void stopSpeech();
      for (const unsubscribe of state.unsubscribers.splice(0)) {
        try {
          unsubscribe?.();
        } catch {
          /* listener already gone */
        }
      }
      closeAnalyser();
      closeScreenGrabber();
      const client = state.transport;
      state.transport = null;
      state.sessionId = null;
      try {
        client?.stop?.();
      } catch {
        /* already dead */
      }
    }
  });

  await loadDesktopSettings();
  ensurePanelManager();
  registerIpcRoutes();
  state.windows.main = createMainWindow();
  state.windows.overlay = createOverlayWindow();
  registerShortcuts();
  for (const event of ["display-metrics-changed", "display-added", "display-removed"]) {
    screen.on(event, onDisplayChanged);
  }
  broadcastWindowState();
  app.on("before-quit", onBeforeQuit);
  // Opening the app is the rep's "I'm about to take a call".
  void runAutoStart();
}

/**
 * The real app only (not a refused launch, not a test driver): pin userData to
 * one folder for dev and packaged builds (data-dir.js), copying the old
 * folders' files on first use. Runs before the single-instance lock, which is
 * keyed on userData, and before `ready`. A test double without the path API
 * keeps its own folder (userDataDirectory()).
 */
function pinDataDirectory() {
  if (typeof app.getPath !== "function" || typeof app.setPath !== "function") return;
  try {
    const { dir, warnings, migration } = prepareDataDir({ env: process.env, appData: app.getPath("appData") });
    for (const message of warnings) console.warn(`[app] ${message}`);
    app.setPath("userData", dir);
    console.log(`[app] data folder: ${dir}`);
    if (migration.copied.length > 0) {
      console.log(`[app] copied from the old data folders: ${migration.copied.map((item) => `${item.file} (${item.from})`).join(", ")}`);
    }
    for (const item of migration.errors) console.warn(`[app] couldn't copy ${item.file}: ${item.message}`);
  } catch (error) {
    console.warn(`[app] data folder not pinned: ${errorText(error)}`);
  }
}

if (REFUSED_SWITCHES.length === 0 && !globalThis.__COPILOT_SHELL_LIBRARY__) pinDataDirectory();

if (REFUSED_SWITCHES.length > 0) {
  // app.exit() above already ended the process; never boot a refused launch.
} else if (globalThis.__COPILOT_SHELL_LIBRARY__) {
  // A driver calls createMainShell() after it installs fakes.
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // A second launch should reveal the existing shell, not spawn a duplicate.
    const main = state.windows.main;
    if (main && !main.isDestroyed()) state.presenter.show(main, { inactive: false });
  });

  app
    .whenReady()
    // A key set after the launching shell started is only in the registry.
    // A real Electron app only (not ELECTRON_RUN_AS_NODE drivers, not a test
    // double of electron): tests must never pull in the user's real keys.
    .then(() => (process.versions?.electron && !process.env.ELECTRON_RUN_AS_NODE ? fillMissingUserEnv(process.env) : []))
    .then(
      (filled) => {
        if (filled.length > 0) console.log(`[app] read from the user environment: ${filled.join(", ")}`);
      },
      () => {},
    )
    .then(bootstrap)
    .catch((error) => {
      warn(`shell bootstrap failed: ${errorText(error)}`);
      app.quit();
    });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) bootstrap();
    else if (state.windows.main && !state.windows.main.isDestroyed()) state.presenter.show(state.windows.main, { inactive: false });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    void state.embeddedServer?.stop?.();
    void endSession("quit");
    state.lifecycle?.dispose();
  });
}
