import test from "node:test";
import assert from "node:assert/strict";
import {
  BORDERLINE_AT,
  MAX_RECENT,
  QUESTION_AT,
  createQuestionSegmenter,
  fallbackQuestion,
} from "../src/desktop/practice/segmenter.js";

const OPENERS = [
  "who",
  "what",
  "where",
  "when",
  "why",
  "how",
  "which",
  "whose",
  "whom",
  "can",
  "could",
  "would",
  "should",
  "will",
  "do",
  "does",
  "did",
  "is",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "tell me",
  "walk me through",
  "explain",
  "describe",
  "give me",
];

test("fallback: question mark, interrogative openers, statements", () => {
  assert.equal(fallbackQuestion("How would you design a rate limiter?").band, "question");
  assert.equal(fallbackQuestion("How would you design a rate limiter?").reason, "ends with a question mark");
  assert.equal(fallbackQuestion("Walk me through your last project").band, "question");
  assert.match(fallbackQuestion("Walk me through your last project").reason, /opens with "walk me through"/);
  assert.equal(fallbackQuestion("Tell me about a hard bug").band, "question");
  assert.equal(fallbackQuestion("Explain the CAP trade-offs").band, "question");
  assert.equal(fallbackQuestion("Let me check with my team.").band, "small-talk");
  assert.equal(fallbackQuestion("Let me check with my team.").reason, "no question signal");
  assert.equal(fallbackQuestion("").band, "small-talk");
});

test("every listed opener is a question, case-insensitively", () => {
  for (const opener of OPENERS) {
    const decision = fallbackQuestion(`${opener} the rollout plan`);
    assert.equal(decision.band, "question", opener);
    assert.equal(decision.reason, `opens with "${opener}"`, opener);
  }
  assert.equal(fallbackQuestion("EXPLAIN the migration").band, "question");
  assert.equal(fallbackQuestion("Walk Me Through the incident").band, "question");
  assert.equal(fallbackQuestion("Tell Me about the incident").band, "question");
});

test("near-misses and word stems stay context", () => {
  for (const text of [
    "doing the rollout",
    "doesn't matter to me",
    "canvas deploy is green",
    "howdy, good to meet you",
    "issue tracker says fixed",
    "Ireland trip was fun",
    "wonder what happens next",
    "there is one leftover",
    "Are you sure", // opener without a question mark is still a question
  ]) {
    const expected = text === "Are you sure" ? "question" : "small-talk";
    assert.equal(fallbackQuestion(text).band, expected, text);
  }
});

test("the question mark only counts at the end", () => {
  assert.equal(fallbackQuestion("Really? ").band, "question");
  assert.equal(fallbackQuestion("Really? ").reason, "ends with a question mark");
  assert.equal(fallbackQuestion("so pricing? no").band, "small-talk");
  assert.equal(fallbackQuestion("so pricing? no").reason, "no question signal");
});

test("consider returns the frozen decision shape with a printable reason", async () => {
  const segmenter = createQuestionSegmenter();
  assert.deepEqual(await segmenter.consider({ text: "what does the enterprise tier cost" }), {
    band: "question",
    p: null,
    source: "fallback",
    reason: 'opens with "what"',
  });
  assert.deepEqual(await segmenter.consider({ text: "yeah that makes sense" }), {
    band: "small-talk",
    p: null,
    source: "fallback",
    reason: "no question signal",
  });
  assert.deepEqual(await segmenter.consider({ text: "   " }), {
    band: "small-talk",
    p: null,
    source: "fallback",
    reason: "empty utterance",
  });
});

test("consider never rejects and stays inside the frozen union", async () => {
  const segmenter = createQuestionSegmenter();
  for (const utterance of [undefined, {}, { text: null }, { text: 42 }, { text: "How would you shard it?" }]) {
    const decision = await segmenter.consider(utterance);
    assert.ok(["question", "maybe", "small-talk"].includes(decision.band));
    assert.equal(decision.p, null);
    assert.equal(decision.source, "fallback");
    assert.equal(typeof decision.reason, "string");
    assert.ok(decision.reason.length > 0);
  }
});

test("no judge hook is ever called, even when one is injected", async () => {
  let calls = 0;
  const segmenter = createQuestionSegmenter({
    ask: () => {
      calls += 1;
      throw new Error("model calls are not allowed on the transcript path");
    },
  });
  const decision = await segmenter.consider({ text: "How would you shard it?" });
  assert.equal(calls, 0);
  assert.equal(decision.band, "question");
  assert.equal(decision.source, "fallback");
});

test("frozen constants and consumed contract survive", () => {
  assert.equal(QUESTION_AT, 0.5);
  assert.equal(BORDERLINE_AT, 0.2);
  assert.equal(MAX_RECENT, 3);
  // What Task 2 branches on: only band === "question" triggers an answer.
  assert.notEqual(fallbackQuestion("let me check with my team").band, "question");
  assert.equal(fallbackQuestion("How would you shard it?").band, "question");
});
