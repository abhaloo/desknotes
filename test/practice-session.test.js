import test from "node:test";
import assert from "node:assert/strict";
import { buildPracticeContext, createPracticeSession } from "../src/desktop/practice/session.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake answer engine: streams the question back in two deltas. */
function fakeAnswerer({ failOn = null } = {}) {
  const calls = [];
  const streamAnswer = (args) => {
    calls.push(args);
    return (async function* () {
      yield `Answer to ${args.question}`;
      await sleep(5);
      if (failOn && args.question.includes(failOn)) throw new Error("provider down");
      yield " second half.";
    })();
  };
  return { streamAnswer, calls };
}

const questionSegmenter = {
  consider: async ({ text }) =>
    text.includes("?")
      ? { band: "question", p: 0.9, source: "judge", reason: "judge is_question p=0.90" }
      : { band: "small-talk", p: 0.05, source: "judge", reason: "judge is_question p=0.05" },
};

function harness(options = {}) {
  const events = [];
  const session = createPracticeSession({
    material: { problemStatement: "Design a rate limiter.", docsName: "resume.md", docsText: "I built X." },
    segmenter: questionSegmenter,
    streamAnswer: fakeAnswerer(options).streamAnswer,
    onEvent: (event) => events.push(event),
    ...options,
  });
  session.start();
  return { session, events };
}

test("buildPracticeContext assembles statement + documents", () => {
  const context = buildPracticeContext({
    problemStatement: "Design a rate limiter.",
    docsName: "resume.md",
    docsText: "I built X.",
  });
  assert.match(context, /^PRACTICE PROBLEM STATEMENT:\nDesign a rate limiter\./);
  assert.match(context, /DOCUMENTS:\nFile: resume\.md\n\nI built X\./);
});

test("a question gets its own streamed answer; small talk gets nothing", async () => {
  const { session, events } = harness();
  const entry = await session.onUtterance({ text: "How would you shard it?", final: true });
  assert.equal(entry.question, "How would you shard it?");
  await sleep(30);
  const types = events.map((event) => event.type);
  assert.deepEqual(types, ["question", "answer-start", "answer-delta", "answer-delta", "answer-done"]);
  assert.equal(entry.status, "done");
  assert.equal(entry.answer, "Answer to How would you shard it? second half.");
  assert.equal(entry.evidence.reason, "judge is_question p=0.90");

  const skipped = await session.onUtterance({ text: "let me check with my team", final: true });
  assert.equal(skipped, null);
  assert.equal(session.record().questions.length, 1);
  assert.equal(session.record().skipped.length, 1);
  assert.equal(events.filter((e) => e.type === "question").length, 1);
});

test("interim, agent and duplicate utterances never trigger", async () => {
  const { session } = harness();
  assert.equal(await session.onUtterance({ text: "How now?", final: false }), null);
  assert.equal(await session.onUtterance({ text: "How now?", final: true, source: "agent" }), null);
  await session.onUtterance({ text: "How now?", final: true });
  assert.equal(await session.onUtterance({ text: "How now?", final: true }), null); // ASR re-delivery
  assert.equal(session.record().questions.length, 1);
});

test("interleaved questions each stream their own answer", async () => {
  const { session, events } = harness();
  const a = await session.onUtterance({ text: "First question?", final: true });
  const b = await session.onUtterance({ text: "Second question?", final: true });
  await sleep(30);
  assert.equal(a.answer, "Answer to First question? second half.");
  assert.equal(b.answer, "Answer to Second question? second half.");
  // The done events may settle in either order: assert the set, not the order.
  const doneIds = events.filter((e) => e.type === "answer-done").map((e) => e.id).sort();
  assert.deepEqual(doneIds, [a.id, b.id].sort());
});

test("end() cuts in-flight streams and marks them cut", async () => {
  const slow = {
    streamAnswer: (args) =>
      (async function* () {
        yield "partial ";
        await sleep(200);
        yield "never";
      })(),
  };
  const events = [];
  const session = createPracticeSession({
    material: { problemStatement: "p" },
    segmenter: questionSegmenter,
    streamAnswer: slow.streamAnswer,
    onEvent: (event) => events.push(event),
  });
  session.start();
  const entry = await session.onUtterance({ text: "Slow question?", final: true });
  await sleep(10);
  const record = session.end();
  const atEnd = events.length;
  await sleep(250); // let the cut stream settle
  assert.equal(record.questions[0].status, "cut");
  assert.equal(record.questions[0].answer, "partial ");
  assert.ok(record.endedAt);
  assert.equal(session.isActive(), false);
  assert.equal(await session.onUtterance({ text: "Later question?", final: true }), null); // no-op
  assert.equal(entry.status, "cut");
  assert.equal(events.length, atEnd, "no events after end()");
});

test("an abort-triggered stream error settles as a cut, not a failure", async () => {
  const events = [];
  const session = createPracticeSession({
    material: { problemStatement: "p" },
    segmenter: questionSegmenter,
    streamAnswer: () =>
      (async function* () {
        yield "partial ";
        await sleep(20);
        throw new Error("provider aborted");
      })(),
    onEvent: (event) => events.push(event),
  });
  session.start();
  const entry = await session.onUtterance({ text: "Slow question?", final: true });
  await sleep(5);
  const record = session.end();
  const atEnd = events.length;
  await sleep(40);
  assert.equal(entry.status, "cut");
  assert.equal(record.questions[0].status, "cut");
  assert.ok(!events.some((e) => e.type === "answer-failed"));
  assert.equal(events.length, atEnd, "nothing is emitted after end()");
});

test("a failing stream records a failed question and keeps going", async () => {
  const { session, events } = harness({ failOn: "Doomed" });
  const entry = await session.onUtterance({ text: "Doomed question?", final: true });
  await sleep(30);
  assert.equal(entry.status, "failed");
  assert.ok(events.some((e) => e.type === "answer-failed" && e.id === entry.id));
  const next = await session.onUtterance({ text: "Next question?", final: true });
  await sleep(30);
  assert.equal(next.status, "done");
});
