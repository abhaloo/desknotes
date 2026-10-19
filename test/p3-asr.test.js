import test from "node:test";
import assert from "node:assert/strict";
import { createAsr } from "../src/server/engines/asr.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tone(samples, amplitude = 9000) {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = Math.round(amplitude * Math.sin(i / 7));
  return out;
}

function collector() {
  const frames = [];
  return { frames, emit: (frame) => frames.push(frame) };
}

function interims(frames) {
  return frames.filter((f) => f.type === "transcript" && f.data.final === false);
}

function finals(frames) {
  return frames.filter((f) => f.type === "transcript" && f.data.final === true);
}

test("mock ASR emits interims every ~300ms of active speech and finalize closes immediately", () => {
  const { frames, emit } = collector();
  const asr = createAsr({ provider: "mock", emit, log: () => {} });
  const chunk = tone(1600); // 100 ms @ 16 kHz

  for (let i = 0; i < 9; i += 1) {
    asr.pushAudio({ streamIdx: 0, seq: i, source: "microphone", pcm16: chunk, ts: i * 100 });
  }
  const pieces = interims(frames);
  assert.equal(pieces.length, 3, "one interim per ~300ms of speech");
  assert.deepEqual(
    pieces.map((f) => f.data.seq),
    [0, 1, 2],
    "transcript seq is monotonic per stream",
  );
  // Text must converge so the pipeline has something better to prefetch each time.
  assert.ok(pieces[0].data.text.length < pieces[1].data.text.length);
  assert.ok(pieces[2].data.text.startsWith(pieces[0].data.text));
  assert.equal(pieces[2].data.text, "We usually start with");
  assert.equal(pieces[0].data.role, "rep");
  assert.equal(pieces[0].data.source, "mic");
  assert.equal(pieces[0].data.stream, 0);

  assert.equal(asr.finalize(0), true);
  const closed = finals(frames);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].data.text, "We usually start with");
  assert.equal(closed[0].data.seq, 3, "final continues the same transcript seq");
  assert.equal(asr.finalize(0), false, "finalize is one-shot per segment");
  assert.equal(finals(frames).length, 1);
  asr.close();
});

test("mock ASR maps stream 1 to prospect/system with an independent seq", () => {
  const { frames, emit } = collector();
  const asr = createAsr({ provider: "mock", emit, log: () => {} });
  const chunk = tone(1600);
  for (let i = 0; i < 6; i += 1) {
    asr.pushAudio({ streamIdx: 1, seq: i, source: "system", pcm16: chunk });
  }
  const pieces = interims(frames);
  assert.ok(pieces.length >= 2);
  assert.equal(pieces[0].data.role, "prospect");
  assert.equal(pieces[0].data.source, "system");
  assert.equal(pieces[0].data.seq, 0);
  assert.ok(pieces[0].data.text.startsWith("How does"));
  asr.finalize(1);
  assert.equal(finals(frames)[0].data.role, "prospect");
  asr.close();
});

test("mock ASR auto-closes a segment after ~700ms of silence chunks", () => {
  const { frames, emit } = collector();
  const asr = createAsr({ provider: "mock", emit, log: () => {} });
  asr.pushAudio({ streamIdx: 0, seq: 0, pcm16: tone(4800) }); // 300 ms of speech
  assert.equal(finals(frames).length, 0);

  const silent = new Int16Array(512); // 32 ms
  for (let i = 0; i < 25; i += 1) asr.pushAudio({ streamIdx: 0, seq: 1 + i, pcm16: silent });
  assert.equal(finals(frames).length, 1, "silence closes the open segment");
  assert.equal(finals(frames)[0].data.text, "We usually");

  for (let i = 0; i < 10; i += 1) asr.pushAudio({ streamIdx: 0, seq: 30 + i, pcm16: silent });
  assert.equal(finals(frames).length, 1, "further silence must not re-open the segment");
  asr.close();
});

test("mock ASR wall watchdog closes a segment when audio stops arriving", async () => {
  const { frames, emit } = collector();
  const asr = createAsr({ provider: "mock", emit, log: () => {}, silenceMs: 80 });
  asr.pushAudio({ streamIdx: 0, seq: 0, pcm16: tone(3200) }); // 200 ms burst, then nothing
  assert.equal(finals(frames).length, 0);
  await sleep(240);
  assert.equal(finals(frames).length, 1, "watchdog finalizes a stalled stream");
  asr.close();
});

test("mock ASR accepts wire-style Uint8Array PCM at the unaligned protocol offset", () => {
  const { frames, emit } = collector();
  const asr = createAsr({ provider: "mock", emit, log: () => {} });
  const payload = new Uint8Array(tone(9600).buffer); // 600 ms
  // Mirror decodeAudioFrame: payload starts at byte 5 of the binary frame.
  const framed = new Uint8Array(5 + payload.byteLength);
  framed.set(payload, 5);
  asr.pushAudio({ streamIdx: 0, seq: 0, pcm16: framed.subarray(5) });
  assert.equal(interims(frames).length, 1);
  assert.equal(interims(frames)[0].data.text, "We usually start", "unaligned wire bytes decode correctly");
  asr.finalize(0);
  assert.equal(finals(frames).length, 1);
  asr.close();
});

test("mock-scripted replays a per-stream script and advances utterances", () => {
  const { frames, emit } = collector();
  const script = {
    1: [
      "Could you describe a hard trade-off you made and the metric you used",
      "What would you improve in our product first",
    ],
  };
  const asr = createAsr({ provider: "mock-scripted", script, emit, log: () => {} });
  const chunk = tone(1600);

  for (let i = 0; i < 12; i += 1) asr.pushAudio({ streamIdx: 1, seq: i, pcm16: chunk }); // 1.2 s
  const first = interims(frames);
  assert.ok(first.length >= 3);
  assert.ok(first.every((f) => script[1][0].startsWith(f.data.text)));
  asr.finalize(1);
  assert.equal(finals(frames)[0].data.text, script[1][0], "final is the complete utterance");

  for (let i = 0; i < 6; i += 1) asr.pushAudio({ streamIdx: 1, seq: 100 + i, pcm16: chunk });
  const second = interims(frames).slice(first.length);
  assert.ok(second.length >= 1);
  assert.ok(script[1][1].startsWith(second[second.length - 1].data.text));
  asr.finalize(1);
  assert.equal(finals(frames)[1].data.text, script[1][1]);
  asr.close();
});

test("openai-compatible ASR degrades to the mock segmenter when unconfigured", () => {
  const { frames, emit } = collector();
  const logs = [];
  const asr = createAsr({ provider: "openai-compatible", emit, log: (entry) => logs.push(entry) });
  asr.pushAudio({ streamIdx: 0, seq: 0, pcm16: tone(4800) }); // 300 ms
  assert.equal(interims(frames).length, 1);
  assert.ok(logs.some((entry) => entry.type === "asr.provider_unconfigured"));
  assert.equal(asr.finalize(0), true);
  assert.equal(finals(frames).length, 1);
  asr.close();
});
