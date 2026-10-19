import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";
import { createAsr } from "../src/server/engines/asr.js";
import { SAMPLE_RATE } from "../src/shared/protocol.js";

/**
 * A batch ASR (`batch: true` on the ASR object) transcribes the whole segment
 * per request, so its next partial is about a second away. The pipeline then
 * starts the speculative answer from a partial of three words or more at once,
 * instead of waiting 250 ms for the last word to stay stable. A streaming ASR
 * keeps that wait. Partials of one or two words never start a turn on their own.
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

function fakeAsr({ batch } = {}) {
  const handlers = [];
  const asr = {
    pushAudio() {},
    finalize() {
      return true;
    },
    close() {},
    onTranscript(cb) {
      handlers.push(cb);
    },
    send(streamIdx, text, final = false) {
      const data = { text, final, stream: streamIdx, role: streamIdx === 1 ? "prospect" : "rep", source: streamIdx === 1 ? "system" : "mic" };
      for (const cb of handlers) cb(data);
    },
  };
  if (batch !== undefined) asr.batch = batch;
  return asr;
}

function answerer({ deltaMs = 3, count = 4 } = {}) {
  const calls = [];
  async function* streamAnswer(args) {
    const call = { question: args.question, finished: false };
    calls.push(call);
    for (let i = 0; i < count; i += 1) {
      await sleep(deltaMs);
      if (args.signal?.aborted) return;
      yield i === 0 ? `ANSWER TO: ${args.question}` : " .";
    }
    call.finished = true;
  }
  return { calls, streamAnswer };
}

function setup({ batch } = {}) {
  const asr = fakeAsr({ batch });
  const ans = answerer();
  const engine = createPipelineEngine({ emit: () => {}, asr, answerer: ans, log: () => {} });
  engine.onSessionStart({ sessionId: "stable" });
  return { asr, answerer: ans, engine };
}

test("batch ASR: a three-word partial starts the speculative answer at once", async () => {
  const { asr, answerer: ans, engine } = setup({ batch: true });
  try {
    asr.send(1, "how much does");
    await sleep(20);
    assert.equal(ans.calls.length, 1);
    assert.equal(ans.calls[0].question, "how much does");
  } finally {
    engine.dispose();
  }
});

test("streaming ASR: the same partial waits 250 ms", async () => {
  const { asr, answerer: ans, engine } = setup();
  try {
    const sentAt = Date.now();
    asr.send(1, "how much does");
    await sleep(100);
    assert.equal(ans.calls.length, 0, "the stability wait has not elapsed at 100 ms");
    await waitFor(() => ans.calls.length === 1, { timeout: 300, label: "stability timer" });
    const waitedMs = Date.now() - sentAt;
    assert.ok(waitedMs >= 240, `answer started after ${waitedMs} ms`);
    await sleep(Math.max(0, 400 - (Date.now() - sentAt)));
    assert.equal(ans.calls.length, 1, "exactly one answer");
    assert.equal(ans.calls[0].question, "how much does");
  } finally {
    engine.dispose();
  }
});

test("batch ASR: one or two words never start a turn on their own", async () => {
  const { asr, answerer: ans, engine } = setup({ batch: true });
  try {
    asr.send(1, "how much");
    await sleep(400);
    assert.equal(ans.calls.length, 0);
  } finally {
    engine.dispose();
  }
});

test("batch ASR: eight words still trigger, as before", async () => {
  const { asr, answerer: ans, engine } = setup({ batch: true });
  try {
    asr.send(1, "how much does the enterprise plan cost per");
    await sleep(20);
    assert.equal(ans.calls.length, 1);
    assert.equal(ans.calls[0].question, "how much does the enterprise plan cost per");
  } finally {
    engine.dispose();
  }
});

test("createAsr marks only the batch endpoint", () => {
  const batch = createAsr({ provider: "openai-compatible", baseUrl: "https://stt.example.test/v1", apiKey: "k", model: "m" });
  const mock = createAsr({ provider: "mock" });
  try {
    assert.equal(batch.batch, true);
    assert.equal(mock.batch, false);
    assert.deepEqual(Object.keys(batch), ["pushAudio", "finalize", "close"]);
    assert.deepEqual(Object.keys(mock), ["pushAudio", "finalize", "close"]);
  } finally {
    batch.close();
    mock.close();
  }
});

test("the pipeline reads batch from the ASR it builds", async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  let respondedAt = 0;
  // The built ASR's interim request is answered by this stub: no socket opens.
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    respondedAt = Date.now();
    return new Response(JSON.stringify({ text: "how much does" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const ans = answerer();
  const engine = createPipelineEngine({
    emit: () => {},
    answerer: ans,
    log: () => {},
    asrOptions: { provider: "openai-compatible", baseUrl: "https://stt.example.test/v1", apiKey: "k", model: "m" },
  });
  try {
    engine.onSessionStart({ sessionId: "stable-built" });
    // One second of prospect audio: the batch engine sends one interim request.
    engine.onAudio({ streamIdx: 1, pcm16: new Int16Array(SAMPLE_RATE) });
    await waitFor(() => ans.calls.length === 1, { label: "interim answer" });
    assert.equal(ans.calls[0].question, "how much does");
    assert.equal(requests.length, 1);
    assert.ok(Date.now() - respondedAt < 200, "started at once, not after the 250 ms wait");
  } finally {
    engine.dispose();
    globalThis.fetch = realFetch;
  }
});
