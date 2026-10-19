import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createAnswerer } from "../src/server/engines/answerer.js";
import { applyVendorPresets, buildEngineConfig } from "../src/server/engines/config.js";

const CEREBRAS = "cerebras-key-0123456789";
const GROQ = "groq-key-0123456789";
const TYPESAFE = "typesafe-key-0123456789";

test("a Cerebras key configures the answerer: Qwen, reasoning on, key on Cerebras only", () => {
  const config = buildEngineConfig({ CEREBRAS_API_KEY: CEREBRAS }, { mode: "live" });
  assert.equal(config.answerProvider, "openai-compatible");
  assert.equal(config.answererOptions.baseUrl, "https://api.cerebras.ai/v1");
  assert.equal(config.answererOptions.apiKey, CEREBRAS);
  assert.equal(config.answererOptions.model, "qwen-3.8-27b");
  assert.equal(config.answererOptions.reasoningEffort, "high");
  // No ASR configured: live mode fails closed instead of reusing the LLM key elsewhere.
  assert.equal(config.asrOptions.provider, "unconfigured");
});

test("an explicit LLM_REASONING_EFFORT wins over the Cerebras preset", () => {
  const config = buildEngineConfig({ CEREBRAS_API_KEY: CEREBRAS, LLM_REASONING_EFFORT: "none" }, { mode: "live" });
  assert.equal(config.answererOptions.baseUrl, "https://api.cerebras.ai/v1");
  assert.equal(config.answererOptions.reasoningEffort, "none");
});

test("a Groq key configures live ASR on Groq with its per-minute budget", () => {
  const config = buildEngineConfig({ GROQ_API_KEY: GROQ, CEREBRAS_API_KEY: CEREBRAS }, { mode: "live" });
  assert.equal(config.asrOptions.provider, "openai-compatible");
  assert.equal(config.asrOptions.configured, true);
  assert.equal(config.asrOptions.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(config.asrOptions.apiKey, GROQ, "the Groq key, never the Cerebras key");
  assert.equal(config.asrOptions.model, "whisper-large-v3-turbo");
  assert.equal(config.asrOptions.maxRequestsPerMinute, 20);
  assert.equal(config.answererOptions.apiKey, CEREBRAS, "the Cerebras key, never the Groq key");
});

test("explicit provider settings win over vendor keys", () => {
  const env = {
    CEREBRAS_API_KEY: CEREBRAS,
    GROQ_API_KEY: GROQ,
    ANSWER_PROVIDER: "openai-compatible",
    LLM_BASE_URL: "https://llm.example.com/v1",
    LLM_API_KEY: "explicit-llm",
    LLM_MODEL: "explicit-model",
    ASR_PROVIDER: "openai-compatible",
    ASR_BASE_URL: "https://asr.example.com/v1",
    ASR_API_KEY: "explicit-asr",
  };
  const config = buildEngineConfig(env, { mode: "live" });
  assert.equal(config.answererOptions.baseUrl, "https://llm.example.com/v1");
  assert.equal(config.answererOptions.apiKey, "explicit-llm");
  assert.equal(config.answererOptions.reasoningEffort, undefined);
  assert.equal(config.asrOptions.apiKey, "explicit-asr");
  assert.equal(config.asrOptions.maxRequestsPerMinute, undefined);
  assert.equal(buildEngineConfig({ CEREBRAS_API_KEY: CEREBRAS, ANSWER_PROVIDER: "mock" }).answerProvider, "mock");
});

test("a TypeSafe key turns both judgments on unless JEV_JUDGMENTS says otherwise", () => {
  const on = buildEngineConfig({ TYPESAFE_API_KEY: TYPESAFE }, { mode: "demo" });
  assert.deepEqual(on.judgeOptions.features, { gate: true, rescue: true });
  assert.equal(on.judgeOptions.apiKey, TYPESAFE);
  assert.equal(buildEngineConfig({ TYPESAFE_API_KEY: TYPESAFE, JEV_JUDGMENTS: "off" }, { mode: "demo" }).judgeOptions, null);
  const gateOnly = buildEngineConfig({ TYPESAFE_API_KEY: TYPESAFE, JEV_JUDGMENTS: "gate" }, { mode: "demo" });
  assert.deepEqual(gateOnly.judgeOptions.features, { gate: true, rescue: false });
});

test("applyVendorPresets leaves the input untouched", () => {
  const env = { CEREBRAS_API_KEY: CEREBRAS };
  const out = applyVendorPresets(env);
  assert.deepEqual(env, { CEREBRAS_API_KEY: CEREBRAS });
  assert.equal(out.LLM_API_KEY, CEREBRAS);
});

test("reasoningEffort is sent as reasoning_effort only when set", async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    for (const reasoningEffort of ["none", undefined]) {
      const answerer = createAnswerer({ provider: "openai-compatible", baseUrl, apiKey: "k", model: "m", reasoningEffort });
      for await (const _ of answerer.streamAnswer({ question: "q" }));
    }
    assert.equal(bodies[0].reasoning_effort, "none");
    assert.equal("reasoning_effort" in bodies[1], false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the Cerebras answer preset never routes vision: screenshots go to the DeepSeek preset", async () => {
  const { createVisionEngine } = await import("../src/server/engines/vision.js");
  const DEEPSEEK = "deepseek-key-0123456789";
  const config = buildEngineConfig({ CEREBRAS_API_KEY: CEREBRAS, DEEPSEEK_API_KEY: DEEPSEEK }, { mode: "demo" });
  // Qwen on Cerebras takes no images: the preset configures answers only.
  assert.equal(config.visionOptions.baseUrl, undefined);
  assert.equal(config.visionOptions.model, undefined);
  assert.equal(config.visionOptions.apiKey, undefined, "the Cerebras key never follows vision");

  const saved = process.env.DEEPSEEK_API_KEY;
  const realFetch = globalThis.fetch;
  const seen = [];
  process.env.DEEPSEEK_API_KEY = DEEPSEEK;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.authorization, model: JSON.parse(init.body).model });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"other","interpretation":"a slide"}' } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const engine = createVisionEngine({ ...config.visionOptions, log: () => {} });
    const result = await engine.analyse({ command_id: "v1", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]) }, {});
    assert.equal(result.status, "ok");
    assert.deepEqual(seen, [{ url: "https://api.deepseek.com/chat/completions", auth: `Bearer ${DEEPSEEK}`, model: "deepseek-flash" }]);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved;
  }
});

test("an operator's own LLM settings still reach vision", () => {
  const config = buildEngineConfig(
    { CEREBRAS_API_KEY: CEREBRAS, LLM_BASE_URL: "https://llm.example.com/v1", LLM_API_KEY: "sk-llm", LLM_MODEL: "vl-model" },
    { mode: "demo" },
  );
  assert.equal(config.visionOptions.baseUrl, "https://llm.example.com/v1");
  assert.equal(config.visionOptions.apiKey, "sk-llm");
  assert.equal(config.visionOptions.model, "vl-model");
});
