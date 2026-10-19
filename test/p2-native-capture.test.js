import test from "node:test";
import assert from "node:assert/strict";
import { createNativeCapture } from "../src/audio/native-capture.js";
import { createCapture } from "../src/audio/index.js";

const CHOICE = Object.freeze({ kind: "endpoint", id: "mic-1" });

function packet(generation, value = 0.2) {
  return {
    pcm: new Float32Array([value]),
    sampleRate: 16000,
    generation,
    endpointId: "mic-1",
  };
}

test("first audio emitted synchronously during start is delivered", async () => {
  const chunks = [];
  const host = {
    open(request) {
      request.onChunk(packet(request.generation, 0.5));
      return {
        info: { endpointId: "mic-1", sampleRate: 48000, generation: request.generation },
        stop: async () => {},
      };
    },
  };
  const capture = createNativeCapture({
    source: "microphone",
    choice: CHOICE,
    generation: 4,
    nativeHost: host,
  });
  capture.onChunk((chunk) => chunks.push(chunk));
  await capture.start();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pcm[0], 0.5);
  assert.equal(capture.info().endpointId, "mic-1");
  assert.equal(capture.info().backend, "native");
});

test("a failed start can be retried and a later success delivers audio", async () => {
  let calls = 0;
  const chunks = [];
  const host = {
    open(request) {
      calls += 1;
      if (calls === 1) return Promise.reject(Object.assign(new Error("device missing"), { code: "device-missing" }));
      request.onChunk(packet(request.generation, 0.75));
      return Promise.resolve({
        info: { endpointId: "mic-1", generation: request.generation, sampleRate: 16000 },
        stop: async () => {},
      });
    },
  };
  const capture = createNativeCapture({
    source: "microphone",
    choice: CHOICE,
    generation: 1,
    nativeHost: host,
  });
  capture.onChunk((chunk) => chunks.push(chunk));
  await assert.rejects(() => capture.start(), /device missing/);
  await capture.start();
  assert.equal(calls, 2);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pcm[0], 0.75);
});

test("cancellation during start stops the session and drops late audio", async () => {
  let resolveOpen;
  const stops = [];
  let held = null;
  const host = {
    open(request) {
      held = request;
      return new Promise((resolve) => {
        resolveOpen = () =>
          resolve({
            info: { endpointId: "mic-1", generation: 2, sampleRate: 16000 },
            stop: async () => {
              stops.push("stop");
            },
          });
      });
    },
  };
  const chunks = [];
  const capture = createNativeCapture({
    source: "system",
    choice: { kind: "default", role: "multimedia" },
    generation: 2,
    nativeHost: host,
  });
  capture.onChunk((chunk) => chunks.push(chunk));
  const starting = capture.start();
  await Promise.resolve();
  const stopping = capture.stop();
  resolveOpen();
  await starting;
  await stopping;
  assert.deepEqual(stops, ["stop"]);
  held.onChunk(packet(2, 0.9));
  assert.equal(chunks.length, 0);
});

test("unexpected end fires once", async () => {
  let onState;
  const host = {
    open(request) {
      onState = request.onState;
      return {
        info: { endpointId: "spk-1", generation: 8, sampleRate: 48000 },
        stop: async () => {},
      };
    },
  };
  let ends = 0;
  const capture = createNativeCapture({
    source: "system",
    choice: CHOICE,
    generation: 8,
    nativeHost: host,
    onEnd: () => {
      ends += 1;
    },
  });
  capture.onEnd(() => {
    ends += 1;
  });
  await capture.start();
  onState({ type: "ended", generation: 8 });
  onState({ type: "ended", generation: 8 });
  onState({ type: "ended", generation: 1 });
  assert.equal(ends, 2, "constructor onEnd plus the later subscriber, each once");
  assert.equal(capture.info().ended, true);
});

test("endpoint loss ends the capture", async () => {
  let onState;
  const host = {
    open(request) {
      onState = request.onState;
      return { info: { endpointId: "spk-1", generation: 8, sampleRate: 48000 }, stop: async () => {} };
    },
  };
  let ends = 0;
  const capture = createNativeCapture({
    source: "system",
    choice: CHOICE,
    generation: 8,
    nativeHost: host,
    onEnd: () => {
      ends += 1;
    },
  });
  await capture.start();
  onState({ type: "device-change", generation: 8, code: "endpoint_invalidated" });
  assert.equal(ends, 1);
  assert.equal(capture.info().ended, true);
});

test("packets from a retired generation are not delivered", async () => {
  const chunks = [];
  const states = [];
  const host = {
    open(request) {
      request.onChunk(packet(5, 0.5));
      request.onChunk(packet(9, 0.25));
      request.onState({ type: "state", generation: 9, state: "ignored" });
      request.onState({ type: "state", generation: 5, state: "live" });
      return {
        info: { endpointId: "mic-1", generation: 5, sampleRate: 16000 },
        stop: async () => {},
      };
    },
  };
  const capture = createNativeCapture({
    source: "microphone",
    choice: CHOICE,
    generation: 5,
    nativeHost: host,
  });
  capture.onChunk((chunk) => chunks.push(chunk.pcm[0]));
  capture.onState((state) => states.push(state.state));
  await capture.start();
  assert.deepEqual(chunks, [0.5]);
  assert.deepEqual(states, ["live"]);
});

test("adapter guarantees timestampMs from QPC fields and preserves explicit values", async () => {
  const chunks = [];
  const host = {
    open(request) {
      request.onChunk({
        pcm: new Float32Array([0.1]),
        sampleRate: 48000,
        generation: request.generation,
        endpointId: "mic-1",
        sampleIndex: 0,
        qpcTimestamp100ns: 100_000,
        clockOriginQpc100ns: 50_000,
      });
      request.onChunk({
        pcm: new Float32Array([0.2]),
        sampleRate: 48000,
        generation: request.generation,
        endpointId: "mic-1",
        timestampMs: 12.5,
      });
      return {
        info: { endpointId: "mic-1", generation: request.generation, sampleRate: 48000 },
        stop: async () => ({ droppedSamples: 3, flushedSamples: 5 }),
      };
    },
  };
  const capture = createNativeCapture({
    source: "microphone",
    choice: CHOICE,
    generation: 4,
    nativeHost: host,
  });
  capture.onChunk((chunk) => chunks.push(chunk));
  await capture.start();
  assert.equal(chunks[0].timestampMs, 5, "(100000 - 50000) / 10000 ticks");
  assert.equal(chunks[0].qpcTimestamp100ns, 100_000, "raw QPC stays as an extra");
  assert.equal(chunks[1].timestampMs, 12.5, "an explicit timestampMs is not recomputed");
  await capture.stop();
  assert.equal(capture.info().droppedSamples, 3);
  assert.equal(capture.info().flushedSamples, 5);
});

test("missing host and binding are rejected", async () => {
  assert.throws(
    () => createNativeCapture({ source: "microphone", generation: 1 }),
    /native audio capture is unsupported on this platform/,
  );
  const capture = createCapture({ backend: "native", source: "system" });
  await assert.rejects(
    () => capture.start(),
    /native audio capture is unsupported on this platform/,
  );
});
