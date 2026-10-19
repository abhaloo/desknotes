/**
 * Runs the realtime client against the real server under a NON-Bun runtime
 * (Electron's Node 20 via ELECTRON_RUN_AS_NODE, or Node with the global
 * WebSocket disabled). Bun ships a global WebSocket, which is exactly why the
 * "WebSocket is not defined" launch failure never showed up under `bun test`.
 *
 * Prints one JSON line with the observations; the test asserts on it.
 */
import { RealtimeClient } from "../../src/transport/realtime-client.js";
import { RealtimeServer } from "../../src/server/ws-server.js";
import { createEngineFactory } from "../../src/server/engines/index.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) return false;
    await delay(10);
  }
  return true;
}

function tone(samples) {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = Math.round(9000 * Math.sin(i / 7));
  return out;
}

const report = {
  runtime: process.versions.electron ? `electron-${process.versions.electron}` : `node-${process.versions.node}`,
  node: process.versions.node,
  globalWebSocket: typeof globalThis.WebSocket,
  sessions: [],
};

const server = new RealtimeServer({
  port: 0,
  createEngine: createEngineFactory({}),
  verifyToken: (jwt) => jwt === "local-secret",
});
const { url } = await server.start();

try {
  // Start -> End -> Start under one process, like the desktop shell.
  for (let round = 0; round < 2; round += 1) {
    const client = new RealtimeClient({ baseUrl: url }); // DEFAULT socket factory
    const types = [];
    let binaryDownlink = 0;
    client.onFrame((raw, frame) => {
      if (typeof raw !== "string") binaryDownlink += 1;
      types.push(frame.type);
    });
    const entry = { round, started: false, error: null };
    try {
      await client.start({ sessionId: `node-runtime-${round}`, jwt: "local-secret" });
      entry.started = true;
      entry.state = client.state;
      entry.capabilities = client.hasCapability("screen_analyse");
      // ~1.6 s of loud audio on the prospect stream -> mock ASR interims.
      for (let i = 0; i < 16; i += 1) {
        client.sendAudio("system", tone(1600));
        await delay(5);
      }
      client.finalizeStream("system");
      entry.gotFinal = await waitFor(() => types.includes("transcript") && types.includes("turn.started"));
      entry.sent = client.getStats().sentFrames;
    } catch (error) {
      entry.error = String(error?.message ?? error);
    }
    entry.types = [...new Set(types)];
    entry.transcripts = types.filter((t) => t === "transcript").length;
    entry.binaryDownlink = binaryDownlink;
    client.stop();
    report.sessions.push(entry);
    await delay(50);
  }
} finally {
  await server.stop();
}

console.log(`RESULT ${JSON.stringify(report)}`);
process.exit(0);
