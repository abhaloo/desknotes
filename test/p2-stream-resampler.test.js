import test from "node:test";
import assert from "node:assert/strict";
import { createStreamingResampler } from "../src/audio/stream-resampler.js";

function tone(rate, freq, amplitude = 0.25) {
  const out = new Float32Array(rate);
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return out;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

test("48k/44.1k arbitrary packets match analytical 997 Hz oracle and preserve one second of speech", () => {
  for (const inputRate of [48000, 44100]) {
    const input = Float32Array.from({ length: inputRate }, (_, i) =>
      0.25 * Math.sin((2 * Math.PI * 997 * i) / inputRate),
    );
    const split = createStreamingResampler({ inputRate, outputRate: 16000 });
    const pieces = [];
    for (let i = 0; i < input.length; i += 128) pieces.push(split.push(input.subarray(i, i + 128)));
    pieces.push(split.flush());
    const actual = pieces.flatMap((part) => [...part]);
    const whole = createStreamingResampler({ inputRate, outputRate: 16000 });
    const expectedWhole = [...whole.push(input), ...whole.flush()];
    assert.ok(Math.abs(actual.length - 16000) <= 1);
    assert.equal(actual.length, expectedWhole.length);
    actual.forEach((value, index) => assert.ok(Math.abs(value - expectedWhole[index]) < 1e-5));
    // Independent analytical oracle: steady-state 997 Hz RMS at 16 kHz must match 0.25 / Math.SQRT2 within 1 dB
    const steady = actual.slice(256, actual.length - 256);
    const measured = Math.sqrt(steady.reduce((sum, value) => sum + value * value, 0) / steady.length);
    const targetRms = 0.25 / Math.SQRT2;
    const dbDiff = Math.abs(20 * Math.log10(measured / targetRms));
    assert.ok(dbDiff <= 1.0, `passband RMS drift ${dbDiff} dB exceeds 1 dB`);
  }
});

test("1 kHz passband stays within 1 dB and 12 kHz at 48 kHz is rejected by 40 dB", () => {
  const referenceInput = tone(48000, 1000, 0.25);
  const reference = createStreamingResampler({ inputRate: 48000, outputRate: 16000 });
  const referenceOut = concat([reference.push(referenceInput), reference.flush()]);
  const referenceSteady = referenceOut.subarray(256, referenceOut.length - 256);
  const referenceRms = rms(referenceSteady);
  const targetRms = 0.25 / Math.SQRT2;
  const passbandDb = Math.abs(20 * Math.log10(referenceRms / targetRms));
  assert.ok(passbandDb <= 1, `1 kHz drift ${passbandDb} dB`);

  const stopInput = tone(48000, 12000, 0.25);
  const stopped = createStreamingResampler({ inputRate: 48000, outputRate: 16000 });
  const stopOut = concat([stopped.push(stopInput), stopped.flush()]);
  const stopSteady = stopOut.subarray(256, stopOut.length - 256);
  const rejectionDb = 20 * Math.log10(rms(stopSteady) / referenceRms);
  assert.ok(rejectionDb <= -40, `12 kHz rejection ${rejectionDb} dB`);
});

test("flush is one-shot and reset clears fractional history", () => {
  const input = tone(48000, 997, 0.25);
  const used = createStreamingResampler({ inputRate: 48000, outputRate: 16000 });
  used.push(input.subarray(0, 4000));
  const tail = used.flush();
  assert.ok(tail.length > 0);
  assert.equal(used.flush().length, 0);
  assert.equal(used.push(input).length, 0, "a flushed resampler ignores further input");

  used.reset();
  const fresh = createStreamingResampler({ inputRate: 48000, outputRate: 16000 });
  const restarted = concat([used.push(input), used.flush()]);
  const expected = concat([fresh.push(input), fresh.flush()]);
  assert.equal(restarted.length, expected.length);
  for (let i = 0; i < restarted.length; i++) {
    assert.ok(Math.abs(restarted[i] - expected[i]) < 1e-5, `sample ${i}`);
  }
});

test("equal rates pass samples through with no delay", () => {
  const input = new Float32Array([0.25, -0.5, 0.125, 0]);
  const resampler = createStreamingResampler({ inputRate: 16000, outputRate: 16000 });
  const pushed = resampler.push(input);
  assert.equal(pushed, input);
  assert.equal(resampler.flush().length, 0);
});
