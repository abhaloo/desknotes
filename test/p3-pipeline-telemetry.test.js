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

/**
 * Fake recorder: the pipeline's whole contract is `{ record(event), close?() }`.
 * `throwOnRecord` proves the pipeline wraps every call (telemetry must never
 * break a turn even when a bad recorder is injected).
 */
function fakeRecorder({ throwOnRecord = false } = {}) {
  const events = [];
  const recorder = {
    events,
    closeCount: 0,
    record(event) {
      events.push(event);
      if (throwOnRecord) throw new Error("recorder exploded");
    },
    close() {
      recorder.closeCount += 1;
    },
  };
  return recorder;
}

/** Scripted ASR whose transcripts the test injects synchronously. */
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
    send(streamIdx, text, final = false, extra = {}) {
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
}

/** Echoes its question with a predictable shape so `chars` and text are assertable. */
function fakeAnswerer({ deltaMs = 4, count = 3 } = {}) {
  async function* streamAnswer(args) {
    for (let i = 0; i < count; i += 1) {
      await sleep(deltaMs);
      if (args.signal?.aborted) return;
      yield i === 0 ? `ANSWER TO: ${args.question}` : " .";
    }
  }
  return { streamAnswer };
}

/** Minimal judge double: only the verdicts the pipeline consumes. */
function fakeJudge({ isQuestion = () => 0.95, answersSame = () => 0.95, delayMs = 5, features = { gate: true, rescue: false } } = {}) {
  const judge = {
    enabled: true,
    features,
    calls: [],
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
    close() {},
  };
  return judge;
}

function makeEngine({ telemetry, answerer, judge } = {}) {
  const frames = [];
  const asr = fakeAsr();
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer: fakeAnswerer(answerer),
    log: () => {},
    telemetry,
    judge,
  });
  return { frames, asr, engine };
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const QUESTION = "how much does the enterprise tier cost per seat";
const OTHER = "what does the onboarding timeline look like for a new team";
const TIER = "how much is the pro tier per seat for a team of forty";
const PLAN = "how much is the pro plan per seat for a team of forty";

test("interim hypotheses are recorded verbatim, in arrival order, repeats included", async () => {
  const recorder = fakeRecorder();
  const { asr, engine } = makeEngine({ telemetry: recorder });
  engine.onSessionStart({ sessionId: "s-telemetry" });

  const first = "how much does the enterprise tier cost";
  const grown = "how much does the enterprise tier cost per seat";
  const revised = "how much does the enterprise tier cost";
  asr.send(1, first);
  asr.send(1, first); // the ASR re-emits the identical interim
  asr.send(1, grown); // the interim grows
  asr.send(1, revised); // the ASR revises backwards
  asr.send(1, grown, true); // final closed the segment

  const partials = ofType(recorder.events, "asr.partial");
  assert.deepEqual(
    partials.map((e) => e.text),
    [first, first, grown, revised],
    "every interim, including the verbatim repeat, appears in arrival order",
  );
  assert.ok(partials.every((e) => e.stream === 1));
  assert.ok(partials.every((e) => e.sessionId === "s-telemetry"));

  const final = ofType(recorder.events, "asr.final")[0];
  assert.equal(final.text, grown);
  assert.equal(final.stream, 1);
  assert.equal(final.committed, true);
  assert.equal(final.sessionId, "s-telemetry");

  assert.equal(ofType(recorder.events, "session.start")[0].sessionId, "s-telemetry");
  engine.onSessionEnd();
  assert.equal(ofType(recorder.events, "session.end").length, 1);
  assert.equal(recorder.closeCount, 1);
});

test("every frame handed to the transport is recorded as a wire.frame with its payload text", async () => {
  const recorder = fakeRecorder();
  const { frames, asr, engine } = makeEngine({ telemetry: recorder });
  engine.onSessionStart({ sessionId: "s-wire" });
  asr.send(1, QUESTION, true);

  const done = await waitFor(() => frames.find((f) => f.type === "turn.done"), { label: "turn.done frame" });
  const wire = ofType(recorder.events, "wire.frame");
  assert.equal(wire.length, frames.length, "one wire.frame per emitted frame");
  assert.deepEqual(
    wire.map((e) => e.frame),
    frames.map((f) => ({ type: f.type, ...f.data })),
    "each recorded frame is the emitted payload flattened under its type",
  );
  assert.deepEqual(
    wire.map((e) => e.seq),
    frames.map((_, i) => i + 1),
    "seq is a monotonic pipeline counter when the transport carries none",
  );
  assert.ok(wire.every((e) => e.sessionId === "s-wire"));

  const started = wire.find((e) => e.frame.type === "turn.started");
  assert.equal(started.frame.question, QUESTION);
  const tokenText = wire
    .filter((e) => e.frame.type === "turn.token")
    .map((e) => e.frame.delta)
    .join("");
  assert.equal(tokenText, `ANSWER TO: ${QUESTION} . .`);
  const doneFrame = wire.find((e) => e.frame.type === "turn.done");
  assert.equal(doneFrame.frame.text, `ANSWER TO: ${QUESTION} . .`);
  assert.equal(doneFrame.frame.text, done.data.text);
  engine.onSessionEnd();
});

test("turn.started/turn.done/turn.superseded carry the reason and committed flag of the turn they describe", async () => {
  const recorder = fakeRecorder();
  const { asr, engine } = makeEngine({ telemetry: recorder, answerer: { deltaMs: 40, count: 10 } });
  engine.onSessionStart({ sessionId: "s-turns" });

  asr.send(1, TIER); // >= 8 words: opens an uncommitted prefetch
  const prefetch = await waitFor(() => ofType(recorder.events, "turn.started")[0], { label: "prefetch turn" });
  assert.equal(prefetch.reason, "partial_trigger");
  assert.equal(prefetch.committed, false);
  assert.equal(prefetch.intent, "prefetch");
  assert.equal(prefetch.chars, TIER.length);

  asr.send(1, PLAN); // materially different question supersedes the prefetch
  const superseded = await waitFor(
    () => ofType(recorder.events, "turn.superseded").find((e) => e.turnId === prefetch.turnId),
    { label: "prefetch superseded" },
  );
  assert.equal(superseded.reason, "partial_diverge");
  assert.equal(superseded.sessionId, "s-turns");

  asr.send(1, OTHER, true); // final for a different question restarts a committed turn
  const committed = await waitFor(
    () => ofType(recorder.events, "turn.started").find((e) => e.turnId !== prefetch.turnId && e.committed),
    { label: "committed turn" },
  );
  assert.equal(committed.reason, "final_restart");
  assert.equal(committed.intent, "final");
  assert.equal(committed.chars, OTHER.length);

  const done = await waitFor(
    () => ofType(recorder.events, "turn.done").find((e) => e.turnId === committed.turnId),
    { label: "committed turn done" },
  );
  assert.equal(done.chars, (`ANSWER TO: ${OTHER}` + " .".repeat(9)).length);
  engine.onSessionEnd();
});

test("without a telemetry option the wire output is exactly the previous behaviour", async () => {
  async function run({ withRecorder }) {
    const recorder = fakeRecorder();
    const frames = [];
    const asr = fakeAsr();
    const engine = createPipelineEngine({
      emit: (frame) => frames.push(frame),
      asr,
      answerer: fakeAnswerer({ deltaMs: 5, count: 3 }),
      log: () => {},
      telemetry: withRecorder ? recorder : undefined,
    });
    engine.onSessionStart({ sessionId: "s-plain" });
    asr.send(1, QUESTION);
    asr.send(1, QUESTION, true);
    await waitFor(() => frames.some((f) => f.type === "turn.done"), { label: "turn.done" });
    engine.onSessionEnd();
    return { frames, recorder };
  }

  const plain = await run({ withRecorder: false });
  const wired = await run({ withRecorder: true });
  assert.deepEqual(wired.frames, plain.frames, "telemetry is additive: the wire stream is unchanged");
  assert.equal(plain.recorder.events.length, 0, "no recorder, no events");
  assert.ok(wired.recorder.events.length > 0, "the injected recorder saw the same turns");
});

test("a recorder that throws never breaks a turn, and close runs exactly once at session end", async () => {
  const recorder = fakeRecorder({ throwOnRecord: true });
  const { frames, asr, engine } = makeEngine({ telemetry: recorder });
  engine.onSessionStart({ sessionId: "s-throw" });
  asr.send(1, QUESTION, true);

  const done = await waitFor(() => frames.find((f) => f.type === "turn.done"), {
    label: "turn.done despite a throwing record",
  });
  assert.equal(done.data.text, `ANSWER TO: ${QUESTION} . .`);
  assert.ok(ofType(recorder.events, "turn.started").length > 0, "record was attempted");

  engine.onSessionEnd();
  assert.equal(recorder.closeCount, 1);
  assert.equal(recorder.events[recorder.events.length - 1].type, "session.end", "session.end is the last event");
  engine.onSessionEnd();
  engine.dispose();
  assert.equal(recorder.closeCount, 1, "close is called exactly once");
});

test("the gate verdict is recorded where the gate consumes it", async () => {
  const recorder = fakeRecorder();
  const judge = fakeJudge();
  const { asr, engine } = makeEngine({ telemetry: recorder, judge });
  engine.onSessionStart({ sessionId: "s-gate" });
  asr.send(1, QUESTION, true);

  const verdict = await waitFor(() => ofType(recorder.events, "gate.verdict")[0], { label: "gate verdict" });
  const started = ofType(recorder.events, "turn.started")[0];
  assert.equal(verdict.turnId, started.turnId);
  assert.equal(verdict.isQuestion, 0.95);
  assert.equal(verdict.latencyMs, 5);
  assert.ok(!("answersSame" in verdict), "answersSame is omitted when the judge returned null");
  assert.equal(verdict.sessionId, "s-gate");
  engine.onSessionEnd();
});

test("a rescue verdict is recorded with answersSame against the reworded turn", async () => {
  const recorder = fakeRecorder();
  const judge = fakeJudge({ features: { gate: false, rescue: true } });
  const { asr, engine } = makeEngine({ telemetry: recorder, judge, answerer: { deltaMs: 5, count: 3 } });
  engine.onSessionStart({ sessionId: "s-rescue" });

  asr.send(1, TIER);
  const prefetch = await waitFor(() => ofType(recorder.events, "turn.started")[0], { label: "prefetch turn" });
  await waitFor(
    () => ofType(recorder.events, "turn.done").some((e) => e.turnId === prefetch.turnId),
    { label: "prefetch finished" },
  );

  asr.send(1, PLAN, true);
  const verdict = await waitFor(
    () => ofType(recorder.events, "gate.verdict").find((e) => "answersSame" in e),
    { label: "rescue verdict" },
  );
  assert.equal(verdict.isQuestion, 0.95);
  assert.equal(verdict.answersSame, 0.95);
  const fresh = ofType(recorder.events, "turn.started").find((e) => e.turnId === verdict.turnId);
  assert.ok(fresh, "the verdict is attributed to the reworded turn it was asked about");
  assert.equal(fresh.reason, "final_restart");
  assert.equal(fresh.committed, true);
  engine.onSessionEnd();
});
