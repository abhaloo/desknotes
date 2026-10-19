import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  AUDIO_PACKET_KEYS,
  AUDIO_SOURCES,
  DEFAULT_ROLES,
  HEALTH_HEARTBEAT_MS,
  assertDeviceChoice,
  deriveTimestampMs,
  selectNativeAddonLocation,
  validateDeviceChoice,
  validateNativeManifest,
  validateWorkerAudioEvent,
} from "../src/desktop/audio-capture-contract.js";
import { createNativeAudioHost } from "../src/desktop/audio-capture-host.js";

const require = createRequire(import.meta.url);
const { createWorkerRuntime, startFromParentPort, CREDIT_LIMIT } = require(
  "../src/desktop/audio-capture-worker.cjs",
);

const FLAGS = Object.freeze({
  silent: false,
  discontinuity: false,
  timestampError: false,
  syntheticIdleSilence: false,
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestFor(bytes, patch = {}) {
  return {
    sha256: sha256(bytes),
    sourceDigest: "source-digest-1",
    apiVersion: 1,
    napiVersion: 8,
    arch: "x64",
    electronTarget: "33.4.11",
    ...patch,
  };
}

function nowQpc() {
  return Number(process.hrtime.bigint() / 100n);
}

function livePacket(overrides = {}) {
  const now = nowQpc();
  return {
    type: "audio",
    source: "microphone",
    generation: 1,
    endpointId: "ep-1",
    pcm: new Float32Array([0.1, -0.2, 0.3]),
    sampleRate: 48000,
    sampleIndex: 0,
    qpcTimestamp100ns: now,
    clockOriginQpc100ns: Math.max(0, now - 1000),
    flags: { ...FLAGS },
    sequence: 0,
    encoding: "float32",
    ...overrides,
  };
}

function installFakeUtility(handler) {
  const messageHandlers = [];
  const exitHandlers = [];
  let child = null;
  const emit = (message) => {
    for (const cb of [...messageHandlers]) cb(message);
  };
  const utilityProcess = {
    fork(workerPath, args, options) {
      child = {
        workerPath,
        args,
        options,
        killed: false,
        sent: [],
        postMessage(message) {
          child.sent.push(message);
          handler?.(message, { emit, child });
        },
        on(event, cb) {
          if (event === "message") messageHandlers.push(cb);
          if (event === "exit") exitHandlers.push(cb);
        },
        kill() {
          if (this.killed) return;
          this.killed = true;
          for (const cb of [...exitHandlers]) cb(1);
        },
      };
      return child;
    },
  };
  return {
    utilityProcess,
    emit,
    get child() {
      return child;
    },
    exit(code = 1) {
      if (child) child.killed = true;
      for (const cb of [...exitHandlers]) cb(code);
    },
  };
}

function readyHandler(extra) {
  return (message, ctx) => {
    if (message.type === "init") ctx.emit({ type: "ready" });
    extra?.(message, ctx);
  };
}

function withFiles(run) {
  const dir = mkdtempSync(join(tmpdir(), "p5-audio-host-"));
  const addonPath = join(dir, "audio_capture.node");
  const workerPath = join(dir, "worker.cjs");
  const bytes = Buffer.from("owned-addon");
  writeFileSync(addonPath, bytes);
  writeFileSync(workerPath, "/* worker fixture */\n");
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, addonPath, workerPath, bytes, manifest: manifestFor(bytes), cleanup };
}

/* ------------------------------ contract -------------------------------- */

test("packaged addon path is resources, not the repo build tree", () => {
  const packaged = selectNativeAddonLocation({
    isPackaged: true,
    resourcesPath: "C:\\app\\resources",
    moduleDir: "C:\\app\\resources\\app.asar\\src\\desktop",
  });
  assert.equal(packaged.addonPath, join("C:\\app\\resources", "audio_capture.node"));
  assert.equal(packaged.manifestPath, join("C:\\app\\resources\\app.asar\\src\\desktop", "native-audio-manifest.json"));
  assert.equal(packaged.addonPath.includes(`${join("native", "build", "Release")}`), false);

  const dev = selectNativeAddonLocation({
    isPackaged: false,
    resourcesPath: "C:\\electron\\resources",
    moduleDir: "C:\\repo\\src\\desktop",
  });
  assert.equal(dev.addonPath, join("C:\\repo", "native", "build", "Release", "audio_capture.node"));
  assert.equal(dev.addonPath.includes("electron"), false);

  const missingResources = selectNativeAddonLocation({
    isPackaged: true,
    resourcesPath: "",
    moduleDir: "C:\\repo\\src\\desktop",
  });
  assert.equal(missingResources.addonPath.includes(`${join("native", "build", "Release")}`), false);
});

test("device choice accepts an endpoint id or a default role", () => {
  assert.deepEqual([...AUDIO_SOURCES], ["microphone", "system"]);
  assert.deepEqual([...DEFAULT_ROLES], ["multimedia", "communications"]);
  assert.deepEqual(validateDeviceChoice({ kind: "endpoint", id: "ep-1" }), {
    ok: true,
    choice: { kind: "endpoint", id: "ep-1" },
  });
  assert.deepEqual(validateDeviceChoice({ kind: "default", role: "communications" }), {
    ok: true,
    choice: { kind: "default", role: "communications" },
  });
  assert.throws(() => assertDeviceChoice({ kind: "endpoint", id: "" }), /non-empty id/);
  assert.throws(() => assertDeviceChoice({ kind: "endpoint", id: "x".repeat(513) }), /non-empty id/);
  assert.throws(() => assertDeviceChoice({ kind: "default", role: "console" }), /multimedia or communications/);
  assert.throws(() => assertDeviceChoice({ kind: "loopback" }), /endpoint or default/);
  assert.throws(
    () => assertDeviceChoice({ kind: "endpoint", id: "ep-1", workerPath: "C:\\helper.js" }),
    /kind and id/,
  );
  assert.equal(validateDeviceChoice({ kind: "endpoint", id: "ep-1", extra: 1 }).ok, false);
});

test("native manifest locks api, napi, arch and electron target", () => {
  const manifest = manifestFor(Buffer.from("x"));
  assert.equal(validateNativeManifest(manifest).apiVersion, 1);
  assert.throws(() => validateNativeManifest({ ...manifest, apiVersion: 2 }), /apiVersion/);
  assert.throws(() => validateNativeManifest({ ...manifest, napiVersion: 7 }), /napiVersion/);
  assert.throws(() => validateNativeManifest({ ...manifest, arch: "ia32" }), /arch/);
  assert.throws(() => validateNativeManifest({ ...manifest, electronTarget: "28.0.0" }), /electronTarget/);
  assert.throws(() => validateNativeManifest({ ...manifest, sha256: "abcd" }), /sha256/);
  assert.throws(() => validateNativeManifest({ ...manifest, sourceDigest: "" }), /sourceDigest/);
});

test("native manifest carries build and test outcomes for diagnostics", () => {
  const manifest = manifestFor(Buffer.from("x"), {
    buildOutcome: { ok: true, at: "2026-10-14T00:00:00.000Z" },
    testOutcome: { ok: false, at: "2026-10-14T00:01:00.000Z" },
  });
  const validated = validateNativeManifest(manifest);
  assert.deepEqual(validated.buildOutcome, { ok: true, at: "2026-10-14T00:00:00.000Z" });
  assert.deepEqual(validated.testOutcome, { ok: false, at: "2026-10-14T00:01:00.000Z" });
  // Malformed evidence is dropped, not fatal: old manifests predate it.
  const malformed = validateNativeManifest({ ...manifest, testOutcome: { ok: "yes" } });
  assert.equal(malformed.testOutcome, undefined);
});

test("audio events reject bad source, generation, encoding, shape and age", () => {
  const now = 5_000_000;
  const good = {
    type: "audio",
    source: "microphone",
    generation: 2,
    endpointId: "ep-1",
    pcm: new Float32Array([0.25, -0.25]),
    sampleRate: 48000,
    sampleIndex: 0,
    qpcTimestamp100ns: now,
    clockOriginQpc100ns: now - 1000,
    flags: { ...FLAGS },
    sequence: 4,
    encoding: "float32",
  };
  const normalized = validateWorkerAudioEvent(good, {
    expectedSource: "microphone",
    expectedGeneration: 2,
    nowQpc100ns: now,
  });
  assert.ok(normalized.pcm instanceof Float32Array);
  assert.equal(normalized.pcm.length, 2);
  assert.notEqual(normalized.pcm, good.pcm);

  const bytes = Buffer.alloc(8);
  new Float32Array(bytes.buffer).set([0.5, -0.5]);
  const fromBuffer = validateWorkerAudioEvent({ ...good, pcm: bytes }, { nowQpc100ns: now });
  assert.ok(Math.abs(fromBuffer.pcm[0] - 0.5) < 1e-6);

  assert.throws(() => validateWorkerAudioEvent({ ...good, source: "speaker" }), /unrecognized audio source/);
  assert.throws(
    () => validateWorkerAudioEvent(good, { expectedGeneration: 9 }),
    /does not match the open generation/,
  );
  assert.throws(() => validateWorkerAudioEvent({ ...good, encoding: "pcm16" }), /unrecognized audio encoding/);
  assert.throws(() => validateWorkerAudioEvent({ ...good, pcm: new Float32Array(0) }), /packet length/);
  assert.throws(() => validateWorkerAudioEvent({ ...good, pcm: new Float32Array(8193) }), /packet length/);
  assert.throws(() => validateWorkerAudioEvent({ ...good, pcm: new Float32Array([NaN]) }), /finite/);
  assert.throws(() => validateWorkerAudioEvent({ ...good, sampleRate: 1000 }), /sampleRate/);
  assert.throws(() => validateWorkerAudioEvent({ ...good, sampleRate: 192001 }), /sampleRate/);
  assert.equal(
    validateWorkerAudioEvent({ ...good, sampleRate: 8000 }, { nowQpc100ns: now }).sampleRate,
    8000,
  );
  assert.equal(
    validateWorkerAudioEvent({ ...good, sampleRate: 192000 }, { nowQpc100ns: now }).sampleRate,
    192000,
  );
  assert.throws(() => validateWorkerAudioEvent({ ...good, sampleIndex: -1 }), /sampleIndex/);
  assert.throws(() => validateWorkerAudioEvent({ ...good, sequence: -1 }), /sequence/);
  assert.throws(
    () => validateWorkerAudioEvent({ ...good, flags: { ...FLAGS, silent: 1 } }),
    /silent/,
  );
  assert.throws(
    () =>
      validateWorkerAudioEvent(
        { ...good, qpcTimestamp100ns: 1, clockOriginQpc100ns: 0 },
        { nowQpc100ns: 1 + 200 * 10_000 + 1 },
      ),
    /age limit/,
  );
  assert.doesNotThrow(() =>
    validateWorkerAudioEvent(
      { ...good, qpcTimestamp100ns: 1, clockOriginQpc100ns: 0 },
      { nowQpc100ns: 1 + 200 * 10_000 },
    ),
  );
  assert.throws(
    () => validateWorkerAudioEvent({ ...good, qpcTimestamp100ns: 10, clockOriginQpc100ns: 20 }, { nowQpc100ns: 10 }),
    /precedes the capture clock origin/,
  );
});

test("timestampMs lands on the session monotonic base and raw QPC fields stay", () => {
  const base = 1_000_000;
  const event = {
    type: "audio",
    source: "microphone",
    generation: 2,
    endpointId: "ep-1",
    pcm: new Float32Array([0.25, -0.25]),
    sampleRate: 48000,
    sampleIndex: 0,
    qpcTimestamp100ns: base + 4_000_000,
    clockOriginQpc100ns: base + 1_000_000,
    flags: { ...FLAGS },
    sequence: 4,
    encoding: "float32",
  };
  const normalized = validateWorkerAudioEvent(event, { timeBaseQpc100ns: base });
  assert.equal(normalized.timestampMs, 400);
  assert.equal(normalized.qpcTimestamp100ns, event.qpcTimestamp100ns);
  assert.equal(normalized.clockOriginQpc100ns, event.clockOriginQpc100ns);
  assert.equal(normalized.sampleIndex, 0);
  for (const key of Object.keys(normalized)) assert.ok(AUDIO_PACKET_KEYS.includes(key), key);
  // Default base is the capture clock origin (adapter fallback).
  assert.equal(deriveTimestampMs(event), 300);
  assert.equal(deriveTimestampMs({ sampleIndex: 48000, sampleRate: 48000 }), 1000);
});

/* -------------------------------- host ---------------------------------- */

test("silent, discontinuity and timestamp-error flags reach the consumer", async () => {
  const files = withFiles();
  try {
    const chunks = [];
    const fake = installFakeUtility(
      readyHandler((message, ctx) => {
        if (message.type !== "startSource") return;
        ctx.emit(
          livePacket({
            source: message.source,
            generation: message.generation,
            flags: {
              silent: true,
              discontinuity: true,
              timestampError: true,
              syntheticIdleSilence: false,
            },
          }),
        );
        ctx.emit({
          type: "result",
          requestId: message.requestId,
          ok: true,
          value: { endpointId: "ep-1", generation: message.generation, sampleRate: 48000 },
        });
      }),
    );
    const host = createNativeAudioHost({
      utilityProcess: fake.utilityProcess,
      workerPath: files.workerPath,
      addonPath: files.addonPath,
      manifest: files.manifest,
      startupTimeoutMs: 200,
      stopTimeoutMs: 200,
    });
    await host.open({
      source: "microphone",
      choice: { kind: "endpoint", id: "ep-1" },
      generation: 1,
      onChunk: (chunk) => chunks.push(chunk),
    });
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].flags, {
      silent: true,
      discontinuity: true,
      timestampError: true,
      syntheticIdleSilence: false,
    });
    await host.close();
  } finally {
    files.cleanup();
  }
});

test("host stamps audio with timestampMs from the session monotonic base", async () => {
  const files = withFiles();
  try {
    const base = 500_000;
    const chunks = [];
    const fake = installFakeUtility(
      readyHandler((message, ctx) => {
        if (message.type !== "startSource") return;
        ctx.emit({
          type: "audio",
          source: message.source,
          generation: message.generation,
          endpointId: "ep-1",
          pcm: new Float32Array([0.1]),
          sampleRate: 48000,
          sampleIndex: 0,
          qpcTimestamp100ns: base + 250_000,
          clockOriginQpc100ns: base,
          flags: { ...FLAGS },
          sequence: 0,
          encoding: "float32",
        });
        ctx.emit({
          type: "result",
          requestId: message.requestId,
          ok: true,
          value: { endpointId: "ep-1", generation: message.generation, sampleRate: 48000, clockOriginQpc100ns: base },
        });
      }),
    );
    const host = createNativeAudioHost({
      utilityProcess: fake.utilityProcess,
      workerPath: files.workerPath,
      addonPath: files.addonPath,
      manifest: files.manifest,
      startupTimeoutMs: 200,
      stopTimeoutMs: 200,
      nowQpc100ns: () => base,
    });
    await host.open({
      source: "microphone",
      choice: { kind: "endpoint", id: "ep-1" },
      generation: 1,
      onChunk: (chunk) => chunks.push(chunk),
    });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].timestampMs, 25);
    assert.equal(chunks[0].qpcTimestamp100ns, base + 250_000);
    assert.equal(chunks[0].clockOriginQpc100ns, base);
    await host.close();
  } finally {
    files.cleanup();
  }
});

test("host heartbeats an open idle source before its first packet", async () => {
  const files = withFiles();
  try {
    let now = 1_000_000;
    let tick = null;
    let intervalMs = null;
    const cleared = [];
    const states = [];
    const fake = installFakeUtility(
      readyHandler((message, ctx) => {
        if (message.type !== "startSource") return;
        ctx.emit({
          type: "result",
          requestId: message.requestId,
          ok: true,
          value: { endpointId: "spk-1", generation: message.generation, sampleRate: 48000, clockOriginQpc100ns: now },
        });
      }),
    );
    const host = createNativeAudioHost({
      utilityProcess: fake.utilityProcess,
      workerPath: files.workerPath,
      addonPath: files.addonPath,
      manifest: files.manifest,
      startupTimeoutMs: 200,
      stopTimeoutMs: 40,
      nowQpc100ns: () => now,
      healthHeartbeatMs: 1000,
      setIntervalFn: (fn, ms) => {
        tick = fn;
        intervalMs = ms;
        return { unref() {} };
      },
      clearIntervalFn: (id) => cleared.push(id),
    });
    await host.open({
      source: "system",
      choice: { kind: "endpoint", id: "spk-1" },
      generation: 1,
      onChunk: () => {},
      onState: (state) => states.push(state),
    });
    assert.equal(HEALTH_HEARTBEAT_MS, 1000);
    assert.equal(intervalMs, 1000);
    now += 1000 * 10_000;
    tick();
    assert.equal(states.length, 1);
    assert.equal(states[0].type, "health");
    assert.equal(states[0].state, "idle");
    assert.equal(states[0].source, "system");
    assert.ok(states[0].lastPacketAgeMs >= 1000);

    // A fresh packet resets the age, so the next tick stays quiet.
    fake.emit({
      type: "audio",
      source: "system",
      generation: 1,
      endpointId: "spk-1",
      pcm: new Float32Array([0.1]),
      sampleRate: 48000,
      sampleIndex: 0,
      qpcTimestamp100ns: now,
      clockOriginQpc100ns: now - 1_000_000,
      flags: { ...FLAGS },
      sequence: 0,
      encoding: "float32",
    });
    tick();
    assert.equal(states.length, 1);

    await host.close();
    assert.ok(cleared.length >= 1, "heartbeat timer is cleared on close");
  } finally {
    files.cleanup();
  }
});

test("host rejects non-absolute and unverified addon or worker paths", () => {
  const files = withFiles();
  try {
    let forked = false;
    const utilityProcess = {
      fork() {
        forked = true;
      },
    };
    assert.throws(
      () =>
        createNativeAudioHost({
          utilityProcess,
          workerPath: "worker.cjs",
          addonPath: files.addonPath,
          manifest: files.manifest,
        }),
      /absolute path/,
    );
    assert.throws(
      () =>
        createNativeAudioHost({
          utilityProcess,
          workerPath: files.workerPath,
          addonPath: "audio_capture.node",
          manifest: files.manifest,
        }),
      /absolute path/,
    );
    assert.throws(
      () =>
        createNativeAudioHost({
          utilityProcess,
          workerPath: files.workerPath,
          addonPath: files.addonPath,
          manifest: { ...files.manifest, sha256: "ab".repeat(32) },
        }),
      /sha256/,
    );
    assert.equal(forked, false);
  } finally {
    files.cleanup();
  }
});

test("host forks a fixed worker with a minimal environment and no inspect flags", () => {
  const files = withFiles();
  const previousNode = process.env.NODE_OPTIONS;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousInspect = process.env.ELECTRON_RUN_AS_NODE;
  process.env.NODE_OPTIONS = "--inspect";
  process.env.OPENAI_API_KEY = "secret";
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    const fake = installFakeUtility(readyHandler());
    const host = createNativeAudioHost({
      utilityProcess: fake.utilityProcess,
      workerPath: files.workerPath,
      addonPath: files.addonPath,
      manifest: files.manifest,
      startupTimeoutMs: 200,
      stopTimeoutMs: 200,
    });
    assert.equal(fake.child.workerPath, realpathSync(files.workerPath));
    assert.deepEqual(fake.child.args, []);
    assert.equal(fake.child.options.stdio, "ignore");
    assert.equal(fake.child.options.env.NODE_OPTIONS, undefined);
    assert.equal(fake.child.options.env.OPENAI_API_KEY, undefined);
    assert.equal(fake.child.options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.notEqual(fake.child.options.env, process.env);
    const init = fake.child.sent.find((message) => message.type === "init");
    assert.equal(init.addonPath, realpathSync(files.addonPath));
    assert.equal(init.manifest.sha256, files.manifest.sha256);
    return host.close();
  } finally {
    if (previousNode === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNode;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousInspect === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previousInspect;
    files.cleanup();
  }
});

test("startup timeout and worker exit fail closed", async () => {
  const files = withFiles();
  try {
    const hung = installFakeUtility(() => {});
    const hungHost = createNativeAudioHost({
      utilityProcess: hung.utilityProcess,
      workerPath: files.workerPath,
      addonPath: files.addonPath,
      manifest: files.manifest,
      startupTimeoutMs: 40,
      stopTimeoutMs: 40,
    });
    await assert.rejects(() => hungHost.listDevices("microphone"), /startup timed out/);
    assert.equal(hung.child.killed, true);

    const crashed = installFakeUtility((message, ctx) => {
      if (message.type === "init") ctx.child.kill();
    });
    const crashedHost = createNativeAudioHost({
      utilityProcess: crashed.utilityProcess,
      workerPath: files.workerPath,
      addonPath: files.addonPath,
      manifest: files.manifest,
      startupTimeoutMs: 200,
      stopTimeoutMs: 40,
    });
    await assert.rejects(() => crashedHost.getCapabilities(), /worker exited/);
  } finally {
    files.cleanup();
  }
});

test("real host reports worker exit, device loss, and terminate", async () => {
  const files = withFiles();
  try {
    const fake = installFakeUtility(
      readyHandler((message, ctx) => {
        if (message.type === "startSource") {
          ctx.emit({
            type: "result",
            requestId: message.requestId,
            ok: true,
            value: { endpointId: "ep-1", generation: message.generation, sampleRate: 48000 },
          });
        }
      }),
    );
    const host = createNativeAudioHost({
      utilityProcess: fake.utilityProcess,
      workerPath: files.workerPath,
      addonPath: files.addonPath,
      manifest: files.manifest,
      startupTimeoutMs: 200,
      stopTimeoutMs: 40,
    });
    assert.equal(typeof host.terminate, "function");
    assert.equal(typeof host.revokeAll, "function");
    assert.equal(typeof host.onWorkerExit, "function");
    assert.equal(typeof host.onDeviceLoss, "function");
    assert.equal(typeof host.onDefaultDeviceChanged, "function");

    const exits = [];
    const losses = [];
    const defaults = [];
    host.onWorkerExit((error) => exits.push(error.code));
    host.onDeviceLoss((event) => losses.push(event));
    host.onDefaultDeviceChanged((event) => defaults.push(event));

    await host.open({
      source: "system",
      choice: { kind: "endpoint", id: "spk-a" },
      generation: 2,
      onChunk() {},
    });
    fake.emit({
      type: "device-change",
      source: "system",
      generation: 2,
      code: "endpoint_invalidated",
      reason: "invalidated",
      endpointId: "spk-a",
      terminal: true,
    });
    assert.equal(defaults.length, 0);
    assert.equal(losses.length, 1);
    assert.equal(losses[0].source, "system");
    assert.equal(losses[0].code, "endpoint_invalidated");
    assert.deepEqual(losses[0].choice, { kind: "endpoint", id: "spk-a" });

    await host.open({
      source: "microphone",
      choice: { kind: "default", role: "communications" },
      generation: 2,
      onChunk() {},
    });
    fake.emit({
      type: "device-change",
      source: "microphone",
      generation: 2,
      code: "default_role_changed",
      reason: "default-role",
      endpointId: "mic-2",
      terminal: true,
    });
    assert.equal(losses.length, 1);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].source, "microphone");
    assert.equal(defaults[0].role, "communications");

    fake.emit({
      type: "device-change",
      source: "microphone",
      generation: 2,
      code: "endpoint_invalidated",
      endpointId: "mic-2",
    });
    assert.equal(defaults.length, 2);
    assert.equal(defaults[1].role, "communications");
    assert.equal(losses.length, 1);

    let chunks = 0;
    host.revokeAll();
    fake.emit({
      type: "audio",
      source: "microphone",
      generation: 2,
      endpointId: "mic-2",
      pcm: new Float32Array([0.1]),
      sampleRate: 48000,
      sampleIndex: 0,
      qpcTimestamp100ns: nowQpc(),
      clockOriginQpc100ns: nowQpc() - 1000,
      flags: { ...FLAGS },
      sequence: 1,
      encoding: "float32",
    });
    assert.equal(chunks, 0);

    host.terminate();
    assert.equal(fake.child.killed, true);
    assert.deepEqual(exits, ["worker-exit"]);
  } finally {
    files.cleanup();
  }
});

test("open registers the callback before start and rejects bad packets", async () => {
  const files = withFiles();
  try {
    const chunks = [];
    const logs = [];
    const fake = installFakeUtility(
      readyHandler((message, ctx) => {
        if (message.type !== "startSource") return;
        ctx.emit(livePacket({ generation: message.generation, source: message.source }));
        ctx.emit(
          livePacket({
            generation: 99,
            source: message.source,
            sequence: 1,
          }),
        );
        ctx.emit(livePacket({ encoding: "pcm16", source: message.source, sequence: 2 }));
        ctx.emit(
          livePacket({
            source: message.source,
            sequence: 3,
            pcm: new Float32Array(8193),
          }),
        );
        ctx.emit(livePacket({ source: message.source, sequence: 4, sampleRate: 1000 }));
        ctx.emit(
          livePacket({
            source: message.source,
            sequence: 5,
            qpcTimestamp100ns: 1,
            clockOriginQpc100ns: 0,
          }),
        );
        ctx.emit({
          type: "result",
          requestId: message.requestId,
          ok: true,
          value: {
            handle: "NATIVE_PTR_0xDEAD",
            endpointId: "ep-1",
            endpointName: "Mic",
            generation: message.generation,
            sampleRate: 48000,
            nativeChannels: 1,
            encoding: "float32",
            clockOriginQpc100ns: 10,
          },
        });
      }),
    );
    const host = createNativeAudioHost({
      utilityProcess: fake.utilityProcess,
      workerPath: files.workerPath,
      addonPath: files.addonPath,
      manifest: files.manifest,
      startupTimeoutMs: 200,
      stopTimeoutMs: 200,
      log: (event) => logs.push(event),
    });
    const opened = await host.open({
      source: "microphone",
      choice: { kind: "default", role: "multimedia" },
      generation: 1,
      onChunk: (chunk) => chunks.push(chunk),
    });
    assert.equal(chunks.length, 1, "only the fresh matching packet is delivered");
    assert.equal(chunks[0].generation, 1);
    assert.equal(opened.info.handle, undefined);
    assert.equal(opened.info.endpointId, "ep-1");
    const start = fake.child.sent.find((message) => message.type === "startSource");
    assert.equal(start.choice.role, "multimedia");
    assert.ok(fake.child.sent.some((message) => message.type === "ack" && message.source === "microphone"));
    assert.ok(logs.some((event) => event.type === "audio-host.packet-rejected"));
    assert.ok(logs.some((event) => event.type === "audio-host.source-started"));
    await host.close();
  } finally {
    files.cleanup();
  }
});

test("a rejected stop still revokes callbacks", async () => {
  const files = withFiles();
  try {
    const chunks = [];
    let emitAudio = null;
    const fake = installFakeUtility(
      readyHandler((message, ctx) => {
        if (message.type === "startSource") {
          emitAudio = () => ctx.emit(livePacket({ generation: message.generation, source: message.source }));
          ctx.emit({
            type: "result",
            requestId: message.requestId,
            ok: true,
            value: {
              endpointId: "ep-1",
              generation: message.generation,
              sampleRate: 48000,
              nativeChannels: 1,
              encoding: "float32",
              clockOriginQpc100ns: 10,
            },
          });
        }
        if (message.type === "stopSource") {
          ctx.emit({
            type: "result",
            requestId: message.requestId,
            ok: false,
            error: { code: "stop-failed", message: "stop failed" },
          });
        }
      }),
    );
    const host = createNativeAudioHost({
      utilityProcess: fake.utilityProcess,
      workerPath: files.workerPath,
      addonPath: files.addonPath,
      manifest: files.manifest,
      startupTimeoutMs: 200,
      stopTimeoutMs: 200,
    });
    const opened = await host.open({
      source: "system",
      choice: { kind: "endpoint", id: "spk-1" },
      generation: 1,
      onChunk: (chunk) => chunks.push(chunk),
    });
    await assert.rejects(() => opened.stop(), /stop failed/);
    emitAudio();
    assert.equal(chunks.length, 0);
    await host.close();
  } finally {
    files.cleanup();
  }
});

test("stop and close kill a hung worker and report forced cleanup", async () => {
  const files = withFiles();
  try {
    const chunks = [];
    let emitAudio = null;
    const fake = installFakeUtility(
      readyHandler((message, ctx) => {
        if (message.type === "startSource") {
          emitAudio = () => ctx.emit(livePacket({ generation: message.generation, source: message.source }));
          ctx.emit({
            type: "result",
            requestId: message.requestId,
            ok: true,
            value: {
              endpointId: "ep-1",
              generation: message.generation,
              sampleRate: 16000,
              nativeChannels: 1,
              encoding: "float32",
              clockOriginQpc100ns: 4,
            },
          });
        }
      }),
    );
    const logs = [];
    const host = createNativeAudioHost({
      utilityProcess: fake.utilityProcess,
      workerPath: files.workerPath,
      addonPath: files.addonPath,
      manifest: files.manifest,
      startupTimeoutMs: 200,
      stopTimeoutMs: 40,
      log: (event) => logs.push(event),
    });
    const opened = await host.open({
      source: "microphone",
      choice: { kind: "endpoint", id: "ep-1" },
      generation: 1,
      onChunk: (chunk) => chunks.push(chunk),
    });
    const stopped = await opened.stop();
    assert.deepEqual(stopped, { forcedCleanup: true });
    assert.equal(fake.child.killed, true);
    emitAudio();
    assert.equal(chunks.length, 0);
    assert.ok(logs.some((event) => event.type === "audio-host.forced-cleanup"));

    const closingFake = installFakeUtility(readyHandler());
    const closingHost = createNativeAudioHost({
      utilityProcess: closingFake.utilityProcess,
      workerPath: files.workerPath,
      addonPath: files.addonPath,
      manifest: files.manifest,
      startupTimeoutMs: 200,
      stopTimeoutMs: 40,
    });
    const closed = await closingHost.close();
    assert.deepEqual(closed, { forcedCleanup: true });
    assert.equal(closingFake.child.killed, true);
  } finally {
    files.cleanup();
  }
});

test("listDevices round-trips after the worker is ready", async () => {
  const files = withFiles();
  try {
    const fake = installFakeUtility(
      readyHandler((message, ctx) => {
        if (message.type === "listDevices") {
          ctx.emit({
            type: "result",
            requestId: message.requestId,
            ok: true,
            value: [{ id: "ep-7", source: message.source, name: "Headset" }],
          });
        }
        if (message.type === "getCapabilities") {
          ctx.emit({
            type: "result",
            requestId: message.requestId,
            ok: true,
            value: { apiVersion: 1, supportsAec: false, handle: "hidden" },
          });
        }
      }),
    );
    const host = createNativeAudioHost({
      utilityProcess: fake.utilityProcess,
      workerPath: files.workerPath,
      addonPath: files.addonPath,
      manifest: files.manifest,
      startupTimeoutMs: 200,
      stopTimeoutMs: 200,
    });
    await assert.rejects(() => host.listDevices("speaker"), /unrecognized audio source/);
    const devices = await host.listDevices("system");
    assert.equal(devices[0].id, "ep-7");
    const caps = await host.getCapabilities();
    assert.equal(caps.supportsAec, false);
    assert.equal(caps.handle, undefined);
    await host.close();
  } finally {
    files.cleanup();
  }
});

/* ------------------------------- worker --------------------------------- */

function workerPacket(sequence) {
  return {
    type: "audio",
    source: "microphone",
    generation: 3,
    endpointId: "ep-9",
    pcm: new Float32Array([sequence, 0.5]),
    sampleRate: 48000,
    sampleIndex: sequence * 2,
    qpcTimestamp100ns: 1000 + sequence,
    flags: { ...FLAGS },
    sequence,
  };
}

test("worker checks the manifest, the five methods, and hides native handles", async () => {
  const files = withFiles();
  try {
    const posted = [];
    let loaded = false;
    let stoppedHandle = null;
    let emit = null;
    const binding = {
      getCapabilities() {
        return { apiVersion: 1, supportsAec: false };
      },
      listDevices(source) {
        return Promise.resolve([{ id: "ep-9", source }]);
      },
      startSource(_opts, onEvent) {
        emit = onEvent;
        for (let i = 0; i < 7; i++) onEvent(workerPacket(i));
        return Promise.resolve({
          handle: "NATIVE_PTR_0xDEAD",
          generation: 3,
          endpointId: "ep-9",
          endpointName: "Mic",
          sampleRate: 48000,
          nativeChannels: 2,
          encoding: "float32",
          clockOriginQpc100ns: 50,
        });
      },
      stopSource(handle) {
        stoppedHandle = handle;
        return Promise.resolve({ stopped: true, droppedSamples: 0, flushedSamples: 4 });
      },
      dispose() {
        return Promise.resolve();
      },
    };
    const runtime = createWorkerRuntime({
      parentPort: { postMessage: (message) => posted.push(message) },
      readFile: () => files.bytes,
      loadAddon: () => {
        loaded = true;
        return binding;
      },
    });
    runtime.handleMessage({
      type: "init",
      addonPath: files.addonPath,
      manifest: { ...files.manifest, napiVersion: 7 },
    });
    assert.equal(loaded, false);
    assert.equal(posted.at(-1).type, "init-error");

    posted.length = 0;
    runtime.handleMessage({
      type: "init",
      addonPath: "relative.node",
      manifest: files.manifest,
    });
    assert.equal(posted.at(-1).error.code, "invalid-path");

    posted.length = 0;
    const missing = createWorkerRuntime({
      parentPort: { postMessage: (message) => posted.push(message) },
      readFile: () => files.bytes,
      loadAddon: () => ({ ...binding, dispose: undefined }),
    });
    missing.handleMessage({ type: "init", addonPath: files.addonPath, manifest: files.manifest });
    assert.equal(posted.at(-1).error.code, "invalid-binding");
    assert.equal(missing.isReady(), false);

    posted.length = 0;
    const good = createWorkerRuntime({
      parentPort: { postMessage: (message) => posted.push(message) },
      readFile: () => files.bytes,
      loadAddon: () => binding,
    });
    good.handleMessage({ type: "startSource", requestId: 1, source: "microphone", generation: 3 });
    good.handleMessage({ type: "init", addonPath: files.addonPath, manifest: files.manifest });
    await tick();
    assert.equal(good.isReady(), true);
    const audio = posted.filter((message) => message.type === "audio");
    assert.equal(audio.length, CREDIT_LIMIT);
    assert.equal(CREDIT_LIMIT, 6);
    const result = posted.find((message) => message.type === "result" && message.requestId === 1);
    assert.equal(result.ok, true);
    assert.equal(result.value.handle, undefined);
    assert.equal(result.value.endpointId, "ep-9");
    assert.equal(audio[0].clockOriginQpc100ns, 50);
    assert.equal(JSON.stringify(posted).includes("NATIVE_PTR_0xDEAD"), false);

    good.handleMessage({ type: "ack", source: "microphone", credits: 1 });
    emit(workerPacket(8));
    const after = posted.filter((message) => message.type === "audio");
    assert.equal(after.length, 7);
    assert.equal(after[6].flags.discontinuity, true);

    emit({
      type: "device-change",
      source: "microphone",
      generation: 3,
      code: "endpoint_invalidated",
      reason: "invalidated",
      endpointId: "ep-9",
    });
    const loss = posted.find((message) => message.type === "device-change");
    assert.equal(loss.terminal, true);
    assert.equal(loss.code, "endpoint_invalidated");
    assert.equal(loss.reason, "invalidated");
    assert.equal(loss.endpointId, "ep-9");
    assert.equal(JSON.stringify(loss).includes("NATIVE_PTR_0xDEAD"), false);

    good.handleMessage({ type: "stopSource", requestId: 2, source: "microphone" });
    await tick();
    assert.equal(stoppedHandle, "NATIVE_PTR_0xDEAD");
    const stopped = posted.find((message) => message.requestId === 2);
    assert.equal(stopped.value.droppedSamples, 1);
    assert.equal(stopped.value.flushedSamples, 4);
    assert.equal(JSON.stringify(posted).includes("NATIVE_PTR_0xDEAD"), false);
  } finally {
    files.cleanup();
  }
});

test("worker parentPort unwraps event.data", () => {
  const files = withFiles();
  try {
    const posted = [];
    const listeners = [];
    const port = {
      postMessage(message) {
        posted.push(message);
      },
      on(_event, cb) {
        listeners.push(cb);
      },
    };
    startFromParentPort(port);
    listeners[0]({
      data: {
        type: "init",
        addonPath: files.addonPath,
        manifest: {
          apiVersion: 2,
          napiVersion: 8,
          arch: "x64",
          sha256: files.manifest.sha256,
        },
      },
    });
    assert.equal(posted.at(-1).type, "init-error");
    assert.equal(posted.at(-1).error.code, "invalid-manifest");
  } finally {
    files.cleanup();
  }
});
