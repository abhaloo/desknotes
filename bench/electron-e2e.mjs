/**
 * Electron-level speech -> guidance latency: the client path runs in a REAL
 * Electron main process (Node 20, `ws` fallback socket), with real Silero VAD
 * on synthesized speech (bench/fixtures/*.wav, Windows TTS), against the mock
 * server in a separate bun process. Optionally a screenshot is taken in the
 * same main process 300 ms before the question ends: the old thumbnail path
 * (desktopCapturer.getSources) or the off-main grabber.
 *
 *   node_modules/electron/dist/electron bench/electron-e2e.mjs
 *   BENCH_ROOT=<checkout> ...   (measure another checkout's src/)
 *
 * Latencies are relative to the capture time of the end of the last voiced
 * frame of the WAV (frames are paced at 32 ms from T0, as a capture device would).
 * Output: stdout and bench/results/electron-e2e-<label>.txt
 */
import { app, BrowserWindow, desktopCapturer, session } from "electron";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.BENCH_ROOT ?? join(HERE, ".."));
const LABEL = process.env.BENCH_LABEL ?? "current";
const REPS = Number(process.env.BENCH_REPS ?? 3);
const OUT = join(HERE, "results", `electron-e2e-${LABEL}.txt`);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, "");
const out = (line) => {
  console.log(line);
  appendFileSync(OUT, `${line}\n`);
};
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const median = (v) => {
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (x) => (x == null ? "-" : `${Math.round(x)}`);

function readWav(path) {
  const buf = readFileSync(path);
  const data = buf.indexOf("data");
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + data + 8, buf.byteOffset + data + 8 + buf.readUInt32LE(data + 4)));
  return Float32Array.from(pcm, (v) => v / 32768);
}

function lastVoicedFrame(samples) {
  let last = 0;
  for (let i = 0; i + 512 <= samples.length; i += 512) {
    let sum = 0;
    for (let j = 0; j < 512; j++) sum += samples[i + j] ** 2;
    if (20 * Math.log10(Math.sqrt(sum / 512) + 1e-9) > -40) last = i / 512;
  }
  return last;
}

function startServer() {
  return new Promise((resolveReady, reject) => {
    // BUN_PATH, else whatever `bun` resolves to (no shell: the JSON arg must survive intact).
    const child = spawn(process.env.BUN_PATH || "bun", [join(HERE, "server-child.mjs"), JSON.stringify({ root: ROOT, asrOptions: { silenceMs: 2000, energyFloorDb: -40 } })], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/READY (\d+)/);
      if (m) resolveReady({ child, port: Number(m[1]) });
    });
    child.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
}

process.on("unhandledRejection", (error) => {
  out(`FAILED: ${error?.stack ?? error}`);
  app.quit();
});

app.whenReady().then(async () => {
  const anchor = new BrowserWindow({ show: false });
  const { RealtimeClient } = await load("src/transport/realtime-client.js");
  const { SileroVad, VadGate } = await load("src/vad/index.js");
  const { floatToPcm16 } = await load("src/audio/index.js");
  const { ScreenCapture } = await load("src/vision/index.js");
  const grabberPath = join(ROOT, "src", "desktop", "screen-grabber.js");
  const grabberMod = existsSync(grabberPath) ? await import(pathToFileURL(grabberPath).href) : null;

  const thumb = new ScreenCapture({ desktopCapturer, maxWidth: 1920, jpegQuality: 85 });
  thumb.capture({}); // the very first getSources costs ~1.9 s: do not bill it to a question
  await sleep(2500);
  // Created now, warmed only after the thumbnail variants: a live capture
  // stream also makes desktopCapturer thumbnails fast, which would hide the
  // old path's real cost.
  const grabber = grabberMod?.createScreenGrabber({
    BrowserWindow,
    desktopCapturer,
    session,
    app,
    pagePath: join(ROOT, "src", "desktop", "capture", "capture.html"),
  });

  const vad = await SileroVad.create({});
  const { child, port } = await startServer();
  out(`electron ${process.versions.electron}, root ${ROOT}`);

  async function question(wavName, shot) {
    const speech = readWav(join(HERE, "fixtures", wavName));
    const lead = 16;
    const lastVoiced = lead + lastVoicedFrame(speech);
    const tail = 90; // ~2.9 s
    const total = new Float32Array((lead + Math.ceil(speech.length / 512) + tail) * 512);
    total.set(speech, lead * 512);
    const client = new RealtimeClient({ baseUrl: `ws://127.0.0.1:${port}/v3/realtime` });
    const ev = [];
    client.onFrame((raw, f) => ev.push({ t: now(), type: f.type, d: f.data ?? {} }));
    await client.start({ sessionId: `e2e-${Math.random()}`, jwt: "bench" });
    await sleep(150);
    const marks = { hint: null, finalize: null, end: null };
    const hintCapable = typeof client.sendTurnHint === "function";
    const gates = {};
    for (const src of ["microphone", "system"]) {
      gates[src] = new VadGate({
        probe: (f, c) => vad.process(f, c),
        initialState: new Float32Array(0),
        onSend: (f) => client.sendAudio(src, floatToPcm16(f)),
        onSpeechEnd: () => {
          if (src === "system") marks.finalize ??= now();
          client.finalizeStream(src);
        },
        onSpeechPause: () => {
          if (src === "system") marks.hint ??= now();
          if (hintCapable) client.sendTurnHint(src, "pause");
        },
        onSpeechResume: () => hintCapable && client.sendTurnHint(src, "resume"),
      });
    }
    const T0 = now();
    let worstFeedLag = 0;
    const silence = new Float32Array(512);
    for (let i = 0; i * 512 < total.length; i++) {
      const target = T0 + i * 32;
      const wait = target - now();
      if (wait > 0) await sleep(wait);
      worstFeedLag = Math.max(worstFeedLag, now() - target);
      gates.system.feed(total.subarray(i * 512, (i + 1) * 512));
      gates.microphone.feed(silence);
      // Speech end = when the last voiced frame was CAPTURED (its scheduled
      // time), not when a stalled loop finally got to feed it.
      if (i === lastVoiced + 1) marks.end = target;
      if (shot && i === lastVoiced - 9) {
        // ~300 ms before the question ends, as a user hitting "analyse" would.
        const t = now();
        void (shot === "grabber" ? grabber.capture({}) : thumb.capture({})).then((r) => {
          marks.shot = { ms: now() - t, ok: Boolean(r?.bytes) };
        });
      }
    }
    await sleep(1500);
    const first = (type, pred = () => true) => ev.find((e) => e.type === type && pred(e) && e.t > T0);
    const finalT = first("transcript", (e) => e.d.final && e.d.stream === 1);
    const done = ev.filter((e) => e.type === "turn.done").at(-1);
    const answerTurn = done?.d.turn_id;
    const tok = ev.find((e) => e.type === "turn.token" && e.d.turn_id === answerTurn);
    client.stop();
    for (const g of Object.values(gates)) g.close();
    const rel = (t) => (t == null ? null : t - marks.end);
    return {
      hint: rel(marks.hint),
      finalize: rel(marks.finalize),
      final: rel(finalT?.t),
      firstTok: rel(tok?.t),
      feedLag: worstFeedLag,
      shotMs: marks.shot?.ms ?? null,
      shotOk: marks.shot?.ok ?? null,
    };
  }

  const variants = [
    ["short, no screenshot", "short-question.wav", null],
    ["long, no screenshot", "long-question.wav", null],
    ["short, thumbnail screenshot (old path)", "short-question.wav", "thumbnail"],
    ...(grabber ? [["short, grabber screenshot (off-main)", "short-question.wav", "grabber"]] : []),
  ];
  for (const [name, wav, shot] of variants) {
    if (shot === "grabber") await grabber.warm(); // session start
    const runs = [];
    for (let r = 0; r < REPS; r++) runs.push(await question(wav, shot));
    const m = (k) => fmt(median(runs.map((x) => x[k])));
    out(`${name}: hint ${m("hint")} | finalize ${m("finalize")} | final ${m("final")} | firstTok ${m("firstTok")} ms | worst main-loop feed delay ${m("feedLag")} ms${shot ? ` | screenshot ${m("shotMs")} ms ok=${runs.map((x) => x.shotOk).join("/")}` : ""}`);
  }
  await vad.dispose();
  grabber?.close();
  child.stdin.write("STOP\n");
  await sleep(300);
  try {
    child.kill();
  } catch {
    /* gone */
  }
  anchor.destroy();
  app.quit();
});
