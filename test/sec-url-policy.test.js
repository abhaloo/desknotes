import test from "node:test";
import assert from "node:assert/strict";
import {
  checkProviderUrl,
  checkRealtimeUrl,
  isLoopbackHost,
  redactSecrets,
  sameOrigin,
} from "../src/security/url-policy.js";

test("loopback detection covers localhost, 127/8 and ::1 only", () => {
  for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["example.com", "localhost.example.com", "10.0.0.1", "0.0.0.0", "128.0.0.1", "", null]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test("provider URLs must be https unless they point at loopback", () => {
  assert.deepEqual(checkProviderUrl("https://api.example.com/v1/"), { ok: true, url: "https://api.example.com/v1" });
  assert.equal(checkProviderUrl("http://127.0.0.1:9000/v1").ok, true);
  assert.equal(checkProviderUrl("http://localhost:9000/v1").ok, true);

  assert.deepEqual(checkProviderUrl("http://api.example.com/v1"), { ok: false, reason: "insecure_scheme" });
  assert.deepEqual(checkProviderUrl("ftp://api.example.com"), { ok: false, reason: "unsupported_scheme" });
  assert.deepEqual(checkProviderUrl("file:///etc/passwd"), { ok: false, reason: "unsupported_scheme" });
  assert.deepEqual(checkProviderUrl("not a url"), { ok: false, reason: "invalid_url" });
  assert.deepEqual(checkProviderUrl(undefined), { ok: false, reason: "invalid_url" });
});

test("provider URLs never carry credentials (they would leak into logs and errors)", () => {
  assert.deepEqual(checkProviderUrl("https://user:secret@api.example.com/v1"), {
    ok: false,
    reason: "credentials_in_url",
  });
});

test("realtime URLs must be wss unless they point at loopback", () => {
  assert.equal(checkRealtimeUrl("wss://rt.example.com/v3/realtime").ok, true);
  assert.equal(checkRealtimeUrl("ws://127.0.0.1:8787").ok, true);
  assert.equal(checkRealtimeUrl("ws://localhost:8787").ok, true);
  assert.deepEqual(checkRealtimeUrl("ws://rt.example.com/v3/realtime"), { ok: false, reason: "insecure_scheme" });
  assert.deepEqual(checkRealtimeUrl("https://rt.example.com"), { ok: false, reason: "unsupported_scheme" });
  assert.deepEqual(checkRealtimeUrl("wss://u:p@rt.example.com"), { ok: false, reason: "credentials_in_url" });
});

test("sameOrigin compares scheme, host and port", () => {
  assert.equal(sameOrigin("https://a.example.com/v1", "https://a.example.com/other"), true);
  assert.equal(sameOrigin("https://a.example.com", "https://b.example.com"), false);
  assert.equal(sameOrigin("https://a.example.com", "http://a.example.com"), false);
  assert.equal(sameOrigin("https://a.example.com:8443", "https://a.example.com"), false);
  assert.equal(sameOrigin(undefined, "https://a.example.com"), false);
  assert.equal(sameOrigin("garbage", "garbage"), false);
});

test("redactSecrets removes every non-trivial secret occurrence", () => {
  const out = redactSecrets("Bearer sk-live-123456 failed for sk-live-123456 at host", ["sk-live-123456", "", undefined, "ab"]);
  assert.equal(out.includes("sk-live-123456"), false);
  assert.match(out, /\[redacted\]/);
  // Very short "secrets" are ignored: redacting "ab" everywhere would mangle
  // messages without protecting anything.
  assert.equal(redactSecrets("about", ["ab"]), "about");
  assert.equal(redactSecrets(undefined, ["x"]), "");
});

test("vision upload client: the bearer and screenshots only travel over TLS or loopback, never via redirects", async () => {
  const { createHttpClient } = await import("../src/vision/index.js");
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  // A remote plaintext root is refused outright: the bearer would go in clear.
  assert.throws(() => createHttpClient({ baseUrl: "ws://realtime.example.com/v3", fetchImpl }), /insecure_scheme/);

  const local = createHttpClient({ baseUrl: "ws://127.0.0.1:9", getToken: () => "t", fetchImpl });
  // A mint answer pointing the screenshot PUT at a plaintext remote host is refused.
  await assert.rejects(local.put("http://exfil.example.com/upload", { body: new Uint8Array([1]) }), /insecure_scheme/);
  await assert.rejects(local.put("file:///C:/x", { body: new Uint8Array([1]) }), /unsupported_scheme|refused/);
  assert.equal(seen.length, 0, "nothing was sent");

  await local.put("https://storage.example/signed?sig=1", { body: new Uint8Array([1]), contentType: "image/jpeg" });
  await local.post("v3/sessions/s/screen/uploads", { json: {} });
  assert.equal(seen.length, 2);
  for (const { init } of seen) assert.equal(init.redirect, "error", "redirects are never followed");
  assert.equal(seen[0].init.headers.authorization, undefined, "no bearer to the foreign signed URL");
  assert.equal(seen[1].init.headers.authorization, "Bearer t");

  const secure = createHttpClient({ baseUrl: "wss://realtime.example.com/v3", getToken: () => "t", fetchImpl });
  await secure.post("v3/x", { json: {} });
  assert.match(seen[2].url, /^https:\/\/realtime\.example\.com\//);
});
