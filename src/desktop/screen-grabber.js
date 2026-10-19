/**
 * Off-main-thread screenshot capture (F4).
 *
 * `desktopCapturer.getSources` with a full-size thumbnail runs on Electron's
 * main thread: ~1.9 s for the first call and ~350 ms for every later one,
 * measured on Electron 33 / Windows. The main thread also runs the VAD gate,
 * the audio uplink and the answer-token relay, so every screenshot used to
 * freeze all three.
 *
 * This grabber keeps a hidden, sandboxed renderer that holds one low-rate
 * (2 fps) `getDisplayMedia` stream for the active session. A screenshot is a
 * `drawImage` + JPEG encode inside that renderer: ~13 ms end to end, ~1 ms of
 * main-thread time. The main process only answers the display-media request
 * once per stream, with `thumbnailSize: 0` (no thumbnail work).
 *
 * The stream is opened at session start (`warm`) so the first screenshot is
 * fast too, and closed with the session. Any failure returns null, and the
 * caller falls back to the thumbnail path, so capture never gets worse than
 * before.
 *
 * Pure module (no `electron` import): main.mjs injects the Electron objects,
 * so this is unit-testable under bun.
 */

export const CAPTURE_PARTITION = "mockcopilot-screen-capture";
/** A warm stream that cannot produce a frame within this budget is broken. */
const GRAB_TIMEOUT_MS = 5000;

/**
 * @param {{BrowserWindow: Function, desktopCapturer: object, session: object,
 *   app?: object, pagePath: string, maxWidth?: number, jpegQuality?: number,
 *   log?: Function}} deps
 */
export function createScreenGrabber({
  BrowserWindow,
  desktopCapturer,
  session,
  app,
  pagePath,
  maxWidth = 1920,
  jpegQuality = 85,
  log,
} = {}) {
  const warn = typeof log === "function" ? log : () => {};
  let win = null;
  let ready = null; // Promise<void> while the page loads
  let warmFor = undefined; // display id the live stream was opened for
  let warming = null;
  let wantedDisplay = null;
  let closed = false;
  let onWindowCreated = null;

  function displayMatches(source, displayId) {
    return displayId == null || String(source.display_id) === String(displayId) || String(source.id) === String(displayId);
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return ready;
    const partition = session.fromPartition(CAPTURE_PARTITION);
    // Grants this partition's getDisplayMedia (and nothing else) the wanted
    // screen. thumbnailSize 0 = no thumbnail work on the main thread.
    partition.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const source = sources.find((s) => displayMatches(s, wantedDisplay)) ?? sources[0];
          callback(source ? { video: source } : {});
        })
        .catch((error) => {
          warn(`screen grabber: no source (${error?.message ?? error})`);
          callback({});
        });
    });
    win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      focusable: false,
      paintWhenInitiallyHidden: false,
      title: "",
      webPreferences: {
        session: partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // A hidden window is throttled by default: frames would stall.
        backgroundThrottling: false,
      },
    });
    // A hidden window must never keep the app alive on its own: once every
    // other window is gone, close it so window-all-closed can quit the app.
    const watch = (other) => {
      if (other === win) return;
      other.once?.("closed", () => {
        if (closed || !win || win.isDestroyed()) return;
        const others = (BrowserWindow.getAllWindows?.() ?? []).filter((w) => w !== win && !w.isDestroyed());
        if (others.length === 0) close();
      });
    };
    for (const other of BrowserWindow.getAllWindows?.() ?? []) watch(other);
    if (!onWindowCreated && typeof app?.on === "function") {
      onWindowCreated = (_event, other) => watch(other);
      app.on("browser-window-created", onWindowCreated);
    }
    win.on?.("closed", () => {
      win = null;
      ready = null;
      warmFor = undefined;
    });
    ready = Promise.resolve(win.loadFile(pagePath));
    return ready;
  }

  async function run(code, userGesture = false) {
    await ensureWindow();
    if (!win || win.isDestroyed()) throw new Error("capture window gone");
    let timer;
    try {
      return await Promise.race([
        win.webContents.executeJavaScript(code, userGesture),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("screen grab timed out")), GRAB_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Open (or re-target) the live stream. Resolves true when it is ready. */
  async function warm({ display } = {}) {
    if (closed) return false;
    const displayId = display?.id ?? null;
    if (warmFor !== undefined && String(warmFor) === String(displayId)) return true;
    if (warming) return warming;
    warming = (async () => {
      try {
        wantedDisplay = displayId;
        // getDisplayMedia needs transient activation: userGesture = true.
        await run(`window.captureWarm(${Number(maxWidth)})`, true);
        warmFor = displayId;
        return true;
      } catch (error) {
        warn(`screen grabber warm failed: ${error?.message ?? error}`);
        warmFor = undefined;
        return false;
      } finally {
        warming = null;
      }
    })();
    return warming;
  }

  /**
   * Same contract as ScreenCapture.capture: `{bytes, contentType, width,
   * height}` or null (the caller then falls back to the thumbnail path).
   */
  async function capture({ display } = {}) {
    if (closed) return null;
    try {
      if (!(await warm({ display }))) return null;
      const shot = await run(`window.captureGrab(${Number(maxWidth)}, ${Number(jpegQuality) / 100})`);
      if (!shot || !shot.bytes || !shot.width) return null;
      const bytes = shot.bytes instanceof Uint8Array ? shot.bytes : new Uint8Array(shot.bytes);
      return { bytes, contentType: "image/jpeg", width: shot.width, height: shot.height };
    } catch (error) {
      warn(`screen grabber capture failed: ${error?.message ?? error}`);
      warmFor = undefined; // re-open the stream next time
      return null;
    }
  }

  /** Stop the stream and drop the window (session end / app quit). */
  function close() {
    closed = true;
    warmFor = undefined;
    if (onWindowCreated) {
      app?.removeListener?.("browser-window-created", onWindowCreated);
      onWindowCreated = null;
    }
    const current = win;
    win = null;
    ready = null;
    if (current && !current.isDestroyed()) {
      try {
        current.destroy();
      } catch {
        /* already gone */
      }
    }
  }

  return { warm, capture, close, get closed() { return closed; } };
}
