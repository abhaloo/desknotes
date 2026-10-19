/**
 * Benchmark server process: the embedded RealtimeServer + pipeline engine with
 * mock providers, run in its OWN process so a client-side main-loop stall (the
 * thing the long-call scenario simulates) cannot also stall the server.
 *
 * argv[2] = JSON { root, asrOptions, answererOptions, slowVisionMs, judge }, where judge = { mode: "fake"|"live", latencyMs }.
 * stdout protocol: `READY <port>` once listening, then `LOG <json>` lines for
 * the server log entries the harness uses for diagnostics.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const config = JSON.parse(process.argv[2] ?? "{}");
const root = config.root ?? process.cwd();
const load = (rel) => import(pathToFileURL(join(root, rel)).href);

const { RealtimeServer } = await load("src/server/ws-server.js");
const { createPipelineEngine } = await load("src/server/engines/pipeline.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A slow vision provider (the real one awaits an HTTP call with no timeout).
const vision =
  config.slowVisionMs > 0
    ? {
        async analyse() {
          await sleep(config.slowVisionMs);
          return { status: "ok", kind: "other", dedup: false, title: "bench", summary: "bench" };
        },
      }
    : undefined;

const FORWARD_LOGS = new Set([
  "asr.segment_closed",
  "turn.start",
  "turn.commit",
  "turn.done",
  "turn.rescued",
  "turn.gated_out",
  "turn.final_gated_out",
  "turn.shadow_dropped",
  "judge.gate",
  "judge.rescue",
  "gap",
  "dup",
  "handler_error",
  "engine_error",
]);

let makeJudge = () => undefined;
if (config.judge?.mode === "fake") {
  const { createFakeJudge } = await import("./fake-judge.mjs");
  makeJudge = () => createFakeJudge({ latencyMs: config.judge.latencyMs ?? 270 });
} else if (config.judge?.mode === "live") {
  let judgeModule;
  try {
    judgeModule = await load("src/server/engines/judge.js");
  } catch {
    process.stderr.write("live judge needs src/server/engines/judge.js (Task 1)\n");
    process.exit(2);
  }
  const options = judgeModule.judgeOptionsFromEnv({ ...process.env, JEV_JUDGMENTS: process.env.JEV_JUDGMENTS || "gate,rescue" });
  if (!options) {
    process.stderr.write("live judge needs TYPESAFE_API_KEY\n");
    process.exit(2);
  }
  makeJudge = (log) => judgeModule.createJudge({ ...options, log });
}

const server = new RealtimeServer({
  port: 0,
  createEngine: ({ emit, log }) =>
    createPipelineEngine({
      emit,
      log: (entry) => {
        log(entry);
        if (FORWARD_LOGS.has(entry?.type)) process.stdout.write(`LOG ${JSON.stringify({ ...entry, wall: Date.now() })}\n`);
      },
      vision,
      judge: makeJudge(log),
      asrOptions: config.asrOptions ?? {},
      answererOptions: config.answererOptions ?? {},
    }),
});

const { port } = await server.start();
process.stdout.write(`READY ${port}\n`);

const shutdown = async () => {
  try {
    await server.stop();
  } finally {
    process.exit(0);
  }
};
process.stdin.on("data", (chunk) => {
  if (String(chunk).includes("STOP")) void shutdown();
});
process.stdin.on("end", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
