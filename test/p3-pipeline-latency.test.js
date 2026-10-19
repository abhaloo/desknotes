import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 3000, interval = 5, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

/** Fake ASR whose transcripts the test injects. */
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
    send(streamIdx, text, final, extra = {}) {
      const data = {
        text,
        final,
        stream: streamIdx,
        role: streamIdx === 1 ? "prospect" : "rep",
        source: streamIdx === 1 ? "system" : "mic",
        ...extra,
      };
      for (const cb of handlers) cb(data);
    },
  };
}

function quickAnswerer({ deltaMs = 5, count = 3 } = {}) {
  const calls = [];
  return {
    calls,
    async *streamAnswer(args) {
      const call = { question: args.question, cancelled: false };
      calls.push(call);
      for (let i = 0; i < count; i += 1) {
        await sleep(deltaMs);
        if (args.signal?.aborted) {
          call.cancelled = true;
          return;
        }
        yield `d${i} `;
      }
    },
  };
}

function setup(options = {}) {
  const frames = [];
  const asr = fakeAsr();
  const answerer = quickAnswerer(options.answerer);
  // Speculation timing is observed on the wire, so hold is off here (see
  // p3-pipeline-hold.test.js for held turns).
  const engine = createPipelineEngine({ emit: (f) => frames.push(f), asr, answerer, holdSpeculation: false, ...options.engine });
  engine.onSessionStart({ sessionId: "lat" });
  const of = (type) => frames.filter((f) => f.type === type);
  return { frames, asr, answerer, engine, of };
}

test("a final that commits an already-finished prefetch still delivers its gate_seq", async () => {
  const { asr, of } = setup();
  const q = "could you walk me through your background and what you want next";
  asr.send(1, q, false); // >= 8 words: prefetch starts
  await waitFor(() => of("turn.done").length === 1, { label: "prefetch done" });
  asr.send(1, q, true, { gateSeq: 17 });
  await sleep(20);
  const verdicts = of("gate.verdict");
  assert.equal(verdicts.length, 1, "the commit announces the gate verdict");
  assert.equal(verdicts[0].data.gate_seq, 17);
  assert.equal(verdicts[0].data.turn_id, of("turn.started")[0].data.turn_id, "joined to the finished turn");
  assert.equal(of("turn.started").length, 1, "no regeneration for a matching final");
});

/* ---------------------------------------------------- end-of-turn hints -- */

const SHORT_Q = "what does onboarding look like"; // 5 words: never reaches the 8-word trigger

test("a pause hint starts the short question's answer at once; the final commits it", async () => {
  const { asr, engine, answerer, of } = setup();
  asr.send(1, SHORT_Q, false);
  assert.equal(of("turn.started").length, 0, "5 words: no word-count trigger");
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  assert.equal(of("turn.started").length, 1, "the hint opens the turn synchronously");
  assert.equal(of("turn.started")[0].data.question, SHORT_Q);
  asr.send(1, SHORT_Q, true);
  await waitFor(() => of("turn.done").length === 1, { label: "done" });
  await sleep(20);
  assert.equal(of("turn.started").length, 1, "the final committed the speculative turn, no regeneration");
  assert.equal(of("turn.superseded").length, 0);
  assert.equal(answerer.calls.length, 1);
});

test("a resume retracts an unfinished hint turn; the real end answers the full question", async () => {
  const { asr, engine, of } = setup({ answerer: { deltaMs: 30, count: 5 } });
  asr.send(1, "what does onboarding", false);
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  assert.equal(of("turn.started").length, 1);
  engine.onTurnHint({ streamIdx: 1, state: "resume" });
  assert.equal(of("turn.superseded").length, 1, "the speculative card is retired");
  const full = "what does onboarding look like for a new team";
  asr.send(1, full, false);
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  asr.send(1, full, true);
  await waitFor(() => of("turn.done").length === 1, { label: "done" });
  const started = of("turn.started");
  assert.equal(started.length, 2);
  assert.equal(started[1].data.question, full);
  assert.equal(of("turn.done")[0].data.turn_id, started[1].data.turn_id, "the answer is for the whole question");
});

test("hints never seed a turn from a closed segment, from the rep, or over a live turn", async () => {
  const { asr, engine, of } = setup();
  // Rep speech is not answered: its hint is ignored.
  asr.send(0, "let me share my screen with you now", false);
  engine.onTurnHint({ streamIdx: 0, state: "pause" });
  assert.equal(of("turn.started").length, 0);
  // A closed prospect segment's text must not be reused by the next hint.
  asr.send(1, SHORT_Q, true);
  await waitFor(() => of("turn.done").length === 1, { label: "first answer" });
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  assert.equal(of("turn.started").length, 1, "no turn from the previous segment's text");
  // A hint while a turn already owns the lane does not open another.
  asr.send(1, "and how long does that usually take for teams our size", false); // >= 8 words
  assert.equal(of("turn.started").length, 2);
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  assert.equal(of("turn.started").length, 2);
});

test("the documented 250 ms stability rule fires from a timer when no newer partial arrives", async () => {
  const { asr, of } = setup();
  asr.send(1, SHORT_Q, false); // no further partials: the ASR suppresses repeats
  assert.equal(of("turn.started").length, 0);
  await waitFor(() => of("turn.started").length === 1, { timeout: 1000, label: "timer turn" });
  assert.equal(of("turn.started")[0].data.question, SHORT_Q);
});

test("the stability timer needs a real phrase (>= 3 words)", async () => {
  const { asr, of } = setup();
  asr.send(1, "could you", false);
  await sleep(400);
  assert.equal(of("turn.started").length, 0);
});

test("a growing partial keeps re-arming the timer instead of speculating on each word", async () => {
  const { asr, of } = setup();
  const words = "could you tell me about the pricing".split(" ");
  for (let n = 3; n <= words.length; n++) {
    asr.send(1, words.slice(0, n).join(" "), false);
    await sleep(100); // faster than the 250 ms stability window
  }
  assert.equal(of("turn.started").length, 0, "no speculation while the question keeps growing");
  await waitFor(() => of("turn.started").length === 1, { timeout: 1000, label: "timer turn" });
  assert.equal(of("turn.started")[0].data.question, words.join(" "));
});
