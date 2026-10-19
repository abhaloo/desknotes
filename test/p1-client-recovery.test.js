import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeClient } from "../src/transport/realtime-client.js";
import { RealtimeServer } from "../src/server/ws-server.js";

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

/** Socket double: readyState + on* handlers, with server-side close codes. */
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
    if (this.readyState !== 1) throw new Error("FakeSocket: not open");
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

  /** Server-initiated close with a code. */
  kill(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "killed" });
  }

  hello() {
    return this.sent
      .filter((d) => typeof d === "string")
      .map((d) => JSON.parse(d))
      .find((f) => f.type === "hello");
  }
}

function makeClient() {
  const sockets = [];
  const client = new RealtimeClient({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    baseUrl: "ws://fake",
  });
  return { client, sockets };
}

const live = (sockets) => sockets.filter((s) => s.readyState === 0 || s.readyState === 1);

test("reconnect() during a retry backoff joins the loop instead of orphaning sockets", async () => {
  const realRandom = Math.random;
  Math.random = () => 0.99; // first backoff sleep ~495 ms: wide window for the race
  try {
    const { client, sockets } = makeClient();
    const started = client.start({ sessionId: "race", jwt: "t" });
    sockets[0].open();
    await started;

    // An unexpected drop retries IMMEDIATELY (no backoff on attempt 1);
    // failing that attempt puts the loop into its first jittered sleep.
    sockets[0].kill(1006);
    await waitFor(() => sockets.length === 2, 300);
    sockets[1].kill(1006); // closed before open: attempt 1 failed
    await delay(20);
    assert.equal(sockets.length, 2, "still sleeping in backoff");

    const resumed = client.reconnect();
    await waitFor(() => sockets.length === 3, 300);
    sockets[2].open();
    await resumed;

    // Past the original backoff deadline: the loop must not dial again.
    await delay(1100);
    assert.equal(sockets.length, 3, "exactly one new socket for the resume");
    assert.equal(live(sockets).length, 1, "one live link, nothing orphaned");
    assert.equal(client.state, "live");

    client.stop();
    assert.equal(live(sockets).length, 0, "stop() leaves no socket open");
  } finally {
    Math.random = realRandom;
  }
});

test("stop() closes a socket that is still connecting", async () => {
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    const { client, sockets } = makeClient();
    const started = client.start({ sessionId: "pending", jwt: "t" });
    sockets[0].open();
    await started;
    sockets[0].kill(1006);
    await waitFor(() => sockets.length === 2, 500); // retry dialing, never opened
    client.stop();
    assert.equal(live(sockets).length, 0);
  } finally {
    Math.random = realRandom;
  }
});

test("4401 gets ONE refresh-then-retry via session.getJwt, then latches terminal", async () => {
  const { client, sockets } = makeClient();
  let refreshes = 0;
  const started = client.start({
    sessionId: "auth",
    jwt: "stale",
    getJwt: async () => {
      refreshes += 1;
      return `fresh-${refreshes}`;
    },
  });
  sockets[0].open();
  await started;
  assert.equal(sockets[0].hello().jwt, "stale");

  sockets[0].kill(4401);
  await waitFor(() => sockets.length === 2, 500);
  sockets[1].open();
  await waitFor(() => client.state === "live");
  assert.equal(refreshes, 1);
  assert.equal(sockets[1].hello().jwt, "fresh-1", "the retry carries the refreshed token");

  sockets[1].kill(4401); // grace spent
  await delay(300);
  assert.equal(sockets.length, 2, "a spent 4401 never retries");
  assert.equal(client.state, "ended");
  client.stop();
});

test("4401 without getJwt is terminal immediately", async () => {
  const { client, sockets } = makeClient();
  const started = client.start({ sessionId: "auth2", jwt: "t" });
  sockets[0].open();
  await started;
  sockets[0].kill(4401);
  await delay(200);
  assert.equal(sockets.length, 1);
  assert.equal(client.state, "ended");
  client.stop();
});

test("real server: a rejected token closes 4401 (no session.ended), refresh recovers the session", async () => {
  const server = new RealtimeServer({
    port: 0,
    createEngine: () => ({ onAudio() {}, onSessionEnd() {}, dispose() {} }),
    verifyToken: (jwt) => jwt === "good",
  });
  const { url } = await server.start();
  const client = new RealtimeClient({ baseUrl: url });
  const types = [];
  client.onFrame((_raw, frame) => types.push(frame.type));
  try {
    await client.start({ sessionId: "refresh-me", jwt: "expired", getJwt: async () => "good" });
    await waitFor(() => client.getStats().reconnects === 1 && client.state === "live", 3000);
    assert.ok(!types.includes("session.ended"), "auth failure must not send a terminal session.ended");
    assert.equal(server.logs.filter((l) => l.type === "auth_failed").length, 1);
  } finally {
    client.stop();
    await server.stop();
  }
});
