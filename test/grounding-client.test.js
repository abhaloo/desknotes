import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { RealtimeClient } from "../src/transport/realtime-client.js";
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

/** A bare server: announces capabilities on connect and records every JSON frame. */
async function fakeServer({ capabilities = [CAPABILITIES.SESSION_CONTEXT] } = {}) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  const connections = [];
  wss.on("connection", (socket) => {
    const conn = { socket, frames: [] };
    connections.push(conn);
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        conn.frames.push(JSON.parse(String(data)));
      } catch {
        /* not JSON */
      }
    });
    socket.send(JSON.stringify({ v: 1, type: "session.state", seq: 0, data: { capabilities } }));
  });
  return {
    url: `ws://127.0.0.1:${wss.address().port}`,
    connections,
    types: (conn) => conn.frames.map((frame) => frame.type).filter((type) => type !== "ping"),
    contexts: (conn) => (conn ? conn.frames.filter((frame) => frame.type === "session_context") : []),
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        // Bun's ws shim can skip the close callback after a terminate: bounded
        // fallback, as RealtimeServer.stop() does.
        const timer = setTimeout(resolve, 500);
        wss.close(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}

test("a context passed to start() goes out right after hello once the server advertises it", async () => {
  const server = await fakeServer();
  const client = new RealtimeClient({ baseUrl: server.url });
  try {
    await client.start({ sessionId: "ctx-start", jwt: "t", context: { docs: "Led the Acme migration.", name: "resume.md" } });
    await waitFor(() => server.contexts(server.connections[0]).length === 1);
    assert.deepEqual(server.types(server.connections[0]).slice(0, 2), ["hello", "session_context"]);
    const frame = server.contexts(server.connections[0])[0];
    assert.equal(frame.docs, "Led the Acme migration.");
    assert.equal(frame.name, "resume.md");
  } finally {
    client.stop();
    await server.close();
  }
});

test("no capability, or no document, means no frame", async () => {
  const server = await fakeServer({ capabilities: [] });
  const client = new RealtimeClient({ baseUrl: server.url });
  try {
    await client.start({ sessionId: "ctx-nocap", jwt: "t", context: { docs: "facts", name: "a.md" } });
    await waitFor(() => server.connections[0] && server.types(server.connections[0]).includes("hello"));
    await delay(100);
    assert.equal(server.contexts(server.connections[0]).length, 0);
    assert.equal(client.setSessionContext({ docs: "more facts" }), false);
  } finally {
    client.stop();
    await server.close();
  }
  const empty = await fakeServer();
  const second = new RealtimeClient({ baseUrl: empty.url });
  try {
    await second.start({ sessionId: "ctx-empty", jwt: "t", context: { docs: "" } });
    await waitFor(() => second.hasCapability(CAPABILITIES.SESSION_CONTEXT));
    await delay(50);
    assert.equal(empty.contexts(empty.connections[0]).length, 0);
  } finally {
    second.stop();
    await empty.close();
  }
});

test("the document is sent again after a dropped link reconnects", async () => {
  const server = await fakeServer();
  const client = new RealtimeClient({ baseUrl: server.url });
  try {
    await client.start({ sessionId: "ctx-reconnect", jwt: "t", context: { docs: "facts", name: "a.md" } });
    await waitFor(() => server.contexts(server.connections[0]).length === 1);
    server.connections[0].socket.terminate();
    await waitFor(() => server.connections.length === 2 && server.contexts(server.connections[1]).length === 1, 5000);
    assert.deepEqual(server.types(server.connections[1]).slice(0, 2), ["hello", "session_context"]);
    assert.equal(server.contexts(server.connections[1])[0].docs, "facts");
  } finally {
    client.stop();
    await server.close();
  }
});

test("setSessionContext sends while live; a clear sends docs ''; clearing nothing sends nothing", async () => {
  const server = await fakeServer();
  const client = new RealtimeClient({ baseUrl: server.url });
  try {
    await client.start({ sessionId: "ctx-live", jwt: "t" });
    await waitFor(() => client.hasCapability(CAPABILITIES.SESSION_CONTEXT));
    assert.equal(server.contexts(server.connections[0]).length, 0, "nothing loaded, nothing sent");
    assert.equal(client.setSessionContext({ docs: "new facts", name: "b.md" }), true);
    assert.equal(client.setSessionContext(null), true);
    assert.equal(client.setSessionContext(null), false, "clearing nothing sends nothing");
    await waitFor(() => server.contexts(server.connections[0]).length === 2);
    const [set, cleared] = server.contexts(server.connections[0]);
    assert.equal(set.docs, "new facts");
    assert.equal(set.name, "b.md");
    assert.equal(cleared.docs, "");
    assert.equal("name" in cleared, false);
  } finally {
    client.stop();
    await server.close();
  }
});

test("offline then reconnect: a document set while the link is down goes out on the next link", async () => {
  const server = await fakeServer();
  const client = new RealtimeClient({ baseUrl: server.url });
  try {
    await client.start({ sessionId: "ctx-offline", jwt: "t" });
    await waitFor(() => client.hasCapability(CAPABILITIES.SESSION_CONTEXT));
    client.disconnect();
    assert.equal(client.setSessionContext({ docs: "offline facts", name: "c.md" }), false, "stored, not sent");
    await client.reconnect();
    await waitFor(() => server.connections.length === 2 && server.contexts(server.connections[1]).length === 1, 5000);
    assert.equal(server.contexts(server.connections[1])[0].docs, "offline facts");
    assert.equal(server.contexts(server.connections[0]).length, 0);
  } finally {
    client.stop();
    await server.close();
  }
});

test("setSessionContext before start() is a no-op", () => {
  const client = new RealtimeClient({ baseUrl: "ws://127.0.0.1:9" });
  assert.equal(client.setSessionContext({ docs: "x" }), false);
});
