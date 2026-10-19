import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";

/**
 * Speculative answers are generated while the prospect is still talking but
 * held off screen until they are done: a ~0.7 s pause (plus, with a judge,
 * Jev saying the prospect finished a question) or the final transcript.
 * A held answer the prospect talks past is retired without a trace.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 3000, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
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

function answerer({ deltaMs = 3, count = 4 } = {}) {
  const calls = [];
  async function* streamAnswer(args) {
    const call = { question: args.question, finished: false };
    calls.push(call);
    for (let i = 0; i < count; i += 1) {
      await sleep(deltaMs);
      if (args.signal?.aborted) return;
      yield i === 0 ? `ANSWER TO: ${args.question}` : " .";
    }
    call.finished = true;
  }
  return { calls, streamAnswer };
}

/** `verdicts(utterance, input)` -> { isQuestion, isComplete }. */
function fakeJudge(verdicts, { delayMs = 10 } = {}) {
  const judge = {
    enabled: true,
    features: { gate: true, rescue: false },
    calls: [],
    async evaluate(input) {
      judge.calls.push(input);
      await sleep(delayMs);
      const v = verdicts(input.utterance, input);
      return {
        isQuestion: v.isQuestion ?? null,
        answersSame: null,
        isComplete: input.askComplete ? v.isComplete ?? null : null,
        latencyMs: delayMs,
        error: null,
      };
    },
    close() {},
  };
  return judge;
}

function setup({ judge, answer } = {}) {
  const frames = [];
  const logs = [];
  const asr = fakeAsr();
  const ans = answerer(answer);
  const engine = createPipelineEngine({ emit: (f) => frames.push(f), asr, answerer: ans, judge, log: (e) => logs.push(e) });
  engine.onSessionStart({ sessionId: "hold" });
  const turnFrames = () => frames.filter((f) => f.type.startsWith("turn."));
  const of = (type) => frames.filter((f) => f.type === type);
  return { frames, logs, asr, answerer: ans, engine, turnFrames, of };
}

const QUESTION = "how much does the enterprise plan cost per seat for us";
const TRAILING = "so what I'm really wondering is whether the enterprise plan";

test("a speculative answer is generated while the prospect talks but never shown mid-sentence", async () => {
  const { asr, answerer: ans, engine, turnFrames } = setup();
  asr.send(1, QUESTION); // >= 8 words: generation starts now
  await waitFor(() => ans.calls[0]?.finished, { label: "prefetch generated" });
  assert.equal(ans.calls.length, 1);
  assert.deepEqual(turnFrames(), [], "nothing reaches the screen before the prospect is done");
  engine.dispose();
});

test("no judge: the ~0.7 s pause shows the held answer at once, already written", async () => {
  const { asr, answerer: ans, engine, of, logs } = setup();
  asr.send(1, QUESTION);
  await waitFor(() => ans.calls[0]?.finished);
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  assert.equal(of("turn.started").length, 1);
  const tokens = of("turn.token");
  assert.equal(tokens.length, 1, "the held tokens arrive as one delta");
  assert.equal(tokens[0].data.delta, `ANSWER TO: ${QUESTION} . . .`);
  assert.equal(of("turn.done").length, 1);
  assert.equal(ans.calls.length, 1, "no regeneration");
  assert.ok(logs.some((e) => e.type === "turn.revealed" && e.why === "pause"));
  engine.dispose();
});

test("a held answer still streaming at the reveal keeps streaming live", async () => {
  const { asr, answerer: ans, engine, of } = setup({ answer: { deltaMs: 25, count: 4 } });
  asr.send(1, QUESTION);
  await waitFor(() => ans.calls.length === 1);
  await sleep(40); // a token or so generated, still held
  assert.equal(of("turn.started").length, 0);
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  assert.equal(of("turn.started").length, 1);
  const before = of("turn.token").length;
  await waitFor(() => of("turn.done").length === 1, { label: "stream end" });
  assert.ok(of("turn.token").length > before, "later tokens stream as usual");
  const text = of("turn.token").map((f) => f.data.delta).join("");
  assert.equal(text, of("turn.done")[0].data.text);
  engine.dispose();
});

test("a revealed answer is labelled with the latest wording, not the partial it started from", async () => {
  const { asr, answerer: ans, engine, of } = setup();
  asr.send(1, QUESTION); // generation starts on this partial
  asr.send(1, `${QUESTION} please`); // non-material growth: same stream, newer wording
  await waitFor(() => ans.calls[0]?.finished);
  assert.equal(ans.calls.length, 1);
  asr.send(1, `${QUESTION} please`, true);
  const [started] = of("turn.started");
  assert.equal(started.data.question, `${QUESTION} please`, "the question line shows what the prospect finished saying");
  engine.dispose();
});

test("the final transcript shows a held answer that no pause revealed", async () => {
  const { asr, answerer: ans, engine, of } = setup();
  asr.send(1, QUESTION);
  await waitFor(() => ans.calls[0]?.finished);
  assert.equal(of("turn.started").length, 0);
  asr.send(1, QUESTION, true);
  assert.equal(of("turn.started").length, 1);
  assert.equal(of("turn.done").length, 1);
  assert.equal(ans.calls.length, 1, "the held answer is committed, not regenerated");
  engine.dispose();
});

test("a held answer the prospect talks past is retired without a trace", async () => {
  const { asr, answerer: ans, engine, frames } = setup();
  asr.send(1, QUESTION);
  await waitFor(() => ans.calls.length === 1);
  asr.send(1, "what does the onboarding timeline look like for a brand new team");
  await waitFor(() => ans.calls.length === 2);
  assert.deepEqual(
    frames.filter((f) => f.type.startsWith("turn.")),
    [],
    "no started, token or superseded frame for answers never shown",
  );
  engine.dispose();
});

test("judge: a pause on an unfinished thought keeps the answer hidden; the final shows it", async () => {
  const judge = fakeJudge(() => ({ isQuestion: 0.6, isComplete: 0.02 }));
  const { asr, answerer: ans, engine, of } = setup({ judge });
  asr.send(1, TRAILING);
  await waitFor(() => ans.calls[0]?.finished);
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  await waitFor(() => judge.calls.some((c) => c.askComplete), { label: "reveal check" });
  await sleep(30);
  assert.equal(of("turn.started").length, 0, "Jev: not finished, so nothing shows");
  asr.send(1, TRAILING, true);
  assert.equal(of("turn.started").length, 1, "the final is the fallback");
  engine.dispose();
});

test("judge: a pause on a finished question shows it once Jev agrees", async () => {
  const judge = fakeJudge(() => ({ isQuestion: 0.99, isComplete: 0.96 }));
  const { asr, answerer: ans, engine, of, logs } = setup({ judge });
  asr.send(1, QUESTION);
  await waitFor(() => ans.calls[0]?.finished);
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  assert.equal(of("turn.started").length, 0, "not before the verdict");
  await waitFor(() => of("turn.started").length === 1, { label: "reveal" });
  const ask = judge.calls.find((c) => c.askComplete);
  assert.equal(ask.utterance, QUESTION);
  assert.ok(logs.some((e) => e.type === "turn.revealed" && e.why === "pause_judged"));
  engine.dispose();
});

test("judge: small talk at a pause is never shown and its final opens no turn", async () => {
  const smallTalk = "yeah that makes sense I think the team would be fine with that";
  const judge = fakeJudge(() => ({ isQuestion: 0.03, isComplete: 0.8 }));
  const { asr, engine, frames } = setup({ judge });
  asr.send(1, smallTalk);
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  await waitFor(() => judge.calls.some((c) => c.askComplete));
  await sleep(30);
  asr.send(1, smallTalk, true);
  await sleep(30);
  assert.deepEqual(frames.filter((f) => f.type.startsWith("turn.")), []);
  engine.dispose();
});

test("judge: the prospect resuming before the verdict lands keeps the answer hidden", async () => {
  const judge = fakeJudge(() => ({ isQuestion: 0.99, isComplete: 0.9 }), { delayMs: 40 });
  const { asr, answerer: ans, engine, of } = setup({ judge });
  asr.send(1, QUESTION);
  await waitFor(() => ans.calls[0]?.finished);
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  engine.onTurnHint({ streamIdx: 1, state: "resume" });
  await sleep(80);
  assert.equal(of("turn.started").length, 0);
  engine.dispose();
});

test("committed turns are never held: a final with no prefetch shows immediately", async () => {
  const { asr, engine, of } = setup();
  asr.send(1, "pricing?", true);
  assert.equal(of("turn.started").length, 1);
  engine.dispose();
});

test("holdSpeculation: false keeps the old show-while-talking behaviour", async () => {
  const frames = [];
  const asr = fakeAsr();
  const engine = createPipelineEngine({ emit: (f) => frames.push(f), asr, answerer: answerer(), holdSpeculation: false });
  engine.onSessionStart({ sessionId: "live" });
  asr.send(1, QUESTION);
  assert.equal(frames.filter((f) => f.type === "turn.started").length, 1);
  engine.dispose();
});
