import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeClient } from "../src/transport/realtime-client.js";
import { RealtimeServer } from "../src/server/ws-server.js";
import { createEngineFactory } from "../src/server/engines/index.js";
import { ScreenAnalyser, createHttpClient } from "../src/vision/index.js";

async function waitForCapability(client, name, ms = 1500) {
  const end = Date.now() + ms;
  while (!client.hasCapability(name) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The full socket-first path against the real local server: JSON mint, PUT to
 * the signed URL, `screen_analyse` over the socket, `screen.result` back.
 * Before the server grew the mint/upload routes this path could only ever
 * return an `upload` failure.
 */
test("screen analyse succeeds end to end against the local server (mint -> PUT -> socket)", async () => {
  const server = new RealtimeServer({
    port: 0,
    createEngine: createEngineFactory({}),
    verifyToken: (jwt) => jwt === "launch-secret",
  });
  const { url } = await server.start();
  const client = new RealtimeClient({ baseUrl: url });
  const analyser = new ScreenAnalyser({
    transport: client,
    http: createHttpClient({ baseUrl: url, getToken: () => "launch-secret" }),
    sessionIdProvider: () => "vision-e2e",
    timeoutMs: 5000,
  });
  try {
    await client.start({ sessionId: "vision-e2e", jwt: "launch-secret" });
    await waitForCapability(client, "screen_analyse");
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5]);
    const first = await analyser.analyse({ bytes, purpose: "context", origin: "manual" });
    assert.equal(first.failure, undefined, `unexpected failure: ${first.error}`);
    assert.equal(first.status, "ok");
    assert.ok(first.kind.length > 0);
    const second = await analyser.analyse({ bytes, purpose: "context", origin: "manual" });
    assert.equal(second.status, "ok");
    assert.equal(second.dedup, true, "the server's dedup verdict comes back");
  } finally {
    analyser.close();
    client.stop();
    await server.stop();
  }
});

test("a wrong token fails the mint with a typed upload failure (nothing is sent)", async () => {
  const server = new RealtimeServer({
    port: 0,
    createEngine: createEngineFactory({}),
    verifyToken: (jwt) => jwt === "launch-secret",
  });
  const { url } = await server.start();
  const client = new RealtimeClient({ baseUrl: url });
  const sent = [];
  const transport = {
    hasCapability: (name) => client.hasCapability(name),
    onScreenResult: (cb) => client.onScreenResult(cb),
    sendScreenAnalyse: (cmd) => {
      sent.push(cmd);
      return client.sendScreenAnalyse(cmd);
    },
  };
  const analyser = new ScreenAnalyser({
    transport,
    http: createHttpClient({ baseUrl: url, getToken: () => "wrong" }),
    sessionIdProvider: () => "vision-auth",
  });
  try {
    await client.start({ sessionId: "vision-auth", jwt: "launch-secret" });
    await waitForCapability(client, "screen_analyse");
    const result = await analyser.analyse({ bytes: new Uint8Array([1, 2, 3]) });
    assert.equal(result.status, "failed");
    assert.equal(result.failure, "upload");
    assert.equal(sent.length, 0);
  } finally {
    analyser.close();
    client.stop();
    await server.stop();
  }
});

test("createHttpClient never sends the bearer token to a foreign signed URL", async () => {
  const seen = [];
  const http = createHttpClient({
    baseUrl: "ws://127.0.0.1:9999",
    getToken: () => "tok",
    fetchImpl: async (href, init) => {
      seen.push({ href, auth: init.headers.authorization ?? null });
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  await http.post("v3/sessions/s/screen/uploads", { json: { a: 1 } });
  await http.put("https://storage.example/signed?sig=1", { body: new Uint8Array([1]) });
  assert.deepEqual(seen, [
    { href: "http://127.0.0.1:9999/v3/sessions/s/screen/uploads", auth: "Bearer tok" },
    { href: "https://storage.example/signed?sig=1", auth: null },
  ]);
});

test("concurrent analyses of the same image get distinct command ids (no waiter collision)", async () => {
  const listeners = new Set();
  const sent = [];
  const transport = {
    hasCapability: () => true,
    onScreenResult: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    sendScreenAnalyse: (cmd) => {
      sent.push(cmd.commandId);
      setTimeout(() => {
        for (const cb of listeners) cb({ command_id: cmd.commandId, status: "ok", kind: "other" });
      }, 5);
      return true;
    },
  };
  const http = { post: async () => ({ object_path: "o", upload_url: "https://u" }), put: async () => ({}) };
  const analyser = new ScreenAnalyser({ transport, http, sessionIdProvider: () => "s", timeoutMs: 1000 });
  const bytes = new Uint8Array([7, 7, 7]);
  const results = await Promise.all([1, 2, 3].map(() => analyser.analyse({ bytes })));
  assert.deepEqual(results.map((r) => r.status), ["ok", "ok", "ok"]);
  assert.equal(new Set(sent).size, 3, "every command id is unique");
  analyser.close();
});
