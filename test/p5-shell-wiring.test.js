import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BROADCAST_CHANNELS, COMMAND_CHANNELS, IPC } from "../src/desktop/ipc-gateway.js";

/**
 * Structure guards for the shell. These are cheap, static checks that catch the
 * two regressions that would break the whole package:
 *  1) a pure module accidentally importing Electron (breaks `bun test`), and
 *  2) Bun-only globals leaking into `src/desktop` (breaks the Electron/Node
 *     runtime the shell actually runs on).
 */
const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..", "src", "desktop");
const read = (relative) => readFileSync(join(desktop, relative), "utf8");

const PURE_MODULES = [
  "session-lifecycle.js",
  "ipc-gateway.js",
  "ipc-error-codes.js",
  "renderer/answer-buffer.js",
  "renderer/capture-start.js",
  "web-hardening.js",
];
// The preload is CommonJS: sandboxed preloads cannot be ESM (sec-preload-sandbox.test.js).
const ALL_MODULES = [...PURE_MODULES, "main.mjs", "preload.cjs", "renderer/app.js"];

test("pure desktop modules never import electron", () => {
  for (const relative of PURE_MODULES) {
    const source = read(relative);
    assert.ok(!/from\s+["']electron["']/.test(source), `${relative} must stay electron-free`);
    assert.ok(!/require\(["']electron["']\)/.test(source), `${relative} must stay electron-free`);
  }
});

test("desktop sources use no Bun-only globals", () => {
  for (const relative of ALL_MODULES) {
    const source = read(relative);
    assert.ok(!/\bBun\./.test(source), `${relative} must not touch Bun globals`);
    assert.ok(!/\bBun\b/.test(source), `${relative} must not reference Bun`);
  }
});

test("electron entry points import electron and use the pure modules", () => {
  const main = read("main.mjs");
  assert.match(main, /from\s+["']electron["']/);
  assert.match(main, /SessionLifecycle/);
  assert.match(main, /IpcGateway/);
  const preload = read("preload.cjs");
  assert.match(preload, /contextBridge/);
  assert.match(preload, /ipcRenderer/);
});

test("main lazily imports the P1/P2/P4 packages so missing peers degrade", () => {
  const main = read("main.mjs");
  for (const specifier of ["../transport/realtime-client.js", "../audio/index.js", "../vision/index.js", "../vad/index.js"]) {
    assert.ok(main.includes(specifier), `main.mjs should reference ${specifier}`);
  }
  assert.ok(!/^import[^\n]*\.\.\/transport/m.test(main), "transport import must be dynamic, not top-level");
  assert.match(main, /optionalImport/);
});

test("main wires the documented IPC channel families", () => {
  const main = read("main.mjs");
  for (const key of [
    "IPC.SPEECH_START",
    "IPC.SPEECH_STOP",
    "IPC.SPEECH_RECONNECT",
    "IPC.SPEECH_DISCONNECT",
    "IPC.SPEECH_REQUEST_ANSWER",
    "IPC.SPEECH_SET_VAD_ENABLED",
    "IPC.SPEECH_GET_VAD_ENABLED",
    "IPC.SPEECH_GET_REALTIME_STATUS",
    "IPC.SPEECH_TRANSCRIPT_RECEIVED",
    "IPC.SPEECH_STATUS_CHANGED",
    "IPC.SPEECH_REALTIME_STATUS_CHANGED",
    "IPC.SPEECH_VAD_STATS",
    "IPC.SCREEN_ANALYSE",
    "IPC.SESSION_START",
    "IPC.SESSION_END",
    "IPC.SESSION_CAPTURE_FULLSCREEN",
    "IPC.SHORTCUTS_LIST",
    "IPC.WINDOW_SHOW",
    "IPC.WINDOW_HIDE",
    "IPC.WINDOW_TOGGLE",
    "IPC.WINDOW_SET_CLICK_THROUGH",
    "IPC.WINDOW_GET_STATE",
    "IPC.CONFIG_GET",
    "IPC.SHELL_ACTION",
    "IPC.PANELS_SET",
    "IPC.PANELS_CHANGED",
  ]) {
    assert.ok(main.includes(key), `main.mjs should wire ${key}`);
  }
});

test("overlay keeps its always-on-top / click-through shape and the realtime config surface", () => {
  const main = read("main.mjs");
  for (const needle of ["frame: false", "transparent: true", "alwaysOnTop: true", "setIgnoreMouseEvents", "{ forward: true }", "REALTIME_URL", "ws://localhost:8787", "SESSION_ID", "JWT"]) {
    assert.ok(main.includes(needle), `main.mjs should contain ${needle}`);
  }
});

test("multi-answer contract: exact channels, one dispatcher, panel manager", () => {
  // The pinned names other agents implement against; a typo here is a shell-wide break.
  assert.equal(IPC.SHELL_ACTION, "shell:action");
  assert.equal(IPC.PANELS_SET, "panels:set");
  assert.equal(IPC.PANELS_CHANGED, "panels:changed");
  assert.ok(COMMAND_CHANNELS.includes(IPC.SHELL_ACTION), "shell:action must be a command channel");
  assert.ok(COMMAND_CHANNELS.includes(IPC.PANELS_SET), "panels:set must be a command channel");
  assert.ok(BROADCAST_CHANNELS.includes(IPC.PANELS_CHANGED), "panels:changed must be a broadcast channel");

  // The sandboxed preload duplicates the tables (sec-preload-sandbox.test.js
  // deep-compares them); both copies must carry the same literals.
  for (const relative of ["ipc-gateway.js", "preload.cjs"]) {
    const source = read(relative);
    for (const [name, channel] of [
      ["SHELL_ACTION", IPC.SHELL_ACTION],
      ["PANELS_SET", IPC.PANELS_SET],
      ["PANELS_CHANGED", IPC.PANELS_CHANGED],
    ]) {
      assert.ok(source.includes(`${name}: "${channel}"`), `${relative} must pin ${name} = "${channel}"`);
    }
  }
  const preload = read("preload.cjs");
  assert.match(preload, /shellAction\s*\(/, "preload must expose shellAction(action)");
  assert.match(preload, /panelsSet\s*\(/, "preload must expose panelsSet(enabled)");

  // One dispatcher for accelerators and buttons; one manager for panel state.
  const main = read("main.mjs");
  assert.ok(main.includes("IPC.SHELL_ACTION"), "main.mjs must wire shell:action");
  assert.ok(main.includes("IPC.PANELS_SET"), "main.mjs must wire panels:set");
  assert.ok(main.includes("IPC.PANELS_CHANGED"), "main.mjs must broadcast panels:changed");
  assert.match(main, /function\s+triggerShellAction\s*\(/);
  assert.match(main, /triggerShellAction\(\s*"answer-now"\s*\)/, "the answer-now accelerator must route through triggerShellAction");
  assert.match(main, /createPanelManager\s*\(/);
  assert.ok(main.includes("state.windows.panels"), "panel windows must live in state.windows.panels");
  assert.ok(existsSync(join(desktop, "panel-manager.js")), "src/desktop/panel-manager.js must exist");
  const manager = read("panel-manager.js");
  assert.match(manager, /export\s+function\s+createPanelManager\b/);
  assert.ok(
    main.includes('query: { mode: "panel" }') || manager.includes('query: { mode: "panel" }'),
    'panel windows must load the renderer with query: { mode: "panel" }',
  );
});

test("renderer ships the required surface and imports the pure view model", () => {
  const html = read("renderer/index.html");
  const app = read("renderer/app.js");
  for (const id of ["lane-prospect", "lane-rep", "answer-text", "vad-bar", "toggle-capture", "shortcut-hints"]) {
    assert.ok(html.includes(id), `index.html should contain #${id}`);
  }
  assert.match(app, /from\s+["']\.\/answer-buffer\.js["']/);
  assert.match(app, /from\s+["']\.\.\/ipc-gateway\.js["']/);
  assert.match(app, /quietMs:\s*1500/);
  assert.match(app, /textContent/);
  assert.ok(!/innerHTML/.test(app), "renderer must not inject server text as HTML");
});

test("settings redesign: the control window is a title row, answer card, lanes and shortcuts", () => {
  const html = read("renderer/index.html");
  const app = read("renderer/app.js");
  // Title row: brand, multi-answer checkbox, gear and the tiny Hide icon.
  assert.match(html, /<header class="titlebar panel-hidden">/);
  for (const id of ["toggle-multi-answer", "btn-settings", "btn-hide"]) {
    assert.ok(html.includes(`id="${id}"`), `title row should contain #${id}`);
  }
  // Streaming answer card keeps its visible actions row and shortcut label.
  for (const id of ["answer-text", "screen-cards", "btn-answer-now", "hint-answer-now", "btn-screen"]) {
    assert.ok(html.includes(`id="${id}"`), `answer card should contain #${id}`);
  }
  // The shortcut row renders after the lanes inside the single scroll region.
  assert.match(html, /<ul id="shortcut-hints"><\/ul>/);
  assert.ok(html.indexOf('id="shortcut-hints"') > html.indexOf('id="lane-rep"'), "the shortcut row must follow the lanes");
  // Removed controls: Start/End and the folded autostart toggle.
  for (const gone of ["btn-start", "btn-end", "toggle-autostart"]) {
    assert.ok(!html.includes(`id="${gone}"`), `#${gone} must be removed`);
  }
  assert.ok(!/SESSION_END|toggleAutostart|onAutoStartToggle|applySpeechResult/.test(app), "renderer must not wire the removed Start/End or autostart controls");
  // The capture checkbox is the only listening control left, so it must be able
  // to open a session itself: with auto-start off (or after a failed boot)
  // speech:start alone answers E_NOT_ACTIVE and the user has no way back in.
  assert.match(app, /CH\.SESSION_START/, "checking capture must be able to open a session");
  assert.match(app, /from\s+["']\.\/capture-start\.js["']/, "the recovery path must go through the tested capture-start helper");
});

test("settings dialog owns the moved panels and stays control-mode only", () => {
  const html = read("renderer/index.html");
  const app = read("renderer/app.js");
  const css = read("renderer/styles.css");
  const dialog = /<dialog id="settings-dialog"[\s\S]*<\/dialog>/.exec(html)?.[0] ?? "";
  assert.ok(dialog, "index.html must contain #settings-dialog as a native <dialog>");
  assert.match(dialog, /class="settings-dialog control-only"/);
  for (const id of [
    "status-pill",
    "realtime-pill",
    "toggle-capture",
    "toggle-click-through",
    "click-through-pill",
    "audio-panel",
    "vad-bar",
    "grounding-panel",
    "btn-settings-close",
  ]) {
    assert.ok(dialog.includes(`id="${id}"`), `#${id} must live in the settings dialog`);
  }
  // The approved sections, grouped cards in the same visual language.
  for (const heading of ["Session", "Audio", "Answer quality", "Grounding"]) {
    assert.ok(dialog.includes(`>${heading}</h2>`), `settings dialog should have a ${heading} section`);
  }
  // The toast stays on the main window (transient feedback without settings).
  assert.ok(!dialog.includes('id="toast"'), "the toast must not move into the dialog");
  // Control-only dialog: overlay/panel modes hide it outright.
  assert.match(css, /body\[data-mode="overlay"\] #settings-dialog/);
  assert.match(css, /body\[data-mode="panel"\] #settings-dialog/);
  // app.js opens/closes it only through the gear and Close buttons.
  assert.match(app, /settingsDialog\.showModal\(\)/);
  assert.match(app, /settingsDialog\?\.close\(\)/);
  // One control, not two: the capture checkbox carries the old autostart
  // preference, through capture-start.js so the round-trip is tested.
  assert.match(app, /saveAutoStart: \(autoStart\) => persistAutoStart\(autoStart\)/);
  assert.match(app, /CH\.SETTINGS_SET, \{ autoStart \}/);
});

test("overlay keeps its own chrome: pills, capture, and no VAD meter", () => {
  const html = read("renderer/index.html");
  const app = read("renderer/app.js");
  const css = read("renderer/styles.css");
  const dialog = /<dialog id="settings-dialog"[\s\S]*<\/dialog>/.exec(html)?.[0] ?? "";
  // Spec item 4: the overlay has no settings dialog, so the live surfaces it
  // had before the redesign stay in overlay markup, outside the control-only
  // dialog - `overlay-only` is what hides them from the control window.
  const OVERLAY_CHROME = [
    ["status-pill-overlay", "statusPillOverlay"],
    ["realtime-pill-overlay", "realtimePillOverlay"],
    ["toggle-capture-overlay", "toggleCaptureOverlay"],
    ["click-through-pill-overlay", "clickThroughPillOverlay"],
  ];
  for (const [id, binding] of OVERLAY_CHROME) {
    assert.ok(html.includes(`id="${id}"`), `overlay chrome should contain #${id}`);
    assert.ok(!dialog.includes(`id="${id}"`), `#${id} belongs to the overlay, not the dialog`);
    assert.match(app, new RegExp(`${binding}: el\\("${id}"\\)`), `app.js must bind #${id} as ${binding}`);
  }
  assert.match(css, /body\[data-mode="control"\] \.overlay-only\s*\{\s*display: none;/, "overlay chrome must hide in control mode");
  // The VAD gate is a Settings diagnostic only: the assistant window shows none.
  const outsideDialog = html.replace(dialog, "");
  assert.ok(!/VAD gate|vad-bar|vad-state|vad-meta/.test(outsideDialog), "no VAD meter outside the Settings dialog");
});
