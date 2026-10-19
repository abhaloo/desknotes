"use strict";

/**
 * Utility-process side of native audio capture.
 *
 * CommonJS on purpose: Electron forks this file as a script. The process
 * has no window and no provider credentials. Native handles stay in this
 * process; parent messages carry PCM and status only.
 */

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { isAbsolute } = require("node:path");
const {
  AUDIO_SOURCES,
  MAX_SAMPLES_PER_PACKET,
  audioPacket,
  coerceFloat32,
  isTerminalCaptureEvent,
  makeCodedError,
  normalizeFlags,
  stripPrivate,
} = require("./audio-capture-contract.cjs");

const METHODS = Object.freeze([
  "getCapabilities",
  "listDevices",
  "startSource",
  "stopSource",
  "dispose",
]);
const SOURCES = new Set(AUDIO_SOURCES);
const CREDIT_LIMIT = 6;

function createWorkerRuntime({ parentPort, loadAddon, readFile } = {}) {
  if (!parentPort || typeof parentPort.postMessage !== "function") {
    throw makeCodedError("invalid-port", "parentPort.postMessage is required");
  }
  const read = readFile || ((file) => readFileSync(file));
  const load = loadAddon || ((file) => require(file));

  let binding = null;
  let ready = false;
  const handles = new Map();
  const origins = new Map();
  const credits = { microphone: CREDIT_LIMIT, system: CREDIT_LIMIT };
  const overload = { microphone: 0, system: 0 };
  const armDiscontinuity = { microphone: false, system: false };
  const queue = [];

  function post(message) {
    parentPort.postMessage(stripPrivate(message));
  }

  function fail(requestId, code, message) {
    post({ type: "result", requestId, ok: false, error: { code, message } });
  }

  function verifyManifest(addonPath, manifest) {
    if (typeof addonPath !== "string" || !isAbsolute(addonPath) || addonPath.includes("\0")) {
      throw makeCodedError("invalid-path", "addon path must be an absolute path");
    }
    if (!manifest || typeof manifest !== "object") {
      throw makeCodedError("invalid-manifest", "addon manifest is required");
    }
    if (manifest.apiVersion !== 1) {
      throw makeCodedError("invalid-manifest", "addon apiVersion must be 1");
    }
    if (!(Number(manifest.napiVersion) >= 8)) {
      throw makeCodedError("invalid-manifest", "addon napiVersion must be >= 8");
    }
    if (manifest.arch !== "x64") {
      throw makeCodedError("invalid-manifest", "addon arch must be x64");
    }
    const bytes = read(addonPath);
    const actual = createHash("sha256").update(bytes).digest("hex");
    const expected = typeof manifest.sha256 === "string" ? manifest.sha256.toLowerCase() : "";
    if (!expected || actual !== expected) {
      throw makeCodedError("hash-mismatch", "addon sha256 does not match the manifest");
    }
  }

  function verifyBinding(loaded) {
    if (!loaded || typeof loaded !== "object") {
      throw makeCodedError("invalid-binding", "addon did not export a binding");
    }
    for (const name of METHODS) {
      if (typeof loaded[name] !== "function") {
        throw makeCodedError("invalid-binding", `addon is missing ${name}`);
      }
    }
  }

  function initialize(message) {
    try {
      verifyManifest(message.addonPath, message.manifest);
      const loaded = load(message.addonPath);
      verifyBinding(loaded);
      binding = loaded;
      ready = true;
      post({ type: "ready", apiVersion: 1 });
      while (queue.length) dispatch(queue.shift());
    } catch (error) {
      binding = null;
      ready = false;
      post({
        type: "init-error",
        error: { code: error.code || "init-failed", message: error.message || "addon init failed" },
      });
      while (queue.length) {
        const queued = queue.shift();
        if (queued && queued.requestId != null) {
          fail(queued.requestId, "not-ready", "addon failed to load");
        }
      }
    }
  }

  function deliverAudio(source, event) {
    let pcm = null;
    try {
      pcm = coerceFloat32(event.pcm);
    } catch {
      pcm = null;
    }
    if (!pcm || pcm.length < 1 || pcm.length > MAX_SAMPLES_PER_PACKET) {
      overload[source] += 1;
      armDiscontinuity[source] = true;
      return;
    }
    // Main has not returned a credit. Drop the packet and mark the next
    // one we do deliver so the speech path resets instead of gluing a gap.
    if ((credits[source] ?? 0) <= 0) {
      overload[source] += 1;
      armDiscontinuity[source] = true;
      return;
    }
    credits[source] -= 1;
    const flags = normalizeFlags({
      silent: Boolean(event.flags?.silent),
      discontinuity: Boolean(event.flags?.discontinuity) || armDiscontinuity[source],
      timestampError: Boolean(event.flags?.timestampError),
      syntheticIdleSilence: Boolean(event.flags?.syntheticIdleSilence),
    });
    armDiscontinuity[source] = false;
    post(
      audioPacket(event, {
        type: "audio",
        source: event.source || source,
        pcm,
        clockOriginQpc100ns:
          event.clockOriginQpc100ns != null ? event.clockOriginQpc100ns : origins.get(source),
        flags,
        encoding: "float32",
      }),
    );
  }

  function onNativeEvent(source, event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "audio" || event.pcm) {
      deliverAudio(source, event);
      return;
    }
    const code = typeof event.code === "string" ? event.code : undefined;
    const terminal = isTerminalCaptureEvent(event);
    post({
      type: event.type || "state",
      source,
      generation: event.generation,
      state: event.state,
      code,
      message: typeof event.message === "string" ? event.message : undefined,
      reason: typeof event.reason === "string" ? event.reason : undefined,
      endpointId: typeof event.endpointId === "string" ? event.endpointId : undefined,
      terminal,
    });
  }

  async function startSource(message) {
    if (!SOURCES.has(message.source)) {
      fail(message.requestId, "invalid-source", "unrecognized audio source");
      return;
    }
    if (!Number.isInteger(message.generation) || message.generation < 0) {
      fail(message.requestId, "invalid-generation", "unrecognized audio generation");
      return;
    }
    if (handles.has(message.source)) {
      fail(message.requestId, "source-busy", "audio source is already started");
      return;
    }
    // Reset the credit window before start. The binding may emit the first
    // packet synchronously, and that packet has to consume a real credit.
    credits[message.source] = CREDIT_LIMIT;
    armDiscontinuity[message.source] = false;
    overload[message.source] = 0;
    const buffered = [];
    let acceptLive = false;
    try {
      const info = await binding.startSource(
        { source: message.source, choice: message.choice, generation: message.generation },
        (event) => {
          // Hold packets that arrive before the start result so they can
          // carry the clock origin and still precede the result message.
          if (!acceptLive) buffered.push(event);
          else onNativeEvent(message.source, event);
        },
      );
      handles.set(message.source, info ? info.handle : undefined);
      if (info && Number.isFinite(info.clockOriginQpc100ns)) {
        origins.set(message.source, info.clockOriginQpc100ns);
      }
      acceptLive = true;
      for (const event of buffered) onNativeEvent(message.source, event);
      post({ type: "result", requestId: message.requestId, ok: true, value: stripPrivate(info) });
    } catch (error) {
      handles.delete(message.source);
      fail(message.requestId, error.code || "start-failed", error.message || "startSource failed");
    }
  }

  async function stopSource(message) {
    const source = message.source;
    if (!SOURCES.has(source)) {
      fail(message.requestId, "invalid-source", "unrecognized audio source");
      return;
    }
    const handle = handles.get(source);
    if (handle === undefined && !handles.has(source)) {
      post({
        type: "result",
        requestId: message.requestId,
        ok: true,
        value: { stopped: true, droppedSamples: overload[source] || 0, flushedSamples: 0 },
      });
      return;
    }
    try {
      const result = await binding.stopSource(handle);
      handles.delete(source);
      post({
        type: "result",
        requestId: message.requestId,
        ok: true,
        value: {
          stopped: true,
          droppedSamples: (result?.droppedSamples || 0) + (overload[source] || 0),
          flushedSamples: result?.flushedSamples || 0,
        },
      });
    } catch (error) {
      fail(message.requestId, error.code || "stop-failed", error.message || "stopSource failed");
    }
  }

  async function dispose(message) {
    try {
      if (binding && typeof binding.dispose === "function") await binding.dispose();
      handles.clear();
      binding = null;
      post({ type: "result", requestId: message.requestId, ok: true, value: { disposed: true } });
    } catch (error) {
      fail(message.requestId, error.code || "dispose-failed", error.message || "dispose failed");
    }
  }

  async function listDevices(message) {
    if (!SOURCES.has(message.source)) {
      fail(message.requestId, "invalid-source", "unrecognized audio source");
      return;
    }
    try {
      const devices = await binding.listDevices(message.source);
      post({ type: "result", requestId: message.requestId, ok: true, value: stripPrivate(devices) });
    } catch (error) {
      fail(message.requestId, error.code || "list-failed", error.message || "listDevices failed");
    }
  }

  async function getCapabilities(message) {
    try {
      const value = await binding.getCapabilities();
      post({ type: "result", requestId: message.requestId, ok: true, value: stripPrivate(value) });
    } catch (error) {
      fail(message.requestId, error.code || "capabilities-failed", error.message || "getCapabilities failed");
    }
  }

  function ack(message) {
    if (!SOURCES.has(message.source)) return;
    const returned = Number.isInteger(message.credits) ? message.credits : 1;
    if (returned <= 0) return;
    credits[message.source] = Math.min(CREDIT_LIMIT, (credits[message.source] || 0) + returned);
  }

  function dispatch(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "ack") {
      ack(message);
      return;
    }
    if (message.type === "startSource") {
      void startSource(message);
      return;
    }
    if (message.type === "stopSource") {
      void stopSource(message);
      return;
    }
    if (message.type === "dispose") {
      void dispose(message);
      return;
    }
    if (message.type === "listDevices") {
      void listDevices(message);
      return;
    }
    if (message.type === "getCapabilities") {
      void getCapabilities(message);
      return;
    }
    if (message.requestId != null) {
      fail(message.requestId, "unknown-message", "unrecognized worker message");
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (!ready) {
      if (message.type === "init") {
        initialize(message);
        return;
      }
      if (queue.length >= 32) queue.shift();
      queue.push(message);
      return;
    }
    dispatch(message);
  }

  return {
    handleMessage,
    isReady: () => ready,
  };
}

function startFromParentPort(port) {
  const runtime = createWorkerRuntime({ parentPort: port });
  port.on("message", (event) => {
    const message = event && typeof event === "object" && "data" in event ? event.data : event;
    runtime.handleMessage(message);
  });
  return runtime;
}

if (typeof process.parentPort !== "undefined" && process.parentPort) {
  startFromParentPort(process.parentPort);
}

module.exports = {
  createWorkerRuntime,
  startFromParentPort,
  CREDIT_LIMIT,
};
