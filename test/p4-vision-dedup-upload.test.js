import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeClient } from "../src/transport/realtime-client.js";
import { RealtimeServer } from "../src/server/ws-server.js";
import { createEngineFactory } from "../src/server/engines/index.js";
import { ScreenAnalyser, createHttpClient } from "../src/vision/index.js";

/** Counts control-plane requests by method so the test can see a skipped PUT. */
function countingFetch() {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push(init?.method ?? "GET");
    return globalThis.fetch(url, init);
  };
  return { calls, fetchImpl };
}

test("F9: an unchanged screenshot skips the upload (hash-first mint) and still gets the dedup verdict", async () => {
  const server = new RealtimeServer({
    port: 0,
    createEngine: createEngineFactory({}),
    verifyToken: (jwt) => jwt === "secret",
  });
  const { url } = await server.start();
  const client = new RealtimeClient({ baseUrl: url });
  const { calls, fetchImpl } = countingFetch();
  const analyser = new ScreenAnalyser({
    transport: client,
    http: createHttpClient({ baseUrl: url, getToken: () => "secret", fetchImpl }),
    sessionIdProvider: () => "dedup-upload",
    timeoutMs: 5000,
  });
  try {
    await client.start({ sessionId: "dedup-upload", jwt: "secret" });
    // start() resolves on OPEN; the capability frame lands right after.
    for (let i = 0; i < 200 && !client.hasCapability("screen_analyse"); i++) await new Promise((r) => setTimeout(r, 5));
    const bytes = new Uint8Array(200_000).fill(7);
    const first = await analyser.analyse({ bytes });
    assert.equal(first.status, "ok", first.error);
    assert.deepEqual(calls, ["POST", "PUT"], "first time: mint + upload");

    const second = await analyser.analyse({ bytes });
    assert.equal(second.status, "ok", second.error);
    assert.equal(second.dedup, true, "the server's dedup verdict comes back");
    assert.deepEqual(calls, ["POST", "PUT", "POST"], "unchanged screen: mint only, no upload");

    const changed = await analyser.analyse({ bytes: new Uint8Array(200_000).fill(8) });
    assert.equal(changed.status, "ok", changed.error);
    assert.equal(changed.dedup, false);
    assert.deepEqual(calls.slice(3), ["POST", "PUT"], "a new image is uploaded");
  } finally {
    analyser.close();
    client.stop();
    await server.stop();
  }
});

test("F9: the mint reports `exists` only for an object stored in the SAME session", async () => {
  const server = new RealtimeServer({ port: 0, createEngine: createEngineFactory({}) });
  const { url } = await server.start();
  const http = () => createHttpClient({ baseUrl: url, getToken: () => "t" });
  const a = new RealtimeClient({ baseUrl: url });
  const b = new RealtimeClient({ baseUrl: url });
  const analyserA = new ScreenAnalyser({ transport: a, http: http(), sessionIdProvider: () => "sess-a", timeoutMs: 5000 });
  try {
    await a.start({ sessionId: "sess-a", jwt: "t" });
    await b.start({ sessionId: "sess-b", jwt: "t" });
    for (let i = 0; i < 200 && !a.hasCapability("screen_analyse"); i++) await new Promise((r) => setTimeout(r, 5));
    const bytes = new Uint8Array(1000).fill(3);
    await analyserA.analyse({ bytes });
    const { hashImage } = await import("../src/vision/index.js");
    const body = { content_type: "image/jpeg", image_hash: hashImage(bytes) };
    const mintA = await http().post("v3/sessions/sess-a/screen/uploads", { json: body });
    const mintB = await http().post("v3/sessions/sess-b/screen/uploads", { json: body });
    assert.equal(mintA.exists, true);
    assert.equal(mintB.exists, undefined, "another session never learns about it");
    assert.ok(mintB.upload_url, "upload_url is always minted (older clients)");
  } finally {
    analyserA.close();
    a.stop();
    b.stop();
    await server.stop();
  }
});
