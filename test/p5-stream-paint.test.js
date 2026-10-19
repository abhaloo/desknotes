import test from "node:test";
import assert from "node:assert/strict";
import { AnswerPainter, LanePainter, createFrameScheduler } from "../src/desktop/renderer/stream-paint.js";
import { TranscriptLanes, LANE } from "../src/desktop/renderer/answer-buffer.js";

/** Minimal DOM double: text is the concatenation of child text. */
class FakeNode {
  constructor(text = "") {
    this.children = [];
    this.parent = null;
    this._text = text;
    this.writes = 0;
    this.className = "";
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("") : this._text;
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
    this.writes += 1;
  }
  append(...items) {
    for (const item of items) {
      if (this.children.length === 0 && this._text) this.children.push(this._text);
      this._text = "";
      if (typeof item !== "string") item.parent = this;
      this.children.push(item);
    }
  }
  insertBefore(node, ref) {
    node.parent = this;
    this.children.splice(this.children.indexOf(ref), 0, node);
  }
  replaceChildren(...items) {
    this.children = [];
    this._text = "";
    this.writes += 1;
    this.append(...items);
  }
  remove() {
    const siblings = this.parent?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }
}

const line = (text, interim) => Object.assign(new FakeNode(text), { interim });

test("answer tokens append as text; only a new turn or diverging text repaints in full", () => {
  const node = new FakeNode("placeholder");
  const painter = new AnswerPainter(node, {
    placeholder: "Waiting…",
    createPart: (c) => Object.assign(new FakeNode(), { className: c }),
  });
  painter.paint(null);
  assert.equal(node.textContent, "Waiting…");
  painter.paint({ id: "t1", text: "" });
  assert.equal(node.textContent, "", "a started answer with no words yet is empty, not the placeholder");
  painter.paint({ id: "t1", text: "Good " });
  painter.paint({ id: "t1", text: "Good question. " });
  painter.paint({ id: "t1", text: "Good question. On pricing" });
  assert.equal(node.textContent, "Good question. On pricing");
  assert.equal(painter.appends, 2, "two deltas appended, not repainted");
  const fullBefore = painter.fullPaints;
  painter.paint({ id: "t1", text: "Good question. On pricing" }); // done with identical text
  assert.equal(painter.fullPaints, fullBefore, "an identical final text does not touch the DOM");
  painter.paint({ id: "t1", text: "Corrected final answer" }); // done text differs: authoritative
  assert.equal(node.textContent, "Corrected final answer");
  painter.paint({ id: "t2", text: "Next" });
  assert.equal(node.textContent, "Next", "a new turn replaces the card");
});

test("lanes append new finals, update the interim in place, and handle head trimming", () => {
  const container = new FakeNode();
  const painter = new LanePainter(container, line);
  const lanes = new TranscriptLanes({ maxLines: 3 });
  const paint = () => painter.paint(lanes.lines(LANE.PROSPECT), lanes.current(LANE.PROSPECT));
  const texts = () => container.children.map((c) => c.textContent);

  lanes.ingest({ role: "prospect", text: "how", final: false });
  paint();
  lanes.ingest({ role: "prospect", text: "how much", final: false });
  paint();
  assert.deepEqual(texts(), ["how much"]);
  const interimNode = container.children[0];
  lanes.ingest({ role: "prospect", text: "how much is it", final: true });
  paint();
  assert.deepEqual(texts(), ["how much is it"]);
  for (const t of ["a", "b", "c"]) {
    lanes.ingest({ role: "prospect", text: t, final: true });
    paint();
  }
  assert.deepEqual(texts(), ["a", "b", "c"], "head trimmed to maxLines");
  lanes.ingest({ role: "prospect", text: "d…", final: false });
  paint();
  assert.deepEqual(texts(), ["a", "b", "c", "d…"]);
  assert.equal(painter.rebuilds, 1, "only the very first paint rebuilt the lane");
  assert.ok(!container.children.includes(interimNode), "the old interim node was removed");
});

test("the frame scheduler coalesces many requests into one paint per key per frame", () => {
  const frames = [];
  const scheduler = createFrameScheduler((cb) => frames.push(cb));
  let answerPaints = 0;
  let lanePaints = 0;
  for (let i = 0; i < 50; i++) scheduler.request("answer", () => answerPaints++);
  scheduler.request("lane", () => lanePaints++);
  assert.equal(frames.length, 1, "one animation frame requested");
  frames.shift()();
  assert.equal(answerPaints, 1);
  assert.equal(lanePaints, 1);
  scheduler.request("answer", () => answerPaints++);
  assert.equal(frames.length, 1, "the next request asks for the next frame");
});
