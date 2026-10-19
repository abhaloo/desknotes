import test from "node:test";
import assert from "node:assert/strict";
import { SCREEN_CONTEXT_TTL_MS, buildContext, createPipelineEngine } from "../src/server/engines/pipeline.js";

/*
 * Screen turns: stage 1 (vision interprets the screenshot) feeds stage 2 (a
 * normal answer turn in the lane). The interpretation then stays in the
 * context of later turns until Clear, a newer capture or the staleness TTL.
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
    finalize() {},
    close() {},
    onTranscript(cb) {
      handlers.push(cb);
    },
    send(streamIdx, text, final) {
      const data = { text, final, stream: streamIdx, streamIdx, role: streamIdx === 1 ? "prospect" : "rep" };
      for (const cb of handlers) cb(data);
    },
  };
}

/** Records every streamAnswer call; each answer streams `count` deltas `deltaMs` apart. */
function recordingAnswerer({ deltaMs = 2, count = 3 } = {}) {
  const calls = [];
  async function* streamAnswer(args) {
    const call = { args, cancelled: false };
    calls.push(call);
    for (let i = 0; i < count; i += 1) {
      await sleep(deltaMs);
      if (args.signal?.aborted) {
        call.cancelled = true;
        return;
      }
      yield `[a${calls.length}:${i}] `;
    }
  }
  return { calls, streamAnswer };
}

/** Vision double: answers each analyse() with the next queued result (or a default). */
function fakeVision(results = []) {
  const queue = [...results];
  const requests = [];
  return {
    requests,
    async analyse(request) {
      requests.push(request);
      const next = queue.shift() ?? reading("Default screen text.");
      if (typeof next === "function") return next(request);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function reading(summary, extra = {}) {
  return {
    analysisId: `an_${summary.length}`,
    status: "ok",
    kind: "question",
    title: "System design question",
    summary,
    error: "",
    dedup: false,
    solve: "not_requested",
    ...extra,
  };
}

function fakeClock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms) => (value += ms) };
}

function setup({ vision, answerer = recordingAnswerer(), clock = fakeClock(), telemetry } = {}) {
  const frames = [];
  const logs = [];
  const asr = fakeAsr();
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    log: (entry) => logs.push(entry),
    asr,
    answerer,
    vision,
    now: clock.now,
    telemetry,
  });
  engine.onSessionStart({ sessionId: "s-screen" });
  const doneCount = () => frames.filter((frame) => frame.type === "turn.done").length;
  return { frames, logs, asr, answerer, engine, clock, doneCount };
}

const QUESTION_ON_SCREEN = 'Visible question, verbatim: "Design a URL shortener that handles 10k writes per second."';

test("an analysis starts exactly one answer turn whose context has the screen and the conversation", async () => {
  const vision = fakeVision([reading(QUESTION_ON_SCREEN)]);
  const { engine, answerer, asr, frames, doneCount } = setup({ vision });

  // A committed exchange first (it becomes RECENT EXCHANGE)...
  engine.onAnswerRequest({ utterance: "what database do you use" });
  await waitFor(() => doneCount() === 1, { label: "first answer" });
  // ...then the prospect speaks without any turn being committed: a final
  // that the judge-less pipeline answers, and a fresh partial still open.
  asr.send(1, "so here is the problem we are stuck on", true);
  await waitFor(() => doneCount() === 2, { label: "spoken answer" });
  asr.send(1, "how would you scale this", false);
  const before = answerer.calls.length;
  const startedBefore = frames.filter((frame) => frame.type === "turn.started").length;

  const result = await engine.onScreenAnalyse({ command_id: "cmd-1", image_hash: "ab".repeat(32) });
  assert.equal(result.status, "ok", "the vision result is returned unchanged for screen.result");
  assert.equal(result.summary, QUESTION_ON_SCREEN);

  await waitFor(() => doneCount() === 3, { label: "screen answer" });
  assert.equal(answerer.calls.length, before + 1, "exactly one answer turn per analysis");
  assert.equal(frames.filter((frame) => frame.type === "turn.started").length, startedBefore + 1);
  const { args } = answerer.calls.at(-1);
  assert.equal(args.screen, "capture");
  assert.equal(args.intent, "screen");
  assert.match(args.context, /SCREEN \(captured just now; kind: question; title: System design question\):\n/);
  assert.ok(args.context.includes(QUESTION_ON_SCREEN));
  assert.ok(args.context.includes("RECENT EXCHANGE:\nQ: what database do you use"));
  assert.ok(args.context.includes("PROSPECT SPEECH (latest last):\n- so here is the problem we are stuck on\n- how would you scale this"));
  assert.equal(args.question, 'The prospect\'s latest words: "how would you scale this"');

  // The answer streams in the normal lane: started -> tokens -> done, committed.
  const started = frames.filter((frame) => frame.type === "turn.started").at(-1);
  assert.equal(started.data.intent, "screen");
  // The answer window shows the prospect's words and what was captured, not the prompt text.
  assert.equal(started.data.display_question, "how would you scale this (with the screen: System design question)");
  const done = frames.filter((frame) => frame.type === "turn.done").at(-1);
  assert.equal(done.data.turn_id, started.data.turn_id);
  assert.ok(done.data.text.length > 0);
  assert.equal(frames.filter((frame) => frame.type === "screen.result").length, 0, "the transport sends screen.result, not the pipeline");
  engine.onSessionEnd();
});

test("with nothing said yet, the screen turn answers what the screen shows", async () => {
  const { engine, answerer, doneCount, frames } = setup({ vision: fakeVision([reading(QUESTION_ON_SCREEN)]) });
  await engine.onScreenAnalyse({ command_id: "solo", image_hash: "ab".repeat(32) });
  await waitFor(() => doneCount() === 1);
  const { args } = answerer.calls[0];
  assert.equal(args.question, "Answer the question or task shown on the screen.");
  const started = frames.find((frame) => frame.type === "turn.started");
  assert.equal(started.data.display_question, "On screen: System design question");
  assert.equal(args.context.includes("PROSPECT SPEECH"), false);
  assert.ok(args.context.includes(QUESTION_ON_SCREEN));
  engine.onSessionEnd();
});

test("the screen block persists into later spoken turns with its age, then expires", async () => {
  const clock = fakeClock();
  const { engine, answerer, doneCount } = setup({ vision: fakeVision([reading(QUESTION_ON_SCREEN)]), clock });
  await engine.onScreenAnalyse({ command_id: "p1", image_hash: "ab".repeat(32) });
  await waitFor(() => doneCount() === 1);

  clock.advance(3 * 60_000);
  engine.onAnswerRequest({ utterance: "and what about caching" });
  await waitFor(() => doneCount() === 2);
  const later = answerer.calls[1].args;
  assert.equal(later.screen, "context", "a later turn carries the screen as context, not as a capture");
  assert.equal(later.intent, "manual");
  assert.match(later.context, /SCREEN \(captured 3 minutes ago; kind: question/);
  assert.ok(later.context.includes(QUESTION_ON_SCREEN));
  assert.equal(later.context.includes("PROSPECT SPEECH"), false, "only the screen turn carries raw prospect lines");
  // The screen exchange is follow-up history under a short label.
  assert.match(later.context, /RECENT EXCHANGE:\nQ: \[screen: System design question\]\nA: /);

  clock.advance(SCREEN_CONTEXT_TTL_MS);
  engine.onAnswerRequest({ utterance: "anything else" });
  await waitFor(() => doneCount() === 3);
  const expired = answerer.calls[2].args;
  assert.equal("screen" in expired, false);
  assert.equal(expired.context.includes("SCREEN ("), false);
  assert.equal(SCREEN_CONTEXT_TTL_MS, 10 * 60_000);
  engine.onSessionEnd();
});

test("Clear drops the screen context, and a screen answer still streaming", async () => {
  const answerer = recordingAnswerer({ deltaMs: 15, count: 20 });
  const { engine, frames, doneCount, logs } = setup({ vision: fakeVision([reading(QUESTION_ON_SCREEN)]), answerer });
  await engine.onScreenAnalyse({ command_id: "c1", image_hash: "ab".repeat(32) });
  const started = await waitFor(() => frames.find((frame) => frame.type === "turn.started"));
  await waitFor(() => frames.some((frame) => frame.type === "turn.token"));

  engine.onScreenClear();
  await waitFor(() => answerer.calls[0].cancelled, { label: "screen answer cancelled" });
  assert.ok(frames.some((frame) => frame.type === "turn.superseded" && frame.data.turn_id === started.data.turn_id));
  assert.ok(logs.some((entry) => entry.type === "screen.context_cleared" && entry.had === true));

  engine.onAnswerRequest({ utterance: "next question" });
  await waitFor(() => answerer.calls.length === 2);
  assert.equal(answerer.calls[1].args.context.includes("SCREEN ("), false);
  assert.equal("screen" in answerer.calls[1].args, false);
  await waitFor(() => doneCount() === 1);
  engine.onSessionEnd();
});

test("Clear while a capture is in flight discards its result: no context, no turn", async () => {
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  const { engine, answerer } = setup({ vision: fakeVision([() => pending]) });
  const analysing = engine.onScreenAnalyse({ command_id: "late", image_hash: "ab".repeat(32) });
  await sleep(5);
  engine.onScreenClear();
  release(reading(QUESTION_ON_SCREEN));
  const result = await analysing;
  assert.equal(result.status, "ok", "the card still gets its result");
  await sleep(30);
  assert.equal(answerer.calls.length, 0);
  engine.onAnswerRequest({ utterance: "q" });
  await waitFor(() => answerer.calls.length === 1);
  assert.equal(answerer.calls[0].args.context.includes("SCREEN ("), false);
  engine.onSessionEnd();
});

test("a newer capture replaces the screen context; only the latest is kept", async () => {
  const { engine, answerer, doneCount } = setup({
    vision: fakeVision([reading("FIRST SCREEN: a slide about caching."), reading("SECOND SCREEN: a Python editor.", { kind: "code" })]),
  });
  await engine.onScreenAnalyse({ command_id: "n1", image_hash: "ab".repeat(32) });
  await waitFor(() => doneCount() === 1);
  await engine.onScreenAnalyse({ command_id: "n2", image_hash: "cd".repeat(32) });
  await waitFor(() => doneCount() === 2);
  engine.onAnswerRequest({ utterance: "follow up" });
  await waitFor(() => doneCount() === 3);
  for (const { args } of answerer.calls.slice(1)) {
    assert.ok(args.context.includes("SECOND SCREEN"));
    assert.equal(args.context.includes("FIRST SCREEN"), false);
    assert.equal(args.context.match(/SCREEN \(captured/g).length, 1, "one SCREEN block");
  }
  engine.onSessionEnd();
});

test("an older capture landing after a newer one never replaces it", async () => {
  let releaseOld;
  const oldPending = new Promise((resolve) => (releaseOld = resolve));
  const { engine, answerer, doneCount } = setup({
    vision: fakeVision([() => oldPending, reading("NEWER SCREEN.")]),
  });
  const older = engine.onScreenAnalyse({ command_id: "o1", image_hash: "ab".repeat(32) });
  await engine.onScreenAnalyse({ command_id: "o2", image_hash: "cd".repeat(32) });
  releaseOld(reading("OLDER SCREEN."));
  await older;
  await waitFor(() => doneCount() === 1);
  await sleep(20);
  assert.equal(answerer.calls.length, 1, "only the newer capture answers");
  assert.ok(answerer.calls[0].args.context.includes("NEWER SCREEN."));
  engine.onAnswerRequest({ utterance: "q" });
  await waitFor(() => answerer.calls.length === 2);
  assert.ok(answerer.calls[1].args.context.includes("NEWER SCREEN."));
  assert.equal(answerer.calls[1].args.context.includes("OLDER SCREEN."), false);
  engine.onSessionEnd();
});

test("a vision failure starts no answer turn and keeps the previous screen context", async () => {
  const { engine, answerer, frames, doneCount } = setup({
    vision: fakeVision([
      reading("KEPT SCREEN."),
      { status: "failed", kind: "", title: "", summary: "", error: "the vision model could not read the screen", failure: "provider", dedup: false, solve: "not_requested" },
      { status: "empty", kind: "other", title: "", summary: "", error: "", dedup: false, solve: "not_requested" },
      reading("   "),
      new Error("vision exploded"),
    ]),
  });
  await engine.onScreenAnalyse({ command_id: "ok", image_hash: "ab".repeat(32) });
  await waitFor(() => doneCount() === 1);
  const turnsBefore = frames.filter((frame) => frame.type === "turn.started").length;

  const failed = await engine.onScreenAnalyse({ command_id: "f1", image_hash: "cd".repeat(32) });
  const empty = await engine.onScreenAnalyse({ command_id: "f2", image_hash: "cd".repeat(32) });
  const blank = await engine.onScreenAnalyse({ command_id: "f3", image_hash: "cd".repeat(32) });
  const thrown = await engine.onScreenAnalyse({ command_id: "f4", image_hash: "cd".repeat(32) });
  assert.equal(failed.status, "failed");
  assert.equal(empty.status, "empty");
  assert.equal(thrown.status, "failed");
  assert.equal(blank.status, "ok");
  await sleep(30);
  assert.equal(frames.filter((frame) => frame.type === "turn.started").length, turnsBefore, "no failure opened a turn");
  assert.equal(answerer.calls.length, 1);

  engine.onAnswerRequest({ utterance: "q" });
  await waitFor(() => answerer.calls.length === 2);
  assert.ok(answerer.calls[1].args.context.includes("KEPT SCREEN."), "a failed capture does not erase the last good one");
  engine.onSessionEnd();
});

test("a capture the server already timed out (aborted signal) starts no turn", async () => {
  const controller = new AbortController();
  const { engine, answerer } = setup({
    vision: fakeVision([
      () => {
        controller.abort();
        return reading(QUESTION_ON_SCREEN);
      },
    ]),
  });
  await engine.onScreenAnalyse({ command_id: "t1", image_hash: "ab".repeat(32), signal: controller.signal });
  await sleep(30);
  assert.equal(answerer.calls.length, 0);
  engine.onSessionEnd();
});

test("a capture replaces a streaming answer (cancel/replace); speech during the screen answer queues", async () => {
  const answerer = recordingAnswerer({ deltaMs: 15, count: 12 });
  const { engine, asr, frames, doneCount } = setup({ vision: fakeVision([reading(QUESTION_ON_SCREEN)]), answerer });
  engine.onAnswerRequest({ utterance: "tell me about your team" });
  const first = await waitFor(() => frames.find((frame) => frame.type === "turn.started"));
  await waitFor(() => frames.some((frame) => frame.type === "turn.token"));

  await engine.onScreenAnalyse({ command_id: "r1", image_hash: "ab".repeat(32) });
  await waitFor(() => answerer.calls[0].cancelled, { label: "old answer cancelled" });
  assert.ok(frames.some((frame) => frame.type === "turn.superseded" && frame.data.turn_id === first.data.turn_id));
  const screenTurn = frames.filter((frame) => frame.type === "turn.started").at(-1);
  assert.equal(screenTurn.data.intent, "screen");

  // A prospect final while the screen answer streams waits its turn.
  asr.send(1, "and how long would that take", true);
  await sleep(20);
  assert.equal(answerer.calls[1].cancelled, false, "speech never supersedes the screen answer");
  await waitFor(() => doneCount() === 2, { timeout: 5000, label: "screen answer then the queued final" });
  const doneIds = frames.filter((frame) => frame.type === "turn.done").map((frame) => frame.data.turn_id);
  assert.equal(doneIds[0], screenTurn.data.turn_id);
  assert.equal(answerer.calls.length, 3);
  assert.equal(answerer.calls[2].args.question, "and how long would that take");
  assert.equal(answerer.calls[2].args.screen, "context");
  engine.onSessionEnd();
});

test("telemetry records the screen turn like any turn, with its stage timings", async () => {
  const events = [];
  const clock = fakeClock();
  const vision = fakeVision([
    () => {
      clock.advance(1_800); // stage 1
      return reading(QUESTION_ON_SCREEN);
    },
  ]);
  const { engine, doneCount } = setup({ vision, clock, telemetry: { record: (event) => events.push(event) } });
  await engine.onScreenAnalyse({ command_id: "tel-1", image_hash: "ab".repeat(32) });
  await waitFor(() => doneCount() === 1);

  const analysed = events.find((event) => event.type === "screen.analysed");
  assert.deepEqual(
    { ...analysed, sessionId: undefined },
    { type: "screen.analysed", sessionId: undefined, commandId: "tel-1", status: "ok", kind: "question", dedup: false, stub: false, chars: QUESTION_ON_SCREEN.length, visionMs: 1_800 },
  );
  const started = events.find((event) => event.type === "turn.started");
  assert.equal(started.reason, "screen");
  assert.equal(started.committed, true);
  assert.equal(started.intent, "screen");
  assert.deepEqual(started.screen, { analysisId: `an_${QUESTION_ON_SCREEN.length}`, kind: "question", chars: QUESTION_ON_SCREEN.length, dedup: false, stub: false, visionMs: 1_800 });
  const done = events.find((event) => event.type === "turn.done");
  assert.equal(done.turnId, started.turnId);
  assert.equal(done.screen.visionMs, 1_800);
  assert.equal(typeof done.screen.firstDeltaMs, "number");
  assert.equal(typeof done.screen.answerMs, "number");
  // No field name the recorder would redact as credential-shaped.
  assert.equal(/key|token|secret|password|auth/i.test(Object.keys(done.screen).join(" ")), false);
  engine.onSessionEnd();
});

test("offline mock mode: no keys, a deterministic stub reading and a mock answer", async () => {
  const frames = [];
  const make = () =>
    createPipelineEngine({
      emit: (frame) => frames.push(frame),
      log: () => {},
      asr: fakeAsr(),
      answererOptions: { provider: "mock", deltaMinMs: 1, deltaMaxMs: 2 },
    });
  const texts = [];
  for (let run = 0; run < 2; run += 1) {
    frames.length = 0;
    const engine = make();
    engine.onSessionStart({ sessionId: `mock-${run}` });
    const result = await engine.onScreenAnalyse({ command_id: "m1", image_hash: "ab".repeat(32) });
    assert.equal(result.status, "ok");
    assert.equal(result.stub, true);
    assert.match(result.summary, /^Stub screen reading/);
    const done = await waitFor(() => frames.find((frame) => frame.type === "turn.done"), { label: "mock answer" });
    assert.ok(done.data.text.length > 50);
    texts.push([result.summary, done.data.text]);
    engine.onSessionEnd();
  }
  assert.deepEqual(texts[0], texts[1], "the same capture gives the same reading and answer");
});

test("buildContext renders SCREEN after DOCUMENTS and keeps the whole context within budget", () => {
  const screen = { text: "s".repeat(5_000), kind: "code", title: "Editor", ageMs: 42_000 };
  const text = buildContext({ docs: "d".repeat(40_000), history: [{ q: "q", a: "a" }], screen, prospect: ["p".repeat(2_000), "latest"] });
  assert.ok(text.length <= 32_000, `context is ${text.length} chars`);
  const order = ["DOCUMENTS:\n", "SCREEN (captured 42 seconds ago; kind: code; title: Editor):\n", "RECENT EXCHANGE:\n", "PROSPECT SPEECH (latest last):\n"];
  const positions = order.map((marker) => text.indexOf(marker));
  assert.ok(positions.every((at) => at >= 0), "every section renders");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "sections keep their order");
  const screenBlock = text.slice(positions[1], positions[2]).trimEnd();
  assert.ok(screenBlock.length <= 1_500);
  assert.ok(text.trimEnd().endsWith("- latest"), "the latest prospect line survives the cap");
  assert.equal(buildContext({ docs: "D", screen: null, prospect: [] }), "DOCUMENTS:\nD");
  assert.equal(buildContext({ screen: { text: "  ", ageMs: 0 } }), "");
  assert.match(buildContext({ screen: { text: "x", ageMs: 61_000 } }), /^SCREEN \(captured 1 minute ago\):\nx$/);
});
