import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnswerBuffer } from "../src/desktop/renderer/answer-buffer.js";

/** An answer the engine cut short says so under the card (turn.done `cut`). */
const here = dirname(fileURLToPath(import.meta.url));
const readRenderer = (file) => readFileSync(join(here, "..", "src", "desktop", "renderer", file), "utf8");

test("turn.done cut lands on the entry; a whole answer and the next turn carry none", () => {
  const answers = new AnswerBuffer();
  answers.start({ turn_id: "t1", question: "q" }, 1);
  assert.equal(answers.active.cut, null, "a streaming answer is not cut");
  answers.done({ turn_id: "t1", text: "• VERDICT: x.", cut: "lines" }, 2);
  assert.equal(answers.active.cut, "lines");
  answers.start({ turn_id: "t2", question: "q2" }, 3);
  assert.equal(answers.active.cut, null, "the next turn starts clean");
  answers.done({ turn_id: "t2", text: "• VERDICT: y." }, 4);
  assert.equal(answers.active.cut, null);
  answers.done({ turn_id: "t3", text: "z", cut: 7 }, 5);
  assert.equal(answers.active.cut, null, "only a reason string counts");
});

test("renderer: a done, cut answer shows a quiet note under the text", () => {
  const app = readRenderer("app.js");
  const css = readRenderer("styles.css");
  assert.match(app, /const cut = Boolean\(active\?\.done && active\.cut\);/);
  assert.match(app, /if \(cut\) els\.answerText\.dataset\.cut = "";\s*else delete els\.answerText\.dataset\.cut;/);
  const rule = /\.answer-text\[data-cut\]::after \{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.match(rule, /content: "Answer cut short\."/);
  assert.match(rule, /color: var\(--muted\)/);
});
