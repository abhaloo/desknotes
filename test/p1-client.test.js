import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeClient } from "../src/transport/realtime-client.js";
import { RING_MAX_BYTES, decodeAudioFrame } from "../src/shared/protocol.js";

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

/** Minimal socket double: the client only speaks readyState + on* handlers. */
class FakeSocket {
  constructor() {
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.closeCalls = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  send(data) {
    if (this.readyState !== 1) throw new Error("FakeSocket: not open");
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.closeCalls += 1;
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: code !== 1006 }));
  }

  // --- test drivers ---------------------------------------------------------
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Unsolicited drop: close event without a local close() call. */
  kill() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "killed", wasClean: false });
  }

  fail(error) {
    this.onerror?.({ error: error ?? new Error("boom") });
    this.kill();
  }

  deliver(frame) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  sentJson() {
    return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d));
  }

  sentBinary() {
    return this.sent.filter((d) => typeof d !== "string");
  }
}

function makeClient({ track, ...options } = {}) {
  const sockets = [];
  const client = new RealtimeClient({
    createSocket: (url) => {
      const socket = new FakeSocket();
      socket.url = url;
      sockets.push(socket);
      track?.(socket);
      return socket;
    },
    baseUrl: "ws://fake",
    ...options,
  });
  return { client, sockets };
}

const CAPS = { v: 1, type: "session.state", data: { capabilities: ["screen_analyse", "answer_request", "replay", "session_commands"] } };

test("start() resolves on OPEN, sends hello and negotiates capabilities", async () => {
  const { client, sockets } = makeClient();
  const statuses = [];
  client.onStatus((event) => statuses.push(event));
  try {
    const started = client.start({
      sessionId: "unit-1",
      jwt: "jwt-1",
      topology: "general",
      captureAuthorized: true,
    });
    assert.equal(client.state, "connecting");
    assert.equal(sockets.length, 1);
    sockets[0].open();
    await started;
    assert.equal(client.state, "live");

    const hello = sockets[0].sentJson()[0];
    assert.equal(hello.v, 1);
    assert.equal(hello.type, "hello");
    assert.equal(hello.jwt, "jwt-1");
    assert.equal(hello.session_id, "unit-1");
    assert.equal(hello.capture_authorized, true);
    assert.deepEqual(
      hello.streams.map((s) => s.source),
      ["mic", "system"], // wire source names
    );
    // Fresh session: the key is omitted entirely until a downlink frame has
    // been seen — the server must be able to tell "fresh" from "resume".
    assert.equal("last_seen_seq" in hello, false);

    // Capabilities are unknown until the first session.state.
    assert.equal(client.hasCapability("replay"), false);
    sockets[0].deliver(CAPS);
    assert.equal(client.hasCapability("replay"), true);
    assert.equal(client.hasCapability("screen_analyse"), true);
    assert.deepEqual(statuses.map((s) => s.state), ["connecting", "live"]);
  } finally {
    client.stop();
  }
});

test("sendAudio frames per-stream seq/pcm and commands are one-shot JSON", async () => {
  const { client, sockets } = makeClient();
  try {
    const started = client.start({ sessionId: "unit-2", jwt: "t" });
    sockets[0].open();
    await started;

    client.sendAudio("microphone", new Int16Array([1, -2, 3000]));
    client.sendAudio("microphone", new Int16Array([4]));
    client.sendAudio("system", new Int16Array([5, 6]));
    const frames = sockets[0].sentBinary().map((buffer) => decodeAudioFrame(buffer));
    assert.deepEqual(
      frames.map((f) => [f.streamIdx, f.seq]),
      [
        [0, 0],
        [0, 1],
        [1, 0],
      ],
    );
    assert.deepEqual([...new Int16Array(frames[0].pcm.slice().buffer)], [1, -2, 3000]);
    assert.deepEqual([...new Int16Array(frames[2].pcm.slice().buffer)], [5, 6]);

    client.finalizeStream("system");
    client.requestAnswer("answer this", "answer", 9);
    client.setCaptureAuthorized(false);
    const json = sockets[0].sentJson();
    assert.deepEqual(json.at(-3), { v: 1, type: "finalize", stream: 1 });
    assert.deepEqual(json.at(-2), {
      v: 1,
      type: "answer_request",
      utterance: "answer this",
      intent: "answer",
      gate_seq: 9,
    });
    assert.deepEqual(json.at(-1), { v: 1, type: "set_capture_auth", authorized: false });

    // Vision is socket-first but only after the capability is negotiated.
    assert.equal(
      client.sendScreenAnalyse({ commandId: "c0", imageHash: "h", contentType: "image/jpeg" }),
      false,
    );
    sockets[0].deliver({ v: 1, type: "session.state", data: { capabilities: ["replay"] } });
    assert.equal(
      client.sendScreenAnalyse({ commandId: "c0", imageHash: "h", contentType: "image/jpeg" }),
      false,
    );
    sockets[0].deliver(CAPS);
    assert.equal(
      client.sendScreenAnalyse({ commandId: "c1", imageHash: "h", contentType: "image/jpeg" }),
      true,
    );
    const vision = sockets[0].sentJson().at(-1);
    assert.equal(vision.type, "screen_analyse");
    assert.equal(vision.command_id, "c1");
    assert.equal(vision.image_hash, "h");

    const stats = client.getStats();
    assert.equal(stats.sentFrames, 3);
    assert.equal(stats.droppedFrames, 0);
    assert.equal(stats.bufferedBytes, 0);
    assert.equal(stats.reconnects, 0);
    // lastSeenSeq tracks DOWNLINK frames: uplink audio never moves it.
    assert.equal(stats.lastSeenSeq, null);
  } finally {
    client.stop();
  }
});

test("drop mid-stream: bounded drop-oldest ring, backoff reconnect, in-order flush", async () => {
  const telemetry = [];
  const { client, sockets } = makeClient({ telemetry: (event) => telemetry.push(event), pingIntervalMs: 60_000 });
  const statuses = [];
  client.onStatus((event) => statuses.push(event));
  try {
    const started = client.start({ sessionId: "unit-3", jwt: "t" });
    sockets[0].open();
    await started;
    client.sendAudio("microphone", new Int16Array(16));
    assert.equal(client.getStats().lastSeenSeq, null); // downlink-tracked

    sockets[0].kill();
    await waitFor(() => statuses.some((s) => s.state === "reconnecting" && s.attempt === 1));

    // 100 x (5 header + 4096 payload) bytes overflows the 384000-byte ring by 7.
    const payload = new Int16Array(2048);
    for (let i = 0; i < 100; i += 1) client.sendAudio("microphone", payload);

    const buffered = client.getStats();
    assert.ok(buffered.bufferedBytes <= RING_MAX_BYTES);
    assert.equal(buffered.droppedFrames, 7);
    assert.equal(buffered.sentFrames, 1);

    // Control commands issued while down must never enter the ring.
    client.requestAnswer("late", "answer");
    client.finalizeStream("microphone");
    client.setCaptureAuthorized(true);
    assert.equal(client.sendScreenAnalyse({ commandId: "down" }), false);

    await waitFor(() => sockets.length === 2, 3000);
    sockets[1].open();
    await waitFor(() => client.state === "live");

    const sent = sockets[1].sentBinary().map((buffer) => decodeAudioFrame(buffer));
    // Half-open recovery: the frame that was on the wire when the link died
    // was never acknowledged by a pong, so it is resent first with its
    // ORIGINAL seq (the server drops it as a duplicate if it already had it).
    assert.equal(sent[0].seq, 0);
    const frames = sent.slice(1);
    assert.equal(frames.length, 93);
    // seq is consumed at the wire send only: ring loss is invisible in
    // the seq space, so the flushed frames continue contiguously from 0.
    assert.equal(frames[0].seq, 1); // drop-oldest kept the newest 93 frames
    for (let i = 1; i < frames.length; i += 1) assert.equal(frames[i].seq, frames[i - 1].seq + 1);

    const json = sockets[1].sentJson();
    assert.deepEqual(
      json.map((f) => f.type),
      ["hello"],
      "only hello is replayed on the wire; commands are never buffered",
    );
    assert.equal("last_seen_seq" in json[0], false); // no downlink seen yet
    assert.equal(json[0].capture_authorized, true); // local session state carried over
    assert.deepEqual(
      telemetry.filter((e) => e.type === "gap").map((e) => e.droppedFrames),
      [7],
    );

    const stats = client.getStats();
    assert.equal(stats.bufferedBytes, 0);
    assert.equal(stats.sentFrames, 94);
    assert.equal(stats.reconnects, 1);
    assert.equal(stats.lastSeenSeq, null); // downlink-tracked
    assert.equal(statuses.filter((s) => s.state === "reconnecting")[0].attempt, 1);
  } finally {
    client.stop();
  }
});

test("first-connect failure rejects start() and never starts a retry loop", async () => {
  const sockets = [];
  const client = new RealtimeClient({
    baseUrl: "ws://fake",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      // Fail the launch attempt only; the explicit reconnect gets a live socket.
      if (sockets.length === 1) queueMicrotask(() => socket.fail(new Error("connection refused")));
      return socket;
    },
  });
  const statuses = [];
  client.onStatus((event) => statuses.push(event));
  try {
    await assert.rejects(client.start({ sessionId: "unit-4", jwt: "t" }), /connection refused/);
    assert.deepEqual(statuses.map((s) => s.state), ["connecting", "failed"]);
    await delay(700);
    assert.equal(sockets.length, 1, "launch failure must not retry behind the UI");

    // An explicit reconnect() is the operator-approved resume path.
    const resuming = client.reconnect();
    await waitFor(() => sockets.length === 2, 2000);
    sockets[1].open();
    await resuming;
    assert.equal(client.state, "live");
    assert.equal(client.getStats().reconnects, 1);
  } finally {
    client.stop();
  }
});

test("session.ended latches terminal until a fresh start()", async () => {
  const { client, sockets } = makeClient();
  try {
    const started = client.start({ sessionId: "unit-5", jwt: "t" });
    sockets[0].open();
    await started;

    sockets[0].deliver({ v: 1, type: "session.ended", data: { reason: "server_shutdown" } });
    assert.equal(client.state, "ended");
    assert.ok(sockets[0].closeCalls >= 1);

    await delay(700);
    assert.equal(sockets.length, 1, "terminal verdicts must not auto-reconnect");
    await assert.rejects(client.reconnect(), /terminal/);

    // A fresh start() is the only way out of the latch.
    const restarted = client.start({ sessionId: "unit-5b", jwt: "t" });
    await waitFor(() => sockets.length === 2, 2000);
    sockets[1].open();
    await restarted;
    assert.equal(client.state, "live");
  } finally {
    client.stop();
  }
});

test("backoff grows across consecutive failed reconnect attempts", async () => {
  const { client, sockets } = makeClient();
  const statuses = [];
  client.onStatus((event) => statuses.push(event));
  try {
    const started = client.start({ sessionId: "unit-7", jwt: "t" });
    sockets[0].open();
    await started;

    sockets[0].kill();
    await waitFor(() => sockets.length === 2, 2000);
    // The retry itself must fail before the second (doubled) delay applies.
    sockets[1].fail();
    await waitFor(() => statuses.some((s) => s.state === "reconnecting" && s.attempt === 2), 2000);
    await waitFor(() => sockets.length === 3, 2500);
    sockets[2].open();
    await waitFor(() => client.state === "live");
    assert.equal(client.getStats().reconnects, 1);
  } finally {
    client.stop();
  }
});

test("heartbeat pings and tears down a half-open link for reconnect", async () => {
  // Every ping arms a silence deadline; ANY inbound frame clears it.
  // The deadline is HEARTBEAT_TIMEOUT_MS (5 s), scaled here.
  const { client, sockets } = makeClient({ pingIntervalMs: 40, heartbeatTimeoutMs: 120 });
  try {
    const started = client.start({ sessionId: "unit-6", jwt: "t" });
    sockets[0].open();
    await started;

    await waitFor(
      () => sockets[0].sentJson().some((f) => f.type === "ping") || client.state === "reconnecting",
      1000,
    );
    // Server never answers: the post-ping deadline fires and the half-open
    // link is torn down for recovery.
    await waitFor(() => client.state === "reconnecting", 1000);
    await waitFor(() => sockets.length === 2, 3000);
    sockets[1].open();
    await waitFor(() => client.state === "live");
    assert.equal(client.getStats().reconnects, 1);
  } finally {
    client.stop();
  }
});

test("inbound frames clear the heartbeat deadline (no spurious teardown)", async () => {
  const { client, sockets } = makeClient({ pingIntervalMs: 30, heartbeatTimeoutMs: 90 });
  try {
    const started = client.start({ sessionId: "unit-6b", jwt: "t" });
    sockets[0].open();
    await started;
    // Server chatters (e.g. transcripts) faster than the deadline: the link
    // must stay up even though no `pong` is ever sent.
    const chatter = setInterval(() => {
      if (sockets[0].readyState === 1) sockets[0].deliver({ v: 1, type: "pong", seq: 1 });
    }, 20);
    await delay(300);
    clearInterval(chatter);
    assert.equal(client.state, "live");
    assert.equal(sockets.length, 1);
  } finally {
    client.stop();
  }
});
