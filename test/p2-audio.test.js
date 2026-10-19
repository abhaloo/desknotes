import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCapture,
  resampleTo16kMono,
  floatToPcm16,
  createSpeechPipeline,
} from "../src/audio/index.js";

const FRAME = 512;
const SAMPLE_RATE = 16000;

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function f32(length, fill = 0) {
  const out = new Float32Array(length);
  if (typeof fill === "function") {
    for (let i = 0; i < length; i++) out[i] = fill(i);
  } else {
    out.fill(fill);
  }
  return out;
}

/** Speech-like frame (syllable-modulated harmonics) used by the pipeline test. */
function speechFrame(i) {
  const frame = new Float32Array(FRAME);
  for (let j = 0; j < FRAME; j++) {
    const s = i * FRAME + j;
    const t = s / SAMPLE_RATE;
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    frame[j] =
      syllable *
      (0.5 * Math.sin(2 * Math.PI * 180 * t) + 0.25 * Math.sin(2 * Math.PI * 360 * t));
  }
  return frame;
}

/** Minimal 16-bit PCM WAV writer used to build the on-disk fixture. */
function makeWav(samples, sampleRate, channels = 1) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // uncompressed PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

/* ----------------------------- resampling ------------------------------- */

test("resampleTo16kMono downsamples 48 kHz to exactly one third", () => {
  const src = f32(4800, (i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
  const out = resampleTo16kMono(src, 48000);
  assert.ok(out instanceof Float32Array);
  assert.equal(out.length, 1600);
  for (let i = 0; i < out.length; i++) {
    assert.ok(Math.abs(out[i] - src[i * 3]) < 1e-6, `sample ${i}`);
  }
});

test("resampleTo16kMono passes 16 kHz through untouched", () => {
  const src = f32(512, (i) => i / 512);
  const out = resampleTo16kMono(src, 16000);
  assert.equal(out, src, "no copy needed when the rate already matches");
  assert.equal(out.length, 512);
});

test("resampleTo16kMono produces the right length for arbitrary ratios", () => {
  const src = f32(4000, 0.25);
  const out = resampleTo16kMono(src, 44100);
  assert.equal(out.length, Math.round((4000 * 16000) / 44100));
  assert.ok(out.every((value) => Math.abs(value - 0.25) < 1e-6), "DC stays DC");

  const up = resampleTo16kMono(f32(800, 0.5), 8000);
  assert.equal(up.length, 1600, "8 kHz upsamples 2x");

  assert.equal(resampleTo16kMono(new Float32Array(0), 48000).length, 0);
});

/* ------------------------------- PCM16 ---------------------------------- */

test("floatToPcm16 clamps, rounds and keeps mono length", () => {
  const out = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5, -0.5]));
  assert.ok(out instanceof Int16Array);
  assert.deepEqual([...out], [0, 32767, -32768, 32767, -32768, 16384, -16384]);
  assert.equal(out.length, 7);
});

/* -------------------------- capture backends ---------------------------- */

test("file capture reads a 16-bit PCM WAV fixture chunk by chunk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p2-wav-"));
  try {
    const samples = new Int16Array(1200);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(20000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
    }
    const filePath = join(dir, "fixture.wav");
    writeFileSync(filePath, makeWav(samples, SAMPLE_RATE, 1));

    const capture = createCapture({
      backend: "file",
      source: "microphone",
      filePath,
      chunkMs: 16,
      pace: "fast",
    });
    const chunks = [];
    const unsub = capture.onChunk((chunk) => chunks.push(chunk));
    await capture.start();
    await waitFor(() => capture.info().ended);
    unsub();

    assert.deepEqual(
      chunks.map((c) => c.pcm.length),
      [256, 256, 256, 256, 176],
    );
    assert.ok(chunks.every((c) => c.sampleRate === SAMPLE_RATE));
    assert.equal(chunks[0].timestampMs, 0);
    assert.ok(Math.abs(chunks[1].timestampMs - 16) < 1e-9);

    const merged = new Float32Array(samples.length);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk.pcm, offset);
      offset += chunk.pcm.length;
    }
    assert.equal(offset, samples.length);
    for (let i = 0; i < merged.length; i++) {
      assert.ok(Math.abs(merged[i] - samples[i] / 32768) < 1e-4, `sample ${i}`);
    }

    const info = capture.info();
    assert.equal(info.backend, "file");
    assert.equal(info.channels, 1);
    assert.equal(info.ended, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("simulated capture is deterministic under a seed and contains bursts + silence", async () => {
  const collect = async (seed) => {
    const capture = createCapture({
      backend: "simulated",
      seed,
      durationMs: 1000,
      chunkMs: 32,
      pace: "fast",
    });
    const chunks = [];
    capture.onChunk((chunk) => chunks.push(chunk.pcm.slice()));
    await capture.start();
    await waitFor(() => capture.info().ended);
    return chunks;
  };

  const first = await collect(1234);
  const second = await collect(1234);
  assert.equal(first.length, Math.ceil(SAMPLE_RATE / FRAME)); // 32 chunks
  assert.equal(first.length, second.length);
  for (let i = 0; i < first.length; i++) {
    assert.deepEqual([...first[i]], [...second[i]], `chunk ${i} differs`);
  }

  const merged = new Float32Array(SAMPLE_RATE);
  let offset = 0;
  for (const chunk of first) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  assert.equal(offset, SAMPLE_RATE);

  let sum = 0;
  for (let i = 1000; i < 6000; i++) sum += merged[i] * merged[i];
  const rms = Math.sqrt(sum / 5000);
  assert.ok(rms > 0.1, `speech burst rms ${rms}`);

  for (let i = 8000; i < SAMPLE_RATE; i++) {
    assert.equal(merged[i], 0, `expected exact silence at ${i}`);
  }
});

test("native capture without a host reports unsupported", async () => {
  const capture = createCapture({ backend: "native", source: "microphone" });
  assert.equal(typeof capture.stop, "function");
  assert.equal(typeof capture.onChunk, "function");
  assert.equal(capture.info().backend, "native");
  await assert.rejects(
    () => capture.start(),
    /native audio capture is unsupported on this platform/,
  );
});

test("native capture delegates to the injected host", async () => {
  const chunks = [];
  let opened = null;
  const host = {
    async open(request) {
      opened = request;
      request.onChunk({
        pcm: new Float32Array([0.25]),
        sampleRate: SAMPLE_RATE,
        generation: 3,
      });
      return {
        info: { endpointId: "mic-a", sampleRate: SAMPLE_RATE, generation: 3 },
        stop: async () => {},
      };
    },
  };
  const capture = createCapture({
    backend: "native",
    source: "microphone",
    nativeHost: host,
    choice: { kind: "endpoint", id: "mic-a" },
    generation: 3,
  });
  capture.onChunk((chunk) => chunks.push(chunk));
  await capture.start();
  assert.equal(opened.source, "microphone");
  assert.equal(opened.choice.id, "mic-a");
  assert.equal(opened.generation, 3);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pcm[0], 0.25);
  assert.equal(capture.info().endpointId, "mic-a");
  await capture.stop();
});

test("unknown capture backends are rejected", async () => {
  const capture = createCapture({ backend: "telepathy" });
  await assert.rejects(() => capture.start(), /unknown capture backend/i);
});

/* ------------------------------- pipeline -------------------------------- */

function fakeCapture(frames) {
  const listeners = new Set();
  return {
    onChunk(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async start() {
      for (const frame of frames) {
        for (const cb of [...listeners]) {
          cb({ pcm: frame, sampleRate: SAMPLE_RATE, timestampMs: 0 });
        }
        await tick(); // let the gate drain between chunks, like a real device
      }
    },
    stop() {},
    info() {
      return { backend: "fake" };
    },
  };
}

test("speech pipeline emits vad/audio events and finalizes the sink on speech end", async () => {
  const frames = [];
  for (let i = 0; i < 8; i++) frames.push(new Float32Array(FRAME)); // silence
  for (let i = 0; i < 32; i++) frames.push(speechFrame(i)); // utterance
  for (let i = 0; i < 40; i++) frames.push(new Float32Array(FRAME)); // trailing silence

  const vad = {
    initialState: () => new Float32Array(320),
    probe: async (frame, carry) => {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      return { probability: rms > 0.05 ? 0.9 : 0.1, nextState: carry };
    },
  };

  const sent = [];
  const finalized = [];
  const events = [];
  const sink = {
    sendAudio: (source, pcm16) => sent.push({ source, pcm16 }),
    finalizeStream: (source) => finalized.push(source),
  };

  const pipeline = createSpeechPipeline({
    capture: fakeCapture(frames),
    vad,
    sink,
    source: "microphone",
  });
  pipeline.onEvent((event) => events.push(event));

  await pipeline.start();
  await waitFor(() => finalized.length > 0);
  await pipeline.stop();

  assert.deepEqual(finalized, ["microphone"], "finalize fires once on speech end");
  const vadEvents = events.filter((e) => e.type === "vad");
  assert.deepEqual(
    vadEvents.map((e) => e.speaking),
    [true, false],
  );

  const audioEvents = events.filter((e) => e.type === "audio");
  assert.ok(audioEvents.length > 10, `audio events: ${audioEvents.length}`);
  assert.ok(audioEvents.every((e) => Number.isInteger(e.bytes) && e.bytes % 2 === 0));
  assert.equal(sent.length, audioEvents.length);
  assert.ok(sent.every((s) => s.source === "microphone"));
  assert.ok(sent.every((s) => s.pcm16 instanceof Int16Array && s.pcm16.length === FRAME));
  assert.equal(
    audioEvents[0].bytes,
    FRAME * 2,
    "512 stereo-free samples are 1024 bytes",
  );
});

test("pipeline accepts a raw VAD instance exposing process()", async () => {
  const frames = [f32(FRAME, 0.5), f32(FRAME, 0.5)];
  const sent = [];
  let probes = 0;
  const rawVad = {
    initialState: () => new Float32Array(320),
    process: async (frame, carry) => {
      probes++;
      return { probability: 0.9, nextState: carry };
    },
  };
  const pipeline = createSpeechPipeline({
    capture: fakeCapture(frames),
    vad: rawVad,
    sink: { sendAudio: (source, pcm16) => sent.push(pcm16), finalizeStream: () => {} },
    source: "microphone",
  });
  await pipeline.start();
  await pipeline.stop();
  assert.ok(probes >= 1, "process() was used as the probe");
  assert.equal(sent.length, 2);
  const stats = pipeline.stats();
  assert.equal(stats.forwarded, 2);
  assert.equal(stats.speaking, false, "flush() closes the segment at stop");
});

test("pipeline with a null vad forwards every frame without gating", async () => {
  const frames = [f32(FRAME, 0.3), f32(FRAME, -0.3), f32(FRAME, 0.1)];
  const sent = [];
  const events = [];
  const pipeline = createSpeechPipeline({
    capture: fakeCapture(frames),
    vad: null,
    sink: {
      sendAudio: (source, pcm16) => sent.push({ source, pcm16 }),
      finalizeStream: () => {},
    },
    source: "system",
  });
  pipeline.onEvent((event) => events.push(event));

  await pipeline.start();
  await tick();
  await pipeline.stop();

  assert.equal(sent.length, 3);
  assert.ok(sent.every((s) => s.source === "system" && s.pcm16.length === FRAME));
  assert.equal(events.filter((e) => e.type === "audio").length, 3);
  assert.equal(events.filter((e) => e.type === "vad").length, 0);
});

test("pipeline emits an error event for a bad capture chunk and keeps going", async () => {
  const listeners = new Set();
  const capture = {
    onChunk(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async start() {
      for (const cb of [...listeners]) {
        cb({ pcm: new Float32Array(FRAME), sampleRate: 0, timestampMs: 0 }); // invalid rate
      }
      await tick();
      for (const cb of [...listeners]) {
        cb({ pcm: new Float32Array(FRAME), sampleRate: SAMPLE_RATE, timestampMs: 0 });
      }
    },
    stop() {},
    info() {
      return { backend: "fake" };
    },
  };

  const events = [];
  const pipeline = createSpeechPipeline({
    capture,
    vad: null,
    sink: { sendAudio: () => {}, finalizeStream: () => {} },
    source: "microphone",
    log: () => {},
  });
  pipeline.onEvent((event) => events.push(event));

  await pipeline.start();
  await tick();
  await pipeline.stop();

  const errors = events.filter((e) => e.type === "error");
  assert.equal(errors.length, 1);
  assert.ok(errors[0].error instanceof Error);
  assert.ok(
    events.some((e) => e.type === "audio"),
    "capture continues after the bad chunk",
  );
});
