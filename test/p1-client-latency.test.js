import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeClient } from "../src/transport/realtime-client.js";
import { RealtimeServer } from "../src/server/ws-server.js";
import {
  UPLINK_HIGH_WATER_BYTES,
  UPLINK_LOW_WATER_BYTES,
  PING_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  decodeAudioFrame,
} from "../src/shared/protocol.js";

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
    this.bufferedAmount = 0;
  }
  send(data) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(data);
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  kill(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  deliver(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  audioSeqs() {
    return this.sent.filter((d) => typeof d !== "string").map((d) => decodeAudioFrame(d).seq);
  }
  json() {
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

async function live(options) {
  const made = makeClient(options);
  const started = made.client.start({ sessionId: `lat-${Math.random()}`, jwt: "t" });
  made.sockets[0].open();
  await started;
  return made;
}

const pcm = () => new Int16Array(512);

test("liveness defaults: 5 s ping, 5 s deadline (a half-open link costs <= 10 s, not 35 s)", () => {
  assert.equal(PING_INTERVAL_MS, 5000);
  assert.equal(HEARTBEAT_TIMEOUT_MS, 5000);
});

test("F8: the first retry after an unexpected drop is immediate, even with maximal jitter", async () => {
  const realRandom = Math.random;
  Math.random = () => 0.99;
  try {
    const { client, sockets } = await live();
    const at = Date.now();
    sockets[0].kill(1006);
    await waitFor(() => sockets.length === 2, 400);
    assert.ok(Date.now() - at < 100, `redialed after ${Date.now() - at} ms`);
    client.stop();
  } finally {
    Math.random = realRandom;
  }
});

test("F8: a server-announced restart (1012) keeps full jitter on the first retry", async () => {
  const realRandom = Math.random;
  Math.random = () => 0.99; // ~495 ms
  try {
    const { client, sockets } = await live();
    sockets[0].kill(1012);
    await delay(200);
    assert.equal(sockets.length, 1, "still in the jittered backoff");
    await waitFor(() => sockets.length === 2, 1000);
    client.stop();
  } finally {
    Math.random = realRandom;
  }
});

test("F6: frames a pong has acknowledged are not resent; unacknowledged ones are, with original seq", async () => {
  const { client, sockets } = await live({ pingIntervalMs: 20 });
  for (let i = 0; i < 3; i += 1) client.sendAudio("system", pcm()); // seq 0..2
  await waitFor(() => sockets[0].json().some((f) => f.type === "ping"));
  sockets[0].deliver({ v: 1, type: "pong" }); // the server processed 0..2
  for (let i = 0; i < 2; i += 1) client.sendAudio("system", pcm()); // seq 3..4, on the wire when it dies
  sockets[0].kill(1006);
  await waitFor(() => sockets.length === 2, 400);
  sockets[1].open();
  await waitFor(() => sockets[1].audioSeqs().length === 2);
  assert.deepEqual(sockets[1].audioSeqs(), [3, 4]);
  assert.equal(client.getLinkStats().resentFrames, 2);
  assert.equal(client.getStats().sentFrames, 5, "a resend is not a new send");
  client.stop();
});

test("F6: a clean disconnect() resends nothing", async () => {
  const { client, sockets } = await live({ pingIntervalMs: 60_000 });
  client.sendAudio("system", pcm());
  client.disconnect();
  const resumed = client.reconnect();
  sockets[1].open();
  await resumed;
  await delay(10);
  assert.deepEqual(sockets[1].audioSeqs(), []);
  client.stop();
});

test("F6: audio flowing with nothing coming back is probed at once and a dead link torn down fast", async () => {
  const { client, sockets } = await live({ pingIntervalMs: 60_000, heartbeatTimeoutMs: 80 });
  client._lastRecvAt = Date.now() - 2000; // nothing inbound for 2 s
  client.sendAudio("system", pcm());
  assert.ok(sockets[0].json().some((f) => f.type === "ping"), "speech-time probe sent with the audio");
  assert.equal(client.getLinkStats().livenessProbes, 1);
  await waitFor(() => client.state === "reconnecting", 1000);
  client.stop();
});

test("F6: an answered probe keeps the link", async () => {
  const { client, sockets } = await live({ pingIntervalMs: 60_000, heartbeatTimeoutMs: 80 });
  client._lastRecvAt = Date.now() - 2000;
  client.sendAudio("system", pcm());
  sockets[0].deliver({ v: 1, type: "pong" });
  await delay(150);
  assert.equal(client.state, "live");
  assert.equal(sockets.length, 1);
  client.stop();
});

test("F7: uplink backpressure queues audio above the high-water mark and drains in order below the low mark", async () => {
  const { client, sockets } = await live({ pingIntervalMs: 60_000 });
  const socket = sockets[0];
  client.sendAudio("system", pcm()); // seq 0 straight to the wire
  socket.bufferedAmount = UPLINK_HIGH_WATER_BYTES + 1;
  for (let i = 0; i < 4; i += 1) client.sendAudio("system", pcm());
  assert.deepEqual(socket.audioSeqs(), [0], "nothing more is written into a full socket buffer");
  assert.equal(client.getLinkStats().uplinkPaused, true);
  assert.equal(client.getLinkStats().queuedFrames, 4);
  socket.bufferedAmount = UPLINK_LOW_WATER_BYTES + 1; // between the marks: still paused (hysteresis)
  await delay(40);
  assert.deepEqual(socket.audioSeqs(), [0]);
  socket.bufferedAmount = 0;
  await waitFor(() => socket.audioSeqs().length === 5, 500); // the drain timer resumes on its own
  assert.deepEqual(socket.audioSeqs(), [0, 1, 2, 3, 4], "in order, seq assigned at the actual send");
  client.sendAudio("system", pcm());
  assert.deepEqual(socket.audioSeqs(), [0, 1, 2, 3, 4, 5]);
  client.stop();
});

test("F6: a main-loop stall past the deadline does not tear down a link whose pong is waiting to be read", async () => {
  const server = new RealtimeServer({
    port: 0,
    createEngine: () => ({ onSessionStart() {}, onAudio() {}, onFinalize() {}, onSessionEnd() {}, dispose() {} }),
  });
  const { url } = await server.start();
  const client = new RealtimeClient({ baseUrl: url, pingIntervalMs: 60_000, heartbeatTimeoutMs: 60 });
  try {
    await client.start({ sessionId: "stall", jwt: "t" });
    await delay(30);
    const statuses = [];
    client.onStatus((s) => statuses.push(s.state));
    // Node/Electron run due timers before reading socket I/O, so without the
    // grace this tears the link down (Bun happens to read I/O first).
    // Ping, then block this process (client AND in-process server) well past
    // the deadline before the pong can be read.
    client._sendPing(60);
    const until = Date.now() + 500;
    while (Date.now() < until) {
      /* main-loop stall */
    }
    await delay(400);
    assert.equal(client.state, "live", `link kept (statuses: ${statuses.join(",")})`);
    assert.deepEqual(statuses, []);
  } finally {
    client.stop();
    await server.stop();
  }
});
