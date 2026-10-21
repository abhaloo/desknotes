import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label) {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > 3000) throw new Error(`timed out waiting for ${label}`);
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

function recordingAnswerer() {
  const calls = [];
  async function* streamAnswer(args) {
    calls.push(args);
    for (const piece of ["• VERDICT: direct answer.\n", "• HOW: parts."]) {
      await sleep(1);
      if (args.signal?.aborted) return;
      yield piece;
    }
  }
  return { calls, streamAnswer };
}

function setup(engineOptions = {}) {
  let clock = 50_000;
  const frames = [];
  const logs = [];
  const asr = fakeAsr();
  const answerer = recordingAnswerer();
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer,
    log: (entry) => logs.push(entry),
    now: () => clock,
    ...engineOptions,
  });
  engine.onSessionStart({ sessionId: "s" });
  const done = () => frames.filter((frame) => frame.type === "turn.done").length;
  return { engine, frames, logs, asr, answerer, done, advance: (ms = 1000) => (clock += ms) };
}

test("answerCards on by default: cards: true reaches the answerer", async () => {
  const { asr, answerer, done } = setup();
  asr.send(1, "How do I start a live session?", true);
  await waitFor(() => done() === 1, "answer");
  assert.equal(answerer.calls[0].cards, true);
});

test("answerCards off: no cards key reaches the answerer", async () => {
  const boom = () => {
    throw new Error("settings unreadable");
  };
  for (const answerCards of [false, () => false, boom]) {
    const { asr, answerer, done } = setup({ answerCards, highlights: false });
    asr.send(1, "How do I start a live session?", true);
    await waitFor(() => done() === 1, "answer");
    assert.equal("cards" in answerer.calls[0], false, String(answerCards));
    assert.deepEqual(
      Object.keys(answerer.calls[0]).sort(),
      ["context", "intent", "onCut", "onFallback", "question", "signal"].sort(),
    );
  }
});

test("a resolver is read once per generation", async () => {
  let on = false;
  let reads = 0;
  const resolver = () => {
    reads += 1;
    return on;
  };
  const { asr, answerer, done, advance } = setup({ answerCards: resolver });
  asr.send(1, "How do I start a live session?", true);
  await waitFor(() => done() === 1, "answer 1");
  assert.equal("cards" in answerer.calls[0], false);
  assert.equal(reads, 1, "read once for generation 1");

  on = true;
  advance();
  asr.send(1, "And how do I end the session again?", true);
  await waitFor(() => done() === 2, "answer 2");
  assert.equal(answerer.calls[1].cards, true);
  assert.equal(reads, 2, "read once for generation 2");
});

test("a noise final starts no turn and logs turn.final_noise", async () => {
  const { asr, frames, logs } = setup();
  for (const noise of ["you", "Music", "."]) {
    asr.send(1, noise, true);
  }
  await sleep(20);
  assert.equal(frames.filter((frame) => frame.type === "turn.started").length, 0);
  const noiseLogs = logs.filter((entry) => entry.type === "turn.final_noise");
  assert.equal(noiseLogs.length, 3);
  assert.deepEqual(noiseLogs.map((l) => l.chars), [3, 5, 1]);
});

test("a one-word question with ? is answered", async () => {
  const { asr, answerer, done } = setup();
  asr.send(1, "Why?", true);
  await waitFor(() => done() === 1, "answer");
  assert.equal(answerer.calls.length, 1);
  assert.equal(answerer.calls[0].question, "Why?");
});

test("a noise pause hint starts no prefetch", async () => {
  const { engine, asr, answerer, frames } = setup();
  asr.send(1, "you", false);
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  await sleep(20);
  assert.equal(answerer.calls.length, 0, "noise pause hint started no prefetch");
  assert.equal(frames.filter((f) => f.type === "turn.started").length, 0);

  asr.send(1, "How do you scale it", false);
  engine.onTurnHint({ streamIdx: 1, state: "pause" });
  await waitFor(() => answerer.calls.length === 1, "prefetch started");
  assert.equal(answerer.calls[0].question, "How do you scale it");
});

test("an answer the answerer cut short carries cut on turn.done; a whole answer carries none", async () => {
  async function* streamAnswer(args) {
    yield "• VERDICT: direct answer.\n";
    await sleep(1);
    yield "• TRADE-OFF: cost.";
    if (args.question.includes("long")) args.onCut?.("lines");
  }
  const { asr, frames, done } = setup({ answerer: { streamAnswer } });
  asr.send(1, "Tell me the long version of how this works?", true);
  await waitFor(() => done() === 1, "first answer");
  const first = frames.filter((frame) => frame.type === "turn.done")[0];
  assert.equal(first.data.cut, "lines");
  asr.send(1, "And how much does the enterprise plan cost per seat?", true);
  await waitFor(() => done() === 2, "second answer");
  const second = frames.filter((frame) => frame.type === "turn.done")[1];
  assert.equal("cut" in second.data, false);
});
