/**
 * Client-side VAD: Silero VAD (ONNX) plus a zero-dependency energy fallback,
 * wrapped in a gate that forwards only speech to the uplink.
 *
 * Why a gate at all: every non-speech frame crossing the wire costs bandwidth,
 * server CPU and — more importantly — answer latency inside the ASR segment.
 * The gate buys that back with a tiny local inference budget, and is built so
 * that a slow/broken inference path degrades to "forward everything" rather
 * than to "drop the user's voice".
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Frozen tunables — see docs/module-contracts.md (values must not drift). */
export const VadConfig = {
  enabled: true,
  frameSamples: 512, // 32 ms @ 16 kHz, Silero v5 fixed frame
  sampleRate: 16000,
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  redemptionFrames: 24, // ~0.77 s hangover
  preRollMs: 384,
  maxQueueFrames: 32,
  maxDroppedBeforeFailOpen: 64,
};

/**
 * Additive latency tunables (VadConfig above is frozen). All are overridable
 * through `tunables`.
 *
 * - pauseHintFrames: after this many sub-negative frames inside a live
 *   segment the gate raises a "probable end of turn" hint (onSpeechPause).
 *   22 frames = 704 ms. Answers are generated while the prospect talks but
 *   held off screen; this pause (plus, with a judge, Jev agreeing the
 *   prospect finished a question) is what shows them. At 256 ms a fast
 *   answer model showed answers mid-sentence. It is ONLY a hint:
 *   the segment still closes after the full 24-frame redemption, so a
 *   mid-thought pause can never split one question into two segments. If
 *   speech returns first, onSpeechResume retracts the hint. 0 disables it.
 * - dropWindowFrames: the 64-drop backlog budget counts drops inside this
 *   sliding window of audio (256 frames = 8.2 s) instead of for the whole
 *   call, so isolated main-loop bursts on a long call can no longer add up
 *   to a permanent fail-open. A hung detector still drops every frame and
 *   fails open after 64 drops, exactly as before.
 * - failOpenCooldownFrames: a BACKLOG fail-open re-arms gating after this
 *   much audio, provided the detector has gone idle (its last inference
 *   returned). A probe failure (exception / non-finite output) stays latched.
 * - fallbackNoiseFloorDb: while failed open, endpointing continues on a
 *   synchronous energy detector so finalize / hints keep flowing. Audio is
 *   still forwarded unconditionally; only the end-of-speech signal is kept.
 */
export const VadLatencyConfig = {
  pauseHintFrames: 22,
  dropWindowFrames: 256,
  failOpenCooldownFrames: 256,
  fallbackNoiseFloorDb: -55,
};

// Silero v5 keeps 64 samples of context glued in front of each 512-sample
// frame (576 model input) plus an LSTM state of [2,1,128]. `carry` packs both
// as a single Float32Array(320) so the frozen process(frame, carry) signature
// stays singular: [0..256) = LSTM state, [256..320) = context samples.
const LSTM_FLOATS = 2 * 1 * 128;
const CONTEXT_SAMPLES = 64;
const CARRY_FLOATS = LSTM_FLOATS + CONTEXT_SAMPLES;

const DEFAULT_MODEL_URL = new URL("../../third_party/silero_vad.onnx", import.meta.url);
const EMPTY_F32 = new Float32Array(0);

/**
 * Packaged apps keep native-loadable assets in app.asar.unpacked: Electron's fs
 * answers for the asar path, but onnxruntime's C++ reads the file directly and
 * needs the REAL filesystem path.
 */
function realAssetPath(path) {
  return path.includes("app.asar") ? path.replace("app.asar", "app.asar.unpacked") : path;
}

/**
 * Real Silero VAD via onnxruntime-node. `create()` is async because loading the
 * graph costs tens of ms — do it once at session launch, off the capture path.
 */
export class SileroVad {
  constructor({ session, ort, modelPath, sampleRate = VadConfig.sampleRate } = {}) {
    this.session = session;
    this.ort = ort;
    this.modelPath = modelPath;
    this.sampleRate = sampleRate;
    this.frameSamples = VadConfig.frameSamples;
    this.disposed = false;
  }

  /**
   * @param {{ modelPath?: string|URL }} [options]
   * @returns {Promise<SileroVad>}
   */
  static async create({ modelPath } = {}) {
    let ort;
    try {
      // Dynamic so this module stays importable (and testable) on machines
      // where the optional native runtime is missing.
      ort = await import("onnxruntime-node");
    } catch (err) {
      throw new Error(`onnxruntime-node is unavailable: ${err?.message ?? err}`);
    }

    const resolved = realAssetPath(
      modelPath instanceof URL
        ? fileURLToPath(modelPath)
        : modelPath
          ? String(modelPath)
          : fileURLToPath(DEFAULT_MODEL_URL),
    );

    if (!existsSync(resolved)) {
      throw new Error(`Silero VAD model not found at ${resolved}`);
    }

    // Single-threaded inference: the VAD shares the main process with
    // capture and IPC — an ORT thread pool fights them for cores and makes the
    // 32 ms frame cadence jitter.
    const session = await ort.InferenceSession.create(resolved, {
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    });
    const vad = new SileroVad({ session, ort, modelPath: resolved });

    // Warm the graph now so the first real utterance never pays JIT cost.
    await vad.process(new Float32Array(VadConfig.frameSamples), null);
    return vad;
  }

  /** Fresh state for a new stream. */
  initialState() {
    return new Float32Array(CARRY_FLOATS);
  }

  /**
   * @param {Float32Array} frame 512 samples @ 16 kHz
   * @param {Float32Array|null} [carry] packed state from the previous call
   * @returns {Promise<{ probability: number, nextState: Float32Array }>}
   */
  async process(frame, carry) {
    if (this.disposed) throw new Error("SileroVad has been disposed");
    if (!(frame instanceof Float32Array) || frame.length !== this.frameSamples) {
      throw new Error(`SileroVad.process expects Float32Array(${this.frameSamples})`);
    }

    const stateData = new Float32Array(LSTM_FLOATS);
    const context = new Float32Array(CONTEXT_SAMPLES);
    if (carry && carry.length >= CARRY_FLOATS) {
      stateData.set(carry.subarray(0, LSTM_FLOATS));
      context.set(carry.subarray(LSTM_FLOATS, CARRY_FLOATS));
    } else if (carry && carry.length >= LSTM_FLOATS) {
      stateData.set(carry.subarray(0, LSTM_FLOATS));
    }

    const input = new Float32Array(CONTEXT_SAMPLES + this.frameSamples);
    input.set(context, 0);
    input.set(frame, CONTEXT_SAMPLES);

    const feeds = {
      input: new this.ort.Tensor("float32", input, [1, CONTEXT_SAMPLES + this.frameSamples]),
      state: new this.ort.Tensor("float32", stateData, [2, 1, 128]),
      sr: new this.ort.Tensor("int64", BigInt64Array.from([BigInt(this.sampleRate)]), []),
    };

    const out = await this.session.run(feeds);
    // Validate the model outputs: a NaN probability must never reach
    // the hysteresis branch, and a truncated state would silently corrupt
    // every later frame. Throw so the gate fails open instead.
    const outputValue = out.output;
    const stateValue = out.stateN;
    if (!outputValue || !stateValue) {
      throw new Error("Silero VAD run returned no output/stateN tensor");
    }
    const probability = Number(outputValue.data[0]);
    const stateN = stateValue.data;
    if (!Number.isFinite(probability)) {
      throw new Error("Silero VAD returned an empty or non-finite probability");
    }
    if (stateN.length < LSTM_FLOATS) {
      throw new Error("Silero VAD returned a truncated stateN tensor");
    }

    // New context = tail of the current frame; the LSTM state flows through.
    const nextState = new Float32Array(CARRY_FLOATS);
    nextState.set(stateN.subarray(0, LSTM_FLOATS), 0);
    nextState.set(frame.subarray(this.frameSamples - CONTEXT_SAMPLES), LSTM_FLOATS);
    return { probability, nextState };
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.session && typeof this.session.release === "function") {
      await this.session.release();
    }
  }
}

/**
 * Dependency-free fallback with the exact SileroVad process() contract.
 * Probability is the frame energy mapped from `noiseFloorDb` to
 * `noiseFloorDb + 30 dB`, so the shared 0.5/0.35 thresholds behave sensibly.
 */
export class EnergyVad {
  constructor({ noiseFloorDb = -55, sampleRate = VadConfig.sampleRate } = {}) {
    this.noiseFloorDb = noiseFloorDb;
    this.sampleRate = sampleRate;
    this.frameSamples = VadConfig.frameSamples;
  }

  initialState() {
    // Energy VAD is stateless; carry is only mirrored for contract parity.
    return new Float32Array(0);
  }

  async process(frame, carry) {
    if (!(frame instanceof Float32Array) || frame.length === 0) {
      return { probability: 0, nextState: carry };
    }
    return { probability: energyProbability(frame, this.noiseFloorDb), nextState: carry };
  }
}

/**
 * Synchronous energy "probability": frame RMS mapped from `noiseFloorDb` to
 * `noiseFloorDb + 30 dB`. Shared by EnergyVad and the gate's fail-open
 * endpointing fallback (which must never await anything).
 * @param {Float32Array} frame
 * @param {number} [noiseFloorDb]
 */
export function energyProbability(frame, noiseFloorDb = -55) {
  if (!frame || frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-7)); // float32 noise floor ~-140 dB
  return Math.max(0, Math.min(1, (db - noiseFloorDb) / 30));
}

/**
 * Buffers arbitrary chunks into 512-sample frames, probes them asynchronously
 * and forwards speech. Silence is held in a pre-roll ring so the first ~384 ms
 * of an utterance (which necessarily precede its detection) still reach the
 * server. The hangover keeps mid-thought pauses from finalizing a segment.
 *
 * The pre-roll is measured against CLASSIFIED frames: frames still waiting for
 * inference are never discarded, so a burst of audio delivered after a
 * main-loop stall cannot push a not-yet-detected onset out of the ring.
 */
export class VadGate {
  /**
   * @param {object} options
   * @param {(frame: Float32Array, carry: any) => Promise<{probability:number,nextState:any}>} options.probe
   * @param {(frame: Float32Array) => void} [options.onSend]
   * @param {() => void} [options.onSpeechEnd]
   * @param {() => void} [options.onFailedOpen]
   * @param {() => void} [options.onSpeechStart]  additive convenience for the pipeline UI
   * @param {() => void} [options.onSpeechPause]  additive: probable end of turn (speculation only)
   * @param {() => void} [options.onSpeechResume] additive: speech returned after onSpeechPause
   * @param {any} [options.initialState]
   * @param {Partial<typeof VadConfig & typeof VadLatencyConfig>} [options.tunables]
   */
  constructor({
    probe,
    onSend,
    onSpeechEnd,
    onFailedOpen,
    onSpeechStart,
    onSpeechPause,
    onSpeechResume,
    initialState,
    tunables,
  } = {}) {
    const cfg = { ...VadConfig, ...VadLatencyConfig, ...(tunables ?? {}) };
    this.cfg = cfg;
    this.frameSamples = Math.max(1, cfg.frameSamples | 0);
    this.frameMs = (this.frameSamples / cfg.sampleRate) * 1000;
    // Round up-ish: at least one frame so a tiny preRollMs still buys context.
    this.preRollFrames = Math.max(1, Math.round(cfg.preRollMs / this.frameMs));
    // A hint at or beyond the closing hangover would be pointless.
    const hint = Math.max(0, cfg.pauseHintFrames | 0);
    this.pauseHintFrames = hint > 0 && hint < cfg.redemptionFrames ? hint : 0;

    this.probe = typeof probe === "function" ? probe : null;
    this.onSend = typeof onSend === "function" ? onSend : () => {};
    this.onSpeechEnd = typeof onSpeechEnd === "function" ? onSpeechEnd : () => {};
    this.onFailedOpen = typeof onFailedOpen === "function" ? onFailedOpen : () => {};
    this.onSpeechStart = typeof onSpeechStart === "function" ? onSpeechStart : () => {};
    this.onSpeechPause = typeof onSpeechPause === "function" ? onSpeechPause : () => {};
    this.onSpeechResume = typeof onSpeechResume === "function" ? onSpeechResume : () => {};

    this.carry =
      initialState ??
      (this.probe && typeof this.probe.initialState === "function" ? this.probe.initialState() : null);
    // Kept so a re-armed gate restarts the detector from a clean state.
    this.initialCarry = this.carry;

    this.bypass = cfg.enabled === false || !this.probe; // off / no probe => straight pass-through

    this.partial = EMPTY_F32;
    this.preRoll = []; // { frame, idx } held while not speaking
    this.queue = []; // { frame, idx } awaiting inference
    this.pumping = false;
    this.frameIdx = 0; // frames fed so far = audio clock in frames
    this.classifiedIdx = -1; // newest frame whose detection was applied

    this.speaking = false;
    this.negFrames = 0;
    this.pauseHinted = false;
    this.failedOpen = false;
    this.failOpenReason = null; // "backlog" | "probe"
    this.failOpenAt = 0;
    this.ended = false;
    this.closed = false;

    this.forwardedFrames = 0;
    this.gatedFrames = 0;
    this.droppedFrames = 0;
    this.recentDrops = []; // frameIdx of each drop inside dropWindowFrames
    this.lastError = null;
  }

  /**
   * Hot path. Never awaits inference: audio is forwarded/held synchronously so
   * capture timing is unaffected by ONNX scheduling.
   * @param {Float32Array} chunk any length
   */
  feed(chunk) {
    if (this.closed || this.ended || !chunk || chunk.length === 0) return;

    let data = chunk;
    if (this.partial.length) {
      data = new Float32Array(this.partial.length + chunk.length);
      data.set(this.partial, 0);
      data.set(chunk, this.partial.length);
    }

    let off = 0;
    while (off + this.frameSamples <= data.length) {
      // Copy because the held pre-roll may outlive the caller's buffer.
      const frame = data.slice(off, off + this.frameSamples);
      off += this.frameSamples;
      this._handleFrame(frame);
    }
    this.partial = off < data.length ? data.slice(off) : EMPTY_F32;
  }

  _handleFrame(frame) {
    const idx = this.frameIdx++;
    if (this.failedOpen) this._maybeRearm(idx);

    if (this.bypass) {
      this._forward(frame);
      return;
    }
    if (this.failedOpen) {
      // Failing open: forward unconditionally and stop spending CPU on model
      // probes. Endpointing continues on frame energy (synchronous, cannot
      // stall) so an utterance in progress still gets its onSpeechEnd ->
      // finalize instead of waiting on server-side silence timers forever.
      this._forward(frame);
      this._applyDetection(energyProbability(frame, this.cfg.fallbackNoiseFloorDb), idx);
      return;
    }

    if (this.speaking) {
      this._forward(frame);
    } else if (this.probe && this.queue.length >= this.cfg.maxQueueFrames) {
      // Backlog saturation: the detector cannot keep up, so stop
      // gating entirely — flush the held onset and forward this frame too.
      // Holding audio behind a stalled detector strands real speech; silence
      // sent by mistake is the cheaper error.
      this._flushPreRoll();
      this._forward(frame);
    } else {
      this.preRoll.push({ frame, idx });
      this._trimPreRoll();
    }
    this._enqueue(frame, idx);
  }

  /** Keep every unclassified frame plus `preRollFrames` of classified context. */
  _trimPreRoll() {
    const keepFrom = this.classifiedIdx - this.preRollFrames + 1;
    while (this.preRoll.length && this.preRoll[0].idx < keepFrom) {
      this.preRoll.shift();
      this.gatedFrames++;
    }
  }

  _flushPreRoll() {
    while (this.preRoll.length) this._forward(this.preRoll.shift().frame);
  }

  _forward(frame) {
    this.forwardedFrames++;
    try {
      this.onSend(frame);
    } catch (err) {
      this.lastError = err;
    }
  }

  _emit(callback) {
    try {
      callback();
    } catch (err) {
      this.lastError = err;
    }
  }

  _enqueue(frame, idx) {
    if (!this.probe) return;
    if (this.queue.length >= this.cfg.maxQueueFrames) {
      // Bounded backlog: drop the OLDEST detection (the newest audio matters
      // most for realtime state) and count it. The audio itself was already
      // forwarded or is held in the pre-roll, so nothing is lost on the wire.
      this.queue.shift();
      this._recordDrop(idx);
      if (this.failedOpen) {
        this.queue.length = 0;
        return;
      }
    }
    this.queue.push({ frame, idx });
    this._pump();
  }

  _recordDrop(idx, err) {
    if (err) this.lastError = err;
    this.droppedFrames++;
    // Windowed budget: only drops within the last dropWindowFrames of audio
    // count. Bursts after main-loop stalls are transient; a detector that is
    // actually stalled drops every frame and still trips this within 64.
    const window = Math.max(1, this.cfg.dropWindowFrames | 0);
    this.recentDrops.push(idx);
    while (this.recentDrops.length && this.recentDrops[0] <= idx - window) this.recentDrops.shift();
    if (!this.failedOpen && this.recentDrops.length >= this.cfg.maxDroppedBeforeFailOpen) {
      this._enterFailOpen("backlog");
    }
  }

  _enterFailOpen(reason) {
    this.failedOpen = true;
    this.failOpenReason = reason;
    this.failOpenAt = this.frameIdx;
    this.queue.length = 0;
    this.recentDrops.length = 0;
    // Nothing held may be stranded: forward the tail we were still gating.
    this._flushPreRoll();
    // A live segment keeps its speaking state; the energy fallback closes it.
    this.negFrames = 0;
    this._emit(this.onFailedOpen);
  }

  /**
   * A backlog fail-open is a cooldown, not a life sentence: once enough audio
   * has passed AND the detector has gone idle (its in-flight inference
   * returned, so it is demonstrably alive), gating resumes from a clean
   * detector state. Probe failures never re-arm.
   */
  _maybeRearm(idx) {
    if (this.failOpenReason !== "backlog" || this.pumping) return;
    if (idx - this.failOpenAt < Math.max(1, this.cfg.failOpenCooldownFrames | 0)) return;
    this.failedOpen = false;
    this.failOpenReason = null;
    this.carry = this.initialCarry;
    this.classifiedIdx = idx - 1;
    this.negFrames = 0;
  }

  _pump() {
    if (this.pumping || this.ended || this.closed || this.failedOpen || this.bypass) return;
    this.pumping = true;
    void (async () => {
      try {
        while (!this.ended && !this.closed && !this.failedOpen && this.queue.length) {
          const { frame, idx } = this.queue.shift();
          let result;
          try {
            result = await this.probe(frame, this.carry);
          } catch (err) {
            // A probe FAILURE is a broken detector, not one missed detection
            //: fail open on the FIRST error and stop probing. The 64
            // budget is for backlog drops only.
            this.lastError = err;
            if (!this.failedOpen) this._enterFailOpen("probe");
            else this.failOpenReason = "probe";
            return;
          }
          if (this.ended || this.closed || this.failedOpen) break;
          const probability = result?.probability;
          if (typeof probability !== "number" || !Number.isFinite(probability)) {
            // Malformed inference output is a detector failure too.
            this.lastError = new Error("VAD probe returned a non-finite probability");
            this._enterFailOpen("probe");
            return;
          }
          if (result.nextState !== undefined) this.carry = result.nextState;
          this._applyDetection(probability, idx);
        }
      } finally {
        this.pumping = false;
        if (!this.ended && !this.closed && !this.failedOpen && this.queue.length) this._pump();
      }
    })();
  }

  _applyDetection(probability, idx) {
    const pos = this.cfg.positiveSpeechThreshold;
    const neg = this.cfg.negativeSpeechThreshold;
    if (idx > this.classifiedIdx) this.classifiedIdx = idx;

    if (probability >= pos) {
      this.negFrames = 0;
      if (this.pauseHinted) {
        // The speaker kept going: retract the end-of-turn hint.
        this.pauseHinted = false;
        this._emit(this.onSpeechResume);
      }
      if (!this.speaking) {
        this.speaking = true;
        // Flush the held pre-roll FIRST: the onset that triggered this
        // detection sits somewhere in it, so dropping it would clip the word.
        this._flushPreRoll();
        this._emit(this.onSpeechStart);
      }
      return;
    }

    if (probability < neg) {
      if (this.speaking) {
        this.negFrames++;
        if (this.pauseHintFrames && this.negFrames === this.pauseHintFrames && !this.pauseHinted) {
          // Probable end of turn: lets the server speculate ~0.5 s before the
          // segment closes. Never closes anything itself.
          this.pauseHinted = true;
          this._emit(this.onSpeechPause);
        }
        if (this.negFrames >= this.cfg.redemptionFrames) {
          this.speaking = false;
          this.negFrames = 0;
          this.pauseHinted = false;
          this._emit(this.onSpeechEnd);
        }
      } else {
        this._trimPreRoll();
      }
      return;
    }

    // Hysteresis band (neg <= p < pos): keep a live segment alive, never start.
    // An outstanding pause hint stays outstanding: the band is not speech.
    this.negFrames = 0;
    if (!this.speaking) this._trimPreRoll();
  }

  /**
   * End of stream: forward whatever is still held and close a live segment so
   * the server can finalize ASR immediately instead of waiting for silence.
   */
  flush() {
    if (this.ended || this.closed) return;
    this.ended = true;
    this.queue.length = 0;
    this._flushPreRoll();
    // The trailing sub-frame remainder is real audio (often the last
    // syllable): forward it as a short frame instead of discarding it.
    if (this.partial.length) {
      const tail = this.partial;
      this.partial = EMPTY_F32;
      this._forward(tail);
    }
    if (this.speaking) {
      this.speaking = false;
      this.negFrames = 0;
      this.pauseHinted = false;
      this._emit(this.onSpeechEnd);
    }
  }

  close() {
    if (this.closed) return;
    // flush() first so a consumer that only calls close() does not lose the
    // held tail or the trailing onSpeechEnd.
    this.flush();
    this.closed = true;
    this.queue.length = 0;
    this.preRoll.length = 0;
    this.partial = EMPTY_F32;
  }

  stats() {
    // Keys match the gate stats surface in docs/module-contracts.md.
    return {
      forwarded: this.forwardedFrames,
      gated: this.gatedFrames,
      dropped: this.droppedFrames,
      speaking: this.speaking,
      failedOpen: this.failedOpen,
    };
  }

  /** Test/teardown helper: resolve once the inference backlog is drained. */
  async drain() {
    while (this.pumping || this.queue.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
