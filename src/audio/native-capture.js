/**
 * Adapts the native audio host to the capture interface used by the speech
 * pipeline. Listeners are attached by the caller before start(); this module
 * passes them into host.open so a packet emitted during start is not lost.
 *
 * The native host already normalizes packets, but this adapter is the last
 * boundary before the pipeline, so it guarantees the module contract
 * (`timestampMs` on the session's monotonic base) even for an injected host.
 */

import {
  deriveTimestampMs,
  isTerminalCaptureEvent,
  makeCodedError,
} from "../desktop/audio-capture-contract.js";

/**
 * @param {{ source?: string, choice?: object, generation?: number,
 *           nativeHost?: { open: Function }, onEnd?: Function, onState?: Function }} options
 */
export function createNativeCapture({
  source,
  choice,
  generation,
  nativeHost,
  onEnd,
  onState,
} = {}) {
  if (!nativeHost || typeof nativeHost.open !== "function") {
    throw new Error("native audio capture is unsupported on this platform");
  }
  if (source !== "microphone" && source !== "system") {
    throw makeCodedError("invalid-source", "native capture source must be microphone or system");
  }
  if (!Number.isInteger(generation) || generation < 0) {
    throw makeCodedError("invalid-generation", "native capture generation must be a non-negative integer");
  }

  const listeners = new Set();
  const endListeners = new Set(typeof onEnd === "function" ? [onEnd] : []);
  const stateListeners = new Set(typeof onState === "function" ? [onState] : []);

  let started = false;
  let stopped = false;
  let ended = false;
  let session = null;
  let startPromise = null;
  let info = { backend: "native", source, generation, ended: false };

  const emit = (chunk) => {
    for (const cb of [...listeners]) {
      try {
        cb(chunk);
      } catch {
        /* a consumer error must not kill capture */
      }
    }
  };

  const emitState = (state) => {
    for (const cb of [...stateListeners]) {
      try {
        cb(state);
      } catch {
        /* state is advisory */
      }
    }
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    info = { ...info, ended: true };
    for (const cb of [...endListeners]) {
      try {
        cb();
      } catch {
        /* consumer callback */
      }
    }
  };

  const sameGeneration = (value) => value === generation;

  async function openSession() {
    const opened = await nativeHost.open({
      source,
      choice,
      generation,
      onChunk: (chunk) => {
        if (stopped || ended) return;
        if (!chunk || !sameGeneration(chunk.generation)) return;
        // Contract shape: native-rate mono Float32 with timestampMs on the
        // capture time base; the raw QPC/sample fields stay as extras.
        emit({ ...chunk, timestampMs: deriveTimestampMs(chunk) });
      },
      onState: (state) => {
        if (state?.generation !== undefined && !sameGeneration(state.generation)) return;
        emitState(state);
        if (isTerminalCaptureEvent(state)) finish();
      },
    });
    session = opened;
    info = {
      backend: "native",
      source,
      generation,
      ...opened.info,
      ended,
    };
  }

  const capture = {
    async start() {
      if (stopped) throw new Error("native capture was stopped");
      if (started) return startPromise;
      started = true;
      startPromise = openSession();
      try {
        await startPromise;
      } catch (error) {
        started = false;
        startPromise = null;
        session = null;
        throw error;
      }
    },

    async stop() {
      stopped = true;
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          /* start() already rejected for the caller that awaited it */
        }
      }
      if (session && typeof session.stop === "function") {
        const closing = session;
        session = null;
        const result = await closing.stop();
        // Native stop reports overload drops/flushed samples; keep them on
        // info so the host can wire counters into diagnostics.
        if (result && typeof result === "object") {
          info = {
            ...info,
            ...(Number.isFinite(result.droppedSamples) ? { droppedSamples: result.droppedSamples } : {}),
            ...(Number.isFinite(result.flushedSamples) ? { flushedSamples: result.flushedSamples } : {}),
          };
        }
      }
    },

    onChunk(cb) {
      if (typeof cb !== "function") return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    onEnd(cb) {
      if (typeof cb !== "function") return () => {};
      endListeners.add(cb);
      return () => endListeners.delete(cb);
    },

    onState(cb) {
      if (typeof cb !== "function") return () => {};
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },

    info() {
      return { ...info, ended };
    },
  };

  return capture;
}
