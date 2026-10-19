import test from "node:test";
import assert from "node:assert/strict";
import { VadConfig, VadLatencyConfig, VadGate, energyProbability } from "../src/vad/index.js";

const FRAME = VadConfig.frameSamples;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const tagged = (tag) => new Float32Array(FRAME).fill(tag);
const tagOf = (frame) => frame[0];
const loud = () => {
  const f = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) f[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / 16000);
  return f;
};

/** Gate with a scripted async probe; probability comes from `script(frame, probeIndex)`. */
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

/** Probe whose inferences only resolve when released (a stalled detector). */
function heldProbe() {
  const pending = [];
  let hold = true;
  let calls = 0;
  const probe = (frame, carry) =>
    new Promise((resolve) => {
      calls++;
      const done = () => resolve({ probability: 0, nextState: carry });
      if (hold) pending.push(done);
      else done();
    });
  return {
    probe,
    calls: () => calls,
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      while (pending.length) pending.shift()();
    },
  };
}

test("fail-open tunables are additive and leave the frozen VadConfig untouched", () => {
  assert.equal(VadConfig.maxDroppedBeforeFailOpen, 64);
  assert.equal(VadLatencyConfig.dropWindowFrames, 256);
  assert.equal(VadLatencyConfig.failOpenCooldownFrames, 256);
});

test("pre-roll survives a burst: an onset that is still queued for inference is not discarded", async () => {
  // 30 frames delivered at once (a main-loop stall releasing captured audio):
  // the onset at frame 25 is detected long after frames 13..24 were fed.
  const { gate, rec } = scripted((frame) => (tagOf(frame) >= 25 ? 0.9 : 0));
  const burst = new Float32Array(30 * FRAME);
  for (let i = 0; i < 30; i++) burst.fill(i, i * FRAME, (i + 1) * FRAME);
  gate.feed(burst);
  await gate.drain();
  assert.equal(rec.starts, 1);
  const preOnset = rec.sent.filter((t) => t < 25);
  assert.ok(preOnset.length >= 12, `>=384 ms before the onset recovered, got ${preOnset.length}`);
  assert.deepEqual(rec.sent.slice(-5), [25, 26, 27, 28, 29], "onset and tail forwarded in order");
  for (let i = 1; i < rec.sent.length; i++) assert.ok(rec.sent[i] > rec.sent[i - 1], "strictly in order");
  gate.close();
});

test("isolated backlog bursts on a long call no longer add up to a permanent fail-open", async () => {
  const det = heldProbe();
  const sent = [];
  const failed = [];
  const gate = new VadGate({ probe: det.probe, onSend: (f) => sent.push(f), onFailedOpen: () => failed.push(1) });
  // Five stalls of 53 frames each: 1 in flight + 32 queued + 20 dropped = 100
  // drops in total, which the old lifetime counter turned into a permanent
  // fail-open after the 64th.
  for (let burst = 0; burst < 5; burst++) {
    det.hold();
    gate.feed(new Float32Array(53 * FRAME));
    det.release();
    await gate.drain();
    // ~9.6 s of steady audio with the detector keeping up between stalls.
    for (let i = 0; i < 20; i++) {
      gate.feed(new Float32Array(15 * FRAME));
      await gate.drain();
    }
  }
  assert.equal(gate.stats().dropped, 100);
  assert.equal(gate.stats().failedOpen, false, "transient bursts must not latch fail-open");
  assert.equal(failed.length, 0);
  gate.close();
});

test("a hung detector still fails open after 64 backlog drops (fail-open safety kept)", () => {
  const det = heldProbe(); // never released
  const failed = [];
  let sent = 0;
  const gate = new VadGate({ probe: det.probe, onSend: () => sent++, onFailedOpen: () => failed.push(1) });
  gate.feed(new Float32Array((1 + 32 + 63) * FRAME));
  assert.equal(gate.stats().failedOpen, false, "63 drops: still gating");
  gate.feed(new Float32Array(FRAME));
  assert.equal(gate.stats().failedOpen, true, "64th drop fails open");
  assert.equal(failed.length, 1);
  const before = sent;
  gate.feed(new Float32Array(10 * FRAME));
  assert.equal(sent, before + 10, "everything is forwarded once failed open");
  assert.equal(det.calls(), 1, "no further inference while failed open");
  gate.close();
});

test("failing open mid-utterance still ends the segment (energy endpointing keeps finalize alive)", async () => {
  let explode = false;
  const ends = [];
  let sent = 0;
  const gate = new VadGate({
    probe: async (frame, carry) => {
      await tick();
      if (explode) throw new Error("inference exploded");
      return { probability: 0.9, nextState: carry };
    },
    onSend: () => sent++,
    onSpeechEnd: () => ends.push(1),
  });
  gate.feed(loud());
  await gate.drain();
  assert.equal(gate.stats().speaking, true);
  explode = true;
  gate.feed(loud());
  await gate.drain();
  assert.equal(gate.stats().failedOpen, true);
  assert.equal(ends.length, 0, "failing open is not an end of speech");

  // Speaker keeps talking, then stops: the segment closes after the normal
  // 24-frame hangover, measured on frame energy.
  for (let i = 0; i < 10; i++) gate.feed(loud());
  for (let i = 0; i < 23; i++) gate.feed(new Float32Array(FRAME));
  assert.equal(ends.length, 0);
  gate.feed(new Float32Array(FRAME));
  assert.equal(ends.length, 1, "onSpeechEnd -> finalize still fires");
  assert.equal(sent, 2 + 10 + 24, "fail-open still forwards every frame");
  gate.close();
});

test("a backlog fail-open re-arms once the detector is idle again; a probe failure never does", async () => {
  const det = heldProbe();
  let sent = 0;
  const gate = new VadGate({ probe: det.probe, onSend: () => sent++ });
  gate.feed(new Float32Array((1 + 32 + 64) * FRAME));
  assert.equal(gate.stats().failedOpen, true);
  // Detector still stuck: cooldown elapses but it never re-arms.
  gate.feed(new Float32Array(300 * FRAME));
  assert.equal(gate.stats().failedOpen, true, "a stuck detector stays failed open");
  // The in-flight inference finally returns: the detector is alive.
  det.release();
  await gate.drain();
  gate.feed(new Float32Array(FRAME));
  assert.equal(gate.stats().failedOpen, false, "gating resumes after the cooldown");
  await gate.drain();
  const before = sent;
  for (let i = 0; i < 40; i++) {
    gate.feed(new Float32Array(FRAME));
    await gate.drain();
  }
  assert.ok(sent - before < 40, "silence is gated again");
  gate.close();

  const broken = new VadGate({
    probe: async () => {
      throw new Error("inference exploded");
    },
    onSend: () => {},
  });
  broken.feed(new Float32Array(FRAME));
  await broken.drain();
  assert.equal(broken.stats().failedOpen, true);
  broken.feed(new Float32Array(600 * FRAME));
  await broken.drain();
  assert.equal(broken.stats().failedOpen, true, "probe failures stay latched");
  broken.close();
});

test("energyProbability matches the EnergyVad mapping", () => {
  assert.equal(energyProbability(new Float32Array(FRAME)), 0);
  assert.ok(energyProbability(loud()) >= VadConfig.positiveSpeechThreshold);
  const quiet = new Float32Array(FRAME).fill(Math.pow(10, -50 / 20));
  assert.ok(energyProbability(quiet) < VadConfig.negativeSpeechThreshold);
});
