import test from "node:test";
import assert from "node:assert/strict";

/**
 * Session search, phase 4: the search box in Settings > Session history
 * (src/desktop/renderer/recap-history.js) against a stub DOM and a fake
 * bridge, the recap-control-ui.test.js harness.
 *
 *   - typing asks main (recap:search {query}) once per settled burst of keys
 *     (debounceMs), and paints the matching rows best first, each with the
 *     snippet main read from the recap; a reply older than the latest
 *     request is dropped;
 *   - rows are joined with the last recap:list: a hit for a session no
 *     longer listed is left out; the rest of the row is the usual one
 *     (title, meta, Open, Delete), so every existing control keeps working;
 *   - an empty box (or Escape) restores the full list at once, without IPC;
 *   - the status line says how many match, that words only are matched when
 *     the local model is absent, and how far indexing is (recap:search-status);
 *     results are refreshed as more sessions get indexed;
 *   - render() after a delete or a new recap re-runs the active query;
 *     Delete all follows the whole list, not the filtered one.
 *   Text nodes only: innerHTML is forbidden.
 */
class StubNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.className = "";
    this.type = "";
    this.children = [];
    this.listeners = {};
    this.text = "";
  }
  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }
  set innerHTML(_value) {
    throw new Error("innerHTML is forbidden in the control window");
  }
  append(...items) {
    for (const item of items) this.children.push(typeof item === "string" ? Object.assign(new StubNode("#text"), { text: item }) : item);
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  async fire(type, extra = {}) {
    for (const fn of this.listeners[type] ?? []) await fn({ type, currentTarget: this, target: this, preventDefault() {}, ...extra });
  }
  focus() {}
}

function findAll(node, predicate, out = []) {
  for (const child of node?.children ?? []) {
    if (predicate(child)) out.push(child);
    findAll(child, predicate, out);
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const T0 = Date.parse("2026-10-28T14:00:00.000Z");
const summary = (n) => ({
  id: `session-${n}`,
  startedAt: new Date(T0 + n * 3_600_000).toISOString(),
  endedAt: new Date(T0 + n * 3_600_000 + 300_000).toISOString(),
  durationMs: 300_000,
  endReason: "user",
  stats: { lines: 10, prospectLines: 4, repLines: 4, turns: 2, questions: 2, answered: 2, gaps: 0, terms: 1 },
  savedAt: new Date(T0 + n * 3_600_000 + 301_000).toISOString(),
});
const STATUS_OK = { mode: "semantic", reason: null, indexed: 3, pending: 0, total: 3 };

async function boot({ sessions = [summary(3), summary(2), summary(1)], answer = null, confirm = () => true } = {}) {
  const { IPC } = await import("../src/desktop/ipc-gateway.js");
  const { createRecapHistory } = await import("../src/desktop/renderer/recap-history.js");
  const requests = [];
  const commands = [];
  const toasts = [];
  const listeners = {};
  const state = { list: { sessions, readError: null } };
  const bridge = {
    async request(channel, payload) {
      requests.push({ channel, payload });
      if (channel === IPC.RECAP_LIST) return state.list;
      if (channel === IPC.RECAP_SEARCH) {
        if (typeof answer === "function") return answer(payload, requests.filter((r) => r.channel === IPC.RECAP_SEARCH).length);
        return { query: payload.query, hits: [], status: STATUS_OK };
      }
      throw new Error(`unexpected request ${channel}`);
    },
    async command(channel, payload) {
      commands.push({ channel, payload });
      return {};
    },
    on(channel, fn) {
      (listeners[channel] ??= []).push(fn);
    },
  };
  const els = { list: new StubNode("ul"), empty: new StubNode("p"), deleteAll: new StubNode("button"), search: new StubNode("input"), status: new StubNode("p") };
  const document = { createElement: (tag) => new StubNode(tag) };
  const history = createRecapHistory({ document, channels: IPC, bridge, confirm, showToast: (message, kind) => toasts.push({ message, kind }), els, debounceMs: 10 });
  const rows = () => els.list.children.map((li) => ({ id: li.dataset.recapId, snippet: findAll(li, (n) => n.className === "recap-history-snippet").map((n) => n.textContent)[0] ?? null }));
  const searches = () => requests.filter((r) => r.channel === IPC.RECAP_SEARCH).map((r) => r.payload.query);
  const type = async (value) => {
    els.search.value = value;
    await els.search.fire("input");
  };
  const broadcast = async (channel, payload) => {
    for (const fn of listeners[channel] ?? []) await fn(payload);
  };
  return { IPC, history, els, state, bridge, requests, commands, toasts, rows, searches, type, broadcast };
}

test("typing asks main once per settled burst and paints the hits, best first, with snippets", async () => {
  const h = await boot({
    answer: (payload) => ({ query: payload.query, hits: [{ id: "session-1", score: 0.8, snippet: "Prospect: how much for 200 seats?" }, { id: "session-3", score: 0.5, snippet: "" }], status: STATUS_OK }),
  });
  await h.history.load();
  assert.deepEqual(h.rows().map((r) => r.id), ["session-3", "session-2", "session-1"]);
  await h.type("p");
  await h.type("pr");
  await h.type("pricing");
  assert.deepEqual(h.searches(), [], "nothing asked before the burst settles");
  await sleep(40);
  assert.deepEqual(h.searches(), ["pricing"]);
  assert.deepEqual(h.rows(), [
    { id: "session-1", snippet: "Prospect: how much for 200 seats?" },
    { id: "session-3", snippet: null },
  ]);
  assert.equal(h.els.empty.hidden, true);
  assert.equal(h.els.status.textContent, "2 of 3 sessions match.");
  assert.equal(h.els.deleteAll.disabled, false);
  // The usual controls are on a hit row.
  const buttons = findAll(h.els.list.children[0], (n) => n.tagName === "BUTTON").map((n) => n.dataset.action);
  assert.deepEqual(buttons, ["open", "delete"]);
});

test("no hits: the empty line names the query; clearing the box restores the full list without IPC", async () => {
  const h = await boot();
  await h.history.load();
  await h.type("kubernetes");
  await sleep(40);
  assert.deepEqual(h.rows(), []);
  assert.equal(h.els.empty.hidden, false);
  assert.equal(h.els.empty.textContent, "No sessions match “kubernetes”.");
  assert.equal(h.els.status.textContent, "0 of 3 sessions match.");
  const before = h.requests.length;
  await h.type("");
  assert.deepEqual(h.rows().map((r) => r.id), ["session-3", "session-2", "session-1"]);
  assert.equal(h.els.empty.hidden, true);
  assert.equal(h.els.status.textContent, "");
  await sleep(40);
  assert.equal(h.requests.length, before, "an empty box asks nothing");
});

test("Escape clears the box and the filter", async () => {
  const h = await boot();
  await h.history.load();
  await h.type("okta");
  await sleep(40);
  assert.deepEqual(h.rows(), []);
  await h.els.search.fire("keydown", { key: "Escape" });
  assert.equal(h.els.search.value, "");
  assert.equal(h.rows().length, 3);
});

test("a reply older than the latest request is dropped", async () => {
  const h = await boot({
    answer: async (payload) => {
      if (payload.query === "slow") {
        await sleep(60);
        return { query: "slow", hits: [{ id: "session-1", score: 1, snippet: "slow" }], status: STATUS_OK };
      }
      return { query: payload.query, hits: [{ id: "session-2", score: 1, snippet: "fast" }], status: STATUS_OK };
    },
  });
  await h.history.load();
  await h.type("slow");
  await sleep(25); // the slow request is in flight
  await h.type("fast");
  await sleep(25);
  assert.deepEqual(h.rows().map((r) => r.id), ["session-2"]);
  await sleep(60); // the slow reply lands now
  assert.deepEqual(h.rows().map((r) => r.id), ["session-2"], "the stale reply did not paint");
  assert.deepEqual(h.searches(), ["slow", "fast"]);
});

test("hits are joined with the last list: an unknown id is left out, a row keeps its title and meta", async () => {
  const h = await boot({
    answer: () => ({ query: "x", hits: [{ id: "session-9", score: 1, snippet: "gone" }, { id: "session-2", score: 0.7, snippet: "kept" }], status: STATUS_OK }),
  });
  await h.history.load();
  await h.type("x");
  await sleep(40);
  assert.deepEqual(h.rows(), [{ id: "session-2", snippet: "kept" }]);
  const title = findAll(h.els.list.children[0], (n) => n.className === "recap-history-title")[0];
  const meta = findAll(h.els.list.children[0], (n) => n.className === "recap-history-meta")[0];
  assert.ok(title.textContent.length > 0);
  assert.match(meta.textContent, /5 min 0 s · 2 questions · 0 gaps/);
  assert.equal(h.els.status.textContent, "1 of 3 sessions match.");
});

test("render() after a delete or a new recap re-runs the active query", async () => {
  let calls = 0;
  const h = await boot({
    answer: () => {
      calls += 1;
      return { query: "x", hits: [{ id: "session-1", score: 1, snippet: "one" }, { id: "session-2", score: 0.9, snippet: "two" }], status: STATUS_OK };
    },
  });
  await h.history.load();
  await h.type("x");
  await sleep(40);
  assert.equal(calls, 1);
  h.state.list = { sessions: [summary(3), summary(1)], readError: null };
  await h.history.load(); // what app.js does on recap:ready and after a delete
  await sleep(40);
  assert.equal(calls, 2, "asked again");
  assert.deepEqual(h.rows().map((r) => r.id), ["session-1"], "session-2 is gone from the list, so from the rows");
  assert.equal(h.els.deleteAll.disabled, false);
  h.state.list = { sessions: [], readError: null };
  await h.history.load();
  await sleep(40);
  assert.equal(h.els.deleteAll.disabled, true, "Delete all follows the whole list");
});

test("the status line: words only without the model, indexing progress, and results refresh as indexing goes on", async () => {
  let status = { mode: "keyword", reason: "onnxruntime-node is unavailable", indexed: 0, pending: 0, total: 3 };
  let calls = 0;
  const h = await boot({
    answer: () => {
      calls += 1;
      return { query: "x", hits: [], status };
    },
  });
  await h.history.load();
  await h.type("x");
  await sleep(40);
  assert.equal(h.els.status.textContent, "0 of 3 sessions match. Matching words only: the local search model isn't installed.");

  status = { mode: "semantic", reason: null, indexed: 1, pending: 2, total: 3 };
  await h.broadcast(h.IPC.RECAP_SEARCH_STATUS, status);
  await sleep(40);
  assert.equal(calls, 2, "more sessions indexed: the query runs again");
  assert.equal(h.els.status.textContent, "0 of 3 sessions match. Indexing 1 of 3 sessions…");

  await h.broadcast(h.IPC.RECAP_SEARCH_STATUS, status);
  await sleep(40);
  assert.equal(calls, 2, "the same status again asks nothing");

  await h.type("");
  status = { mode: "semantic", reason: null, indexed: 3, pending: 0, total: 3 };
  await h.broadcast(h.IPC.RECAP_SEARCH_STATUS, status);
  await sleep(40);
  assert.equal(calls, 2, "no query, no search");
  assert.equal(h.els.status.textContent, "", "nothing to say when idle and not searching");
});

test("a failed search is a toast and the full list stays; a list error hides the search", async () => {
  const h = await boot({
    answer: () => {
      throw new Error("The session search failed.");
    },
  });
  await h.history.load();
  await h.type("x");
  await sleep(40);
  assert.deepEqual(h.toasts, [{ message: "The session search failed.", kind: "error" }]);
  assert.equal(h.rows().length, 3);
  h.state.list = { sessions: [], readError: "The saved session recaps couldn't be listed." };
  await h.history.load();
  assert.equal(h.els.search.disabled, true);
  assert.equal(h.els.empty.textContent, "The saved session recaps couldn't be listed.");
});

test("without a bridge the box is inert", async () => {
  const { IPC } = await import("../src/desktop/ipc-gateway.js");
  const { createRecapHistory } = await import("../src/desktop/renderer/recap-history.js");
  const els = { list: new StubNode("ul"), empty: new StubNode("p"), deleteAll: new StubNode("button"), search: new StubNode("input"), status: new StubNode("p") };
  const history = createRecapHistory({ document: { createElement: (tag) => new StubNode(tag) }, channels: IPC, bridge: null, confirm: () => true, showToast: () => {}, els });
  history.render({ sessions: [summary(1)] });
  els.search.value = "x";
  await els.search.fire("input");
  await sleep(120);
  assert.equal(els.list.children.length, 1);
});
