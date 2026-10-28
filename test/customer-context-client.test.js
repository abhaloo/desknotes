import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { RealtimeClient } from "../src/transport/realtime-client.js";
import { CAPABILITIES } from "../src/shared/protocol.js";

/**
 * The selected customer profile on the client side of `session_context`:
 * main hands `{docs, name, customer: {name, docs}}` to start() or
 * setSessionContext(); the client keeps the whole context for the session,
 * sends it on every connection, and sends it again when it changes. A
 * context with a profile but no grounding document is still a context.
 */

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
        const timer = setTimeout(resolve, 500);
        wss.close(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}

const ACME = { name: "Acme Corp", docs: "File: deals.csv\n\n## Acme Corp\n- Stage: Closed Won" };
const GLOBEX = { name: "Globex", docs: "File: notes.md\n\nPrefers annual billing." };

test("a customer passed to start() goes out with the document in one session_context frame", async () => {
  const server = await fakeServer();
  const client = new RealtimeClient({ baseUrl: server.url });
  try {
    await client.start({ sessionId: "cust-start", jwt: "t", context: { docs: "Pricing: forty a seat.", name: "product.md", customer: ACME } });
    await waitFor(() => server.contexts(server.connections[0]).length === 1);
    assert.deepEqual(server.types(server.connections[0]).slice(0, 2), ["hello", "session_context"]);
    const frame = server.contexts(server.connections[0])[0];
    assert.deepEqual(frame, { v: 1, type: "session_context", docs: "Pricing: forty a seat.", name: "product.md", customer: ACME });
    assert.deepEqual(client.session.context, { docs: "Pricing: forty a seat.", name: "product.md", customer: ACME }, "held for the session");
  } finally {
    client.stop();
    await server.close();
  }
});

test("a profile without a grounding document is still a context: docs '' plus the customer, and no name", async () => {
  const server = await fakeServer();
  const client = new RealtimeClient({ baseUrl: server.url });
  try {
    await client.start({ sessionId: "cust-only", jwt: "t", context: { docs: "", customer: ACME } });
    await waitFor(() => server.contexts(server.connections[0]).length === 1);
    const frame = server.contexts(server.connections[0])[0];
    assert.equal(frame.docs, "");
    assert.equal("name" in frame, false);
    assert.deepEqual(frame.customer, ACME);
    assert.deepEqual(client.session.context, { docs: "", name: "", customer: ACME });
  } finally {
    client.stop();
    await server.close();
  }
});

test("a customer with no text, or a non-object, is no customer; with no document either there is no context", async () => {
  const server = await fakeServer();
  const client = new RealtimeClient({ baseUrl: server.url });
  try {
    await client.start({ sessionId: "cust-empty", jwt: "t", context: { docs: "", customer: { name: "Acme Corp", docs: "" } } });
    await waitFor(() => client.hasCapability(CAPABILITIES.SESSION_CONTEXT));
    await delay(50);
    assert.equal(server.contexts(server.connections[0]).length, 0, "nothing to send");
    assert.equal(client.session.context, null);
    assert.equal(client.setSessionContext({ docs: "", customer: "Acme Corp" }), false, "nothing held, nothing to clear");
    assert.equal(client.setSessionContext({ docs: "", customer: { docs: 42 } }), false);

    assert.equal(client.setSessionContext({ docs: "facts", customer: { name: "Acme Corp", docs: "" } }), true);
    await waitFor(() => server.contexts(server.connections[0]).length === 1);
    const frame = server.contexts(server.connections[0])[0];
    assert.equal(frame.docs, "facts");
    assert.equal("customer" in frame, false, "an empty customer is not sent");
  } finally {
    client.stop();
    await server.close();
  }
});

test("a customer's missing or non-string name is left out of the frame", async () => {
  const server = await fakeServer();
  const client = new RealtimeClient({ baseUrl: server.url });
  try {
    await client.start({ sessionId: "cust-noname", jwt: "t", context: { docs: "facts", customer: { docs: ACME.docs } } });
    await waitFor(() => server.contexts(server.connections[0]).length === 1);
    assert.deepEqual(server.contexts(server.connections[0])[0].customer, { docs: ACME.docs });
    client.setSessionContext({ docs: "facts", customer: { name: 42, docs: ACME.docs } });
    await waitFor(() => server.contexts(server.connections[0]).length === 2);
    assert.deepEqual(server.contexts(server.connections[0])[1].customer, { docs: ACME.docs });
  } finally {
    client.stop();
    await server.close();
  }
});

test("setSessionContext while live: switch the profile, drop it, keep the document; a clear sends docs '' alone", async () => {
  const server = await fakeServer();
  const client = new RealtimeClient({ baseUrl: server.url });
  try {
    await client.start({ sessionId: "cust-live", jwt: "t" });
    await waitFor(() => client.hasCapability(CAPABILITIES.SESSION_CONTEXT));
    assert.equal(client.setSessionContext({ docs: "facts", name: "a.md", customer: ACME }), true);
    assert.equal(client.setSessionContext({ docs: "facts", name: "a.md", customer: GLOBEX }), true, "a switch is a new whole state");
    assert.equal(client.setSessionContext({ docs: "facts", name: "a.md" }), true, "dropping the profile keeps the document");
    assert.equal(client.setSessionContext({ docs: "", customer: ACME }), true, "dropping the document keeps the profile");
    assert.equal(client.setSessionContext(null), true);
    assert.equal(client.setSessionContext(null), false, "clearing nothing sends nothing");
    await waitFor(() => server.contexts(server.connections[0]).length === 5);
    const [first, switched, dropped, profileOnly, cleared] = server.contexts(server.connections[0]);
    assert.deepEqual(first.customer, ACME);
    assert.deepEqual(switched.customer, GLOBEX);
    assert.equal(switched.docs, "facts");
    assert.equal("customer" in dropped, false);
    assert.equal(dropped.docs, "facts");
    assert.equal(profileOnly.docs, "");
    assert.equal("name" in profileOnly, false);
    assert.deepEqual(profileOnly.customer, ACME);
    assert.deepEqual(cleared, { v: 1, type: "session_context", docs: "" });
  } finally {
    client.stop();
    await server.close();
  }
});

test("the profile is sent again after a dropped link reconnects, and after a reconnect from offline", async () => {
  const server = await fakeServer();
  const client = new RealtimeClient({ baseUrl: server.url });
  try {
    await client.start({ sessionId: "cust-reconnect", jwt: "t", context: { docs: "", customer: ACME } });
    await waitFor(() => server.contexts(server.connections[0]).length === 1);
    server.connections[0].socket.terminate();
    await waitFor(() => server.connections.length === 2 && server.contexts(server.connections[1]).length === 1, 5000);
    assert.deepEqual(server.types(server.connections[1]).slice(0, 2), ["hello", "session_context"]);
    assert.deepEqual(server.contexts(server.connections[1])[0].customer, ACME);

    client.disconnect();
    assert.equal(client.setSessionContext({ docs: "facts", customer: GLOBEX }), false, "stored, not sent");
    await client.reconnect();
    await waitFor(() => server.connections.length === 3 && server.contexts(server.connections[2]).length === 1, 5000);
    const frame = server.contexts(server.connections[2])[0];
    assert.equal(frame.docs, "facts");
    assert.deepEqual(frame.customer, GLOBEX);
    assert.equal(server.contexts(server.connections[1]).length, 1, "the old link got nothing more");
  } finally {
    client.stop();
    await server.close();
  }
});

test("no capability means no frame, even with a profile", async () => {
  const server = await fakeServer({ capabilities: [] });
  const client = new RealtimeClient({ baseUrl: server.url });
  try {
    await client.start({ sessionId: "cust-nocap", jwt: "t", context: { docs: "", customer: ACME } });
    await waitFor(() => server.connections[0] && server.types(server.connections[0]).includes("hello"));
    await delay(100);
    assert.equal(server.contexts(server.connections[0]).length, 0);
    assert.equal(client.setSessionContext({ docs: "", customer: GLOBEX }), false);
  } finally {
    client.stop();
    await server.close();
  }
});
