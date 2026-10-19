import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeServer } from "../src/server/ws-server.js";
import { RealtimeClient } from "../src/transport/realtime-client.js";
import { createSpeechPipeline } from "../src/audio/index.js";
import { CAPABILITIES } from "../src/shared/protocol.js";
import { VadLatencyConfig } from "../src/vad/index.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(5);
  }
}

function hintEngine() {
  const seen = { hints: [], starts: [] };
  const createEngine = () => ({
    onSessionStart(payload) {
      seen.starts.push(payload);
    },
    onAudio() {},
    onFinalize() {},
    onTurnHint(payload) {
      seen.hints.push(payload);
    },
    onSessionEnd() {},
    dispose() {},
  });
  return { seen, createEngine };
}

test("turn_hint travels client -> server -> engine behind the turn_hint capability", async () => {
  const { seen, createEngine } = hintEngine();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const client = new RealtimeClient({ baseUrl: url });
  try {
    await client.start({ sessionId: "hints", jwt: "t" });
    await waitFor(() => client.hasCapability(CAPABILITIES.TURN_HINT));
    assert.equal(client.sendTurnHint("system", "pause"), true);
    assert.equal(client.sendTurnHint("system", "resume"), true);
    await waitFor(() => seen.hints.length === 2);
    assert.deepEqual(seen.hints, [
      { streamIdx: 1, state: "pause" },
      { streamIdx: 1, state: "resume" },
    ]);
    assert.throws(() => client.sendTurnHint("system", "maybe"), /unknown turn hint state/);
  } finally {
    client.stop();
    await server.stop();
  }
});

test("no capability means no hint on the wire (older server builds)", async () => {
  const { seen, createEngine } = hintEngine();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const client = new RealtimeClient({ baseUrl: url });
  try {
    await client.start({ sessionId: "nohints", jwt: "t" });
    await waitFor(() => client.hasCapability(CAPABILITIES.TURN_HINT));
    client._capabilities.delete(CAPABILITIES.TURN_HINT); // an older server build
    assert.equal(client.sendTurnHint("system", "pause"), false);
    await delay(30);
    assert.equal(seen.hints.length, 0);
  } finally {
    client.stop();
    await server.stop();
  }
});

test("the speech pipeline forwards VAD end-of-turn hints to sink.hintStream", async () => {
  let chunkCb = null;
  const capture = {
    onChunk(cb) {
      chunkCb = cb;
      return () => {};
    },
    async start() {},
    stop() {},
  };
  // Speech for 2 frames, then quiet: the hint comes after the default
  // pauseHintFrames quiet frames (~0.7 s), before the 24-frame close.
  let calls = 0;
  const vad = {
    initialState: () => null,
    probe: async (_f, carry) => ({ probability: calls++ < 2 ? 0.9 : 0.1, nextState: carry }),
  };
  const hints = [];
  const finalized = [];
  const pipeline = createSpeechPipeline({
    capture,
    vad,
    source: "system",
    sink: {
      sendAudio() {},
      finalizeStream: (source) => finalized.push(source),
      hintStream: (source, state) => hints.push([source, state]),
    },
  });
  await pipeline.start();
  for (let i = 0; i < 2 + VadLatencyConfig.pauseHintFrames; i++) {
    chunkCb({ pcm: new Float32Array(512), sampleRate: 16000 });
    await delay(2);
  }
  await waitFor(() => hints.length === 1);
  assert.deepEqual(hints, [["system", "pause"]]);
  assert.deepEqual(finalized, [], "the hint is not a segment close");
  await pipeline.stop();
});
