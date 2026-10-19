import test from "node:test";
import assert from "node:assert/strict";
import { createSpeechPipeline, floatToPcm16 } from "../src/audio/index.js";
import { createStreamingResampler } from "../src/audio/stream-resampler.js";

function concatFloat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function concatPcm16(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function scriptedCapture(chunks, stopImpl = () => {}) {
  const listeners = new Set();
  return {
    onChunk(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onEnd() {
      return () => {};
    },
    async start() {
      for (const chunk of chunks) {
        for (const cb of [...listeners]) cb(chunk);
      }
    },
    stop: stopImpl,
    info() {
      return { backend: "fake" };
    },
  };
}

test("pipeline Stop stays pending until async source cleanup settles", async () => {
  let release;
  let stopped = false;
  const finalized = [];
  const capture = scriptedCapture([], () => new Promise((resolve) => {
    release = resolve;
  }));
  const pipeline = createSpeechPipeline({
    capture,
    vad: null,
    sink: {
      sendAudio() {},
      finalizeStream(source) {
        finalized.push(source);
      },
    },
    source: "microphone",
  });
  await pipeline.start();
  const pending = pipeline.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stopped, false);
  assert.deepEqual(finalized, []);
  release();
  await pending;
  assert.equal(stopped, true);
});

test("128-sample native packets keep one second of 48 kHz audio at 16 kHz", async () => {
  const inputRate = 48000;
  const input = Float32Array.from({ length: inputRate }, (_, i) =>
    0.25 * Math.sin((2 * Math.PI * 997 * i) / inputRate),
  );
  const chunks = [];
  for (let i = 0; i < input.length; i += 128) {
    chunks.push({ pcm: input.subarray(i, i + 128), sampleRate: inputRate, timestampMs: 0 });
  }
  const sent = [];
  const finalized = [];
  const pipeline = createSpeechPipeline({
    capture: scriptedCapture(chunks),
    vad: null,
    sink: {
      sendAudio(_source, pcm16) {
        sent.push(pcm16);
      },
      finalizeStream(source) {
        finalized.push(source);
      },
    },
    source: "system",
  });
  await pipeline.start();
  await pipeline.stop();
  const total = sent.reduce((sum, frame) => sum + frame.length, 0);
  assert.ok(Math.abs(total - 16000) <= 1, `samples ${total}`);
  assert.deepEqual(finalized, ["system"]);
});

test("a discontinuity resets the streaming resampler before the next packet", async () => {
  const inputRate = 48000;
  const first = Float32Array.from({ length: 24000 }, (_, i) =>
    0.25 * Math.sin((2 * Math.PI * 997 * i) / inputRate),
  );
  const second = Float32Array.from({ length: 24000 }, (_, i) =>
    0.25 * Math.sin((2 * Math.PI * 440 * i) / inputRate),
  );
  const sent = [];
  const pipeline = createSpeechPipeline({
    capture: scriptedCapture([
      { pcm: first, sampleRate: inputRate, timestampMs: 0 },
      {
        pcm: second,
        sampleRate: inputRate,
        timestampMs: 500,
        flags: {
          silent: false,
          discontinuity: true,
          timestampError: false,
          syntheticIdleSilence: false,
        },
      },
    ]),
    vad: null,
    sink: {
      sendAudio(_source, pcm16) {
        sent.push(pcm16);
      },
      finalizeStream() {},
    },
    source: "microphone",
  });
  await pipeline.start();
  await pipeline.stop();

  const left = createStreamingResampler({ inputRate, outputRate: 16000 });
  const right = createStreamingResampler({ inputRate, outputRate: 16000 });
  const expected = floatToPcm16(
    concatFloat([left.push(first), left.flush(), right.push(second), right.flush()]),
  );
  const actual = concatPcm16(sent);
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) assert.equal(actual[i], expected[i]);

  const continuous = createStreamingResampler({ inputRate, outputRate: 16000 });
  const joined = new Float32Array(first.length + second.length);
  joined.set(first, 0);
  joined.set(second, first.length);
  const glued = floatToPcm16(concatFloat([continuous.push(joined), continuous.flush()]));
  assert.notEqual(actual[8000], glued[8000]);
});

test("chunk.discontinuity and a sample-rate change also reset the resampler", async () => {
  const inputRate = 48000;
  const first = Float32Array.from({ length: 2048 }, (_, i) =>
    0.2 * Math.sin((2 * Math.PI * 500 * i) / inputRate),
  );
  const second = new Float32Array(512);
  second.fill(0.5);
  const sent = [];
  const pipeline = createSpeechPipeline({
    capture: scriptedCapture([
      { pcm: first, sampleRate: inputRate, timestampMs: 0 },
      { pcm: second, sampleRate: 16000, timestampMs: 40, discontinuity: true },
    ]),
    vad: null,
    sink: {
      sendAudio(_source, pcm16) {
        sent.push(pcm16);
      },
      finalizeStream() {},
    },
    source: "microphone",
  });
  await pipeline.start();
  await pipeline.stop();
  const actual = concatPcm16(sent);
  const head = createStreamingResampler({ inputRate, outputRate: 16000 });
  const headOut = concatFloat([head.push(first), head.flush()]);
  const expected = floatToPcm16(concatFloat([headOut, second]));
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) assert.equal(actual[i], expected[i]);
});
