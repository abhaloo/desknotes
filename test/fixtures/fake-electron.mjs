/**
 * Minimal stand-in for the `electron` module so the REAL src/desktop/main.mjs
 * can boot under Electron's bundled Node (ELECTRON_RUN_AS_NODE) without a
 * display. Only the surface main.mjs touches is implemented; IPC handlers
 * and renderer broadcasts are recorded so a driver can exercise the shell's
 * session wiring exactly the way the preload bridge does.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ipcHandlers = new Map();
export const sent = []; // { windowId, channel, payload, at }
export const quitCalls = []; // one timestamp per app.quit()
export const registeredShortcuts = []; // every globalShortcut.register accelerator
const appListeners = new Map();
const windows = [];
let nextId = 1;

export const app = {
  isPackaged: false, // dev run
  commandLine: { appendSwitch() {}, hasSwitch: () => false },
  requestSingleInstanceLock: () => true,
  exit() {},
  on(event, fn) {
    if (!appListeners.has(event)) appListeners.set(event, []);
    appListeners.get(event).push(fn);
    return app;
  },
  whenReady: () => Promise.resolve(),
  quit() {
    quitCalls.push(Date.now());
  },
  dock: undefined,
  getPath(name) {
    return join(tmpdir(), "mock-sales-copilot-electron", String(name ?? "userData"));
  },
  emit(event, ...args) {
    for (const fn of appListeners.get(event) ?? []) fn(...args);
  },
};

export class BrowserWindow {
  constructor(options = {}) {
    this.id = nextId++;
    this.options = options;
    this.visible = false;
    this.destroyed = false;
    this.loaded = null;
    // Recorded, never fired automatically: a driver can inspect what main.mjs
    // attached (navigation pins, close handlers) and fire one on purpose.
    this.listeners = new Map();
    this.skipTaskbar = false;
    const contentsListeners = new Map();
    this.webContents = {
      id: this.id,
      session: options.webPreferences?.session ?? session.defaultSession,
      listeners: contentsListeners,
      send: (channel, payload) => sent.push({ windowId: this.id, channel, payload, at: Date.now() }),
      on(event, fn) {
        if (!contentsListeners.has(event)) contentsListeners.set(event, []);
        contentsListeners.get(event).push(fn);
      },
      setWindowOpenHandler() {},
      reload() {},
      closeDevTools() {},
      openDevTools() {},
    };
    windows.push(this);
    for (const fn of appListeners.get("web-contents-created") ?? []) fn({}, this.webContents);
    for (const fn of appListeners.get("browser-window-created") ?? []) fn({}, this);
  }

  static getAllWindows() {
    return windows.filter((w) => !w.destroyed);
  }

  loadFile(path, options = {}) {
    this.loaded = { path, options };
    return Promise.resolve();
  }
  once() {}
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  /** User closed the window: destroyed, then "closed" listeners run (Electron order). */
  close() {
    this.destroyed = true;
    this.visible = false;
    for (const fn of this.listeners.get("closed") ?? []) fn();
  }
  isMinimized() {
    return false;
  }
  restore() {}
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  show() {
    this.visible = true;
  }
  showInactive() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setOpacity() {}
  focus() {}
  getNativeWindowHandle() {
    return Buffer.alloc(8);
  }
  setSkipTaskbar(on) {
    this.skipTaskbar = Boolean(on);
  }
  setIgnoreMouseEvents() {}
}

function fakeImage(width, height) {
  const jpeg = Buffer.alloc(2048);
  for (let i = 0; i < jpeg.length; i += 1) jpeg[i] = (i * 31 + width) & 0xff;
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  return {
    getSize: () => ({ width, height }),
    resize: () => fakeImage(width, height),
    toJPEG: () => jpeg,
  };
}

export const desktopCapturer = {
  async getSources() {
    return [{ id: "screen:0", name: "Screen", thumbnail: fakeImage(1280, 720) }];
  },
};

export const globalShortcut = {
  register: (accelerator) => {
    registeredShortcuts.push(accelerator);
    return true;
  },
  unregister() {},
  unregisterAll() {},
};

export const ipcMain = {
  handle(channel, fn) {
    ipcHandlers.set(channel, fn);
  },
};

export const screen = {
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  on() {},
};

export const Menu = { setApplicationMenu() {} };
export const powerMonitor = { on() {} };
/** Sessions: the hardening installs permission/request handlers; the screen grabber a display-media handler. */
function fakeSession(name) {
  return {
    name,
    setPermissionRequestHandler(fn) {
      this.permissionRequest = fn;
    },
    setPermissionCheckHandler(fn) {
      this.permissionCheck = fn;
    },
    setDisplayMediaRequestHandler(fn) {
      this.displayMedia = fn;
    },
    webRequest: {
      onBeforeRequest(fn) {
        this.beforeRequest = fn;
      },
    },
  };
}
const partitions = new Map();
export const session = {
  defaultSession: fakeSession("default"),
  fromPartition(name) {
    if (!partitions.has(name)) partitions.set(name, fakeSession(name));
    return partitions.get(name);
  },
};

/** Native file picker: records each call; a driver sets the next result. */
export const dialogCalls = [];
let dialogResult = { canceled: true, filePaths: [] };
export function setDialogResult(result) {
  dialogResult = result;
}
export const dialog = {
  async showOpenDialog(...args) {
    const hasParent = args.length > 1;
    dialogCalls.push({ hasParent, options: hasParent ? args[1] : args[0] });
    return dialogResult;
  },
};

/** shell.openPath: records each folder; a driver sets the next result ("" = opened). */
export const openPathCalls = [];
let openPathResult = "";
export function setOpenPathResult(result) {
  openPathResult = result;
}
export const shell = {
  async openPath(target) {
    openPathCalls.push(target);
    return openPathResult;
  },
};

export const contextBridge = { exposeInMainWorld() {} };
export const ipcRenderer = { invoke() {}, on() {}, removeListener() {} };

/** The IPC event Electron delivers for a call from window `id`'s top-level page. */
export function ipcEvent(id = 1) {
  const win = windows.find((w) => w.id === id);
  const loaded = win?.loaded;
  const query = new URLSearchParams(loaded?.options?.query ?? {}).toString();
  const url = loaded ? `${pathToFileURL(loaded.path).href}${query ? `?${query}` : ""}` : "about:blank";
  return { sender: { id }, senderFrame: { url, parent: null } };
}

/** Fire a webContents event (e.g. "before-input-event") on window `id`. */
export function emitWebContents(id, event, ...args) {
  const win = windows.find((w) => w.id === id);
  for (const fn of win?.webContents.listeners.get(event) ?? []) fn(...args);
}

/** What `ipcRenderer.invoke(channel, payload)` resolves to in the renderer. */
export async function invoke(channel, payload = null) {
  return invokeFrom(1, channel, payload);
}

/** The same call made from window `id`'s top-level page (sender checks see its URL). */
export async function invokeFrom(id, channel, payload = null) {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler(ipcEvent(id), payload);
}

export default { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, powerMonitor, screen, session, shell, contextBridge, ipcRenderer };

