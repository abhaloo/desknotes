import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createAnswerer, DEFAULT_SYSTEM_PROMPT, GROUNDING_RULE } from "../src/server/engines/answerer.js";
import { createVisionEngine } from "../src/server/engines/vision.js";
import { hashImage } from "../src/vision/index.js";
import { scopedApiKey } from "../src/server/engines/provider-http.js";

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}
// Drop keep-alive/in-flight sockets first: a capped stream leaves the provider
// mid-write, and server.close() alone would wait on that socket indefinitely.
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });

async function drain(answerer, args = { question: "q" }) {
  let text = "";
  for await (const delta of answerer.streamAnswer(args)) text += delta;
  return text;
}

test("answerer refuses a plaintext remote provider URL and answers nothing (key never sent)", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error("must not be called");
  };
  try {
    const logs = [];
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: "http://llm.example.com/v1",
      apiKey: "sk-test-plaintext",
      log: (entry) => logs.push(entry),
      deltaMinMs: 0,
      deltaMaxMs: 0,
    });
    await assert.rejects(() => drain(answerer), (error) => error.code === "no_answer_model", "no demo text either");
    assert.equal(calls.length, 0, "no request may carry the key over plaintext");
    const entry = logs.find((e) => e.type === "answerer.provider_insecure_url");
    assert.ok(entry, "the refusal is logged");
    assert.equal(JSON.stringify(logs).includes("sk-test-plaintext"), false, "the key is never logged");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("answerer does not follow provider redirects (bearer key must not hop origins)", async () => {
  const leaked = [];
  const sink = await listen((req, res) => {
    leaked.push(req.headers.authorization ?? null);
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"choices":[{"message":{"content":"redirected"}}]}');
  });
  const origin = await listen((req, res) => {
    req.resume();
    res.writeHead(307, { location: `http://127.0.0.1:${sink.port}/v1/chat/completions` });
    res.end();
  });
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      apiKey: "sk-test-redirect",
    });
    await assert.rejects(() => drain(answerer));
    assert.equal(leaked.length, 0, "the redirect target must never be contacted");
  } finally {
    await close(origin.server);
    await close(sink.server);
  }
});

test("answerer error messages never contain the API key", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connect failed for Bearer sk-test-in-error");
  };
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "sk-test-in-error",
    });
    await assert.rejects(
      () => drain(answerer),
      (error) => !String(error?.message).includes("sk-test-in-error") && !String(error?.stack).includes("sk-test-in-error"),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("answerer caps a runaway provider stream", async () => {
  const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(1000) } }] })}\n\n`;
  const { server, port } = await listen((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    let sent = 0;
    let gone = false;
    res.on("close", () => (gone = true)); // the client cancelled at its cap
    const pump = () => {
      while (sent < 500 && !gone) {
        sent += 1;
        if (!res.write(chunk)) return res.once("drain", pump);
      }
      if (!gone) res.end("data: [DONE]\n\n");
    };
    pump();
  });
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "k",
      maxAnswerChars: 20_000,
    });
    // The cap counts the provider's characters; the filter's bullet markers
    // come on top of it.
    const text = (await drain(answerer)).replace(/^• /gm, "");
    assert.ok(text.length <= 20_000, `answer capped (got ${text.length})`);
    assert.ok(text.length >= 19_000, "the cap truncates, it does not discard");
  } finally {
    await close(server);
  }
});

test("vision provider refuses a plaintext remote URL and uses the heuristic", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error("must not be called");
  };
  try {
    const logs = [];
    const engine = createVisionEngine({
      log: (entry) => logs.push(entry),
      provider: "openai-compatible",
      baseUrl: "http://vision.example.com/v1",
      apiKey: "sk-vision-plain",
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await engine.analyse({ command_id: "c", bytes }, {});
    assert.equal(result.status, "ok");
    assert.equal(calls.length, 0);
    assert.ok(logs.some((e) => e.type === "vision.provider_insecure_url"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("vision provider does not follow redirects and never logs the key", async () => {
  const leaked = [];
  const sink = await listen((req, res) => {
    leaked.push(req.headers.authorization ?? null);
    req.resume();
    res.end("{}");
  });
  const origin = await listen((req, res) => {
    req.resume();
    res.writeHead(302, { location: `http://127.0.0.1:${sink.port}/x` });
    res.end();
  });
  try {
    const logs = [];
    const engine = createVisionEngine({
      log: (entry) => logs.push(entry),
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      apiKey: "sk-vision-redirect",
    });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
    const result = await engine.analyse({ command_id: "r", bytes, image_hash: hashImage(bytes) }, {});
    // A failed model call is a typed failure: a stub reading would feed a
    // screen nobody read into the answer turn.
    assert.equal(result.status, "failed");
    assert.equal(result.failure, "provider");
    assert.equal(leaked.length, 0);
    assert.ok(logs.some((e) => e.type === "vision.error"));
    assert.equal(JSON.stringify(logs).includes("sk-vision-redirect"), false);
  } finally {
    await close(origin.server);
    await close(sink.server);
  }
});

test("the shared LLM key is only reused for a provider on the same origin", () => {
  const llm = { baseUrl: "https://llm.example.com/v1", apiKey: "sk-llm" };
  // Explicit per-provider key always wins.
  assert.equal(scopedApiKey({ explicitKey: "sk-asr", baseUrl: "https://asr.example.com", fallback: llm }), "sk-asr");
  // Same origin (or inherited base URL): reuse is fine.
  assert.equal(scopedApiKey({ baseUrl: undefined, fallback: llm }), "sk-llm");
  assert.equal(scopedApiKey({ baseUrl: "https://llm.example.com/v2", fallback: llm }), "sk-llm");
  // Different origin: the LLM key must not be sent there.
  assert.equal(scopedApiKey({ baseUrl: "https://asr.other.com/v1", fallback: llm }), undefined);
  assert.equal(scopedApiKey({ baseUrl: "http://llm.example.com/v1", fallback: llm }), undefined);
});

test("server entry does not hand the LLM key to a different-origin ASR or vision endpoint", async () => {
  const { buildEngineConfig } = await import("../src/server/main.js");
  const config = buildEngineConfig({
    ANSWER_PROVIDER: "openai-compatible",
    LLM_BASE_URL: "https://llm.example.com/v1",
    LLM_API_KEY: "sk-llm",
    ASR_PROVIDER: "openai-compatible",
    ASR_BASE_URL: "https://stt.other.com/v1",
    VISION_PROVIDER: "openai-compatible",
    VISION_BASE_URL: "https://llm.example.com/v1",
  });
  assert.equal(config.answererOptions.apiKey, "sk-llm");
  assert.equal(config.asrOptions.apiKey, undefined, "foreign-origin ASR must not receive the LLM key");
  assert.equal(config.visionOptions.apiKey, "sk-llm", "same-origin vision may reuse it");

  const explicit = buildEngineConfig({
    LLM_BASE_URL: "https://llm.example.com/v1",
    LLM_API_KEY: "sk-llm",
    ASR_BASE_URL: "https://stt.other.com/v1",
    ASR_API_KEY: "sk-stt",
  });
  assert.equal(explicit.asrOptions.apiKey, "sk-stt");
});

test("answerer bounds the question and context it forwards to the provider", async () => {
  const realFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response('{"choices":[{"message":{"content":"ok"}}]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "sk-test-bounds",
    });
    await drain(answerer, { question: "q".repeat(100_000), context: "c".repeat(1_000_000) });
    const user = sent.messages.find((m) => m.role === "user").content;
    const system = sent.messages.find((m) => m.role === "system").content;
    assert.ok(user.length <= 4_200, `question forwarded at ${user.length} chars`);
    // The fixed prompt is ours; the bound is on the caller-supplied context after it.
    const prefix = `${DEFAULT_SYSTEM_PROMPT}\n\n${GROUNDING_RULE}\n\nContext:\n`;
    assert.ok(system.startsWith(prefix), "the prompt frames the context");
    const forwarded = system.length - prefix.length;
    assert.ok(forwarded <= 32_000, `context forwarded at ${forwarded} chars`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ASR refuses a plaintext remote provider URL and degrades to the mock segmenter", async () => {
  const { createAsr } = await import("../src/server/engines/asr.js");
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error("must not be called");
  };
  try {
    const logs = [];
    const asr = createAsr({
      provider: "openai-compatible",
      baseUrl: "http://stt.example.com/v1",
      apiKey: "sk-stt-plain",
      emit: () => {},
      log: (entry) => logs.push(entry),
    });
    const pcm = new Int16Array(16000).map((_, i) => Math.round(9000 * Math.sin(i / 7)));
    asr.pushAudio({ streamIdx: 1, pcm16: pcm });
    asr.finalize(1);
    await new Promise((r) => setTimeout(r, 50));
    asr.close();
    assert.equal(calls.length, 0, "no audio or key over plaintext");
    assert.ok(logs.some((e) => e.type === "asr.provider_insecure_url"));
    assert.equal(JSON.stringify(logs).includes("sk-stt-plain"), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ASR does not follow provider redirects (call audio and key must not hop origins)", async () => {
  const { createAsr } = await import("../src/server/engines/asr.js");
  const leaked = [];
  const sink = await listen((req, res) => {
    leaked.push(req.headers.authorization ?? null);
    req.resume();
    res.end('{"text":"leaked"}');
  });
  const origin = await listen((req, res) => {
    req.resume();
    res.writeHead(307, { location: `http://127.0.0.1:${sink.port}/v1/audio/transcriptions` });
    res.end();
  });
  try {
    const frames = [];
    const logs = [];
    const asr = createAsr({
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      apiKey: "sk-stt-redirect",
      emit: (f) => frames.push(f),
      log: (e) => logs.push(e),
    });
    const pcm = new Int16Array(16000).map((_, i) => Math.round(9000 * Math.sin(i / 7)));
    asr.pushAudio({ streamIdx: 1, pcm16: pcm });
    asr.finalize(1);
    for (let i = 0; i < 100 && !logs.some((e) => e.type === "asr.stt_error"); i += 1) await new Promise((r) => setTimeout(r, 20));
    asr.close();
    assert.equal(leaked.length, 0, "the redirect target is never contacted");
    assert.ok(logs.some((e) => e.type === "asr.stt_error"));
    assert.equal(JSON.stringify(logs).includes("sk-stt-redirect"), false);
  } finally {
    await close(origin.server);
    await close(sink.server);
  }
});
