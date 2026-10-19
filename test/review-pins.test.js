/**
 * CONTRACT PINS — core behaviors that must never regress.
 *
 * Each test pins a load-bearing behavior of DeskNotes' client/engine
 * contract (docs/protocol.md): framing constants, session-resume semantics,
 * VAD tunables, and the answer-turn lifecycle. These should always stay
 * green; their complement in test/review-divergences.test.js demonstrates
 * the contract end-to-end.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeClient } from "../src/transport/realtime-client.js";
import {
  RING_MAX_BYTES,
  decodeAudioFrame,
  encodeAudioFrame,
} from "../src/shared/protocol.js";
import { VadConfig, VadGate } from "../src/vad/index.js";
import { SpeakingIndicators } from "../src/desktop/renderer/answer-buffer.js";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";

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

/* ------------------------------------------------------- wire frame layout -- */

// Spec: encodeAudioFrame = [u8 streamIdx][u32le seq][pcm16 payload] @5
//.
test("pin: binary audio frame is [u8 stream_idx][u32le seq][pcm16 @5]", () => {
  const payload = new Int16Array([0x1234, -2, 300]);
  const buffer = encodeAudioFrame(1, 0x01020304, payload);
  const view = new DataView(buffer);
  assert.equal(buffer.byteLength, 5 + 6);
  assert.equal(view.getUint8(0), 1);
  assert.equal(view.getUint32(1, true), 0x01020304);
  const decoded = decodeAudioFrame(buffer);
  assert.equal(decoded.streamIdx, 1);
  assert.equal(decoded.seq, 0x01020304);
  assert.equal(decoded.pcm.byteLength, 6);
  assert.equal(decoded.pcm[0], 0x34);
  assert.equal(decoded.pcm[1], 0x12);
});

// Spec: RING_MAX_BYTES = 16e3 * 2 * 12.
test("pin: gap ring budget is exactly 12 s of 16 kHz mono PCM16", () => {
  assert.equal(RING_MAX_BYTES, 16e3 * 2 * 12);
  assert.equal(RING_MAX_BYTES, 384_000);
});

/* -------------------------------------------------------------- hello shape -- */

// specified hello: {type:"hello", v:1, jwt, session_id, streams, capture_authorized}
//.
test("pin: hello carries jwt, session_id, streams and capture_authorized", async () => {
  const { client, sockets } = makeClient();
  const started = client.start({ sessionId: "s1", jwt: "tok", captureAuthorized: true });
  sockets[0].open();
  await started;
  const hello = sockets[0].sentJson().find((f) => f.type === "hello");
  assert.ok(hello, "hello is the first control frame");
  assert.equal(hello.v, 1);
  assert.equal(hello.jwt, "tok");
  assert.equal(hello.session_id, "s1");
  assert.equal(hello.capture_authorized, true);
  assert.ok(Array.isArray(hello.streams) && hello.streams.length >= 1);
  client.stop();
});

/* --------------------------------------------------- command fire-and-forget -- */

// Spec: answer_request is dropped when not OPEN, never queued
//; gate_seq omitted when undefined (19343).
test("pin: answer_request omits gate_seq when absent, sends it when given", async () => {
  const { client, sockets } = makeClient();
  const started = client.start({ sessionId: "s2", jwt: "t" });
  sockets[0].open();
  await started;
  client.requestAnswer("what is your weakness", "general");
  client.requestAnswer("tell me about yourself", "general", 17);
  const frames = sockets[0].sentJson().filter((f) => f.type === "answer_request");
  assert.equal(frames.length, 2);
  assert.equal("gate_seq" in frames[0], false);
  assert.equal(frames[1].gate_seq, 17);
  assert.equal(frames[0].utterance, "what is your weakness");
  assert.equal(frames[0].intent, "general");
  client.stop();
});

// Spec: a command sent during a gap is dropped, NOT replayed after
// reconnect.
test("pin: control commands are never ring-buffered across a gap", async () => {
  const { client, sockets } = makeClient();
  const started = client.start({ sessionId: "s3", jwt: "t" });
  sockets[0].open();
  await started;
  sockets[0].kill();
  client.requestAnswer("queued?", "general");
  assert.equal(client.sendScreenAnalyse({ commandId: "c1" }), false);
  await waitFor(() => sockets.length === 2, 3000);
  sockets[1].open();
  await delay(50);
  const types = sockets[1].sentJson().map((f) => f.type);
  assert.ok(types.includes("hello"));
  assert.ok(!types.includes("answer_request"), "a stale answer_request is never replayed");
  assert.ok(!types.includes("screen_analyse"), "a stale screen_analyse is never replayed");
  client.stop();
});

// Spec: finalize is best-effort, dropped when not OPEN.
test("pin: finalize is dropped (not buffered) while the socket is down", async () => {
  const { client, sockets } = makeClient();
  const started = client.start({ sessionId: "s4", jwt: "t" });
  sockets[0].open();
  await started;
  sockets[0].kill();
  client.finalizeStream("microphone");
  await waitFor(() => sockets.length === 2, 3000);
  sockets[1].open();
  await delay(50);
  assert.ok(!sockets[1].sentJson().some((f) => f.type === "finalize"));
  client.stop();
});

/* --------------------------------------------------- gap ring + seq continuity -- */

// specified mechanism: bounded drop-oldest ring, FIFO replay on reconnect
//.
test("pin: gap audio is buffered bounded and replayed in order with live seq", async () => {
  const { client, sockets } = makeClient();
  const started = client.start({ sessionId: "s5", jwt: "t" });
  sockets[0].open();
  await started;
  client.sendAudio("microphone", pcm(16, 1)); // seq 0
  sockets[0].kill();
  for (let i = 0; i < 5; i += 1) client.sendAudio("microphone", pcm(16, 100 + i)); // seq 1..5
  await waitFor(() => sockets.length === 2, 3000);
  sockets[1].open();
  await waitFor(() => sockets[1].sent.filter((d) => typeof d !== "string").length === 6);
  const seqs = sockets[1]
    .sent.filter((d) => typeof d !== "string")
    .map((d) => decodeAudioFrame(d).seq);
  // seq 0 was on the wire when the link died and no pong acknowledged it:
  // it is resent first with its ORIGINAL seq (a duplicate the server drops if
  // it already had it). Then the ring replays in order and seq continues.
  assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5], "unacked frame resent, then ring replays in order, seq continues");
  client.stop();
});

/* --------------------------------------------------------------- heartbeat -- */

// Spec: ANY inbound frame counts as liveness.
test("pin: inbound traffic keeps the link alive (half-open only on silence)", async () => {
  // Deadline scaled from 20 s to 60 ms so the 200 ms window spans several
  // ping+deadline cycles; with the 20 s default this could never fail.
  const { client, sockets } = makeClient({ pingIntervalMs: 30, heartbeatTimeoutMs: 60 });
  const started = client.start({ sessionId: "s6", jwt: "t" });
  sockets[0].open();
  await started;
  for (let i = 0; i < 10; i += 1) {
    sockets[0].deliver({ v: 1, type: "pong" });
    await delay(20);
  }
  assert.ok(sockets[0].sentJson().some((f) => f.type === "ping"), "deadlines were armed");
  assert.equal(client.state, "live", "frequent inbound frames prevent teardown");
  assert.equal(sockets[0].readyState, 1, "the link was never torn down");
  // Control: the same link goes quiet -> the deadline fires (half-open).
  await waitFor(() => client.state === "reconnecting", 1000);
  assert.notEqual(sockets[0].readyState, 1);
  client.stop();
});

// specified ping layout: {v:1, type:"ping"}.
test("pin: heartbeat ping is {v:1, type:'ping'} JSON", async () => {
  const { client, sockets } = makeClient({ pingIntervalMs: 25 });
  const started = client.start({ sessionId: "s7", jwt: "t" });
  sockets[0].open();
  await started;
  await waitFor(() => sockets[0].sentJson().some((f) => f.type === "ping"));
  const ping = sockets[0].sentJson().find((f) => f.type === "ping");
  assert.deepEqual(ping, { v: 1, type: "ping" });
  client.stop();
});

/* --------------------------------------------------------------- VadConfig -- */

// specified VadConfig: frameSamples 512, 16 kHz,
// 0.5/0.35, redemptionFrames 24, preRollMs 384, maxQueueFrames 32,
// maxDroppedBeforeFailOpen 64.
test("pin: VadConfig tunables match the documented constants", () => {
  assert.equal(VadConfig.frameSamples, 512);
  assert.equal(VadConfig.sampleRate, 16000);
  assert.equal(VadConfig.positiveSpeechThreshold, 0.5);
  assert.equal(VadConfig.negativeSpeechThreshold, 0.35);
  assert.equal(VadConfig.redemptionFrames, 24);
  assert.equal(VadConfig.preRollMs, 384);
  assert.equal(VadConfig.maxQueueFrames, 32);
  assert.equal(VadConfig.maxDroppedBeforeFailOpen, 64);
});

const FRAME = VadConfig.frameSamples;
const f32 = (frames, fill = 0) => new Float32Array(frames * FRAME).fill(fill);

// Spec: onSpeechEnd only after 24 consecutive sub-negative frames
//.
test("pin: redemption hangover ends speech on the 24th sub-negative frame", async () => {
  const probs = [1, ...Array(23).fill(0)];
  let ends = 0;
  const gate = new VadGate({
    probe: async (frame, carry) => ({ probability: probs.shift() ?? 0, nextState: carry }),
    onSend: () => {},
    onSpeechEnd: () => { ends += 1; },
  });
  gate.feed(f32(24));
  await gate.drain();
  assert.equal(ends, 0, "23 negatives must not end the segment");
  gate.feed(f32(1));
  await gate.drain();
  assert.equal(ends, 1, "the 24th consecutive negative ends it");
  gate.close();
});

// Spec: onset flushes the held pre-roll first,
// sized at 384 ms (6144 samples, 4934 + 19895-19897).
test("pin: onset flushes >=384 ms of pre-roll before anything is lost", async () => {
  let i = 0;
  const sent = [];
  const gate = new VadGate({
    probe: async (frame, carry) => {
      i += 1;
      // 20 silent frames, then onset.
      return { probability: i > 20 ? 1 : 0, nextState: carry };
    },
    onSend: (frame) => sent.push(frame[0]),
    onSpeechEnd: () => {},
  });
  gate.feed(f32(22, 0.01));
  await gate.drain();
  assert.ok(sent.length >= 12, `>=12 frames (384 ms) recovered, got ${sent.length}`);
  gate.close();
});

/* ------------------------------------------------------ speaking debounce -- */

// Spec: SPEAKING_QUIET_MS = 1500, interim-driven.
test("pin: speaking indicator debounces interim transcripts over 1.5 s", () => {
  const ind = new SpeakingIndicators({ quietMs: 1500 });
  assert.equal(ind.quietMs, 1500);
  const t0 = 1_000_000;
  ind.note("rep", t0);
  assert.equal(ind.speaking("rep", t0 + 1499), true);
  assert.equal(ind.speaking("rep", t0 + 1500), false);
  assert.equal(ind.speaking("prospect", t0 + 10), false);
});

/* --------------------------------------- answer_request arbitration (mock) -- */

// specified server rule surfaced in the client docs: answer_request "never
// supersedes a live answer".
test("pin: answer_request never supersedes a live turn", async () => {
  const frames = [];
  let tap = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const engine = createPipelineEngine({
    emit: (f) => frames.push(f),
    asr: ({ onTranscript }) => {
      tap = onTranscript;
      return { pushAudio() {}, finalize() {}, close() {} };
    },
    answerer: {
      async *streamAnswer() {
        await gate;
        yield "long answer";
      },
    },
  });
  engine.onSessionStart({ sessionId: "p1" });
  tap({ final: true, text: "Tell me about a hard bug.", stream: 1 }); // prospect stream: only prospect speech opens turns
  await delay(10);
  assert.equal(engine.onAnswerRequest({ utterance: "override", intent: "manual" }), false);
  release();
  await delay(10);
  assert.equal(engine.onAnswerRequest({ utterance: "idle now", intent: "manual" }), true);
  assert.ok(frames.some((f) => f.type === "turn.done"));
});
