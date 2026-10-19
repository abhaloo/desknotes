/**
 * Main-process owner of the native audio utility process.
 *
 * The renderer never sees the addon path or a native handle. This module
 * forks one fixed worker, checks the manifest before load, and drops any
 * packet that fails the contract. Stop has a hard deadline: a hung worker
 * is killed and every callback is revoked so a later packet cannot land
 * in a new session.
 */

import { isAbsolute } from "node:path";
import {
  AUDIO_SOURCES,
  HEALTH_HEARTBEAT_MS,
  QPC_TICKS_PER_MS,
  assertDeviceChoice,
  isTerminalCaptureEvent,
  makeCodedError,
  stripPrivate,
  validateNativeManifest,
  validateWorkerAudioEvent,
} from "./audio-capture-contract.js";
import { minimalWindowsEnv, readQpc100ns, sha256File, verifiedFile } from "./audio-capture-manifest.js";

/**
 * @param {{ utilityProcess: { fork: Function }, workerPath: string, addonPath: string,
 *           manifest: object, verifyAddonFile?: boolean, stopTimeoutMs?: number,
 *           startupTimeoutMs?: number, log?: Function }} options
 */
export function createNativeAudioHost({
  utilityProcess,
  workerPath,
  addonPath,
  manifest,
  verifyAddonFile = true,
  stopTimeoutMs = 2000,
  startupTimeoutMs = 5000,
  healthHeartbeatMs = HEALTH_HEARTBEAT_MS,
  nowQpc100ns = readQpc100ns,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log,
} = {}) {
  if (!utilityProcess || typeof utilityProcess.fork !== "function") {
    throw makeCodedError("invalid-host", "utilityProcess.fork is required");
  }
  if (!Number.isFinite(stopTimeoutMs) || stopTimeoutMs <= 0) {
    throw makeCodedError("invalid-host", "stopTimeoutMs must be > 0");
  }
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw makeCodedError("invalid-host", "startupTimeoutMs must be > 0");
  }
  if (!Number.isFinite(healthHeartbeatMs) || healthHeartbeatMs <= 0) {
    throw makeCodedError("invalid-host", "healthHeartbeatMs must be > 0");
  }

  // One monotonic origin for this host, i.e. this session. Every packet's
  // timestampMs is QPC capture time relative to it (never IPC arrival).
  const timeBaseQpc100ns = nowQpc100ns();

  const verifiedManifest = validateNativeManifest(manifest);
  const verifiedWorker = verifiedFile(workerPath, "worker path");
  let verifiedAddon = addonPath;
  if (verifyAddonFile) {
    verifiedAddon = verifiedFile(addonPath, "addon path");
    const actual = sha256File(verifiedAddon);
    if (actual !== verifiedManifest.sha256) {
      throw makeCodedError("hash-mismatch", "addon sha256 does not match the manifest");
    }
  } else if (typeof addonPath !== "string" || addonPath.includes("\0") || !isAbsolute(addonPath)) {
    throw makeCodedError("invalid-path", "addon path must be an absolute path");
  }

  const emitLog = (event) => {
    if (typeof log !== "function") return;
    try {
      log(event);
    } catch {
      /* logging is best-effort */
    }
  };

  let child = null;
  let startupTimer = null;
  let readySettled = false;
  let readyResolve = () => {};
  let readyReject = () => {};
  let nextId = 1;
  let hostClosed = false;
  let healthTimer = null;
  const pending = new Map();
  const sources = new Map();
  const workerExitListeners = new Set();
  const defaultListeners = new Set();
  const deviceLossListeners = new Set();

  const startup = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Construction does not await startup. A timeout or early exit must not
  // surface as an unhandled rejection; listDevices/open still observe it.
  startup.catch(() => {});

  function revokeSlot(slot) {
    if (!slot || slot.revoked) return;
    slot.revoked = true;
    slot.onChunk = () => {};
    slot.onState = () => {};
    if (sources.get(slot.source) === slot) sources.delete(slot.source);
    if (sources.size === 0) stopHealthTimer();
  }

  function revokeAllSlots() {
    for (const slot of [...sources.values()]) revokeSlot(slot);
    stopHealthTimer();
  }

  /**
   * Idle source health. A source that is open and quiet emits no audio, so
   * the host says so once per heartbeat instead of letting a silent source
   * look dead before its first packet.
   */
  function heartbeatTick() {
    const now = nowQpc100ns();
    for (const slot of [...sources.values()]) {
      if (slot.revoked) continue;
      const base = Number.isFinite(slot.lastPacketQpc100ns)
        ? slot.lastPacketQpc100ns
        : slot.openedAtQpc100ns;
      const ageMs = Math.max(0, (now - base) / QPC_TICKS_PER_MS);
      if (ageMs < healthHeartbeatMs) continue;
      try {
        slot.onState(
          stripPrivate({
            type: "health",
            source: slot.source,
            generation: slot.generation,
            state: "idle",
            lastPacketAgeMs: Math.round(ageMs),
          }),
        );
      } catch (error) {
        emitLog({ type: "audio-host.callback-error", source: slot.source, message: error.message });
      }
    }
  }

  function ensureHealthTimer() {
    if (healthTimer !== null) return;
    healthTimer = setIntervalFn(heartbeatTick, healthHeartbeatMs);
    // A heartbeat must not keep the process alive on its own.
    if (healthTimer && typeof healthTimer.unref === "function") healthTimer.unref();
  }

  function stopHealthTimer() {
    if (healthTimer === null) return;
    clearIntervalFn(healthTimer);
    healthTimer = null;
  }

  function fanout(listeners, value) {
    for (const cb of [...listeners]) {
      try {
        cb(value);
      } catch (error) {
        emitLog({ type: "audio-host.callback-error", message: error.message });
      }
    }
  }

  function subscribe(listeners, cb) {
    if (typeof cb !== "function") return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function notifyDeviceChange(slot, message) {
    const code = typeof message.code === "string" ? message.code : "";
    if (!isTerminalCaptureEvent(message)) return;
    const choice = slot.choice;
    const endpointId = typeof message.endpointId === "string" ? message.endpointId : undefined;
    if (choice?.kind === "default" && (code === "default_role_changed" || code === "endpoint_invalidated")) {
      fanout(defaultListeners, {
        source: slot.source,
        role: choice.role,
        endpointId,
        code,
        generation: slot.generation,
      });
      return;
    }
    fanout(deviceLossListeners, {
      source: slot.source,
      code: code || "endpoint_invalidated",
      reason: typeof message.reason === "string" ? message.reason : undefined,
      endpointId,
      generation: slot.generation,
      choice,
    });
  }

  function rejectPending(error) {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(error);
    }
  }

  function onExit(code) {
    const error = makeCodedError("worker-exit", `audio capture worker exited (${code})`);
    if (startupTimer) clearTimeout(startupTimer);
    stopHealthTimer();
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
    rejectPending(error);
    revokeAllSlots();
    emitLog({ type: "audio-host.worker-exit", code });
    fanout(workerExitListeners, error);
  }

  function ack(source) {
    if (!child || child.killed || !AUDIO_SOURCES.includes(source)) return;
    try {
      child.postMessage({ type: "ack", source, credits: 1 });
    } catch {
      /* worker already gone */
    }
  }

  function acceptAudio(message) {
    const slot = sources.get(message.source);
    if (!slot || slot.revoked) {
      ack(message.source);
      return;
    }
    let normalized;
    try {
      normalized = validateWorkerAudioEvent(message, {
        expectedSource: slot.source,
        expectedGeneration: slot.generation,
        nowQpc100ns: nowQpc100ns(),
        timeBaseQpc100ns,
      });
    } catch (error) {
      emitLog({
        type: "audio-host.packet-rejected",
        source: message.source,
        code: error.code,
        message: error.message,
      });
      ack(message.source);
      return;
    }
    try {
      slot.lastPacketQpc100ns = message.qpcTimestamp100ns;
      slot.onChunk(normalized);
    } catch (error) {
      emitLog({ type: "audio-host.callback-error", source: message.source, message: error.message });
    } finally {
      ack(message.source);
    }
  }

  function onMessage(message) {
    if (!message || typeof message !== "object" || hostClosed) return;
    if (message.type === "ready") {
      if (readySettled) return;
      readySettled = true;
      if (startupTimer) clearTimeout(startupTimer);
      readyResolve();
      emitLog({ type: "audio-host.ready" });
      return;
    }
    if (message.type === "init-error") {
      const error = makeCodedError(
        message.error?.code || "init-failed",
        message.error?.message || "audio worker rejected the addon",
      );
      if (!readySettled) {
        readySettled = true;
        if (startupTimer) clearTimeout(startupTimer);
        readyReject(error);
      }
      emitLog({ type: "audio-host.init-failed", code: error.code });
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      return;
    }
    if (message.type === "result") {
      const waiter = pending.get(message.requestId);
      if (!waiter) return;
      pending.delete(message.requestId);
      if (message.ok) waiter.resolve(stripPrivate(message.value));
      else {
        waiter.reject(
          makeCodedError(message.error?.code || "worker-error", message.error?.message || "audio worker request failed"),
        );
      }
      return;
    }
    if (message.type === "audio") {
      acceptAudio(message);
      return;
    }
    if (message.type === "state" || message.type === "error" || message.type === "device-change") {
      const slot = sources.get(message.source);
      if (!slot || slot.revoked) return;
      if (message.generation !== undefined && message.generation !== slot.generation) return;
      try {
        slot.onState(stripPrivate(message));
      } catch (error) {
        emitLog({ type: "audio-host.callback-error", source: message.source, message: error.message });
      }
      if (message.type === "device-change") notifyDeviceChange(slot, message);
    }
  }

  function request(type, fields = {}) {
    if (!child || child.killed) {
      return Promise.reject(makeCodedError("worker-exit", "audio capture worker is not running"));
    }
    const requestId = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      child.postMessage({ type, requestId, ...fields });
    });
  }

  function settleStop(work) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child?.kill();
        } catch {
          /* already gone */
        }
        revokeAllSlots();
        emitLog({ type: "audio-host.forced-cleanup" });
        resolve({ forcedCleanup: true });
      }, stopTimeoutMs);
      Promise.resolve(work).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value ?? { forcedCleanup: false });
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  child = utilityProcess.fork(verifiedWorker, [], {
    env: minimalWindowsEnv(),
    stdio: "ignore",
  });
  if (!child || typeof child.on !== "function" || typeof child.postMessage !== "function") {
    throw makeCodedError("invalid-host", "utilityProcess.fork did not return a worker");
  }
  child.on("message", (message) => {
    try {
      onMessage(message);
    } catch (error) {
      emitLog({ type: "audio-host.message-error", message: error.message });
    }
  });
  child.on("exit", onExit);
  startupTimer = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    const error = makeCodedError("startup-timeout", "audio capture worker startup timed out");
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    readyReject(error);
    emitLog({ type: "audio-host.startup-timeout" });
  }, startupTimeoutMs);
  child.postMessage({ type: "init", addonPath: verifiedAddon, manifest: verifiedManifest });
  emitLog({ type: "audio-host.spawned" });

  async function stopSource(slot) {
    let forced = false;
    try {
      if (!child || child.killed) {
        forced = true;
        return { forcedCleanup: true };
      }
      const result = await settleStop(request("stopSource", { source: slot.source, generation: slot.generation }));
      if (result?.forcedCleanup) forced = true;
      emitLog({ type: "audio-host.source-stopped", source: slot.source, forcedCleanup: Boolean(result?.forcedCleanup) });
      return result;
    } finally {
      if (forced) revokeAllSlots();
      else revokeSlot(slot);
    }
  }

  return {
    async listDevices(source) {
      if (!AUDIO_SOURCES.includes(source)) throw makeCodedError("invalid-source", "unrecognized audio source");
      await startup;
      return request("listDevices", { source });
    },

    async getCapabilities() {
      await startup;
      return request("getCapabilities", {});
    },

    async open({ source, choice, generation, onChunk, onState }) {
      if (!AUDIO_SOURCES.includes(source)) throw makeCodedError("invalid-source", "unrecognized audio source");
      const deviceChoice = assertDeviceChoice(choice);
      if (!Number.isInteger(generation) || generation < 0) {
        throw makeCodedError("invalid-generation", "unrecognized audio generation");
      }
      if (hostClosed) throw makeCodedError("closed", "audio host is closed");
      await startup;
      const existing = sources.get(source);
      if (existing && !existing.revoked) throw makeCodedError("source-busy", "audio source is already open");

      const slot = {
        source,
        generation,
        choice: deviceChoice,
        onChunk: typeof onChunk === "function" ? onChunk : () => {},
        onState: typeof onState === "function" ? onState : () => {},
        revoked: false,
        openedAtQpc100ns: nowQpc100ns(),
        lastPacketQpc100ns: null,
      };
      // Register before the worker message. A binding that emits the first
      // packet inside startSource must not race the callback table.
      sources.set(source, slot);
      ensureHealthTimer();
      try {
        const info = stripPrivate(
          await request("startSource", { source, choice: deviceChoice, generation }),
        );
        if (slot.revoked) {
          throw makeCodedError("cancelled", "audio source was cancelled during start");
        }
        emitLog({ type: "audio-host.source-started", source, generation });
        return {
          info,
          stop: () => stopSource(slot),
        };
      } catch (error) {
        revokeSlot(slot);
        throw error;
      }
    },

    async close() {
      if (hostClosed && (!child || child.killed)) return { forcedCleanup: false };
      hostClosed = true;
      let result = { forcedCleanup: false };
      try {
        if (child && !child.killed) {
          result = await settleStop(request("dispose", {}));
        } else {
          result = { forcedCleanup: true };
        }
      } catch (error) {
        try {
          child?.kill();
        } catch {
          /* already gone */
        }
        result = { forcedCleanup: true };
        emitLog({ type: "audio-host.close-failed", message: error.message });
      } finally {
        revokeAllSlots();
      }
      return { forcedCleanup: Boolean(result?.forcedCleanup) };
    },

    onWorkerExit(cb) {
      return subscribe(workerExitListeners, cb);
    },

    onDefaultDeviceChanged(cb) {
      return subscribe(defaultListeners, cb);
    },

    onDeviceLoss(cb) {
      return subscribe(deviceLossListeners, cb);
    },

    terminate() {
      hostClosed = true;
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      revokeAllSlots();
    },

    revokeAll() {
      revokeAllSlots();
    },
  };
}
