/**
 * Speech -> guidance latency benchmark (repeatable, localhost, mock engines).
 *
 *   bun bench/latency.mjs [--reps 3] [--only short,long] [--out bench/results/x.json]
 *                         [--label name] [--root <checkout>]
 *                         [--judge off|fake|live] [--judge-ms 270]
 *
 * --judge fake uses bench/fake-judge.mjs at --judge-ms latency; --judge live calls TypeSafe (needs TYPESAFE_API_KEY).
 *
 * Client side runs in THIS process, exactly as the desktop main process wires
 * it: 16 kHz frames paced at real time -> VadGate (EnergyVad probe, so the
 * synthetic audio classifies deterministically) -> RealtimeClient over a real
 * WebSocket. The server (RealtimeServer + pipeline engine, mock ASR/answerer)
 * runs in a child process so a simulated client main-loop stall cannot also
 * stall the server. Every timestamp is taken here, on the client clock, and
 * every latency is relative to the moment the LAST speech frame was captured
 * ("speech end").
 *
 * ASR model: unless a scenario says "mock-default", the mock ASR runs with
 * silenceMs 2000 and an energy floor of -40 dBFS. That makes it behave like a
 * real streaming ASR, whose segment close is driven by the client's
 * `finalize` (the protocol's endpointing contract), instead of the mock's own
 * 700 ms silence timer racing the 768 ms VAD hangover and hiding it; and it
 * keeps -50 dBFS room noise from being transcribed as words.
 *
 * Metrics per question (median across reps, raw values in the JSON):
 *   hint      speech end -> VAD "probable end of turn" hint (if supported)
 *   finalize  speech end -> `finalize` sent (VAD segment close)
 *   final     speech end -> committed final transcript received
 *   firstTok  speech end -> first token of the answer turn that survives
 *             (negative = the answer started while the speaker was talking)
 *   partials  inter-partial gap p50/max and speech start -> first partial
 *
 * The "halfopen" scenario routes the socket through a local TCP proxy that,
 * 1 s into the question, silently stops forwarding in both directions while
 * keeping the connection open (a half-open link: send() keeps succeeding).
 * It reports how long the client took to get a live link back and how many
 * of the question's words the committed final still contains.
 */
import { spawn } from "node:child_process";
import { createServer as createTcpServer, connect as tcpConnect } from "node:net";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ args -- */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(arg("root", join(HERE, "..")));
const REPS = Math.max(1, Number(arg("reps", 3)) | 0);
const ONLY = arg("only", "") ? new Set(arg("only", "").split(",")) : null;
const OUT = arg("out", null);
const LABEL = arg("label", "run");
const JUDGE = arg("judge", "off");
const JUDGE_MS = Number(arg("judge-ms", 270));
if (!["off", "fake", "live"].includes(JUDGE)) {
  console.error(`Invalid --judge "${JUDGE}": expected off|fake|live\nUsage: bun bench/latency.mjs [--judge off|fake|live] [--judge-ms 270]`);
  process.exit(2);
}

const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { RealtimeClient } = await load("src/transport/realtime-client.js");
const vadModule = await load("src/vad/index.js");
const { VadGate, EnergyVad } = vadModule;
const { floatToPcm16 } = await load("src/audio/index.js");

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FRAME = 512;
const FRAME_MS = 32;

/* ----------------------------------------------------------------- audio -- */

let speechPhase = 0;
function speechFrame() {
  const f = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    const t = (speechPhase + i) / 16000;
    f[i] = 0.3 * (0.6 * Math.sin(2 * Math.PI * 180 * t) + 0.4 * (Math.random() * 2 - 1));
  }
  speechPhase += FRAME;
  return f;
}
function noiseFrame(db) {
  const f = new Float32Array(FRAME);
  if (db == null) return f; // digital silence
  const a = Math.pow(10, db / 20) * Math.sqrt(3); // uniform noise: rms = a / sqrt(3)
  for (let i = 0; i < FRAME; i++) f[i] = a * (Math.random() * 2 - 1);
  return f;
}

/* ---------------------------------------------------------------- server -- */

function spawnServer(config) {
  return new Promise((resolveReady, reject) => {
    const child = spawn(process.execPath, [join(HERE, "server-child.mjs"), JSON.stringify({ root: ROOT, ...config })], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const logs = [];
    let buf = "";
    let ready = false;
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith("READY ")) {
          ready = true;
          resolveReady({ child, port: Number(line.slice(6)), logs });
        } else if (line.startsWith("LOG ")) {
          try {
            logs.push(JSON.parse(line.slice(4)));
          } catch {
            /* partial line */
          }
        }
      }
    });
    child.on("exit", (code) => {
      if (!ready) reject(new Error(`bench server exited early (${code})`));
    });
  });
}

async function stopServer(child) {
  try {
    child.stdin.write("STOP\n");
  } catch {
    /* already gone */
  }
  await Promise.race([new Promise((r) => child.once("exit", r)), sleep(2000)]);
  if (child.exitCode === null) child.kill();
}

/* -------------------------------------------------------------- scenario -- */

const REALISTIC_ASR = { silenceMs: 2000, energyFloorDb: -40 };
const ROOM_DB = -50;

const q = (speechMs, { lead = 400, tail = 2500, db = ROOM_DB } = {}) => [
  { op: "quiet", ms: lead, db },
  { op: "speech", ms: speechMs },
  { op: "quiet", ms: tail, db },
];

const SCENARIOS = {
  short: {
    title: "short question (1.5 s, 6 words), -50 dBFS room tail",
    server: { asrOptions: REALISTIC_ASR },
    timeline: q(1500),
  },
  long: {
    title: "long question (3.6 s, 13 words), -50 dBFS room tail",
    server: { asrOptions: REALISTIC_ASR },
    timeline: q(3600),
  },
  "short-nohint": {
    title: "short question, client WITHOUT end-of-turn hints (server stability rule only)",
    server: { asrOptions: REALISTIC_ASR },
    hints: false,
    timeline: q(1500),
  },
  "short-mockdefault": {
    title: "short question, mock-default ASR (700 ms silence close), digital-silence tail",
    server: {},
    timeline: q(1500, { db: null }),
  },
  vision: {
    title: "long question with a concurrent 3 s screen analysis sent 1 s into speech",
    server: { asrOptions: REALISTIC_ASR, slowVisionMs: 3000 },
    timeline: [
      { op: "quiet", ms: 400, db: ROOM_DB },
      { op: "speech", ms: 1000 },
      { op: "vision" },
      { op: "speech", ms: 2600, cont: true },
      { op: "quiet", ms: 4500, db: ROOM_DB },
    ],
  },
  halfopen: {
    title: "half-open link 1 s into a 13-word question (proxy blackholes the live connection)",
    server: { asrOptions: REALISTIC_ASR },
    proxy: true,
    tailMs: 1000,
    timeline: [
      { op: "quiet", ms: 400, db: ROOM_DB },
      { op: "speech", ms: 1000 },
      { op: "blackhole" },
      { op: "speech", ms: 2600, cont: true },
      { op: "quiet", ms: 12000, db: ROOM_DB },
    ],
  },
  drift: {
    title: "long call: 8 questions, a 1.5 s client main-loop stall before each",
    server: { asrOptions: REALISTIC_ASR },
    reps: 1,
    timeline: Array.from({ length: 8 }, (_, i) => [
      { op: "quiet", ms: 600, db: ROOM_DB },
      { op: "stall", ms: 1500, db: ROOM_DB },
      { op: "quiet", ms: 300, db: ROOM_DB },
      { op: "speech", ms: i % 2 ? 3600 : 1500 },
      { op: "quiet", ms: 2700, db: ROOM_DB },
    ]).flat(),
  },
  revise: {
    title: "long question whose final rewords one word the interims had (pro tier -> pro plan)",
    server: {
      asrOptions: {
        ...REALISTIC_ASR,
        provider: "mock-scripted",
        script: {
          1: [
            {
              interim: "how much is the pro tier per seat for a team of forty people",
              text: "how much is the pro plan per seat for a team of forty people",
            },
          ],
        },
      },
    },
    timeline: q(3600),
  },
  smalltalk: {
    title: "small talk (12 words) then, 0.9 s later, a real question: does the small-talk answer block the question?",
    server: {
      asrOptions: {
        ...REALISTIC_ASR,
        provider: "mock-scripted",
        script: {
          1: [
            "yeah that makes sense I think the team would be fine with that approach",
            "how much does the enterprise tier cost per seat for forty people",
          ],
        },
      },
    },
    timeline: [
      { op: "quiet", ms: 400, db: ROOM_DB },
      { op: "speech", ms: 3200 },
      { op: "quiet", ms: 900, db: ROOM_DB },
      { op: "speech", ms: 3200 },
      { op: "quiet", ms: 3000, db: ROOM_DB },
    ],
  },
};

/** TCP pass-through whose live connections can be silently blackholed. */
async function startProxy(targetPort) {
  const pairs = new Set();
  const server = createTcpServer((inbound) => {
    const outbound = tcpConnect(targetPort, "127.0.0.1");
    const pair = { inbound, outbound, dead: false };
    pairs.add(pair);
    inbound.on("data", (d) => {
      if (!pair.dead) outbound.write(d);
    });
    outbound.on("data", (d) => {
      if (!pair.dead) inbound.write(d);
    });
    const end = () => {
      pairs.delete(pair);
      inbound.destroy();
      outbound.destroy();
    };
    inbound.on("error", end);
    outbound.on("error", end);
    inbound.on("close", end);
    outbound.on("close", end);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    blackhole() {
      for (const pair of pairs) pair.dead = true;
    },
    close() {
      for (const pair of pairs) {
        pair.inbound.destroy();
        pair.outbound.destroy();
      }
      server.close();
    },
  };
}

async function runOnce(name, sc, rep) {
  const { child, port, logs } = await spawnServer({
    ...sc.server,
    judge: JUDGE === "off" ? undefined : { mode: JUDGE, latencyMs: JUDGE_MS },
  });
  const proxy = sc.proxy ? await startProxy(port) : null;
  const wantHints = sc.hints !== false;
  const client = new RealtimeClient({ baseUrl: `ws://127.0.0.1:${proxy ? proxy.port : port}/v3/realtime` });
  const statusLog = [];
  client.onStatus((s) => statusLog.push({ t: now(), state: s.state }));
  const ev = [];
  client.onFrame((raw, f) => ev.push({ t: now(), type: f.type, d: f.data ?? {} }));
  await client.start({ sessionId: `bench-${name}-${rep}-${Date.now()}`, jwt: "bench", topology: "general", captureAuthorized: true });
  await sleep(150);

  const questions = [];
  const marks = { hint: [], resume: [], finalize: [], visionSent: [] };
  const energy = new EnergyVad();
  const hintCapable = wantHints && typeof client.sendTurnHint === "function";
  const gates = {};
  let fed = 0;
  for (const src of ["microphone", "system"]) {
    gates[src] = new VadGate({
      probe: (frame, carry) => energy.process(frame, carry),
      onSend: (frame) => client.sendAudio(src, floatToPcm16(frame)),
      onSpeechEnd: () => {
        if (src === "system") marks.finalize.push(now());
        client.finalizeStream(src);
      },
      // Additive hint callbacks (ignored by gates that predate them).
      onSpeechPause: () => {
        if (src === "system") marks.hint.push(now());
        if (hintCapable) client.sendTurnHint(src, "pause");
      },
      onSpeechResume: () => {
        if (src === "system") marks.resume.push(now());
        if (hintCapable) client.sendTurnHint(src, "resume");
      },
    });
  }

  const feed = (sysFrame) => {
    gates.system.feed(sysFrame);
    gates.microphone.feed(noiseFrame(null));
    fed++;
  };

  const T0 = now();
  let tick = 0;
  const pace = async () => {
    const target = T0 + tick * FRAME_MS;
    tick++;
    const wait = target - now();
    if (wait > 0) await sleep(wait);
  };

  for (const step of sc.timeline) {
    if (step.op === "blackhole") {
      marks.blackhole = now();
      proxy.blackhole();
      continue;
    }
    if (step.op === "vision") {
      marks.visionSent.push(now());
      client.sendScreenAnalyse({
        commandId: `cmd-${Math.random().toString(36).slice(2)}`,
        purpose: "context",
        origin: "manual",
        imageHash: `h${Math.random()}`,
        objectPath: "bench/object",
        contentType: "image/jpeg",
      });
      continue;
    }
    const frames = Math.round(step.ms / FRAME_MS);
    if (step.op === "stall") {
      // Main-loop stall: capture keeps producing audio, the loop cannot run.
      // The captured frames are then delivered in one burst.
      const until = now() + step.ms;
      while (now() < until) {
        /* busy */
      }
      for (let i = 0; i < frames; i++) {
        tick++;
        feed(noiseFrame(step.db));
      }
      continue;
    }
    if (step.op === "speech" && !step.cont) questions.push({ start: null, end: null });
    for (let i = 0; i < frames; i++) {
      await pace();
      if (step.op === "speech") {
        feed(speechFrame());
        const cur = questions[questions.length - 1];
        cur.start ??= now();
        cur.end = now();
      } else {
        feed(noiseFrame(step.db));
      }
    }
  }
  await sleep(sc.tailMs ?? 3000);

  const stats = gates.system.stats();
  const clientStats = client.getStats();
  const linkStats = typeof client.getLinkStats === "function" ? client.getLinkStats() : null;
  client.stop();
  proxy?.close();
  await stopServer(child);
  const relive = marks.blackhole != null ? statusLog.find((s) => s.t > marks.blackhole && s.state === "live") : null;

  return {
    questions: questions.map((qq, i) => measureQuestion(qq, questions[i + 1]?.start ?? Infinity, ev, marks)),
    vision: marks.visionSent.length
      ? (() => {
          const res = ev.find((e) => e.type === "screen.result");
          return { result_ms: res ? res.t - marks.visionSent[0] : null };
        })()
      : null,
    vad: { ...stats, fed, forwardedRatio: +(stats.forwarded / Math.max(1, fed)).toFixed(3) },
    client: { sentFrames: clientStats.sentFrames, droppedFrames: clientStats.droppedFrames, ...(linkStats ?? {}) },
    link:
      marks.blackhole != null
        ? { reconnect_ms: relive ? +(relive.t - marks.blackhole).toFixed(0) : null, gaps: logs.filter((l) => l.type === "gap").length }
        : null,
    segClose: logs.filter((l) => l.type === "asr.segment_closed" && l.stream === 1).map((l) => l.reason),
    judge: {
      rescued: logs.filter((l) => l.type === "turn.rescued").length,
      gatedOut: logs.filter((l) => l.type === "turn.gated_out").length,
      gateCalls: logs.filter((l) => l.type === "judge.gate").length,
      rescueCalls: logs.filter((l) => l.type === "judge.rescue").length,
      rescueVerdicts: logs
        .filter((l) => l.type === "judge.rescue")
        .map(({ p_same, p_question, latency_ms, error }) => ({ p_same, p_question, latency_ms, error })),
      shadowDropped: logs.filter((l) => l.type === "turn.shadow_dropped").map((l) => l.reason),
    },
    hintCapable,
  };
}

function measureQuestion(qq, nextStart, ev, marks) {
  const inWin = (t) => t >= qq.start && t < nextStart;
  const after = (arr) => arr.find((t) => t >= qq.end - 1 && t < nextStart);
  const rel = (t) => (t == null ? null : +(t - qq.end).toFixed(1));

  const finals = ev.filter((e) => e.type === "transcript" && e.d.final && e.d.stream === 1 && inWin(e.t));
  const partials = ev.filter((e) => e.type === "transcript" && !e.d.final && e.d.stream === 1 && inWin(e.t));
  const gaps = [];
  for (let i = 1; i < partials.length; i++) gaps.push(partials[i].t - partials[i - 1].t);

  const turns = new Map();
  for (const e of ev) {
    const id = e.d?.turn_id;
    if (!id) continue;
    if (!turns.has(id)) turns.set(id, { started: null, first: null, done: null, superseded: null, question: null });
    const t = turns.get(id);
    if (e.type === "turn.started") {
      t.started = e.t;
      t.question = e.d.question;
    } else if (e.type === "turn.token" && t.first == null) t.first = e.t;
    else if (e.type === "turn.done") t.done = e.t;
    else if (e.type === "turn.superseded") t.superseded = e.t;
  }
  const mine = [...turns.values()].filter((t) => t.started != null && inWin(t.started));
  const answer = mine.filter((t) => t.superseded == null).at(-1) ?? null;

  return {
    words: finals[0]?.d.text?.split(/\s+/).length ?? null,
    finals: finals.length,
    // Words across every final of the question (an outage can split it).
    finalWordsAll: finals.reduce((sum, f) => sum + (f.d.text?.split(/\s+/).length ?? 0), 0),
    hint: rel(after(marks.hint)),
    finalize: rel(after(marks.finalize)),
    final: rel(finals[0]?.t),
    firstTok: rel(answer?.first),
    answerDone: rel(answer?.done),
    turnsStarted: mine.length,
    turnsSuperseded: mine.filter((t) => t.superseded != null).length,
    partials: partials.length,
    partialGapP50: gaps.length ? +median(gaps).toFixed(1) : null,
    partialGapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null,
    firstPartial: partials.length ? +(partials[0].t - qq.start).toFixed(1) : null,
  };
}

/* ------------------------------------------------------------- reporting -- */

function median(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const fmt = (x) => (x == null ? "-" : Math.round(x).toString());
const range = (vals) => {
  const v = vals.filter((x) => typeof x === "number");
  return v.length > 1 ? ` (${fmt(Math.min(...v))}..${fmt(Math.max(...v))})` : "";
};

const results = {
  label: LABEL,
  root: ROOT,
  runtime: `bun ${process.versions.bun ?? "?"}`,
  at: new Date().toISOString(),
  judge: { mode: JUDGE, latencyMs: JUDGE === "fake" ? JUDGE_MS : null },
  scenarios: {},
};
const METRICS = ["hint", "finalize", "final", "firstTok", "answerDone", "partialGapP50", "partialGapMax", "firstPartial"];

for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (ONLY && !ONLY.has(name)) continue;
  const reps = sc.reps ?? REPS;
  const runs = [];
  for (let r = 0; r < reps; r++) runs.push(await runOnce(name, sc, r));
  results.scenarios[name] = { title: sc.title, runs };

  console.log(`\n## ${name}: ${sc.title}  [${reps} rep${reps > 1 ? "s" : ""}, hint wired to server: ${runs[0].hintCapable}]`);
  const nq = runs[0].questions.length;
  if (nq === 1) {
    const qs = runs.map((r) => r.questions[0]);
    for (const m of METRICS) console.log(`  ${m.padEnd(14)} ${fmt(median(qs.map((x) => x[m]))).padStart(6)} ms${range(qs.map((x) => x[m]))}`);
    console.log(`  words=${qs[0].words} finals=${qs.map((x) => x.finals).join("/")} turnsStarted=${qs.map((x) => x.turnsStarted).join("/")} superseded=${qs.map((x) => x.turnsSuperseded).join("/")} segClose=${runs.map((r) => r.segClose.join("+")).join(" | ")}`);
  } else {
    console.log("  q  words  hint finalize  final firstTok");
    const r0 = runs[0];
    r0.questions.forEach((x, i) =>
      console.log(`  ${String(i + 1).padStart(2)} ${String(x.words ?? "-").padStart(5)} ${fmt(x.hint).padStart(5)} ${fmt(x.finalize).padStart(8)} ${fmt(x.final).padStart(6)} ${fmt(x.firstTok).padStart(8)}`),
    );
    const half = nq >> 1;
    const firstHalf = r0.questions.slice(0, half);
    const secondHalf = r0.questions.slice(half);
    console.log(`  final median first half ${fmt(median(firstHalf.map((x) => x.final)))} ms vs second half ${fmt(median(secondHalf.map((x) => x.final)))} ms`);
    console.log(`  short-q firstTok first half ${fmt(median(firstHalf.filter((_, i) => i % 2 === 0).map((x) => x.firstTok)))} ms vs second half ${fmt(median(secondHalf.filter((_, i) => i % 2 === 0).map((x) => x.firstTok)))} ms`);
  }
  if (runs[0].vision) console.log(`  screen.result after ${fmt(median(runs.map((r) => r.vision.result_ms)))} ms`);
  if (runs[0].link) {
    console.log(`  link back live after ${fmt(median(runs.map((r) => r.link.reconnect_ms)))} ms${range(runs.map((r) => r.link.reconnect_ms))} (null = never within the run)`);
    console.log(`  words reaching a final (all finals): ${runs.map((r) => r.questions[0].finalWordsAll ?? 0).join("/")} of 13; finals: ${runs.map((r) => r.questions[0].finals).join("/")}; resent frames: ${runs.map((r) => r.client.resentFrames ?? "-").join("/")}`);
  }
  const v = runs[0].vad;
  console.log(`  vad: forwarded ${v.forwarded}/${v.fed} frames (${v.forwardedRatio}), dropped ${v.dropped}, failedOpen ${v.failedOpen}`);
  const rescuedSum = runs.reduce((sum, r) => sum + (r.judge?.rescued ?? 0), 0);
  const gatedOutSum = runs.reduce((sum, r) => sum + (r.judge?.gatedOut ?? 0), 0);
  console.log(`  judge=${JUDGE} rescued=${rescuedSum} gatedOut=${gatedOutSum}`);
}

if (OUT) {
  mkdirSync(dirname(resolve(OUT)), { recursive: true });
  writeFileSync(resolve(OUT), JSON.stringify(results, null, 1));
  console.log(`\nwrote ${resolve(OUT)}`);
}
process.exit(0);
