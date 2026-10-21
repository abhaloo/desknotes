import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";

/**
 * A generation that fails before its first token is retried once — unless the
 * provider already refused. Cerebras answers a billing-gated key with HTTP 402
 * and `x-should-retry: false`; the old code spent the retry on the same wall,
 * so the user waited twice as long for the same empty card.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 3000, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
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
    send(streamIdx, text, final = false) {
      const data = { text, final, stream: streamIdx, role: streamIdx === 1 ? "prospect" : "rep", source: "system" };
      for (const cb of handlers) cb(data);
    },
  };
}

/** An answerer that throws `error` instead of answering. */
function failingAnswerer(error) {
  const calls = [];
  async function* streamAnswer(args) {
    calls.push(args);
    throw error;
  }
  return { calls, streamAnswer, answerOnce: async (args) => {
    for await (const _ of streamAnswer(args));
    return "";
  } };
}

function engineWith(answerer) {
  const frames = [];
  const logs = [];
  const asr = fakeAsr();
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer,
    log: (entry) => logs.push(entry),
    holdSpeculation: false,
  });
  engine.onSessionStart({ sessionId: "s-failure" });
  return { asr, frames, logs, engine };
}

test("a refusal (402, x-should-retry: false) is not retried: one attempt, one error frame", async () => {
  const refusal = Object.assign(new Error("answerer: chat endpoint HTTP 402"), { status: 402, retryable: false });
  const answerer = failingAnswerer(refusal);
  const { asr, frames } = engineWith(answerer);
  asr.send(1, "what does the pricing look like for a team of fifty", true, { gateSeq: null });
  const error = await waitFor(() => frames.find((frame) => frame.type === "error"), { label: "error frame" });
  assert.equal(error.data.code, "generation_failed");
  assert.match(error.data.message, /HTTP 402/);
  assert.equal(answerer.calls.length, 1, "a refusal costs one attempt, not two");
  assert.equal(frames.filter((frame) => frame.type === "error.retry").length, 0);
  const done = frames.find((frame) => frame.type === "turn.done");
  assert.equal(done.data.text ?? "", "", "the card closes empty, and the toast explains why");
});

test("a transient failure (5xx) still gets the one transparent retry", async () => {
  const transient = Object.assign(new Error("answerer: chat endpoint HTTP 503"), { status: 503, retryable: true });
  const answerer = failingAnswerer(transient);
  const { asr, frames } = engineWith(answerer);
  asr.send(1, "what does the pricing look like for a team of fifty", true, { gateSeq: null });
  await waitFor(() => frames.filter((frame) => frame.type === "error").length === 1, { label: "second failure" });
  assert.equal(frames.filter((frame) => frame.type === "error.retry").length, 1);
  assert.equal(answerer.calls.length, 2, "the retry ran");
  const done = frames.find((frame) => frame.type === "turn.done");
  assert.equal(done.data.text ?? "", "");
});

test("an error without a status keeps the old behaviour: retried once", async () => {
  const answerer = failingAnswerer(new Error("provider exploded"));
  const { asr, frames } = engineWith(answerer);
  asr.send(1, "what does the pricing look like for a team of fifty", true, { gateSeq: null });
  await waitFor(() => frames.filter((frame) => frame.type === "error").length === 1, { label: "failure" });
  assert.equal(answerer.calls.length, 2);
  assert.equal(frames.filter((frame) => frame.type === "error.retry").length, 1);
});

test("the answerer's HTTP error carries the status and the provider's retry hint", async () => {
  const { httpStatusError } = await import("../src/server/engines/provider-http.js");
  const refusal = httpStatusError("answerer: chat endpoint", new Response("{}", {
    status: 402,
    headers: { "x-should-retry": "false" },
  }));
  assert.equal(refusal.status, 402);
  assert.equal(refusal.retryable, false);
  assert.equal(refusal.message, "answerer: chat endpoint HTTP 402");
  const transient = httpStatusError("answerer: chat endpoint", new Response("{}", { status: 503 }));
  assert.equal(transient.retryable, true);
  assert.equal(httpStatusError("x", new Response("{}", { status: 429 })).retryable, true);
  assert.equal(httpStatusError("x", new Response("{}", { status: 400 })).retryable, false);
  assert.equal(httpStatusError("x", new Response("{}", { status: 402, headers: { "x-should-retry": "true" } })).retryable, false);
});
