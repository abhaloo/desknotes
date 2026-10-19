import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LAYOUT_STORAGE_PREFIX,
  clampShare,
  createLayoutStore,
  installSplitters,
  parseLayout,
  serializeLayout,
  shareBounds,
  shareFromKey,
  shareFromOffset,
} from "../src/desktop/renderer/layout-splitters.js";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop");
const read = (relative) => readFileSync(join(desktop, relative), "utf8");

/* ------------------------------------------------------------ pure helpers */

test("parseLayout keeps only sane shares and never throws", () => {
  assert.deepEqual(parseLayout('{"answer":0.4,"prospect":0.6}'), { answer: 0.4, prospect: 0.6 });
  assert.deepEqual(parseLayout('{"answer":0.4}'), { answer: 0.4, prospect: null });
  for (const raw of [null, undefined, "", "{", "[]", "42", '"x"', '{"answer":"0.4"}', '{"answer":-1,"prospect":2}', '{"answer":0}', '{"answer":1}']) {
    assert.deepEqual(parseLayout(raw), { answer: null, prospect: null }, String(raw));
  }
  assert.deepEqual(parseLayout('{"answer":NaN}'), { answer: null, prospect: null });
});

test("serializeLayout rounds, drops defaults, and is null when everything is default", () => {
  assert.equal(serializeLayout({ answer: 0.123456, prospect: null }), '{"answer":0.1235}');
  assert.equal(serializeLayout({ answer: null, prospect: null }), null);
  assert.equal(serializeLayout({}), null);
  assert.deepEqual(parseLayout(serializeLayout({ answer: 0.3, prospect: 0.7 })), { answer: 0.3, prospect: 0.7 });
});

test("shares are clamped by the pixel floors of both boxes", () => {
  assert.deepEqual(shareBounds({ total: 600, minA: 120, minB: 160 }), { min: 0.2, max: (600 - 160) / 600 });
  assert.equal(shareBounds({ total: 200, minA: 120, minB: 160 }), null, "too short to resize: nothing moves");
  assert.equal(shareBounds({ total: 0 }), null);
  assert.equal(clampShare(0.05, { min: 0.2, max: 0.7 }), 0.2);
  assert.equal(clampShare(0.9, { min: 0.2, max: 0.7 }), 0.7);
  assert.equal(clampShare(Number.NaN, { min: 0.2, max: 0.7 }), null);
  assert.equal(shareFromOffset({ offset: 300, total: 600, minA: 120, minB: 160 }), 0.5);
  assert.equal(shareFromOffset({ offset: 10, total: 600, minA: 120, minB: 160 }), 0.2);
  assert.equal(shareFromOffset({ offset: 590, total: 600, minA: 120, minB: 160 }), 440 / 600);
});

test("splitter keys: arrows step 5%, pages 15%, Home/End go to the limits, Enter resets", () => {
  const box = { total: 1000, minA: 100, minB: 100 };
  assert.equal(shareFromKey("ArrowDown", 0.5, box), 0.55);
  assert.equal(shareFromKey("ArrowUp", 0.5, box), 0.45);
  assert.equal(shareFromKey("PageDown", 0.5, box), 0.65);
  assert.equal(shareFromKey("PageUp", 0.5, box), 0.35);
  assert.equal(shareFromKey("Home", 0.5, box), 0.1);
  assert.equal(shareFromKey("End", 0.5, box), 0.9);
  assert.equal(shareFromKey("ArrowDown", 0.89, box), 0.9, "clamped");
  assert.equal(shareFromKey("Enter", 0.5, box), "reset");
  assert.equal(shareFromKey("a", 0.5, box), null);
  assert.equal(shareFromKey("ArrowLeft", 0.5, box), null, "the splitters are horizontal");
  assert.equal(shareFromKey("ArrowDown", 0.5, { total: 100, minA: 100, minB: 100 }), null);
});

test("the layout store is per window mode and survives storage that throws", () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  const control = createLayoutStore(storage, "control");
  const overlay = createLayoutStore(storage, "overlay");
  assert.equal(control.key, `${LAYOUT_STORAGE_PREFIX}control`);
  assert.equal(control.write({ answer: 0.4, prospect: null }), true);
  assert.deepEqual(control.read(), { answer: 0.4, prospect: null });
  assert.deepEqual(overlay.read(), { answer: null, prospect: null }, "modes do not share a layout");
  control.write({ answer: null, prospect: null });
  assert.equal(data.has(control.key), false, "back to defaults removes the key");

  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  const store = createLayoutStore(broken, "control");
  assert.deepEqual(store.read(), { answer: null, prospect: null });
  assert.equal(store.write({ answer: 0.4 }), false);
  assert.deepEqual(createLayoutStore(null, "control").read(), { answer: null, prospect: null });
});

/* ----------------------------------------------------- DOM wiring (fake) */

class FakeElement {
  constructor(id, rect) {
    this.id = id;
    this.rect = rect;
    this.attrs = {};
    this.listeners = {};
    this.vars = {};
    this.classes = new Set();
    this.classList = {
      toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)),
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
    };
    this.style = { setProperty: (name, value) => (this.vars[name] = value) };
  }
  getBoundingClientRect() {
    const { top, height } = this.rect;
    return { top, height, bottom: top + height, left: 0, width: 400 };
  }
  setAttribute(name, value) {
    this.attrs[name] = value;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type, event = {}) {
    const full = { preventDefault() { this.defaultPrevented = true; }, ...event };
    for (const fn of this.listeners[type] ?? []) fn(full);
    return full;
  }
  focus() {}
  setPointerCapture() {}
  releasePointerCapture() {}
}

function fakePage({ storage } = {}) {
  const nodes = {
    scroll: new FakeElement("scroll", { top: 0, height: 700 }),
    card: new FakeElement("card", { top: 0, height: 200 }),
    splitA: new FakeElement("split-answer", { top: 204, height: 10 }),
    lanes: new FakeElement("lanes", { top: 218, height: 400 }),
    prospect: new FakeElement("prospect", { top: 218, height: 196 }),
    splitL: new FakeElement("split-lanes", { top: 414, height: 8 }),
    rep: new FakeElement("rep", { top: 422, height: 196 }),
    body: new FakeElement("body", { top: 0, height: 700 }),
    root: new FakeElement("root", { top: 0, height: 700 }),
  };
  const selectors = {
    ".panel-scroll": nodes.scroll,
    ".answer-card": nodes.card,
    ".lanes": nodes.lanes,
    '.lane[data-lane="prospect"]': nodes.prospect,
    '.lane[data-lane="rep"]': nodes.rep,
  };
  const doc = {
    body: nodes.body,
    documentElement: nodes.root,
    querySelector: (s) => selectors[s] ?? null,
    getElementById: (id) => ({ "split-answer": nodes.splitA, "split-lanes": nodes.splitL })[id] ?? null,
  };
  const mins = { "--answer-min": "120px", "--lanes-min": "160px", "--lane-min": "56px" };
  const win = {
    get localStorage() {
      if (storage === "throws") throw new Error("SecurityError");
      return storage;
    },
    getComputedStyle: (node) => (node === nodes.root ? { getPropertyValue: (name) => mins[name] ?? "" } : { paddingTop: "0px", paddingBottom: "0px", borderTopWidth: "0px", borderBottomWidth: "0px" }),
    addEventListener() {},
  };
  return { nodes, doc, win };
}

test("installSplitters: keys move and persist a share, Enter and double-click reset", () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  const { nodes, doc, win } = fakePage({ storage });
  const api = installSplitters({ document: doc, window: win, mode: "control" });
  assert.ok(api);
  assert.equal(nodes.scroll.classes.has("split-answer"), false, "default layout until the user moves something");
  assert.equal(nodes.splitA.attrs["aria-valuenow"], "33");

  const event = nodes.splitA.fire("keydown", { key: "ArrowDown" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(nodes.scroll.classes.has("split-answer"), true);
  assert.ok(Math.abs(api.layout().answer - (200 / 600 + 0.05)) < 1e-9);
  assert.match(data.get(`${LAYOUT_STORAGE_PREFIX}control`), /"answer":0\.38/);
  assert.equal(nodes.scroll.vars["--answer-grow"], String(api.layout().answer * 100));

  nodes.splitL.fire("keydown", { key: "Home" });
  assert.equal(nodes.lanes.classes.has("split-lanes"), true);
  assert.equal(nodes.lanes.vars["--prospect-fr"], `${(56 / 392) * 100}fr`);

  nodes.splitA.fire("keydown", { key: "Enter" });
  assert.equal(nodes.scroll.classes.has("split-answer"), false);
  nodes.splitL.fire("dblclick");
  assert.equal(nodes.lanes.classes.has("split-lanes"), false);
  assert.equal(data.size, 0, "all defaults: nothing stored");

  assert.equal(nodes.splitA.fire("keydown", { key: "x" }).defaultPrevented, undefined, "other keys pass through");
  assert.equal(nodes.splitA.fire("keydown", { key: "ArrowDown", ctrlKey: true }).defaultPrevented, undefined);
});

test("installSplitters restores a saved layout and works when storage throws", () => {
  const saved = new Map([[`${LAYOUT_STORAGE_PREFIX}overlay`, '{"answer":0.25,"prospect":0.7}']]);
  const storage = { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k) };
  const restored = fakePage({ storage });
  installSplitters({ document: restored.doc, window: restored.win, mode: "overlay" });
  assert.equal(restored.nodes.scroll.classes.has("split-answer"), true);
  assert.equal(restored.nodes.scroll.vars["--answer-grow"], "25");
  assert.equal(restored.nodes.lanes.vars["--prospect-fr"], "70fr");

  const broken = fakePage({ storage: "throws" });
  const api = installSplitters({ document: broken.doc, window: broken.win, mode: "control" });
  broken.nodes.splitA.fire("keydown", { key: "ArrowUp" });
  assert.ok(api.layout().answer > 0, "still resizes for this session");
});

test("panel windows keep the fixed layout", () => {
  const { doc, win } = fakePage({ storage: null });
  assert.equal(installSplitters({ document: doc, window: win, mode: "panel" }), null);
});

/* --------------------------------------------------------- static checks */

test("index.html: two keyboard-reachable, no-drag separators, hidden in panel windows", () => {
  const html = read("renderer/index.html");
  for (const id of ["split-answer", "split-lanes"]) {
    const tag = new RegExp(`<div id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    assert.ok(tag, `${id} exists`);
    assert.match(tag, /class="splitter no-drag panel-hidden"/);
    assert.match(tag, /role="separator"/);
    assert.match(tag, /aria-orientation="horizontal"/);
    assert.match(tag, /tabindex="0"/);
    assert.doesNotMatch(tag, /\stitle=|aria-live/);
  }
  // Order: answer card, answer splitter, lanes; Prospect, lane splitter, You.
  const order = ["answer-card", 'id="split-answer"', 'class="lanes"', 'data-lane="prospect"', 'id="split-lanes"', 'data-lane="rep"'].map((s) => html.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("styles.css: splitters are no-drag, boxes keep pixel floors, panels keep auto rows", () => {
  const css = read("renderer/styles.css");
  const splitter = /\n\.splitter \{[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
  assert.match(splitter, /-webkit-app-region: no-drag/);
  assert.match(splitter, /cursor: row-resize/);
  assert.match(css, /--answer-min: 120px/);
  assert.match(css, /--lanes-min: 160px/);
  assert.match(css, /--lane-min: 56px/);
  assert.match(css, /\.panel-scroll\.split-answer \.answer-card \{[^}]*min-height: var\(--answer-min\)[^}]*overflow-y: auto/);
  assert.match(css, /\.panel-scroll\.split-answer \.lanes \{[^}]*min-height: var\(--lanes-min\)/);
  assert.match(css, /minmax\(var\(--lane-min\), var\(--prospect-fr, 1fr\)\)/);
  assert.match(css, /body:not\(\[data-mode="panel"\]\) \.lanes \{/);
});

test("app.js installs the splitters for this window's mode", () => {
  const app = read("renderer/app.js");
  assert.match(app, /import \{ installSplitters \} from "\.\/layout-splitters\.js";/);
  assert.match(app, /installSplitters\(\{ document, window, mode: document\.body\.dataset\.mode \}\)/);
  const module = read("renderer/layout-splitters.js");
  assert.doesNotMatch(module, /\.title\s*=|setAttribute\(\s*["']title|aria-live|\b(alert|confirm|prompt)\s*\(/);
  // Every storage access is guarded (sandboxed or private profiles may throw).
  assert.match(module, /function safeStorage\(win\) \{\s*try \{/);
});
