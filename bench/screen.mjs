/**
 * Screen-analysis client latency: fresh vs unchanged screenshot through the
 * real socket-first path (mint -> PUT -> screen_analyse -> screen.result)
 * against the embedded server with the mock vision engine.
 *
 *   bun bench/screen.mjs [--root <checkout>] [--kb 400] [--n 20]
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const ROOT = resolve(arg("root", join(dirname(fileURLToPath(import.meta.url)), "..")));
const KB = Number(arg("kb", 400));
const N = Number(arg("n", 20));
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const { RealtimeServer } = await load("src/server/ws-server.js");
const { createEngineFactory } = await load("src/server/engines/index.js");
const { RealtimeClient } = await load("src/transport/realtime-client.js");
const { ScreenAnalyser, createHttpClient } = await load("src/vision/index.js");

const server = new RealtimeServer({ port: 0, createEngine: createEngineFactory({}) });
const { url } = await server.start();
const client = new RealtimeClient({ baseUrl: url });
await client.start({ sessionId: "screen-bench", jwt: "t" });
const analyser = new ScreenAnalyser({
  transport: client,
  http: createHttpClient({ baseUrl: url, getToken: () => "t" }),
  sessionIdProvider: () => "screen-bench",
  timeoutMs: 10_000,
});

const image = (seed) => {
  const bytes = new Uint8Array(KB * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed * 7) & 255;
  return bytes;
};
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const fresh = [];
const unchanged = [];
for (let i = 0; i < N; i++) {
  const bytes = image(i);
  let t = performance.now();
  const a = await analyser.analyse({ bytes });
  fresh.push(performance.now() - t);
  t = performance.now();
  const b = await analyser.analyse({ bytes });
  unchanged.push(performance.now() - t);
  if (a.status !== "ok" || b.status !== "ok" || b.dedup !== true) throw new Error(`unexpected result ${JSON.stringify(b)}`);
}
console.log(`screen analyse, ${KB} KB image, ${N} pairs: fresh p50 ${median(fresh).toFixed(1)} ms, unchanged (dedup) p50 ${median(unchanged).toFixed(1)} ms`);
analyser.close();
client.stop();
await server.stop();
process.exit(0);
