import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CARD_LABEL as SHARED_CARD_LABEL } from "../src/shared/answer-cards.js";
import {
  AnswerPainter,
  CARD_LABEL as RENDERER_CARD_LABEL,
  HIGHLIGHT_CLASS,
  LINE_CLASS,
  LABEL_CLASS,
  BULLET_CLASS,
  HEAD_CLASS,
  LABELLED_CLASS,
  CODE_CLASS,
  FENCE_CLASS,
  INLINE_CODE_CLASS,
} from "../src/desktop/renderer/stream-paint.js";
import { shouldFollow } from "../src/desktop/renderer/answer-scroll.js";

/** Minimal DOM double: text is the concatenation of child text, with className. */
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

const createPart = (c) => Object.assign(new FakeNode(), { className: c });

test("the shared and renderer CARD_LABEL are the same pattern", () => {
  assert.equal(RENDERER_CARD_LABEL.source, SHARED_CARD_LABEL.source);
  assert.equal(RENDERER_CARD_LABEL.flags, SHARED_CARD_LABEL.flags);
});

test("textContent is exactly the answer text, streamed or whole", () => {
  const input =
    "• VERDICT: use **object storage** directly.\n" +
    "• HOW: signed URLs bypass the API.\n" +
    "```python\n" +
    "def upload(file):\n" +
    "    return s3.put(file, **kwargs)\n" +
    "```\n" +
    "• TRADE-OFF: clients do one extra request.";
  const text =
    "• VERDICT: use object storage directly.\n" +
    "• HOW: signed URLs bypass the API.\n" +
    "```python\n" +
    "def upload(file):\n" +
    "    return s3.put(file, **kwargs)\n" +
    "```\n" +
    "• TRADE-OFF: clients do one extra request.";

  const wholeNode = new FakeNode();
  const wholePainter = new AnswerPainter(wholeNode, { createPart });
  wholePainter.paint({ id: "t1", text: input, done: true });
  assert.equal(wholeNode.textContent, text);

  const streamNode = new FakeNode();
  const streamPainter = new AnswerPainter(streamNode, { createPart });
  let accumulated = "";
  for (let i = 0; i < input.length; i += 1) {
    accumulated += input[i];
    streamPainter.paint({ id: "t1", text: accumulated, done: i === input.length - 1 });
  }
  assert.equal(streamNode.textContent, text);
});

test("the VERDICT line is the headline; labels become tags", () => {
  const text = "• VERDICT: use a queue.\n• HOW: absorbs bursts.";
  const node = new FakeNode();
  const painter = new AnswerPainter(node, { createPart });
  painter.paint({ id: "t1", text, done: true });

  assert.equal(node.children[0].className, "ln lab head");
  const line0 = node.children[0].children;
  assert.equal(line0[0].className, "blt");
  assert.equal(line0[0].textContent, "• ");
  assert.equal(line0[1].className, "lbl");
  // The space after the colon belongs to the tag: a hidden VERDICT tag leaves no leading space on the headline.
  assert.equal(line0[1].textContent, "VERDICT: ");
  assert.equal(line0[2], "use a queue.");

  assert.equal(node.children[1].className, "ln lab");
  const line1 = node.children[1].children;
  assert.equal(line1[0].className, "blt");
  assert.equal(line1[0].textContent, "• ");
  assert.equal(line1[1].className, "lbl");
  assert.equal(line1[1].textContent, "HOW: ");
  assert.equal(line1[2], "absorbs bursts.");
});

test("a line without an uppercase label stays plain", () => {
  const text = "• Clarify: how many sensors";
  const node = new FakeNode();
  const painter = new AnswerPainter(node, { createPart });
  painter.paint({ id: "t1", text, done: true });

  assert.equal(node.children.length, 1);
  const line = node.children[0];
  assert.equal(line.className, "ln");
  assert.equal(line.children.length, 1);
  assert.equal(line.children[0], text);
});

test("code lines are painted raw, ** included", () => {
  const text = "```python\nf(**kwargs)\n```";
  const node = new FakeNode();
  const spans = [];
  const painter = new AnswerPainter(node, {
    createPart,
    createHighlight: () => {
      const span = createPart(HIGHLIGHT_CLASS);
      spans.push(span);
      return span;
    },
  });
  painter.paint({ id: "t1", text, done: true });

  const classes = node.children.map((c) => c.className);
  assert.deepEqual(classes, ["ln fence", "ln code", "ln fence"]);
  assert.equal(spans.length, 0, "no highlight span created");
});

test("a highlight in a labelled line still becomes a span", () => {
  const text = "• VERDICT: click **Go Live** now.";
  const node = new FakeNode();
  const spans = [];
  const painter = new AnswerPainter(node, {
    createPart,
    createHighlight: () => {
      const span = createPart(HIGHLIGHT_CLASS);
      spans.push(span);
      return span;
    },
  });
  painter.paint({ id: "t1", text, done: true });

  assert.equal(spans.length, 1);
  assert.equal(spans[0].textContent, "Go Live");
  assert.ok(node.children[0].children.includes(spans[0]));
});

test("scroll stays at the top unless the rep scrolled to the bottom", () => {
  assert.equal(shouldFollow({ scrollHeight: 500, scrollTop: 0, clientHeight: 300 }), false);
  assert.equal(shouldFollow({ scrollHeight: 300, scrollTop: 0, clientHeight: 300 }), false);
  assert.equal(shouldFollow({ scrollHeight: 304, scrollTop: 10, clientHeight: 300 }), false);
  assert.equal(shouldFollow({ scrollHeight: 500, scrollTop: 180, clientHeight: 300 }), true);
  assert.equal(shouldFollow({ scrollHeight: 500, scrollTop: 199, clientHeight: 300 }), true);
  assert.equal(shouldFollow({ scrollHeight: 500, scrollTop: 100, clientHeight: 300 }), false);
});

test("headline and label tags do not depend on how the text is chunked", () => {
  // The card stream sends the first line whole, and a revealed prefetch arrives in large chunks:
  // lines far longer than any label must still be decorated.
  const text =
    "• VERDICT: I'd stream every reading through **Kafka** into a time-series database, and drive the dashboard and the alerts from that one stream.\n" +
    "• SCALE: Assume 10k sensors reading every 10 seconds, so that is about 1,000 writes a second, or 8.6 GB a day.\n" +
    "• Clarify: a mixed-case word with a colon stays plain text, however long the line is.\n" +
    "• TRADE-OFF: Kafka adds operations work, but it lets us replay data and absorb bursts without slowing the dashboard.";
  const paintIn = (pieces) => {
    const node = new FakeNode();
    const painter = new AnswerPainter(node, { createPart });
    let sofar = "";
    for (const piece of pieces) {
      sofar += piece;
      painter.paint({ id: "t1", text: sofar, done: false });
    }
    painter.paint({ id: "t1", text, done: true });
    return { classes: node.children.map((c) => c.className), text: node.textContent };
  };
  const whole = paintIn([text]);
  assert.deepEqual(whole.classes, ["ln lab head", "ln lab", "ln", "ln lab"]);
  assert.equal(whole.text, text.replaceAll("**", ""));
  assert.deepEqual(paintIn(text.split(/(?<=\n)/)), whole, "line at a time");
  assert.deepEqual(paintIn([...text]), whole, "one character at a time");
  assert.deepEqual(paintIn(text.match(/[\s\S]{1,7}/g)), whole, "seven characters at a time");
});

/** The spans of one class in a painted node, as their text. */
function spansOf(node, className) {
  const found = [];
  const walk = (n) => {
    for (const child of n.children ?? []) {
      if (typeof child === "string") continue;
      if (child.className === className) found.push(child.textContent);
      walk(child);
    }
  };
  walk(node);
  return found;
}

test("inline code paints as a code span without its backticks; stars inside it stay text", () => {
  const input = "• FIX: use `seen: list | None = None`, then call `f(**kwargs)` and keep **one branch**.\n• TRADE-OFF: a `None` check.";
  const text = "• FIX: use seen: list | None = None, then call f(**kwargs) and keep one branch.\n• TRADE-OFF: a None check.";
  const paints = [];
  for (const pieces of [[input], [...input], input.match(/[\s\S]{1,3}/g)]) {
    const node = new FakeNode();
    const painter = new AnswerPainter(node, { createPart });
    let accumulated = "";
    pieces.forEach((piece, i) => {
      accumulated += piece;
      painter.paint({ id: "t1", text: accumulated, done: i === pieces.length - 1 });
    });
    assert.equal(node.textContent, text);
    assert.deepEqual(spansOf(node, INLINE_CODE_CLASS), ["seen: list | None = None", "f(**kwargs)", "None"]);
    assert.deepEqual(spansOf(node, HIGHLIGHT_CLASS), ["one branch"]);
    paints.push(JSON.stringify(node.children.map((c) => c.className)));
  }
  assert.equal(new Set(paints).size, 1, "the same lines whatever the chunk size");
});

test("inline code inside a key phrase, and an unclosed backtick ends with its line", () => {
  const node = new FakeNode();
  const painter = new AnswerPainter(node, { createPart });
  painter.paint({ id: "t1", text: "• VERDICT: use **`unknown` first** here.\n• HOW: a `stray tick\n• TRADE-OFF: none.", done: true });
  assert.deepEqual(spansOf(node, HIGHLIGHT_CLASS), ["unknown first"]);
  assert.deepEqual(spansOf(node, INLINE_CODE_CLASS), ["unknown", "stray tick"]);
  assert.equal(node.children[2].className, "ln lab", "the next line is not code");
  assert.equal(node.children[2].textContent, "• TRADE-OFF: none.");
});

test("inline code is styled monospace in the overlay and practice", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "renderer", "styles.css"), "utf8");
  const rule = /([^{}]*)\{[^}]*font-family: ui-monospace[^}]*\}/g;
  const selectors = [...css.matchAll(rule)].map((m) => m[1]).join(" ");
  assert.match(selectors, /\.answer-text \.ic/);
  assert.match(selectors, /\.practice-prose \.ic/);
});
