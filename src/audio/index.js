/**
 * Audio capture, resampling and the capture -> VAD -> sink pipeline.
 *
 * All capture backends deliver native-rate mono float samples to a single
 * listener API; resampling to the wire format (16 kHz mono PCM16) is a separate
 * pure step so it can be unit-tested and reused by every backend.
 */

import { readFileSync } from "node:fs";
import { SAMPLE_RATE } from "../shared/protocol.js";
import { VadConfig, VadGate } from "../vad/index.js";
import { createNativeCapture } from "./native-capture.js";
import { createStreamingResampler } from "./stream-resampler.js";

const DEFAULT_CHUNK_MS = 32;
const DEFAULT_SIM_DURATION_MS = 4000;

/** Deterministic stateless noise so a stream depends only on (seed, index). */
function noiseAt(seed, i) {
  let h = (seed | 0) ^ Math.imul(i | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/**
 * Speech-like burst: two formant-ish tones plus breath noise under a
 * raised-cosine envelope, followed by digital silence (exact zeros). Exact
 * zeros matter: tests and the gate must see unambiguous non-speech.
 */
function simulatedSample(seed, i, sampleRate) {
  const cycle = Math.max(1, Math.round(sampleRate)); // 1 s cadence
  const phase = i % cycle;
  const speechLen = Math.round(0.45 * sampleRate);
  if (phase >= speechLen) return 0;

  const t = phase / sampleRate;
  const attack = Math.min(1, phase / Math.max(1, 0.03 * sampleRate));
  const release = Math.min(1, (speechLen - phase) / Math.max(1, 0.08 * sampleRate));
  const shape = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(attack, release));
  // ~4 Hz syllable amplitude modulation is what makes this score as speech on
  // a real VAD rather than as a steady tone.
  const syllable = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t);
  const env = shape * syllable;
  const voiced = 0.5 * Math.sin(2 * Math.PI * 180 * t) + 0.25 * Math.sin(2 * Math.PI * 360 * t);
  const breath = 0.35 * noiseAt(seed, i);
  return (voiced + breath) * env * 0.8;
}

function ascii(buf, offset, length) {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(buf[offset + i]);
  return out;
}

/** Minimal 16-bit PCM WAV reader -> mono Float32 frames (native rate). */
function readWavFile(filePath) {
  const buf = readFileSync(filePath);
  if (buf.length < 44 || ascii(buf, 0, 4) !== "RIFF" || ascii(buf, 8, 4) !== "WAVE") {
    throw new Error(`not a RIFF/WAVE file: ${filePath}`);
  }

  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = ascii(buf, offset, 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bitsPerSample: buf.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = { start, size };
      break;
    }
    offset = start + size + (size % 2); // RIFF chunks are word-aligned
  }

  if (!fmt || !data) throw new Error(`WAV is missing fmt/data chunks: ${filePath}`);
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error("file capture requires an uncompressed 16-bit PCM WAV");
  }
  if (!fmt.channels || fmt.channels < 1) throw new Error("WAV declares zero channels");

  const byteLen = Math.min(data.size, Math.max(0, buf.length - data.start));
  const totalSamples = Math.floor(byteLen / 2);
  const frames = new Float32Array(Math.floor(totalSamples / fmt.channels));
  for (let i = 0; i < frames.length; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      sum += buf.readInt16LE(data.start + (i * fmt.channels + c) * 2) / 32768;
    }
    frames[i] = sum / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, frames };
}

/**
 * @param {{ backend?: "simulated"|"file"|"native", source?: string, filePath?: string,
 *           sampleRate?: number, chunkMs?: number, seed?: number, pace?: "realtime"|"fast",
 *           durationMs?: number, onEnd?: () => void, onState?: Function,
 *           choice?: object, generation?: number, nativeHost?: object }} [options]
 * @returns {{ start: () => Promise<void>, stop: () => void|Promise<void>, onChunk: (cb: Function) => Function, info: () => object }}
 */
export function createCapture({
  backend = "simulated",
  source,
  filePath,
  sampleRate = SAMPLE_RATE,
  chunkMs = DEFAULT_CHUNK_MS,
  seed = 1,
  pace = "realtime",
  durationMs = DEFAULT_SIM_DURATION_MS,
  onEnd,
  onState,
  choice,
  generation,
  nativeHost,
} = {}) {
  if (chunkMs <= 0) throw new Error("chunkMs must be > 0");
  if (backend === "native" && nativeHost) {
    return createNativeCapture({ source, choice, generation, nativeHost, onEnd, onState });
  }

  const listeners = new Set();
  const subscribe = (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  const emit = (chunk) => {
    for (const cb of [...listeners]) {
      try {
        cb(chunk);
      } catch {
        // A consumer error must not kill the capture timer.
      }
    }
  };

  let timer = null;
  let started = false;
  let stopped = false;
  let ended = false;
  let info = { backend, source, sampleRate, chunkMs };
  // End-of-stream subscribers: the constructor callback plus anyone wired
  // later (the speech pipeline flushes + finalizes its gate from here).
  const endListeners = new Set(typeof onEnd === "function" ? [onEnd] : []);

  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimer();
    for (const cb of [...endListeners]) {
      try {
        cb();
      } catch {
        /* consumer callback */
      }
    }
  };

  function clearTimer() {
    if (timer !== null) {
      if (pace === "fast") clearTimeout(timer);
      else clearInterval(timer);
      timer = null;
    }
  }

  // "fast" emits on the macrotask queue (deterministic content, test-speed);
  // "realtime" paces at chunkMs like a device would.
  const schedule = (step) => {
    if (pace === "fast") {
      timer = setTimeout(function tick() {
        if (stopped) return;
        step();
        if (!stopped && !ended) timer = setTimeout(tick, 0);
      }, 0);
    } else {
      timer = setInterval(() => {
        if (stopped) return;
        step();
      }, chunkMs);
    }
  };

  const capture = {
    async start() {
      if (started) return;
      started = true;
      stopped = false;

      if (backend === "native") {
        throw new Error("native audio capture is unsupported on this platform");
      }

      if (backend === "simulated") {
        const rate = Math.max(1, Math.round(sampleRate));
        const chunkSamples = Math.max(1, Math.round((rate * chunkMs) / 1000));
        const limit = Math.max(chunkSamples, Math.round((rate * Math.max(0, durationMs)) / 1000));
        let produced = 0;
        info = { ...info, sampleRate: rate, seed, durationMs, ended: false };
        schedule(() => {
          const take = Math.min(chunkSamples, limit - produced);
          if (take <= 0) {
            finish();
            return;
          }
          const pcm = new Float32Array(take);
          for (let i = 0; i < take; i++) {
            pcm[i] = simulatedSample(seed, produced + i, rate);
          }
          const timestampMs = (produced / rate) * 1000;
          produced += take;
          emit({ pcm, sampleRate: rate, timestampMs });
          if (produced >= limit) finish();
        });
        return;
      }

      if (backend === "file") {
        if (!filePath) throw new Error("file capture requires filePath");
        const { sampleRate: rate, channels, frames } = readWavFile(filePath);
        const chunkSamples = Math.max(1, Math.round((rate * chunkMs) / 1000));
        const total = frames.length;
        let produced = 0;
        info = {
          ...info,
          filePath,
          sampleRate: rate,
          channels,
          totalFrames: total,
          durationMs: (total / rate) * 1000,
          ended: false,
        };
        schedule(() => {
          const take = Math.min(chunkSamples, total - produced);
          if (take <= 0) {
            finish();
            return;
          }
          const pcm = frames.slice(produced, produced + take);
          const timestampMs = (produced / rate) * 1000;
          produced += take;
          emit({ pcm, sampleRate: rate, timestampMs });
          if (produced >= total) finish();
        });
        return;
      }

      throw new Error(`unknown capture backend: ${backend}`);
    },

    stop() {
      stopped = true;
      clearTimer();
    },

    onChunk: subscribe,

    /** Additive: `(cb) -> unsub`, fired once when a finite source runs out. */
    onEnd(cb) {
      if (typeof cb !== "function") return () => {};
      endListeners.add(cb);
      return () => endListeners.delete(cb);
    },

    info() {
      return { ...info, ended };
    },
  };

  return capture;
}

/**
 * Linear-interpolation resampler to the 16 kHz wire rate. Output length is
 * round(input * 16000 / srcRate) so arbitrary device rates (44.1/48 kHz)
 * land on an exact, predictable frame count.
 *
 * Deliberately NOT the streaming resampler: this one-shot export is frozen
 * by its callers/tests (exact `round()` length and `src[i * ratio]` phase).
 * `createStreamingResampler` uses a windowed-sinc filter with fractional
 * carry, so aliasing its output here would change both the sample values and
 * the length contract. The speech pipeline uses the streaming resampler;
 * this export stays for one-shot callers only.
 * @param {Float32Array} input
 * @param {number} srcRate
 * @returns {Float32Array}
 */
export function resampleTo16kMono(input, srcRate) {
  if (!input || input.length === 0) return new Float32Array(0);
  if (!Number.isFinite(srcRate) || srcRate <= 0) {
    throw new Error(`invalid source sample rate: ${srcRate}`);
  }
  if (srcRate === SAMPLE_RATE && input instanceof Float32Array) return input;

  const ratio = SAMPLE_RATE / srcRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  const last = input.length - 1;

  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    if (i0 >= last) {
      out[i] = input[last];
      continue;
    }
    const frac = pos - i0;
    out[i] = input[i0] + (input[i0 + 1] - input[i0]) * frac;
  }
  return out;
}

/**
 * Float samples -> clamped little-endian-friendly PCM16.
 * @param {Float32Array} input
 * @returns {Int16Array}
 */
export function floatToPcm16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = input[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = Math.round(s < 0 ? s * 32768 : s * 32767);
  }
  return out;
}

/**
 * Wires capture -> resample -> VAD gate -> sink. Emits {type:"vad"|"audio"|
 * "error"} events for the UI/telemetry and calls sink.finalizeStream the
 * moment the gate closes an utterance, so ASR does not wait for silence.
 *
 * @param {object} options
 * @param {ReturnType<typeof createCapture>} options.capture
 * @param {{ probe: Function, initialState?: Function }|null} options.vad
 * @param {{ sendAudio: Function, finalizeStream: Function, hintStream?: Function }} options.sink
 *   hintStream(source, "pause"|"resume") is optional (additive): the gate's
 *   probable-end-of-turn hint, ~0.5 s ahead of finalize, for speculation.
 * @param {number|string} options.source
 * @param {Function} [options.log]
 * @param {number} [options.teardownTimeoutMs] bound on VAD drain during stop
 */
export function createSpeechPipeline({
  capture,
  vad,
  sink,
  source,
  log,
  teardownTimeoutMs = 2000,
} = {}) {
  const listeners = new Set();
  const emit = (event) => {
    for (const cb of [...listeners]) {
      try {
        cb(event);
      } catch {
        // One bad listener must not break the audio path.
      }
    }
  };
  const logEvent = (event) => {
    if (typeof log !== "function") return;
    try {
      log(event);
    } catch {
      /* logging is best-effort */
    }
  };

  let gate = null;
  let unsubCapture = null;
  let unsubEnd = null;
  let started = false;
  let stopped = false;
  let streamEnded = false;
  let resampler = null;
  let resamplerRate = null;
  // Audio forwarded since the last finalize: a gate that never detects
  // speech (VAD off, fail-open) never closes the segment on its own.
  let unfinalized = false;

  const forwardFrame = (frame) => {
    const pcm16 = floatToPcm16(frame);
    sink.sendAudio(source, pcm16);
    unfinalized = true;
    emit({ type: "audio", bytes: pcm16.byteLength });
  };

  const finalize = () => {
    unfinalized = false;
    try {
      sink.finalizeStream(source);
    } catch (err) {
      emit({ type: "error", error: err });
    }
  };

  // A hung probe must not pin Stop. The timeout resolves so teardown still
  // flushes the resampler tail and finalizes once.
  const settleWithin = (work, timeoutMs) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, timeoutMs);
      Promise.resolve(work).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  const flushResampler = () => {
    if (!resampler || !gate) return;
    const tail = resampler.flush();
    if (tail.length) gate.feed(tail);
  };

  /** End of stream: forward the held tail and close the open utterance. */
  const flushGate = () => {
    if (!gate || streamEnded) return;
    streamEnded = true;
    const speechDriven = !gate.bypass && !gate.failedOpen;
    // flush() forwards the held tail and fires onSpeechEnd -> finalize when
    // an utterance is live.
    gate.flush();
    // Pass-through / fail-open gates never see speech end, so finalize here
    // or the server waits out its silence timeout for nothing.
    if (!speechDriven && unfinalized) finalize();
  };

  const handleEnd = async () => {
    if (stopped || streamEnded) return;
    logEvent({ type: "capture.ended", source });
    // Let queued inference settle first so the gate's speech state (and
    // its onSpeechEnd) reflects every frame the source produced.
    try {
      await settleWithin(gate?.drain?.(), teardownTimeoutMs);
    } catch {
      /* drain is best effort */
    }
    if (stopped || streamEnded) return;
    try {
      flushResampler();
      await settleWithin(gate?.drain?.(), teardownTimeoutMs);
    } catch {
      /* drain is best effort */
    }
    if (stopped || streamEnded) return;
    flushGate();
  };

  const onSpeechStart = () => {
    emit({ type: "vad", speaking: true });
  };

  // Speculation-only signals: a failure here must never touch the audio path.
  const hint = (state) => {
    if (typeof sink.hintStream !== "function") return;
    try {
      sink.hintStream(source, state);
    } catch (err) {
      logEvent({ type: "vad.hint_error", error: err });
    }
  };

  const onSpeechEnd = () => {
    // Latency-critical: close the server-side ASR segment now.
    finalize();
    emit({ type: "vad", speaking: false });
  };

  const handleChunk = (chunk) => {
    try {
      if (!chunk) return;
      const rate = chunk.sampleRate ?? SAMPLE_RATE;
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`invalid source sample rate: ${rate}`);
      }
      const pcm = chunk.pcm;
      if (!pcm || pcm.length === 0) return;
      const discontinuity = Boolean(chunk.flags?.discontinuity || chunk.discontinuity);
      // A format change or a flagged gap must not reuse filter history.
      // Flush the previous tail first so that audio is not discarded.
      if (resampler && (discontinuity || resamplerRate !== rate)) {
        flushResampler();
        if (discontinuity && resamplerRate === rate) resampler.reset();
        else resampler = null;
      }
      if (!resampler) {
        resampler = createStreamingResampler({ inputRate: rate, outputRate: SAMPLE_RATE });
        resamplerRate = rate;
      }
      const mono = resampler.push(pcm instanceof Float32Array ? pcm : Float32Array.from(pcm));
      if (mono.length) gate.feed(mono);
    } catch (err) {
      logEvent({ type: "capture.error", error: err });
      emit({ type: "error", error: err });
    }
  };

  const pipeline = {
    async start() {
      if (started) return;
      started = true;
      stopped = false;

      // Accept either the frozen { probe, initialState } descriptor or a raw
      // SileroVad-like instance (which exposes process()).
      const probeFn =
        vad && typeof vad.probe === "function"
          ? vad.probe.bind(vad)
          : vad && typeof vad.process === "function"
            ? vad.process.bind(vad)
            : null;
      gate = new VadGate({
        probe: probeFn ? (frame, carry) => probeFn(frame, carry) : null,
        initialState:
          vad && typeof vad.initialState === "function" ? vad.initialState() : undefined,
        onSend: forwardFrame,
        onSpeechStart,
        onSpeechEnd,
        onSpeechPause: () => hint("pause"),
        onSpeechResume: () => hint("resume"),
        onFailedOpen: () => logEvent({ type: "vad.failed_open", source }),
        // No probe => straight pass-through (still framed at 512 samples).
        tunables: vad ? undefined : { ...VadConfig, enabled: false },
      });

      unsubCapture = capture.onChunk(handleChunk);
      streamEnded = false;
      unsubEnd = typeof capture.onEnd === "function" ? capture.onEnd(() => void handleEnd()) : null;
      try {
        await capture.start();
        logEvent({ type: "capture.started", source });
      } catch (err) {
        if (unsubCapture) {
          unsubCapture();
          unsubCapture = null;
        }
        if (unsubEnd) {
          unsubEnd();
          unsubEnd = null;
        }
        started = false;
        logEvent({ type: "capture.error", error: err });
        emit({ type: "error", error: err });
        throw err;
      }
    },

    async stop() {
      if (stopped || !started) return;
      stopped = true;
      if (unsubCapture) {
        unsubCapture();
        unsubCapture = null;
      }
      if (unsubEnd) {
        unsubEnd();
        unsubEnd = null;
      }
      try {
        // Native stop returns a Promise. Pipeline Stop stays pending until
        // that cleanup settles, then the resampler/VAD tail is flushed once.
        await capture.stop();
      } catch (err) {
        emit({ type: "error", error: err });
      }
      if (gate) {
        try {
          await settleWithin(gate.drain(), teardownTimeoutMs);
          flushResampler();
          await settleWithin(gate.drain(), teardownTimeoutMs);
        } catch (err) {
          emit({ type: "error", error: err });
        } finally {
          flushGate();
          gate.close();
        }
      }
      logEvent({ type: "capture.stopped", source });
    },

    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    // Additive: lets the desktop shell feed the VAD meter (vad:stats) without
    // reaching into the gate. Shape matches VadGate.stats().
    stats() {
      return gate ? gate.stats() : null;
    },
  };

  return pipeline;
}
