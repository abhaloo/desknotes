/**
 * CONTRACT DEMONSTRATIONS — executable behavioral specification.
 *
 * Each test asserts DeskNotes' documented wire contract
 * (docs/protocol.md) and keeps it executable so the contract cannot silently
 * drift. If a test here fails, the implementation moved away from the spec —
 * fix the implementation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeClient } from "../src/transport/realtime-client.js";
import { decodeAudioFrame } from "../src/shared/protocol.js";
import { VadGate } from "../src/vad/index.js";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";
import { ScreenAnalyser } from "../src/vision/index.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 2000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(stepMs);
  }
}

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }
  send(data) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(data);
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  kill(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "killed", wasClean: false });
  }
  deliver(frame) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  sentJson() {
    return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d));
  }
}

function makeClient(options = {}) {
  const sockets = [];
  const client = new RealtimeClient({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    baseUrl: "ws://fake",
    ...options,
  });
  return { client, sockets };
}

const pcm = (n, tag = 0) => {
  const out = new Int16Array(n);
  if (n > 0) out[0] = tag;
  return out;
};

/* ---------------------------------------------------------------- spec ----- */

// specified hello streams for topology "general": stream_id "rep",
// source "mic" / stream_id "prospect", source "system"
//.
test("contract: hello stream descriptors use stream_id 'rep'/'prospect', source 'mic'/'system'", async () => {
  const { client, sockets } = makeClient();
  const started = client.start({ sessionId: "d1", jwt: "t" });
  sockets[0].open();
  await started;
  const hello = sockets[0].sentJson().find((f) => f.type === "hello");
  assert.deepEqual(
    hello.streams.map((s) => ({ stream_id: s.stream_id, source: s.source })),
    [
      { stream_id: "rep", source: "mic" },
      { stream_id: "prospect", source: "system" },
    ],
  );
  client.stop();
});

/* ---------------------------------------------------------------- spec ----- */

// Spec: last_seen_seq is OMITTED on a fresh session (null) —
test("contract: first hello omits last_seen_seq entirely", async () => {
  const { client, sockets } = makeClient();
  const started = client.start({ sessionId: "d2", jwt: "t" });
  sockets[0].open();
  await started;
  const hello = sockets[0].sentJson().find((f) => f.type === "hello");
  assert.ok(!("last_seen_seq" in hello), "fresh session must not ask for replay");
  client.stop();
});

/* ---------------------------------------------------------------- spec ----- */

// Spec: lastSeenSeq tracks the highest top-level seq of DOWNLINK frames so
// the server can replay missed control frames.
test("contract: last_seen_seq is the highest downlink frame seq, not sent-audio seq", async () => {
  const { client, sockets } = makeClient();
  const started = client.start({ sessionId: "d3", jwt: "t" });
  sockets[0].open();
  await started;
  sockets[0].deliver({ v: 1, type: "turn.done", seq: 42, data: { turn_id: "t1" } });
  sockets[0].deliver({ v: 1, type: "say", seq: 7, data: { say_id: "s1", text: "hi" } });
  sockets[0].kill();
  await waitFor(() => sockets.length === 2, 3000);
  sockets[1].open();
  await waitFor(() => sockets[1].sentJson().some((f) => f.type === "hello"));
  const hello = sockets[1].sentJson().find((f) => f.type === "hello");
  assert.equal(hello.last_seen_seq, 42, "replay must resume after the newest downlink seq");
  client.stop();
});

/* ---------------------------------------------------------------- spec ----- */

// Spec: finalize carries the NUMERIC stream index
//.
test("contract: finalize stream field is the numeric stream_idx", async () => {
  const { client, sockets } = makeClient();
  const started = client.start({ sessionId: "d4", jwt: "t" });
  sockets[0].open();
  await started;
  client.finalizeStream("microphone");
  client.finalizeStream(1);
  const frames = sockets[0].sentJson().filter((f) => f.type === "finalize");
  assert.deepEqual(frames.map((f) => f.stream), [0, 1]);
  assert.ok(frames.every((f) => typeof f.stream === "number"));
  client.stop();
});

/* ---------------------------------------------------------------- spec ----- */

// specified backoff is FULL JITTER: delay = random() * min(15000, 500 * 2^attempt)
//.
test("contract: reconnect backoff is full-jitter (random() * cap)", async () => {
  const realRandom = Math.random;
  Math.random = () => 0; // full-jitter with random 0 => ~0 ms delay
  try {
    const { client, sockets } = makeClient();
    const started = client.start({ sessionId: "d5", jwt: "t" });
    sockets[0].open();
    await started;
    const at = Date.now();
    sockets[0].kill();
    await waitFor(() => sockets.length === 2, 3000);
    const waited = Date.now() - at;
    assert.ok(waited < 150, `jittered delay with random()=0 must retry fast, waited ${waited}ms`);
    client.stop();
  } finally {
    Math.random = realRandom;
  }
});

/* ---------------------------------------------------------------- spec ----- */

// Spec: close codes 4400/4404/4409 are TERMINAL (no retry)
//.
test("contract: terminal close codes 4400/4404/4409 latch 'closed' without retry", async () => {
  for (const code of [4400, 4404, 4409]) {
    const { client, sockets } = makeClient();
    const started = client.start({ sessionId: `d6-${code}`, jwt: "t" });
    sockets[0].open();
    await started;
    sockets[0].kill(code);
    await delay(1200);
    assert.equal(
      sockets.length,
      1,
      `close ${code} must not trigger a reconnect attempt`,
    );
    assert.notEqual(client.state, "reconnecting");
    client.stop();
  }
});

/* ---------------------------------------------------------------- spec ----- */

// Spec: user-initiated reconnect() makes ONE IMMEDIATE attempt, then backs
// off` straight away).
test("contract: reconnect() attempts immediately, without a backoff sleep", async () => {
  const { client, sockets } = makeClient();
  const started = client.start({ sessionId: "d7", jwt: "t" });
  sockets[0].open();
  await started;
  client.disconnect();
  const at = Date.now();
  void client.reconnect();
  await waitFor(() => sockets.length === 2, 3000);
  const waited = Date.now() - at;
  assert.ok(waited < 150, `resume must be immediate, waited ${waited}ms`);
  client.stop();
});

/* ---------------------------------------------------------------- spec ----- */

// Spec: seq is consumed only when a frame is actually SENT — frames dropped
// while disconnected-do-not-want never advance seq.
test("contract: dropped frames do not consume seq numbers", async () => {
  const { client, sockets } = makeClient();
  const started = client.start({ sessionId: "d8", jwt: "t" });
  sockets[0].open();
  await started;
  client.sendAudio("microphone", pcm(8, 1)); // seq 0
  client.sendAudio("microphone", pcm(8, 2)); // seq 1
  client.disconnect(); // want=false: further frames are dropped, not ringed
  for (let i = 0; i < 3; i += 1) client.sendAudio("microphone", pcm(8, 9));
  void client.reconnect();
  await waitFor(() => sockets.length === 2, 3000);
  sockets[1].open();
  await delay(30);
  client.sendAudio("microphone", pcm(8, 3));
  const frames = sockets[1].sent.filter((d) => typeof d !== "string");
  const last = decodeAudioFrame(frames[frames.length - 1]);
  assert.equal(last.seq, 2, "the next real send continues at seq 2");
  client.stop();
});

/* ---------------------------------------------------------------- spec ----- */

// Heartbeat (docs/protocol.md): a ping every PING_INTERVAL_MS arms a
// HEARTBEAT_TIMEOUT_MS deadline that any inbound frame clears, so a half-open
// link eats at most ping + deadline (10 s) of speech. Static-value pin; the
// runtime behavior is covered, scaled, in p1-client.test.js.
test("contract: half-open detection deadline is 5 s after a ping, pinged every 5 s", async () => {
  const { HEARTBEAT_TIMEOUT_MS, PING_INTERVAL_MS } = await import("../src/shared/protocol.js");
  assert.equal(HEARTBEAT_TIMEOUT_MS, 5000);
  assert.equal(PING_INTERVAL_MS, 5000);
});

/* --------------------------------------------------------------- spec ----- */

// specified VadGate: while the inference backlog is saturated the gate FORWARDS
// audio (and flushes pre-roll) instead of gating — "the gate already forwards
// instead of gating, so no speech waits on this backstop"
//.
test("contract: saturated inference backlog forwards audio instead of gating", async () => {
  const sent = [];
  let hold = true;
  const pending = [];
  const gate = new VadGate({
    probe: (frame, carry) =>
      new Promise((resolve) => {
        const done = () => resolve({ probability: 0, nextState: carry });
        if (hold) pending.push(done);
        else done();
      }),
    onSend: (frame) => sent.push(1),
    onSpeechEnd: () => {},
  });
  gate.feed(new Float32Array(40 * 512));
  assert.ok(sent.length > 0, "saturated backlog must forward, not hold, audio");
  hold = false;
  while (pending.length) pending.shift()();
  await gate.drain();
  gate.close();
});

/* --------------------------------------------------------------- spec ----- */

// specified VadGate: ANY inference failure fails open immediately —
// "VAD inference failed; failing open (forwarding all audio)"
//. The 64-drop budget is for BACKLOG drops only.
test("contract: the first inference failure fails the gate open", async () => {
  const gate = new VadGate({
    probe: async () => {
      throw new Error("inference exploded");
    },
    onSend: () => {},
    onSpeechEnd: () => {},
    onFailedOpen: () => {},
  });
  gate.feed(new Float32Array(512));
  await gate.drain();
  assert.equal(gate.stats().failedOpen, true, "one probe failure must fail open");
  gate.close();
});

/* --------------------------------------------------------------- spec ----- */

// specified downlink answer vocabulary is turn.started / turn.token / turn.done
// with data.turn_id (renderer contract, cockpit-Bu2rIC7n.js:15699-15715).
test("contract: answers stream as turn.started/token/done frames keyed by turn_id", async () => {
  const frames = [];
  let tap = null;
  const engine = createPipelineEngine({
    emit: (f) => frames.push(f),
    asr: ({ onTranscript }) => {
      tap = onTranscript;
      return { pushAudio() {}, finalize() {}, close() {} };
    },
    answerer: {
      async *streamAnswer() {
        yield "part1 ";
        yield "part2";
      },
    },
  });
  engine.onSessionStart({ sessionId: "d12" });
  tap({ final: true, text: "Why this company?", stream: 1, gateSeq: 9 }); // prospect stream: only prospect speech opens turns
  await delay(30);
  const types = frames.map((f) => f.type);
  assert.ok(types.includes("turn.started"), `got: ${types.join(",")}`);
  assert.ok(types.includes("turn.token"), `got: ${types.join(",")}`);
  assert.ok(types.includes("turn.done"), `got: ${types.join(",")}`);
  const started = frames.find((f) => f.type === "turn.started");
  assert.equal(typeof started.data.turn_id, "string");
});

/* --------------------------------------------------------------- spec ----- */

// Spec: gate_seq is echoed on turn.started — "echoed back on the turn
// frames so the client can render the answer under that question"
//.
test("contract: gate_seq is echoed on the turn's first frame", async () => {
  const frames = [];
  let tap = null;
  const engine = createPipelineEngine({
    emit: (f) => frames.push(f),
    asr: ({ onTranscript }) => {
      tap = onTranscript;
      return { pushAudio() {}, finalize() {}, close() {} };
    },
    answerer: {
      async *streamAnswer() {
        yield "answer";
      },
    },
  });
  engine.onSessionStart({ sessionId: "d13" });
  tap({ final: true, text: "What motivates you?", stream: 1, gateSeq: 21 }); // prospect stream
  await delay(30);
  const started = frames.find((f) => f.type === "turn.started") ?? frames[0];
  assert.equal(started.data.gate_seq, 21, "correlation must appear on the FIRST turn frame");
});

/* --------------------------------------------------------------- spec ----- */

// specified typed failures: result.failure is a STRING tag ("upload" | "timeout"
// | "unreachable") with solve "not_requested" and empty-string fields
//.
test("contract: typed failures carry a string failure tag and solve 'not_requested'", async () => {
  const analyser = new ScreenAnalyser({
    transport: {
      hasCapability: () => true,
      sendScreenAnalyse: () => true,
      onScreenResult: () => () => {},
    },
    http: { post: async () => ({ object_path: "o", upload_url: "u" }), put: async () => {} },
    timeoutMs: 15,
  });
  const result = await analyser.analyse({ bytes: new Uint8Array([1, 2, 3]) });
  assert.equal(result.failure, "timeout");
  assert.equal(result.solve, "not_requested");
  assert.equal(result.status, "failed");
  analyser.close();
});

/* --------------------------------------------------------------- spec ----- */

// Spec: a mint/upload failure ABORTS the analyse with failure "upload" and
// the screen_analyse command is never sent.
test("contract: upload failure aborts before the screen_analyse command is sent", async () => {
  const sends = [];
  const analyser = new ScreenAnalyser({
    transport: {
      hasCapability: () => true,
      sendScreenAnalyse: (cmd) => { sends.push(cmd); return true; },
      onScreenResult: () => () => {},
    },
    http: {
      post: async (path) => {
        if (path.includes("upload")) throw new Error("mint failed");
        return {};
      },
    },
    timeoutMs: 50,
  });
  const result = await analyser.analyse({ bytes: new Uint8Array([9, 9]) });
  assert.equal(sends.length, 0, "no command may reference an object that never uploaded");
  assert.equal(result.status, "failed");
  assert.equal(result.failure, "upload");
  analyser.close();
});

/* --------------------------------------------------------------- spec ----- */

// Spec: there is NO client-side dedup window — every capture is uploaded
// and the SERVER decides `dedup`.
test("contract: repeated identical frames are re-sent; dedup is a server verdict", async () => {
  const sends = [];
  let sink = null;
  const analyser = new ScreenAnalyser({
    transport: {
      hasCapability: () => true,
      sendScreenAnalyse: (cmd) => {
        sends.push(cmd);
        // The fake server processes both frames independently: its verdict is
        // "not a duplicate" — the point being that the CLIENT must never
        // fabricate the flag from a local cache.
        queueMicrotask(() =>
          sink?.({ command_id: cmd.commandId, status: "ok", kind: "code", dedup: false }),
        );
        return true;
      },
      onScreenResult: (cb) => { sink = cb; return () => {}; },
    },
    http: { post: async () => ({ object_path: "o", upload_url: "u" }), put: async () => {} },
    timeoutMs: 500,
    dedupeWindowMs: 10_000,
  });
  const bytes = new Uint8Array([4, 2]);
  await analyser.analyse({ bytes });
  const second = await analyser.analyse({ bytes });
  assert.equal(sends.length, 2, "the server, not the client, decides dedup");
  assert.equal(second.dedup, false, "a cache hit must not masquerade as a server dedup verdict");
  analyser.close();
});
