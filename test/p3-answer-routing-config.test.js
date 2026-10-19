import test from "node:test";
import assert from "node:assert/strict";
import { buildEngineConfig } from "../src/server/engines/config.js";

const baseEnv = { ANSWER_PROVIDER: "openai-compatible", LLM_BASE_URL: "https://llm.example/v1", LLM_API_KEY: "llm-key", LLM_MODEL: "base-model" };

test("defaults: spoken mode and no routes", () => {
  const config = buildEngineConfig({ ...baseEnv });
  assert.equal(config.answererOptions.promptMode, "spoken");
  assert.equal(config.answererOptions.routes, undefined);
});

test("ANSWER_PROMPT_MODE=technical selects the technical default; anything else falls back to spoken", () => {
  assert.equal(buildEngineConfig({ ...baseEnv, ANSWER_PROMPT_MODE: "technical" }).answererOptions.promptMode, "technical");
  assert.equal(buildEngineConfig({ ...baseEnv, ANSWER_PROMPT_MODE: "banana" }).answererOptions.promptMode, "spoken");
});

test("LLM_TECHNICAL_* builds the technical slot over the base slot", () => {
  const config = buildEngineConfig({
    ...baseEnv,
    LLM_TECHNICAL_BASE_URL: "https://tech.example/v1",
    LLM_TECHNICAL_API_KEY: "tech-key",
    LLM_TECHNICAL_MODEL: "tech-model",
    LLM_TECHNICAL_REASONING_EFFORT: "high",
  });
  assert.deepEqual(config.answererOptions.routes.technical, {
    provider: "openai-compatible",
    baseUrl: "https://tech.example/v1",
    apiKey: "tech-key",
    model: "tech-model",
    reasoningEffort: "high",
  });
});

test("a model-only technical override shares the base endpoint and key", () => {
  const config = buildEngineConfig({ ...baseEnv, LLM_TECHNICAL_MODEL: "tech-model" });
  assert.deepEqual(config.answererOptions.routes.technical, {
    provider: "openai-compatible",
    baseUrl: "https://llm.example/v1",
    apiKey: "llm-key",
    model: "tech-model",
    reasoningEffort: undefined,
  });
});

test("the shared LLM key is not reused on a foreign technical origin", () => {
  const config = buildEngineConfig({ ...baseEnv, LLM_TECHNICAL_BASE_URL: "https://tech.example/v1" });
  assert.equal(config.answererOptions.routes.technical.apiKey, undefined);
  assert.equal(config.answererOptions.routes.technical.baseUrl, "https://tech.example/v1");
});

test("no LLM_TECHNICAL_* means no routes at all", () => {
  const config = buildEngineConfig({ ...baseEnv, ANSWER_PROMPT_MODE: "technical" });
  assert.equal(config.answererOptions.routes, undefined);
});

test("the technical slot stays inside the chosen provider; ANSWER_PROVIDER=mock never goes live", () => {
  const config = buildEngineConfig({
    ANSWER_PROVIDER: "mock",
    LLM_BASE_URL: "https://llm.example/v1",
    LLM_API_KEY: "llm-key",
    LLM_MODEL: "base-model",
    LLM_TECHNICAL_BASE_URL: "https://tech.example/v1",
    LLM_TECHNICAL_API_KEY: "tech-key",
    LLM_TECHNICAL_MODEL: "tech-model",
  });
  assert.equal(config.answererOptions.routes.technical.provider, "mock");
});
