/**
 * Adjustable boxes in the Sales Assistant window (control and overlay modes).
 *
 * Two splitters: one between the STREAMING ANSWER card and the transcript
 * lanes, one between the PROSPECT and YOU lanes. Each stores a share (0..1)
 * of the space the two boxes have together, not pixels, so a saved layout fits
 * any window size. CSS turns a share into flex-grow / grid `fr` weights with
 * pixel floors (styles.css, `.split-answer` / `.split-lanes`), so the boxes
 * keep their minimum sizes and re-clamp on every window resize without script;
 * whatever still does not fit scrolls in `.panel-scroll`, as before.
 *
 * Without a saved share the layout is the default one, unchanged. Double-click
 * a splitter (or press Enter on it) to go back to the default. Arrow keys move
 * a focused splitter by 5%, Page Up / Page Down by 15%, Home / End to the
 * limits. Shares persist per window mode in localStorage; storage can be
 * missing or throw (sandbox, private profile), which only means the layout is
 * not remembered.
 *
 * The pure helpers below run under bun without a DOM.
 */

export const LAYOUT_STORAGE_PREFIX = "desknotes.layout.v1.";
export const SPLITS = Object.freeze(["answer", "prospect"]);
/** Shares outside this range are not a layout anyone dragged to: ignore them. */
const SHARE_FLOOR = 0.01;
const SHARE_CEIL = 0.99;
const KEY_STEPS = Object.freeze({ ArrowUp: -0.05, ArrowDown: 0.05, PageUp: -0.15, PageDown: 0.15 });

function validShare(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= SHARE_FLOOR && value <= SHARE_CEIL ? value : null;
}

/** A stored layout string as `{answer, prospect}`, each a share or null. Never throws. */
export function parseLayout(raw) {
  let parsed = null;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  return { answer: validShare(source.answer), prospect: validShare(source.prospect) };
}

/** The layout to store, or null when both splits are at their defaults. */
export function serializeLayout(layout = {}) {
  const out = {};
  for (const name of SPLITS) {
    const share = validShare(layout[name]);
    if (share !== null) out[name] = Math.round(share * 10_000) / 10_000;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/**
 * The share range the two boxes allow right now: the first box keeps `minA`
 * pixels and the second `minB` out of `total`. Null when they cannot both fit
 * (the window is too short to resize anything; the outer column scrolls).
 */
export function shareBounds({ total, minA = 0, minB = 0 } = {}) {
  if (!(total > 0) || minA + minB > total) return null;
  return { min: minA / total, max: (total - minB) / total };
}

export function clampShare(share, bounds) {
  if (!bounds || !Number.isFinite(share)) return null;
  return Math.min(bounds.max, Math.max(bounds.min, share));
}

/** The share for a drag: `offset` pixels from the first box's top edge. */
export function shareFromOffset({ offset, total, minA, minB }) {
  return clampShare(offset / total, shareBounds({ total, minA, minB }));
}

/**
 * The result of a key on a focused splitter: a new share, "reset", or null
 * (not a splitter key, or nothing can move).
 */
export function shareFromKey(key, current, { total, minA, minB }) {
  if (key === "Enter") return "reset";
  const bounds = shareBounds({ total, minA, minB });
  if (!bounds) return null;
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;
  if (!Object.hasOwn(KEY_STEPS, key)) return null;
  return clampShare(current + KEY_STEPS[key], bounds);
}

/** localStorage-backed store for one window mode; every access is guarded. */
export function createLayoutStore(storage, mode) {
  const key = `${LAYOUT_STORAGE_PREFIX}${mode}`;
  return {
    key,
    read() {
      try {
        return parseLayout(storage?.getItem(key) ?? null);
      } catch {
        return parseLayout(null);
      }
    },
    write(layout) {
      try {
        const body = serializeLayout(layout);
        if (body === null) storage?.removeItem(key);
        else storage?.setItem(key, body);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/* ------------------------------------------------------------- DOM wiring */

/** Vertical padding plus border of a box, in pixels. */
function boxChrome(win, node) {
  try {
    const style = win.getComputedStyle(node);
    return ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"]
      .map((property) => Number.parseFloat(style[property]) || 0)
      .reduce((sum, value) => sum + value, 0);
  } catch {
    return 0;
  }
}

function safeStorage(win) {
  try {
    return win.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A pixel custom property from :root (styles.css owns the minimum sizes). */
function cssPixels(win, doc, name, fallback) {
  try {
    const value = Number.parseFloat(win.getComputedStyle(doc.documentElement).getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Wire both splitters. Panel windows (multi-answer) keep the fixed layout.
 * @param {{document: Document, window: Window, mode: string}} deps
 */
export function installSplitters({ document: doc, window: win, mode }) {
  if (mode !== "control" && mode !== "overlay") return null;
  const scroll = doc.querySelector(".panel-scroll");
  const card = doc.querySelector(".answer-card");
  const lanes = doc.querySelector(".lanes");
  const prospect = doc.querySelector('.lane[data-lane="prospect"]');
  const rep = doc.querySelector('.lane[data-lane="rep"]');
  const answerSplit = doc.getElementById("split-answer");
  const laneSplit = doc.getElementById("split-lanes");
  if (!scroll || !card || !lanes || !prospect || !rep || !answerSplit || !laneSplit) return null;

  const store = createLayoutStore(safeStorage(win), mode);
  const layout = store.read();

  // Each split: the two boxes, the element whose CSS variables carry the share.
  const splits = {
    answer: {
      handle: answerSplit,
      first: card,
      second: lanes,
      host: scroll,
      className: "split-answer",
      fixed: true,
      mins: ["--answer-min", "--lanes-min"],
      apply(share) {
        scroll.style.setProperty("--answer-grow", String(share * 100));
        scroll.style.setProperty("--lanes-grow", String((1 - share) * 100));
      },
    },
    prospect: {
      handle: laneSplit,
      first: prospect,
      second: rep,
      host: lanes,
      className: "split-lanes",
      fixed: false,
      mins: ["--lane-min", "--lane-min"],
      apply(share) {
        // fr cannot go through calc(), so the unit travels with the weight.
        lanes.style.setProperty("--prospect-fr", `${share * 100}fr`);
        lanes.style.setProperty("--rep-fr", `${(1 - share) * 100}fr`);
      },
    },
  };

  /**
   * The two boxes as the share sees them. A flex item never shrinks below its
   * own padding and border, so with flex-basis 0 the card is `pad + share *
   * (space - pads)` tall: the share is measured on the space without them.
   * Grid rows carry no such offset (`fixed: false`).
   */
  function measure(split) {
    const a = split.first.getBoundingClientRect();
    const b = split.second.getBoundingClientRect();
    const padA = split.fixed ? boxChrome(win, split.first) : 0;
    const padB = split.fixed ? boxChrome(win, split.second) : 0;
    return {
      top: a.top + padA,
      height: a.height - padA,
      total: a.height + b.height - padA - padB,
      // The handle and its gaps belong to neither box.
      between: Math.max(0, b.top - a.bottom),
      minA: cssPixels(win, doc, split.mins[0], 0) - padA,
      minB: cssPixels(win, doc, split.mins[1], 0) - padB,
    };
  }

  function render(name) {
    const split = splits[name];
    const share = layout[name];
    split.host.classList.toggle(split.className, share !== null);
    if (share !== null) split.apply(share);
    // For assistive tech: the first box's share, as a percentage.
    const shown = share ?? currentShare(split);
    split.handle.setAttribute("aria-valuenow", String(Math.round(shown * 100)));
  }

  function currentShare(split) {
    const { height, total } = measure(split);
    return total > 0 ? height / total : 0.5;
  }

  function set(name, share, { persist = true } = {}) {
    layout[name] = share === null ? null : validShare(share);
    render(name);
    if (persist) store.write(layout);
  }

  /**
   * Switch a split from the default layout to a share without moving
   * anything: the boxes can have a different combined height once they share
   * the space by weight, so the first box's current height is re-expressed
   * against the new total. Returns the measurement to drag against.
   */
  function enterSplit(name) {
    const split = splits[name];
    if (layout[name] !== null) return measure(split);
    const before = measure(split);
    if (!(before.total > 0)) return before;
    set(name, before.height / before.total, { persist: false });
    const after = measure(split);
    const share = clampShare(before.height / after.total, shareBounds(after));
    if (share !== null) set(name, share, { persist: false });
    return measure(split);
  }

  for (const [name, split] of Object.entries(splits)) {
    const { handle } = split;
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (!shareBounds(measure(split))) return;
      event.preventDefault();
      const wasDefault = layout[name] === null;
      const box = enterSplit(name);
      handle.focus?.({ preventScroll: true });
      handle.setPointerCapture?.(event.pointerId);
      // Keep the grab point under the pointer: offset from the handle centre.
      const handleRect = handle.getBoundingClientRect();
      drag = { box, wasDefault, moved: false, startY: event.clientY, grab: event.clientY - (handleRect.top + handleRect.height / 2) };
      doc.body.classList.add("is-resizing");
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const { box, grab } = drag;
      if (Math.abs(event.clientY - drag.startY) < 2 && !drag.moved) return;
      drag.moved = true;
      // The first box ends where the handle's gap starts.
      const offset = event.clientY - grab - box.top - box.between / 2;
      const share = shareFromOffset({ offset, total: box.total, minA: box.minA, minB: box.minB });
      if (share !== null) set(name, share, { persist: false });
    });
    const end = (event) => {
      if (!drag) return;
      const { wasDefault, moved } = drag;
      drag = null;
      handle.releasePointerCapture?.(event.pointerId);
      doc.body.classList.remove("is-resizing");
      // A click that did not move keeps the default layout (and a double-click resets).
      if (wasDefault && !moved) set(name, null, { persist: false });
      else store.write(layout);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
    handle.addEventListener("dblclick", () => set(name, null));
    handle.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const preview = shareFromKey(event.key, layout[name] ?? currentShare(split), measure(split));
      if (preview === null) return;
      event.preventDefault();
      if (preview === "reset") {
        set(name, null);
        return;
      }
      const box = enterSplit(name);
      const next = shareFromKey(event.key, layout[name], box);
      if (typeof next === "number") set(name, next);
    });
  }

  for (const name of SPLITS) render(name);
  // aria-valuenow follows the default layout as the window resizes.
  win.addEventListener("resize", () => {
    for (const name of SPLITS) if (layout[name] === null) render(name);
  });
  return {
    layout: () => ({ ...layout }),
    reset() {
      for (const name of SPLITS) set(name, null);
    },
  };
}
