import test from "node:test";
import assert from "node:assert/strict";

/**
 * Session recap, phase 5b: recap.js (the recap window) against a stub DOM and
 * a fake preload bridge, like practice-renderer.test.js. The window reads the
 * session id from its query string (?id=...), asks main for that recap with
 * recap:get, and paints it with text nodes only.
 */
class StubNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.className = "";
    this.listeners = {};
    this.text = "";
  }
  append(...items) {
    for (const item of items) this.children.push(typeof item === "string" ? Object.assign(new StubNode("#text"), { text: item }) : item);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }
  set innerHTML(_value) {
    throw new Error("innerHTML is forbidden in the recap window");
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  setAttribute() {}
}

const IDS = ["recap-title", "recap-meta", "recap-notes", "recap-status", "recap-body", "recap-timeline", "recap-questions", "recap-gaps", "recap-terms"];
const T0 = Date.parse("2026-10-28T14:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function builtRecap() {
  const line = (type, offsetMs, fields) => ({ type, at: iso(T0 + offsetMs), offsetMs, ...fields });
  return {
    version: 1,
    id: "session-1",
    startedAt: iso(T0),
    endedAt: iso(T0 + 60_000),
    durationMs: 60_000,
    endReason: "user",
    truncated: false,
    dropped: { lines: 0 },
    failed: false,
    lines: [
      line("transcript", 3_000, { role: "prospect", source: "system", text: "How does SSO work?", segmentId: "s1", heardAt: iso(T0 + 2_000), heardOffsetMs: 2_000 }),
      line("gate.verdict", 3_050, { turnId: "t1", gateSeq: 1, verdict: "answer" }),
      line("turn.started", 3_100, { turnId: "t1", question: "How does SSO work?", displayQuestion: null, intent: "final", gateSeq: 1 }),
      line("turn.done", 4_500, { turnId: "t1", text: "VERDICT: <b>SAML</b> or OIDC.", cut: null, fallback: null }),
      line("terms", 4_900, { turnId: "t1", terms: [{ term: "OIDC", full_name: "OpenID Connect", what: "A sign-on layer." }] }),
      line("transcript", 9_000, { role: "rep", source: "mic", text: "We support both.", segmentId: "r1", heardAt: iso(T0 + 8_000), heardOffsetMs: 8_000 }),
    ],
    turns: [],
    questions: [{ turnId: "t1", at: iso(T0 + 3_100), offsetMs: 3_100, question: "How does SSO work?", intent: "final", status: "done", answer: "VERDICT: <b>SAML</b> or OIDC.", cut: null, terms: ["OIDC"] }],
    gaps: [{ kind: "cut", turnId: "t1", at: iso(T0 + 3_100), offsetMs: 3_100, question: "How does SSO work?", reason: "lines" }],
    terms: [{ turnId: "t1", at: iso(T0 + 4_900), offsetMs: 4_900, term: "OIDC", full_name: "OpenID Connect", what: "A sign-on layer.", question: "How does SSO work?" }],
    stats: { lines: 6, prospectLines: 1, repLines: 1, turns: 1, questions: 1, answered: 1, gaps: 1, terms: 1 },
    savedAt: iso(T0 + 61_000),
    text: "Session recap — …",
  };
}

/** Loads a fresh copy of recap.js with these globals; returns the nodes and the calls it made. */
async function boot({ search, request }) {
  const nodes = new Map(IDS.map((id) => [id, new StubNode()]));
  const { IPC } = await import("../src/desktop/ipc-gateway.js");
  const requests = [];
  globalThis.document = {
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: (tag) => new StubNode(tag),
    createTextNode: (text) => Object.assign(new StubNode("#text"), { text: String(text) }),
  };
  globalThis.window = {
    location: { search },
    copilot: {
      channels: IPC,
      request: async (channel, payload) => {
        requests.push([channel, payload]);
        return request(channel, payload);
      },
      command: async () => ({}),
      on: () => () => {},
    },
  };
  await import(`../src/desktop/renderer/recap.js?case=${encodeURIComponent(search)}-${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { nodes, requests, IPC };
}

function cleanup() {
  delete globalThis.document;
  delete globalThis.window;
}

test("recap window: asks main for the session in its query string and paints it", async () => {
  try {
    const data = builtRecap();
    const { nodes, requests, IPC } = await boot({ search: "?id=session-1", request: async () => ({ recap: data }) });
    assert.deepEqual(requests, [[IPC.RECAP_GET, { id: "session-1" }]]);
    assert.match(nodes.get("recap-title").textContent, /^Session recap — /);
    assert.match(nodes.get("recap-meta").textContent, /1 min 0 s · Ended by you · 1 question · 1 gap · 1 term/);
    const timeline = nodes.get("recap-timeline").children;
    assert.equal(timeline.length, data.lines.length, "one row per timeline line");
    assert.deepEqual(timeline.map((row) => row.dataset.type), data.lines.map((line) => line.type));
    assert.equal(timeline[0].dataset.role, "prospect");
    assert.equal(timeline[5].dataset.role, "rep");
    assert.match(timeline[0].textContent, /00:00:03/);
    assert.match(timeline[0].textContent, /Prospect/);
    assert.match(timeline[0].textContent, /How does SSO work\?/);
    assert.ok(timeline[3].textContent.includes("VERDICT: <b>SAML</b> or OIDC."), "model text shows literally");
    assert.equal(nodes.get("recap-questions").children.length, 1);
    assert.equal(nodes.get("recap-gaps").children.length, 1);
    assert.equal(nodes.get("recap-terms").children.length, 1);
    assert.match(nodes.get("recap-terms").textContent, /OIDC \(OpenID Connect\): A sign-on layer\./);
    assert.equal(nodes.get("recap-status").hidden, true, "no status when the recap painted");
    assert.equal(nodes.get("recap-body").hidden, false, "the sections show");
  } finally {
    cleanup();
  }
});

test("recap window: empty sections say so", async () => {
  try {
    const data = { ...builtRecap(), questions: [], gaps: [], terms: [] };
    const { nodes } = await boot({ search: "?id=session-1", request: async () => ({ recap: data }) });
    assert.equal(nodes.get("recap-questions").textContent, "No questions were detected.");
    assert.equal(nodes.get("recap-gaps").textContent, "No gaps.");
    assert.equal(nodes.get("recap-terms").textContent, "No terms were explained.");
  } finally {
    cleanup();
  }
});

test("recap window: without an id it asks for nothing and says so", async () => {
  try {
    const { nodes, requests } = await boot({ search: "", request: async () => ({ recap: builtRecap() }) });
    assert.deepEqual(requests, []);
    assert.equal(nodes.get("recap-status").hidden, false);
    assert.equal(nodes.get("recap-status").textContent, "No session selected.");
    assert.equal(nodes.get("recap-body").hidden, true);
  } finally {
    cleanup();
  }
});

test("recap window: a deleted or unreadable recap shows why instead of a blank page", async () => {
  try {
    const gone = await boot({
      search: "?id=session-404",
      request: async () => {
        throw Object.freeze({ name: "IpcError", code: "E_RECAP_NOT_FOUND", message: "no such recap" });
      },
    });
    assert.equal(gone.nodes.get("recap-status").hidden, false);
    assert.equal(gone.nodes.get("recap-status").textContent, "This session recap no longer exists.");
    assert.equal(gone.nodes.get("recap-timeline").children.length, 0);
    assert.equal(gone.nodes.get("recap-body").hidden, true, "no empty section headings under an error");
    cleanup();
    const broken = await boot({
      search: "?id=session-1",
      request: async () => {
        throw Object.freeze({ name: "IpcError", code: "E_RECAP_UNREADABLE", message: "This session recap couldn't be read." });
      },
    });
    assert.equal(broken.nodes.get("recap-status").textContent, "This session recap couldn't be read.");
  } finally {
    cleanup();
  }
});
