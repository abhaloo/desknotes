import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { RealtimeServer } from "../src/server/ws-server.js";
import { RealtimeClient } from "../src/transport/realtime-client.js";
import { CAPABILITIES, FRAME } from "../src/shared/protocol.js";

/*
 * Clear reaches the server: `screen_clear` (capability `screen_clear`) makes
 * the engine drop the screen context it keeps for later answers.
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

test("the frame and capability are part of the protocol vocabulary", () => {
  assert.equal(FRAME.SCREEN_CLEAR, "screen_clear");
  assert.equal(CAPABILITIES.SCREEN_CLEAR, "screen_clear");
});

test("the server advertises screen_clear and routes it to the engine", async () => {
  let clears = 0;
  const server = new RealtimeServer({
    port: 0,
    createEngine: () => ({
      onSessionStart() {},
      onAudio() {},
      onFinalize() {},
      onScreenClear() {
        clears += 1;
      },
      onSessionEnd() {},
      dispose() {},
    }),
  });
  const { url } = await server.start();
  const socket = new WebSocket(url);
  const frames = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const send = (frame) => socket.send(JSON.stringify({ v: 1, ...frame }));
  try {
    const state = await waitFor(() => frames.find((frame) => frame.type === "session.state"));
    assert.ok(state.data.capabilities.includes(CAPABILITIES.SCREEN_CLEAR));
    send({ type: "hello", jwt: "t", session_id: "clear-1", streams: [], capture_authorized: false });
    send({ type: "screen_clear" });
    await waitFor(() => clears === 1);
    assert.equal(server.logs.some((entry) => entry.type === "unknown_frame"), false);
  } finally {
    socket.terminate();
    await server.stop();
  }
});

async function fakeServer(capabilities) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  const frames = [];
  wss.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (!isBinary) frames.push(JSON.parse(String(data)));
    });
    socket.send(JSON.stringify({ v: 1, type: "session.state", seq: 0, data: { capabilities } }));
  });
  return {
    url: `ws://127.0.0.1:${wss.address().port}`,
    clears: () => frames.filter((frame) => frame.type === "screen_clear"),
    hello: () => frames.some((frame) => frame.type === "hello"),
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

test("the client sends screen_clear only to a server that advertises it", async () => {
  for (const [capabilities, expected] of [
    [[CAPABILITIES.SCREEN_CLEAR], 1],
    [[], 0],
  ]) {
    const server = await fakeServer(capabilities);
    const client = new RealtimeClient({ baseUrl: server.url });
    try {
      await client.start({ sessionId: `clear-${expected}`, jwt: "t" });
      await waitFor(() => server.hello());
      if (expected) await waitFor(() => client.hasCapability(CAPABILITIES.SCREEN_CLEAR));
      else await delay(50);
      assert.equal(client.clearScreenContext(), expected === 1);
      if (expected) await waitFor(() => server.clears().length === 1);
      else await delay(50);
      assert.equal(server.clears().length, expected);
    } finally {
      client.stop();
      await server.close();
    }
  }
});

test("main's Clear tells the server to drop the screen context", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const main = readFileSync(join(here, "..", "src", "desktop", "main.mjs"), "utf8");
  const clear = main.slice(main.indexOf("function clearDisplay()"), main.indexOf("function quitApp()"));
  assert.match(clear, /state\.transport\?\.clearScreenContext\?\.\(\)/);
  assert.match(clear, /broadcast\(IPC\.DISPLAY_CLEARED/);
});
