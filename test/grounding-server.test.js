import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { RealtimeServer } from "../src/server/ws-server.js";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";
import { CAPABILITIES } from "../src/shared/protocol.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(5);
  }
}

function contextEngine() {
  const seen = { contexts: [] };
  const createEngine = () => ({
    onSessionStart() {},
    onAudio() {},
    onFinalize() {},
    onContextSet(payload) {
      seen.contexts.push(payload);
    },
    onSessionEnd() {},
    dispose() {},
  });
  return { seen, createEngine };
}

async function connect(url) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, frames, send: (frame) => socket.send(JSON.stringify({ v: 1, ...frame })) };
}

const hello = (sessionId) => ({ type: "hello", jwt: "t", session_id: sessionId, streams: [], capture_authorized: false });

test("the server advertises session_context and routes it to the engine", async () => {
  const { seen, createEngine } = contextEngine();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const link = await connect(url);
  try {
    const state = await waitFor(() => link.frames.find((frame) => frame.type === "session.state"));
    assert.ok(state.data.capabilities.includes(CAPABILITIES.SESSION_CONTEXT));
    link.send(hello("ctx-1"));
    link.send({ type: "session_context", docs: "Led the Acme migration.", name: "resume.md" });
    await waitFor(() => seen.contexts.length === 1);
    assert.deepEqual(seen.contexts[0], { docs: "Led the Acme migration.", name: "resume.md" });
    link.send({ type: "session_context", docs: "" });
    await waitFor(() => seen.contexts.length === 2);
    assert.deepEqual(seen.contexts[1], { docs: "", name: "" });
    const entry = server.logs.find((log) => log.type === "session_context");
    assert.equal(entry.chars, "Led the Acme migration.".length);
    assert.ok(!JSON.stringify(server.logs).includes("Acme"), "logs carry lengths, never the text");
  } finally {
    link.socket.terminate();
    await server.stop();
  }
});

test("session_context before hello is dropped and logged", async () => {
  const { seen, createEngine } = contextEngine();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const link = await connect(url);
  try {
    link.send({ type: "session_context", docs: "early", name: "a.md" });
    await waitFor(() => server.logs.some((log) => log.type === "context_before_hello"));
    link.send(hello("ctx-2"));
    await delay(50);
    assert.equal(seen.contexts.length, 0);
  } finally {
    link.socket.terminate();
    await server.stop();
  }
});

test("a non-string or oversized document is rejected; a long name is cut to 200", async () => {
  const { seen, createEngine } = contextEngine();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const link = await connect(url);
  try {
    link.send(hello("ctx-3"));
    link.send({ type: "session_context", docs: 42 });
    link.send({ type: "session_context", docs: "x".repeat(32_001) });
    link.send({ type: "session_context", docs: "ok", name: "n".repeat(300) });
    await waitFor(() => seen.contexts.length === 1);
    assert.equal(seen.contexts[0].docs, "ok");
    assert.equal(seen.contexts[0].name.length, 200);
    assert.equal(server.logs.filter((log) => log.type === "bad_session_context").length, 2);
  } finally {
    link.socket.terminate();
    await server.stop();
  }
});

/* ------------------------------------------------------------ pipeline -- */

function fakeAsr() {
  const handlers = [];
  return {
    pushAudio() {},
    finalize() {
      return true;
    },
    close() {},
    onTranscript(cb) {
      handlers.push(cb);
    },
    send(streamIdx, text, final) {
      const data = { text, final, stream: streamIdx, streamIdx, role: streamIdx === 1 ? "prospect" : "rep", source: streamIdx === 1 ? "system" : "mic" };
      for (const cb of handlers) cb(data);
    },
  };
}

function recordingAnswerer({ deltaMs = 5, count = 3 } = {}) {
  const calls = [];
  async function* streamAnswer(args) {
    calls.push({ args });
    for (let i = 0; i < count; i += 1) {
      await delay(deltaMs);
      if (args.signal?.aborted) return;
      yield `[${calls.length}:${i}] `;
    }
  }
  return { calls, streamAnswer, answerOnce: async () => "" };
}

test("onContextSet grounds the next answer with the file name and the text", async () => {
  const asr = fakeAsr();
  const answerer = recordingAnswerer();
  const logs = [];
  const engine = createPipelineEngine({ emit: () => {}, asr, answerer, log: (entry) => logs.push(entry), now: Date.now });
  engine.onSessionStart({ sessionId: "s-ctx" });
  engine.onContextSet({ docs: "Led the Acme migration in 2021.", name: "resume.md" });
  asr.send(1, "describe a project where you improved reliability", true);
  await waitFor(() => answerer.calls.length === 1);
  assert.equal(answerer.calls[0].args.context, "DOCUMENTS:\nFile: resume.md\n\nLed the Acme migration in 2021.");
  const entry = logs.find((log) => log.type === "pipeline.context_set");
  assert.equal(entry.context_chars, answerer.calls[0].args.context.length);
  assert.ok(!JSON.stringify(logs).includes("Acme"), "logs never carry the document text");
  engine.dispose();
});

test("a swap reaches the next answer, the answer in flight keeps the old one, clear removes it", async () => {
  const asr = fakeAsr();
  const answerer = recordingAnswerer({ deltaMs: 20, count: 4 });
  const frames = [];
  const engine = createPipelineEngine({ emit: (frame) => frames.push(frame), asr, answerer, log: () => {}, now: Date.now });
  engine.onSessionStart({ sessionId: "s-swap" });
  engine.onContextSet({ docs: "old facts", name: "a.md" });
  asr.send(1, "describe a project where you improved reliability", true);
  await waitFor(() => answerer.calls.length === 1);
  engine.onContextSet({ docs: "new facts", name: "b.md" });
  assert.equal(answerer.calls[0].args.context, "DOCUMENTS:\nFile: a.md\n\nold facts");
  await waitFor(() => frames.some((frame) => frame.type === "turn.done"));

  asr.send(1, "where do you see yourself in five years", true);
  await waitFor(() => answerer.calls.length === 2);
  // Task 4 appends the session's committed exchange after the document: the
  // first turn's Q/A is now part of the second answer's context.
  assert.equal(answerer.calls[1].args.context, "DOCUMENTS:\nFile: b.md\n\nnew facts\n\nRECENT EXCHANGE:\nQ: describe a project where you improved reliability\nA: [1:0] [1:1] [1:2] [1:3] ");
  await waitFor(() => frames.filter((frame) => frame.type === "turn.done").length === 2);

  engine.onContextSet({ docs: "", name: "" });
  asr.send(1, "can you walk me through the hardest outage you ever debugged", true);
  await waitFor(() => answerer.calls.length === 3);
  // Clearing the document removes the static context, not the session history.
  assert.equal(answerer.calls[2].args.context, "RECENT EXCHANGE:\nQ: describe a project where you improved reliability\nA: [1:0] [1:1] [1:2] [1:3] \n\nQ: where do you see yourself in five years\nA: [2:0] [2:1] [2:2] [2:3] ");
  engine.dispose();
});
