import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";
import { WebSocket as WsClient } from "ws";
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

function recordingEngines() {
  const engines = [];
  const createEngine = ({ emit }) => {
    const engine = {
      audio: [],
      screen: [],
      onSessionStart() {
        emit({ type: "transcript", data: { text: "hello", final: false } });
      },
      onAudio(audio) {
        engine.audio.push(audio.seq);
      },
      async onScreenAnalyse(request) {
        engine.screen.push(request);
        return { status: "ok", kind: "other", analysisId: "a1" };
      },
      onSessionEnd() {},
      dispose() {},
    };
    engines.push(engine);
    return engine;
  };
  return { engines, createEngine };
}

/** Raw upgrade so a browser-style Origin header can be sent from any runtime. */
function rawUpgrade(port, origin) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
          (origin ? `Origin: ${origin}\r\n` : "") +
          "\r\n",
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
    setTimeout(() => resolve(0), 2000);
  });
}

test("Start -> End -> Start under the SAME session id delivers audio again", async () => {
  const { engines, createEngine } = recordingEngines();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  try {
    for (let round = 0; round < 2; round += 1) {
      const client = new RealtimeClient({ baseUrl: url });
      await client.start({ sessionId: "reused-id", jwt: "t" });
      for (let i = 0; i < 10; i += 1) client.sendAudio("system", new Int16Array([i]));
      await waitFor(() => engines.length === round + 1 && engines[round].audio.length === 10);
      client.stop();
      await delay(30);
    }
    assert.deepEqual(engines[1].audio, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "fresh hello resets seq accounting");
    assert.equal(server.logs.filter((l) => l.type === "dup").length, 0);
  } finally {
    await server.stop();
  }
});

test("pre-hello session.state carries the reserved seq 0; session frames number from 1", async () => {
  const { createEngine } = recordingEngines();
  const server = new RealtimeServer({ port: 0, createEngine });
  const { url } = await server.start();
  const socket = new WsClient(url);
  const frames = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data))));
  try {
    await new Promise((resolve) => socket.once("open", resolve));
    await waitFor(() => frames.length === 1);
    assert.equal(frames[0].type, "session.state");
    assert.equal(frames[0].seq, 0);
    socket.send(JSON.stringify({ v: 1, type: "hello", jwt: "t", session_id: "seq-s", streams: [] }));
    await waitFor(() => frames.length === 2);
    assert.equal(frames[1].type, "transcript");
    assert.equal(frames[1].seq, 1);
  } finally {
    socket.close();
    await server.stop();
  }
});

test("upgrades carrying a browser Origin are refused unless allowlisted", async () => {
  const { createEngine } = recordingEngines();
  const server = new RealtimeServer({ port: 0, createEngine, allowedOrigins: ["app://trusted"] });
  const { port } = await server.start();
  try {
    assert.equal(await rawUpgrade(port, "https://evil.example"), 403);
    assert.equal(await rawUpgrade(port, "null"), 403, "sandboxed/file pages send Origin: null");
    assert.equal(await rawUpgrade(port, "app://trusted"), 101);
    assert.equal(await rawUpgrade(port, null), 101, "native clients send no Origin");
    assert.ok(server.logs.some((l) => l.type === "origin_rejected"));
  } finally {
    await server.stop();
  }
});

test("a wrong token gets close 4401 and none of the session's frames, even with last_seen_seq", async () => {
  const { createEngine } = recordingEngines();
  const server = new RealtimeServer({ port: 0, createEngine, verifyToken: (jwt) => jwt === "secret" });
  const { url } = await server.start();
  const owner = new RealtimeClient({ baseUrl: url });
  try {
    await owner.start({ sessionId: "victim", jwt: "secret" });
    await waitFor(() => owner.getStats().lastSeenSeq >= 1); // the session produced a frame

    for (const jwt of ["guess", undefined]) {
      const intruder = new WsClient(url);
      const frames = [];
      intruder.on("message", (data) => frames.push(JSON.parse(String(data))));
      const closed = new Promise((resolve) => intruder.once("close", (code) => resolve(code)));
      await new Promise((resolve) => intruder.once("open", resolve));
      intruder.send(JSON.stringify({ v: 1, type: "hello", jwt, session_id: "victim", streams: [], last_seen_seq: 0 }));
      assert.equal(await closed, 4401);
      assert.deepEqual(frames.map((f) => f.type), ["session.state"], "only the pre-hello capability frame");
    }
  } finally {
    owner.stop();
    await server.stop();
  }
});

test("screen upload contract: mint -> signed PUT -> screen_analyse sees the bytes", async () => {
  const { engines, createEngine } = recordingEngines();
  const server = new RealtimeServer({ port: 0, createEngine, verifyToken: (jwt) => jwt === "secret" });
  const { url, httpUrl } = await server.start();
  const client = new RealtimeClient({ baseUrl: url });
  const results = [];
  client.onScreenResult((result) => results.push(result));
  try {
    await client.start({ sessionId: "shots", jwt: "secret" });
    await waitFor(() => engines.length === 1);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const imageHash = createHash("sha256").update(bytes).digest("hex");
    const mintUrl = `${httpUrl}/v3/sessions/shots/screen/uploads`;
    const mintBody = JSON.stringify({ content_type: "image/jpeg", image_hash: imageHash });

    const noAuth = await fetch(mintUrl, { method: "POST", body: mintBody });
    assert.equal(noAuth.status, 401);
    const crossSite = await fetch(mintUrl, {
      method: "POST",
      body: mintBody,
      headers: { authorization: "Bearer secret", origin: "https://evil.example" },
    });
    assert.equal(crossSite.status, 403);

    const minted = await fetch(mintUrl, { method: "POST", body: mintBody, headers: { authorization: "Bearer secret" } });
    assert.equal(minted.status, 200);
    const { object_path: objectPath, upload_url: uploadUrl } = await minted.json();
    assert.ok(objectPath && uploadUrl);

    const put = await fetch(uploadUrl, { method: "PUT", body: bytes, headers: { "content-type": "image/jpeg" } });
    assert.equal(put.status, 200);
    const replay = await fetch(uploadUrl, { method: "PUT", body: bytes });
    assert.equal(replay.status, 403, "upload grants are one-shot");

    assert.ok(
      client.sendScreenAnalyse({ commandId: "c1", purpose: "context", origin: "manual", imageHash, objectPath, contentType: "image/jpeg" }),
    );
    await waitFor(() => results.length === 1);
    assert.equal(results[0].status, "ok");
    assert.deepEqual([...engines[0].screen[0].imageBytes], [1, 2, 3, 4, 5]);
  } finally {
    client.stop();
    await server.stop();
  }
});
