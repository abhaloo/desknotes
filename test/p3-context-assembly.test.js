import test from "node:test";
import assert from "node:assert/strict";
import { buildContext, createPipelineEngine } from "../src/server/engines/pipeline.js";

test("a lone document fills the whole 32k budget including its heading", () => {
  const text = buildContext({ docs: "x".repeat(40_000) });
  assert.equal(text.length, 32_000);
  assert.ok(text.startsWith("DOCUMENTS:\n"));
});

test("resume and playbook are capped, and the document gets the remainder", () => {
  const text = buildContext({ resume: "r".repeat(9_000), playbook: "p".repeat(9_000), docs: "d".repeat(40_000) });
  assert.ok(text.length <= 32_000);
  assert.ok(text.startsWith("RESUME:\n" + "r".repeat(4_000)));
  assert.ok(text.includes("PLAYBOOK:\n" + "p".repeat(4_000)));
  assert.ok(text.includes("DOCUMENTS:\n"));
});

test("history: newest two pairs, truncated, rendered after the document", () => {
  const text = buildContext({
    docs: "DOC",
    history: [
      { q: "q1", a: "a1" },
      { q: "q2", a: "a2" },
      { q: "q3", a: "a3" },
    ],
  });
  assert.ok(text.includes("DOCUMENTS:\nDOC"));
  assert.ok(text.includes("RECENT EXCHANGE:\n"));
  assert.ok(text.includes("Q: q2"));
  assert.ok(text.includes("Q: q3"));
  assert.ok(!text.includes("q1"));
  const tail = text.slice(text.indexOf("RECENT EXCHANGE:"));
  assert.ok(tail.indexOf("Q: q2") < tail.indexOf("Q: q3"));
});

test("history strings are capped per side and in total", () => {
  const text = buildContext({ history: [{ q: "q".repeat(500), a: "a".repeat(900) }] });
  const exchange = text.slice(text.indexOf("RECENT EXCHANGE:"));
  assert.ok(exchange.length <= "RECENT EXCHANGE:".length + 1_000);
  assert.ok(exchange.includes("Q: " + "q".repeat(200)));
});

test("buildContext is deterministic and total is always <= 32k", () => {
  const args = { resume: "r".repeat(50_000), playbook: "p".repeat(50_000), docs: "d".repeat(50_000), history: [{ q: "q".repeat(5_000), a: "a".repeat(5_000) }] };
  assert.equal(buildContext(args), buildContext(args));
  assert.ok(buildContext(args).length <= 32_000);
});

function fakeAnswerer(calls) {
  return {
    async *streamAnswer(args) {
      calls.push(args);
      yield "the answer";
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("waitFor timed out");
}

test("the pipeline feeds finished committed answers back in as history", async () => {
  const frames = [];
  const calls = [];
  const engine = createPipelineEngine({ emit: (frame) => frames.push(frame), answerer: fakeAnswerer(calls), log: () => {} });
  engine.onSessionStart({ sessionId: "s" });
  engine.onContextSet({ docs: "DOC", name: "notes.md" });

  engine.onAnswerRequest({ utterance: "first question" });
  await waitFor(() => frames.some((frame) => frame.type === "turn.done"));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].context.includes("File: notes.md"));

  engine.onAnswerRequest({ utterance: "second question" });
  await waitFor(() => calls.length === 2);
  assert.ok(calls[1].context.includes("RECENT EXCHANGE:"));
  assert.ok(calls[1].context.includes("Q: first question"));
  assert.ok(calls[1].context.includes("A: the answer"));
  assert.ok(!calls[1].context.includes("Q: second question"));
  engine.onSessionEnd();
});

test("no history section before the first committed answer", async () => {
  const frames = [];
  const calls = [];
  const engine = createPipelineEngine({ emit: (frame) => frames.push(frame), answerer: fakeAnswerer(calls), log: () => {} });
  engine.onSessionStart({ sessionId: "s" });
  engine.onAnswerRequest({ utterance: "only question" });
  await waitFor(() => calls.length === 1);
  assert.ok(!calls[0].context.includes("RECENT EXCHANGE:"));
  engine.onSessionEnd();
});

test("a failed turn never becomes follow-up history, streamed text or not", async () => {
  const frames = [];
  const calls = [];
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    answerer: {
      async *streamAnswer(args) {
        calls.push(args);
        yield "partial ";
        throw new Error("provider exploded");
      },
    },
    log: () => {},
  });
  engine.onSessionStart({ sessionId: "s" });
  engine.onAnswerRequest({ utterance: "first question" });
  await waitFor(() => frames.some((frame) => frame.type === "turn.done"));
  assert.equal(calls.length, 3, "the attempt and its two retries all failed");
  engine.onAnswerRequest({ utterance: "second question" });
  await waitFor(() => calls.length === 4);
  assert.ok(!calls[3].context.includes("RECENT EXCHANGE:"), "a partially-streamed FAILED turn is never recorded");
  engine.onSessionEnd();
});

test("a failed empty attempt whose retry delivers is recorded", async () => {
  const frames = [];
  const calls = [];
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    answerer: {
      async *streamAnswer(args) {
        calls.push(args);
        if (calls.length === 1) throw new Error("flaky start");
        yield "the answer";
      },
    },
    log: () => {},
  });
  engine.onSessionStart({ sessionId: "s" });
  engine.onAnswerRequest({ utterance: "only question" });
  await waitFor(() => frames.some((frame) => frame.type === "turn.done"));
  engine.onAnswerRequest({ utterance: "follow-up question" });
  await waitFor(() => calls.length === 3); // failed attempt, retry, follow-up
  assert.ok(calls[2].context.includes("RECENT EXCHANGE:"));
  assert.ok(calls[2].context.includes("Q: only question"));
  assert.ok(calls[2].context.includes("A: the answer"));
  engine.onSessionEnd();
});

/** A document over the budget: four sections, the TypeScript one last. */
function bigDocument() {
  return [
    `# Profile\n${"i".repeat(10_000)}\n`,
    `## Billing\n${"b".repeat(10_000)}\n`,
    `## Hiring\n${"h".repeat(10_000)}\n`,
    `## TypeScript: any and unknown\n${"t".repeat(5_000)}\n`,
  ];
}

test("a document that fits is passed through unchanged", () => {
  const docs = bigDocument().slice(0, 2).join("");
  assert.equal(buildContext({ docs, question: "anything" }), `DOCUMENTS:\n${docs}`);
});

test("an oversized document drops whole sections, the least relevant first, and keeps document order", () => {
  const [profile, billing, hiring, typescript] = bigDocument();
  const text = buildContext({ docs: profile + billing + hiring + typescript, question: "What is the difference between any and unknown in TypeScript?" });
  assert.ok(text.length <= 32_000);
  assert.ok(text.includes(typescript), "the late, relevant section is kept whole");
  assert.ok(text.includes(profile) && text.includes(billing), "earlier sections are kept whole");
  assert.equal(text.includes("## Hiring"), false, "a whole section is dropped");
  assert.ok(text.indexOf("## Billing") < text.indexOf("## TypeScript"), "document order");
  assert.equal(/h{2}/.test(text), false, "no part of the dropped section remains");
});

test("with no relevant section, the document keeps its first sections whole", () => {
  const [profile, billing, hiring, typescript] = bigDocument();
  const text = buildContext({ docs: profile + billing + hiring + typescript, question: "" });
  assert.ok(text.includes(profile + billing + hiring));
  assert.equal(text.includes("## TypeScript"), false);
});

test("history: the newest exchange is kept whole; the older one gets what is left", () => {
  const history = [
    { q: "o".repeat(200), a: "p".repeat(400) },
    { q: "n".repeat(200), a: "m".repeat(400) },
  ];
  const text = buildContext({ history });
  const exchange = text.slice(text.indexOf("RECENT EXCHANGE:\n") + "RECENT EXCHANGE:\n".length);
  assert.ok(exchange.length <= 1_000);
  assert.ok(exchange.endsWith(`Q: ${"n".repeat(200)}\nA: ${"m".repeat(400)}`), "the newest pair is whole");
  assert.ok(exchange.startsWith(`Q: ${"o".repeat(200)}`), "the older pair is cut, not the newer");
});

test("the pipeline fits the document to the question being answered", async () => {
  const frames = [];
  const calls = [];
  const engine = createPipelineEngine({ emit: (frame) => frames.push(frame), answerer: fakeAnswerer(calls), log: () => {} });
  engine.onSessionStart({ sessionId: "s" });
  engine.onContextSet({ docs: bigDocument().join(""), name: "notes.md" });
  engine.onAnswerRequest({ utterance: "How does TypeScript treat any and unknown?" });
  await waitFor(() => calls.length === 1);
  assert.ok(calls[0].context.includes(`## TypeScript: any and unknown\n${"t".repeat(5_000)}\n`), "the whole section");
  assert.ok(calls[0].context.includes("File: notes.md"), "the preamble stays");
  engine.onSessionEnd();
});
