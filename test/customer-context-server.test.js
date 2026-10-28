import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { RealtimeServer } from "../src/server/ws-server.js";
import { CUSTOMER_CHARS } from "../src/shared/context-budget.js";

/**
 * `session_context.customer` on the wire (docs/protocol.md): the selected
 * customer profile, `{name?, docs}`, beside the grounding document. The
 * server validates it on its own: a bad customer is dropped and logged and
 * the frame's document still applies (the rep keeps the grounding document
 * they loaded; the profile is reported, not silently lost). The name is cut
 * to 200, the engine gets `{docs, name, customer: {name, docs}}`, and logs
 * carry lengths only.
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
const ACME_DOCS = "File: deals.csv\n\n## Acme Corp\n- Stage: Closed Won";

async function withServer(fn) {
  const { seen, createEngine } = contextEngine();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const link = await connect(url);
  try {
    await fn({ server, link, seen });
  } finally {
    link.socket.terminate();
    await server.stop();
  }
}

test("a customer beside the document reaches the engine whole; without one the engine sees no customer field", () =>
  withServer(async ({ server, link, seen }) => {
    link.send(hello("cust-1"));
    link.send({ type: "session_context", docs: "Pricing: forty a seat.", name: "product.md", customer: { name: "Acme Corp", docs: ACME_DOCS } });
    await waitFor(() => seen.contexts.length === 1);
    assert.deepEqual(seen.contexts[0], { docs: "Pricing: forty a seat.", name: "product.md", customer: { name: "Acme Corp", docs: ACME_DOCS } });

    link.send({ type: "session_context", docs: "Pricing: forty a seat.", name: "product.md" });
    await waitFor(() => seen.contexts.length === 2);
    assert.deepEqual(seen.contexts[1], { docs: "Pricing: forty a seat.", name: "product.md" }, "the frame is the whole state: no customer means none");
    assert.equal("customer" in seen.contexts[1], false);

    link.send({ type: "session_context", docs: "", customer: { name: "Acme Corp", docs: ACME_DOCS } });
    await waitFor(() => seen.contexts.length === 3);
    assert.deepEqual(seen.contexts[2], { docs: "", name: "", customer: { name: "Acme Corp", docs: ACME_DOCS } }, "a profile without a grounding document");

    link.send({ type: "session_context", docs: "" });
    await waitFor(() => seen.contexts.length === 4);
    assert.deepEqual(seen.contexts[3], { docs: "", name: "" });

    const entries = server.logs.filter((log) => log.type === "session_context");
    assert.equal(entries.length, 4);
    assert.equal(entries[0].chars, "Pricing: forty a seat.".length);
    assert.equal(entries[0].customer_chars, ACME_DOCS.length);
    assert.equal(entries[1].customer_chars, 0);
    assert.equal(entries[2].chars, 0);
    assert.equal(entries[2].customer_chars, ACME_DOCS.length);
    assert.ok(!JSON.stringify(server.logs).includes("Acme"), "logs carry lengths, never the profile text or the account name");
  }));

test("a customer that is not an object, or whose docs are not a string or too long, is dropped and logged; the document still applies", () =>
  withServer(async ({ server, link, seen }) => {
    assert.equal(CUSTOMER_CHARS, 15_000, "the wire guard is the pipeline's cap: what is accepted is never trimmed");
    link.send(hello("cust-2"));
    const bad = ["Acme", 42, ["x"], { name: "Acme" }, { name: "Acme", docs: 42 }, { name: "Acme", docs: "x".repeat(CUSTOMER_CHARS + 1) }];
    for (const customer of bad) link.send({ type: "session_context", docs: "facts", name: "a.md", customer });
    link.send({ type: "session_context", docs: "ok", customer: { name: "Acme", docs: "x".repeat(CUSTOMER_CHARS) } });
    await waitFor(() => seen.contexts.length === bad.length + 1);
    for (let i = 0; i < bad.length; i += 1) {
      assert.deepEqual(seen.contexts[i], { docs: "facts", name: "a.md" }, `bad customer ${i}: the document applies, the customer does not`);
    }
    const good = seen.contexts[bad.length];
    assert.equal(good.docs, "ok");
    assert.equal(good.customer.docs.length, CUSTOMER_CHARS, "exactly the cap is accepted");
    const dropped = server.logs.filter((log) => log.type === "bad_customer_context");
    assert.deepEqual(
      dropped.map((log) => log.customer_chars),
      [null, null, null, null, null, CUSTOMER_CHARS + 1],
      "a length only when docs is a string",
    );
    assert.ok(dropped.every((log) => log.sessionId === "cust-2"));
    const applied = server.logs.filter((log) => log.type === "session_context");
    assert.equal(applied.length, bad.length + 1);
    assert.ok(applied.slice(0, bad.length).every((log) => log.customer_chars === 0), "the applied frame had no customer");
    assert.equal(applied[bad.length].customer_chars, CUSTOMER_CHARS);
    assert.equal(server.logs.filter((log) => log.type === "bad_session_context").length, 0, "the frame itself was fine");
  }));

test("an empty customer is no customer; a missing or non-string name is ''; a long name is cut to 200", () =>
  withServer(async ({ link, seen }) => {
    link.send(hello("cust-3"));
    link.send({ type: "session_context", docs: "facts", customer: { name: "Acme", docs: "" } });
    link.send({ type: "session_context", docs: "facts", customer: null });
    link.send({ type: "session_context", docs: "facts", customer: { docs: ACME_DOCS } });
    link.send({ type: "session_context", docs: "facts", customer: { name: 42, docs: ACME_DOCS } });
    link.send({ type: "session_context", docs: "facts", customer: { name: "n".repeat(300), docs: ACME_DOCS } });
    await waitFor(() => seen.contexts.length === 5);
    assert.deepEqual(seen.contexts[0], { docs: "facts", name: "" }, "empty docs: no customer");
    assert.deepEqual(seen.contexts[1], { docs: "facts", name: "" }, "null: no customer");
    assert.deepEqual(seen.contexts[2], { docs: "facts", name: "", customer: { name: "", docs: ACME_DOCS } });
    assert.deepEqual(seen.contexts[3], { docs: "facts", name: "", customer: { name: "", docs: ACME_DOCS } });
    assert.equal(seen.contexts[4].customer.name.length, 200);
  }));

test("a bad document still drops the whole frame, customer included: docs is the frame's anchor", () =>
  withServer(async ({ server, link, seen }) => {
    link.send(hello("cust-4"));
    link.send({ type: "session_context", docs: 42, customer: { name: "Acme", docs: ACME_DOCS } });
    link.send({ type: "session_context", docs: "x".repeat(32_001), customer: { name: "Acme", docs: ACME_DOCS } });
    link.send({ type: "session_context", docs: "ok", customer: { name: "Acme", docs: ACME_DOCS } });
    await waitFor(() => seen.contexts.length === 1);
    assert.deepEqual(seen.contexts[0], { docs: "ok", name: "", customer: { name: "Acme", docs: ACME_DOCS } });
    assert.equal(server.logs.filter((log) => log.type === "bad_session_context").length, 2);
    assert.equal(server.logs.filter((log) => log.type === "bad_customer_context").length, 0);
  }));
