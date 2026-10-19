import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANSWER_QUESTION_MAX_CHARS, AnswerBuffer, answerQuestion } from "../src/desktop/renderer/answer-buffer.js";

/** The answer window names the question each answer is for, above the answer. */
const here = dirname(fileURLToPath(import.meta.url));
const readRenderer = (file) => readFileSync(join(here, "..", "src", "desktop", "renderer", file), "utf8");

const GREENHOUSE =
  "A company operates commercial greenhouses across multiple regions. Each greenhouse contains sensors measuring temperature, humidity, and soil moisture. We need a service that continuously ingests those readings and provides a dashboard showing current conditions, historical trends, and anomaly alerts. Your task is to design the back-end architecture. Start by clarifying the requirements, then walk us through your design. You can use diagrams or notes.";

test("turn.started puts the question on the answer entry", () => {
  const answers = new AnswerBuffer();
  answers.start({ turn_id: "t1", question: "  how much is the\n enterprise plan " }, 1);
  assert.equal(answers.active.question, "How much is the enterprise plan");
  answers.append({ turn_id: "t1", delta: "\u2022 It depends." }, 2);
  assert.equal(answers.active.question, "How much is the enterprise plan", "tokens keep it");
  answers.start({ turn_id: "t2", question: "what about SSO" }, 3);
  assert.equal(answers.active.question, "What about SSO", "the next turn brings its own");
});

test("a screen turn's display text wins over its prompt text; long questions are cut", () => {
  assert.equal(answerQuestion({ question: "Answer the question or task shown on the screen.", display_question: "On screen: Caching question" }), "On screen: Caching question");
  assert.equal(answerQuestion({ question: "plain" , display_question: "  " }), "Plain");
  assert.equal(answerQuestion({}), "");
  assert.equal(ANSWER_QUESTION_MAX_CHARS, 120);
  const long = answerQuestion({ question: "word ".repeat(100) });
  assert.equal(long.length, ANSWER_QUESTION_MAX_CHARS);
  assert.ok(long.endsWith(" word\u2026"), "the cut ends on a whole word");
  const midWord = answerQuestion({ question: "abcdefghij ".repeat(30) });
  assert.equal(midWord, `Abcdefghij${" abcdefghij".repeat(9)}\u2026`, "a cut inside a word moves back to the space before it");
  const noSpace = answerQuestion({ question: "x".repeat(300) });
  assert.equal(noSpace, `X${"x".repeat(ANSWER_QUESTION_MAX_CHARS - 2)}\u2026`, "with no space near the limit the cut is exact");
});

test("the prospect's words are summarized to the ask; a screen turn's display text is not", () => {
  assert.equal(answerQuestion({ question: GREENHOUSE }), "Design the back-end architecture");
  assert.equal(
    answerQuestion({ question: "Answer the question or task shown on the screen.", display_question: "On screen: so, what is a mutex? Explain it." }),
    "On screen: so, what is a mutex? Explain it.",
  );
});

test("renderer: a question line above the answer, set as text, hidden when there is none", () => {
  const html = readRenderer("index.html");
  const app = readRenderer("app.js");
  const css = readRenderer("styles.css");
  assert.match(html, /<p id="answer-question" class="answer-question" hidden><\/p>\s*<div id="answer-text"/);
  assert.match(app, /answerQuestion: el\("answer-question"\)/);
  assert.match(app, /const shown = question \? `Q: \$\{question\}` : "";/);
  assert.match(app, /els\.answerQuestion\.textContent = shown;/);
  assert.match(app, /els\.answerQuestion\.hidden = !question;/);
  assert.match(css, /\.answer-question \{[^}]*white-space: nowrap/);
  assert.match(css, /\.answer-question \{[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(css, /\.answer-question \{[^}]*-webkit-line-clamp/);
});
