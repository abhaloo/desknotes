import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket as WsClient } from "ws";
import { RealtimeServer } from "../src/server/ws-server.js";
import { encodeAudioFrame } from "../src/shared/protocol.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 2500, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(stepMs);
  }
}

/** Engine whose screen analysis hangs until the test releases it. */
function slowScreenEngine() {
  const state = { audio: [], finalize: [], screen: [], releases: [] };
  const createEngine = () => ({
    onSessionStart() {},
    onAudio(payload) {
      state.audio.push(payload.seq);
    },
    onFinalize(payload) {
      state.finalize.push(payload.streamIdx);
    },
    onScreenAnalyse(request) {
      state.screen.push(request);
      return new Promise((resolve) => {
        state.releases.push(() => resolve({ status: "ok", kind: "other", dedup: false }));
      });
    },
    onSessionEnd() {},
    dispose() {},
  });
  return { state, createEngine };
}

async function connect(url) {
  const socket = new WsClient(url);
  const frames = [];
  socket.on("message", (data, isBinary) => {
    if (!isBinary) frames.push(JSON.parse(String(data)));
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ v: 1, type: "hello", jwt: "t", session_id: `s-${Math.random()}`, streams: [], capture_authorized: true }));
  return { socket, frames };
}

const screenFrame = (id) =>
  JSON.stringify({ v: 1, type: "screen_analyse", command_id: id, purpose: "context", origin: "manual", image_hash: "a".repeat(64), object_path: "x", content_type: "image/jpeg" });

test("a slow screen analysis no longer stalls audio or finalize behind it (F1)", async () => {
  const { state, createEngine } = slowScreenEngine();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const { socket, frames } = await connect(url);
  try {
    socket.send(screenFrame("c1"));
    await waitFor(() => state.screen.length === 1);
    for (let seq = 0; seq < 5; seq++) socket.send(encodeAudioFrame(1, seq, new Int16Array([seq])));
    socket.send(JSON.stringify({ v: 1, type: "finalize", stream: 1 }));
    await waitFor(() => state.finalize.length === 1);
    assert.deepEqual(state.audio, [0, 1, 2, 3, 4], "audio processed in order while vision is still running");
    assert.equal(frames.filter((f) => f.type === "screen.result").length, 0, "result not sent yet");
    state.releases[0]();
    const result = await waitFor(() => frames.find((f) => f.type === "screen.result"));
    assert.equal(result.data.command_id, "c1");
    assert.equal(result.data.status, "ok");
  } finally {
    socket.close();
    await server.stop();
  }
});

test("a hung screen analysis is answered with a typed failure at the deadline and aborted", async () => {
  const { state, createEngine } = slowScreenEngine();
  const server = new RealtimeServer({ port: 0, createEngine, screenAnalyseTimeoutMs: 80 });
  const { url } = await server.start();
  const { socket, frames } = await connect(url);
  try {
    socket.send(screenFrame("hung"));
    const result = await waitFor(() => frames.find((f) => f.type === "screen.result"));
    assert.equal(result.data.status, "failed");
    assert.equal(result.data.error, "analysis_timeout");
    assert.equal(state.screen[0].signal.aborted, true, "the provider call is told to stop");
  } finally {
    socket.close();
    await server.stop();
  }
});

test("concurrent screen analyses are capped per connection (busy beyond two)", async () => {
  const { state, createEngine } = slowScreenEngine();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const { socket, frames } = await connect(url);
  try {
    socket.send(screenFrame("a"));
    socket.send(screenFrame("b"));
    socket.send(screenFrame("c"));
    const busy = await waitFor(() => frames.find((f) => f.type === "screen.result"));
    assert.equal(busy.data.command_id, "c");
    assert.equal(busy.data.solve, "busy");
    assert.equal(busy.data.status, "failed");
    assert.equal(state.screen.length, 2);
    for (const release of state.releases) release();
    await waitFor(() => frames.filter((f) => f.type === "screen.result").length === 3);
  } finally {
    socket.close();
    await server.stop();
  }
});

test("closing the connection aborts its in-flight screen analysis", async () => {
  const { state, createEngine } = slowScreenEngine();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const { socket } = await connect(url);
  try {
    socket.send(screenFrame("gone"));
    await waitFor(() => state.screen.length === 1);
    socket.close();
    await waitFor(() => state.screen[0].signal.aborted);
  } finally {
    await server.stop();
  }
});
