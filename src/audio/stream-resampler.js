/**
 * Continuous windowed-sinc resampler.
 *
 * Native capture delivers arbitrary packet sizes at the device rate. A fresh
 * linear resample of each packet restarts the fractional phase, so one second
 * of 48 kHz audio split into 128-sample packets would not last one second at
 * 16 kHz. This filter keeps phase and history across pushes.
 *
 * Equal rates are a copy: the speech path already frames 16 kHz audio at 512
 * samples, and a Nyquist sinc would delay those frames.
 */

const DEFAULT_OUTPUT_RATE = 16000;
const DEFAULT_MAX_TAPS = 256;
const MIN_TAPS = 31;
const MAX_CACHED_PHASES = 1024;

function assertRate(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid ${name} sample rate: ${value}`);
  }
}

function oddTapCount(maxTaps) {
  const cap = Math.min(DEFAULT_MAX_TAPS, Math.max(MIN_TAPS, maxTaps | 0));
  return cap % 2 === 0 ? cap - 1 : cap;
}

/** Blackman window on [-1, 1]. Zero at the edges, one at the center. */
function blackman(offsetOverHalf) {
  const t = Math.abs(offsetOverHalf);
  if (t >= 1) return 0;
  return (
    0.42 +
    0.5 * Math.cos(Math.PI * offsetOverHalf) +
    0.08 * Math.cos(2 * Math.PI * offsetOverHalf)
  );
}

function asFloat32(input) {
  if (input instanceof Float32Array) return input;
  if (!input || typeof input.length !== "number") {
    throw new Error("resampler input must be a Float32Array");
  }
  return Float32Array.from(input);
}

/**
 * @param {{ inputRate: number, outputRate?: number, maxTaps?: number }} options
 * @returns {{ push: (input: Float32Array) => Float32Array, flush: () => Float32Array, reset: () => void }}
 */
export function createStreamingResampler({
  inputRate,
  outputRate = DEFAULT_OUTPUT_RATE,
  maxTaps = DEFAULT_MAX_TAPS,
} = {}) {
  assertRate("input", inputRate);
  assertRate("output", outputRate);

  if (inputRate === outputRate) {
    let flushed = false;
    return {
      push(input) {
        if (flushed) return new Float32Array(0);
        const pcm = asFloat32(input);
        if (pcm.length === 0) return new Float32Array(0);
        return pcm instanceof Float32Array && input instanceof Float32Array ? pcm : Float32Array.from(pcm);
      },
      flush() {
        flushed = true;
        return new Float32Array(0);
      },
      reset() {
        flushed = false;
      },
    };
  }

  const taps = oddTapCount(maxTaps);
  const half = (taps - 1) >> 1;
  // Low-pass below the lower Nyquist. The 0.9 scale leaves a transition
  // band so a 12 kHz tone at 48 kHz input falls in the stopband, while
  // 1 kHz stays inside the flat passband.
  const cutoff = 0.5 * Math.min(1, outputRate / inputRate) * (outputRate < inputRate ? 0.9 : 1);
  const stepDenom = outputRate;

  let storage = new Float64Array(4096);
  let base = 0;
  let length = 0;
  let consumed = 0;
  let outputCount = 0;
  let flushed = false;

  function sampleAt(index) {
    if (index < base || index >= consumed) return 0;
    return storage[index - base];
  }

  function coeff(offset) {
    const ax = Math.abs(offset);
    if (ax > half) return 0;
    const sincArg = 2 * cutoff * offset;
    const sinc = sincArg === 0 ? 1 : Math.sin(Math.PI * sincArg) / (Math.PI * sincArg);
    return 2 * cutoff * sinc * blackman(offset / half);
  }

  // coeff() costs a sin and two cos per tap, on the thread that also relays
  // answer tokens. The weights depend only on the fractional phase, and the
  // phase repeats (one value for 48k -> 16k, 160 for 44.1k -> 16k), so each
  // phase is computed once. The map is keyed by the exact double, so output
  // is bit-identical; clearing at the cap bounds it as the low bits of the
  // phase change with the magnitude of the position.
  const phaseWeights = new Map();

  function weightsFor(frac) {
    let entry = phaseWeights.get(frac);
    if (entry) return entry;
    const w = new Float64Array(taps);
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      const value = coeff(k - frac);
      w[k + half] = value;
      sum += value;
    }
    if (phaseWeights.size >= MAX_CACHED_PHASES) phaseWeights.clear();
    entry = { w, sum };
    phaseWeights.set(frac, entry);
    return entry;
  }

  function emitAt(pos) {
    const i0 = Math.floor(pos);
    const { w, sum } = weightsFor(pos - i0);
    let acc = 0;
    for (let k = -half; k <= half; k++) {
      acc += sampleAt(i0 + k) * w[k + half];
    }
    if (sum === 0) return 0;
    return acc / sum;
  }

  function compact() {
    const nextPos = (outputCount * inputRate) / stepDenom;
    const keep = Math.max(0, Math.floor(nextPos) - half - 2);
    if (keep <= base) return;
    const drop = keep - base;
    if (drop >= length) {
      storage = new Float64Array(4096);
      length = 0;
      base = consumed;
      return;
    }
    storage.copyWithin(0, drop, length);
    length -= drop;
    base = keep;
  }

  function append(input) {
    const need = length + input.length;
    if (need > storage.length) {
      let cap = storage.length;
      while (cap < need) cap *= 2;
      const next = new Float64Array(cap);
      next.set(storage.subarray(0, length));
      storage = next;
    }
    for (let i = 0; i < input.length; i++) storage[length + i] = input[i];
    length += input.length;
    consumed += input.length;
  }

  function produce(allowPadding) {
    const out = [];
    while (outputCount < 1e12) {
      const pos = (outputCount * inputRate) / stepDenom;
      if (allowPadding) {
        if (pos >= consumed) break;
      } else if (Math.floor(pos) + half >= consumed) {
        break;
      }
      out.push(emitAt(pos));
      outputCount += 1;
    }
    const pcm = new Float32Array(out.length);
    for (let i = 0; i < out.length; i++) pcm[i] = out[i];
    compact();
    return pcm;
  }

  return {
    push(input) {
      if (flushed) return new Float32Array(0);
      const pcm = asFloat32(input);
      if (pcm.length === 0) return new Float32Array(0);
      append(pcm);
      return produce(false);
    },
    flush() {
      if (flushed) return new Float32Array(0);
      flushed = true;
      return produce(true);
    },
    reset() {
      storage = new Float64Array(4096);
      base = 0;
      length = 0;
      consumed = 0;
      outputCount = 0;
      flushed = false;
    },
  };
}
