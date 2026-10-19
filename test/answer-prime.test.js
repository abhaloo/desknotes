import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnswerer } from "../src/server/engines/answerer.js";
import { createSelectableAnswerer } from "../src/server/engines/index.js";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";

/**
 * Cerebras prompt-cache priming: one max_tokens 1 request whose system message
 * is the one the next default-card answer sends. Nothing waits for it.
 */
const CEREBRAS = {
  provider: "openai-compatible",
  baseUrl: "https://api.cerebras.ai/v1",
  apiKey: "ck",
  model: "qwen-3.8-27b",
  reasoningEffort: "high",
};
const ANSWER_SSE = `data: ${JSON.stringify({ choices: [{ delta: { content: "- VERDICT: use a queue.\n- HOW: a queue absorbs bursts." } }] })}\n\ndata: [DONE]\n\n`;

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

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/**
 * Replaces globalThis.fetch for one test. A request with max_tokens 1 is a
 * priming request and gets `primeReply(init)`; any other request streams the
 * answer. Every call is recorded as { url, body, at }. The caller restores.
 */
function fakeFetch({ primeReply = () => jsonResponse({ choices: [{ message: { content: "" } }] }) } = {}) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, at: Date.now() });
    if (body.max_tokens === 1) return primeReply(init);
    return new Response(ANSWER_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return {
    calls,
    primes: () => calls.filter((call) => call.body.max_tokens === 1),
    answers: () => calls.filter((call) => call.body.max_tokens !== 1),
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

function fakeAsr() {
  return {
    pushAudio() {},
    finalize() {
      return true;
    },
    close() {},
    onTranscript() {},
  };
}

test("prime sends one max_tokens 1 request with the first answer's exact system message", async () => {
  const fake = fakeFetch();
  try {
    const answerer = createAnswerer(CEREBRAS);
    const context = "DOCUMENTS:\nThe doc.";
    assert.equal(answerer.prime({ context, highlights: true, cards: true }), true);
    await waitFor(() => fake.primes().length === 1, { label: "prime request" });
    const [prime] = fake.primes();
    assert.equal(prime.url, "https://api.cerebras.ai/v1/chat/completions");
    assert.equal(prime.body.max_tokens, 1);
    assert.equal(prime.body.stream, false);
    assert.equal(prime.body.model, "qwen-3.8-27b");
    assert.equal(prime.body.reasoning_effort, "high");
    assert.match(prime.body.messages[0].content, /DOCUMENTS:\nThe doc\./);

    await answerer.answerOnce({ question: "How would you scale it?", context, highlights: true, cards: true });
    const [answer] = fake.answers();
    assert.equal(answer.body.stream, true);
    assert.equal(answer.body.messages[0].content, prime.body.messages[0].content);
    assert.equal(answer.body.model, prime.body.model);
    assert.equal(answer.body.temperature, prime.body.temperature);
    assert.equal(answer.body.reasoning_effort, prime.body.reasoning_effort);
  } finally {
    fake.restore();
  }
});

test("prime and the first answer share the system message of a file-based prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "answer-prime-"));
  const fake = fakeFetch();
  try {
    const file = join(dir, "answer-instructions.txt");
    await writeFile(file, "Role:\nYou are Pat, a calm account executive.\n");
    const answerer = createAnswerer({ ...CEREBRAS, answerInstructionsPath: file });
    const context = "DOCUMENTS:\nThe doc.";
    assert.equal(answerer.prime({ context, highlights: true, cards: true }), true);
    await waitFor(() => fake.primes().length === 1, { label: "prime request" });
    await answerer.answerOnce({ question: "How would you scale it?", context, highlights: true, cards: true });
    const [prime] = fake.primes();
    const [answer] = fake.answers();
    assert.match(prime.body.messages[0].content, /calm account executive/);
    assert.match(answer.body.messages[0].content, /calm account executive/);
    assert.equal(answer.body.messages[0].content, prime.body.messages[0].content);
  } finally {
    fake.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the same arguments are primed once; a new document primes again", async () => {
  const fake = fakeFetch();
  try {
    const answerer = createAnswerer(CEREBRAS);
    assert.equal(answerer.prime({ context: "DOCUMENTS:\nA." }), true);
    assert.equal(answerer.prime({ context: "DOCUMENTS:\nA." }), false);
    await waitFor(() => fake.primes().length === 1, { label: "first prime" });
    await sleep(20);
    assert.equal(fake.primes().length, 1, "the repeated call sent nothing");

    assert.equal(answerer.prime({ context: "DOCUMENTS:\nB." }), true);
    await waitFor(() => fake.primes().length === 2, { label: "second prime" });
  } finally {
    fake.restore();
  }
});

test("never for DeepSeek or another origin", async () => {
  const fake = fakeFetch();
  try {
    const others = [
      { provider: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey: "dk", model: "deepseek-flash" },
      { provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "lk", model: "m" },
      { provider: "mock" },
    ];
    for (const options of others) {
      assert.equal(createAnswerer(options).prime({ context: "DOCUMENTS:\nThe doc.", highlights: true, cards: true }), false, JSON.stringify(options));
    }
    await sleep(20);
    assert.equal(fake.calls.length, 0, "no request reached any other origin");

    // Positive control: the same call does prime on Cerebras.
    assert.equal(createAnswerer(CEREBRAS).prime({ context: "DOCUMENTS:\nThe doc.", highlights: true, cards: true }), true);
    await waitFor(() => fake.primes().length === 1, { label: "Cerebras control prime" });
  } finally {
    fake.restore();
  }
});

test("a slow prime never delays the first answer token", async () => {
  let release = () => {};
  const fake = fakeFetch({
    primeReply: () =>
      new Promise((resolve) => {
        release = () => resolve(jsonResponse({ choices: [{ message: { content: "" } }] }));
      }),
  });
  try {
    const answerer = createAnswerer(CEREBRAS);
    const context = "DOCUMENTS:\nThe doc.";
    assert.equal(answerer.prime({ context, highlights: true, cards: true }), true);
    await waitFor(() => fake.primes().length === 1, { label: "prime request" });

    const started = Date.now();
    let firstDeltaMs = null;
    let text = "";
    for await (const delta of answerer.streamAnswer({ question: "How would you scale it?", context, highlights: true, cards: true })) {
      if (firstDeltaMs === null) firstDeltaMs = Date.now() - started;
      text += delta;
    }
    assert.ok(firstDeltaMs !== null && firstDeltaMs < 100, `first delta after ${firstDeltaMs} ms`);
    assert.match(text, /VERDICT: use a queue\./);
    assert.equal(fake.answers().length, 1, "the answer went out while the prime was pending");
    assert.equal(fake.primes().length, 1);
  } finally {
    release();
    fake.restore();
  }
});

test("failures are logged as codes and allow a later retry", async () => {
  let mode = "http";
  const fake = fakeFetch({
    primeReply: (init) => {
      if (mode === "http") return jsonResponse({ error: "busy" }, 500);
      if (mode === "network") throw new Error("connect ECONNREFUSED https://api.cerebras.ai key=ck");
      // As a real fetch does: the request rejects with the signal's reason once the signal aborts.
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });
  const realTimeout = AbortSignal.timeout;
  const logs = [];
  try {
    const answerer = createAnswerer({ ...CEREBRAS, log: (event) => logs.push(event) });
    const args = { context: "DOCUMENTS:\nThe doc.", highlights: true, cards: true };

    assert.equal(answerer.prime(args), true);
    await waitFor(() => logs.length === 1, { label: "HTTP failure log" });
    assert.deepEqual(logs[0], { type: "answerer.prime_failed", reason: "http_500" });

    mode = "network";
    assert.equal(answerer.prime(args), true, "a failed prime is sent again");
    await waitFor(() => logs.length === 2, { label: "network failure log" });
    assert.equal(logs[1].reason, "failed");

    mode = "timeout";
    AbortSignal.timeout = () => realTimeout.call(AbortSignal, 20);
    assert.equal(answerer.prime(args), true);
    await waitFor(() => logs.length === 3, { label: "timeout log" });
    assert.equal(logs[2].reason, "timeout");

    assert.doesNotMatch(JSON.stringify(logs), /ECONNREFUSED|key=ck|Bearer ck|cerebras\.ai/);
  } finally {
    AbortSignal.timeout = realTimeout;
    fake.restore();
  }
});

test("the selectable answerer primes only a Cerebras choice, and again after a switch", async () => {
  const fake = fakeFetch();
  try {
    let choice = "deepseek-flash";
    const answerer = createSelectableAnswerer({
      options: CEREBRAS,
      selectModel: () => choice,
      deepseekApiKey: "dk",
      cerebrasAvailable: true,
    });
    const args = { context: "DOCUMENTS:\nThe doc.", highlights: true, cards: true };

    assert.equal(answerer.prime(args), false);
    await sleep(20);
    assert.equal(fake.calls.length, 0, "a DeepSeek choice primes nothing");

    choice = "cerebras-qwen-thinking";
    assert.equal(answerer.prime(args), true);
    await waitFor(() => fake.primes().length === 1, { label: "Cerebras prime after the switch" });
    assert.equal(fake.primes()[0].url, "https://api.cerebras.ai/v1/chat/completions");
    assert.equal(answerer.prime(args), false);
    await sleep(20);
    assert.equal(fake.primes().length, 1);
  } finally {
    fake.restore();
  }
});

test("the pipeline primes once after the document loads, with the next answer's system message", async () => {
  const fake = fakeFetch();
  const frames = [];
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr: fakeAsr(),
    answerer: createAnswerer(CEREBRAS),
  });
  try {
    engine.onSessionStart({ sessionId: "prime" });
    engine.onContextSet({ docs: "Pricing: forty dollars a seat.", name: "notes.txt" });
    await sleep(10);
    engine.onContextSet({ docs: "Pricing: forty dollars a seat.", name: "notes.txt" });
    await sleep(450);
    assert.equal(fake.primes().length, 1, "one debounced prime for the document");

    engine.onAnswerRequest({ utterance: "What does it cost?" });
    await waitFor(() => frames.some((frame) => frame.type === "turn.done"), { label: "turn.done" });
    assert.equal(fake.answers().length, 1);
    assert.equal(fake.answers()[0].body.messages[0].content, fake.primes()[0].body.messages[0].content);
  } finally {
    engine.dispose();
    fake.restore();
  }
});

test("no document, no prime", async () => {
  const fake = fakeFetch();
  const engine = createPipelineEngine({ emit() {}, asr: fakeAsr(), answerer: createAnswerer(CEREBRAS) });
  try {
    engine.onSessionStart({ sessionId: "bare" });
    await sleep(450);
    assert.equal(fake.calls.length, 0, "a session with no document primes nothing");

    engine.onContextSet({ docs: "" });
    await sleep(450);
    assert.equal(fake.calls.length, 0, "an empty document primes nothing");

    // Positive control: a real document does prime through the same engine.
    engine.onContextSet({ docs: "Pricing: forty dollars a seat." });
    await waitFor(() => fake.primes().length === 1, { label: "prime once a document is loaded" });
  } finally {
    engine.dispose();
    fake.restore();
  }
});

test("a partial never primes: its speculative answer sends the same prefix", async () => {
  const primes = [];
  const streamed = [];
  let deliverTranscript = null;
  const answererStub = {
    async *streamAnswer(args) {
      streamed.push(args);
      yield "x";
    },
    prime(args) {
      primes.push(args);
      return true;
    },
  };
  const asr = {
    pushAudio() {},
    finalize() {
      return true;
    },
    close() {},
    onTranscript(cb) {
      deliverTranscript = cb;
    },
  };
  const engine = createPipelineEngine({ emit() {}, asr, answerer: answererStub });
  try {
    engine.onSessionStart({ sessionId: "segment" });
    engine.onContextSet({ docs: "D" });
    await sleep(450);
    assert.equal(primes.length, 1, "the document primes once");

    deliverTranscript({ text: "how much does it", final: false, stream: 1, role: "prospect", source: "system" });
    await waitFor(() => streamed.length === 1, { label: "speculative answer" });
    await sleep(450);
    assert.equal(primes.length, 1, "the partial and its answer add no prime");

    const answer = streamed[0];
    const prime = primes[0];
    assert.equal(prime.highlights, answer.highlights);
    assert.equal(prime.cards, answer.cards);
  } finally {
    engine.dispose();
  }
});

test("dispose cancels a pending prime", async () => {
  const fake = fakeFetch();
  const disposed = createPipelineEngine({ emit() {}, asr: fakeAsr(), answerer: createAnswerer(CEREBRAS) });
  const live = createPipelineEngine({ emit() {}, asr: fakeAsr(), answerer: createAnswerer(CEREBRAS) });
  try {
    disposed.onSessionStart({ sessionId: "gone" });
    disposed.onContextSet({ docs: "Pricing: forty dollars a seat." });
    live.onSessionStart({ sessionId: "live" });
    live.onContextSet({ docs: "Pricing: forty dollars a seat." });
    await sleep(100);
    disposed.dispose();
    await sleep(450);
    assert.equal(fake.primes().length, 1, "only the engine that was not disposed primed");
  } finally {
    live.dispose();
    disposed.dispose();
    fake.restore();
  }
});
