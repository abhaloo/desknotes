import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAsr } from "../src/server/engines/asr.js";
import { assertProviderUrlAllowed, buildEngineConfig } from "../src/server/engines/config.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 4000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error("timed out");
    await sleep(10);
  }
}

function tone(samples, amplitude = 9000) {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = Math.round(amplitude * Math.sin(i / 7));
  return out;
}

function transcriptsOf(frames) {
  return frames.filter((frame) => frame.type === "transcript");
}

function statesOf(frames) {
  return frames.filter((frame) => frame.type === "transcription.state").map((frame) => frame.data);
}

function statusOf(data) {
  return data.status ?? data.state;
}

test("buildEngineConfig is re-exported from the server entry and the engine index", async () => {
  const fromMain = await import("../src/server/main.js");
  const fromIndex = await import("../src/server/engines/index.js");
  assert.equal(fromMain.buildEngineConfig, buildEngineConfig);
  assert.equal(fromIndex.buildEngineConfig, buildEngineConfig);
});

test("assertProviderUrlAllowed accepts https and loopback http only", () => {
  assert.equal(assertProviderUrlAllowed("https://asr.example.test/v1"), "https://asr.example.test/v1");
  assert.equal(assertProviderUrlAllowed("http://127.0.0.1:9/v1"), "http://127.0.0.1:9/v1");
  assert.throws(() => assertProviderUrlAllowed("http://stt.example.com/v1"), /insecure_scheme/);
  assert.throws(() => assertProviderUrlAllowed("not a url"), /invalid_url/);
});

test("live config wires a real ASR fixture and keeps cross-origin LLM keys off the ASR endpoint", () => {
  const config = buildEngineConfig(
    {
      ASR_PROVIDER: "openai-compatible",
      ASR_BASE_URL: "https://asr.example.test/v1",
      ASR_API_KEY: "fixture-asr",
      ASR_MODEL: "fixture-stt",
      LLM_BASE_URL: "https://llm.example.test/v1",
      LLM_API_KEY: "fixture-llm",
      OPENAI_API_KEY: "fixture-openai",
    },
    { mode: "live" },
  );
  assert.equal(config.mode, "live");
  assert.equal(config.asrProvider, "openai-compatible");
  assert.equal(config.asrOptions.provider, "openai-compatible");
  assert.equal(config.asrOptions.baseUrl, "https://asr.example.test/v1");
  assert.equal(config.asrOptions.apiKey, "fixture-asr");
  assert.equal(config.asrOptions.model, "fixture-stt");
  assert.equal(config.asrOptions.configured, true);
  assert.equal(config.asrOptions.allowMockFallback, false);
  assert.equal(config.answererOptions.apiKey, "fixture-llm");

  const foreign = buildEngineConfig(
    {
      ASR_PROVIDER: "openai-compatible",
      ASR_BASE_URL: "https://stt.other.com/v1",
      ASR_MODEL: "fixture-stt",
      LLM_BASE_URL: "https://llm.example.test/v1",
      LLM_API_KEY: "fixture-llm",
      OPENAI_API_KEY: "fixture-openai",
    },
    { mode: "live" },
  );
  assert.equal(foreign.asrOptions.apiKey, undefined);
  assert.equal(foreign.asrProvider, "unconfigured");
  assert.equal(foreign.asrOptions.configured, false);

  const openaiOrigin = buildEngineConfig(
    {
      ASR_PROVIDER: "openai-compatible",
      ASR_BASE_URL: "https://api.openai.com/v1",
      ASR_MODEL: "fixture-stt",
      LLM_BASE_URL: "https://llm.example.test/v1",
      LLM_API_KEY: "fixture-llm",
      OPENAI_API_KEY: "fixture-openai",
    },
    { mode: "live" },
  );
  assert.equal(openaiOrigin.asrProvider, "openai-compatible");
  assert.equal(openaiOrigin.asrOptions.apiKey, "fixture-openai");
  assert.notEqual(openaiOrigin.asrOptions.apiKey, "fixture-llm");

  const sameOriginLlm = buildEngineConfig(
    {
      ASR_PROVIDER: "openai-compatible",
      ASR_BASE_URL: "https://llm.example.test/v1",
      ASR_MODEL: "fixture-stt",
      LLM_BASE_URL: "https://llm.example.test/v1",
      LLM_API_KEY: "fixture-llm",
      OPENAI_API_KEY: "fixture-openai",
    },
    { mode: "live" },
  );
  assert.equal(sameOriginLlm.asrOptions.apiKey, "fixture-llm");
});

test("unknown COPILOT_MODE is rejected", () => {
  assert.throws(() => buildEngineConfig({ COPILOT_MODE: "paper" }), /COPILOT_MODE/);
  assert.throws(() => buildEngineConfig({ LLM_API_KEY: "fixture-llm" }, { mode: "paper" }), /paper/);
  assert.equal(buildEngineConfig({}).mode, "live");
  assert.equal(buildEngineConfig({ COPILOT_MODE: "demo" }).mode, "demo");
  assert.equal(buildEngineConfig({ COPILOT_MODE: "demo" }, { mode: "live" }).mode, "live");
});

test("missing, invalid, and mock-requested live ASR stay unconfigured and emit no canned words", () => {
  const cases = [
    { env: {}, reason: "missing_provider" },
    {
      env: {
        ASR_PROVIDER: "mock",
        ASR_BASE_URL: "https://asr.example.test/v1",
        ASR_API_KEY: "fixture-asr",
        ASR_MODEL: "fixture-stt",
      },
      reason: "mock_refused",
    },
    {
      env: {
        ASR_PROVIDER: "openai-compatible",
        ASR_BASE_URL: "http://stt.invalid.example/v1",
        ASR_API_KEY: "fixture-key-do-not-leak",
        ASR_MODEL: "fixture-stt",
      },
      reason: "insecure_scheme",
    },
    {
      env: {
        ASR_PROVIDER: "openai-compatible",
        ASR_BASE_URL: "https://asr.example.test/v1",
        ASR_MODEL: "fixture-stt",
      },
      reason: "missing_api_key",
    },
    {
      env: { ASR_PROVIDER: "no-such-provider", ASR_API_KEY: "fixture-asr" },
      reason: "unknown_provider",
    },
  ];

  for (const entry of cases) {
    const config = buildEngineConfig(entry.env, { mode: "live" });
    assert.equal(config.asrProvider, "unconfigured", entry.reason);
    assert.equal(config.asrOptions.provider, "unconfigured");
    assert.equal(config.asrOptions.configured, false);
    assert.equal(config.asrOptions.allowMockFallback, false);
    assert.equal(config.asrOptions.mode, "live");
    assert.equal(config.asrOptions.reason, entry.reason);

    const frames = [];
    const logs = [];
    const asr = createAsr({
      ...config.asrOptions,
      emit: (frame) => frames.push(frame),
      log: (item) => logs.push(item),
    });
    try {
      asr.pushAudio({ streamIdx: 0, pcm16: tone(4800) });
      asr.pushAudio({ streamIdx: 1, pcm16: tone(4800) });
      asr.pushAudio({});
      assert.equal(asr.finalize(0), false);
      assert.equal(asr.finalize(1), false);
      asr.flushInterim(0);
      assert.equal(transcriptsOf(frames).length, 0, entry.reason);
      const states = statesOf(frames);
      assert.ok(states.some((data) => statusOf(data) === "unconfigured"), entry.reason);
      assert.equal(states.some((data) => statusOf(data) === "live"), false);
      const blob = JSON.stringify({ frames, logs });
      assert.equal(blob.includes("We usually start"), false, entry.reason);
      assert.equal(blob.includes("How does your pricing"), false, entry.reason);
      assert.equal(blob.includes("fixture-key-do-not-leak"), false, entry.reason);
      assert.equal(blob.includes("stt.invalid.example"), false, entry.reason);
      assert.equal(blob.includes("fixture-asr"), false, entry.reason);
    } finally {
      asr.close();
    }
  }
});

test("demo mode permits mock ASR and labels transcription state as demo", () => {
  const config = buildEngineConfig({ COPILOT_MODE: "demo" });
  assert.equal(config.mode, "demo");
  assert.equal(config.asrProvider, "mock");
  assert.equal(config.asrOptions.allowMockFallback, true);

  const frames = [];
  const asr = createAsr({
    ...config.asrOptions,
    emit: (frame) => frames.push(frame),
    log: () => {},
  });
  try {
    asr.pushAudio({ streamIdx: 0, pcm16: tone(4800) });
    const texts = transcriptsOf(frames).map((frame) => frame.data.text);
    assert.ok(texts.some((text) => text.includes("We usually")));
    const states = statesOf(frames);
    assert.ok(
      states.some((data) => data.mode === "demo" || data.provider === "mock" || statusOf(data) === "demo"),
    );
  } finally {
    asr.close();
  }
});

test("HTTP ASR failure emits degraded and returns to live only after a successful recognition", async () => {
  let calls = 0;
  const phases = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      calls += 1;
      if (calls === 1) {
        phases.push("fail");
        res.writeHead(500);
        res.end();
        return;
      }
      phases.push("ok");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "heard the caller" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const config = buildEngineConfig(
    {
      ASR_PROVIDER: "openai-compatible",
      ASR_BASE_URL: baseUrl,
      ASR_API_KEY: "fixture-asr",
      ASR_MODEL: "fixture-stt",
      LLM_BASE_URL: "https://llm.example.test/v1",
      LLM_API_KEY: "fixture-llm",
    },
    { mode: "live" },
  );
  assert.equal(config.asrProvider, "openai-compatible");
  assert.equal(config.asrOptions.apiKey, "fixture-asr");

  const frames = [];
  const asr = createAsr({
    ...config.asrOptions,
    emit: (frame) => frames.push(frame),
    log: () => {},
  });
  try {
    asr.pushAudio({ streamIdx: 0, pcm16: tone(16000) });
    await waitFor(() => statesOf(frames).some((data) => statusOf(data) === "degraded"));
    assert.equal(phases[0], "fail");
    assert.equal(
      statesOf(frames).some((data) => statusOf(data) === "live"),
      false,
      "a failed recognition must not report live",
    );
    assert.equal(transcriptsOf(frames).length, 0);

    asr.pushAudio({ streamIdx: 0, pcm16: tone(16000) });
    assert.equal(statesOf(frames).some((data) => statusOf(data) === "live"), false);
    await waitFor(() => statesOf(frames).some((data) => statusOf(data) === "live"));
    assert.equal(phases.at(-1), "ok");
    assert.ok(phases.includes("fail"));
    const texts = transcriptsOf(frames).map((frame) => frame.data.text);
    assert.ok(texts.includes("heard the caller"));
    assert.equal(texts.some((text) => text.includes("We usually start")), false);
    const liveAt = statesOf(frames).findIndex((data) => statusOf(data) === "live");
    const degradedAt = statesOf(frames).findIndex((data) => statusOf(data) === "degraded");
    assert.ok(degradedAt >= 0 && liveAt > degradedAt);
  } finally {
    asr.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
