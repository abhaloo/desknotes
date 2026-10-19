/**
 * Multi-answer panel manager: lifecycle, geometry and persistence of the two
 * extra answer windows (spec R1/R6/R7/R9/R10).
 *
 * WHY a separate module: `main.mjs` owns the Electron API and window recipes, so
 * this module owns only the feature's state machine and stays testable with
 * BrowserWindow-shaped fakes (no `electron` import). Windows are injected via
 * `createPanelWindow(bounds)`; the `panels` array is mutated in place so the
 * caller's `state.windows.panels` is always the authoritative list.
 *
 * State rules:
 *  - exactly PANEL_COUNT panels while enabled (R9);
 *  - a manual close is a feature-level OFF (R10): the injected
 *    `onPanelsDisabled()` closes the sibling and reports the new state;
 *  - bounds live in `<userData>/panel-bounds.json` and are clamped into live
 *    display work areas on spawn and on display-topology changes (R7).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** R9: the main window plus exactly two answer panels. */
export const PANEL_COUNT = 2;
export const PANEL_BOUNDS_FILE = "panel-bounds.json";

/** Panels smaller than this stop being usable answer surfaces. */
const MIN_WIDTH = 200;
const MIN_HEIGHT = 160;

const noop = () => {};

function errorText(error) {
  if (error instanceof Error) return error.message || error.name;
  return String(error ?? "unknown error");
}

function clamp(value, min, max) {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}

function finite(value, fallback) {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

/**
 * @param {object} deps
 * @param {Array} [deps.panels]  caller-owned array (same reference as `state.windows.panels`)
 * @param {(bounds: {x:number,y:number,width:number,height:number}) => object} deps.createPanelWindow
 * @param {{getPrimaryDisplay: Function, getDisplayMatching?: Function}} deps.screen
 * @param {string|(() => string)} [deps.userDataDir]
 * @param {{width:number,height:number,margin:number,top:number}} [deps.overlay] default size/anchor
 * @param {() => boolean} [deps.getClickThrough]  current global click-through state
 * @param {() => void} [deps.onPanelsDisabled]    injected R10 handler (close sibling + broadcast)
 * @param {(message: string) => void} [deps.log]
 * @returns {{ensurePanels: Function, applyClickThrough: Function, reclampAll: Function, closeAll: Function}}
 */
export function createPanelManager({
  panels = [],
  createPanelWindow,
  screen,
  userDataDir = () => "",
  overlay = { width: 424, height: 860, margin: 16, top: 24 },
  getClickThrough = () => false,
  onPanelsDisabled = noop,
  log = noop,
} = {}) {
  if (typeof createPanelWindow !== "function") {
    throw new TypeError("createPanelManager needs createPanelWindow(bounds)");
  }
  if (!screen || typeof screen.getPrimaryDisplay !== "function") {
    throw new TypeError("createPanelManager needs a screen with getPrimaryDisplay()");
  }

  /** Last known geometry per fixed panel slot (0..PANEL_COUNT-1). */
  const slotBounds = new Map();
  /** Panel window -> slot index, so a manual close cannot shift stored positions. */
  const slotOf = new WeakMap();
  /** Feature state driven through ensurePanels(). */
  let enabled = false;
  /** True while a programmatic close runs: "closed" is then not a user action. */
  let closing = false;

  function directory() {
    const value = typeof userDataDir === "function" ? userDataDir() : userDataDir;
    return typeof value === "string" && value.length > 0 ? value : ".";
  }

  function boundsPath() {
    return join(directory(), PANEL_BOUNDS_FILE);
  }

  function readStoredBounds() {
    try {
      const parsed = JSON.parse(readFileSync(boundsPath(), "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Missing or corrupt file: fall back to the default anchors.
      return [];
    }
  }

  /** Live window rect, or the bounds last captured for its slot. */
  function boundsOf(win) {
    try {
      if (typeof win.getBounds === "function") {
        const live = win.getBounds();
        if (live && typeof live === "object") {
          return {
            x: finite(Number(live.x), 0),
            y: finite(Number(live.y), 0),
            width: Math.max(MIN_WIDTH, finite(Number(live.width), overlay.width)),
            height: Math.max(MIN_HEIGHT, finite(Number(live.height), overlay.height)),
          };
        }
      }
    } catch (error) {
      log(`panel getBounds failed: ${errorText(error)}`);
    }
    return slotBounds.get(slotOf.get(win)) ?? null;
  }

  function persistBounds() {
    for (const win of panels) {
      const slot = slotOf.get(win);
      if (slot === undefined) continue;
      const bounds = boundsOf(win);
      if (bounds) slotBounds.set(slot, bounds);
    }
    // Kept as a fixed-length, index-addressed array: closing panel 0 must not
    // move the surviving panel's stored position into slot 0.
    const stored = [];
    for (let slot = 0; slot < PANEL_COUNT; slot += 1) {
      if (slotBounds.has(slot)) stored[slot] = slotBounds.get(slot);
    }
    try {
      mkdirSync(directory(), { recursive: true });
      writeFileSync(boundsPath(), `${JSON.stringify(stored, null, 2)}\n`);
    } catch (error) {
      log(`panel bounds persist failed: ${errorText(error)}`);
    }
  }

  function displayFor(rect) {
    if (typeof screen.getDisplayMatching === "function") {
      try {
        return screen.getDisplayMatching(rect);
      } catch (error) {
        log(`panel display match failed: ${errorText(error)}`);
      }
    }
    return screen.getPrimaryDisplay();
  }

  /** Clamp a rect into the nearest live work area; never strand a panel off-screen (R7). */
  function clampBounds(bounds = {}) {
    const width = Math.max(MIN_WIDTH, finite(Number(bounds.width), overlay.width));
    const height = Math.max(MIN_HEIGHT, finite(Number(bounds.height), overlay.height));
    const rect = {
      x: finite(Number(bounds.x), 0),
      y: finite(Number(bounds.y), 0),
      width,
      height,
    };
    const { workArea } = displayFor(rect);
    const w = Math.min(width, workArea.width);
    const h = Math.min(height, workArea.height);
    return {
      width: w,
      height: h,
      x: clamp(rect.x, workArea.x, workArea.x + workArea.width - w),
      y: clamp(rect.y, workArea.y, workArea.y + workArea.height - h),
    };
  }

  function defaultBounds(index) {
    const { workArea } = screen.getPrimaryDisplay();
    const width = Math.max(MIN_WIDTH, Math.min(overlay.width, workArea.width));
    const height = Math.max(MIN_HEIGHT, Math.min(overlay.height, workArea.height));
    // Start tucked against the right edge like the overlay; later panels step left.
    const x = workArea.x + workArea.width - width - overlay.margin - index * (width + overlay.margin);
    return clampBounds({ x, y: workArea.y + overlay.top, width, height });
  }

  /** R10: a manual close turns the whole feature off. */
  function handleClosed(win) {
    const index = panels.indexOf(win);
    if (index >= 0) panels.splice(index, 1);
    if (closing || !enabled) return;
    enabled = false;
    try {
      onPanelsDisabled();
    } catch (error) {
      log(`panel disabled callback failed: ${errorText(error)}`);
    }
  }

  function wirePanel(win, bounds, slot) {
    slotOf.set(win, slot);
    slotBounds.set(slot, bounds);
    if (typeof win.on !== "function") return;
    try {
      // "close" still has readable bounds; persist there so a manual close of
      // one panel keeps its slot's last position (R7/R10).
      win.on("close", persistBounds);
      win.on("closed", () => handleClosed(win));
      // Persist drags/resizes as they happen (R7).
      win.on("move", persistBounds);
      win.on("resize", persistBounds);
    } catch (error) {
      log(`panel wiring failed: ${errorText(error)}`);
    }
  }

  function applyClickThrough(nextEnabled) {
    const ignore = Boolean(nextEnabled);
    for (const win of panels) {
      if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) continue;
      try {
        if (typeof win.setIgnoreMouseEvents === "function") {
          // Identical to the overlay: forward:true keeps hover alive while clicks pass through (R6).
          win.setIgnoreMouseEvents(ignore, { forward: true });
        }
      } catch (error) {
        log(`panel click-through failed: ${errorText(error)}`);
      }
    }
  }

  function reclampAll() {
    panels.forEach((win, index) => {
      if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return;
      const slot = slotOf.get(win) ?? index;
      const next = clampBounds(boundsOf(win) ?? defaultBounds(slot));
      slotBounds.set(slot, next);
      try {
        if (typeof win.setBounds === "function") win.setBounds(next);
      } catch (error) {
        log(`panel reclamp failed: ${errorText(error)}`);
      }
    });
  }

  /** Persist, then close every panel. Public API: `closeAll()`. */
  function closeAll() {
    enabled = false;
    persistBounds();
    closing = true;
    try {
      for (const win of [...panels]) {
        try {
          if (typeof win.close === "function") win.close();
          else if (typeof win.destroy === "function") win.destroy();
        } catch (error) {
          log(`panel close failed: ${errorText(error)}`);
        }
      }
      // Fakes may never emit "closed"; the authoritative list is cleared here.
      panels.length = 0;
    } finally {
      closing = false;
    }
  }

  function ensurePanels(nextEnabled) {
    const wanted = Boolean(nextEnabled);
    if (!wanted) {
      if (panels.length === 0 && !enabled) return { enabled: false, count: 0 };
      closeAll();
      return { enabled: false, count: 0 };
    }
    if (enabled && panels.length === PANEL_COUNT) return { enabled: true, count: panels.length };
    enabled = true;
    const stored = readStoredBounds();
    try {
      while (panels.length < PANEL_COUNT) {
        const used = new Set(panels.map((win) => slotOf.get(win)));
        let slot = 0;
        while (used.has(slot)) slot += 1;
        const bounds = clampBounds({ ...defaultBounds(slot), ...(stored[slot] ?? {}) });
        const win = createPanelWindow(bounds);
        if (!win) throw new Error("createPanelWindow returned no window");
        wirePanel(win, bounds, slot);
        panels.push(win);
      }
    } catch (error) {
      // R-errors: log, uncheck, leave the app usable; never half-enable panels.
      log(`panel creation failed: ${errorText(error)}`);
      closeAll();
      return { enabled: false, count: 0 };
    }
    // A panel spawned while click-through is active must pass clicks through.
    applyClickThrough(getClickThrough());
    return { enabled: true, count: panels.length };
  }

  return { ensurePanels, applyClickThrough, reclampAll, closeAll };
}
