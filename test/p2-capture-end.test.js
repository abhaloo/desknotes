import test from "node:test";
import assert from "node:assert/strict";
import { createCapture, createSpeechPipeline } from "../src/audio/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 3000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error("timed out");
    await sleep(5);
  }
}

function recordingSink() {
  const sent = [];
  const finalized = [];
  return {
    sent,
    finalized,
    sendAudio: (source, pcm16) => sent.push({ source, bytes: pcm16.byteLength }),
    finalizeStream: (source) => finalized.push(source),
  };
}

test("capture exposes an onEnd subscription that fires once when a finite source ends", async () => {
  const capture = createCapture({ backend: "simulated", source: "system", durationMs: 200, pace: "fast" });
  let ends = 0;
  const unsub = capture.onEnd(() => {
    ends += 1;
  });
  assert.equal(typeof unsub, "function");
  await capture.start();
  await waitFor(() => capture.info().ended);
  await sleep(20);
  assert.equal(ends, 1);
});

test("a finite capture ending on its own finalizes the stream (VAD off: pass-through)", async () => {
  const sink = recordingSink();
  const capture = createCapture({ backend: "simulated", source: "system", durationMs: 300, pace: "fast" });
  const pipeline = createSpeechPipeline({ capture, vad: null, sink, source: "system" });
  await pipeline.start();
  // No stop(): the file/simulated source simply runs out.
  await waitFor(() => sink.finalized.length > 0);
  await sleep(30);
  assert.deepEqual(sink.finalized, ["system"], "exactly one finalize at end of stream");
  const totalBytes = sink.sent.reduce((sum, s) => sum + s.bytes, 0);
  // Every captured sample reaches the sink: whole 512-sample frames plus the
  // sub-frame remainder the gate forwards at end of stream.
  assert.equal(totalBytes, 16000 * 0.3 * 2);
  await pipeline.stop();
  assert.deepEqual(sink.finalized, ["system"], "stop() after end does not finalize again");
});

test("a capture that ends mid-speech flushes the gate and finalizes the open utterance", async () => {
  const sink = recordingSink();
  const events = [];
  const vad = {
    initialState: () => new Float32Array(0),
    probe: async (_frame, carry) => ({ probability: 0.95, nextState: carry }), // speech throughout
  };
  const capture = createCapture({ backend: "simulated", source: "microphone", durationMs: 400, pace: "fast" });
  const pipeline = createSpeechPipeline({ capture, vad, sink, source: "microphone" });
  pipeline.onEvent((event) => events.push(event));
  await pipeline.start();
  await waitFor(() => sink.finalized.length > 0);
  await sleep(30);
  assert.deepEqual(sink.finalized, ["microphone"]);
  assert.deepEqual(
    events.filter((e) => e.type === "vad").map((e) => e.speaking),
    [true, false],
  );
  await pipeline.stop();
});
