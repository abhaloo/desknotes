import test from "node:test";
import assert from "node:assert/strict";
import { VadConfig, VadLatencyConfig, VadGate } from "../src/vad/index.js";

const FRAME = VadConfig.frameSamples;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const tagged = (tag) => new Float32Array(FRAME).fill(tag);
const tagOf = (frame) => frame[0];
const loud = () => {
  const f = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) f[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / 16000);
  return f;
};

/**
 * Gate with a scripted async probe; probability comes from `script(frame, probeIndex)`.
 * The hint mechanics below are written against an 8-frame hint; the shipped
 * default (22 frames) has its own test.
 */
function scripted(script, extra = {}) {
  const rec = { sent: [], ends: 0, starts: 0, pauses: 0, resumes: 0, failed: 0, order: [] };
  let calls = 0;
  const gate = new VadGate({
    probe: async (frame, carry) => {
      const p = script(frame, calls++);
      await tick();
      return { probability: p, nextState: carry };
    },
    onSend: (frame) => rec.sent.push(tagOf(frame)),
    onSpeechEnd: () => {
      rec.ends++;
      rec.order.push("end");
    },
    onSpeechStart: () => {
      rec.starts++;
      rec.order.push("start");
    },
    onSpeechPause: () => {
      rec.pauses++;
      rec.order.push("pause");
    },
    onSpeechResume: () => {
      rec.resumes++;
      rec.order.push("resume");
    },
    onFailedOpen: () => rec.failed++,
    ...extra,
    tunables: { pauseHintFrames: 8, ...extra.tunables },
  });
  return { gate, rec };
}

/** Feed frames one by one with the detector keeping up (no backlog). */
async function feedPaced(gate, frames) {
  for (const f of frames) {
    gate.feed(f);
    await gate.drain();
  }
}

test("pause-hint tunable is additive and shorter than the frozen redemption", () => {
  assert.equal(VadConfig.redemptionFrames, 24);
  assert.equal(VadLatencyConfig.pauseHintFrames, 22); // ~0.7 s of silence
  assert.ok(VadLatencyConfig.pauseHintFrames < VadConfig.redemptionFrames);
});

test("by default the hint waits ~0.7 s: the 22nd quiet frame, still before the 24-frame close", async () => {
  const { gate, rec } = scripted((frame) => (tagOf(frame) === 1 ? 0.9 : 0.1), {
    tunables: { pauseHintFrames: VadLatencyConfig.pauseHintFrames },
  });
  await feedPaced(gate, [tagged(1)]);
  await feedPaced(gate, Array.from({ length: 21 }, () => tagged(0)));
  assert.equal(rec.pauses, 0, "21 quiet frames (672 ms): no hint yet");
  await feedPaced(gate, [tagged(0)]);
  assert.equal(rec.pauses, 1, "22nd quiet frame (704 ms) raises the hint");
  assert.equal(rec.ends, 0);
  await feedPaced(gate, [tagged(0), tagged(0)]);
  assert.equal(rec.ends, 1, "the segment still closes on the 24th");
  assert.deepEqual(rec.order, ["start", "pause", "end"]);
  gate.close();
});

test("pause hint fires on the 8th quiet frame; the segment still closes only on the 24th", async () => {
  const { gate, rec } = scripted((frame) => (tagOf(frame) === 1 ? 0.9 : 0.1));
  await feedPaced(gate, [tagged(1), tagged(1)]);
  assert.equal(rec.starts, 1);

  await feedPaced(gate, Array.from({ length: 7 }, () => tagged(0)));
  assert.equal(rec.pauses, 0, "7 quiet frames: no hint yet");

  await feedPaced(gate, [tagged(0)]);
  assert.equal(rec.pauses, 1, "8th quiet frame raises the probable-end hint");
  assert.equal(rec.ends, 0, "the hint never closes the segment");
  assert.equal(gate.stats().speaking, true);

  await feedPaced(gate, Array.from({ length: 15 }, () => tagged(0)));
  assert.equal(rec.ends, 0, "23 quiet frames still keep the segment open");
  await feedPaced(gate, [tagged(0)]);
  assert.equal(rec.ends, 1, "24th quiet frame closes it");
  assert.equal(rec.pauses, 1, "exactly one hint per pause");
  assert.equal(rec.resumes, 0);
  assert.deepEqual(rec.order, ["start", "pause", "end"]);
  assert.equal(rec.sent.length, 26, "hangover audio still reaches the sink");
  gate.close();
});

test("a mid-thought pause retracts the hint and never splits the utterance", async () => {
  const { gate, rec } = scripted((frame) => (tagOf(frame) === 1 ? 0.9 : 0.1));
  await feedPaced(gate, [tagged(1)]);
  // 20 quiet frames (640 ms): hint raised, hangover not exhausted.
  await feedPaced(gate, Array.from({ length: 20 }, () => tagged(0)));
  assert.equal(rec.pauses, 1);
  // Speaker resumes: hint retracted, still one segment.
  await feedPaced(gate, [tagged(1), tagged(1)]);
  assert.equal(rec.resumes, 1);
  assert.equal(rec.ends, 0, "no segment close across the pause");
  assert.equal(rec.starts, 1, "still the same segment");
  // Real end: a fresh hint, then one close.
  await feedPaced(gate, Array.from({ length: 24 }, () => tagged(0)));
  assert.deepEqual(rec.order, ["start", "pause", "resume", "pause", "end"]);
  gate.close();
});

test("hysteresis-band frames neither retract the hint nor re-raise it", async () => {
  const { gate, rec } = scripted((frame) => (tagOf(frame) === 1 ? 0.9 : tagOf(frame) === 2 ? 0.4 : 0.1));
  await feedPaced(gate, [tagged(1)]);
  await feedPaced(gate, Array.from({ length: 10 }, () => tagged(0)));
  assert.equal(rec.pauses, 1);
  await feedPaced(gate, [tagged(2)]); // band: keeps the segment alive, is not speech
  assert.equal(rec.resumes, 0);
  await feedPaced(gate, Array.from({ length: 23 }, () => tagged(0)));
  assert.equal(rec.ends, 0, "the band reset the closing hangover");
  assert.equal(rec.pauses, 1, "no duplicate hint while the first is outstanding");
  await feedPaced(gate, [tagged(0)]);
  assert.equal(rec.ends, 1);
  gate.close();
});

test("pauseHintFrames 0 (or >= redemption) disables the hint", async () => {
  for (const pauseHintFrames of [0, 24, 30]) {
    const { gate, rec } = scripted((frame) => (tagOf(frame) === 1 ? 0.9 : 0.1), { tunables: { pauseHintFrames } });
    await feedPaced(gate, [tagged(1), ...Array.from({ length: 24 }, () => tagged(0))]);
    assert.equal(rec.pauses, 0, `pauseHintFrames=${pauseHintFrames}`);
    assert.equal(rec.ends, 1);
    gate.close();
  }
});

test("flush() closes a hinted segment once and emits no resume", async () => {
  const { gate, rec } = scripted((frame) => (tagOf(frame) === 1 ? 0.9 : 0.1));
  await feedPaced(gate, [tagged(1), ...Array.from({ length: 9 }, () => tagged(0))]);
  assert.equal(rec.pauses, 1);
  gate.flush();
  gate.flush();
  assert.equal(rec.ends, 1);
  assert.equal(rec.resumes, 0);
  gate.close();
});

test("the probable-end hint keeps flowing while the gate is failed open", async () => {
  let explode = false;
  const pauses = [];
  const ends = [];
  const gate = new VadGate({
    probe: async (frame, carry) => {
      await tick();
      if (explode) throw new Error("inference exploded");
      return { probability: 0.9, nextState: carry };
    },
    onSend: () => {},
    onSpeechPause: () => pauses.push(1),
    onSpeechEnd: () => ends.push(1),
  });
  gate.feed(loud());
  await gate.drain();
  explode = true;
  gate.feed(loud());
  await gate.drain();
  assert.equal(gate.stats().failedOpen, true);
  for (let i = 0; i < VadLatencyConfig.pauseHintFrames; i++) gate.feed(new Float32Array(FRAME));
  assert.equal(pauses.length, 1, "hint after the default quiet frames on the energy fallback");
  assert.equal(ends.length, 0);
  for (let i = VadLatencyConfig.pauseHintFrames; i < VadConfig.redemptionFrames; i++) gate.feed(new Float32Array(FRAME));
  assert.equal(ends.length, 1);
  gate.close();
});
