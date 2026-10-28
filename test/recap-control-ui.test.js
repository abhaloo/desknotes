import test from "node:test";
import assert from "node:assert/strict";

/**
 * Session recap, phase 5c: app.js in CONTROL mode against a stub DOM and a
 * fake preload bridge (the renderer-window-state.test.js harness).
 *
 *   - #btn-recap: hidden until a recap is ready; recap:ready shows it; a
 *     click opens that recap (recap:open {id}); the next session starting
 *     (launching) hides it again; a recap that finished before the window
 *     loaded (recap:list.latest) shows it at boot.
 *   - #recap-problem: a small icon with a tooltip when the recording or its
 *     save went wrong (recap:ready saveError / notes); hidden by the next session.
 *   - Settings > Session history (recap-history.js): the "Save a recap of
 *     each session" switch (settings:set {sessionRecap}), one row per saved
 *     session with Open and Delete, and Delete all. Deleting asks first. A
 *     file deleted outside the app leaves the list when Open fails, and the
 *     list reloads when the window regains focus while Settings is open.
 */
class StubNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.className = "";
    this.type = "";
    this.children = [];
    this.listeners = {};
    this.classes = new Set();
    this.text = "";
    this.open = false;
    this.title = "";
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
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }
  append(...items) {
    for (const item of items) this.children.push(typeof item === "string" ? Object.assign(new StubNode("#text"), { text: item }) : item);
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
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  async fire(type) {
    for (const fn of this.listeners[type] ?? []) await fn({ type, currentTarget: this, target: this, preventDefault() {} });
  }
}

/** Every descendant of `node` that matches `predicate`, depth first. */
function findAll(node, predicate, out = []) {
  for (const child of node?.children ?? []) {
    if (predicate(child)) out.push(child);
    findAll(child, predicate, out);
  }
  return out;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
const summary = (n) => ({
  id: `session-${n}`,
  startedAt: new Date(Date.parse("2026-10-28T14:00:00.000Z") + n * 3_600_000).toISOString(),
  endedAt: new Date(Date.parse("2026-10-28T14:05:00.000Z") + n * 3_600_000).toISOString(),
  durationMs: 300_000,
  endReason: "user",
  stats: { lines: 10, prospectLines: 4, repLines: 4, turns: 2, questions: 2, answered: 2, gaps: 0, terms: 1 },
  savedAt: new Date(Date.parse("2026-10-28T14:05:01.000Z") + n * 3_600_000).toISOString(),
});

async function boot({ list, lifecycle = "idle", settings = { sessionRecap: true }, confirm = () => true, open = null }) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, new StubNode());
    return nodes.get(id);
  };
  const handlers = {};
  const commands = [];
  const requests = [];
  const confirms = [];
  const windowListeners = {};
  const state = { list, settings };
  const { IPC } = await import("../src/desktop/ipc-gateway.js");
  globalThis.document = {
    body: new StubNode("body"),
    getElementById: node,
    createElement: (tag) => new StubNode(tag),
    createTextNode: (text) => Object.assign(new StubNode("#text"), { text: String(text) }),
    querySelector: () => null,
  };
  globalThis.window = {
    location: { search: "?mode=control" },
    addEventListener: (type, fn) => {
      (windowListeners[type] ??= []).push(fn);
    },
    confirm: (message) => {
      confirms.push(message);
      return confirm(message);
    },
    copilot: {
      channels: IPC,
      request: async (channel, payload) => {
        requests.push([channel, payload]);
        if (channel === IPC.RECAP_LIST) return state.list;
        if (channel === IPC.SETTINGS_GET) return state.settings;
        if (channel === IPC.SPEECH_GET_REALTIME_STATUS) return { lifecycle, realtime: "idle", vad: {} };
        if (channel === IPC.SHORTCUTS_LIST) return { bindings: [] };
        if (channel === IPC.WINDOW_GET_STATE) return { clickThrough: false, windowOpacity: 1 };
        if (channel === IPC.AUDIO_LIST_DEVICES) return [];
        return {};
      },
      command: async (channel, payload) => {
        commands.push([channel, payload]);
        if (channel === IPC.RECAP_DELETE) {
          const removed = payload?.all ? state.list.sessions.length : 1;
          state.list = { ...state.list, sessions: payload?.all ? [] : state.list.sessions.filter((s) => s.id !== payload?.id) };
          return { removed };
        }
        if (channel === IPC.SETTINGS_SET) {
          state.settings = { ...state.settings, ...payload };
          return state.settings;
        }
        if (channel === IPC.RECAP_OPEN) {
          if (open) return open(payload);
          return { opened: true, id: payload?.id ?? null };
        }
        return {};
      },
      on: (channel, fn) => {
        (handlers[channel] ??= []).push(fn);
        return () => {};
      },
      openSettingsFolder: async () => ({}),
      openKnownTerms: async () => ({}),
      openKeysFile: async () => ({}),
      panelsSet: async () => ({}),
      shellAction: async () => ({}),
    },
  };
  await import(`../src/desktop/renderer/app.js?recap=${Math.random()}`);
  await settle();
  const emit = async (channel, payload) => {
    for (const fn of handlers[channel] ?? []) fn(payload);
    await settle();
  };
  const focus = async () => {
    for (const fn of windowListeners.focus ?? []) fn({ type: "focus" });
    await settle();
  };
  return { node, handlers, commands, requests, confirms, IPC, emit, state, focus };
}

function cleanup() {
  delete globalThis.document;
  delete globalThis.window;
}

const rows = (node) => node("recap-history").children;
const rowButton = (row, action) => findAll(row, (child) => child.dataset?.action === action)[0] ?? null;

test("Session recap button: hidden at boot, shown when a recap is ready, opens it, hidden by the next session", async () => {
  try {
    const ui = await boot({ list: { enabled: true, latest: null, sessions: [] } });
    const button = ui.node("btn-recap");
    assert.equal(button.hidden, true, "no recap yet");
    assert.ok(ui.handlers[ui.IPC.RECAP_READY]?.length > 0, "subscribes to recap:ready");

    await ui.emit(ui.IPC.SPEECH_STATUS_CHANGED, { state: "ended", previous: "ending" });
    await ui.emit(ui.IPC.RECAP_READY, { id: "session-1", summary: summary(1), saveError: null });
    assert.equal(button.hidden, false);
    assert.equal(button.dataset.recapId, "session-1");

    await button.fire("click");
    assert.deepEqual(ui.commands.filter(([channel]) => channel === ui.IPC.RECAP_OPEN), [[ui.IPC.RECAP_OPEN, { id: "session-1" }]]);

    await ui.emit(ui.IPC.SPEECH_STATUS_CHANGED, { state: "launching", previous: "ended" });
    assert.equal(button.hidden, true, "a new session hides the last one's button");
  } finally {
    cleanup();
  }
});

test("Session recap button: a recap that finished before the window loaded shows at boot", async () => {
  try {
    const ui = await boot({ list: { enabled: true, latest: summary(2), sessions: [summary(2)] }, lifecycle: "ended" });
    assert.equal(ui.node("btn-recap").hidden, false);
    assert.equal(ui.node("btn-recap").dataset.recapId, "session-2");
  } finally {
    cleanup();
  }
});

test("Session recap button: not shown while a session is live, even with a latest recap", async () => {
  try {
    const ui = await boot({ list: { enabled: true, latest: summary(2), sessions: [summary(2)] }, lifecycle: "active" });
    assert.equal(ui.node("btn-recap").hidden, true);
  } finally {
    cleanup();
  }
});

test("Session recap problem icon: an unsaved recap still opens, and the icon's tooltip says what went wrong", async () => {
  try {
    const ui = await boot({ list: { enabled: true, latest: null, sessions: [] } });
    const icon = ui.node("recap-problem");
    assert.equal(icon.hidden, true, "no problem yet");
    await ui.emit(ui.IPC.RECAP_READY, { id: "session-3", summary: null, saveError: "Couldn't save the session recap.", notes: [] });
    assert.equal(ui.node("btn-recap").hidden, false);
    assert.equal(icon.hidden, false);
    assert.match(icon.title, /Couldn't save the session recap\./);
    await icon.fire("click");
    assert.match(ui.node("toast").textContent, /Couldn't save the session recap\./, "a click shows the same text for keyboard and touch");
    await ui.emit(ui.IPC.SPEECH_STATUS_CHANGED, { state: "launching", previous: "ended" });
    assert.equal(icon.hidden, true, "a new session clears it");
  } finally {
    cleanup();
  }
});

test("Session recap problem icon: a recording that stopped early or hit its cap is reported the same way", async () => {
  try {
    const ui = await boot({ list: { enabled: true, latest: null, sessions: [] } });
    await ui.emit(ui.IPC.RECAP_READY, {
      id: "session-5",
      summary: summary(5),
      saveError: null,
      notes: ["12 lines were not recorded (the recap reached its size limit).", "Recording stopped early after an internal error."],
    });
    const icon = ui.node("recap-problem");
    assert.equal(icon.hidden, false);
    assert.match(icon.title, /12 lines were not recorded/);
    assert.match(icon.title, /Recording stopped early/);
    await ui.emit(ui.IPC.RECAP_READY, { id: "session-6", summary: summary(6), saveError: null, notes: [] });
    assert.equal(icon.hidden, true, "a clean recap clears it");
  } finally {
    cleanup();
  }
});

test("Session history: a recap deleted outside the app leaves the list when Open fails", async () => {
  try {
    const ui = await boot({
      list: { enabled: true, latest: null, sessions: [summary(2), summary(1)] },
      open: (payload) => {
        if (payload?.id === "session-2") throw Object.freeze({ name: "IpcError", code: "E_RECAP_NOT_FOUND", message: "This session recap no longer exists." });
        return { opened: true, id: payload?.id ?? null };
      },
    });
    // The file went away behind the app's back; the folder is the truth.
    ui.state.list = { enabled: true, latest: null, sessions: [summary(1)] };
    const lists = () => ui.requests.filter(([channel]) => channel === ui.IPC.RECAP_LIST).length;
    const before = lists();
    await rowButton(rows(ui.node)[0], "open").fire("click");
    await settle();
    assert.equal(lists(), before + 1, "the list is read again");
    assert.deepEqual(rows(ui.node).map((row) => row.dataset.recapId), ["session-1"]);
    assert.match(ui.node("toast").textContent, /no longer exists/);
  } finally {
    cleanup();
  }
});

test("Session history: the list reloads when the window regains focus while Settings is open", async () => {
  try {
    const ui = await boot({ list: { enabled: true, latest: null, sessions: [summary(2), summary(1)] } });
    const lists = () => ui.requests.filter(([channel]) => channel === ui.IPC.RECAP_LIST).length;
    ui.state.list = { enabled: true, latest: null, sessions: [summary(1)] };
    const before = lists();
    await ui.focus();
    assert.equal(lists(), before, "Settings closed: nothing to refresh");
    ui.node("settings-dialog").open = true;
    await ui.focus();
    assert.equal(lists(), before + 1);
    assert.deepEqual(rows(ui.node).map((row) => row.dataset.recapId), ["session-1"]);
  } finally {
    cleanup();
  }
});

test("Session history: one row per saved session, newest first, with Open and Delete", async () => {
  try {
    const ui = await boot({ list: { enabled: true, latest: null, sessions: [summary(2), summary(1)] } });
    assert.ok(ui.requests.some(([channel]) => channel === ui.IPC.RECAP_LIST), "the list is read at boot");
    const list = rows(ui.node);
    assert.equal(list.length, 2);
    assert.equal(ui.node("recap-history-empty").hidden, true);
    assert.deepEqual(list.map((row) => row.dataset.recapId), ["session-2", "session-1"]);
    assert.match(list[0].textContent, /5 min 0 s · 2 questions · 0 gaps/);
    for (const row of list) {
      assert.ok(rowButton(row, "open"), "an Open button");
      assert.ok(rowButton(row, "delete"), "a Delete button");
      assert.equal(rowButton(row, "open").textContent, "Open");
      assert.equal(rowButton(row, "delete").textContent, "Delete");
    }
    await rowButton(list[1], "open").fire("click");
    assert.deepEqual(ui.commands.filter(([channel]) => channel === ui.IPC.RECAP_OPEN), [[ui.IPC.RECAP_OPEN, { id: "session-1" }]]);
  } finally {
    cleanup();
  }
});

test("Session history: Delete asks first, removes that one session, and the list follows", async () => {
  let answer = false;
  try {
    const ui = await boot({ list: { enabled: true, latest: null, sessions: [summary(2), summary(1)] }, confirm: () => answer });
    await rowButton(rows(ui.node)[0], "delete").fire("click");
    assert.equal(ui.confirms.length, 1, "asked");
    assert.equal(ui.commands.filter(([channel]) => channel === ui.IPC.RECAP_DELETE).length, 0, "declined: nothing deleted");
    answer = true;
    await rowButton(rows(ui.node)[0], "delete").fire("click");
    await settle();
    assert.deepEqual(ui.commands.filter(([channel]) => channel === ui.IPC.RECAP_DELETE), [[ui.IPC.RECAP_DELETE, { id: "session-2" }]]);
    assert.deepEqual(rows(ui.node).map((row) => row.dataset.recapId), ["session-1"]);
  } finally {
    cleanup();
  }
});

test("Session history: Delete all asks first, removes every session, and shows the empty note", async () => {
  let answer = false;
  try {
    const ui = await boot({ list: { enabled: true, latest: null, sessions: [summary(2), summary(1)] }, confirm: () => answer });
    await ui.node("recap-delete-all").fire("click");
    assert.equal(ui.commands.filter(([channel]) => channel === ui.IPC.RECAP_DELETE).length, 0, "declined: nothing deleted");
    answer = true;
    await ui.node("recap-delete-all").fire("click");
    await settle();
    assert.deepEqual(ui.commands.filter(([channel]) => channel === ui.IPC.RECAP_DELETE), [[ui.IPC.RECAP_DELETE, { all: true }]]);
    assert.equal(rows(ui.node).length, 0);
    assert.equal(ui.node("recap-history-empty").hidden, false);
    assert.equal(ui.node("recap-delete-all").disabled, true, "nothing left to delete");
  } finally {
    cleanup();
  }
});

test("Session history: a new recap appears in the list without reopening Settings", async () => {
  try {
    const ui = await boot({ list: { enabled: true, latest: null, sessions: [] } });
    assert.equal(ui.node("recap-history-empty").hidden, false);
    ui.state.list = { enabled: true, latest: summary(4), sessions: [summary(4)] };
    await ui.emit(ui.IPC.RECAP_READY, { id: "session-4", summary: summary(4), saveError: null });
    assert.deepEqual(rows(ui.node).map((row) => row.dataset.recapId), ["session-4"]);
    assert.equal(ui.node("recap-history-empty").hidden, true);
  } finally {
    cleanup();
  }
});

test("Session history: the switch follows settings and saves sessionRecap; turning it off keeps the list", async () => {
  try {
    const ui = await boot({ list: { enabled: true, latest: null, sessions: [summary(1)] }, settings: { sessionRecap: true } });
    const toggle = ui.node("session-recap");
    assert.equal(toggle.checked, true);
    toggle.checked = false;
    await toggle.fire("change");
    assert.deepEqual(ui.commands.filter(([channel]) => channel === ui.IPC.SETTINGS_SET).at(-1), [ui.IPC.SETTINGS_SET, { sessionRecap: false }]);
    assert.equal(rows(ui.node).length, 1, "old recaps stay until deleted");
    assert.equal(ui.commands.filter(([channel]) => channel === ui.IPC.RECAP_DELETE).length, 0);
  } finally {
    cleanup();
  }
});
