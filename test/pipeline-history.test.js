import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";

/**
 * Follow-up context: every answer the client saw enters RECENT EXCHANGE once,
 * however it was committed. The common fast path is a prefetch that finishes
 * on the partial, before the final commits it.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > 3000) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

function fakeAsr() {
  const handlers = [];
  return {
    pushAudio() {},
    finalize() {
      return true;
    },
    close() {},
    onTranscript(cb) {
      handlers.push(cb);
    },
    send(streamIdx, text, final) {
      const data = { text, final, stream: streamIdx, role: "prospect", source: "system" };
      for (const cb of handlers) cb(data);
    },
  };
}

function scriptedAnswerer(answers) {
  const calls = [];
  const finished = [];
  async function* streamAnswer(args) {
    const index = calls.push(args) - 1;
    yield answers[index] ?? "- An answer.";
    finished.push(index);
  }
  return { calls, finished, streamAnswer };
}

const QUESTION = "How does Kafka keep messages in order for each consumer group?";
const FOLLOW_UP = "Why would you pick it over a plain queue?";

function setup() {
  const frames = [];
  const asr = fakeAsr();
  const answerer = scriptedAnswerer(["- Kafka keeps an ordered log per partition.", "- It lets consumers replay."]);
  const engine = createPipelineEngine({ emit: (frame) => frames.push(frame), asr, answerer, log: () => {} });
  engine.onSessionStart({ sessionId: "s" });
  return { frames, asr, answerer, engine };
}

function historyCount(context, question) {
  return context.split(`Q: ${question}\n`).length - 1;
}

test("an answer that finished before the final committed it becomes follow-up context", async () => {
  const { frames, asr, answerer, engine } = setup();
  asr.send(1, QUESTION, false);
  await waitFor(() => answerer.finished.includes(0), "the prefetch finished on the partial");
  await sleep(5);
  asr.send(1, QUESTION, true);
  await waitFor(() => frames.some((frame) => frame.type === "turn.done"), "the committed card");

  asr.send(1, FOLLOW_UP, true);
  await waitFor(() => answerer.calls.length === 2, "the follow-up answer");
  const context = answerer.calls[1].context;
  assert.ok(context.includes("RECENT EXCHANGE:"), context);
  assert.equal(historyCount(context, QUESTION), 1, context);
  assert.ok(context.includes("Kafka keeps an ordered log per partition."), context);
  engine.onSessionEnd?.();
});

test("an answer committed while it streams enters the history once", async () => {
  const { frames, asr, answerer, engine } = setup();
  asr.send(1, QUESTION, true);
  await waitFor(() => frames.some((frame) => frame.type === "turn.done"), "the card");

  asr.send(1, FOLLOW_UP, true);
  await waitFor(() => answerer.calls.length === 2, "the follow-up answer");
  assert.equal(historyCount(answerer.calls[1].context, QUESTION), 1, answerer.calls[1].context);
  engine.onSessionEnd?.();
});
