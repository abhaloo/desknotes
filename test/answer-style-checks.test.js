import test from "node:test";
import assert from "node:assert/strict";
import { passes, scoreAnswer, summarize } from "../bench/answer-style-checks.mjs";

test("scoreAnswer flags chatbot openers, closers, AI vocabulary and negative parallels", () => {
  const score = scoreAnswer({
    raw: "Great question! It's crucial to leverage data \u2014 not only speed but trust. Let me know if that helps.",
    delivered: "Great question! It's crucial to leverage data, not only speed but trust. Let me know if that helps.",
  });
  assert.equal(score.opener, true);
  assert.equal(score.closer, true);
  assert.deepEqual(score.aiHits, ["crucial", "leverage"]);
  assert.equal(score.negativeParallel, true);
  assert.equal(score.rawDashes, 1);
  assert.equal(score.hardTotal, 0);
});

test("scoreAnswer counts hard-rule characters left in delivered text", () => {
  const score = scoreAnswer({ delivered: "We **ship** \u2014 fast \uD83D\uDE80 \u201Cnow\u201D\n- item" });
  assert.equal(score.deliveredHard.dashes, 1);
  assert.equal(score.deliveredHard.markdown, 3, "two ** plus one list marker");
  assert.equal(score.deliveredHard.emoji, 1);
  assert.equal(score.deliveredHard.curly, 2);
  assert.equal(score.hardTotal, 7);
});

test("facts are matched case-insensitively and refusals are caught for uncovered questions", () => {
  const covered = scoreAnswer({ delivered: "I led the ACME migration in 2021.", expect: ["Acme migration", "2021", "Toronto"] });
  assert.deepEqual(covered.factsMissing, ["Toronto"]);
  const refused = scoreAnswer({ delivered: "I don't know that one.", uncovered: true });
  assert.equal(refused.refused, true);
  const plausible = scoreAnswer({ delivered: "I'd start with a short pilot.", uncovered: true });
  assert.equal(plausible.refused, false);
});

test("the audit's leftovers are flagged: 'actually', tailing 'not just' and AI disclaimers", () => {
  const score = scoreAnswer({ delivered: "I actually help people solve problems, not just push products." });
  assert.deepEqual(score.aiHits, ["actually"]);
  assert.equal(score.negativeParallel, true);
  assert.equal(score.disclaimer, false);
  for (const text of ["I don't have access to your contract details.", "As an AI, I can't say.", "I don't have any information on that."]) {
    assert.equal(scoreAnswer({ delivered: text }).disclaimer, true, text);
  }
  const summary = summarize([scoreAnswer({ delivered: "I don't have access to pricing." })]);
  assert.equal(summary.disclaimers, 1);
  assert.equal(passes(summary), false, "an AI disclaimer fails the bench");
});

test("passes() needs zero hard characters, openers and closers, and at most one AI word per ten answers", () => {
  const clean = Array.from({ length: 10 }, () => scoreAnswer({ delivered: "We ship weekly. It works." }));
  assert.equal(passes(summarize(clean)), true);
  const oneWord = [...clean.slice(1), scoreAnswer({ delivered: "It's crucial." })];
  assert.equal(passes(summarize(oneWord)), true);
  const twoWords = [...clean.slice(2), scoreAnswer({ delivered: "It's crucial." }), scoreAnswer({ delivered: "A robust plan." })];
  assert.equal(passes(summarize(twoWords)), false);
  assert.equal(passes(summarize([scoreAnswer({ delivered: "Fast \u2014 now." })])), false);
});
