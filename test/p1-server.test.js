import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket as WsClient } from "ws";
import { RealtimeServer } from "../src/server/ws-server.js";
import { createMockEngine } from "../src/server/mock-engine.js";
import { RealtimeClient } from "../src/transport/realtime-client.js";
import { encodeAudioFrame } from "../src/shared/protocol.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 2500, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(stepMs);
  }
}

/** Engine spy implementing the frozen engine interface. */
function captureEngines() {
  const engines = [];
  const createEngine = ({ emit } = {}) => {
    const engine = {
      emit,
      events: { start: [], audio: [], finalize: [], answer: [], screen: [], endCalls: 0, disposed: false },
      onSessionStart(payload) {
        this.events.start.push(payload);
      },
      onAudio(payload) {
        this.events.audio.push(payload);
      },
      onFinalize(payload) {
        this.events.finalize.push(payload);
      },
      onAnswerRequest(payload) {
        this.events.answer.push(payload);
      },
      async onScreenAnalyse(request) {
        this.events.screen.push(request);
        return { command_id: request.commandId, status: "ok", kind: "other", dedup: false, solve: "stub solution" };
      },
      onSessionEnd() {
        this.events.endCalls += 1;
      },
      dispose() {
        this.events.disposed = true;
      },
    };
    engines.push(engine);
    return engine;
  };
  return { engines, createEngine };
}

function rawHello(socket, fields) {
  socket.send(JSON.stringify({ v: 1, type: "hello", jwt: "t", streams: [], capture_authorized: true, ...fields }));
}

function rawAudio(socket, seq, value = seq) {
  socket.send(encodeAudioFrame(0, seq, new Int16Array([value])));
}

test("client/server round trip: hello, capabilities, audio, finalize, answer_request, screen", async () => {
  const { engines, createEngine } = captureEngines();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const client = new RealtimeClient({ baseUrl: url });
  const screenResults = [];
  client.onScreenResult((result) => screenResults.push(result));
  try {
    await client.start({ sessionId: "round-trip", jwt: "token", captureAuthorized: true });
    assert.equal(client.state, "live");
    await waitFor(() => client.hasCapability("replay"));
    assert.equal(client.hasCapability("answer_request"), true);
    assert.equal(client.hasCapability("screen_analyse"), true);

    await waitFor(() => engines.length === 1 && engines[0].events.start.length === 1);
    const start = engines[0].events.start[0];
    assert.equal(start.sessionId, "round-trip");
    assert.equal(start.captureAuthorized, true);
    assert.equal(start.streams.length, 2);

    client.sendAudio("microphone", new Int16Array([1, -2, 3000]));
    client.sendAudio("system", new Int16Array([7, 8]));
    await waitFor(() => engines[0].events.audio.length === 2);
    const [mic, system] = engines[0].events.audio;
    assert.equal(mic.streamIdx, 0);
    assert.equal(mic.seq, 0);
    assert.equal(mic.source, "microphone");
    assert.deepEqual([...mic.pcm16], [1, -2, 3000]);
    assert.equal(system.streamIdx, 1);
    assert.equal(system.seq, 0);
    assert.equal(system.source, "system");
    assert.deepEqual([...system.pcm16], [7, 8]);

    client.finalizeStream("microphone");
    await waitFor(() => engines[0].events.finalize.length === 1);
    assert.deepEqual(engines[0].events.finalize[0], { streamIdx: 0 });

    client.requestAnswer("Why this role?", "answer", 12);
    await waitFor(() => engines[0].events.answer.length === 1);
    assert.deepEqual(engines[0].events.answer[0], {
      utterance: "Why this role?",
      intent: "answer",
      gateSeq: 12,
    });

    const sent = client.sendScreenAnalyse({
      commandId: "cmd-1",
      purpose: "context",
      origin: "manual",
      imageHash: "hash-1",
      objectPath: "shots/1.jpg",
      contentType: "image/jpeg",
    });
    assert.equal(sent, true);
    await waitFor(() => screenResults.length === 1);
    assert.equal(screenResults[0].command_id, "cmd-1");
    assert.equal(screenResults[0].status, "ok");
    assert.equal(screenResults[0].solve, "stub solution");
    assert.equal(engines[0].events.screen[0].imageHash, "hash-1");

    const stats = client.getStats();
    assert.deepEqual(Object.keys(stats).sort(), [
      "bufferedBytes",
      "droppedFrames",
      "lastSeenSeq",
      "reconnects",
      "sentFrames",
    ]);
    assert.equal(stats.sentFrames, 2);
    assert.equal(stats.bufferedBytes, 0);
    assert.equal(stats.reconnects, 0);
  } finally {
    client.stop();
    await server.stop();
  }
});

test("socket loss mid-stream: ring flush keeps seq monotonic and the next engine resumes", async () => {
  const { engines, createEngine } = captureEngines();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const sockets = [];
  const client = new RealtimeClient({
    baseUrl: url,
    createSocket: (target) => {
      const socket = new WsClient(target);
      sockets.push(socket);
      return socket;
    },
  });
  try {
    await client.start({ sessionId: "resume-session", jwt: "t" });
    for (let i = 0; i < 5; i += 1) client.sendAudio("microphone", new Int16Array([i]));
    await waitFor(() => engines.length === 1 && engines[0].events.audio.length === 5);
    // Only the pre-hello capability frame (reserved seq 0) has come down;
    // uplink audio never moves last_seen_seq.
    assert.equal(client.getStats().lastSeenSeq, 0);

    sockets[0].terminate(); // unsolicited drop: the client has to recover on its own
    for (let i = 5; i < 10; i += 1) client.sendAudio("microphone", new Int16Array([i]));
    assert.ok(client.getStats().bufferedBytes > 0, "audio captured while down must be ring-buffered");

    await waitFor(() => sockets.length === 2, 4000);
    await waitFor(() => client.state === "live" && client.getStats().reconnects === 1);
    await waitFor(() => engines.length === 2 && engines[1].events.audio.length === 5);

    // Fresh engine per connection: it receives the CLIENT's ring flush in
    // order as live frames.
    assert.deepEqual(
      engines[1].events.audio.map((a) => a.seq),
      [5, 6, 7, 8, 9],
    );
    assert.deepEqual(client.getStats(), {
      sentFrames: 10,
      droppedFrames: 0,
      bufferedBytes: 0,
      reconnects: 1,
      lastSeenSeq: 0, // pre-hello session.state of each connection (seq 0)
    });
    assert.equal(server.logs.filter((l) => l.type === "gap").length, 0);
  } finally {
    client.stop();
    await server.stop();
  }
});

test("server replays missed downlink frames above hello.last_seen_seq into the new connection", async () => {
  // The `last_seen_seq` key is the highest DOWNLINK frame seq the client saw;
  // the server re-sends the control frames it missed verbatim (same seq).
  const { engines, createEngine } = captureEngines();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const collect = (socket, into) => socket.on("message", (data) => into.push(JSON.parse(String(data))));
  const open = (socket) => new Promise((resolve) => socket.once("open", resolve));
  const closeSocket = (socket) => new Promise((resolve) => { socket.once("close", resolve); socket.close(); });
  try {
    const firstSeen = [];
    const first = new WsClient(url);
    collect(first, firstSeen);
    await open(first);
    rawHello(first, { session_id: "downlink-replay" });
    await waitFor(() => engines.length === 1);
    for (let i = 0; i < 5; i += 1) {
      engines[0].emit({ type: "transcript", data: { text: `t${i}`, final: true } });
    }
    await waitFor(() => firstSeen.filter((f) => f.type === "transcript").length === 5);
    const seqs = firstSeen.filter((f) => f.type === "transcript").map((f) => f.seq);
    assert.ok(seqs.every((s) => typeof s === "number"), "downlink frames carry a top-level seq");

    await closeSocket(first);
    const secondSeen = [];
    const second = new WsClient(url);
    collect(second, secondSeen);
    await open(second);
    // The client saw only the first two frames before its gap: everything
    // above its last_seen_seq must be replayed verbatim.
    rawHello(second, { session_id: "downlink-replay", last_seen_seq: seqs[1] });
    await waitFor(() => secondSeen.filter((f) => f.type === "transcript").length >= 3);
    const replayed = secondSeen.filter((f) => f.type === "transcript");
    assert.deepEqual(replayed.map((f) => f.seq), seqs.slice(2), "missed frames replayed with their specified seq");
    assert.deepEqual(replayed.map((f) => f.data.text), ["t2", "t3", "t4"]);

    // A fresh session (no last_seen_seq key) gets nothing replayed.
    await closeSocket(second);
    const thirdSeen = [];
    const third = new WsClient(url);
    collect(third, thirdSeen);
    await open(third);
    rawHello(third, { session_id: "downlink-replay" });
    await delay(150);
    assert.equal(thirdSeen.filter((f) => f.type === "transcript").length, 0);
    await closeSocket(third);
  } finally {
    await server.stop();
  }
});

test("server accounts per-stream seq gaps and duplicates", async () => {
  const server = new RealtimeServer({ port: 0, createEngine: captureEngines().createEngine });
  const { url } = await server.start();
  try {
    const socket = new WsClient(url);
    await new Promise((resolve) => socket.once("open", resolve));
    rawHello(socket, { session_id: "gap-session", capture_authorized: false });
    rawAudio(socket, 0);
    rawAudio(socket, 4); // gap: 1..3 missing
    rawAudio(socket, 5);
    rawAudio(socket, 5); // duplicate
    socket.send(encodeAudioFrame(1, 7, new Int16Array([7]))); // stream 1 first frame: never a gap

    await waitFor(() => server.logs.some((l) => l.type === "gap") && server.logs.some((l) => l.type === "dup"));
    const gaps = server.logs.filter((l) => l.type === "gap");
    assert.equal(gaps.length, 1);
    assert.deepEqual(
      { sessionId: gaps[0].sessionId, streamIdx: gaps[0].streamIdx, expected: gaps[0].expected, got: gaps[0].got, missing: gaps[0].missing },
      { sessionId: "gap-session", streamIdx: 0, expected: 1, got: 4, missing: 3 },
    );
    const dups = server.logs.filter((l) => l.type === "dup");
    assert.equal(dups.length, 1);
    assert.equal(dups[0].streamIdx, 0);
    assert.equal(dups[0].seq, 5);

    await new Promise((resolve) => {
      socket.once("close", resolve);
      socket.close();
    });
  } finally {
    await server.stop();
  }
});

test("disconnect() keeps the session server-side and reconnect() resumes it", async () => {
  const { engines, createEngine } = captureEngines();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const client = new RealtimeClient({ baseUrl: url });
  try {
    await client.start({ sessionId: "keep-session", jwt: "t" });
    client.sendAudio("microphone", new Int16Array([1]));
    await waitFor(() => engines.length === 1 && engines[0].events.audio.length === 1);

    client.disconnect();
    assert.equal(client.state, "reconnecting");
    await delay(200);
    assert.equal(engines.length, 1, "an explicit disconnect must not auto-reconnect");

    await client.reconnect();
    assert.equal(client.state, "live");
    await waitFor(() => engines.length === 2 && engines[1].events.start.length === 1);
    client.sendAudio("microphone", new Int16Array([2]));
    await waitFor(() => engines[1].events.audio.length === 1);
    // seq never resets across a resume, even though the engine is new.
    assert.equal(engines[1].events.audio[0].seq, 1);
  } finally {
    client.stop();
    await server.stop();
  }
});

test("server shutdown emits session.ended and the client latches terminal (no reconnect)", async () => {
  const server = new RealtimeServer({ port: 0, createEngine: captureEngines().createEngine });
  const { url } = await server.start();
  const sockets = [];
  const statuses = [];
  const client = new RealtimeClient({
    baseUrl: url,
    createSocket: (target) => {
      const socket = new WsClient(target);
      sockets.push(socket);
      return socket;
    },
  });
  client.onStatus((event) => statuses.push(event));
  try {
    await client.start({ sessionId: "shutdown-session", jwt: "t" });
    assert.equal(client.state, "live");
    await server.stop();
    await waitFor(() => client.state === "ended");
    assert.ok(statuses.some((s) => s.state === "ended"));
    await delay(700);
    assert.equal(sockets.length, 1, "session.ended must suppress auto-reconnect");
    assert.equal(client.getStats().reconnects, 0);
  } finally {
    client.stop();
    await server.stop();
  }
});

test("failed token verification ends the connection terminally", async () => {
  const server = new RealtimeServer({
    port: 0,
    createEngine: captureEngines().createEngine,
    verifyToken: () => false,
  });
  const { url } = await server.start();
  const client = new RealtimeClient({ baseUrl: url });
  try {
    await client.start({ sessionId: "denied-session", jwt: "bad-token" });
    await waitFor(() => client.state === "ended");
    assert.ok(server.logs.some((l) => l.type === "auth_failed"));
  } finally {
    client.stop();
    await server.stop();
  }
});

test("mock engine emits canned transcripts, say echo and streamed answers", async () => {
  const server = new RealtimeServer({ port: 0, createEngine: createMockEngine });
  const { url } = await server.start();
  const client = new RealtimeClient({ baseUrl: url });
  const transcripts = [];
  const says = [];
  const deltas = [];
  const dones = [];
  const unsubscribe = client.onFrame((raw, frame) => {
    if (frame.type === "transcript") transcripts.push(frame.data);
    if (frame.type === "say") says.push(frame.data);
    if (frame.type === "turn.token") deltas.push(frame.data);
    if (frame.type === "turn.done") dones.push(frame.data);
  });
  try {
    await client.start({ sessionId: "mock-session", jwt: "t" });
    await waitFor(() => client.hasCapability("replay"));

    // 0.5 s of audio is exactly the interim cadence, so the stub is time-free.
    client.sendAudio("microphone", new Int16Array(8000));
    await waitFor(() => transcripts.length === 1);
    assert.equal(transcripts[0].final, false);
    assert.equal(transcripts[0].role, "rep");
    assert.equal(transcripts[0].source, "mic");

    client.finalizeStream("microphone");
    await waitFor(() => transcripts.length === 2);
    assert.equal(transcripts[1].final, true);
    assert.equal(says.length, 0);

    client.finalizeStream("system");
    await waitFor(() => transcripts.length === 3 && says.length === 1);
    assert.equal(transcripts[2].role, "prospect");
    assert.equal(says[0].text, transcripts[2].text);

    client.requestAnswer("Tell me about yourself", "answer");
    await waitFor(() => dones.length === 1);
    assert.ok(deltas.length >= 3 && deltas.length <= 5);
    assert.equal(new Set(deltas.map((d) => d.turn_id)).size, 1);
    assert.equal(deltas.map((d) => d.delta).join(""), "Tell me about yourself");
    assert.equal(dones[0].text, "Tell me about yourself");
  } finally {
    unsubscribe();
    client.stop();
    await server.stop();
  }
});
