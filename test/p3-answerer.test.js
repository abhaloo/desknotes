import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createAnswerer } from "../src/server/engines/answerer.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("mock answerer streams a structured answer in ordered deltas", async () => {
  const answerer = createAnswerer({ provider: "mock", deltaMinMs: 8, deltaMaxMs: 14 });
  const deltas = [];
  const started = Date.now();
  for await (const delta of answerer.streamAnswer({
    question: "How do you handle conflicting priorities?",
    context: "",
    intent: "answer",
  })) {
    deltas.push(delta);
  }
  const elapsed = Date.now() - started;

  assert.ok(deltas.length >= 5, `expected several deltas, got ${deltas.length}`);
  assert.ok(deltas.every((d) => typeof d === "string" && d.length > 0));
  const text = deltas.join("");
  assert.match(text, /Good question/);
  assert.match(text, /conflicting priorities/);
  assert.match(text, /how many reps/i);
  assert.match(text, /short trial/);
  assert.ok(text.length > 200);
  // Pacing is the observable behavior the prefetch path relies on.
  assert.ok(elapsed >= deltas.length * 8 - 10, `streamed too fast: ${elapsed}ms`);
});

test("answerOnce returns exactly the concatenated stream", async () => {
  const answerer = createAnswerer({ provider: "mock", deltaMinMs: 0, deltaMaxMs: 0 });
  const args = { question: "Tell me about a project you are proud of", intent: "answer" };
  const once = await answerer.answerOnce(args);
  let streamed = "";
  for await (const delta of answerer.streamAnswer(args)) streamed += delta;
  assert.equal(once, streamed);
  assert.ok(once.length > 200);
});

test("aborting the signal stops the mock stream promptly", async () => {
  const answerer = createAnswerer({ provider: "mock", deltaMinMs: 5, deltaMaxMs: 5 });
  const controller = new AbortController();
  const deltas = [];
  const task = (async () => {
    for await (const delta of answerer.streamAnswer({ question: "x", signal: controller.signal })) {
      deltas.push(delta);
    }
  })();
  await sleep(28);
  controller.abort();
  const stoppedAt = Date.now();
  await task;
  assert.ok(Date.now() - stoppedAt < 150, "abort must not wait for the full answer");
  const count = deltas.length;
  assert.ok(count >= 2);
  await sleep(30);
  assert.equal(deltas.length, count, "no deltas after abort");
});

test("unconfigured openai-compatible answerer degrades to mock", async () => {
  const logs = [];
  const answerer = createAnswerer({
    provider: "openai-compatible",
    log: (entry) => logs.push(entry),
    deltaMinMs: 0,
    deltaMaxMs: 0,
  });
  const text = await answerer.answerOnce({ question: "What is your biggest strength?", intent: "answer" });
  assert.ok(text.length > 100);
  assert.ok(logs.some((entry) => entry.type === "answerer.provider_unconfigured"));
});

test("configured openai-compatible answerer parses streaming SSE deltas", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
      model: "test-model",
    });
    let text = "";
    for await (const delta of answerer.streamAnswer({ question: "say hello" })) text += delta;
    assert.equal(text, "• Hello world");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("configured openai-compatible answerer surfaces provider errors as typed failures", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"nope"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
      model: "test-model",
    });
    await assert.rejects(async () => {
      for await (const _delta of answerer.streamAnswer({ question: "q" })) {
        /* drain */
      }
    }, /HTTP 500/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
