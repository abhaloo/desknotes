/**
 * DeskNotes demo — one command that shows the whole realtime loop.
 *
 *   bun scripts/demo.mjs
 *
 * Boots the realtime server on an ephemeral port, connects the real client,
 * then drives the pipeline exactly like a live session:
 *   1. simulated prospect (system) audio -> VAD gate -> binary WS uplink
 *   2. server ASR emits partial/final transcripts (scripted question)
 *   3. the gate opens a turn and streams tokens to the client
 *   4. an answer_request shows the manual override + gate_seq echo
 *   5. a screen analyse shows the socket-first vision path (mint -> PUT ->
 *      command -> screen.result) with the server's dedup verdict
 *
 * Everything is printed as it happens so you can see the latency shape.
 */
import { RealtimeServer } from "../src/server/ws-server.js";
import { createEngineFactory } from "../src/server/engines/index.js";
import { RealtimeClient } from "../src/transport/realtime-client.js";
import { createCapture, createSpeechPipeline } from "../src/audio/index.js";
import { EnergyVad, VadGate } from "../src/vad/index.js";
import { ScreenAnalyser, createHttpClient } from "../src/vision/index.js";

const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(5)}ms`;

const engine = createEngineFactory({
  asrOptions: {
    provider: "mock-scripted",
    // Stream 1 = the prospect (system audio): only prospect speech opens
    // turns. Stream 0 = the rep (mic), the person being coached.
    script: {
      1: ["Could you walk me through how pricing works for a team our size"],
      0: ["Sure - it depends on the number of reps, so let me ask a few questions"],
    },
  },
  answererOptions: { provider: "mock", deltaMinMs: 25, deltaMaxMs: 60 },
});

const server = new RealtimeServer({ port: 0, createEngine: engine });
const { url } = await server.start();
console.log(`[${ts()}] server up at ${url}\n`);

const client = new RealtimeClient({ baseUrl: url });

/* ---------------------------------------------------------- frame printer */
const seenTurns = new Map();
client.onFrame((_raw, frame) => {
  const d = frame.data ?? {};
  switch (frame.type) {
    case "transcript":
      console.log(`[${ts()}] transcript  [${d.role}/${d.source}] ${d.final ? "FINAL " : "partial"} "${d.text}"`);
      break;
    case "transcription.state":
      console.log(`[${ts()}] asr         ${d.state} (${d.stream_id})`);
      break;
    case "gate.verdict":
      console.log(`[${ts()}] gate        verdict=${d.verdict} gate_seq=${d.gate_seq}`);
      break;
    case "turn.started":
      seenTurns.set(d.turn_id, "");
      console.log(`[${ts()}] turn        started ${d.turn_id}${d.gate_seq != null ? ` (gate_seq=${d.gate_seq})` : ""}`);
      break;
    case "turn.token": {
      const acc = (seenTurns.get(d.turn_id) ?? "") + d.delta;
      seenTurns.set(d.turn_id, acc);
      process.stdout.write(`[${ts()}] token       "${d.delta}"\r`);
      break;
    }
    case "turn.done":
      console.log(`\n[${ts()}] turn        DONE ${d.turn_id}: "${d.text}"`);
      break;
    case "turn.superseded":
      console.log(`[${ts()}] turn        superseded ${d.turn_id}`);
      break;
    case "say":
      console.log(`[${ts()}] say         (${d.say_id}) "${d.text}"`);
      break;
    default:
      break;
  }
});

const sessionId = `demo-${Date.now().toString(36)}`;
await client.start({ sessionId, jwt: "demo", topology: "general" });

/* -------------------------------------- 1. voice: prospect system capture */
console.log(`[${ts()}] connecting + starting simulated system-audio capture: the prospect (VAD-gated)\n`);
const vad = new EnergyVad({ noiseFloorDb: -55 });
const gateProbe = { probe: (f, c) => vad.process(f, c), initialState: () => new Float32Array(320) };
const capture = createCapture({ backend: "simulated", source: "system", durationMs: 6000, seed: 11, pace: 1 });
const pipeline = createSpeechPipeline({
  capture,
  vad: gateProbe,
  sink: client,
  source: "system",
});
await pipeline.start();
await new Promise((r) => setTimeout(r, 6500));
await pipeline.stop();
client.finalizeStream("system");
await new Promise((r) => setTimeout(r, 1500));

/* --------------------------------------------- 2. manual answer override */
console.log(`\n[${ts()}] user presses "answer now" (answer_request with gate_seq=7)`);
client.requestAnswer("What does onboarding look like for a team of fifty", "manual", 7);
await new Promise((r) => setTimeout(r, 1500));

/* ------------------------------------------------------- 3. vision path */
console.log(`\n[${ts()}] screen analyse over the socket (mint -> PUT -> command)`);
// Real control plane: the server mints the upload and serves the signed PUT.
const http = createHttpClient({ baseUrl: url, getToken: () => "demo" });
const vision = new ScreenAnalyser({ transport: client, http, sessionIdProvider: () => sessionId });
const shot = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const r1 = await vision.analyse({ bytes: shot, purpose: "question", origin: "hotkey" });
const r2 = await vision.analyse({ bytes: shot, purpose: "question", origin: "hotkey" });
console.log(`[${ts()}] screen.result #1: status=${r1.status} kind=${r1.kind} solve=${r1.solve}`);
console.log(`[${ts()}] screen.result #2: status=${r2.status} dedup=${r2.dedup}  <- dedup is a SERVER verdict`);

/* ---------------------------------------------------------------- wrap up */
const stats = client.getStats();
console.log(`\n[${ts()}] transport stats: ${JSON.stringify(stats)}`);
client.stop();
await server.stop();
console.log(`[${ts()}] demo complete — transcripts above arrived live from the ASR lane.`);
process.exit(0);
