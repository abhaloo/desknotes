import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ANSWER_MODEL_CHOICES,
  DEEPSEEK,
  DEFAULT_ANSWER_MODEL,
  applyAnswerModelSelection,
  isAnswerModelChoice,
  normalizeAnswerModel,
  providerRequestExtras,
} from "../src/server/engines/answer-models.js";
import { createAnswerer } from "../src/server/engines/answerer.js";
import { buildEngineConfig } from "../src/server/engines/config.js";
import { createSelectableAnswerer } from "../src/server/engines/index.js";

const DEEPSEEK_KEY = "deepseek-key-0123456789";
const CEREBRAS_KEY = "cerebras-key-0123456789";
const CEREBRAS_OPTIONS = Object.freeze({
  provider: "openai-compatible",
  baseUrl: "https://api.cerebras.ai/v1",
  apiKey: CEREBRAS_KEY,
  model: "qwen-3.8-27b",
  reasoningEffort: "high",
});

/** Records every chat request (url + body) and answers with one SSE delta. */
function fakeChat() {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

test("the three choices: DeepSeek V4.1 Flash (default, thinking on), Flash fast, Qwen 27B thinking", () => {
  assert.deepEqual(
    ANSWER_MODEL_CHOICES.map(({ id, label, model, thinking }) => [id, label, model ?? null, thinking ?? null]),
    [
      ["deepseek-flash-thinking", "DeepSeek V4.1 Flash", "deepseek-flash", "enabled"],
      ["deepseek-flash", "DeepSeek V4.1 Flash (fast)", "deepseek-flash", "disabled"],
      ["cerebras-qwen-thinking", "Qwen 27B thinking (Cerebras)", null, null],
    ],
  );
  assert.equal(DEFAULT_ANSWER_MODEL, ANSWER_MODEL_CHOICES[0].id, "the default comes first");
  assert.equal(DEEPSEEK.baseUrl, "https://api.deepseek.com");
  for (const { id } of ANSWER_MODEL_CHOICES) assert.equal(isAnswerModelChoice(id), true);
  for (const bad of ["", "deepseek-v4-pro", "deepseek-v4.1", "deepseek-v4.1-flash", "cerebras-qwen", null, 3, "gpt-4o"]) assert.equal(isAnswerModelChoice(bad), false);
});

test("normalizeAnswerModel migrates old ids and sends anything unknown to the default", () => {
  assert.equal(normalizeAnswerModel(""), DEFAULT_ANSWER_MODEL, "old Automatic");
  assert.equal(normalizeAnswerModel("deepseek-v4-pro"), "deepseek-flash", "Pro had thinking off");
  assert.equal(normalizeAnswerModel("deepseek-flash"), "deepseek-flash");
  assert.equal(normalizeAnswerModel("cerebras-qwen"), "cerebras-qwen-thinking", "Qwen answers only with thinking");
  assert.equal(normalizeAnswerModel("cerebras-qwen-thinking"), "cerebras-qwen-thinking");
  for (const unknown of [null, undefined, 7, {}, "gpt-9", "__proto__", "toString", "constructor"]) {
    assert.equal(normalizeAnswerModel(unknown), DEFAULT_ANSWER_MODEL, String(unknown));
  }
});

test("thinking is off on the DeepSeek origin unless the choice asks for it, and never sent elsewhere", () => {
  assert.deepEqual(providerRequestExtras("https://api.deepseek.com"), { thinking: { type: "disabled" } });
  assert.deepEqual(providerRequestExtras("https://api.deepseek.com/v1"), { thinking: { type: "disabled" } });
  assert.deepEqual(providerRequestExtras("https://api.deepseek.com", { thinking: "enabled" }), { thinking: { type: "enabled" } });
  assert.deepEqual(providerRequestExtras("https://api.deepseek.com", { thinking: "maybe" }), { thinking: { type: "disabled" } });
  assert.deepEqual(providerRequestExtras("https://api.cerebras.ai/v1", { thinking: "enabled" }), {});
  assert.deepEqual(providerRequestExtras("https://api.deepseek.com.evil.example", { thinking: "enabled" }), {});
  assert.deepEqual(providerRequestExtras(undefined), {});
});

test("a DeepSeek choice points the answerer at DeepSeek with the DeepSeek key", () => {
  const cerebras = buildEngineConfig({ CEREBRAS_API_KEY: CEREBRAS_KEY }, { mode: "demo" }).answererOptions;
  for (const [id, thinking] of [["deepseek-flash-thinking", "enabled"], ["deepseek-flash", "disabled"], [null, "enabled"], ["", "enabled"]]) {
    const { options, unavailable, choice } = applyAnswerModelSelection(
      { provider: "openai-compatible", ...cerebras },
      { answerModel: id, deepseekApiKey: DEEPSEEK_KEY, cerebrasAvailable: true },
    );
    assert.equal(unavailable, false);
    assert.equal(choice, id || DEFAULT_ANSWER_MODEL);
    assert.equal(options.provider, "openai-compatible");
    assert.equal(options.baseUrl, "https://api.deepseek.com");
    assert.equal(options.apiKey, DEEPSEEK_KEY, "never the Cerebras key");
    assert.equal(options.model, "deepseek-flash");
    assert.equal(options.thinking, thinking);
    assert.equal(options.reasoningEffort, undefined, "Cerebras' reasoning_effort high is not sent to DeepSeek");
  }
});

test("without a DeepSeek key the default falls back to the configured Cerebras Qwen preset, never to mock", () => {
  const config = buildEngineConfig({ CEREBRAS_API_KEY: CEREBRAS_KEY }, { mode: "demo" });
  const base = { provider: config.answerProvider, ...config.answererOptions };
  assert.equal(base.provider, "openai-compatible");
  assert.equal(base.model, "qwen-3.8-27b");
  assert.equal(base.reasoningEffort, "high", "the fallback is Qwen with thinking too");
  for (const answerModel of [DEFAULT_ANSWER_MODEL, "deepseek-flash", "", null, "deepseek-v4-pro", "gpt-9"]) {
    const { options, unavailable } = applyAnswerModelSelection(base, { answerModel, deepseekApiKey: null, cerebrasAvailable: config.cerebrasAvailable });
    assert.equal(options, base, `${answerModel}: the configured engine, unchanged`);
    assert.equal(unavailable, true, "the Settings note says why");
  }
});

test("the old Qwen id answers on Qwen with thinking, even when a DeepSeek key exists", () => {
  const plain = { ...CEREBRAS_OPTIONS, reasoningEffort: "none" };
  assert.deepEqual(
    applyAnswerModelSelection(plain, { answerModel: "cerebras-qwen", deepseekApiKey: DEEPSEEK_KEY, cerebrasAvailable: true }),
    { options: { ...CEREBRAS_OPTIONS, reasoningEffort: "high" }, unavailable: false, choice: "cerebras-qwen-thinking" },
  );
  const mock = { provider: "mock" };
  assert.equal(applyAnswerModelSelection(mock, { answerModel: "cerebras-qwen", cerebrasAvailable: false }).unavailable, true, "no Cerebras key: not Qwen");
});

test("the CEREBRAS_API_KEY preset is Qwen with thinking, and a DeepSeek key alone never rewrites it", () => {
  const cerebras = buildEngineConfig({ CEREBRAS_API_KEY: CEREBRAS_KEY }, { mode: "demo" });
  assert.equal(cerebras.answerProvider, "openai-compatible");
  assert.equal(cerebras.answererOptions.baseUrl, "https://api.cerebras.ai/v1");
  assert.equal(cerebras.answererOptions.model, "qwen-3.8-27b");
  assert.equal(cerebras.answererOptions.reasoningEffort, "high");
  assert.equal(cerebras.cerebrasAvailable, true);
  const config = buildEngineConfig({ DEEPSEEK_API_KEY: DEEPSEEK_KEY }, { mode: "demo" });
  assert.equal(config.answerProvider, "mock");
  assert.equal(config.answererOptions.apiKey, undefined);
  assert.equal(config.deepseekApiKey, DEEPSEEK_KEY);
  assert.equal(config.cerebrasAvailable, false);
  assert.equal(config.answerModel, null);
  const pinned = buildEngineConfig({ DEEPSEEK_API_KEY: DEEPSEEK_KEY, ANSWER_MODEL: "deepseek-flash" }, { mode: "demo" });
  assert.equal(pinned.answerModel, "deepseek-flash");
});

test("buildEngineConfig hands the instructions path to the answerer and vision engines", () => {
  const fromOption = buildEngineConfig({ ANSWER_INSTRUCTIONS_PATH: "C:\\env.txt" }, { mode: "demo", answerInstructionsPath: "C:\\opt.txt" });
  assert.equal(fromOption.answererOptions.answerInstructionsPath, "C:\\opt.txt");
  assert.equal(fromOption.visionOptions.answerInstructionsPath, "C:\\opt.txt");
  assert.equal(buildEngineConfig({ ANSWER_INSTRUCTIONS_PATH: "C:\\env.txt" }, { mode: "demo" }).answererOptions.answerInstructionsPath, "C:\\env.txt");
  assert.equal(buildEngineConfig({}, { mode: "demo" }).answererOptions.answerInstructionsPath, null);
});

test("the selectable answerer follows the choice per answer, with thinking on only for the default", async () => {
  const chat = fakeChat();
  const logs = [];
  let choice = "cerebras-qwen-thinking";
  try {
    const answerer = createSelectableAnswerer({
      options: CEREBRAS_OPTIONS,
      selectModel: () => choice,
      deepseekApiKey: DEEPSEEK_KEY,
      cerebrasAvailable: true,
      log: (entry) => logs.push(entry),
    });
    await answerer.answerOnce({ question: "one" });
    choice = "deepseek-flash";
    await answerer.answerOnce({ question: "two" });
    await answerer.answerOnce({ question: "three" });
    choice = "deepseek-flash-thinking";
    await answerer.answerOnce({ question: "four" });
    choice = null; // nothing chosen: the default
    await answerer.answerOnce({ question: "five" });

    assert.deepEqual(
      chat.calls.map(({ url, body, auth }) => [url, body.model, body.thinking?.type ?? null, body.reasoning_effort ?? null, auth]),
      [
        ["https://api.cerebras.ai/v1/chat/completions", "qwen-3.8-27b", null, "high", `Bearer ${CEREBRAS_KEY}`],
        ["https://api.deepseek.com/chat/completions", "deepseek-flash", "disabled", null, `Bearer ${DEEPSEEK_KEY}`],
        ["https://api.deepseek.com/chat/completions", "deepseek-flash", "disabled", null, `Bearer ${DEEPSEEK_KEY}`],
        ["https://api.deepseek.com/chat/completions", "deepseek-flash", "enabled", null, `Bearer ${DEEPSEEK_KEY}`],
        ["https://api.deepseek.com/chat/completions", "deepseek-flash", "enabled", null, `Bearer ${DEEPSEEK_KEY}`],
      ],
    );
    // One log line per switch, never one per answer, and never a key. The two
    // DeepSeek choices share a model id, so the choice itself is in the key.
    assert.deepEqual(
      logs.filter((entry) => entry.type === "engine.answer_model").map(({ selected, model, thinking }) => [selected, model, thinking]),
      [
        ["cerebras-qwen-thinking", "qwen-3.8-27b", null],
        ["deepseek-flash", "deepseek-flash", "disabled"],
        ["deepseek-flash-thinking", "deepseek-flash", "enabled"],
      ],
    );
    assert.equal(JSON.stringify(logs).includes(DEEPSEEK_KEY), false);
  } finally {
    chat.restore();
  }
});

test("the answer-instructions file applies to every choice", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "answer-models-"));
  const chat = fakeChat();
  let choice = null;
  try {
    const file = path.join(dir, "answer-instructions.txt");
    await writeFile(file, "Role:\nYou are Pat, a pirate-voiced account executive.\n");
    const answerer = createSelectableAnswerer({
      options: { ...CEREBRAS_OPTIONS, answerInstructionsPath: file },
      selectModel: () => choice,
      deepseekApiKey: DEEPSEEK_KEY,
      cerebrasAvailable: true,
    });
    for (const id of ANSWER_MODEL_CHOICES.map((entry) => entry.id)) {
      choice = id;
      await answerer.answerOnce({ question: `asked on ${id}` });
    }
    assert.equal(chat.calls.length, ANSWER_MODEL_CHOICES.length);
    for (const { body } of chat.calls) {
      assert.match(body.messages[0].content, /pirate-voiced account executive/, `${body.model} ${body.thinking?.type ?? ""}`);
    }
  } finally {
    chat.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a resolver that throws falls back to the default", async () => {
  const answerer = createSelectableAnswerer({
    options: { provider: "mock" },
    selectModel: () => {
      throw new Error("settings gone");
    },
  });
  const text = await answerer.answerOnce({ question: "still answers?" });
  assert.ok(text.length > 0);
});

test("Qwen 27B thinking: the configured Cerebras engine with reasoning_effort high", async () => {
  const picked = applyAnswerModelSelection(CEREBRAS_OPTIONS, { answerModel: "cerebras-qwen-thinking", deepseekApiKey: DEEPSEEK_KEY, cerebrasAvailable: true });
  assert.deepEqual(picked, { options: { ...CEREBRAS_OPTIONS, reasoningEffort: "high" }, unavailable: false, choice: "cerebras-qwen-thinking" });
  // The request reaches Cerebras with the effort; the reasoning field itself is never streamed.
  const chat = fakeChat();
  try {
    await createAnswerer(picked.options).answerOnce({ question: "q" });
    assert.equal(chat.calls[0].url, "https://api.cerebras.ai/v1/chat/completions");
    assert.equal(chat.calls[0].body.reasoning_effort, "high");
    assert.equal(chat.calls[0].body.model, "qwen-3.8-27b");
  } finally {
    chat.restore();
  }
  // No Cerebras key, or an engine that is not Cerebras: unchanged, and the note says why.
  const mock = { provider: "mock" };
  assert.deepEqual(applyAnswerModelSelection(mock, { answerModel: "cerebras-qwen-thinking", cerebrasAvailable: false }), { options: mock, unavailable: true, choice: "cerebras-qwen-thinking" });
  const other = { ...CEREBRAS_OPTIONS, baseUrl: "https://llm.example.com/v1" };
  assert.deepEqual(applyAnswerModelSelection(other, { answerModel: "cerebras-qwen-thinking", cerebrasAvailable: true }), { options: other, unavailable: true, choice: "cerebras-qwen-thinking" });
});

/**
 * A chosen engine that refuses the request (Cerebras 402 out of credit) must
 * not turn every card empty: the same question is replayed once on DeepSeek
 * V4.1 Flash with thinking on, which is the default Settings choice.
 */
function refusingChat({ refuseOrigin = "https://api.cerebras.ai", status = 402 } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization };
    calls.push(call);
    if (call.url.startsWith(refuseOrigin)) {
      return new Response(JSON.stringify({ message: "Payment required to access this resource.", code: "payment_required" }), {
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

test("a Cerebras refusal replays the answer on DeepSeek thinking, and logs the switch", async () => {
  const chat = refusingChat();
  const logs = [];
  try {
    const answerer = createSelectableAnswerer({
      options: CEREBRAS_OPTIONS,
      selectModel: () => "cerebras-qwen-thinking",
      deepseekApiKey: DEEPSEEK_KEY,
      cerebrasAvailable: true,
      log: (entry) => logs.push(entry),
    });
    const text = await answerer.answerOnce({ question: "what is a worker thread" });
    // The spoken filter bullets the line: the answer arrives, from DeepSeek.
    assert.match(text.trim(), /ok/, "the answer still arrives");
    assert.deepEqual(
      chat.calls.map(({ url, body, auth }) => [url, body.model, body.thinking?.type ?? null, body.reasoning_effort ?? null, auth]),
      [
        ["https://api.cerebras.ai/v1/chat/completions", "qwen-3.8-27b", null, "high", `Bearer ${CEREBRAS_KEY}`],
        ["https://api.deepseek.com/chat/completions", "deepseek-flash", "enabled", null, `Bearer ${DEEPSEEK_KEY}`],
      ],
    );
    const switchLine = logs.find((entry) => entry.type === "engine.answer_failover");
    assert.deepEqual(
      { status: switchLine.status, from: switchLine.from, to: switchLine.to, choice: switchLine.choice, thinking: switchLine.thinking },
      { status: 402, from: "qwen-3.8-27b", to: "deepseek-flash", choice: "deepseek-flash-thinking", thinking: "enabled" },
    );
    assert.equal(JSON.stringify(logs).includes(DEEPSEEK_KEY), false, "never a key in the log");
  } finally {
    chat.restore();
  }
});

test("the failover runs only on a refusal, and never onto the same origin", async () => {
  // A 5xx is the pipeline's retry, not another provider's problem.
  let chat = refusingChat({ status: 503 });
  try {
    const answerer = createSelectableAnswerer({
      options: CEREBRAS_OPTIONS,
      selectModel: () => "cerebras-qwen-thinking",
      deepseekApiKey: DEEPSEEK_KEY,
      cerebrasAvailable: true,
    });
    await assert.rejects(() => answerer.answerOnce({ question: "q" }), /HTTP 503/);
    assert.equal(chat.calls.length, 1);
  } finally {
    chat.restore();
  }
  // Already answering on DeepSeek: another attempt on the same origin is pointless.
  chat = refusingChat({ refuseOrigin: "https://api.deepseek.com" });
  try {
    const answerer = createSelectableAnswerer({
      options: CEREBRAS_OPTIONS,
      selectModel: () => "deepseek-flash",
      deepseekApiKey: DEEPSEEK_KEY,
      cerebrasAvailable: true,
    });
    await assert.rejects(() => answerer.answerOnce({ question: "q" }), /HTTP 402/);
    assert.equal(chat.calls.length, 1);
  } finally {
    chat.restore();
  }
  // No DeepSeek key to fail over to: the refusal surfaces as before.
  chat = refusingChat();
  try {
    const answerer = createSelectableAnswerer({
      options: CEREBRAS_OPTIONS,
      selectModel: () => "cerebras-qwen-thinking",
      deepseekApiKey: null,
      cerebrasAvailable: true,
    });
    await assert.rejects(() => answerer.answerOnce({ question: "q" }), /HTTP 402/);
    assert.equal(chat.calls.length, 1);
  } finally {
    chat.restore();
  }
});
