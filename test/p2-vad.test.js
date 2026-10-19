import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { VadConfig, SileroVad, EnergyVad, VadGate } from "../src/vad/index.js";

const MODEL_URL = new URL("../third_party/silero_vad.onnx", import.meta.url);

let ortAvailable = false;
try {
  await import("onnxruntime-node");
  ortAvailable = true;
} catch {
  ortAvailable = false;
}
const sileroSkip = !ortAvailable
  ? "onnxruntime-node unavailable"
  : !existsSync(MODEL_URL)
    ? "vendored model missing"
    : false;

const SAMPLE_RATE = 16000;
const FRAME = VadConfig.frameSamples;

/** Speech-like: syllable-modulated harmonics + breath; Silero scores this high. */
function speechFrame(i) {
  const frame = new Float32Array(FRAME);
  for (let j = 0; j < FRAME; j++) {
    const s = i * FRAME + j;
    const t = s / SAMPLE_RATE;
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    const vibrato = 1 + 0.15 * Math.sin(2 * Math.PI * 3 * t);
    frame[j] =
      syllable *
      (0.5 * Math.sin(2 * Math.PI * 180 * vibrato * t) +
        0.25 * Math.sin(2 * Math.PI * 360 * vibrato * t) +
        0.12 * Math.sin(2 * Math.PI * 900 * vibrato * t));
  }
  return frame;
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

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("VadConfig exposes the frozen tunables", () => {
  assert.deepEqual(VadConfig, {
    enabled: true,
    frameSamples: 512,
    sampleRate: 16000,
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    redemptionFrames: 24,
    preRollMs: 384,
    maxQueueFrames: 32,
    maxDroppedBeforeFailOpen: 64,
  });
});

test("SileroVad detects speech-like audio over silence and advances carry state", { skip: sileroSkip }, async () => {
  const vad = await SileroVad.create();
  try {
    assert.equal(vad.frameSamples, 512);
    const initial = vad.initialState();
    assert.ok(initial instanceof Float32Array);
    assert.equal(initial.length, 320); // LSTM [2,1,128] + 64 context samples

    // Silence first: the model must stay quiet and the LSTM state must be
    // carried (not reset) between calls.
    let silenceCarry = initial;
    let silenceSum = 0;
    for (let i = 0; i < 12; i++) {
      const result = await vad.process(new Float32Array(FRAME), silenceCarry);
      assert.ok(result.probability >= 0 && result.probability <= 1);
      assert.ok(result.nextState instanceof Float32Array);
      silenceCarry = result.nextState;
      silenceSum += result.probability;
    }
    const silenceAvg = silenceSum / 12;
    assert.ok(silenceAvg < 0.2, `silence avg ${silenceAvg}`);

    // Speech-like frames: state must actually change (LSTM + context carry).
    let speechCarry = initial;
    let speechSum = 0;
    let peak = 0;
    for (let i = 0; i < 16; i++) {
      const result = await vad.process(speechFrame(i), speechCarry);
      speechCarry = result.nextState;
      speechSum += result.probability;
      peak = Math.max(peak, result.probability);
    }
    const speechAvg = speechSum / 16;
    assert.ok(peak > silenceAvg, `speech peak ${peak} vs silence avg ${silenceAvg}`);
    assert.ok(
      speechAvg > silenceAvg + 0.1,
      `speech avg ${speechAvg} should clearly beat silence avg ${silenceAvg}`,
    );
    assert.ok(
      !speechCarry.every((v, i) => v === initial[i]),
      "nextState must advance the carry",
    );
    assert.notEqual(speechCarry, initial, "nextState should be a fresh buffer");
  } finally {
    await vad.dispose();
  }
});

test("SileroVad create() fails clearly when the model is missing", { skip: !ortAvailable }, async () => {
  await assert.rejects(
    () => SileroVad.create({ modelPath: new URL("./does-not-exist.onnx", MODEL_URL) }),
    /not found/i,
  );
});

test("SileroVad dispose() is idempotent and blocks further inference", { skip: sileroSkip }, async () => {
  const vad = await SileroVad.create();
  await vad.dispose();
  await vad.dispose();
  await assert.rejects(() => vad.process(new Float32Array(FRAME), null), /disposed/);
});

test("SileroVad.process rejects malformed frames", { skip: sileroSkip }, async () => {
  const vad = await SileroVad.create();
  try {
    await assert.rejects(() => vad.process(new Float32Array(256), null), /Float32Array\(512\)/);
  } finally {
    await vad.dispose();
  }
});

test("EnergyVad gates silence and passes loud audio with the same contract", async () => {
  const vad = new EnergyVad({ noiseFloorDb: -55 });
  const carry = new Float32Array(0);

  const silence = await vad.process(new Float32Array(FRAME), carry);
  assert.equal(silence.nextState, carry); // stateless: carry mirrored
  assert.ok(silence.probability < VadConfig.negativeSpeechThreshold);

  const loud = f32(FRAME, (i) => 0.6 * Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE));
  const speech = await vad.process(loud, carry);
  assert.ok(speech.probability >= VadConfig.positiveSpeechThreshold);
});

/* ------------------------------- VadGate -------------------------------- */

function frameTagged(tag) {
  return f32(FRAME, () => tag);
}

function tagOf(frame) {
  return frame[0];
}

/** Scripted async probe: probability comes from `script(probeIndex)`. */
function makeScriptedGate({ script, onSend, onSpeechEnd, onFailedOpen, onSpeechStart, tunables } = {}) {
  const sent = [];
  const ends = [];
  const opens = [];
  const failed = [];
  let probeCalls = 0;
  const gate = new VadGate({
    probe: async (frame, carry) => {
      const index = probeCalls++;
      const probability = script(index, frame);
      await tick(); // realistic async inference, never synchronous
      return { probability, nextState: carry };
    },
    onSend: (frame) => {
      sent.push(tagOf(frame));
      onSend?.(frame);
    },
    onSpeechEnd: () => {
      ends.push(ends.length);
      onSpeechEnd?.();
    },
    onSpeechStart: () => {
      opens.push(opens.length);
      onSpeechStart?.();
    },
    onFailedOpen: () => {
      failed.push(failed.length);
      onFailedOpen?.();
    },
    tunables,
  });
  return { gate, sent, ends, opens, failed, probeCalls: () => probeCalls };
}

test("VadGate gates silence and flushes the pre-roll on speech onset", async () => {
  const silence = (i) => (i < 8 ? 0 : 0.9);
  const { gate, sent, ends, opens } = makeScriptedGate({ script: silence });

  // 8 silent frames: all held in the pre-roll, nothing forwarded, none lost.
  for (let i = 0; i < 8; i++) gate.feed(frameTagged(i));
  await gate.drain();
  assert.deepEqual(sent, []);
  assert.deepEqual(opens, []);
  assert.equal(gate.stats().speaking, false);
  assert.equal(gate.stats().gated, 0);

  // Onset on frame 8: the whole pre-roll (including the ramp-up) is flushed
  // before the onset frame itself is lazy-forwarded.
  for (let i = 8; i < 12; i++) gate.feed(frameTagged(i));
  await gate.drain();
  assert.deepEqual(sent, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(opens.length, 1, "one speech-start event");

  // While speaking every frame is forwarded immediately.
  for (let i = 12; i < 16; i++) gate.feed(frameTagged(i));
  await gate.drain();
  assert.deepEqual(sent.slice(-4), [12, 13, 14, 15]);
  const stats = gate.stats();
  assert.equal(stats.forwarded, 16);
  assert.equal(stats.gated, 0);
  assert.equal(stats.speaking, true);
  assert.deepEqual(ends, []);
  gate.close();
});

test("VadGate waits out the 24-frame redemption hangover before onSpeechEnd", async () => {
  const { gate, sent, ends } = makeScriptedGate({
    script: (i) => (i < 4 ? 0.9 : 0.2),
  });

  for (let i = 0; i < 4; i++) gate.feed(frameTagged(i));
  await gate.drain();
  assert.equal(gate.stats().speaking, true);
  assert.equal(ends.length, 0);

  // 23 quiet frames is not yet the end of the utterance.
  for (let i = 4; i < 4 + 23; i++) gate.feed(frameTagged(i));
  await gate.drain();
  assert.equal(ends.length, 0, "hangover not exhausted");
  assert.equal(gate.stats().speaking, true);

  // The 24th quiet frame closes the segment; the tail was already forwarded.
  gate.feed(frameTagged(27));
  await gate.drain();
  assert.equal(ends.length, 1);
  assert.equal(gate.stats().speaking, false);
  assert.equal(sent.length, 28, "tail audio still reaches the sink");
  gate.close();
});

test("VadGate hysteresis band resets the hangover counter", async () => {
  let phase = "speech";
  const { gate, ends } = makeScriptedGate({
    script: () => (phase === "speech" ? 0.9 : phase === "quiet" ? 0.2 : 0.4),
  });

  gate.feed(frameTagged(0));
  await gate.drain();
  assert.equal(gate.stats().speaking, true);

  phase = "quiet";
  for (let i = 0; i < 23; i++) gate.feed(frameTagged(i));
  await gate.drain();

  phase = "band"; // 0.4: above the negative threshold => still a live segment
  gate.feed(frameTagged(100));
  await gate.drain();
  assert.equal(gate.stats().speaking, true);
  assert.equal(ends.length, 0);

  phase = "quiet";
  for (let i = 0; i < 23; i++) gate.feed(frameTagged(i));
  await gate.drain();
  assert.equal(ends.length, 0, "counter restarted after the hysteresis frame");

  gate.feed(frameTagged(200));
  await gate.drain();
  assert.equal(ends.length, 1);
  gate.close();
});

test("VadGate forwards on backlog saturation instead of stranding audio", async () => {
  let hold = true;
  const pending = [];
  const sent = [];
  const gate = new VadGate({
    probe: (frame, carry) =>
      new Promise((resolve) => {
        const done = () => resolve({ probability: 0, nextState: carry });
        if (hold) pending.push(done);
        else done();
      }),
    onSend: (frame) => sent.push(tagOf(frame)),
  });

  // 34 frames synchronously: one is in flight, 32 fill the queue, the 34th
  // drops the oldest queued detection. The saturation rule:
  // once the detector cannot keep up the gate stops gating — the held pre-roll
  // is flushed and the tail forwarded, because stranding speech behind a
  // stalled detector is the worse error.
  gate.feed(f32(34 * FRAME, (i) => Math.floor(i / FRAME)));
  assert.equal(gate.stats().dropped, 1);
  assert.ok(sent.length > 0, "saturation must flush the pre-roll and forward");

  hold = false;
  while (pending.length) pending.shift()();
  await gate.drain();
  assert.equal(gate.stats().failedOpen, false, "backlog drops alone do not fail open");
  assert.equal(gate.stats().dropped, 1);
  gate.close();
});

test("VadGate fails open on the FIRST probe failure and stops probing", async () => {
  let calls = 0;
  const sent = [];
  const failed = [];
  const gate = new VadGate({
    probe: async () => {
      calls++;
      throw new Error("inference exploded");
    },
    onSend: (frame) => sent.push(tagOf(frame)),
    onFailedOpen: () => failed.push(1),
  });

  // The gate fails open on the first inference FAILURE: a broken detector
  // is not "one missed detection" — the 64 budget is for backlog drops only.
  for (let i = 0; i < 4; i++) gate.feed(frameTagged(i));
  await gate.drain();

  const stats = gate.stats();
  assert.equal(stats.failedOpen, true, "first probe error fails the gate open");
  assert.equal(failed.length, 1, "onFailedOpen fires once");
  assert.equal(calls, 1, "no further inference after the first failure");
  const sentAtFailOpen = sent.length;

  // Post-fail-open: everything flows, nothing is probed.
  for (let i = 0; i < 5; i++) gate.feed(frameTagged(500 + i));
  await tick();
  assert.equal(calls, 1, "no more inference after fail-open");
  assert.equal(sent.length, sentAtFailOpen + 5);
  assert.deepEqual(sent.slice(-5), [500, 501, 502, 503, 504]);
  assert.equal(gate.stats().forwarded, sent.length);
  gate.close();
});

test("VadGate flush() emits the held tail and closes a live segment once", async () => {
  // Silent stream: held frames are flushed at end of stream, no speech end.
  const quiet = makeScriptedGate({ script: () => 0 });
  for (let i = 0; i < 5; i++) quiet.gate.feed(frameTagged(i));
  await quiet.gate.drain();
  assert.deepEqual(quiet.sent, []);
  quiet.gate.flush();
  assert.deepEqual(quiet.sent, [0, 1, 2, 3, 4], "held tail is not lost at EOS");
  assert.equal(quiet.ends.length, 0);
  assert.equal(quiet.gate.stats().forwarded, 5);
  quiet.gate.flush(); // idempotent
  assert.deepEqual(quiet.sent, [0, 1, 2, 3, 4]);

  // Live segment: flush closes it (-> finalize upstream) exactly once.
  const live = makeScriptedGate({ script: () => 0.9 });
  live.gate.feed(frameTagged(7));
  await live.gate.drain();
  assert.equal(live.gate.stats().speaking, true);
  live.gate.flush();
  assert.equal(live.ends.length, 1);
  assert.equal(live.gate.stats().speaking, false);
  live.gate.flush();
  assert.equal(live.ends.length, 1, "flush is idempotent");
  await tick();
  live.gate.close();
});

test("VadGate buffers arbitrary chunk sizes into 512-sample frames", async () => {
  const { gate, sent } = makeScriptedGate({ script: () => 0.9 });
  // 300 + 300 + 424 samples = exactly two 512-sample frames, no remainder.
  gate.feed(f32(300, 1));
  gate.feed(f32(300, 2));
  gate.feed(f32(424, 3));
  await gate.drain();
  gate.flush();
  assert.equal(gate.stats().forwarded, 2);
  assert.ok(sent.length >= 2);
});
