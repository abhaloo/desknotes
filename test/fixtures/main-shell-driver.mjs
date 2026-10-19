/**
 * Boots the REAL src/desktop/main.mjs under Electron's Node runtime with a
 * fake `electron` module, then drives the IPC surface the way the preload
 * bridge does (`ipcRenderer.invoke` -> the gateway envelope). Prints one
 * `RESULT {...}` line for p5-main-wiring.test.js.
 *
 *   DRIVER_MODE=embedded  default config: in-app server, default capture backend
 *   DRIVER_MODE=external  external server (REALTIME_URL/JWT), simulated capture
 *   DRIVER_MODE=practice  practice wiring: external server whose engine can emit transcript frames
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsClient, WebSocketServer } from "ws";

register("./electron-loader.mjs", import.meta.url);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await delay(20);
  }
}

const mode = process.env.DRIVER_MODE ?? "embedded";
// Auto-start would start a session at boot and change every older mode's
// expectations: only the grounding/auto-start modes leave it on.
const GROUNDING_MODES = new Set(["grounding", "autostart-pref-off", "autostart-env-off", "autostart-fail"]);
if (!GROUNDING_MODES.has(mode)) process.env.COPILOT_AUTOSTART = "0";

const report = { mode, node: process.versions.node, globalWebSocket: typeof globalThis.WebSocket, steps: {} };
const step = (name, value) => {
  report.steps[name] = value;
};

let external = null;
if (mode === "external") {
  const { RealtimeServer } = await import("../../src/server/ws-server.js");
  const { createEngineFactory } = await import("../../src/server/engines/index.js");
  external = new RealtimeServer({
    port: 0,
    createEngine: createEngineFactory({}),
    verifyToken: (jwt) => jwt === "external-secret",
  });
  const { url } = await external.start();
  process.env.REALTIME_URL = url;
  process.env.JWT = "external-secret";
  process.env.CAPTURE_BACKEND = "simulated";
  process.env.VAD_ENABLED = "0";
}

let audioUserData = null;
if (mode === "audio-session") {
  globalThis.__COPILOT_SHELL_LIBRARY__ = true;
  const { RealtimeServer } = await import("../../src/server/ws-server.js");
  const { buildEngineConfig, createEngineFactory } = await import("../../src/server/engines/index.js");
  external = new RealtimeServer({
    port: 0,
    createEngine: createEngineFactory(buildEngineConfig(process.env, { mode: "demo" })),
    verifyToken: (jwt) => jwt === "external-secret",
  });
  const { url } = await external.start();
  process.env.REALTIME_URL = url;
  process.env.JWT = "external-secret";
  process.env.CAPTURE_BACKEND = "native";
  process.env.VAD_ENABLED = "0";
  process.env.EMBEDDED_SERVER = "0";
  audioUserData = mkdtempSync(join(tmpdir(), "audio-session-"));
}

let missingUserData = null;
if (mode === "audio-missing") {
  globalThis.__COPILOT_SHELL_LIBRARY__ = true;
  process.env.CAPTURE_BACKEND = "native";
  process.env.VAD_ENABLED = "0";
  process.env.EMBEDDED_SERVER = "0";
  missingUserData = mkdtempSync(join(tmpdir(), "audio-missing-"));
}

let practiceUserData = null;
let practiceSeen = null;
if (mode === "practice") {
  // Practice must drive its own realtime session (practice:start calls
  // startSession), so the external server is what the shell connects to. The
  // engine hands the driver an `emit` so a transcript frame can be injected
  // exactly the way the socket delivers one.
  globalThis.__COPILOT_SHELL_LIBRARY__ = true;
  process.env.CAPTURE_BACKEND = "simulated";
  process.env.VAD_ENABLED = "0";
  process.env.EMBEDDED_SERVER = "0";
  process.env.JWT = "external-secret";
  practiceUserData = mkdtempSync(join(tmpdir(), "practice-userdata-"));
  practiceSeen = { starts: [], emit: null };
  const { RealtimeServer } = await import("../../src/server/ws-server.js");
  const createEngine = ({ emit }) => {
    practiceSeen.emit = emit;
    return {
      onSessionStart(payload) {
        practiceSeen.starts.push(payload?.sessionId ?? null);
      },
      onAudio() {},
      onFinalize() {},
      onTurnHint() {},
      onContextSet() {},
      onSessionEnd() {},
      dispose() {},
    };
  };
  external = new RealtimeServer({ port: 0, createEngine, verifyToken: (jwt) => jwt === "external-secret" });
  const { url } = await external.start();
  process.env.REALTIME_URL = url;
}

let groundingUserData = null;
let groundingDocs = null;
let groundingSeen = null;
let lateServer = null;
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
if (GROUNDING_MODES.has(mode)) {
  globalThis.__COPILOT_SHELL_LIBRARY__ = true;
  process.env.CAPTURE_BACKEND = "simulated";
  process.env.VAD_ENABLED = "0";
  process.env.EMBEDDED_SERVER = "0";
  process.env.JWT = "external-secret";
  groundingUserData = mkdtempSync(join(tmpdir(), "grounding-userdata-"));
  groundingDocs = mkdtempSync(join(tmpdir(), "grounding-docs-"));
  writeFileSync(join(groundingDocs, "resume.md"), "# Pat Doe\r\n\r\nLed the Acme migration in 2021.\r\n");
  writeFileSync(join(groundingDocs, "big.md"), "a".repeat(30_001));
  groundingSeen = { starts: [], contexts: [] };
  const { RealtimeServer } = await import("../../src/server/ws-server.js");
  const createEngine = () => ({
    onSessionStart(payload) {
      groundingSeen.starts.push(payload?.sessionId ?? null);
    },
    onAudio() {},
    onFinalize() {},
    onTurnHint() {},
    onContextSet(payload) {
      groundingSeen.contexts.push(payload);
    },
    onSessionEnd() {},
    dispose() {},
  });
  const verifyToken = (jwt) => jwt === "external-secret";
  if (mode === "autostart-fail") {
    // Nothing listens yet: the boot-time start fails, then this server comes up.
    const port = await freePort();
    process.env.REALTIME_URL = `ws://127.0.0.1:${port}`;
    lateServer = () => new RealtimeServer({ port, createEngine, verifyToken });
  } else {
    external = new RealtimeServer({ port: 0, createEngine, verifyToken });
    const { url } = await external.start();
    process.env.REALTIME_URL = url;
  }
  if (mode === "autostart-env-off") process.env.COPILOT_AUTOSTART = "0";
  else delete process.env.COPILOT_AUTOSTART;
  if (mode === "autostart-pref-off") {
    writeFileSync(join(groundingUserData, "app-preferences.json"), JSON.stringify({ version: 1, autoStart: false }));
  }
}

const fake = await import("./fake-electron.mjs");
const mainModule = await import("../../src/desktop/main.mjs");
if (mode !== "audio-session" && !GROUNDING_MODES.has(mode)) {
  await waitFor(() => fake.ipcHandlers.has("session:start") && fake.BrowserWindow.getAllWindows().length > 0);
}

const firstWindow = () => fake.BrowserWindow.getAllWindows()[0].id;
const broadcasts = (channel, since = 0) =>
  fake.sent.filter((m) => m.windowId === firstWindow() && m.channel === channel && m.at >= since);
const practiceWindow = () =>
  fake.BrowserWindow.getAllWindows().find((win) => String(win.loaded?.path ?? "").endsWith("practice.html")) ?? null;
/** Fire the navigation pins main.mjs attached to `win`; true when every pin let `url` through. */
const navigationAllowed = (win, url) => {
  let prevented = false;
  const event = { preventDefault: () => (prevented = true) };
  for (const fn of win.webContents.listeners.get("will-navigate") ?? []) fn(event, url);
  return !prevented;
};
const practiceEvents = (since = 0) => {
  const win = practiceWindow();
  if (!win) return [];
  return fake.sent
    .filter((m) => m.windowId === win.id && m.channel === "practice:event" && m.at >= since)
    .map((m) => m.payload);
};
const frameTypes = (since = 0) =>
  broadcasts("speech:realtime-frame:received", since).map((m) => {
    try {
      return JSON.parse(m.payload).type;
    } catch {
      return null;
    }
  });

function rawUpgrade(port, origin) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`,
      );
    });
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      if (buf.includes("\r\n")) {
        resolve(Number(buf.split(" ")[1]));
        socket.destroy();
      }
    });
    socket.on("error", () => resolve(-1));
    setTimeout(() => resolve(0), 2000);
  });
}

async function helloWith(url, jwt, sessionId) {
  const socket = new WsClient(url);
  const frames = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data)).type));
  const code = await new Promise((resolve) => {
    socket.once("close", (c) => resolve(c));
    // A handshake refusal (no socket at all) reports its HTTP status.
    socket.once("unexpected-response", (_req, res) => resolve(res.statusCode));
    socket.on("error", () => resolve(-1));
    socket.once("open", () =>
      socket.send(JSON.stringify({ v: 1, type: "hello", jwt, session_id: sessionId, streams: [], last_seen_seq: 0 })),
    );
    setTimeout(() => resolve(0), 3000);
  });
  try {
    socket.terminate();
  } catch {
    /* gone */
  }
  return { code, frames };
}

function createFakeHost() {
  const calls = { open: [], list: [], terminate: 0, revoked: [], stop: 0, close: 0 };
  const sessions = [];
  let deny = {};
  let hangStop = false;
  let rejectStop = false;
  let deferOpen = false;
  const pendingOpens = [];
  let workerExitHandler = null;
  let defaultHandler = null;
  let deviceLossHandler = null;
  return {
    calls,
    sessions,
    setDeny(next) { deny = next ?? {}; },
    setHangStop(value) { hangStop = value; },
    setRejectStop(value) { rejectStop = value; },
    setDeferOpen(value) { deferOpen = value; },
    releaseOpens() {
      const waiting = pendingOpens.splice(0);
      for (const resolve of waiting) resolve();
    },
    onWorkerExit(cb) { workerExitHandler = cb; },
    emitWorkerExit(error) { workerExitHandler?.(error); },
    onDefaultDeviceChanged(cb) { defaultHandler = cb; },
    emitDefaultChange(event) { defaultHandler?.(event); },
    onDeviceLoss(cb) { deviceLossHandler = cb; },
    emitDeviceLoss(event) { deviceLossHandler?.(event); },
    revokeCallback(source) { calls.revoked.push(source); },
    terminate() { calls.terminate += 1; },
    async close() { calls.close += 1; return { forcedCleanup: false }; },
    async listDevices(source) {
      calls.list.push(source);
      if (source === "microphone") {
        return [{ id: "mic-1", name: "Mic One", source, isDefault: true, type: "input", channels: 1, sampleRate: 48000 }];
      }
      return [
        { id: "spk-a", name: "Speakers A", source, isDefault: true, type: "output", channels: 2, sampleRate: 48000 },
        { id: "spk-b", name: "Speakers B", source, isDefault: false, type: "output", channels: 2, sampleRate: 48000 },
      ];
    },
    async getCapabilities() {
      return { supportsAec: true };
    },
    async open({ source, choice, generation, onChunk }) {
      calls.open.push({ source, choice, generation });
      if (deferOpen) await new Promise((resolve) => pendingOpens.push(resolve));
      if (deny[source]) throw deny[source];
      const info = {
        endpointId: choice?.kind === "endpoint" ? choice.id : `default-${choice?.role ?? "role"}`,
        endpointName: choice?.kind === "endpoint" ? choice.id : `Default ${choice?.role ?? ""}`,
      };
      const session = {
        source,
        generation,
        onChunk,
        async stop() {
          calls.stop += 1;
          if (rejectStop) throw new Error("stop rejected");
          if (hangStop) await new Promise(() => {});
        },
        push(chunk) { onChunk?.({ generation: this.generation, sampleRate: 48000, ...chunk }); },
      };
      sessions.push(session);
      return { info, stop: () => session.stop() };
    },
  };
}

async function runAudioSession(desktop) {
  const helperRevoked = [];
  let helperResolved = false;
  try {
    await desktop.settleCaptureStop({
      pipeline: { async stop() { throw Object.assign(new Error("stop rejected"), { code: "stop-rejected" }); } },
      revoke() { helperRevoked.push("revoked"); },
    });
    helperResolved = true;
  } catch {
    helperResolved = false;
  }
  step("rejectedStopHelper", { revoked: helperRevoked.length === 1, resolved: helperResolved });
  step("engineMode", {
    native: desktop.captureEngineMode({}, "native"),
    simulated: desktop.captureEngineMode({}, "simulated"),
    override: desktop.captureEngineMode({ COPILOT_MODE: "demo" }, "native"),
  });

  const host = createFakeHost();
  await desktop.createMainShell({
    nativeHost: host,
    userDataDir: audioUserData,
    quitStopTimeoutMs: 40,
  });
  await waitFor(() => fake.ipcHandlers.has("audio:listDevices") && fake.BrowserWindow.getAllWindows().length > 0);

  const listed = await fake.invoke("audio:listDevices", { source: "system" });
  step("listDoesNotRecord", { ok: listed.ok, devices: listed.value?.length ?? 0, opens: host.calls.open.length });

  const badSource = await fake.invoke("audio:setDevice", { source: "camera", choice: { kind: "default", role: "multimedia" } });
  const saved = await fake.invoke("audio:setDevice", { source: "system", choice: { kind: "endpoint", id: "spk-a" } });
  const caps = await fake.invoke("audio:getCapabilities");
  const before = await fake.invoke("audio:getStatus");
  step("selectors", {
    badSource: badSource.error?.code ?? null,
    saved: saved.value ?? null,
    supportsAec: caps.value?.supportsAec ?? null,
    transcription: before.value?.transcription?.state ?? null,
    savedSystem: before.value?.preferences?.system?.choice ?? null,
  });

  const pathRejected = await fake.invoke("audio:exportDiagnostics", { path: "C:\\evil.json" });
  const exported = await fake.invoke("audio:exportDiagnostics", {});
  let diagnosticsPayload = null;
  try {
    diagnosticsPayload = JSON.parse(readFileSync(exported.value?.path, "utf8"));
  } catch {
    diagnosticsPayload = null;
  }
  step("diagnostics", {
    pathRejected: pathRejected.error?.code ?? null,
    bytes: exported.value?.bytes ?? null,
    underUserData: typeof exported.value?.path === "string" && exported.value.path.includes(audioUserData) && exported.value.path.includes("diagnostics"),
    payload: diagnosticsPayload,
  });

  host.setDeferOpen(true);
  const startPromise = fake.invoke("session:start", {});
  await waitFor(() => host.calls.open.length > 0);
  const endPromise = fake.invoke("session:end");
  await delay(30);
  host.releaseOpens();
  const cancelledStart = await startPromise;
  const cancelledEnd = await endPromise;
  const lateSession = host.sessions[0];
  lateSession?.push?.({ generation: 0, pcm: new Float32Array([0.2, 0.2]) });
  step("cancel", {
    startOk: cancelledStart.ok,
    endOk: cancelledEnd.ok,
    opens: host.calls.open.length,
    stops: host.calls.stop,
    generations: host.calls.open.map((item) => item.generation),
  });

  host.setDeferOpen(false);
  const opensBefore = host.calls.open.length;
  const started = await fake.invoke("session:start", {});
  await waitFor(() => host.calls.open.length >= opensBefore + 2, 5000);
  const statusAfterStart = await waitFor(async () => {
    const status = await fake.invoke("audio:getStatus");
    return status.value?.transcription?.state === "demo" ? status : null;
  }, 4000) ?? await fake.invoke("audio:getStatus");
  const systemOpen = host.calls.open.filter((item) => item.source === "system");
  const micOpen = host.calls.open.filter((item) => item.source === "microphone");
  step("selectedOpen", {
    speechOk: started.value?.speech?.ok ?? null,
    sources: started.value?.speech?.value?.sources ?? null,
    systemChoice: systemOpen.at(-1)?.choice ?? null,
    micChoice: micOpen.at(-1)?.choice ?? null,
    transcription: statusAfterStart.value?.transcription?.state ?? null,
  });

  const levelMark = Date.now();
  const liveSession = host.sessions.at(-1);
  for (let i = 0; i < 25; i += 1) {
    liveSession?.push?.({ pcm: new Float32Array(128).fill(0.2), sampleRate: 48000 });
  }
  const levelWindow = firstWindow();
  const levelBroadcasts = fake.sent.filter((item) => item.windowId === levelWindow && item.channel === "audio:status:changed" && item.at >= levelMark).length;
  step("levels", { broadcasts: levelBroadcasts });

  const conflict = await fake.invoke("audio:setDevice", { source: "system", choice: { kind: "endpoint", id: "spk-b" } });
  const systemOpensBefore = host.calls.open.filter((item) => item.source === "system").length;
  const micOpensBefore = host.calls.open.filter((item) => item.source === "microphone").length;
  host.emitDefaultChange({ source: "microphone", role: "communications", endpointId: "mic-2" });
  await waitFor(() => host.calls.open.filter((item) => item.source === "microphone").length > micOpensBefore, 3000);
  await delay(50);
  step("defaultPin", {
    conflict: conflict.error?.code ?? null,
    conflictType: conflict.error?.type ?? null,
    systemOpens: host.calls.open.filter((item) => item.source === "system").length - systemOpensBefore,
    micOpens: host.calls.open.filter((item) => item.source === "microphone").length - micOpensBefore,
  });

  const pinnedOpens = host.calls.open.filter((item) => item.source === "system").length;
  host.emitDeviceLoss({ source: "system", code: "endpoint_invalidated", endpointId: "spk-a" });
  const pinned = await waitFor(async () => {
    const status = await fake.invoke("audio:getStatus");
    return status.value?.sources?.system?.state === "failed" ? status.value : null;
  }, 3000);
  step("pinnedLoss", {
    code: pinned?.sources?.system?.error?.code ?? null,
    systemState: pinned?.sources?.system?.state ?? null,
    endpointId: pinned?.sources?.system?.endpointId ?? null,
    systemOpens: host.calls.open.filter((item) => item.source === "system").length - pinnedOpens,
    micState: pinned?.sources?.microphone?.state ?? null,
  });

  const deliveredBefore = (await fake.invoke("audio:getStatus")).value?.sources?.system?.delivered ?? 0;
  host.setRejectStop(true);
  await fake.invoke("speech:stop");
  host.sessions.at(-1)?.push?.({ generation: 99, pcm: new Int16Array([1000, 1000, 1000]) });
  const afterReject = await fake.invoke("audio:getStatus");
  step("rejectedStop", {
    revoked: host.calls.revoked.length,
    deliveredBefore,
    deliveredAfter: afterReject.value?.sources?.system?.delivered ?? 0,
    systemState: afterReject.value?.sources?.system?.state ?? null,
  });
  host.setRejectStop(false);

  host.emitWorkerExit({ code: "worker-exit" });
  await waitFor(async () => {
    const status = await fake.invoke("audio:getStatus");
    return status.value?.sources?.microphone?.state === "failed" && status.value?.sources?.system?.state === "failed";
  }, 3000);
  const faulted = await fake.invoke("audio:getStatus");
  step("workerExit", {
    microphone: faulted.value?.sources?.microphone?.error?.code ?? null,
    system: faulted.value?.sources?.system?.error?.code ?? null,
  });

  host.setDeny({
    microphone: Object.assign(new Error("denied"), { code: "E_ACCESSDENIED", hresult: "0x80070005" }),
  });
  const partialMic = await fake.invoke("speech:start");
  step("deniedMic", {
    ok: partialMic.ok,
    started: partialMic.value?.started ?? partialMic.error?.started ?? null,
    failed: partialMic.value?.failed ?? partialMic.error?.failed ?? null,
    sources: partialMic.value?.sources ?? null,
    message: partialMic.value?.failed?.[0]?.message ?? partialMic.error?.failed?.[0]?.message ?? null,
  });

  await fake.invoke("speech:stop");
  host.setDeny({
    system: Object.assign(new Error("invalid"), { code: "AUDCLNT_E_DEVICE_INVALIDATED" }),
  });
  const partialSystem = await fake.invoke("speech:start");
  step("invalidSystem", {
    ok: partialSystem.ok,
    started: partialSystem.value?.started ?? null,
    failed: partialSystem.value?.failed ?? null,
    sources: partialSystem.value?.sources ?? null,
  });

  await fake.invoke("speech:stop");
  host.setDeny({
    microphone: Object.assign(new Error("format"), { code: "AUDCLNT_E_UNSUPPORTED_FORMAT" }),
    system: Object.assign(new Error("hresult"), { code: "E_FAIL", hresult: "0x80004005" }),
  });
  const typed = await fake.invoke("speech:start");
  step("typedFailures", {
    codes: (typed.error?.failed ?? typed.value?.failed ?? []).map((item) => item.code),
    messages: (typed.error?.failed ?? typed.value?.failed ?? []).map((item) => item.message),
  });

  host.setDeny({});
  host.setHangStop(true);
  await fake.invoke("speech:start");
  const since = Date.now();
  fake.app.emit("before-quit", { preventDefault() {} });
  const forced = await waitFor(async () => {
    const status = await fake.invoke("audio:getStatus");
    return status.value?.cleanup?.forcedCleanup ? status.value : null;
  }, 3000);
  const levelBefore = fake.sent.filter((item) => item.channel === "audio:status:changed" && item.at >= since).length;
  const running = host.sessions.at(-1);
  for (let i = 0; i < 30; i += 1) running?.push?.({ generation: 0, pcm: new Int16Array([2000, 2000]) });
  const levelAfter = fake.sent.filter((item) => item.channel === "audio:status:changed" && item.at >= since).length;
  step("forcedCleanup", {
    forced: Boolean(forced?.cleanup?.forcedCleanup),
    terminated: host.calls.terminate,
    levelBroadcasts: Math.max(0, levelAfter - levelBefore),
  });
  try { external?.stop?.(); } catch { /* already stopped */ }
}

async function runAudioMissing(desktop) {
  await desktop.createMainShell({ userDataDir: missingUserData });
  await waitFor(() => fake.ipcHandlers.has("audio:listDevices") && fake.BrowserWindow.getAllWindows().length > 0);
  const listed = await fake.invoke("audio:listDevices", { source: "microphone" });
  const caps = await fake.invoke("audio:getCapabilities");
  step("missingAddon", {
    listOk: listed.ok,
    listCode: listed.error?.code ?? null,
    listValue: listed.value ?? null,
    capsOk: caps.ok,
    capsCode: caps.error?.code ?? null,
  });
}

async function runGrounding(desktop) {
  await desktop.createMainShell({ userDataDir: groundingUserData });
  await waitFor(() => fake.ipcHandlers.has("grounding:load") && fake.BrowserWindow.getAllWindows().length > 0);
  const started = await waitFor(() => groundingSeen.starts.length >= 1, 8000);
  const status = await fake.invoke("speech:getRealtimeStatus");
  step("autoStart", { started: Boolean(started), starts: groundingSeen.starts.length, lifecycle: status.value?.lifecycle ?? null });

  const empty = await fake.invoke("grounding:get");
  step("emptyDocument", { ok: empty.ok, document: empty.value?.document ?? null, readError: empty.value?.readError ?? null });

  fake.setDialogResult({ canceled: true, filePaths: [] });
  // A renderer-supplied path is ignored: only the dialog's choice is read.
  const cancelled = await fake.invoke("grounding:load", { path: join(groundingDocs, "resume.md") });
  await delay(100);
  step("cancelled", { ok: cancelled.ok, cancelled: cancelled.value?.cancelled ?? null, contexts: groundingSeen.contexts.length });

  fake.setDialogResult({ canceled: false, filePaths: [join(groundingDocs, "resume.md")] });
  const loaded = await fake.invoke("grounding:load");
  await waitFor(() => groundingSeen.contexts.length >= 1, 4000);
  const lastDialog = fake.dialogCalls.at(-1);
  step("loaded", {
    ok: loaded.ok,
    document: loaded.value?.document ?? null,
    applied: loaded.value?.applied ?? null,
    textLeaked: JSON.stringify(loaded).includes("Acme"),
    context: groundingSeen.contexts[0] ?? null,
    dialogHasParent: lastDialog?.hasParent ?? null,
    filters: lastDialog?.options?.filters ?? null,
  });

  fake.setDialogResult({ canceled: false, filePaths: [join(groundingDocs, "big.md")] });
  const tooBig = await fake.invoke("grounding:load");
  const afterBig = await fake.invoke("grounding:get");
  step("tooBig", { ok: tooBig.ok, code: tooBig.error?.code ?? null, message: tooBig.error?.message ?? null, kept: afterBig.value?.document?.name ?? null });

  await fake.invoke("session:end");
  const beforeRestart = groundingSeen.contexts.length;
  const restarted = await fake.invoke("session:start", {});
  await waitFor(() => groundingSeen.contexts.length > beforeRestart, 4000);
  step("resentOnStart", { ok: restarted.ok, context: groundingSeen.contexts.at(-1) ?? null });

  const beforeClear = groundingSeen.contexts.length;
  const cleared = await fake.invoke("grounding:clear");
  await waitFor(() => groundingSeen.contexts.length > beforeClear, 4000);
  const afterClear = await fake.invoke("grounding:get");
  step("cleared", {
    ok: cleared.ok,
    context: groundingSeen.contexts.at(-1) ?? null,
    document: afterClear.value?.document ?? null,
    fileGone: !existsSync(join(groundingUserData, "grounding-document.json")),
  });

  // "Open settings folder": main opens userData itself; a failure comes back coded.
  const opened = await fake.invoke("settings:openFolder");
  fake.setOpenPathResult("Failed to open path");
  const openFailed = await fake.invoke("settings:openFolder");
  fake.setOpenPathResult("");
  step("openFolder", {
    ok: opened.ok,
    path: opened.value?.path ?? null,
    calls: [...fake.openPathCalls],
    expected: groundingUserData,
    failCode: openFailed.error?.code ?? null,
    failMessage: openFailed.error?.message ?? null,
  });

  const settings = await fake.invoke("settings:get");
  const badSet = await fake.invoke("settings:set", { autoStart: "no" });
  const goodSet = await fake.invoke("settings:set", { autoStart: false });
  let stored = null;
  try {
    stored = JSON.parse(readFileSync(join(groundingUserData, "app-preferences.json"), "utf8"));
  } catch {
    stored = null;
  }
  step("settings", { initial: settings.value ?? null, badCode: badSet.error?.code ?? null, saved: goodSet.value ?? null, stored });

  // Answer model: a listed DeepSeek id persists beside autoStart; an invented id is refused.
  const modelSet = await fake.invoke("settings:set", { answerModel: "deepseek-flash" });
  const modelBad = await fake.invoke("settings:set", { answerModel: "deepseek-v4.1" });
  const readStored = () => JSON.parse(readFileSync(join(groundingUserData, "app-preferences.json"), "utf8"));
  step("answerModel", { saved: modelSet.value ?? null, badCode: modelBad.error?.code ?? null, stored: readStored() });

  // Rep context ("Use what I say in answers"): a boolean persists; anything else is refused.
  const repOff = await fake.invoke("settings:set", { repContext: false });
  const repBad = await fake.invoke("settings:set", { repContext: "off" });
  const repStoredOff = readStored();
  const repOn = await fake.invoke("settings:set", { repContext: true });
  step("repContext", {
    off: repOff.value?.repContext ?? null,
    badCode: repBad.error?.code ?? null,
    storedOff: repStoredOff,
    on: repOn.value?.repContext ?? null,
    settings: (await fake.invoke("settings:get")).value?.repContext ?? null,
  });

  // Highlights ("Highlight key phrases"): a boolean persists; anything else is refused.
  const hlOff = await fake.invoke("settings:set", { highlights: false });
  const hlBad = await fake.invoke("settings:set", { highlights: "off" });
  const hlStoredOff = readStored();
  const hlOn = await fake.invoke("settings:set", { highlights: true });
  step("highlights", {
    off: hlOff.value?.highlights ?? null,
    badCode: hlBad.error?.code ?? null,
    storedOff: hlStoredOff,
    on: hlOn.value?.highlights ?? null,
    settings: (await fake.invoke("settings:get")).value?.highlights ?? null,
  });

  // Answer cards ("Short answer cards"): a boolean persists; anything else is refused.
  const acOff = await fake.invoke("settings:set", { answerCards: false });
  const acBad = await fake.invoke("settings:set", { answerCards: "off" });
  const acStoredOff = readStored();
  const acOn = await fake.invoke("settings:set", { answerCards: true });
  step("answerCards", {
    off: acOff.value?.answerCards ?? null,
    badCode: acBad.error?.code ?? null,
    storedOff: acStoredOff,
    on: acOn.value?.answerCards ?? null,
    settings: (await fake.invoke("settings:get")).value?.answerCards ?? null,
  });

  // Explain terms: a boolean persists; anything else is refused.
  const glOff = await fake.invoke("settings:set", { glossary: false });
  const glBad = await fake.invoke("settings:set", { glossary: "off" });
  const glStoredOff = readStored();
  const glOn = await fake.invoke("settings:set", { glossary: true });
  step("glossary", {
    off: glOff.value?.glossary ?? null,
    badCode: glBad.error?.code ?? null,
    storedOff: glStoredOff,
    on: glOn.value?.glossary ?? null,
    settings: (await fake.invoke("settings:get")).value?.glossary ?? null,
  });

  // known-terms.txt: seeded empty at boot; "Known terms…" opens it, recreating a deleted file first.
  const knownTermsFile = join(groundingUserData, "known-terms.txt");
  const knownSeeded = existsSync(knownTermsFile) ? readFileSync(knownTermsFile, "utf8") : null;
  const knownCallsBefore = fake.openPathCalls.length;
  const knownOpened = await fake.invoke("settings:openKnownTerms");
  rmSync(knownTermsFile, { force: true });
  fake.setOpenPathResult("Failed to open path");
  const knownFailed = await fake.invoke("settings:openKnownTerms");
  fake.setOpenPathResult("");
  step("knownTerms", {
    seeded: knownSeeded,
    expected: knownTermsFile,
    settingsPath: (await fake.invoke("settings:get")).value?.knownTermsPath ?? null,
    ok: knownOpened.ok,
    path: knownOpened.value?.path ?? null,
    calls: fake.openPathCalls.slice(knownCallsBefore),
    recreated: existsSync(knownTermsFile) ? readFileSync(knownTermsFile, "utf8") : null,
    failCode: knownFailed.error?.code ?? null,
    failMessage: knownFailed.error?.message ?? null,
  });

  // Window opacity: live without persist, saved on persist, clamped, shared by settings:get and window:getState.
  const opacityLive = await fake.invoke("window:setOpacity", { opacity: 0.6 });
  const storedAfterLive = readStored();
  const opacitySaved = await fake.invoke("window:setOpacity", { opacity: 0.1, persist: true });
  const opacityBad = await fake.invoke("window:setOpacity", { opacity: "0.5" });
  const opacitySettings = await fake.invoke("settings:get");
  const opacityState = await fake.invoke("window:getState");
  step("windowOpacity", {
    live: opacityLive.value ?? null,
    storedAfterLive,
    saved: opacitySaved.value ?? null,
    badCode: opacityBad.error?.code ?? null,
    settings: opacitySettings.value?.windowOpacity ?? null,
    state: opacityState.value?.windowOpacity ?? null,
    stored: readStored(),
  });
  await fake.invoke("window:setOpacity", { opacity: 1, persist: true });

  // The prompt file is seeded next to app-preferences.json.
  const instructionsFile = join(groundingUserData, "answer-instructions.txt");
  step("instructions", {
    exists: existsSync(instructionsFile),
    headers: existsSync(instructionsFile)
      ? readFileSync(instructionsFile, "utf8").split(/\r?\n/).filter((line) => /^\d+\.\s/.test(line))
      : [],
  });

  // Clear reaches every window; listening is untouched.
  const clearMark = Date.now();
  const clearResult = await fake.invoke("shell:action", { action: "clear-display" });
  const clearedWindows = new Set(fake.sent.filter((m) => m.channel === "display:cleared" && m.at >= clearMark).map((m) => m.windowId));
  const afterDisplayClear = await fake.invoke("speech:getRealtimeStatus");
  // Broadcast targets: the windows that receive any gateway frame (capture windows never do).
  const broadcastTargets = new Set(fake.sent.filter((m) => m.channel === "window:state:changed").map((m) => m.windowId)).size;
  step("clear", { ok: clearResult.ok, windows: clearedWindows.size, broadcastTargets, lifecycle: afterDisplayClear.value?.lifecycle ?? null });

  // Quit: in-app Ctrl+Q only. Plain q and Ctrl+Shift+Q do nothing; no global Ctrl+Q exists.
  const press = (input) => {
    let prevented = false;
    fake.emitWebContents(firstWindow(), "before-input-event", { preventDefault: () => (prevented = true) }, { type: "keyDown", isAutoRepeat: false, alt: false, shift: false, meta: false, control: false, ...input });
    return prevented;
  };
  const quitsBefore = fake.quitCalls.length;
  const plainPrevented = press({ key: "q" });
  const shiftPrevented = press({ key: "Q", control: true, shift: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const quitsAfterOthers = fake.quitCalls.length;
  const ctrlPrevented = press({ key: "q", control: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const shortcuts = await fake.invoke("shortcuts:list");
  step("quit", {
    plainPrevented,
    shiftPrevented,
    quitsFromOthers: quitsAfterOthers - quitsBefore,
    ctrlPrevented,
    quitsFromCtrlQ: fake.quitCalls.length - quitsAfterOthers,
    globalQuit: fake.registeredShortcuts.filter((acc) => /\+Q$/i.test(acc)),
    hint: (shortcuts.value?.bindings ?? []).find((b) => b.action === "quit") ?? null,
  });
  await fake.invoke("session:end");
  try { await external?.stop?.(); } catch { /* already stopped */ }
}

async function runPractice(desktop) {
  await desktop.createMainShell({ userDataDir: practiceUserData });
  await waitFor(() => fake.ipcHandlers.has("practice:get") && fake.BrowserWindow.getAllWindows().length > 0);

  // The control window (index.html) opens the practice window; every
  // practice call below is made FROM the practice page, the way practice.js
  // makes it, so the sender check is exercised on the real path.
  const opened = await fake.invoke("practice:open");
  await waitFor(() => practiceWindow(), 4000);
  const win = practiceWindow();
  const fromPractice = (channel, payload = null) => fake.invokeFrom(win?.id ?? -1, channel, payload);
  const { pathToFileURL } = await import("node:url");
  const rendererDir = join(process.cwd(), "src", "desktop", "renderer");
  step("window", {
    opened: opened.value?.opened ?? null,
    exists: Boolean(win),
    title: win?.options?.title ?? null,
    frame: win?.options?.frame ?? null,
    alwaysOnTop: win?.options?.alwaysOnTop ?? null,
    samePage: String(win?.loaded?.path ?? "").endsWith("practice.html"),
    skipTaskbar: win?.skipTaskbar ?? null,
    // The practice window may show practice.html and nothing else: never the
    // overlay page, whose bridge is wider.
    navigatePractice: win ? navigationAllowed(win, pathToFileURL(join(rendererDir, "practice.html")).href) : null,
    navigateIndex: win ? navigationAllowed(win, pathToFileURL(join(rendererDir, "index.html")).href) : null,
    controlNavigateIndex: navigationAllowed(fake.BrowserWindow.getAllWindows()[0], pathToFileURL(join(rendererDir, "index.html")).href),
  });

  // Least privilege: the practice page reaches practice:* and nothing else.
  const forbiddenConfig = await fromPractice("config:get");
  const forbiddenSession = await fromPractice("session:start", {});
  const forbiddenShell = await fromPractice("shell:action", { action: "analyse-screen" });
  const forbiddenOpen = await fromPractice("practice:open");
  step("trust", {
    config: forbiddenConfig.error?.code ?? null,
    session: forbiddenSession.error?.code ?? null,
    shell: forbiddenShell.error?.code ?? null,
    open: forbiddenOpen.error?.code ?? null,
  });

  const empty = await fromPractice("practice:get");
  step("empty", {
    ok: empty.ok,
    material: empty.value?.material ?? null,
    session: empty.value?.session ?? null,
    debrief: empty.value?.debrief ?? null,
    materialReadError: empty.value?.materialReadError ?? null,
  });

  const noMaterial = await fromPractice("practice:start");
  step("startWithoutMaterial", { ok: noMaterial.ok, code: noMaterial.error?.code ?? null });

  const saved = await fromPractice("practice:setMaterial", { problemStatement: "Design a rate limiter." });
  const readBack = await fromPractice("practice:get");
  step("material", {
    ok: saved.ok,
    saved: saved.value?.material ?? null,
    readBack: readBack.value?.material ?? null,
    readError: readBack.value?.materialReadError ?? null,
  });

  const blank = await fromPractice("practice:setMaterial", { problemStatement: "   " });
  const afterBlank = await fromPractice("practice:get");
  step("blankMaterial", {
    ok: blank.ok,
    code: blank.error?.code ?? null,
    kept: afterBlank.value?.material?.problemStatement ?? null,
  });

  const started = await fromPractice("practice:start");
  const live = await waitFor(async () => {
    const snapshot = await fromPractice("practice:get");
    return snapshot.value?.session?.active ? snapshot.value.session : null;
  }, 10_000);
  // The server-side onSessionStart runs ~25-30 ms after the shell reports the session active.
  await waitFor(() => practiceSeen.starts.length >= 1, 5000);
  const status = await fake.invoke("speech:getRealtimeStatus");
  step("started", {
    ok: started.ok,
    startedAt: started.value?.startedAt ?? null,
    lifecycle: status.value?.lifecycle ?? null,
    session: live,
    starts: practiceSeen.starts.length,
    // The practice window stays in the taskbar while the call runs.
    practiceSkipTaskbar: win?.skipTaskbar ?? null,
  });

  const again = await fromPractice("practice:start");
  step("secondStart", { ok: again.ok, code: again.error?.code ?? null });

  const mark = Date.now();
  await waitFor(() => typeof practiceSeen.emit === "function", 8000);
  const emitted = typeof practiceSeen.emit === "function";
  practiceSeen.emit?.({
    v: 1,
    type: "transcript",
    data: { text: "How would you shard it?", final: true, role: "rep", source: "mic" },
  });
  const question = await waitFor(() => practiceEvents(mark).find((event) => event.type === "question") ?? null, 8000);
  const done = await waitFor(() => practiceEvents(mark).find((event) => event.type === "answer-done") ?? null, 20_000);
  step("transcript", {
    emitted,
    question: question ? { id: question.id, question: question.question, band: question.evidence?.band ?? null, source: question.evidence?.source ?? null } : null,
    answerDone: done ? { id: done.id, chars: String(done.text ?? "").length } : null,
    types: practiceEvents(mark).map((event) => event.type),
    // Every app window that is not the practice window: control, overlay, panels.
    leakedToApp: fake.sent.filter((m) => m.windowId !== win.id && m.channel === "practice:event").length,
    appWindows: fake.BrowserWindow.getAllWindows().filter((w) => w !== win).length,
  });

  const ended = await fromPractice("practice:end");
  step("ended", {
    ok: ended.ok,
    savedAt: ended.value?.debrief?.savedAt ?? null,
    hasNote: /Practice rehearsal only/.test(ended.value?.debrief?.text ?? ""),
    hasQuestion: /1\. Question: How would you shard it\?/.test(ended.value?.debrief?.text ?? ""),
    stats: ended.value?.debrief?.stats ?? null,
    endedEvents: practiceEvents(mark).filter((event) => event.type === "ended").length,
  });

  const secondEnd = await fromPractice("practice:end");
  step("secondEnd", { ok: secondEnd.ok, code: secondEnd.error?.code ?? null });

  const persisted = await fromPractice("practice:get");
  const debriefPath = join(practiceUserData, "practice-debrief.json");
  const onDisk = existsSync(debriefPath) ? JSON.parse(readFileSync(debriefPath, "utf8")) : null;
  step("persisted", {
    session: persisted.value?.session ?? null,
    title: persisted.value?.debrief?.title ?? null,
    stats: persisted.value?.debrief?.stats ?? null,
    debriefFile: Boolean(onDisk),
    materialFile: existsSync(join(practiceUserData, "practice-material.json")),
    // What the window shows is byte-for-byte what was saved.
    textMatchesFile: onDisk?.text === ended.value?.debrief?.text && onDisk?.text === persisted.value?.debrief?.text,
  });

  const windowsBefore = fake.BrowserWindow.getAllWindows().length;
  const reopened = await fake.invoke("practice:open");
  step("reopen", {
    opened: reopened.value?.opened ?? null,
    extraWindows: fake.BrowserWindow.getAllWindows().length - windowsBefore,
  });

  // Boundary: the tap is gated on session.isActive(), so an utterance after
  // practice:end must not produce another question event.
  const eventsBefore = practiceEvents(mark).length;
  practiceSeen.emit?.({
    v: 1,
    type: "transcript",
    data: { text: "Are you still there?", final: true, role: "rep", source: "mic" },
  });
  await delay(400);
  step("gatedAfterEnd", { newEvents: practiceEvents(mark).length - eventsBefore });

  // Closing the practice window mid-session ends the session (nobody is left
  // to read the answers) and still saves the debrief.
  const restarted = await fromPractice("practice:start");
  win.close();
  const closedEnd = await waitFor(async () => {
    const snapshot = await fake.invoke("practice:get");
    const ended = snapshot.value?.session?.active === false;
    const saved = snapshot.value?.debrief?.title === `Practice session — ${restarted.value?.startedAt}`;
    return ended && saved ? snapshot.value : null;
  }, 4000);
  step("closeEnds", {
    restarted: restarted.ok,
    active: closedEnd?.session?.active ?? null,
    debriefIsNew: closedEnd?.debrief?.title === `Practice session — ${restarted.value?.startedAt}`,
    windowCleared: practiceWindow() === null,
  });

  // A practice window reopened while the call is live is in the taskbar.
  await fake.invoke("practice:open");
  const second = await waitFor(() => practiceWindow(), 4000);
  step("reopenDuringCall", {
    exists: Boolean(second) && second !== win,
    skipTaskbar: second?.skipTaskbar ?? null,
  });

  await fake.invoke("session:end");
  try { await external?.stop?.(); } catch { /* already stopped */ }
}

async function runAutostartOff(desktop) {
  await desktop.createMainShell({ userDataDir: groundingUserData });
  await waitFor(() => fake.ipcHandlers.has("settings:get"));
  await delay(600);
  const status = await fake.invoke("speech:getRealtimeStatus");
  const settings = await fake.invoke("settings:get");
  step("autoStartOff", { starts: groundingSeen.starts.length, lifecycle: status.value?.lifecycle ?? null, settings: settings.value ?? null });
  try { await external?.stop?.(); } catch { /* already stopped */ }
}

async function runAutostartFail(desktop) {
  await desktop.createMainShell({ userDataDir: groundingUserData });
  const failed = await waitFor(async () => {
    const status = await fake.invoke("speech:getRealtimeStatus");
    return status.value?.lifecycle === "failed" ? status.value : null;
  }, 8000);
  external = lateServer();
  await external.start();
  const manual = await fake.invoke("session:start", {});
  await waitFor(() => groundingSeen.starts.length >= 1, 4000);
  step("autoStartFail", { failed: Boolean(failed), lastError: failed?.lastError ?? null, manualOk: manual.ok, starts: groundingSeen.starts.length });
  await fake.invoke("session:end");
  try { await external?.stop?.(); } catch { /* already stopped */ }
}

if (mode === "audio-session") {
  try {
    await runAudioSession(mainModule);
  } catch (error) {
    report.error = String(error?.stack ?? error);
  }
  console.log(`RESULT ${JSON.stringify(report)}`);
  process.exit(0);
}

if (mode === "audio-missing") {
  try {
    await runAudioMissing(mainModule);
  } catch (error) {
    report.error = String(error?.stack ?? error);
  }
  console.log(`RESULT ${JSON.stringify(report)}`);
  process.exit(0);
}

if (GROUNDING_MODES.has(mode)) {
  try {
    if (mode === "grounding") await runGrounding(mainModule);
    else if (mode === "autostart-fail") await runAutostartFail(mainModule);
    else await runAutostartOff(mainModule);
  } catch (error) {
    report.error = String(error?.stack ?? error);
  }
  console.log(`RESULT ${JSON.stringify(report)}`);
  process.exit(0);
}

if (mode === "practice") {
  try {
    await runPractice(mainModule);
  } catch (error) {
    report.error = String(error?.stack ?? error);
  }
  console.log(`RESULT ${JSON.stringify(report)}`);
  process.exit(0);
}


try {
  const config = await fake.invoke("config:get");
  step("config", {
    keys: Object.keys(config.value ?? {}),
    realtimeUrl: config.value?.realtimeUrl ?? null,
    engineMode: config.value?.engineMode ?? null,
  });

  // S2: the renderer must not be able to point the session (and the JWT) elsewhere.
  const attacker = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let attackerConnections = 0;
  attacker.on("connection", (socket) => {
    attackerConnections += 1;
    socket.close();
  });
  await new Promise((resolve) => attacker.once("listening", resolve));
  const evilUrl = `ws://127.0.0.1:${attacker.address().port}`;
  const hijack = await fake.invoke("session:start", { url: evilUrl, jwt: "attacker-wants-this" });
  await delay(400);
  step("hijack", { envelope: hijack, attackerConnections });
  if (hijack?.ok) await fake.invoke("session:end");
  attacker.close();

  // Session 1.
  const t1 = Date.now();
  const start1 = await fake.invoke("session:start", {});
  step("start1", start1);
  await waitFor(() => frameTypes(t1).includes("session.state"), 5000);
  if (mode === "external") await waitFor(() => broadcasts("speech:transcript:received", t1).length > 0, 8000);
  step("session1", {
    frameTypes: [...new Set(frameTypes(t1))],
    transcripts: broadcasts("speech:transcript:received", t1).length,
    errored: broadcasts("speech:errored", t1).map((m) => m.payload?.message ?? null),
  });

  // Speech command result must reach the renderer unwrapped (one envelope).
  const speech = await fake.invoke("speech:start");
  step("speechStart", speech);

  if (mode === "embedded") {
    const port = Number(new URL(config.value.realtimeUrl).port);
    step("security", {
      originUpgrade: await rawUpgrade(port, "https://evil.example"),
      wrongToken: await helloWith(config.value.realtimeUrl, "guess", start1?.value?.sessionId ?? "x"),
      noToken: await helloWith(config.value.realtimeUrl, undefined, start1?.value?.sessionId ?? "x"),
    });
    const screenMark = Date.now();
    step("screen", await fake.invoke("screen:analyse", { purpose: "context", origin: "manual" }));
    step("screenState", broadcasts("screen:analysis-state", screenMark).map((m) => m.payload?.busy));
  }

  const end1 = await fake.invoke("session:end");
  step("end1", end1);

  // Session 2 in the same process (Start -> End -> Start).
  const t2 = Date.now();
  const start2 = await fake.invoke("session:start", {});
  step("start2", start2);
  await waitFor(() => frameTypes(t2).includes("session.state"), 5000);
  if (mode === "external") await waitFor(() => broadcasts("speech:transcript:received", t2).length > 0, 8000);
  step("session2", {
    frameTypes: [...new Set(frameTypes(t2))],
    transcripts: broadcasts("speech:transcript:received", t2).length,
  });

  if (mode === "external") {
    // Remote end: the server ends the session. Teardown must run ONCE.
    const t3 = Date.now();
    await external.stop();
    await waitFor(
      () => broadcasts("session:state:changed", t3).some((m) => m.payload?.state === "ended"),
      5000,
    );
    await delay(300);
    step("remoteEnd", {
      lifecycle: broadcasts("session:state:changed", t3).map((m) => m.payload?.state),
      stopSpeechBroadcasts: broadcasts("speech:vad:stats", t3).length,
      dupLogs: external.logs.filter((l) => l.type === "dup").length,
    });
  } else {
    step("end2", await fake.invoke("session:end"));
  }
} catch (error) {
  report.error = String(error?.stack ?? error);
}

console.log(`RESULT ${JSON.stringify(report)}`);
process.exit(0);
