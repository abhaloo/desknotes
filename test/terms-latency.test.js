/**
 * The spec's latency guarantees for Terms (2026-10-18-terms-design.md): with a
 * fake answerer on a virtual clock, the answer frames and their timing are the
 * same with the setting on and off, whatever the glossary does; the glossary
 * is never called before turn.done; a slow or failing glossary never delays
 * turn.done or the next turn's first token.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 3000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

function fakeAsr() {
  const handlers = [];
  return {
    pushAudio() {},
    finalize() {
      return true;
    },
    close() {},
    onTranscript(cb) {
      handlers.push(cb);
    },
    send(streamIdx, text, final = false) {
      const data = { text, final, stream: streamIdx, role: streamIdx === 1 ? "prospect" : "rep", source: streamIdx === 1 ? "system" : "mic" };
      for (const cb of handlers) cb(data);
    },
  };
}

const PIECES = ["• VERDICT: stream readings over **MQTT** into Kafka.\n", "• HOW: a TSDB keeps them.\n", "• TRADE-OFF: more ops."];

/** Only the answerer moves the virtual clock: 40 ms per token. */
function clockedAnswerer(clock) {
  return {
    async *streamAnswer(args) {
      for (const piece of PIECES) {
        await sleep(1);
        clock.ms += 40;
        if (args.signal?.aborted) return;
        yield piece;
      }
    },
  };
}

/** Glossary behaviours: each records its calls and the frames sent before them. */
const GLOSSARIES = {
  quick: () => Promise.resolve({ terms: [{ term: "MQTT", what: "Publish/subscribe protocol." }], added: 1, latencyMs: 1, error: null }),
  slow: (args) => new Promise((resolve) => args.signal.addEventListener("abort", () => resolve({ terms: [], added: 0, latencyMs: 0, error: "aborted" }))),
  never: () => new Promise(() => {}),
  rejects: () => Promise.reject(new Error("provider down")),
  throws: () => {
    throw new Error("broken engine");
  },
};

function run({ glossary, behaviour, clockStep = 0 }) {
  const clock = { ms: 0 };
  const frames = [];
  const calls = [];
  const asr = fakeAsr();
  const engine = createPipelineEngine({
    emit: (frame) => frames.push({ type: frame.type, data: frame.data, at: clock.ms }),
    asr,
    answerer: clockedAnswerer(clock),
    now: () => clock.ms,
    ...(glossary === undefined ? {} : { glossary }),
    ...(behaviour
      ? {
          glossaryEngine: {
            enabled: true,
            explain(args) {
              calls.push({ text: args.text, signal: args.signal, framesBefore: frames.map((frame) => ({ type: frame.type, id: frame.data?.turn_id, text: frame.data?.text })) });
              // A glossary that blocked its caller would move the clock for everything after it.
              clock.ms += clockStep;
              return GLOSSARIES[behaviour](args);
            },
            close() {},
          },
        }
      : {}),
  });
  engine.onSessionStart({ sessionId: "lat" });
  return { clock, frames, calls, asr, engine };
}

const Q1 = "How would you ingest sensor data for a greenhouse?";
const Q2 = "And how would you alert on a failing sensor?";

/** The answer lane as the client sees it: every frame but `terms`, with its virtual time. */
const answerFrames = (frames) => frames.filter((frame) => frame.type !== "terms");

/** Back to back: the second final queues behind the first answer and starts the moment it is done. */
async function backToBack(options) {
  const r = run(options);
  r.asr.send(1, Q1, true);
  r.asr.send(1, Q2, true);
  await waitFor(() => r.frames.filter((frame) => frame.type === "turn.done").length === 2, "both answers");
  await sleep(10);
  r.engine.onSessionEnd();
  return r;
}

/** With a gap: the first card's glossary request is in flight when the next question lands. */
async function withGap(options) {
  const r = run(options);
  r.asr.send(1, Q1, true);
  await waitFor(() => r.frames.some((frame) => frame.type === "turn.done"), "first answer");
  if (options.behaviour && options.glossary !== false) await waitFor(() => r.calls.length === 1, "first glossary call");
  else await sleep(10);
  r.asr.send(1, Q2, true);
  await waitFor(() => r.frames.filter((frame) => frame.type === "turn.done").length === 2, "second answer");
  await sleep(10);
  r.engine.onSessionEnd();
  return r;
}

test("turn.token frames and their timing are identical with the setting on and off", async () => {
  for (const script of [backToBack, withGap]) {
    const baseline = answerFrames((await script({})).frames);
    assert.ok(baseline.filter((frame) => frame.type === "turn.token").length === 6, "two answers of three tokens");
    const off = await script({ glossary: false, behaviour: "quick" });
    assert.equal(off.calls.length, 0, "off: the glossary is never called");
    assert.deepEqual(answerFrames(off.frames), baseline, `${script.name}: off`);
    for (const behaviour of Object.keys(GLOSSARIES)) {
      const on = await script({ glossary: true, behaviour });
      assert.deepEqual(answerFrames(on.frames), baseline, `${script.name}: on, ${behaviour} glossary`);
    }
  }
  // A glossary call that took 5 s of the caller's time would show in every later frame.
  const blocking = await backToBack({ glossary: true, behaviour: "quick", clockStep: 5000 });
  assert.deepEqual(answerFrames(blocking.frames), answerFrames((await backToBack({})).frames), "nothing on the answer path runs the glossary");
});

test("the glossary engine is never called before turn.done", async () => {
  for (const script of [backToBack, withGap]) {
    for (const behaviour of Object.keys(GLOSSARIES)) {
      const { calls } = await script({ glossary: true, behaviour });
      assert.ok(calls.length >= 1, `${script.name}/${behaviour}: called`);
      for (const call of calls) {
        const done = call.framesBefore.filter((frame) => frame.type === "turn.done");
        assert.ok(done.length >= 1, `${script.name}/${behaviour}: a turn.done was sent first`);
        assert.equal(done.at(-1).text.replaceAll("**", ""), call.text, "the call explains the card whose turn.done was sent");
        const last = call.framesBefore.at(-1);
        assert.equal(last.type, "turn.done", "no newer turn had started");
      }
    }
  }
});

test("a slow or failing glossary call never delays turn.done or the next turn's first token", async () => {
  const timing = (frames) => {
    const started = frames.filter((frame) => frame.type === "turn.started");
    const firstToken = (id) => frames.find((frame) => frame.type === "turn.token" && frame.data.turn_id === id).at;
    const done = (id) => frames.find((frame) => frame.type === "turn.done" && frame.data.turn_id === id).at;
    return started.map((frame) => ({ firstToken: firstToken(frame.data.turn_id) - frame.at, done: done(frame.data.turn_id) - frame.at }));
  };
  const baseline = timing((await withGap({})).frames);
  for (const behaviour of ["slow", "never", "rejects", "throws"]) {
    const on = await withGap({ glossary: true, behaviour });
    assert.deepEqual(timing(on.frames), baseline, behaviour);
    if (behaviour === "slow" || behaviour === "never") {
      assert.equal(on.calls[0].signal.aborted, true, `${behaviour}: the next turn aborted the first card's request`);
    }
  }
  // Wall clock too: a request that never settles cannot hold the next answer back.
  const r = run({ glossary: true, behaviour: "never" });
  r.asr.send(1, Q1, true);
  await waitFor(() => r.calls.length === 1, "request in flight");
  const sent = Date.now();
  r.asr.send(1, Q2, true);
  await waitFor(() => r.frames.filter((frame) => frame.type === "turn.token").length === 4, "the second answer's first token", 1000);
  assert.ok(Date.now() - sent < 500, "the second answer streams while the first request hangs");
  r.engine.onSessionEnd();
});
