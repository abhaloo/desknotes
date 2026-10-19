import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnswerPainter, HIGHLIGHT_CLASS } from "../src/desktop/renderer/stream-paint.js";
import { AnswerBuffer } from "../src/desktop/renderer/answer-buffer.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(join(here, "..", "src", "desktop", "renderer", file), "utf8");

/** DOM double: children are strings (text nodes) or FakeNode elements; nothing parses HTML. */
class FakeNode {
  constructor(tag = "div") {
    this.tag = tag;
    this.className = "";
    this.children = [];
  }
  get textContent() {
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  set textContent(value) {
    this.children = value === "" ? [] : [String(value)];
  }
  append(...items) {
    for (const item of items) this.children.push(item);
  }
}

function painterFor() {
  const node = new FakeNode();
  const spans = [];
  const painter = new AnswerPainter(node, {
    placeholder: "Waiting…",
    createPart: (className) => {
      const el = new FakeNode("span");
      el.className = className;
      return el;
    },
    createHighlight: () => {
      const span = new FakeNode("span");
      span.className = HIGHLIGHT_CLASS;
      spans.push(span);
      return span;
    },
  });
  return { node, spans, painter };
}

/** The card as text, a highlight as [phrase]. */
function shape(node) {
  if (typeof node === "string") return node;
  if (node.className === HIGHLIGHT_CLASS) return `[${node.textContent}]`;
  if (node.children.length === 0) return node.textContent;
  return node.children.map(shape).join("");
}

/** Stream `text` as `deltas` through an AnswerBuffer into a painter, then `done`. */
function stream(deltas, text = deltas.join("")) {
  const { node, painter } = painterFor();
  const answers = new AnswerBuffer();
  answers.start({ turn_id: "t1" });
  painter.paint(answers.active);
  for (const delta of deltas) painter.paint(answers.append({ turn_id: "t1", delta }));
  const streamed = shape(node);
  painter.paint(answers.done({ turn_id: "t1", text }));
  return { streamed, final: shape(node), painter };
}

const ANSWER = "• Use **Go Live** to start.\n• Only **one session at a time** runs.";
const SHAPE = "• Use [Go Live] to start.\n• Only [one session at a time] runs.";

test("a ** pair paints as an hl span; the markers never show", () => {
  const { node, spans, painter } = painterFor();
  painter.paint({ id: "t1", text: ANSWER, done: true });
  assert.equal(shape(node), SHAPE);
  assert.equal(node.textContent.includes("*"), false);
  assert.deepEqual(spans.map((s) => [s.tag, s.className]), [["span", "hl"], ["span", "hl"]]);
});

test("a marker split across deltas at every position paints the same card", () => {
  const all = Array.from(ANSWER);
  assert.deepEqual(stream(all).streamed, SHAPE, "one character per delta");
  for (let cut = 1; cut < ANSWER.length; cut += 1) {
    const { streamed, final, painter } = stream([ANSWER.slice(0, cut), ANSWER.slice(cut)]);
    assert.equal(streamed, SHAPE, `cut at ${cut}`);
    assert.equal(final, SHAPE, `cut at ${cut}`);
    // The empty started card and the first token paint in full; the rest append,
    // and the identical done text does not touch the DOM.
    assert.equal(painter.fullPaints, 2, `cut at ${cut}`);
  }
});

test("streaming stays append-only with highlights", () => {
  const { painter } = stream(["• Use ", "**Go Live**", " to start.\n• Only ", "**one session at a time**", " runs."]);
  assert.equal(painter.fullPaints, 2, "only the started card and the first token paint in full");
  assert.equal(painter.appends, 4);
});

test("a single star waits for the next delta, and shows when it is text", () => {
  const { node, painter } = painterFor();
  painter.paint({ id: "t1", text: "• 5 *" });
  assert.equal(shape(node), "• 5 ", "held: it may be half a marker");
  painter.paint({ id: "t1", text: "• 5 * 3" });
  assert.equal(shape(node), "• 5 * 3");
  painter.paint({ id: "t1", text: "• 5 * 3 *" });
  painter.paint({ id: "t1", text: "• 5 * 3 *", done: true });
  assert.equal(shape(node), "• 5 * 3 *", "a trailing star shows once the answer is done");
});

test("the full repaint parses the whole text: a diverging done text and a new turn", () => {
  const { node, painter } = painterFor();
  painter.paint({ id: "t1", text: "• Draft" });
  painter.paint({ id: "t1", text: "• Final **answer** here.", done: true });
  assert.equal(shape(node), "• Final [answer] here.");
  painter.paint({ id: "t2", text: "• Next **one" });
  assert.equal(shape(node), "• Next [one]", "an open phrase paints as open");
  painter.paint(null);
  assert.equal(shape(node), "Waiting…");
});

test("model text is never parsed as HTML", () => {
  const { node, spans, painter } = painterFor();
  const text = '• Type <b>bold</b> or &lt;tag&gt; and **<img src=x onerror=alert(1)>**';
  painter.paint({ id: "t1", text, done: true });
  assert.equal(shape(node), "• Type <b>bold</b> or &lt;tag&gt; and [<img src=x onerror=alert(1)>]");
  assert.equal(spans.length, 1, "the only element created is the highlight span");
  assert.ok(node.children.every((c) => typeof c === "object" && c.className.startsWith("ln")));
  assert.ok(node.children[0].children.includes(spans[0]));
  const source = read("stream-paint.js");
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "DOMParser", "createContextualFragment", "document.write"]) {
    assert.equal(source.includes(sink), false, `stream-paint.js must not use ${sink}`);
  }
});

test("the AnswerBuffer cap never cuts a marker into a visible star", () => {
  const answers = new AnswerBuffer({ maxChars: 10 });
  answers.append({ turn_id: "t1", delta: "• Use **Go" }); // 10 chars: fits
  assert.equal(answers.active.text, "• Use **Go");
  const cut = new AnswerBuffer({ maxChars: 7 });
  cut.append({ turn_id: "t1", delta: "• Use **Go Live**" });
  assert.equal(cut.active.text, "• Use ", "the cut moves back before the marker");
  assert.equal(cut.active.truncated, true);
  cut.append({ turn_id: "t1", delta: " more" });
  assert.equal(cut.active.text, "• Use ", "later deltas leave the cut head alone");
  cut.done({ turn_id: "t1", text: "• Use **Go Live** to start." });
  assert.equal(cut.active.text, "• Use **Go Live** to start.", "done replaces the text");
});

test("css: an orange text-only highlight, a token on :root, distinct from the screen badge", () => {
  const css = read("styles.css");
  const root = /:root \{[^}]*\}/.exec(css)?.[0] ?? "";
  const token = /--highlight: (#[0-9a-f]{6});/i.exec(root)?.[1];
  assert.ok(token, "--highlight is defined on :root");
  assert.ok(!["#fdba74", "#fb923c"].includes(token.toLowerCase()), "not the badge's orange");
  const rule = /\.answer-text \.hl[,\s][^{}]*\{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.match(rule, /color: var\(--highlight\);/);
  assert.ok(!/background|cursor|border/.test(rule), "text colour only");
  // Readable on the answer panel (--panel-strong, rgba(15, 19, 27, 0.94)): WCAG AA for body text.
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (lum(token) + 0.05) / (lum("#0f131b") + 0.05);
  assert.ok(ratio >= 4.5, `contrast ${ratio.toFixed(2)}`);
});
