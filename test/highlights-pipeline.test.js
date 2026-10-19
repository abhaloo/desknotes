import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContext, createPipelineEngine } from "../src/server/engines/pipeline.js";
import { SCRIPT_ANSWER, runScriptedCall } from "./fixtures/rep-context-script.mjs";

/** Frames and prompts captured on 8ec5b18, before rep context and highlights. */
const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(here, "fixtures", "rep-context-baseline.json"), "utf8"));

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

const MARKED = ["- Use **Go Live** to start.", "\n- It keeps **one session at a time**."];

/** Records every streamAnswer argument and streams a marked answer. */
function recordingAnswerer() {
  const calls = [];
  async function* streamAnswer(args) {
    calls.push(args);
    for (const piece of MARKED) {
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
  const asr = fakeAsr();
  const answerer = recordingAnswerer();
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer,
    log: () => {},
    now: () => clock,
    ...engineOptions,
  });
  engine.onSessionStart({ sessionId: "s" });
  const done = () => frames.filter((frame) => frame.type === "turn.done").length;
  return { frames, asr, answerer, done, advance: (ms = 1000) => (clock += ms) };
}

test("on by default: every answer asks for highlights, and the markers reach the client", async () => {
  const { asr, answerer, frames, done } = setup();
  asr.send(1, "How do I start a live session?", true);
  await waitFor(() => done() === 1, "answer");
  assert.equal(answerer.calls[0].highlights, true);
  const final = frames.find((frame) => frame.type === "turn.done");
  assert.equal(final.data.text, MARKED.join(""));
});

test("off: streamAnswer gets no highlights argument at all", async () => {
  const boom = () => {
    throw new Error("settings unreadable");
  };
  for (const highlights of [false, () => false, boom]) {
    const { asr, answerer, done } = setup({ highlights });
    asr.send(1, "How do I start a live session?", true);
    await waitFor(() => done() === 1, "answer");
    assert.equal("highlights" in answerer.calls[0], false, String(highlights));
  }
});

test("a resolver is read for every answer", async () => {
  let on = false;
  const { asr, answerer, done, advance } = setup({ highlights: () => on });
  asr.send(1, "How do I start a live session?", true);
  await waitFor(() => done() === 1, "answer 1");
  on = true;
  advance();
  asr.send(1, "And how do I end the session again?", true);
  await waitFor(() => done() === 2, "answer 2");
  assert.equal("highlights" in answerer.calls[0], false);
  assert.equal(answerer.calls[1].highlights, true);
});

test("history sent back to the model carries no markers", () => {
  const context = buildContext({ history: [{ q: "How do I start?", a: "• Use **Go Live** to start.\n• Only **one session at a time**." }] });
  assert.equal(context, "RECENT EXCHANGE:\nQ: How do I start?\nA: • Use Go Live to start.\n• Only one session at a time.");
});

test("a later answer's RECENT EXCHANGE has the plain answer", async () => {
  const { asr, answerer, done, advance } = setup();
  asr.send(1, "How do I start a live session?", true);
  await waitFor(() => done() === 1, "answer 1");
  advance();
  asr.send(1, "And how do I end the session again?", true);
  await waitFor(() => done() === 2, "answer 2");
  const context = answerer.calls[1].context;
  assert.ok(context.includes("A: - Use Go Live to start.\n- It keeps one session at a time."), context);
  assert.equal(context.includes("**"), false);
});

test("the rep reading a highlighted card is still card reading", async () => {
  const { asr, answerer, done, advance } = setup();
  asr.send(1, "How do I start a live session?", true);
  await waitFor(() => done() === 1, "answer 1");
  advance();
  asr.send(0, "Use Go Live to start, it keeps one session at a time.", true);
  advance();
  asr.send(1, "And how do I end the session again?", true);
  await waitFor(() => done() === 2, "answer 2");
  const context = answerer.calls[1].context;
  assert.equal(context.includes("REP: Use Go Live"), false, context);
});

test("off through the real answerer: a model that still sends markers gives the 8ec5b18 prompts and frames", async () => {
  const marked = SCRIPT_ANSWER.replace("$45 a seat", "**$45 a seat**").replace("50 seats", "**50 seats**");
  assert.notEqual(marked, SCRIPT_ANSWER);
  assert.deepEqual(await runScriptedCall({ repContext: false, highlights: false }, { answer: marked }), BASELINE);
});
