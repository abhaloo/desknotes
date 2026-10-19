import test from "node:test";
import assert from "node:assert/strict";

/**
 * app.js (overlay mode) against a stub DOM and a fake preload bridge. The
 * click-through pills and the Settings toggle follow WINDOW_STATE_CHANGED and
 * the window state read at boot. Every element id resolves to a node, so the
 * module loads without a real DOM.
 */
class StubNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.className = "";
    this.children = [];
    this.listeners = {};
    this.classes = new Set();
    this.text = "";
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, force) => {
        const on = force ?? !this.classes.has(name);
        if (on) this.classes.add(name);
        else this.classes.delete(name);
        return on;
      },
      contains: (name) => this.classes.has(name),
    };
  }
  get textContent() {
    return this.text;
  }
  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  setAttribute() {}
  removeAttribute() {}
  querySelector() {
    return null;
  }
  focus() {}
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
}

test("click-through pill follows window state", async () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, new StubNode());
    return nodes.get(id);
  };
  const handlers = {};
  let windowState = { clickThrough: false, windowOpacity: 100 };
  const { IPC } = await import("../src/desktop/ipc-gateway.js");

  globalThis.document = {
    body: new StubNode("body"),
    getElementById: node,
    createElement: (tag) => new StubNode(tag),
    createTextNode: (text) => {
      const textNode = new StubNode("#text");
      textNode.textContent = text;
      return textNode;
    },
    querySelector: () => null,
  };
  globalThis.window = {
    location: { search: "" },
    copilot: {
      channels: IPC,
      request: async (channel) => (channel === IPC.WINDOW_GET_STATE ? windowState : {}),
      command: async () => ({}),
      on: (channel, fn) => {
        (handlers[channel] ??= []).push(fn);
      },
    },
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const pills = () => [node("click-through-pill"), node("click-through-pill-overlay")];
  try {
    await import("../src/desktop/renderer/app.js");
    await settle();
    assert.ok(handlers[IPC.WINDOW_STATE_CHANGED]?.length > 0, "subscribes to window:state:changed");
    for (const pill of pills()) assert.equal(pill.textContent, "click-through off");

    for (const fn of handlers[IPC.WINDOW_STATE_CHANGED]) fn({ clickThrough: true, windowOpacity: 100 });
    for (const pill of pills()) {
      assert.equal(pill.textContent, "click-through on");
      assert.equal(pill.dataset.state, "active");
    }
    assert.equal(node("toggle-click-through").checked, true, "the Settings toggle follows the flag");

    for (const fn of handlers[IPC.WINDOW_STATE_CHANGED]) fn({ clickThrough: false, windowOpacity: 100 });
    for (const pill of pills()) assert.equal(pill.textContent, "click-through off");
    assert.equal(node("toggle-click-through").checked, false);

    // A status without the flag leaves the pill as it was.
    for (const fn of handlers[IPC.WINDOW_STATE_CHANGED]) fn({ windowOpacity: 60 });
    for (const pill of pills()) assert.equal(pill.textContent, "click-through off");
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

test("click-through pill starts from the window state read at boot", async () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, new StubNode());
    return nodes.get(id);
  };
  const { IPC } = await import("../src/desktop/ipc-gateway.js");

  globalThis.document = {
    body: new StubNode("body"),
    getElementById: node,
    createElement: (tag) => new StubNode(tag),
    createTextNode: () => new StubNode("#text"),
    querySelector: () => null,
  };
  globalThis.window = {
    location: { search: "?mode=overlay" },
    copilot: {
      channels: IPC,
      request: async (channel) => (channel === IPC.WINDOW_GET_STATE ? { clickThrough: true, windowOpacity: 100 } : {}),
      command: async () => ({}),
      on: () => {},
    },
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  try {
    // A fresh module instance: the first test's import is cached by URL.
    await import("../src/desktop/renderer/app.js?boot=1");
    await settle();
    assert.equal(node("click-through-pill-overlay").textContent, "click-through on");
    assert.equal(node("toggle-click-through").checked, true);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});
