import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";

/**
 * A generation that fails is retried, unless the provider already refused.
 * Cerebras answers a billing-gated key with HTTP 402 and `x-should-retry:
 * false`; the old code spent the retry on the same wall, so the user waited
 * twice as long for the same empty card. Every retryable failure (a 5xx, a
 * dropped connection, a stall) follows one chain: the chosen engine once
 * more, then the stand-in engine, two retries at most (see "stalls" below).
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

test("a transient failure (5xx) follows the chain: the chosen engine again, then the stand-in, then the error", async () => {
  const transient = Object.assign(new Error("answerer: chat endpoint HTTP 503"), { status: 503, retryable: true });
  const answerer = failingAnswerer(transient);
  const { asr, frames } = engineWith(answerer);
  asr.send(1, "what does the pricing look like for a team of fifty", true, { gateSeq: null });
  await waitFor(() => frames.filter((frame) => frame.type === "error").length === 1, { label: "final failure" });
  assert.deepEqual(frames.filter((frame) => frame.type === "error.retry").map((frame) => frame.data.attempt), [2, 3]);
  assert.equal(answerer.calls.length, 3, "two retries, never more");
  assert.equal(answerer.calls[1].retryOf, "error");
  assert.ok(!answerer.calls[1].standIn, "first retry: the chosen engine again");
  assert.equal(answerer.calls[2].standIn, true, "second retry: the stand-in engine");
  const done = frames.find((frame) => frame.type === "turn.done");
  assert.equal(done.data.text ?? "", "");
});

test("an error without a status follows the same chain", async () => {
  const answerer = failingAnswerer(new Error("provider exploded"));
  const { asr, frames } = engineWith(answerer);
  asr.send(1, "what does the pricing look like for a team of fifty", true, { gateSeq: null });
  await waitFor(() => frames.filter((frame) => frame.type === "error").length === 1, { label: "failure" });
  assert.equal(answerer.calls.length, 3);
  assert.equal(frames.filter((frame) => frame.type === "error.retry").length, 2);
  assert.equal(answerer.calls[2].standIn, true);
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

/* ------------------------------------------------------------- stalls -- */

/**
 * A provider that goes silent mid-answer (answerer.js `stalled`, code
 * "stalled", retryable) is retried like any other retryable failure, even
 * after tokens reached the card. Each retry discards the partial card
 * (error.retry tells the client to start the card over) and generates the
 * whole answer again for the same turn: first on the chosen engine again,
 * then, if that fails too, on the stand-in engine (`standIn: true`, which
 * createSelectableAnswerer turns into the next engine on its ladder). Two
 * retries at most; a third failure ends the turn. Every retry says why
 * (`retryOf`: "stalled" or "error").
 */
function stalledError(emitted = 0) {
  return Object.assign(new Error(`answerer: provider stalled (no data for 8000 ms)`), {
    code: "stalled",
    retryable: true,
    emitted,
  });
}

/** An answerer whose attempts run `scripts` in turn: each yields its pieces, then throws `error` if set. */
function scriptedAnswerer(scripts) {
  const calls = [];
  async function* streamAnswer(args) {
    const script = scripts[Math.min(calls.length, scripts.length - 1)];
    calls.push(args);
    for (const piece of script.pieces ?? []) {
      await sleep(2);
      yield piece;
    }
    if (script.error) throw script.error;
  }
  return {
    calls,
    streamAnswer,
    answerOnce: async (args) => {
      let text = "";
      for await (const delta of streamAnswer(args)) text += delta;
      return text;
    },
  };
}

const QUESTION = "what does the pricing look like for a team of fifty";
const retries = (frames) => frames.filter((frame) => frame.type === "error.retry");

test("a stall before the first token is retried on the chosen engine first", async () => {
  const answerer = scriptedAnswerer([{ error: stalledError(0) }, { pieces: ["Fifty seats ", "is one plan."] }]);
  const { asr, frames } = engineWith(answerer);
  asr.send(1, QUESTION, true, { gateSeq: null });
  const done = await waitFor(() => frames.find((frame) => frame.type === "turn.done"), { label: "turn.done" });
  assert.equal(done.data.text, "Fifty seats is one plan.");
  assert.equal(answerer.calls.length, 2, "one retry was enough");
  assert.equal(answerer.calls[0].retryOf, undefined, "the first attempt is not a retry");
  assert.equal(answerer.calls[1].retryOf, "stalled", "the retry says why");
  assert.ok(!answerer.calls[1].standIn, "the first retry stays on the chosen engine");
  assert.equal(answerer.calls[1].question, answerer.calls[0].question, "same question");
  assert.equal(retries(frames).length, 1);
  assert.equal(frames.filter((frame) => frame.type === "error").length, 0, "a recovered stall is not an error");
});

test("a stall mid-answer discards the partial card and regenerates the whole answer", async () => {
  const answerer = scriptedAnswerer([
    { pieces: ["Fifty seats ", "is"], error: stalledError("Fifty seats is".length) },
    { pieces: ["Fifty seats ", "is one plan."] },
  ]);
  const { asr, frames, logs } = engineWith(answerer);
  asr.send(1, QUESTION, true, { gateSeq: null });
  const done = await waitFor(() => frames.find((frame) => frame.type === "turn.done"), { label: "turn.done" });
  const turnId = done.data.turn_id;

  assert.equal(answerer.calls.length, 2);
  assert.equal(answerer.calls[1].retryOf, "stalled");
  assert.equal(done.data.text, "Fifty seats is one plan.", "the retry's answer, not the partial plus the retry");
  assert.equal(done.data.cut, undefined, "a regenerated answer is whole, not cut");
  assert.equal(frames.filter((frame) => frame.type === "error").length, 0);

  // On the wire: the partial tokens, then error.retry, then the new answer from its first token.
  const kinds = frames.filter((frame) => ["turn.token", "error.retry", "turn.done"].includes(frame.type));
  const retryAt = kinds.findIndex((frame) => frame.type === "error.retry");
  assert.ok(retryAt > 0, "the partial tokens went out before the retry");
  assert.deepEqual(kinds[retryAt].data, { turn_id: turnId, attempt: 2 });
  const before = kinds.slice(0, retryAt).map((frame) => frame.data.delta).join("");
  const after = kinds.slice(retryAt + 1, -1).map((frame) => frame.data.delta).join("");
  assert.equal(before, "Fifty seats is");
  assert.equal(after, "Fifty seats is one plan.");
  assert.ok(kinds.slice(retryAt + 1).every((frame) => frame.data.turn_id === turnId), "the same turn, started over");

  const retry = logs.find((entry) => entry.type === "turn.retry");
  assert.ok(retry, "the session log records the retry");
  assert.equal(retry.reason, "stalled");
  assert.equal(retry.attempt, 2);
  assert.equal(retry.chars, "Fifty seats is".length, "how much of the card was discarded");
});

test("a second stall moves the second retry to the stand-in engine, and the card starts over again", async () => {
  const answerer = scriptedAnswerer([
    { pieces: ["Fifty "], error: stalledError(6) },
    { pieces: ["Fifty seats "], error: stalledError(12) },
    { pieces: ["Fifty seats is one plan."] },
  ]);
  const { asr, frames, logs } = engineWith(answerer);
  asr.send(1, QUESTION, true, { gateSeq: null });
  const done = await waitFor(() => frames.find((frame) => frame.type === "turn.done"), { label: "turn.done" });
  assert.equal(answerer.calls.length, 3);
  assert.ok(!answerer.calls[1].standIn, "first retry: the chosen engine again");
  assert.equal(answerer.calls[2].retryOf, "stalled");
  assert.equal(answerer.calls[2].standIn, true, "second retry: the other engine");
  assert.deepEqual(retries(frames).map((frame) => frame.data.attempt), [2, 3]);
  assert.equal(done.data.text, "Fifty seats is one plan.");
  assert.equal(frames.filter((frame) => frame.type === "error").length, 0);
  // The card restarted before each retry: what streams after the last restart is the whole answer.
  const wire = frames.filter((frame) => ["turn.token", "error.retry"].includes(frame.type));
  const lastRetry = wire.map((frame) => frame.type).lastIndexOf("error.retry");
  assert.equal(wire.slice(lastRetry + 1).map((frame) => frame.data.delta).join(""), "Fifty seats is one plan.");
  assert.deepEqual(
    logs.filter((entry) => entry.type === "turn.retry").map((entry) => [entry.attempt, entry.chars, entry.stand_in]),
    [[2, 6, false], [3, 12, true]],
  );
});

test("a third stall fails the turn with what the last attempt managed to show", async () => {
  const answerer = scriptedAnswerer([
    { pieces: ["Fifty "], error: stalledError(6) },
    { pieces: ["Fifty seats "], error: stalledError(12) },
    { pieces: ["Fifty seats is "], error: stalledError(15) },
    { pieces: ["never"] },
  ]);
  const { asr, frames } = engineWith(answerer);
  asr.send(1, QUESTION, true, { gateSeq: null });
  const error = await waitFor(() => frames.find((frame) => frame.type === "error"), { label: "error frame" });
  assert.equal(error.data.code, "generation_failed");
  assert.match(error.data.message, /stalled/);
  assert.equal(answerer.calls.length, 3, "two retries, never more");
  assert.deepEqual(retries(frames).map((frame) => frame.data.attempt), [2, 3]);
  const done = frames.find((frame) => frame.type === "turn.done");
  assert.equal(done.data.text, "Fifty seats is ", "the last attempt's partial text is what the card keeps");
});

test("one chain for every reason: a stall, then a 503 on the retry, reaches the stand-in", async () => {
  const transient = Object.assign(new Error("answerer: chat endpoint HTTP 503"), { status: 503, retryable: true });
  const answerer = scriptedAnswerer([{ error: stalledError(0) }, { error: transient }, { pieces: ["Answered."] }]);
  const { asr, frames } = engineWith(answerer);
  asr.send(1, QUESTION, true, { gateSeq: null });
  const done = await waitFor(() => frames.find((frame) => frame.type === "turn.done"), { label: "turn.done" });
  assert.equal(done.data.text, "Answered.");
  assert.equal(answerer.calls.length, 3);
  assert.deepEqual(answerer.calls.map((call) => call.retryOf ?? null), [null, "stalled", "error"]);
  assert.equal(answerer.calls[2].standIn, true, "the last retry goes to the stand-in");
  assert.equal(frames.filter((frame) => frame.type === "error").length, 0);
});

test("a connection that drops after the first token is retried like a stall: the card starts over", async () => {
  const dropped = new Error("provider request failed: terminated");
  const answerer = scriptedAnswerer([{ pieces: ["Fifty "], error: dropped }, { pieces: ["Fifty seats is one plan."] }]);
  const { asr, frames } = engineWith(answerer);
  asr.send(1, QUESTION, true, { gateSeq: null });
  const done = await waitFor(() => frames.find((frame) => frame.type === "turn.done"), { label: "turn.done" });
  assert.equal(done.data.text, "Fifty seats is one plan.");
  assert.equal(answerer.calls.length, 2);
  assert.equal(answerer.calls[1].retryOf, "error");
  assert.deepEqual(retries(frames).map((frame) => frame.data.attempt), [2]);
  assert.equal(frames.filter((frame) => frame.type === "error").length, 0);
});

test("a refusal after the first token is not retried: the text on screen is the answer", async () => {
  const refusal = Object.assign(new Error("answerer: chat endpoint HTTP 402"), { status: 402, retryable: false });
  const answerer = scriptedAnswerer([{ pieces: ["Fifty "], error: refusal }, { pieces: ["never"] }]);
  const { asr, frames } = engineWith(answerer);
  asr.send(1, QUESTION, true, { gateSeq: null });
  const error = await waitFor(() => frames.find((frame) => frame.type === "error"), { label: "error frame" });
  assert.equal(error.data.code, "generation_failed");
  assert.equal(answerer.calls.length, 1);
  assert.equal(retries(frames).length, 0);
  assert.equal(frames.find((frame) => frame.type === "turn.done").data.text, "Fifty ");
});

test("a stalled turn that was superseded meanwhile is not retried", async () => {
  let release = null;
  const gate = new Promise((resolve) => (release = resolve));
  const calls = [];
  const answerer = {
    calls,
    async *streamAnswer(args) {
      calls.push(args);
      if (calls.length === 1) {
        yield "Fifty ";
        await gate;
        throw stalledError(6);
      }
      yield "A newer answer.";
    },
  };
  const { asr, frames } = engineWith(answerer);
  // A stable interim starts a prefetch; a diverging final replaces it while it is still (silently) open.
  asr.send(1, QUESTION, false);
  await sleep(320);
  asr.send(1, QUESTION, false);
  await waitFor(() => frames.some((frame) => frame.type === "turn.token"), { label: "first token" });
  asr.send(1, "how does onboarding work for a team that size", true);
  await waitFor(() => frames.some((frame) => frame.type === "turn.superseded"), { label: "superseded" });
  release();
  await waitFor(() => frames.some((frame) => frame.type === "turn.done" && frame.data.text === "A newer answer."), { label: "new answer" });
  await sleep(20);
  assert.equal(calls.length, 2, "the superseded turn's stall buys no retry");
  assert.equal(frames.filter((frame) => frame.type === "error.retry").length, 0);
  assert.equal(frames.filter((frame) => frame.type === "error").length, 0);
});
