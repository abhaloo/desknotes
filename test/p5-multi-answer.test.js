import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IPC } from "../src/desktop/ipc-gateway.js";

/**
 * Behavioral regression tests for the multi-answer windows (spec R1, R4-R8,
 * R10). The REAL src/desktop/main.mjs runs in an Electron-as-Node driver
 * process - the test/p5-main-wiring.test.js harness - against
 * test/fixtures/fake-electron.mjs. The driver extends that shared fixture with
 * the surface panel windows need (bounds, close/closed, display lookup and
 * call recording) plus a transport double, so one accelerator press or
 * shell:action call is observably exactly one requestAnswer call.
 *
 * The driver is generated into a temp dir: it must not become a second
 * fixture, and the assertions below stay pinned to the exact channel strings
 * (panels:set, panels:changed, shell:action) and the createPanelManager /
 * triggerShellAction names.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function electronBinary() {
  try {
    const resolution = createRequire(import.meta.url)("electron");
    return typeof resolution === "string" ? resolution : null;
  } catch {
    return null;
  }
}
const electron = electronBinary();
const skip = !electron && "electron binary not installed";

/**
 * Transport double. The driver's resolve hook substitutes this module for
 * ../transport/realtime-client.js, so requestAnswer is counted in-process
 * instead of being sent over a socket.
 */
const transportSource = [
  "export class RealtimeClient {",
  "  onFrame() { return () => {}; }",
  "  onStatus() { return () => {}; }",
  "  async start() { globalThis.__FAKE_TRANSPORT__ = this; }",
  "  async reconnect() {}",
  "  async stop() {}",
  "  disconnect() {}",
  "  requestAnswer(utterance, intent) {",
  "    const requests = globalThis.__ANSWER_REQUESTS__ || (globalThis.__ANSWER_REQUESTS__ = []);",
  "    requests.push({ utterance: String(utterance || ''), intent: intent || null });",
  "  }",
  "  sendAudio() {}",
  "  finalizeStream() {}",
  "  sendTurnHint() { return false; }",
  "  hasCapability() { return false; }",
  "  getStats() { return {}; }",
  "  getLinkStats() { return {}; }",
  "}",
].join("\n");

const hooksSource = (transportUrl) =>
  [
    "const TRANSPORT = " + JSON.stringify(transportUrl) + ";",
    "export async function resolve(specifier, context, next) {",
    "  const resolved = await next(specifier, context);",
    "  if (typeof resolved.url === 'string' && resolved.url.endsWith('/src/transport/realtime-client.js')) {",
    "    return { url: TRANSPORT, shortCircuit: true, format: 'module' };",
    "  }",
    "  return resolved;",
    "}",
  ].join("\n");

const driverSource = ({ userDataDir, electronLoader, fakeElectron, transportHooks }) => `
import { register } from "node:module";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = ${JSON.stringify(root)};
const USERDATA = ${JSON.stringify(userDataDir)};
const ELECTRON_LOADER = ${JSON.stringify(electronLoader)};
const FAKE_ELECTRON = ${JSON.stringify(fakeElectron)};
const TRANSPORT_HOOKS = ${JSON.stringify(transportHooks)};

register(ELECTRON_LOADER, import.meta.url);
register(TRANSPORT_HOOKS, import.meta.url);

const report = { steps: {} };
const step = (name, value) => { report.steps[name] = value; };
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

try {
  const fake = await import(FAKE_ELECTRON);

  // --- extend the shared fake with the surface panels exercise ---------------
  const listeners = new WeakMap();
  function on(win, event, fn, once) {
    if (!win.__events) win.__events = [];
    win.__events.push(event);
    let map = listeners.get(win);
    if (!map) { map = new Map(); listeners.set(win, map); }
    if (!map.has(event)) map.set(event, []);
    const list = map.get(event);
    const wrapped = once
      ? (...args) => {
          const index = list.indexOf(wrapped);
          if (index >= 0) list.splice(index, 1);
          fn(...args);
        }
      : fn;
    list.push(wrapped);
    return win;
  }
  fake.BrowserWindow.prototype.on = function (event, fn) { return on(this, event, fn, false); };
  fake.BrowserWindow.prototype.once = function (event, fn) { return on(this, event, fn, true); };
  fake.BrowserWindow.prototype.removeListener = function (event, fn) {
    const map = listeners.get(this);
    const list = map ? map.get(event) || [] : [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  };
  fake.BrowserWindow.prototype.emit = function (event, ...args) {
    const map = listeners.get(this);
    const list = map ? [...(map.get(event) || [])] : [];
    for (const fn of list) fn(...args);
  };

  function boundsOf(win) {
    if (!win.__bounds) {
      const options = win.options || {};
      win.__bounds = {
        x: options.x === undefined ? 0 : options.x,
        y: options.y === undefined ? 0 : options.y,
        width: options.width === undefined ? 0 : options.width,
        height: options.height === undefined ? 0 : options.height,
      };
    }
    return win.__bounds;
  }
  function record(win, method, args) {
    if (!win.__calls) win.__calls = [];
    win.__calls.push([method].concat(args));
  }
  fake.BrowserWindow.prototype.getBounds = function () { return Object.assign({}, boundsOf(this)); };
  fake.BrowserWindow.prototype.setBounds = function (next) {
    Object.assign(boundsOf(this), next);
    record(this, "setBounds", [next]);
  };
  // Real Electron emits "closed" after a close/destroy; the panel manager's
  // R10 path depends on that event, so the fake must deliver it synchronously.
  fake.BrowserWindow.prototype.close = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    record(this, "close", []);
    this.emit("closed");
  };
  fake.BrowserWindow.prototype.destroy = function () { this.close(); };
  for (const method of ["setIgnoreMouseEvents", "setSkipTaskbar", "setAlwaysOnTop", "setVisibleOnAllWorkspaces", "setOpacity", "show", "showInactive", "hide", "focus", "loadFile"]) {
    const original = fake.BrowserWindow.prototype[method];
    fake.BrowserWindow.prototype[method] = function (...args) {
      record(this, method, args);
      return original ? original.apply(this, args) : undefined;
    };
  }

  // Record webContents guard registration and popup denial per window.
  Object.defineProperty(fake.BrowserWindow.prototype, "webContents", {
    configurable: true,
    get() { return this.__webContents; },
    set(value) {
      this.__webContents = value;
      value.__events = value.__events || [];
      const originalOn = value.on.bind(value);
      value.on = (event, fn) => { value.__events.push(event); return originalOn(event, fn); };
      const originalHandler = value.setWindowOpenHandler.bind(value);
      value.setWindowOpenHandler = (fn) => { value.__windowOpenHandlerSet = true; return originalHandler(fn); };
    },
  });

  // The fake's screen is a stub: panels need display lookup for bounds clamping.
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  const screenEvents = new Map();
  fake.screen.getPrimaryDisplay = () => displays[0];
  fake.screen.getDisplayMatching = () => displays[0];
  fake.screen.on = (event, fn) => {
    if (!screenEvents.has(event)) screenEvents.set(event, []);
    screenEvents.get(event).push(fn);
    return fake.screen;
  };
  fake.screen.emit = (event, ...args) => {
    for (const fn of [...(screenEvents.get(event) || [])]) fn(...args);
  };

  // Shortcut callbacks must be pressable: the accelerator parity test uses the
  // same callback the OS would invoke.
  const shortcuts = new Map();
  fake.globalShortcut.register = (accelerator, callback) => { shortcuts.set(accelerator, callback); return true; };
  fake.globalShortcut.unregister = (accelerator) => { shortcuts.delete(accelerator); };
  fake.globalShortcut.unregisterAll = () => { shortcuts.clear(); };

  globalThis.__COPILOT_SHELL_LIBRARY__ = true;
  process.env.EMBEDDED_SERVER = "0";
  process.env.SCREEN_GRABBER = "0";
  const main = await import(pathToFileURL(ROOT + "/src/desktop/main.mjs").href);
  await main.createMainShell({ userDataDir: USERDATA });
  await delay(50);

  const panels = () =>
    fake.BrowserWindow.getAllWindows().filter(
      (win) => !win.isDestroyed() && win.loaded && win.loaded.options && win.loaded.options.query && win.loaded.options.query.mode === "panel",
    );
  const describePanels = () =>
    panels().map((win) => ({
      id: win.id,
      mode: (win.loaded && win.loaded.options && win.loaded.options.query && win.loaded.options.query.mode) || null,
      query: (win.loaded && win.loaded.options && win.loaded.options.query) || null,
      bounds: win.getBounds(),
      guardEvents: win.__events || [],
      windowOpenHandlerSet: Boolean(win.webContents && win.webContents.__windowOpenHandlerSet),
      ignoreCalls: (win.__calls || []).filter((call) => call[0] === "setIgnoreMouseEvents").map((call) => call.slice(1)),
    }));
  const changedSince = (mark) =>
    fake.sent.filter((message) => message.channel === "panels:changed" && message.at >= mark).map((message) => message.payload);
  const answerCount = () => (globalThis.__ANSWER_REQUESTS__ || []).length;
  async function guarded(name, fn) {
    try {
      return await fn();
    } catch (error) {
      step(name + "Error", String(error && error.stack ? error.stack : error));
      return null;
    }
  }

  // R1/R9: checking the box spawns exactly two panel-mode windows and announces it.
  const t1 = Date.now();
  step("enable1", await guarded("enable1", () => fake.invoke("panels:set", { enabled: true })));
  await delay(50);
  step("panels1", describePanels());
  step("broadcast1", changedSince(t1));

  // R8: every panel denies popups.
  await delay(600);
  step("guard1", panels().map((win) => ({ events: win.__events || [], windowOpenHandlerSet: Boolean(win.webContents && win.webContents.__windowOpenHandlerSet) })));

  // R6: the global click-through toggle reaches every panel with forward:true.
  step("clickThroughOn", await guarded("clickThroughOn", () => fake.invoke("window:setClickThrough", { enabled: true })));
  await delay(30);
  step("panelIgnoreOn", panels().map((win) => (win.__calls || []).filter((call) => call[0] === "setIgnoreMouseEvents").map((call) => call.slice(1))));
  step("clickThroughOff", await guarded("clickThroughOff", () => fake.invoke("window:setClickThrough", { enabled: false })));
  await delay(30);
  step("panelIgnoreOff", panels().map((win) => (win.__calls || []).filter((call) => call[0] === "setIgnoreMouseEvents").map((call) => call.slice(1))));

  // R1/R7: unchecking closes both panels and persists their bounds.
  const live = panels();
  if (live[0]) live[0].setBounds({ x: 61, y: 62, width: 424, height: 700 });
  const boundsPath = join(USERDATA, "panel-bounds.json");
  try { rmSync(boundsPath, { force: true }); } catch { /* nothing to remove */ }
  step("disable1", await guarded("disable1", () => fake.invoke("panels:set", { enabled: false })));
  await delay(100);
  step("panelsAfterDisable", describePanels());
  try {
    step("boundsFile", { exists: true, raw: readFileSync(boundsPath, "utf8") });
  } catch {
    step("boundsFile", { exists: false, raw: null });
  }

  // R10: closing one panel by hand disables the feature and closes the sibling.
  step("enableManual", await guarded("enableManual", () => fake.invoke("panels:set", { enabled: true })));
  await delay(50);
  const manual = panels();
  const t3 = Date.now();
  if (manual[0]) manual[0].close();
  await delay(150);
  step("manualClose", {
    siblingDestroyed: manual[1] ? manual[1].isDestroyed() : null,
    livePanels: describePanels(),
    broadcasts: changedSince(t3),
  });

  // R7: off-screen persisted bounds are clamped into the live work area.
  writeFileSync(boundsPath, JSON.stringify([
    { x: -99999, y: -99999, width: 420, height: 300 },
    { x: 50000, y: 50000, width: 420, height: 300 },
  ]));
  step("enable2", await guarded("enable2", () => fake.invoke("panels:set", { enabled: true })));
  await delay(50);
  step("clamp", describePanels());
  step("workArea", displays[0].workArea);

  // R5: accelerator and IPC converge on triggerShellAction; one press, one request.
  step("sessionStart", await guarded("sessionStart", () => fake.invoke("session:start", {})));
  const accelerator = shortcuts.get("CommandOrControl+Shift+A");
  const before = answerCount();
  if (accelerator) accelerator();
  const afterAccelerator1 = answerCount();
  if (accelerator) accelerator();
  const afterAccelerator2 = answerCount();
  const t5 = Date.now();
  step("shellAction1", await guarded("shellAction1", () => fake.invoke("shell:action", { action: "answer-now" })));
  const afterIpc1 = answerCount();
  step("shellAction2", await guarded("shellAction2", () => fake.invoke("shell:action", { action: "answer-now" })));
  const afterIpc2 = answerCount();
  step("dispatch", {
    deltas: [
      afterAccelerator1 - before,
      afterAccelerator2 - afterAccelerator1,
      afterIpc1 - afterAccelerator2,
      afterIpc2 - afterIpc1,
    ],
    triggered: fake.sent.filter((message) => message.channel === "shortcuts:triggered" && message.at >= t5).map((message) => message.payload),
    requests: (globalThis.__ANSWER_REQUESTS__ || []).map((request) => request.intent),
  });
} catch (error) {
  report.fatal = String(error && error.stack ? error.stack : error);
}

let payload;
try {
  payload = JSON.stringify(report);
} catch (error) {
  payload = JSON.stringify({ fatal: "unserializable report: " + String(error) });
}
console.log("RESULT " + payload);
process.exit(0);
`;

function runDriver(driverPath) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const key of ["REALTIME_URL", "JWT", "SESSION_ID", "CAPTURE_BACKEND", "VAD_ENABLED", "EMBEDDED_SERVER", "REALTIME_PORT", "SCREEN_GRABBER"]) {
    delete env[key];
  }
  const result = spawnSync(electron, [driverPath], { cwd: root, env, encoding: "utf8", timeout: 60_000, windowsHide: true });
  const line = String(result.stdout ?? "")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("RESULT "));
  if (!line) {
    throw new Error(`multi-answer driver produced no result (status ${result.status}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(line.slice("RESULT ".length));
}

let driverPromise = null;
function driver() {
  if (!driverPromise) {
    const workdir = mkdtempSync(join(tmpdir(), "multi-answer-"));
    const userDataDir = join(workdir, "userdata");
    mkdirSync(userDataDir, { recursive: true });
    const electronLoader = pathToFileURL(join(here, "fixtures", "electron-loader.mjs")).href;
    const fakeElectron = pathToFileURL(join(here, "fixtures", "fake-electron.mjs")).href;
    const transportUrl = "data:text/javascript;base64," + Buffer.from(transportSource, "utf8").toString("base64");
    const hooksPath = join(workdir, "transport-hooks.mjs");
    const driverPath = join(workdir, "multi-answer-driver.mjs");
    writeFileSync(hooksPath, hooksSource(transportUrl));
    writeFileSync(
      driverPath,
      driverSource({ userDataDir, electronLoader, fakeElectron, transportHooks: pathToFileURL(hooksPath).href }),
    );
    driverPromise = Promise.resolve().then(() => runDriver(driverPath));
  }
  return driverPromise;
}

/** A driver step that must exist; a guarded step failure is surfaced verbatim. */
function requireStep(report, name) {
  const error = report.steps?.[`${name}Error`];
  assert.equal(error, undefined, `driver step "${name}" failed: ${error}${report.fatal ? ` (driver fatal: ${report.fatal})` : ""}`);
  const value = report.steps?.[name];
  assert.ok(value !== undefined && value !== null, `driver step "${name}" missing${report.fatal ? ` (driver fatal: ${report.fatal})` : ""}`);
  return value;
}

test("panels:set true spawns exactly 2 panel windows and panels:changed reports {enabled:true,count:2}", { skip, timeout: 60_000 }, async () => {
  const report = await driver();
  assert.equal(IPC.PANELS_SET, "panels:set");
  assert.equal(IPC.PANELS_CHANGED, "panels:changed");
  const enabled = requireStep(report, "enable1");
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.deepEqual(enabled.value, { enabled: true, count: 2 });
  const panels = requireStep(report, "panels1");
  assert.equal(panels.length, 2, `expected exactly 2 panel windows, saw ${panels.length}`);
  for (const panel of panels) {
    assert.equal(panel.query.mode, "panel", 'panels must load the renderer with rendererQuery("panel")');
  }
  const changed = requireStep(report, "broadcast1");
  assert.ok(
    changed.some((payload) => payload && payload.enabled === true && payload.count === 2),
    `panels:changed {enabled:true,count:2} was not broadcast: ${JSON.stringify(changed)}`,
  );
});

test("panels:set false closes all panels and persists bounds", { skip, timeout: 60_000 }, async () => {
  const report = await driver();
  const disabled = requireStep(report, "disable1");
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  assert.equal(disabled.value.enabled, false);
  assert.equal(disabled.value.count, 0);
  assert.equal(requireStep(report, "panelsAfterDisable").length, 0, "state.windows.panels must be empty after disable");
  const file = requireStep(report, "boundsFile");
  assert.equal(file.exists, true, "userDataDirectory()/panel-bounds.json must be written when panels close");
  const saved = JSON.parse(file.raw);
  assert.ok(Array.isArray(saved) && saved.length === 2, `expected 2 persisted panel bounds, got ${file.raw}`);
  for (const bounds of saved) {
    for (const key of ["x", "y", "width", "height"]) {
      assert.equal(typeof bounds[key], "number", `panel-bounds.json ${key} must be numeric`);
    }
  }
});

test("manually closing one panel disables the feature (R10)", { skip, timeout: 60_000 }, async () => {
  const report = await driver();
  const closed = requireStep(report, "manualClose");
  assert.equal(closed.siblingDestroyed, true, "the sibling panel must close with the removed one");
  assert.equal(closed.livePanels.length, 0, "no panel window may survive a manual close");
  assert.ok(
    closed.broadcasts.some((payload) => payload && payload.enabled === false && payload.count === 0),
    `panels:changed {enabled:false,count:0} was not broadcast: ${JSON.stringify(closed.broadcasts)}`,
  );
});

test("persisted off-screen bounds clamp into a live work area (R7)", { skip, timeout: 60_000 }, async () => {
  const report = await driver();
  const workArea = requireStep(report, "workArea");
  const panels = requireStep(report, "clamp");
  assert.equal(panels.length, 2);
  for (const panel of panels) {
    const bounds = panel.bounds;
    assert.ok(bounds.x >= workArea.x && bounds.y >= workArea.y, `panel at ${JSON.stringify(bounds)} is above/left of the work area`);
    assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width, `panel at ${JSON.stringify(bounds)} overflows the work area`);
    assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height, `panel at ${JSON.stringify(bounds)} overflows the work area`);
  }
});

test('shell:action "answer-now" and the accelerator hit the same dispatcher (R5)', { skip, timeout: 60_000 }, async () => {
  const report = await driver();
  assert.equal(IPC.SHELL_ACTION, "shell:action");
  const session = requireStep(report, "sessionStart");
  assert.equal(session.ok, true, JSON.stringify(session));
  const shell1 = requireStep(report, "shellAction1");
  assert.equal(shell1.ok, true, JSON.stringify(shell1));
  const dispatch = requireStep(report, "dispatch");
  assert.deepEqual(dispatch.deltas, [1, 1, 1, 1], `each press must issue exactly one answer request (got ${JSON.stringify(dispatch.deltas)})`);
  assert.ok(
    dispatch.triggered.some((payload) => payload && payload.action === "answer-now"),
    "the accelerator must keep announcing answer-now",
  );
  assert.ok(dispatch.requests.every((intent) => intent === "manual"), "both entry points must use the same answer-now semantics");
});

test("click-through applies to every panel with forward:true (R6)", { skip, timeout: 60_000 }, async () => {
  const report = await driver();
  const on = requireStep(report, "panelIgnoreOn");
  assert.equal(on.length, 2);
  for (const calls of on) {
    assert.deepEqual(calls.at(-1), [true, { forward: true }], `expected setIgnoreMouseEvents(true, {forward:true}), got ${JSON.stringify(calls)}`);
  }
  const off = requireStep(report, "panelIgnoreOff");
  assert.equal(off.length, 2);
  for (const calls of off) {
    assert.deepEqual(calls.at(-1), [false, { forward: true }], `expected setIgnoreMouseEvents(false, {forward:true}), got ${JSON.stringify(calls)}`);
  }
});

test("panels deny popups (R8)", { skip, timeout: 60_000 }, async () => {
  const report = await driver();
  const guard = requireStep(report, "guard1");
  assert.equal(guard.length, 2);
  for (const panel of guard) {
    assert.equal(panel.windowOpenHandlerSet, true, "panel popups must be denied too");
  }
});
