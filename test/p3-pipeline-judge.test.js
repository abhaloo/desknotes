import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";

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

/** Echoes its question; per-question pacing so tests can make one stream slow and another fast. */
function streamingAnswerer({ deltaMs = 4, count = 4 } = {}) {
  const calls = [];
  const pace = typeof deltaMs === "function" ? deltaMs : () => deltaMs;
  async function* streamAnswer(args) {
    const call = { question: args.question, cancelled: false, finished: false };
    calls.push(call);
    for (let i = 0; i < count; i += 1) {
      await sleep(pace(args.question));
      if (args.signal?.aborted) {
        call.cancelled = true;
        return;
      }
      yield i === 0 ? `ANSWER TO: ${args.question}` : " .";
    }
    call.finished = true;
  }
  return { calls, streamAnswer };
}

function fakeJudge({ isQuestion = () => 0.95, answersSame = () => 0.95, delayMs = 20, features = { gate: true, rescue: true }, enabled = true } = {}) {
  const judge = {
    enabled,
    features,
    calls: [],
    closed: false,
    async evaluate(input) {
      judge.calls.push(input);
      await sleep(delayMs);
      return {
        isQuestion: isQuestion(input.utterance),
        answersSame: input.answeredFor ? answersSame(input.answeredFor, input.utterance) : null,
        latencyMs: delayMs,
        error: null,
      };
    },
    close() {
      judge.closed = true;
    },
  };
  return judge;
}

function setup({ judge, answerer = {}, policy } = {}) {
  const frames = [];
  const logs = [];
  const asr = fakeAsr();
  const ans = streamingAnswerer(answerer);
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer: ans,
    log: (entry) => logs.push(entry),
    judge,
    judgePolicy: policy,
    // These tests watch speculative turns on the wire; holding them until the
    // prospect is done is covered in p3-pipeline-hold.test.js.
    holdSpeculation: false,
  });
  engine.onSessionStart({ sessionId: "s" });
  return { frames, logs, asr, answerer: ans, engine };
}

const ofType = (frames, type) => frames.filter((f) => f.type === type);
const tokensFor = (frames, id) => frames.filter((f) => f.type === "turn.token" && f.data.turn_id === id).map((f) => f.data.delta).join("");
const doneFor = (frames, id) => frames.find((f) => f.type === "turn.done" && f.data.turn_id === id);

const SMALL_TALK = "yeah that makes sense I think the team would be fine with that";
const QUESTION = "how much does the enterprise tier cost per seat for forty people";
const TIER = "how much is the pro tier per seat for a team of forty";
const PLAN = "how much is the pro plan per seat for a team of forty";

test("a disabled judge changes nothing: a reworded final regenerates and the judge is never asked", async () => {
  const judge = fakeJudge({ enabled: false });
  const { frames, asr, engine } = setup({ judge });
  asr.send(1, TIER);
  await sleep(40);
  asr.send(1, PLAN, true);
  const fresh = await waitFor(() => ofType(frames, "turn.started").find((f) => f.data.question === PLAN), { label: "regenerated turn" });
  await waitFor(() => doneFor(frames, fresh.data.turn_id), { label: "regenerated answer done" });
  assert.equal(judge.calls.length, 0);
  engine.onSessionEnd();
});

test("the gate never delays the start of a turn", () => {
  const judge = fakeJudge({ delayMs: 300 });
  const { frames, asr, engine } = setup({ judge });
  asr.send(1, QUESTION);
  assert.equal(ofType(frames, "turn.started").length, 1, "turn.started is emitted synchronously");
  assert.equal(judge.calls.length, 1);
  engine.onSessionEnd();
});

test("gate cancels a small-talk prefetch, its final opens no turn, and the next question prefetches at once", async () => {
  const judge = fakeJudge({ isQuestion: (u) => (u.startsWith("yeah") ? 0.05 : 0.95) });
  const { frames, logs, asr, engine } = setup({ judge, answerer: { deltaMs: 30, count: 20 } });
  asr.send(1, SMALL_TALK);
  const first = (await waitFor(() => ofType(frames, "turn.started")[0])).data.turn_id;
  await waitFor(() => ofType(frames, "turn.superseded").some((f) => f.data.turn_id === first), { label: "small talk retired" });
  assert.ok(logs.some((l) => l.type === "turn.gated_out"));
  asr.send(1, SMALL_TALK, true);
  await sleep(30);
  assert.equal(ofType(frames, "turn.started").length, 1, "the small-talk final must not reopen a committed turn");
  asr.send(1, QUESTION);
  const second = await waitFor(() => ofType(frames, "turn.started")[1], { label: "question prefetch" });
  assert.equal(second.data.question, QUESTION);
  engine.onSessionEnd();
});

test("a committed small-talk answer no longer blocks the next question's prefetch", async () => {
  const judge = fakeJudge({ isQuestion: (u) => (u.startsWith("yeah") ? 0.05 : 0.95) });
  const { frames, asr, engine } = setup({ judge, answerer: { deltaMs: 30, count: 20 } });
  asr.send(1, SMALL_TALK, true); // committed final straight away
  const first = (await waitFor(() => ofType(frames, "turn.started")[0])).data.turn_id;
  await waitFor(() => ofType(frames, "turn.superseded").some((f) => f.data.turn_id === first), { label: "committed small talk retired" });
  asr.send(1, QUESTION);
  const second = await waitFor(() => ofType(frames, "turn.started")[1], { timeout: 400, label: "prefetch well before the small-talk answer would finish (600 ms)" });
  assert.equal(second.data.question, QUESTION);
  engine.onSessionEnd();
});

test("a real question is kept, and a failed judge fails open", async () => {
  for (const isQuestion of [() => 0.95, () => null]) {
    const judge = fakeJudge({ isQuestion });
    const { frames, asr, engine } = setup({ judge });
    asr.send(1, QUESTION, true);
    const turn = (await waitFor(() => ofType(frames, "turn.started")[0])).data.turn_id;
    await waitFor(() => doneFor(frames, turn), { label: "answer done" });
    assert.equal(ofType(frames, "turn.superseded").length, 0);
    engine.onSessionEnd();
  }
});

test("manual answer requests are never judged", async () => {
  const judge = fakeJudge({ isQuestion: () => 0.01 });
  const { frames, engine } = setup({ judge });
  assert.equal(engine.onAnswerRequest({ utterance: "yeah ok" }), true);
  const turn = (await waitFor(() => ofType(frames, "turn.started")[0])).data.turn_id;
  await waitFor(() => doneFor(frames, turn), { label: "manual answer done" });
  assert.equal(judge.calls.length, 0);
  engine.onSessionEnd();
});

test("rescue: a reworded final reuses the finished prefetch instead of regenerating", async () => {
  const judge = fakeJudge({ answersSame: () => 0.95 });
  const { frames, logs, asr, answerer, engine } = setup({ judge, answerer: { deltaMs: (q) => (q === PLAN ? 40 : 5), count: 4 } });
  asr.send(1, TIER);
  await waitFor(() => answerer.calls[0]?.finished, { label: "prefetch finished" });
  asr.send(1, PLAN, true);
  const rescued = await waitFor(() => logs.find((l) => l.type === "turn.rescued"), { label: "rescue" });
  const started = ofType(frames, "turn.started").find((f) => f.data.turn_id === rescued.turn_id);
  assert.equal(started.data.question, PLAN);
  assert.ok(tokensFor(frames, rescued.turn_id).startsWith(`ANSWER TO: ${TIER}`));
  await waitFor(() => doneFor(frames, rescued.turn_id), { label: "rescued answer done" });
  const fresh = answerer.calls.find((c) => c.question === PLAN);
  await waitFor(() => fresh.cancelled, { label: "regeneration cancelled" });
  engine.onSessionEnd();
});

test("rescue keeps streaming: a still-running prefetch is promoted and forwards its remaining tokens", async () => {
  const judge = fakeJudge({ answersSame: () => 0.95, delayMs: 20 });
  const { frames, logs, asr, engine } = setup({ judge, answerer: { deltaMs: (q) => (q === TIER ? 30 : 60), count: 10 } });
  asr.send(1, TIER);
  await sleep(45); // the prefetch has emitted 1 of 10 deltas
  asr.send(1, PLAN, true);
  const rescued = await waitFor(() => logs.find((l) => l.type === "turn.rescued"), { label: "rescue" });
  const done = await waitFor(() => doneFor(frames, rescued.turn_id), { label: "rescued answer done" });
  const expected = `ANSWER TO: ${TIER}` + " .".repeat(9);
  assert.equal(tokensFor(frames, rescued.turn_id), expected);
  assert.equal(done.data.text, expected);
  engine.onSessionEnd();
});

test("rescue declined: the regenerated answer stands and the prefetch stops", async () => {
  const judge = fakeJudge({ answersSame: () => 0.1 });
  const { frames, logs, asr, answerer, engine } = setup({ judge, answerer: { deltaMs: 30, count: 20 } });
  asr.send(1, TIER);
  await sleep(45);
  asr.send(1, PLAN, true);
  const fresh = await waitFor(() => ofType(frames, "turn.started").find((f) => f.data.question === PLAN), { label: "regenerated turn" });
  await waitFor(() => answerer.calls[0].cancelled, { label: "shadow prefetch stopped" });
  assert.ok(!logs.some((l) => l.type === "turn.rescued"));
  assert.ok(!ofType(frames, "turn.superseded").some((f) => f.data.turn_id === fresh.data.turn_id));
  engine.onSessionEnd();
});

test("rescue arrives too late: a regenerated answer that already finished stands", async () => {
  const judge = fakeJudge({ answersSame: () => 0.95, delayMs: 150 });
  const { frames, logs, asr, engine } = setup({ judge, answerer: { deltaMs: 5, count: 4 } });
  asr.send(1, TIER);
  await sleep(40);
  asr.send(1, PLAN, true);
  const fresh = await waitFor(() => ofType(frames, "turn.started").find((f) => f.data.question === PLAN));
  await waitFor(() => doneFor(frames, fresh.data.turn_id), { label: "regenerated answer done" });
  await sleep(200);
  assert.ok(!logs.some((l) => l.type === "turn.rescued"));
  assert.ok(logs.some((l) => l.type === "turn.shadow_dropped"));
  engine.onSessionEnd();
});

test("gate and rescue share one judge request at a reworded final", async () => {
  const judge = fakeJudge();
  const { asr, logs, engine } = setup({ judge, answerer: { deltaMs: (q) => (q === PLAN ? 40 : 5), count: 4 } });
  asr.send(1, TIER);
  await sleep(40);
  asr.send(1, PLAN, true);
  await waitFor(() => logs.find((l) => l.type === "judge.rescue"), { label: "rescue verdict" });
  const forFinal = judge.calls.filter((c) => c.utterance === PLAN);
  assert.equal(forFinal.length, 1);
  assert.equal(forFinal[0].answeredFor, TIER);
  engine.onSessionEnd();
});

// The prefetch starts on a 10-word prefix; interims then converge (non-material
// growth) on the full question, and the final rewords one word of it.
const PREFIX = "how much is the pro tier per seat for a";
const FULL_TIER = `${PREFIX} team of forty people`;
const FULL_PLAN = "how much is the pro plan per seat for a team of forty people";

test("rescue asks the judge about the last interim, not the shorter prefix the prefetch started from", async () => {
  // Mirrors live Jev: the prefix lacks "team of forty people" (p≈0.41); the full interim is the same question (p≈0.96).
  const judge = fakeJudge({ answersSame: (answeredFor) => (answeredFor === FULL_TIER ? 0.95 : 0.41) });
  const { frames, logs, asr, answerer, engine } = setup({ judge, answerer: { deltaMs: (q) => (q === FULL_PLAN ? 40 : 5), count: 4 } });
  asr.send(1, PREFIX);
  for (const tail of [" team", " team of", " team of forty", " team of forty people"]) asr.send(1, PREFIX + tail);
  assert.equal(answerer.calls.length, 1, "the converging interims never restarted the prefetch");
  await waitFor(() => answerer.calls[0]?.finished, { label: "prefetch finished" });
  asr.send(1, FULL_PLAN, true);
  const rescued = await waitFor(() => logs.find((l) => l.type === "turn.rescued"), { label: "rescue" });
  const forFinal = judge.calls.filter((c) => c.utterance === FULL_PLAN);
  assert.equal(forFinal.length, 1);
  assert.equal(forFinal[0].answeredFor, FULL_TIER);
  assert.equal(logs.find((l) => l.type === "judge.rescue").eligible, true);
  assert.ok(tokensFor(frames, rescued.turn_id).startsWith(`ANSWER TO: ${PREFIX}`));
  await waitFor(() => doneFor(frames, rescued.turn_id), { label: "rescued answer done" });
  engine.onSessionEnd();
});

// ASR revision mid-stream: the interim regresses to "how much is the pro" and
// regrows as "pro plan ... team of forty people". Each step is a continuation
// of the tracked text, so the prefetch for PREFIX ("pro tier ... for a") keeps
// running, but it no longer answers the last interim.
function sendRevisedInterims(asr) {
  asr.send(1, PREFIX);
  asr.send(1, "how much is the pro");
  asr.send(1, FULL_PLAN);
}

test("rescue is refused when the prefetch's start text does not continue into the last interim, whatever the judge says", async () => {
  const judge = fakeJudge({ answersSame: () => 0.95 });
  const { frames, logs, asr, answerer, engine } = setup({ judge, answerer: { deltaMs: (q) => (q === FULL_PLAN ? 20 : 5), count: 4 } });
  sendRevisedInterims(asr);
  assert.equal(answerer.calls.length, 1, "the revised interims never restarted the prefetch");
  await waitFor(() => answerer.calls[0]?.finished, { label: "prefetch finished" });
  asr.send(1, FULL_PLAN, true);
  const verdict = await waitFor(() => logs.find((l) => l.type === "judge.rescue"), { label: "rescue verdict" });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.p_same, 0.95, "the judge was still asked (its is_question feeds the gate)");
  const fresh = ofType(frames, "turn.started").find((f) => f.data.question === FULL_PLAN);
  await waitFor(() => doneFor(frames, fresh.data.turn_id), { label: "regenerated answer done" });
  assert.ok(tokensFor(frames, fresh.data.turn_id).startsWith(`ANSWER TO: ${FULL_PLAN}`));
  assert.ok(!logs.some((l) => l.type === "turn.rescued"));
  assert.ok(logs.some((l) => l.type === "turn.shadow_dropped" && l.reason === "ineligible"));
  engine.onSessionEnd();
});

test("an ineligible shadow still lets the gate cancel a reworded final the judge calls small talk", async () => {
  const judge = fakeJudge({ isQuestion: (u) => (u === FULL_PLAN ? 0.05 : 0.95), answersSame: () => 0.95 });
  const { frames, logs, asr, answerer, engine } = setup({ judge, answerer: { deltaMs: 30, count: 20 } });
  sendRevisedInterims(asr);
  await sleep(45);
  asr.send(1, FULL_PLAN, true);
  const gated = await waitFor(() => logs.find((l) => l.type === "turn.gated_out"), { label: "fresh turn gated out" });
  assert.equal(gated.committed, true);
  assert.ok(ofType(frames, "turn.superseded").some((f) => f.data.turn_id === gated.turn_id));
  assert.equal(logs.find((l) => l.type === "judge.rescue").eligible, false);
  await waitFor(() => answerer.calls[0].cancelled, { label: "shadow prefetch stopped" });
  assert.ok(!logs.some((l) => l.type === "turn.rescued"));
  engine.onSessionEnd();
});

test("ending the session during a pending rescue emits nothing more and closes the judge", async () => {
  const judge = fakeJudge({ delayMs: 100 });
  const { frames, asr, answerer, engine } = setup({ judge, answerer: { deltaMs: 30, count: 20 } });
  asr.send(1, TIER);
  await sleep(45);
  asr.send(1, PLAN, true);
  await sleep(10);
  engine.onSessionEnd();
  const count = frames.length;
  await sleep(200);
  assert.equal(frames.length, count, "no frames after session end");
  assert.equal(judge.closed, true);
  assert.equal(answerer.calls[0].cancelled, true, "shadow generation aborted");
});
