import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFakeElectron } from "./fixtures/fake-electron-shell.js";
import { IPC } from "../src/desktop/ipc-gateway.js";
import { CAPTURE_PARTITION } from "../src/desktop/screen-grabber.js";

const bunTest = await import("bun:test").catch(() => null);
const afterAll = bunTest?.afterAll ?? (() => {});
const mock = bunTest?.mock;

if (!bunTest) {
  test("packaged main hardening", { skip: "requires bun:test mock.module" }, () => {});
}

if (bunTest) {

/**
 * Boots the REAL src/desktop/main.mjs as a PACKAGED build against the
 * fake Electron, twice:
 *  1. with --remote-debugging-port on the command line: it must exit before
 *     creating a window or registering IPC (F20);
 *  2. normally, with an insecure external REALTIME_URL: checks the renderer
 *     containment wiring (F2), the sandboxed preload and the realtime URL
 *     refusal (F7).
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop");
const indexPath = join(desktop, "renderer", "index.html");
const capturePath = join(desktop, "capture", "capture.html");
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await tick(5);
  }
  return fn();
}

const savedEnv = { ...process.env };
const savedArgv = [...process.argv];

function useFake(fake) {
  mock.module("electron", () => ({ ...fake.electron, default: fake.electron }));
}

function withoutFatalListeners(before) {
  for (const kind of ["uncaughtException", "unhandledRejection"]) {
    for (const l of process.listeners(kind)) if (!before[kind].includes(l)) process.removeListener(kind, l);
  }
}
const listenersNow = () => ({
  uncaughtException: process.listeners("uncaughtException"),
  unhandledRejection: process.listeners("unhandledRejection"),
});

// ---- boot 1: refused ---------------------------------------------------------
const refused = createFakeElectron({ isPackaged: true });
refused.electron.app.presentSwitches = ["remote-debugging-port"];
useFake(refused);
process.env.EMBEDDED_SERVER = "0";
let before = listenersNow();
await import("../src/desktop/main.mjs?sec-refused");
withoutFatalListeners(before);
await tick(20);

// ---- boot 2: normal packaged boot ------------------------------------------
const fake = createFakeElectron({ isPackaged: true });
useFake(fake);
process.env.REALTIME_URL = "ws://realtime.example.com/v3/realtime"; // plaintext, remote
process.env.JWT = "external-token";
before = listenersNow();
await import("../src/desktop/main.mjs?sec-hardening");
withoutFatalListeners(before);
await until(() => fake.windows.length >= 2 && fake.ipcHandlers.size > 0);
const main = fake.byTag("main");
const overlay = fake.byTag("overlay");

afterAll(() => {
  fake.electron.app.emit("will-quit");
  process.argv.splice(0, process.argv.length, ...savedArgv);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function ipcEvent(win, { url, parent = null } = {}) {
  const query = new URLSearchParams(win.loaded?.options?.query ?? {}).toString();
  return {
    sender: { id: win.webContents.id },
    senderFrame: { url: url ?? `${pathToFileURL(win.loaded.path).href}${query ? `?${query}` : ""}`, parent },
  };
}
const call = (channel, payload = null, event = ipcEvent(main)) => fake.ipcHandlers.get(channel)(event, payload);

test("F20: a packaged build launched with --remote-debugging-port exits before any window or IPC", () => {
  assert.deepEqual(refused.calls.filter(([t, m]) => t === "app" && m === "exit"), [["app", "exit", 1]]);
  assert.equal(refused.windows.length, 0, "no window was created");
  assert.equal(refused.ipcHandlers.size, 0, "no IPC surface was registered");
});

test("app windows are sandboxed with the CommonJS preload", () => {
  for (const win of [main, overlay]) {
    const prefs = win.options.webPreferences;
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.ok(prefs.preload.endsWith("preload.cjs"));
  }
});

test("F2: every webContents is pinned to its page; popups and webviews are denied", () => {
  for (const win of [main, overlay]) {
    const wc = win.webContents;
    for (const event of ["will-navigate", "will-redirect", "will-frame-navigate", "will-attach-webview"]) {
      assert.ok(wc.listenerCount(event) > 0, `${win.tag}: ${event} handled`);
    }
    const evil = { prevented: false, preventDefault() { this.prevented = true; } };
    wc.emit("will-navigate", evil, "https://evil.example.com/?t=transcript");
    assert.equal(evil.prevented, true);
    const own = { prevented: false, preventDefault() { this.prevented = true; } };
    wc.emit("will-navigate", own, `${pathToFileURL(indexPath).href}?mode=control`);
    assert.equal(own.prevented, false);
    assert.deepEqual(wc.windowOpenHandler({ url: "https://evil.example.com/" }), { action: "deny" });
  }
});

test("F2: the default session grants nothing; the capture partition grants capture to capture.html only", () => {
  const def = fake.electron.session.defaultSession;
  let granted = null;
  def.permissionRequest({ getURL: () => pathToFileURL(indexPath).href }, "media", (ok) => (granted = ok), {});
  assert.equal(granted, false, "the app windows cannot get camera/mic/screen");
  assert.equal(def.permissionCheck({ getURL: () => pathToFileURL(indexPath).href }, "display-capture", "file:///"), false);
  let verdict = null;
  def.webRequest.beforeRequest({ url: "https://evil.example.com/" }, (v) => (verdict = v));
  assert.deepEqual(verdict, { cancel: true });

  const capture = fake.electron.session.fromPartition(CAPTURE_PARTITION);
  let captureGrant = null;
  capture.permissionRequest({ getURL: () => pathToFileURL(capturePath).href }, "media", (ok) => (captureGrant = ok), {
    requestingUrl: pathToFileURL(capturePath).href,
  });
  assert.equal(captureGrant, true);
  let strayGrant = null;
  capture.permissionRequest({ getURL: () => "https://evil.example.com/" }, "media", (ok) => (strayGrant = ok), {
    requestingUrl: "https://evil.example.com/",
  });
  assert.equal(strayGrant, false);
});

test("F2: the hidden capture window is pinned to capture.html", () => {
  const { BrowserWindow } = fake.electron;
  const win = new BrowserWindow({ show: false, webPreferences: { session: fake.electron.session.fromPartition(CAPTURE_PARTITION), sandbox: true } });
  const toIndex = { prevented: false, preventDefault() { this.prevented = true; } };
  win.webContents.emit("will-navigate", toIndex, pathToFileURL(indexPath).href);
  assert.equal(toIndex.prevented, true, "the capture window may not become an app page");
  const self = { prevented: false, preventDefault() { this.prevented = true; } };
  win.webContents.emit("will-navigate", self, pathToFileURL(capturePath).href);
  assert.equal(self.prevented, false);
  win.destroyed = true;
});

test("F2: IPC from a navigated page, a subframe or the capture page is refused", async () => {
  const ok = await call(IPC.CONFIG_GET);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.hasJwt, true);
  assert.ok(!JSON.stringify(ok).includes("external-token"), "the token never reaches the renderer");
  for (const event of [
    ipcEvent(main, { url: "https://evil.example.com/" }),
    ipcEvent(main, { parent: { url: pathToFileURL(indexPath).href } }),
    ipcEvent(main, { url: pathToFileURL(capturePath).href }),
    { sender: { id: main.webContents.id } },
  ]) {
    const refusedCall = await call(IPC.SESSION_START, {}, event);
    assert.deepEqual([refusedCall.ok, refusedCall.error?.code], [false, "E_FORBIDDEN_SENDER"]);
  }
});

test("F7: a plaintext remote REALTIME_URL refuses session start (nothing is sent)", async () => {
  const start = await call(IPC.SESSION_START, {});
  assert.equal(start.ok, false);
  assert.equal(start.error.code, "E_SESSION_START");
  assert.match(start.error.message, /insecure_scheme/);
});

test("S2: session:start still refuses a renderer-chosen url/jwt", async () => {
  const hijack = await call(IPC.SESSION_START, { url: "wss://evil.example.com", jwt: "x" });
  assert.deepEqual([hijack.ok, hijack.error?.code], [false, "E_INVALID_PAYLOAD"]);
});

}
