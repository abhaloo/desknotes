/**
 * Realtime server entry point.
 *
 * Reads provider configuration from the environment, builds one pipeline
 * engine per connection through the factory, and shuts down cleanly on
 * SIGINT/SIGTERM. The transport server is imported lazily and intentionally:
 * it belongs to the transport package, and a missing file must surface as a
 * clear operator message instead of a stack trace at module load.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { buildEngineConfig } from "./engines/config.js";
import { configurePrompts, createEngineFactory } from "./engines/index.js";

export { buildEngineConfig };

const DEFAULT_PORT = 8787;
/** A pinned REALTIME_TOKEN shorter than this is not a secret; one is generated instead. */
const MIN_TOKEN_LENGTH = 16;

/**
 * The standalone server's credential. The ws-server default accepts every
 * hello, and loopback is reachable by every local process and OS user, so the
 * entry point always installs a token check: REALTIME_TOKEN when it is long
 * enough, otherwise a fresh 32-byte token for this run.
 */
export function resolveServerToken(env = process.env, { generate = () => randomBytes(32).toString("hex") } = {}) {
  const pinned = typeof env.REALTIME_TOKEN === "string" ? env.REALTIME_TOKEN : "";
  if (pinned.length >= MIN_TOKEN_LENGTH) return { token: pinned, generated: false };
  return { token: generate(), generated: true, ...(pinned && { rejectedShort: true }) };
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function main(env = process.env) {
  const requestedPort = env.PORT === undefined || env.PORT === "" ? NaN : Number.parseInt(env.PORT, 10);
  // PORT=0 is a valid request for an ephemeral port; only a missing/invalid
  // value falls back to the default.
  const port = Number.isFinite(requestedPort) ? requestedPort : DEFAULT_PORT;

  let RealtimeServer;
  try {
    ({ RealtimeServer } = await import("./ws-server.js"));
  } catch (err) {
    console.error(
      `[server] cannot start: ./ws-server.js is not available (${err?.message ?? err}). ` +
        "The transport package must be installed before running the server.",
    );
    process.exitCode = 1;
    return null;
  }

  const config = buildEngineConfig(env);
  const answerProvider = config.answerProvider;
  const model = env.LLM_MODEL;
  // PROMPTS_DIR names an override folder; its files reload on change only then.
  const prompts = configurePrompts({
    set: env.PROMPT_SET || undefined,
    overrideDir: env.PROMPTS_DIR || null,
    log: (event) => console.warn(`[server] prompts: ${JSON.stringify(event)}`),
  });
  if (env.PROMPTS_DIR) prompts.watch();
  console.log(`[server] prompts: ${prompts.set}`);
  const factory = createEngineFactory(config);

  const credential = resolveServerToken(env);
  if (credential.rejectedShort) {
    console.warn(`[server] REALTIME_TOKEN shorter than ${MIN_TOKEN_LENGTH} chars ignored; generated one instead`);
  }
  const server = new RealtimeServer({
    port,
    createEngine: factory,
    verifyToken: (jwt) => tokenMatches(jwt, credential.token),
  });
  const started = await server.start();
  const resolvedPort = started?.port ?? port;
  const url = started?.url ?? `ws://localhost:${resolvedPort}`;
  console.log(`[server] DeskNotes realtime server listening on ${url}`);
  if (credential.generated) {
    // stderr, once: clients need it as their hello jwt / mint bearer token.
    console.error(`[server] REALTIME_TOKEN not set; token for this run: ${credential.token}`);
  }
  console.log(
    `[server] mode=${config.mode} asr=${config.asrProvider} answer=${answerProvider} model=${model ?? "mock"}`,
  );
  return { server, url, port: resolvedPort };
}

const isMain =
  typeof import.meta.main === "boolean"
    ? import.meta.main
    : // Node ESM: only treat direct invocation as main.
      typeof process !== "undefined" &&
      Array.isArray(process.argv) &&
      process.argv[1] &&
      import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isMain) {
  main()
    .then((started) => {
      if (!started) return;
      let stopping = false;
      const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        console.log(`[server] ${signal} received, shutting down`);
        try {
          await started.server.stop();
        } catch (err) {
          console.error(`[server] shutdown error: ${err?.message ?? err}`);
        }
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
    })
    .catch((err) => {
      console.error(`[server] fatal: ${err?.stack ?? err}`);
      process.exitCode = 1;
    });
}
