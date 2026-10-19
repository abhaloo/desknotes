import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GLOSSARY_LIMITS } from "../src/server/engines/glossary.js";
import {
  TERMS_MAX,
  TERM_CLASS,
  TERM_FULL_CLASS,
  TERM_NAME_CLASS,
  TERM_WHAT_CLASS,
  TermsPainter,
  TermsState,
  normalizeTerms,
} from "../src/desktop/renderer/terms-view.js";

const renderer = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop", "renderer");
const read = (name) => readFileSync(join(renderer, name), "utf8");

/** Minimal DOM double (as in answer-cards-render.test.js): text is the concatenation of child text. */
class FakeNode {
  constructor(text = "") {
    this.children = [];
    this._text = text;
    this.className = "";
    this.hidden = true;
    this.writes = 0;
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
      this.children.push(item);
    }
  }
  replaceChildren(...items) {
    this.children = [];
    this._text = "";
    this.writes += 1;
    this.append(...items);
  }
}

function painter() {
  const node = new FakeNode();
  const made = [];
  const createPart = (className) => {
    made.push(className);
    return Object.assign(new FakeNode(), { className });
  };
  return { node, made, painter: new TermsPainter(node, { createPart }) };
}

const MQTT = { term: "MQTT", full_name: "Message Queuing Telemetry Transport", what: "lightweight publish/subscribe protocol." };
const BACKPRESSURE = { term: "Backpressure", what: "a slow consumer makes the producer slow down." };

test("the renderer's cap is the engine's", () => {
  assert.equal(TERMS_MAX, GLOSSARY_LIMITS.terms);
});

test("entries are strings only, trimmed, at most three; anything else is dropped", () => {
  assert.deepEqual(
    normalizeTerms([
      { term: "  MQTT ", full_name: " Message Queuing Telemetry Transport ", what: " protocol. " },
      { term: "TSDB", full_name: 42, what: "stores readings by time." },
      { term: "", what: "no term" },
      { term: "Kafka" },
      "junk",
      { term: "Redis", what: "in-memory store." },
      { term: "gRPC", what: "a fourth entry." },
    ]),
    [
      { term: "MQTT", fullName: "Message Queuing Telemetry Transport", what: "protocol." },
      { term: "TSDB", fullName: "", what: "stores readings by time." },
      { term: "Redis", fullName: "", what: "in-memory store." },
    ],
  );
  assert.deepEqual(normalizeTerms(null), []);
});

test("a block paints the term and full name, then the explanation, as text nodes", () => {
  const { node, made, painter: p } = painter();
  p.paint(normalizeTerms([MQTT, BACKPRESSURE]));
  assert.equal(node.hidden, false);
  assert.equal(node.children.length, 2);
  assert.equal(node.children[0].className, TERM_CLASS);
  assert.equal(node.children[0].textContent, "MQTT (Message Queuing Telemetry Transport): lightweight publish/subscribe protocol.");
  assert.deepEqual(node.children[0].children.map((c) => c.className), [TERM_NAME_CLASS, TERM_FULL_CLASS, TERM_WHAT_CLASS]);
  assert.equal(node.children[1].textContent, "Backpressure: a slow consumer makes the producer slow down.");
  assert.deepEqual(node.children[1].children.map((c) => c.className), [TERM_NAME_CLASS, TERM_WHAT_CLASS], "no full name, no brackets");
  assert.deepEqual([...new Set(made)].sort(), [TERM_CLASS, TERM_FULL_CLASS, TERM_NAME_CLASS, TERM_WHAT_CLASS].sort());
});

test("model text is never markup: tags arrive as literal text", () => {
  const { node, made, painter: p } = painter();
  p.paint(normalizeTerms([{ term: "<img src=x onerror=alert(1)>", what: "<b>bold</b> & more" }]));
  assert.equal(node.textContent, "<img src=x onerror=alert(1)>: <b>bold</b> & more");
  const leaves = node.children[0].children.flatMap((c) => c.children);
  assert.ok(leaves.every((leaf) => typeof leaf === "string"), "every leaf is a text string");
  assert.ok(made.every((className) => className.startsWith("term")), "only the block's own parts are created");
});

test("empty takes no space; the same list is not painted twice", () => {
  const { node, painter: p } = painter();
  p.paint([]);
  assert.equal(node.hidden, true);
  p.paint(normalizeTerms([MQTT]));
  const writes = node.writes;
  p.paint(normalizeTerms([MQTT]));
  assert.equal(node.writes, writes, "an unchanged block is left alone");
  p.paint([]);
  assert.equal(node.hidden, true);
  assert.equal(node.children.length, 0);
});

test("terms show for the turn on screen only: cleared on turn.started, a late frame for an older turn ignored", () => {
  const state = new TermsState();
  assert.equal(state.start("turn_1"), false, "nothing to clear yet");
  assert.equal(state.apply({ turn_id: "turn_1", terms: [MQTT] }, "turn_1"), true);
  assert.deepEqual(state.entries.map((entry) => entry.term), ["MQTT"]);
  assert.equal(state.apply({ turn_id: "turn_1", terms: [MQTT] }, "turn_1"), false, "the same block again changes nothing");

  assert.equal(state.start("turn_2"), true, "a new turn clears the block");
  assert.deepEqual(state.entries, []);
  assert.equal(state.apply({ turn_id: "turn_1", terms: [BACKPRESSURE] }, "turn_2"), false, "a late frame for the older turn");
  assert.deepEqual(state.entries, []);
  assert.equal(state.apply({ turn_id: "turn_2", terms: [BACKPRESSURE] }, "turn_2"), true);
  assert.equal(state.start("turn_2"), false, "the same turn again keeps its block");
  assert.deepEqual(state.entries.map((entry) => entry.term), ["Backpressure"]);

  assert.equal(state.clear(), true, "Clear empties it");
  assert.equal(state.apply({ turn_id: "turn_2", terms: [MQTT] }, null), false, "nothing on screen after Clear");
  assert.equal(state.apply({ terms: [MQTT] }, null), false, "a frame without a turn");
  assert.equal(state.apply({ turn_id: "turn_3", terms: [MQTT] }, "turn_3"), true, "the answer on screen, even without its turn.started");
});

test("app.js paints the block only on a terms frame, clears it on turn.started and Clear; token painting is untouched", () => {
  const app = read("app.js");
  assert.match(app, /import \{ TermsPainter, TermsState \} from "\.\/terms-view\.js";/);
  assert.match(app, /answerTerms: el\("answer-terms"\)/);
  const tokenCase = /case "turn\.token":([\s\S]*?)break;/.exec(app)?.[1] ?? "";
  assert.doesNotMatch(tokenCase, /terms/i, "a token never touches the block");
  assert.match(app, /case "turn\.started":\s*answers\.start\(data, Date\.now\(\)\);\s*if \(terms\.start\(data\.turn_id\)\) renderTerms\(\);/);
  assert.match(app, /case "terms":[\s\S]*?if \(terms\.apply\(data, answers\.active\?\.id \?\? null\)\) renderTerms\(\);\s*return;/, "a terms frame never repaints the answer");
  assert.match(app, /function renderTerms\(\) \{\s*frames\.request\("terms", \(\) => termsPainter\.paint\(terms\.entries\)\);/, "through the frame scheduler");
  const clear = /function clearDisplay\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(clear, /if \(terms\.clear\(\)\) renderTerms\(\);/);
});

test("the block sits right under the scrolling answer, pinned, muted, smaller, with no tooltip", () => {
  const html = read("index.html");
  assert.match(html, /<div id="answer-text" class="answer-text">[^<]*<\/div>\s*(?:<!--[\s\S]*?-->\s*)?<div id="answer-terms" class="answer-terms" aria-label="Terms" hidden><\/div>/);
  const block = /<div id="answer-terms"[^>]*>/.exec(html)?.[0] ?? "";
  assert.doesNotMatch(block, /\stitle=/);
  const css = read("styles.css");
  const rule = /\.answer-terms \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /position: sticky;/);
  assert.match(rule, /bottom: 0;/);
  assert.match(rule, /color: var\(--muted\);/);
  const size = Number(/font-size: (\d+(?:\.\d+)?)px;/.exec(rule)?.[1]);
  assert.ok(size > 0 && size < 14, "smaller than the 14px answer text");
  assert.match(css, /\.answer-terms\[hidden\] \{\s*display: none;\s*\}/);
  assert.match(css, /\.answer-terms \.term-name,\s*\.answer-terms \.term-full \{[^}]*color: var\(--text\);/);
});
