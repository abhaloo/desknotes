import test from "node:test";
import assert from "node:assert/strict";
import { createAnswerer } from "../src/server/engines/answerer.js";
import { buildEngineConfig } from "../src/server/engines/config.js";
import { createSelectableAnswerer } from "../src/server/engines/index.js";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";
import { createVisionEngine } from "../src/server/engines/vision.js";

/**
 * Two rules for the answer a rep reads on a call:
 * - Live mode never shows demo text. With no usable answer model the turn
 *   fails with a reason the overlay can name; mocks are for demo mode only.
 * - A model other than the chosen one may answer (a missing key, a refusal),
 *   and turn.done says which one stood in and why, so the card can carry a
 *   quiet note.
 */
const DEEPSEEK_KEY = "deepseek-key-0123456789";
const CEREBRAS_KEY = "cerebras-key-0123456789";
const CEREBRAS_OPTIONS = Object.freeze({
  provider: "openai-compatible",
  baseUrl: "https://api.cerebras.ai/v1",
  apiKey: CEREBRAS_KEY,
  model: "qwen-3.8-27b",
  reasoningEffort: "high",
});
const NO_MODEL = Object.freeze({ provider: "unconfigured", model: "mock" });

/** Answers every chat request with one SSE delta, or refuses one origin with `status`. */
function chat({ refuseOrigin = null, status = 402 } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (refuseOrigin && String(url).startsWith(refuseOrigin)) {
      return new Response(JSON.stringify({ code: "refused" }), {
        status,
        headers: { "content-type": "application/json", "x-should-retry": "false" },
      });
    }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

/** Streams one answer and returns its text with every onFallback report. */
async function answer(answerer, question = "what is a worker thread") {
  const notes = [];
  let text = "";
  for await (const delta of answerer.streamAnswer({ question, onFallback: (note) => notes.push(note) })) text += delta;
  return { text, notes };
}

/* ------------------------------------------------------------ live mode -- */

test("live mode never configures mock answers; demo mode still may", () => {
  assert.equal(buildEngineConfig({}, { mode: "live" }).answerProvider, "unconfigured");
  assert.equal(buildEngineConfig({ ANSWER_PROVIDER: "mock" }, { mode: "live" }).answerProvider, "unconfigured");
  assert.equal(
    buildEngineConfig({ ANSWER_PROVIDER: "openai-compatible", LLM_API_KEY: "k" }, { mode: "live" }).answerProvider,
    "unconfigured",
    "an endpoint with no URL is no answer model, not a demo",
  );
  assert.equal(buildEngineConfig({ CEREBRAS_API_KEY: CEREBRAS_KEY }, { mode: "live" }).answerProvider, "openai-compatible");
  assert.equal(buildEngineConfig({}, { mode: "demo" }).answerProvider, "mock");
  assert.equal(buildEngineConfig({ ANSWER_PROVIDER: "mock" }, { mode: "demo" }).answerProvider, "mock");
});

test("live mode turns off the vision stub; demo mode keeps it", () => {
  assert.equal(buildEngineConfig({}, { mode: "live" }).visionOptions.allowMockFallback, false);
  assert.equal(buildEngineConfig({}, { mode: "demo" }).visionOptions.allowMockFallback, true);
});

test("an answerer with no model fails with a named, non-retryable reason and no text", async () => {
  for (const options of [
    NO_MODEL,
    { provider: "openai-compatible", model: "m" },
    { provider: "openai-compatible", baseUrl: "http://llm.example.com/v1", apiKey: "k", model: "m" },
    { provider: "llama-local", model: "m" },
  ]) {
    const answerer = createAnswerer(options);
    let text = "";
    const error = await (async () => {
      try {
        for await (const delta of answerer.streamAnswer({ question: "how much is it" })) text += delta;
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    assert.ok(error, `${options.provider}: the answer fails`);
    assert.equal(error.code, "no_answer_model");
    assert.equal(error.retryable, false, "a retry cannot find a model");
    assert.match(error.message, /no answer model/);
    assert.equal(text, "", `${options.provider}: no demo text`);
  }
});

test("an explicit mock answerer still answers (tests and the demo script)", async () => {
  const text = await createAnswerer({ provider: "mock", deltaMinMs: 0, deltaMaxMs: 0 }).answerOnce({ question: "q" });
  assert.ok(text.length > 0);
});

test("live mode: screen analysis with no vision model fails instead of a stub reading", async () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const live = createVisionEngine({ allowMockFallback: false });
    const result = await live.analyse({ bytes: new Uint8Array(64).fill(7) });
    assert.equal(result.status, "failed");
    assert.equal(result.failure, "unconfigured");
    assert.match(result.error, /DEEPSEEK_API_KEY/);
    const demo = createVisionEngine({});
    assert.notEqual((await demo.analyse({ bytes: new Uint8Array(64).fill(7) })).status, "failed", "demo keeps the stub");
  } finally {
    if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
  }
});

/* --------------------------------------------------- missing-key fallback -- */

test("the DeepSeek choice without its key answers on Qwen and reports the stand-in", async () => {
  const fetches = chat();
  try {
    const answerer = createSelectableAnswerer({
      options: CEREBRAS_OPTIONS,
      selectModel: () => "deepseek-flash-thinking",
      deepseekApiKey: null,
      cerebrasAvailable: true,
    });
    const { text, notes } = await answer(answerer);
    assert.match(text, /ok/);
    assert.deepEqual(fetches.calls, ["https://api.cerebras.ai/v1/chat/completions"]);
    assert.deepEqual(notes, [{ to: "Qwen 27B", from: "DeepSeek Flash", reason: "no_key" }]);
  } finally {
    fetches.restore();
  }
});

test("the Qwen choice without a Cerebras key answers on DeepSeek, never on demo text", async () => {
  const fetches = chat();
  try {
    const answerer = createSelectableAnswerer({
      options: NO_MODEL,
      selectModel: () => "cerebras-qwen-thinking",
      deepseekApiKey: DEEPSEEK_KEY,
      cerebrasAvailable: false,
    });
    const { text, notes } = await answer(answerer);
    assert.match(text, /ok/);
    assert.deepEqual(fetches.calls, ["https://api.deepseek.com/chat/completions"]);
    assert.deepEqual(notes, [{ to: "DeepSeek Flash", from: "Qwen 27B", reason: "no_key" }]);
  } finally {
    fetches.restore();
  }
});

test("no key at all: the answer fails as no_answer_model, with no stand-in reported", async () => {
  const answerer = createSelectableAnswerer({
    options: NO_MODEL,
    selectModel: () => "deepseek-flash-thinking",
    deepseekApiKey: null,
    cerebrasAvailable: false,
  });
  const notes = [];
  await assert.rejects(
    async () => {
      for await (const _ of answerer.streamAnswer({ question: "q", onFallback: (note) => notes.push(note) }));
    },
    (error) => error.code === "no_answer_model",
  );
  assert.deepEqual(notes, []);
});

test("the chosen model answering reports nothing", async () => {
  const fetches = chat();
  try {
    for (const [choice, deepseekApiKey] of [["cerebras-qwen-thinking", DEEPSEEK_KEY], ["deepseek-flash", DEEPSEEK_KEY], ["deepseek-flash-thinking", DEEPSEEK_KEY]]) {
      const answerer = createSelectableAnswerer({ options: CEREBRAS_OPTIONS, selectModel: () => choice, deepseekApiKey, cerebrasAvailable: true });
      const { notes } = await answer(answerer);
      assert.deepEqual(notes, [], `${choice}: no note`);
    }
  } finally {
    fetches.restore();
  }
});

/* ------------------------------------------------------ refusal failover -- */

test("a refusal names its reason: 402 out of credit, 401 key, 403 refused, 429 rate limit", async () => {
  for (const [status, reason] of [[402, "out_of_credit"], [401, "key_rejected"], [403, "refused"], [429, "rate_limited"]]) {
    const fetches = chat({ refuseOrigin: "https://api.cerebras.ai", status });
    try {
      const answerer = createSelectableAnswerer({
        options: CEREBRAS_OPTIONS,
        selectModel: () => "cerebras-qwen-thinking",
        deepseekApiKey: DEEPSEEK_KEY,
        cerebrasAvailable: true,
      });
      const { text, notes } = await answer(answerer);
      assert.match(text, /ok/, `${status}: DeepSeek answers`);
      assert.deepEqual(notes, [{ to: "DeepSeek Flash", from: "Qwen 27B", reason }]);
    } finally {
      fetches.restore();
    }
  }
});

test("a refused engine is skipped for a while, so later answers do not pay for the refusal", async () => {
  const fetches = chat({ refuseOrigin: "https://api.cerebras.ai", status: 402 });
  let clock = 1_000_000;
  try {
    const answerer = createSelectableAnswerer({
      options: CEREBRAS_OPTIONS,
      selectModel: () => "cerebras-qwen-thinking",
      deepseekApiKey: DEEPSEEK_KEY,
      cerebrasAvailable: true,
      now: () => clock,
    });
    await answer(answerer);
    assert.equal(fetches.calls.length, 2, "first answer: the refusal, then DeepSeek");
    fetches.calls.length = 0;
    clock += 60_000;
    const second = await answer(answerer);
    assert.deepEqual(fetches.calls, ["https://api.deepseek.com/chat/completions"], "straight to DeepSeek");
    assert.deepEqual(second.notes, [{ to: "DeepSeek Flash", from: "Qwen 27B", reason: "out_of_credit" }], "still a stand-in");
    fetches.calls.length = 0;
    clock += 5 * 60_000;
    await answer(answerer);
    assert.equal(fetches.calls[0], "https://api.cerebras.ai/v1/chat/completions", "after the pause the chosen engine is tried again");
  } finally {
    fetches.restore();
  }
});

test("a rate limit pauses the engine for less time than a billing refusal", async () => {
  const fetches = chat({ refuseOrigin: "https://api.cerebras.ai", status: 429 });
  let clock = 1_000_000;
  try {
    const answerer = createSelectableAnswerer({
      options: CEREBRAS_OPTIONS,
      selectModel: () => "cerebras-qwen-thinking",
      deepseekApiKey: DEEPSEEK_KEY,
      cerebrasAvailable: true,
      now: () => clock,
    });
    await answer(answerer);
    fetches.calls.length = 0;
    clock += 10_000;
    await answer(answerer);
    assert.deepEqual(fetches.calls, ["https://api.deepseek.com/chat/completions"], "still paused at 10 s");
    fetches.calls.length = 0;
    clock += 30_000;
    await answer(answerer);
    assert.equal(fetches.calls[0], "https://api.cerebras.ai/v1/chat/completions", "tried again after 40 s");
  } finally {
    fetches.restore();
  }
});

test("a paused engine is not primed either: the warm-up would meet the same refusal", async () => {
  const fetches = chat({ refuseOrigin: "https://api.cerebras.ai", status: 402 });
  try {
    const answerer = createSelectableAnswerer({
      options: CEREBRAS_OPTIONS,
      selectModel: () => "cerebras-qwen-thinking",
      deepseekApiKey: DEEPSEEK_KEY,
      cerebrasAvailable: true,
    });
    assert.equal(answerer.prime({ context: "before" }), true, "the chosen Cerebras engine primes");
    await answer(answerer);
    assert.equal(answerer.prime({ context: "after" }), false, "paused: no priming request");
  } finally {
    fetches.restore();
  }
});

test("a pause belongs to the refused engine: another Settings choice answers at once, with no note", async () => {
  const fetches = chat({ refuseOrigin: "https://api.cerebras.ai", status: 402 });
  let choice = "cerebras-qwen-thinking";
  try {
    const answerer = createSelectableAnswerer({
      options: CEREBRAS_OPTIONS,
      selectModel: () => choice,
      deepseekApiKey: DEEPSEEK_KEY,
      cerebrasAvailable: true,
    });
    await answer(answerer);
    choice = "deepseek-flash";
    fetches.calls.length = 0;
    const { notes } = await answer(answerer);
    assert.deepEqual(fetches.calls, ["https://api.deepseek.com/chat/completions"]);
    assert.deepEqual(notes, []);
  } finally {
    fetches.restore();
  }
});

/* ------------------------------------------------------------- pipeline -- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > 3000) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

function pipelineWith(streamAnswer) {
  const frames = [];
  const handlers = [];
  const asr = {
    pushAudio() {},
    finalize: () => true,
    close() {},
    onTranscript: (cb) => handlers.push(cb),
  };
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer: { streamAnswer },
    holdSpeculation: false,
  });
  engine.onSessionStart({ sessionId: "s-fallback" });
  const ask = (text) => {
    for (const cb of handlers) cb({ text, final: true, stream: 1, role: "prospect", source: "system" });
  };
  const done = () => frames.filter((frame) => frame.type === "turn.done");
  return { frames, ask, done };
}

test("turn.done carries the stand-in the answerer reported; an answer without one carries none", async () => {
  const note = { to: "DeepSeek Flash", from: "Qwen 27B", reason: "out_of_credit" };
  async function* streamAnswer(args) {
    if (args.question.includes("pricing")) args.onFallback?.(note);
    yield "• VERDICT: direct answer.";
  }
  const { ask, done } = pipelineWith(streamAnswer);
  ask("What does the pricing look like for fifty seats?");
  await waitFor(() => done().length === 1, "first answer");
  assert.deepEqual(done()[0].data.fallback, note);
  ask("And how long does onboarding usually take for a team?");
  await waitFor(() => done().length === 2, "second answer");
  assert.equal("fallback" in done()[1].data, false, "the wire is unchanged when the chosen model answered");
});

test("a retried generation reports only the attempt that answered", async () => {
  let attempt = 0;
  async function* streamAnswer(args) {
    attempt += 1;
    if (attempt === 1) {
      args.onFallback?.({ to: "DeepSeek Flash", from: "Qwen 27B", reason: "rate_limited" });
      throw Object.assign(new Error("answerer: chat endpoint HTTP 503"), { status: 503, retryable: true });
    }
    yield "• VERDICT: second attempt.";
  }
  const { ask, done } = pipelineWith(streamAnswer);
  ask("What does the pricing look like for fifty seats?");
  await waitFor(() => done().length === 1, "answer after retry");
  assert.equal(attempt, 2);
  assert.equal("fallback" in done()[0].data, false);
});
