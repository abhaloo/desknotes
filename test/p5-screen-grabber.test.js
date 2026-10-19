import test from "node:test";
import assert from "node:assert/strict";
import { createScreenGrabber } from "../src/desktop/screen-grabber.js";

/** Electron doubles: a hidden window whose page answers captureWarm/captureGrab. */
function fakes({ failWarm = false, failGrab = false } = {}) {
  const calls = { exec: [], handler: null, windows: [], getSources: [] };
  const appListeners = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.handlers = {};
      calls.windows.push(this);
      this.webContents = {
        executeJavaScript: async (code, gesture) => {
          calls.exec.push({ code, gesture });
          if (code.startsWith("window.captureWarm")) {
            if (failWarm) throw new Error("NotAllowedError");
            // The page asks main for a source, as getDisplayMedia would.
            await new Promise((resolve) => calls.handler({}, resolve));
            return true;
          }
          if (code.startsWith("window.captureGrab")) {
            if (failGrab) throw new Error("capture stream not warm");
            return { bytes: new Uint8Array([0xff, 0xd8, 1, 2]), width: 1920, height: 1080 };
          }
          return null;
        },
      };
    }
    static getAllWindows() {
      return calls.windows.filter((w) => !w.destroyed);
    }
    loadFile(path) {
      this.loaded = path;
      return Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    on(event, fn) {
      this.handlers[event] = fn;
    }
    once(event, fn) {
      this.handlers[event] = fn;
    }
    destroy() {
      this.destroyed = true;
      this.handlers.closed?.();
    }
  }
  const session = {
    fromPartition: (name) => ({
      name,
      setDisplayMediaRequestHandler(fn) {
        calls.handler = fn;
      },
    }),
  };
  const desktopCapturer = {
    async getSources(options) {
      calls.getSources.push(options);
      return [
        { id: "screen:1", display_id: "100" },
        { id: "screen:2", display_id: "200" },
      ];
    },
  };
  const app = {
    on: (event, fn) => appListeners.push({ event, fn }),
    removeListener: (event, fn) => {
      const i = appListeners.findIndex((l) => l.fn === fn);
      if (i >= 0) appListeners.splice(i, 1);
    },
  };
  return { calls, BrowserWindow: FakeWindow, session, desktopCapturer, app, appListeners };
}

function grabber(f, extra = {}) {
  return createScreenGrabber({
    BrowserWindow: f.BrowserWindow,
    desktopCapturer: f.desktopCapturer,
    session: f.session,
    app: f.app,
    pagePath: "/x/capture.html",
    ...extra,
  });
}

test("warm opens one hidden, sandboxed capture window; the source costs no thumbnail", async () => {
  const f = fakes();
  const g = grabber(f);
  assert.equal(await g.warm(), true);
  assert.equal(f.calls.windows.length, 1);
  const [win] = f.calls.windows;
  assert.equal(win.options.show, false);
  assert.equal(win.options.skipTaskbar, true);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.backgroundThrottling, false);
  assert.equal(win.loaded, "/x/capture.html");
  assert.deepEqual(f.calls.getSources[0].thumbnailSize, { width: 0, height: 0 }, "no thumbnail work on main");
  assert.equal(f.calls.exec[0].gesture, true, "getDisplayMedia needs transient activation");
  assert.equal(await g.warm(), true);
  assert.equal(f.calls.exec.length, 1, "an already-warm stream is reused");
  g.close();
});

test("capture returns the ScreenCapture shape from the live stream", async () => {
  const f = fakes();
  const g = grabber(f);
  const shot = await g.capture();
  assert.deepEqual(shot, { bytes: new Uint8Array([0xff, 0xd8, 1, 2]), contentType: "image/jpeg", width: 1920, height: 1080 });
  assert.match(f.calls.exec.at(-1).code, /captureGrab\(1920, 0\.85\)/);
  g.close();
});

test("a requested display is honoured (re-warmed onto that screen)", async () => {
  const f = fakes();
  const g = grabber(f);
  await g.warm();
  let granted = null;
  const handler = f.calls.handler;
  f.calls.handler = (req, cb) => handler(req, (grant) => cb((granted = grant)));
  await g.capture({ display: { id: 200 } });
  assert.equal(granted.video.id, "screen:2");
  g.close();
});

test("failures return null so the caller falls back to the thumbnail path", async () => {
  const warmFails = grabber(fakes({ failWarm: true }));
  assert.equal(await warmFails.capture(), null);
  warmFails.close();
  const grabFails = grabber(fakes({ failGrab: true }));
  assert.equal(await grabFails.capture(), null);
  grabFails.close();
});

test("close destroys the window and stops capturing; the hidden window never outlives the app's windows", async () => {
  const f = fakes();
  const g = grabber(f);
  const appWindow = new f.BrowserWindow({ show: true }); // e.g. the overlay
  await g.warm();
  const capWin = f.calls.windows[1];
  // The last visible window closes: the capture window must go too.
  appWindow.destroyed = true;
  appWindow.handlers.closed();
  assert.equal(capWin.destroyed, true);
  assert.equal(g.closed, true);
  assert.equal(await g.capture(), null);
  assert.equal(f.appListeners.length, 0, "no app listener leaks across sessions");
});
