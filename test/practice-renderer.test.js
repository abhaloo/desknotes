import test from "node:test";
import assert from "node:assert/strict";

/**
 * practice.js against a minimal stub DOM and a fake preload bridge: the
 * block lifecycle (stream, finalize once, cut on end), the verbatim debrief,
 * and a clean page per session. No real DOM is needed: the renderer only
 * uses append / replaceChildren / textContent and a few properties.
 */
class StubNode {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.className = "";
    this.listeners = {};
  }
  append(...items) {
    for (const item of items) this.children.push(typeof item === "string" ? { text: item } : item);
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  get textContent() {
    return this.children.map((child) => child.text ?? child.textContent).join("");
  }
  set textContent(value) {
    this.children = [{ text: String(value) }];
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
}

const IDS = [
  "material-status",
  "material-text",
  "material-save",
  "practice-start",
  "practice-end",
  "session-summary",
  "answer-blocks",
  "debrief-status",
  "debrief-text",
  "toast",
];

test("practice renderer: streamed blocks finalize once, cut on end, debrief verbatim", async () => {
  const nodes = new Map(IDS.map((id) => [id, new StubNode()]));
  const { IPC } = await import("../src/desktop/ipc-gateway.js");
  let onEvent = null;
  const commands = [];
  let startedAt = "2026-10-15T10:00:00.000Z";
  globalThis.document = {
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: (tag) => new StubNode(tag),
  };
  globalThis.window = {
    copilot: {
      channels: IPC,
      request: async () => ({ material: null, materialReadError: null, session: null, debrief: null, debriefReadError: null }),
      command: async (channel) => {
        commands.push(channel);
        return channel === IPC.PRACTICE_START ? { startedAt } : { debrief: null };
      },
      on: (channel, fn) => {
        if (channel === IPC.PRACTICE_EVENT) onEvent = fn;
      },
    },
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await import("../src/desktop/renderer/practice.js");
    await settle();
    assert.equal(typeof onEvent, "function", "subscribes to practice:event");
    const blocksNode = nodes.get("answer-blocks");

    await nodes.get("practice-start").listeners.click();
    assert.deepEqual(commands, [IPC.PRACTICE_START]);
    assert.equal(nodes.get("practice-start").disabled, true);
    assert.equal(nodes.get("practice-end").disabled, false);

    const evidence = { band: "question", p: null, source: "fallback", reason: "ends with a question mark" };
    onEvent({ type: "question", id: "q_1", question: "How would you shard it?", evidence, at: startedAt });
    onEvent({ type: "answer-start", id: "q_1" });
    // Deltas and done arrive before any frame runs: the queued paint must not
    // re-append the last delta after the paragraphs replaced the stream.
    onEvent({ type: "answer-delta", id: "q_1", delta: "Hash the key." });
    onEvent({ type: "answer-delta", id: "q_1", delta: "\n\nThen rebalance." });
    onEvent({ type: "answer-done", id: "q_1", text: "Hash the key.\n\nThen rebalance." });
    await settle();
    const first = blocksNode.children[0];
    const [header, meta, prose] = first.children;
    assert.equal(header.tagName, "strong");
    assert.equal(header.textContent, "Question: How would you shard it?");
    assert.equal(meta.textContent, "Detected: ends with a question mark · done");
    assert.deepEqual(prose.children.map((p) => [p.tagName, p.textContent]), [
      ["p", "Hash the key."],
      ["p", "Then rebalance."],
    ]);
    // A late delta for a finished block changes nothing.
    onEvent({ type: "answer-delta", id: "q_1", delta: " extra" });
    await settle();
    assert.equal(prose.children.length, 2);

    // Small talk renders nothing.
    onEvent({ type: "skipped", text: "ok", evidence: { band: "small-talk", p: null, source: "fallback", reason: "no question signal" } });
    assert.equal(blocksNode.children.length, 1);

    // A stream still running at End gets no answer-done: "ended" settles it as cut.
    onEvent({ type: "question", id: "q_2", question: "And the hot keys?", evidence, at: startedAt });
    onEvent({ type: "answer-delta", id: "q_2", delta: "Split them" });
    await settle();
    const debriefText = "Practice session — x\n\nPractice rehearsal only. These answers are study material, not live assistance.\n  odd   spacing kept";
    onEvent({ type: "ended", debrief: { savedAt: "2026-10-15T10:05:00.000Z", title: "t", text: debriefText, stats: {} } });
    await settle();
    const second = blocksNode.children[1];
    assert.equal(second.children[1].textContent, "Detected: ends with a question mark · cut");
    assert.deepEqual(second.children[2].children.map((p) => p.textContent), ["Split them"]);
    assert.equal(nodes.get("debrief-text").textContent, debriefText, "debrief text is shown verbatim");
    assert.equal(nodes.get("debrief-text").hidden, false);
    assert.equal(nodes.get("debrief-status").textContent, "Debrief saved at 2026-10-15T10:05:00.000Z.");
    assert.equal(nodes.get("practice-start").disabled, false);
    assert.equal(nodes.get("practice-end").disabled, true);

    // The next session starts on a clean page (ids restart at q_1).
    startedAt = "2026-10-15T11:00:00.000Z";
    await nodes.get("practice-start").listeners.click();
    assert.equal(blocksNode.children.length, 0);
    assert.equal(nodes.get("debrief-text").hidden, true);
    onEvent({ type: "question", id: "q_1", question: "New one?", evidence, at: startedAt });
    assert.equal(blocksNode.children.length, 1);
    assert.equal(blocksNode.children[0].children[0].textContent, "Question: New one?");
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});
