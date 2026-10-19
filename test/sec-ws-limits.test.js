import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { WebSocket } from "ws";
import { RealtimeServer } from "../src/server/ws-server.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const engine = () => ({ onSessionStart() {}, onAudio() {}, onSessionEnd() {}, dispose() {}, onScreenAnalyse: async () => ({ status: "ok" }) });

async function withServer(options, fn) {
  const server = new RealtimeServer({ port: 0, createEngine: engine, verifyToken: (jwt) => jwt === "secret", ...options });
  const addr = await server.start();
  try {
    await fn(server, addr);
  } finally {
    await server.stop();
  }
}

function rawUpgrade(port, { host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      if (buf.includes("\r\n")) {
        resolve(Number(buf.split(" ")[1]));
        socket.destroy();
      }
    });
    socket.on("error", () => resolve(-1));
  });
}

function request(port, { method = "POST", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", (e) => resolve({ status: -1, body: String(e) }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}
const closed = (ws) => new Promise((resolve) => ws.once("close", (code) => resolve(code)));
const hello = (ws, sessionId = "s1", jwt = "secret") =>
  ws.send(JSON.stringify({ v: 1, type: "hello", jwt, session_id: sessionId, streams: [], capture_authorized: true }));

test("frames above maxPayload close the socket (1009) instead of buffering 100 MiB", async () => {
  await withServer({ maxPayloadBytes: 64 * 1024 }, async (_s, { url }) => {
    const ws = await open(url);
    hello(ws);
    await sleep(50);
    const done = closed(ws);
    ws.send(new Uint8Array(65 * 1024));
    assert.equal(await done, 1009);
  });
});

test("the default maxPayload is 1 MiB", async () => {
  await withServer({}, async (server) => {
    assert.equal(server.maxPayloadBytes, 1024 * 1024);
  });
});

test("a socket that never says hello is closed with 4401 after the deadline", async () => {
  await withServer({ helloTimeoutMs: 80 }, async (_s, { url }) => {
    const ws = await open(url);
    const code = await Promise.race([closed(ws), sleep(1500).then(() => "still open")]);
    assert.equal(code, 4401);
  });
});

test("an authenticated socket is not touched by the hello deadline", async () => {
  await withServer({ helloTimeoutMs: 80 }, async (_s, { url }) => {
    const ws = await open(url);
    hello(ws);
    await sleep(250);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });
});

test("a full pending set evicts its oldest member; a newcomer is never refused", async () => {
  await withServer({ maxPendingConnections: 2, helloTimeoutMs: 5000 }, async (_s, { url, port }) => {
    const a = await open(url);
    const aClosed = closed(a);
    const b = await open(url);
    assert.equal(await rawUpgrade(port), 101, "no 503: the newcomer gets in");
    assert.equal(await aClosed, 4401, "the oldest idle socket was evicted");
    b.close();
  });
});

test("handshake auth: without the bearer the upgrade is refused (401), no socket exists", async () => {
  await withServer({ requireUpgradeAuth: true }, async (server, { url, port }) => {
    assert.equal(await rawUpgrade(port), 401);
    const withToken = new WebSocket(url, { headers: { authorization: "Bearer secret" } });
    await new Promise((resolve, reject) => {
      withToken.once("open", resolve);
      withToken.once("error", reject);
    });
    const wrong = new WebSocket(url, { headers: { authorization: "Bearer nope" } });
    const wrongResult = await new Promise((resolve) => {
      wrong.once("open", () => resolve("open"));
      // Node's ws reports the status; Bun's ws shim only raises "error" (twice).
      wrong.once("unexpected-response", (_req, res) => resolve(res.statusCode));
      wrong.on("error", () => resolve("refused"));
    });
    assert.ok(wrongResult === 401 || wrongResult === "refused", `wrong bearer refused at the handshake (${wrongResult})`);
    assert.equal(server._conns.size, 1, "only the authenticated socket exists");
    assert.ok(!JSON.stringify(server.logs).includes("secret"), "the credential is never logged");
    withToken.close();
  });
});

/**
 * The coordinator's lockout scenario: 40 idle unauthenticated sockets plus a
 * new one every few ms, while the real client connects, loses its link
 * unexpectedly, resumes and resends what the server had not acknowledged.
 */
async function floodScenario({ requireUpgradeAuth }) {
  const { RealtimeClient } = await import("../src/transport/realtime-client.js");
  const received = new Map(); // sessionId -> Set(seq) for stream 0
  const server = new RealtimeServer({
    port: 0,
    verifyToken: (jwt) => jwt === "secret",
    requireUpgradeAuth,
    maxPendingConnections: 8,
    createEngine: () => {
      let sid = null;
      return {
        onSessionStart({ sessionId }) {
          sid = sessionId;
          if (!received.has(sid)) received.set(sid, new Set());
        },
        onAudio({ streamIdx, seq }) {
          if (streamIdx === 0) received.get(sid)?.add(seq);
        },
        onSessionEnd() {},
        dispose() {},
      };
    },
  });
  const { url } = await server.start();
  const attackers = [];
  const spawnAttacker = () => {
    const ws = new WebSocket(url);
    ws.on("error", () => {});
    ws.on("unexpected-response", () => {});
    attackers.push(ws);
  };
  for (let i = 0; i < 40; i += 1) spawnAttacker();
  const flood = setInterval(spawnAttacker, 3);
  const createSocket = (target) =>
    new WebSocket(target, requireUpgradeAuth ? { headers: { authorization: "Bearer secret" } } : undefined);
  const client = new RealtimeClient({ baseUrl: url, createSocket });
  const frame = () => new Int16Array(512);
  try {
    await sleep(100); // the flood is established before the client arrives
    await client.start({ sessionId: "legit", jwt: "secret", topology: "general", captureAuthorized: true });
    for (let i = 0; i < 5; i += 1) client.sendAudio("microphone", frame());
    await sleep(100);
    // Unexpected drop (server side), then audio captured while the link is down.
    for (const conn of server._conns) if (conn.sessionId === "legit") conn.socket.terminate();
    for (let i = 0; i < 5; i += 1) client.sendAudio("microphone", frame());
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && (received.get("legit")?.size ?? 0) < 10) await sleep(20);
    return { state: client.state, seqs: [...(received.get("legit") ?? [])].sort((a, b) => a - b) };
  } finally {
    clearInterval(flood);
    client.stop();
    for (const ws of attackers) ws.terminate?.();
    await server.stop();
  }
}

for (const requireUpgradeAuth of [false, true]) {
  test(`a flood of idle unauthenticated sockets cannot lock the client out (upgrade auth: ${requireUpgradeAuth})`, async () => {
    const result = await floodScenario({ requireUpgradeAuth });
    assert.equal(result.state, "live", "connected, dropped and resumed under flood");
    assert.deepEqual(result.seqs, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "every frame arrived, including those sent while the link was down");
  });
}

test("the Host check accepts every loopback spelling the clients use", async () => {
  await withServer({}, async (_s, { port }) => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
      assert.equal(await rawUpgrade(port, { host }), 101, host);
    }
  });
});

test("DNS-rebinding defence: a non-loopback Host header is refused on upgrade and HTTP", async () => {
  await withServer({}, async (_s, { port }) => {
    assert.equal(await rawUpgrade(port, { host: "evil.example.com" }), 403);
    assert.equal(await rawUpgrade(port, { host: `localhost:${port}` }), 101);
    assert.equal(await rawUpgrade(port, { host: "127.0.0.1:1" }), 101, "any loopback port (local proxies)");
    const mint = await request(port, {
      path: "/v3/sessions/s1/screen/uploads",
      headers: { host: "evil.example.com", authorization: "Bearer secret" },
      body: "{}",
    });
    assert.equal(mint.status, 403);
  });
});

test("idle sessions are evicted once no connection holds them", async () => {
  await withServer({ sessionIdleMs: 50 }, async (server, { url }) => {
    const a = await open(url);
    hello(a, "old-session");
    await sleep(50);
    a.close();
    await sleep(120);
    const b = await open(url);
    hello(b, "new-session");
    await sleep(50);
    assert.equal(server._sessions.has("old-session"), false);
    assert.equal(server._sessions.has("new-session"), true);
    b.close();
  });
});

test("upload contract: image allowlist at mint, exact content type at PUT, bounded grants", async () => {
  await withServer({}, async (server, { url, port }) => {
    const ws = await open(url);
    hello(ws, "up");
    await sleep(50);
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const imageHash = createHash("sha256").update(bytes).digest("hex");
    const mint = (contentType) =>
      request(port, {
        path: "/v3/sessions/up/screen/uploads",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ content_type: contentType, image_hash: imageHash }),
      });
    assert.equal((await mint("image/svg+xml")).status, 400, "SVG (scriptable) is not a screenshot type");
    assert.equal((await mint("text/html")).status, 400);

    const ok = await mint("image/jpeg");
    assert.equal(ok.status, 200);
    const { upload_url: uploadUrl } = JSON.parse(ok.body);
    const putPath = new URL(uploadUrl).pathname;
    const wrongType = await request(port, { method: "PUT", path: putPath, headers: { "content-type": "image/png" }, body: bytes });
    assert.equal(wrongType.status, 415);

    const again = JSON.parse((await mint("image/jpeg")).body);
    const good = await request(port, { method: "PUT", path: new URL(again.upload_url).pathname, headers: { "content-type": "image/jpeg; charset=binary" }, body: bytes });
    assert.equal(good.status, 200, "parameters on the content type are tolerated");

    // Outstanding (unused) grants per session are bounded: the oldest is
    // evicted rather than refusing (hash-first `exists` leaves grants unused).
    const statuses = [];
    for (let i = 0; i < 20; i += 1) statuses.push((await mint("image/png")).status);
    assert.ok(statuses.every((st) => st === 200), `minting keeps working: ${statuses}`);
    const outstanding = [...server._uploads.values()].filter((e) => e.sessionId === "up").length;
    assert.ok(outstanding <= 8, `grants bounded per session (${outstanding})`);
    ws.close();
  });
});

test("HTTP request and header timeouts are bounded", async () => {
  await withServer({}, async (server) => {
    const httpServer = server._http;
    if (typeof httpServer.headersTimeout === "number") assert.ok(httpServer.headersTimeout <= 10_000);
    if (typeof httpServer.requestTimeout === "number") assert.ok(httpServer.requestTimeout > 0 && httpServer.requestTimeout <= 30_000);
  });
});
