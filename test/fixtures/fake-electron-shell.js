/**
 * A fake `electron` module for driving `src/desktop/main.mjs` under `bun test`:
 * windows, web contents, sessions, IPC handlers and shortcuts, with every
 * window call recorded in order. test/fixtures/fake-electron.mjs is the
 * session-wiring fake.
 */
import { EventEmitter } from "node:events";

export function createFakeElectron({ isPackaged = true } = {}) {
  const calls = []; // global, ordered log: [windowTag, method, ...args]
  let nextWcId = 1;
  const windows = [];

  const app = new EventEmitter();
  app.isPackaged = isPackaged;
  app.switches = [];
  app.commandLine = {
    appendSwitch: (name, value) => app.switches.push(value === undefined ? name : `${name}=${value}`),
    hasSwitch: (name) => (app.presentSwitches ?? []).includes(name),
  };
  app.requestSingleInstanceLock = () => true;
  app.exitCode = null;
  app.exit = (code) => {
    app.exitCode = code;
    calls.push(["app", "exit", code]);
  };
  app.quit = () => calls.push(["app", "quit"]);
  app.whenReady = () => Promise.resolve();
  app.dock = undefined;

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
  const session = {
    defaultSession: fakeSession("default"),
    fromPartition(name) {
      if (!partitions.has(name)) partitions.set(name, fakeSession(name));
      return partitions.get(name);
    },
  };

  class FakeWebContents extends EventEmitter {
    constructor(win) {
      super();
      this.id = nextWcId++;
      this.win = win;
      this.session = win.options.webPreferences?.session ?? session.defaultSession;
      this.sent = [];
      this.devToolsOpen = false;
      this.windowOpenHandler = null;
    }
    send(channel, payload) {
      this.sent.push([channel, payload]);
    }
    setWindowOpenHandler(fn) {
      this.windowOpenHandler = fn;
    }
    reload() {
      this.win.record("reload");
    }
    closeDevTools() {
      this.devToolsOpen = false;
      this.win.record("closeDevTools");
    }
    openDevTools(options) {
      this.devToolsOpen = true;
      this.win.record("openDevTools", options);
    }
  }

  class BrowserWindow extends EventEmitter {
    static getAllWindows() {
      return windows.filter((w) => !w.destroyed);
    }

    constructor(options = {}) {
      super();
      this.options = options;
      this.tag = options.frame === false ? "overlay" : "main";
      this.visible = false;
      this.destroyed = false;
      this.opacity = typeof options.opacity === "number" ? options.opacity : 1;
      this.loaded = null;
      this.webContents = new FakeWebContents(this);
      windows.push(this);
      app.emit("web-contents-created", {}, this.webContents);
      app.emit("browser-window-created", {}, this);
    }

    record(method, ...args) {
      calls.push([this.tag, method, ...args]);
    }

    show() {
      this.visible = true;
      this.record("show");
      this.emit("show");
    }
    showInactive() {
      this.visible = true;
      this.record("showInactive");
      this.emit("show");
    }
    hide() {
      this.visible = false;
      this.record("hide");
      this.emit("hide");
    }
    focus() {
      this.record("focus");
    }
    setOpacity(value) {
      this.opacity = value;
      this.record("setOpacity", value);
    }
    setSkipTaskbar(value) {
      this.record("setSkipTaskbar", value);
    }
    setAlwaysOnTop(...args) {
      this.record("setAlwaysOnTop", ...args);
    }
    setVisibleOnAllWorkspaces(...args) {
      this.record("setVisibleOnAllWorkspaces", ...args);
    }
    setIgnoreMouseEvents(...args) {
      this.record("setIgnoreMouseEvents", ...args);
    }
    loadFile(path, options) {
      this.loaded = { path, options };
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    getTitle() {
      return this.options.title ?? "";
    }
  }

  const shortcuts = new Map();
  const globalShortcut = {
    register(accelerator, callback) {
      shortcuts.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      shortcuts.delete(accelerator);
    },
    unregisterAll() {
      shortcuts.clear();
    },
  };

  const ipcHandlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      ipcHandlers.set(channel, handler);
    },
  };

  const Menu = {
    applicationMenu: "default",
    setApplicationMenu(menu) {
      Menu.applicationMenu = menu;
      calls.push(["app", "setApplicationMenu", menu]);
    },
  };

  const screen = new EventEmitter();
  screen.getPrimaryDisplay = () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } });
  const powerMonitor = new EventEmitter();

  const electron = {
    app,
    BrowserWindow,
    desktopCapturer: {},
    // The grounding loader's open-file picker; these tests never click Load.
    dialog: {
      async showOpenDialog() {
        calls.push(["dialog", "showOpenDialog"]);
        return { canceled: true, filePaths: [] };
      },
    },
    globalShortcut,
    ipcMain,
    Menu,
    powerMonitor,
    screen,
    session,
    // "Open settings folder"; these tests never click it.
    shell: {
      async openPath(target) {
        calls.push(["shell", "openPath", target]);
        return "";
      },
    },
  };

  return {
    electron,
    calls,
    windows,
    shortcuts,
    ipcHandlers,
    byTag(tag) {
      return windows.find((w) => w.tag === tag && !w.destroyed);
    },
  };
}
