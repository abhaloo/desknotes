import test from "node:test";
import assert from "node:assert/strict";
import {
  ANSWER_CARDS_ENV,
  ANSWER_CARDS_SETTING,
  CARD_LIMITS,
  TRADE_OFF_LABEL,
  VERDICT_LABEL,
  cardLabel,
  isVerdictLine,
  parseAnswerCardsSwitch,
  wantsDetail,
} from "../src/shared/answer-cards.js";

test("names and limits", () => {
  assert.equal(ANSWER_CARDS_SETTING, "answerCards");
  assert.equal(ANSWER_CARDS_ENV, "ANSWER_CARDS");
  assert.deepEqual({ ...CARD_LIMITS }, { lines: 9, detailLines: 9, codeLines: 80, lineWords: 30, lineSegments: 3 });
  assert.equal(TRADE_OFF_LABEL, "TRADE-OFF");
  assert.ok(Object.isFrozen(CARD_LIMITS));
  assert.equal(VERDICT_LABEL, "VERDICT");
});

test("the ANSWER_CARDS switch reads like HIGHLIGHTS", () => {
  for (const on of [undefined, "", "1", "true", "on", " ON "]) assert.equal(parseAnswerCardsSwitch(on), true, String(on));
  for (const off of ["0", "false", "off", "Off"]) assert.equal(parseAnswerCardsSwitch(off), false, off);
  assert.equal(parseAnswerCardsSwitch("maybe"), null);
});

test("questions that ask for specifics want a detail card", () => {
  const detail = [
    "What are the exact technical differences between interface and type in TypeScript?",
    "How does a dynamic array manage capacity growth under the hood?",
    "Walk me through exactly how a sliding window rate limiter works in Redis, step by step.",
    "For the sensor readings table, which exact columns would you store?",
    "Which fields go in the reading table?",
    "What schema would you use for alerts?",
    "What's the formula for the pass@k estimator?",
    "What is the time complexity of that lookup?",
    "Can you write the code for it?",
    "Show me some pseudocode.",
    "How many requests per second can one PostgreSQL instance handle?",
    "Can you go deeper on the storage layer?",
    "Explain the JVM internals involved.",
    "Implement an LRU cache.",
    "Write a function that returns the longest palindrome.",
    "Given an array of integers, return the indices of two numbers that add up to a target.",
    "Can you solve this?",
    "I think we can do better.",
    "There might be room for improvement here.",
    "How can we optimize this?",
    "Explain dynamic array amortized append costs.",
    "How would you implement a rate limiter?",
    "Can you implement it in Python?",
    "Walk me through the code.",
  ];
  for (const question of detail) assert.equal(wantsDetail(question), true, question);
});

test("design, trade-off and story questions get the default card", () => {
  const general = [
    "Design a chat service for one-to-one and group conversations.",
    "Why would you choose Kafka over RabbitMQ for the sensor pipeline?",
    "Describe a back-end or distributed system you helped design. What did you personally own?",
    "After a routine deploy, p99 latency tripled. Walk through how you would find the cause.",
    "What does exactly-once processing mean in a stream pipeline?",
    "How do you manage complexity in a large codebase?",
    "What's the difference between a process and a thread?",
    "How would you implement a hiring process?",
    "How do you evaluate and calibrate a code-generation LLM judge, and monitor drift?",
    "What does a good code review look like?",
    "",
  ];
  for (const question of general) assert.equal(wantsDetail(question), false, question);
  assert.equal(wantsDetail(null), false);
});

test("a VERDICT line is recognised with or without its bullet", () => {
  for (const line of ["• VERDICT: use a queue.", "VERDICT: yes", "- VERDICT: yes", "  • verdict: yes", "• **VERDICT:** yes"]) {
    assert.equal(isVerdictLine(line), true, line);
  }
  for (const line of ["• 1. Clarifying requirements", "• I would use a queue.", "• HOW: a queue", "", null]) {
    assert.equal(isVerdictLine(line), false, String(line));
  }
});

test("cardLabel finds a line's uppercase label and the text after it", () => {
  assert.deepEqual(cardLabel("• VERDICT: use a queue."), { bullet: "• ", label: "VERDICT", rest: "use a queue." });
  assert.deepEqual(cardLabel("TRADE-OFF: costs more"), { bullet: "", label: "TRADE-OFF", rest: "costs more" });
  assert.deepEqual(cardLabel("• METRICS & SLA: p99"), { bullet: "• ", label: "METRICS & SLA", rest: "p99" });
  assert.deepEqual(cardLabel("• PITFALLS (Java collisions): chaining"), { bullet: "• ", label: "PITFALLS (Java collisions)", rest: "chaining" });
  assert.equal(cardLabel("• Clarify: how many sensors"), null, "a mixed-case label is ordinary text");
  assert.equal(cardLabel("• I said: yes"), null);
  assert.equal(cardLabel("• A: yes"), null, "a single letter is not a label");
  assert.equal(cardLabel("• HTTP:// is not a label"), null, "the colon must be followed by a space");
});
