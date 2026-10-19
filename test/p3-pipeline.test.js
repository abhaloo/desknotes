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

/** Fake ASR whose transcripts the test can inject synchronously. */
function fakeAsr() {
  const handlers = [];
  const pushes = [];
  const finalized = [];
  const api = {
    pushes,
    finalized,
    pushAudio(audio) {
      pushes.push(audio);
    },
    finalize(streamIdx) {
      finalized.push(streamIdx);
      return true;
    },
    close() {
      api.closed = true;
    },
    onTranscript(cb) {
      handlers.push(cb);
    },
    send(streamIdx, text, final, extra = {}) {
      const data = {
        text,
        final,
        stream: streamIdx,
        streamIdx,
        role: streamIdx === 1 ? "prospect" : "rep",
        source: streamIdx === 1 ? "system" : "mic",
        ...extra,
      };
      for (const cb of handlers) cb(data);
    },
  };
  return api;
}

/** Deterministic streamed answerer with observable per-generation state. */
function timedAnswerer({ deltaMs = 8, count = 6, fail = false } = {}) {
  const calls = [];
  async function* streamAnswer(args) {
    const call = { args, deltas: [], cancelled: false, completed: false };
    calls.push(call);
    for (let i = 0; i < count; i += 1) {
      await sleep(deltaMs);
      if (args.signal?.aborted) {
        call.cancelled = true;
        return;
      }
      if (fail) throw new Error("provider exploded");
      const delta = `[g${calls.length}:${i}] `;
      call.deltas.push(delta);
      yield delta;
    }
    call.completed = true;
  }
  return {
    calls,
    streamAnswer,
    answerOnce: async (args) => {
      let text = "";
      for await (const delta of streamAnswer(args)) text += delta;
      return text;
    },
  };
}

function fakeClock(start = 1000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

function deltasFor(frames, answerId) {
  return frames
    .filter((frame) => frame.type === "turn.token" && frame.data.turn_id === answerId)
    .map((frame) => frame.data.delta);
}

test("prefetch: partial trigger starts before the final, converging partials keep the turn, final commits", async () => {
  const frames = [];
  const logs = [];
  const asr = fakeAsr();
  const answerer = timedAnswerer({ deltaMs: 8, count: 6 });
  const clock = fakeClock(1000);
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer,
    log: (entry) => logs.push(entry),
    now: clock.now,
    holdSpeculation: false, // the prefetch is watched on the wire (held turns: p3-pipeline-hold)
  });
  engine.onSessionStart({ sessionId: "s-prefetch" });

  // 6 words and a brand-new last word: below both triggers.
  asr.send(1, "can you tell me about a hard");
  assert.equal(answerer.calls.length, 0, "no speculative generation yet");

  // Same last word for 300 ms -> the stability trigger fires pre-final.
  clock.advance(300);
  asr.send(1, "can you tell me about a hard");
  assert.equal(answerer.calls.length, 1, "prefetch must start before the final");
  const firstId = await waitFor(
    () => frames.find((frame) => frame.type === "turn.token")?.data.turn_id,
    { label: "first prefetch delta" },
  );

  // A newer, CONVERGING partial (prefix extension) keeps the generation:
  // restarting here threw away completed work for zero fidelity gain
  //.
  clock.advance(300);
  asr.send(1, "can you tell me about a hard debugging");
  assert.equal(answerer.calls.length, 1, "a converging partial must NOT restart the prefetch");

  // The final commits the in-flight generation instead of starting a third.
  // It converges on the generated-for text ("...a hard" + 2 words). A final
  // that adds MATERIAL wording to the prefix the stream answers must not be
  // committed (see p3-pipeline-gating.test.js); this test previously used
  // "...hard debugging problem you solved" (+4 words) and so pinned exactly
  // that prefix-answer bug.
  clock.advance(300);
  asr.send(1, "can you tell me about a hard debugging problem", true, { gateSeq: null });
  await sleep(10);
  assert.equal(answerer.calls.length, 1, "matching final continues the same stream");

  const done = await waitFor(() => frames.find((frame) => frame.type === "turn.done"), {
    label: "turn.done",
  });
  assert.ok(answerer.calls[0].completed, "the committed generation runs to the end");
  const committedId = done.data.turn_id;
  const deltas = deltasFor(frames, committedId);
  assert.ok(deltas.length >= 3);
  assert.equal(done.data.text, deltas.join(""), "done text equals the committed deltas");
  assert.ok(
    frames.findLastIndex((frame) => frame.type === "turn.token") < frames.indexOf(done),
    "deltas must arrive before done",
  );
  assert.equal(committedId, firstId, "a converging partial keeps the same turn id");
  assert.ok(
    !frames.some((frame) => frame.type === "turn.done" && frame.data.turn_id !== committedId),
    "exactly one turn completes",
  );
  assert.ok(logs.some((entry) => entry.type === "turn.commit"));
  engine.dispose();
});

test("a final that diverges from the prefetch restarts a committed generation", async () => {
  const frames = [];
  const asr = fakeAsr();
  const answerer = timedAnswerer({ deltaMs: 2, count: 3 });
  const clock = fakeClock(0);
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer,
    log: () => {},
    now: clock.now,
  });
  engine.onSessionStart({ sessionId: "s-diverge" });

  asr.send(1, "can you tell me about a hard debugging");
  clock.advance(300);
  asr.send(1, "can you tell me about a hard debugging"); // stability trigger
  assert.equal(answerer.calls.length, 1);

  clock.advance(300);
  asr.send(1, "where do you see yourself in five years", true);
  assert.equal(answerer.calls.length, 2, "diverging final starts a fresh committed turn");
  await waitFor(() => answerer.calls[0].cancelled, { label: "prefetch cancellation" });

  const done = await waitFor(() => frames.find((frame) => frame.type === "turn.done"));
  assert.equal(done.data.text, deltasFor(frames, done.data.turn_id).join(""));
  assert.equal(answerer.calls[1].args.question, "where do you see yourself in five years");
  engine.dispose();
});

test("answer_request is ignored during a live turn and triggers when idle, echoing gate_seq", async () => {
  const frames = [];
  const logs = [];
  const asr = fakeAsr();
  const answerer = timedAnswerer({ deltaMs: 30, count: 4 });
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer,
    log: (entry) => logs.push(entry),
    now: Date.now,
  });
  engine.onSessionStart({ sessionId: "s-request" });

  asr.send(1, "describe a project where you improved reliability", true);
  await waitFor(() => answerer.calls.length === 1, { label: "first committed generation" });

  assert.equal(
    engine.onAnswerRequest({ utterance: "what is your notice period", intent: "manual", gateSeq: 42 }),
    false,
  );
  assert.equal(answerer.calls.length, 1, "a live turn must never be superseded");
  assert.ok(logs.some((entry) => entry.type === "answer_request.ignored"));

  const firstDone = await waitFor(() => frames.find((frame) => frame.type === "turn.done"), {
    label: "first answer.done",
  });
  assert.equal(firstDone.data.gate_seq, undefined, "ASR finals carry no gate_seq");

  assert.equal(
    engine.onAnswerRequest({ utterance: "what is your notice period", intent: "manual", gateSeq: 42 }),
    true,
  );
  const secondDone = await waitFor(
    () => frames.filter((frame) => frame.type === "turn.done")[1],
    { label: "manual answer.done" },
  );
  assert.equal(secondDone.data.gate_seq, 42, "gate_seq is echoed into done");
  assert.equal(secondDone.data.text, deltasFor(frames, secondDone.data.turn_id).join(""));
  assert.equal(answerer.calls.length, 2);
  assert.equal(answerer.calls[1].args.intent, "manual");
  engine.dispose();
});

test("session context (resume/playbook/docs) reaches streamAnswer", async () => {
  const frames = [];
  const calls = [];
  const answerer = {
    async *streamAnswer(args) {
      calls.push(args);
      yield "ok";
    },
    async answerOnce() {
      return "ok";
    },
  };
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr: fakeAsr(),
    answerer,
    log: () => {},
    now: Date.now,
  });
  engine.onSessionStart({
    sessionId: "s-context",
    resume: "RESUME_MARKER backend engineer",
    playbook: "PLAYBOOK_MARKER ask about measurable impact",
    docs: "DOC_MARKER notes on distributed systems",
  });

  engine.onAnswerRequest({ utterance: "what should I emphasize", intent: "manual", gateSeq: 7 });
  await waitFor(() => calls.length === 1, { label: "context-answering call" });
  assert.equal(calls[0].question, "what should I emphasize");
  assert.equal(calls[0].intent, "manual");
  assert.match(calls[0].context, /RESUME_MARKER/);
  assert.match(calls[0].context, /PLAYBOOK_MARKER/);
  assert.match(calls[0].context, /DOC_MARKER/);
  await waitFor(() => frames.some((frame) => frame.type === "turn.done"));
  engine.dispose();
});

test("context passed as session.context reaches streamAnswer too", async () => {
  const calls = [];
  const answerer = {
    async *streamAnswer(args) {
      calls.push(args);
      yield "ok";
    },
    async answerOnce() {
      return "ok";
    },
  };
  const engine = createPipelineEngine({
    emit: () => {},
    asr: fakeAsr(),
    answerer,
    log: () => {},
    now: Date.now,
  });
  engine.onSessionStart({
    sessionId: "s-context-2",
    context: { resume: "CTX_RESUME", playbook: "CTX_PLAYBOOK", documents: "CTX_DOCS" },
  });
  engine.onAnswerRequest({ utterance: "q" });
  await waitFor(() => calls.length === 1);
  assert.match(calls[0].context, /CTX_RESUME/);
  assert.match(calls[0].context, /CTX_PLAYBOOK/);
  assert.match(calls[0].context, /CTX_DOCS/);
  engine.dispose();
});

test("onAudio and onFinalize route to the ASR with normalized field names", () => {
  const asr = fakeAsr();
  const engine = createPipelineEngine({
    emit: () => {},
    asr,
    answerer: timedAnswerer(),
    log: () => {},
  });
  const pcm = new Int16Array([1, 2, 3, 4]);
  engine.onAudio({ streamIdx: 1, seq: 9, source: "system", pcm16: pcm, timestampMs: 1234 });
  engine.onFinalize({ streamIdx: 1 });
  assert.equal(asr.pushes.length, 1);
  assert.deepEqual(asr.pushes[0], {
    streamIdx: 1,
    seq: 9,
    source: "system",
    pcm16: pcm,
    ts: 1234,
  });
  assert.deepEqual(asr.finalized, [1]);
  engine.dispose();
  assert.equal(asr.closed, true);
});

test("pipeline taps transcripts from an injected ASR that only exposes an emit sink", async () => {
  const frames = [];
  const asr = { pushAudio() {}, finalize() {}, close() {}, emit() {} };
  const answerer = timedAnswerer({ deltaMs: 1, count: 2 });
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer,
    log: () => {},
    now: Date.now,
  });
  engine.onSessionStart({ sessionId: "s-tap" });
  asr.emit({
    v: 1,
    type: "transcript",
    data: {
      text: "walk me through your most complex system design",
      final: true,
      role: "prospect",
      source: "system",
      stream: 1,
      seq: 0,
    },
  });
  await waitFor(() => frames.some((frame) => frame.type === "turn.done"));
  assert.equal(answerer.calls.length, 1);
  engine.dispose();
});

test("a prefetch that finished before the final commits without regenerating", async () => {
  const frames = [];
  const asr = fakeAsr();
  const answerer = timedAnswerer({ deltaMs: 1, count: 3 });
  const clock = fakeClock(0);
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer,
    log: () => {},
    now: clock.now,
  });
  engine.onSessionStart({ sessionId: "s-finished" });

  asr.send(1, "can you tell me about a hard debugging");
  clock.advance(300);
  asr.send(1, "can you tell me about a hard debugging"); // stability trigger
  await waitFor(() => answerer.calls[0].completed, { label: "prefetch completion" });

  asr.send(1, "can you tell me about a hard debugging problem", true);
  const done = await waitFor(() => frames.find((frame) => frame.type === "turn.done"), {
    timeout: 300,
    label: "instant answer.done",
  });
  assert.equal(answerer.calls.length, 1, "a finished prefetch is reused, not regenerated");
  assert.equal(done.data.text, deltasFor(frames, done.data.turn_id).join(""));
  engine.dispose();
});

test("mock-scripted ASR drives prefetch through the pipeline", async () => {
  const frames = [];
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    log: () => {},
    asrOptions: {
      provider: "mock-scripted",
      script: {
        1: [
          "Can you walk me through the hardest outage you ever debugged end to end",
          "What did you learn from it",
        ],
      },
    },
    answererOptions: { provider: "mock", deltaMinMs: 1, deltaMaxMs: 2 },
  });
  engine.onSessionStart({ sessionId: "s-script" });

  const chunk = new Int16Array(4800); // 300 ms
  for (let i = 0; i < chunk.length; i += 1) chunk[i] = Math.round(9000 * Math.sin(i / 7));
  for (let i = 0; i < 10; i += 1) {
    engine.onAudio({ streamIdx: 1, seq: i + 1, pcm16: chunk, timestampMs: i * 300 });
  }
  await waitFor(() => frames.some((frame) => frame.type === "turn.token"), {
    label: "scripted prefetch deltas",
  });
  assert.ok(frames.filter((frame) => frame.type === "transcript" && !frame.data.final).length >= 8);

  engine.onFinalize({ streamIdx: 1 });
  const done = await waitFor(() => frames.find((frame) => frame.type === "turn.done"), {
    timeout: 5000,
    label: "scripted answer.done",
  });
  assert.equal(done.data.text, deltasFor(frames, done.data.turn_id).join(""));
  engine.dispose();
});

test("engine contract smoke: audio -> prefetch -> commit, say, vision delegation, session end", async () => {
  const frames = [];
  const logs = [];
  const visionCalls = [];
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    log: (entry) => logs.push(entry),
    vision: {
      async analyse(request, ctx) {
        visionCalls.push({ request, ctx });
        return { status: "ok", kind: "question", dedup: false, solve: "stub answer" };
      },
    },
    asrOptions: { provider: "mock" },
    answererOptions: { provider: "mock", deltaMinMs: 1, deltaMaxMs: 2 },
  });
  engine.onSessionStart({ sessionId: "s-smoke" });

  const chunk = new Int16Array(3200); // 200 ms @ 16 kHz
  for (let i = 0; i < chunk.length; i += 1) chunk[i] = Math.round(9000 * Math.sin(i / 9));
  const wire = new Uint8Array(chunk.buffer);
  for (let i = 0; i < 17; i += 1) {
    engine.onAudio({ streamIdx: 1, seq: i + 1, source: "system", pcm16: wire, timestampMs: i * 200 });
  }

  const interims = frames.filter((frame) => frame.type === "transcript" && frame.data.final === false);
  assert.ok(interims.length >= 4, `expected interims, got ${interims.length}`);
  assert.ok(interims.every((frame) => frame.data.role === "prospect"));
  await waitFor(() => logs.some((entry) => entry.type === "turn.start" && entry.committed === false), {
    label: "speculative prefetch start",
  });

  engine.onFinalize({ streamIdx: 1 });
  const finalFrame = await waitFor(
    () => frames.find((frame) => frame.type === "transcript" && frame.data.final === true),
    { label: "final transcript" },
  );
  assert.equal(finalFrame.data.role, "prospect");
  assert.equal(finalFrame.data.source, "system");
  assert.equal(finalFrame.data.stream, 1);
  assert.ok(frames.some((frame) => frame.type === "say"), "prospect speech echoes into say");

  const done = await waitFor(() => frames.find((frame) => frame.type === "turn.done"), {
    timeout: 5000,
    label: "turn.done",
  });
  assert.ok(done.data.text.length > 50);
  const committed = deltasFor(frames, done.data.turn_id);
  assert.ok(committed.length >= 3);
  assert.equal(done.data.text, committed.join(""), "committed deltas form the done text");

  const result = await engine.onScreenAnalyse({
    command_id: "cmd-1",
    image_hash: "ab".repeat(32),
    purpose: "question",
  });
  assert.equal(result.status, "ok");
  assert.equal(visionCalls.length, 1);
  assert.equal(visionCalls[0].request.command_id, "cmd-1");
  assert.equal(visionCalls[0].ctx.sessionId, "s-smoke");
  assert.ok(
    !frames.some((frame) => frame.type === "screen.result"),
    "the transport server emits screen.result from the returned result; the pipeline must not duplicate it",
  );

  engine.onSessionEnd();
  engine.dispose(); // idempotent
  assert.ok(logs.some((entry) => entry.type === "pipeline.session_end"));
});

test("a broken vision engine degrades to a typed failure instead of throwing", async () => {
  const frames = [];
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr: fakeAsr(),
    answerer: timedAnswerer(),
    vision: async () => {
      throw new Error("vision factory unavailable");
    },
    log: () => {},
    now: Date.now,
  });
  // Force the stub by giving ensureVision a failing factory path through a
  // direct call: the delegate catch still returns a typed failure.
  const result = await engine.onScreenAnalyse({ command_id: "cmd-2", image_hash: "cd".repeat(32) });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.kind, "unavailable");
  engine.dispose();
});

test("latency bounds: trigger->first token and finished-prefetch commit stay fast (real clock)", async () => {
  // Early measurements showed 59-62 ms and 0.1 ms — but nothing BOUNDED them,
  // NOTHING bounded them: a regression to
  // "answers arrive seconds later" would have passed every test. Bounds are
  // generous for slow CI yet far tighter than the default 3 s waitFor.
  const frames = [];
  const logs = [];
  const asr = fakeAsr();
  const answerer = timedAnswerer({ deltaMs: 15, count: 5 }); // ~75 ms stream
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer,
    log: (entry) => logs.push(entry),
    holdSpeculation: false, // trigger -> first token is measured on the wire
  });
  engine.onSessionStart({ sessionId: "s-latency" });

  // 9-word partial: the >= 8-word trigger fires on arrival (no fake clock).
  const t0 = Date.now();
  asr.send(1, "can you walk me through the hardest outage you ever debugged", false);
  await waitFor(() => frames.find((frame) => frame.type === "turn.token"), { label: "first token" });
  const lead = Date.now() - t0;
  assert.ok(lead < 300, `trigger -> first token must stay sub-300ms (took ${lead}ms)`);

  // Let the generation finish, then commit with the final transcript: a
  // finished prefetch must commit without regenerating, well under 100 ms.
  await waitFor(() => frames.find((frame) => frame.type === "turn.done"), { label: "stream end" });
  const t1 = Date.now();
  asr.send(1, "can you walk me through the hardest outage you ever debugged", true);
  await waitFor(() => logs.some((entry) => entry.type === "turn.commit"), { label: "commit" });
  const commit = Date.now() - t1;
  assert.ok(commit < 100, `finished prefetch commit must be instant (took ${commit}ms)`);
  assert.equal(answerer.calls.length, 1, "committing a finished prefetch never regenerates");
  engine.dispose();
});
