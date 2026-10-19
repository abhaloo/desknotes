import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJudgeRequest,
  createJudge,
  DISABLED_JUDGE,
  judgeOptionsFromEnv,
  parseFeatures,
  parseJudgeResponse,
} from "../src/server/engines/judge.js";

const KEY = "ts-test-key-123456";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

const ok = (isQuestion, answersSame) =>
  jsonResponse({
    model: "jev-1.13.0",
    answers: {
      is_question: { type: "noul", noul: isQuestion },
      ...(answersSame == null ? {} : { answers_same: { type: "noul", noul: answersSame } }),
    },
    usage: { input_tokens: 120, output_tokens: 4 },
  });

test("no key, no features, or an insecure base URL -> disabled judge", async () => {
  assert.equal(createJudge({ features: "gate" }), DISABLED_JUDGE);
  assert.equal(createJudge({ apiKey: KEY, features: "" }), DISABLED_JUDGE);
  const logs = [];
  const insecure = createJudge({ apiKey: KEY, features: "gate", baseUrl: "http://example.com", log: (e) => logs.push(e) });
  assert.equal(insecure, DISABLED_JUDGE);
  assert.ok(logs.some((e) => e.type === "judge.provider_insecure_url"));
  const v = await DISABLED_JUDGE.evaluate({ utterance: "how much is it" });
  assert.deepEqual(v, { isQuestion: null, answersSame: null, isComplete: null, latencyMs: 0, error: "disabled" });
});

test("parseFeatures accepts strings, arrays and objects", () => {
  assert.deepEqual(parseFeatures("gate, Rescue"), { gate: true, rescue: true });
  assert.deepEqual(parseFeatures(["gate"]), { gate: true, rescue: false });
  assert.deepEqual(parseFeatures({ rescue: true }), { gate: false, rescue: true });
  assert.deepEqual(parseFeatures(undefined), { gate: false, rescue: false });
});

test("request asks is_question always and answers_same only with answeredFor", () => {
  const one = buildJudgeRequest({ model: "jev-latest", utterance: " yeah ok ", recent: ["a", "b", "c", "d"] });
  assert.equal(one.model, "jev-latest");
  assert.equal(one.state.utterance, "yeah ok");
  assert.deepEqual(one.state.recent_prospect_lines, ["b", "c", "d"]);
  assert.deepEqual(Object.keys(one.questions), ["is_question"]);
  assert.equal(one.questions.is_question.type, "noul");
  const two = buildJudgeRequest({ utterance: "how much is the pro plan", answeredFor: "how much is the pro tier" });
  assert.equal(two.state.answered_question, "how much is the pro tier");
  assert.deepEqual(Object.keys(two.questions).sort(), ["answers_same", "is_question"]);
});

test("parseJudgeResponse clamps and nulls missing or non-numeric answers", () => {
  assert.deepEqual(parseJudgeResponse({ answers: { is_question: { noul: 1.2 }, answers_same: { noul: -1 } } }), {
    isQuestion: 1,
    answersSame: 0,
    isComplete: null,
  });
  assert.deepEqual(parseJudgeResponse({ answers: { is_question: { noul: "x" } } }), { isQuestion: null, answersSame: null, isComplete: null });
  assert.deepEqual(parseJudgeResponse(null), { isQuestion: null, answersSame: null, isComplete: null });
});

test("evaluate POSTs one request to /v1/systemone with the bearer key and parses both answers", async () => {
  const fetchImpl = fakeFetch(() => ok(0.91, 0.87));
  const judge = createJudge({ apiKey: KEY, features: "gate,rescue", baseUrl: "https://api.typesafe.ai/", fetchImpl });
  assert.equal(judge.enabled, true);
  assert.deepEqual(judge.features, { gate: true, rescue: true });
  const v = await judge.evaluate({ utterance: "how much is the pro plan", answeredFor: "how much is the pro tier" });
  assert.equal(v.isQuestion, 0.91);
  assert.equal(v.answersSame, 0.87);
  assert.equal(v.error, null);
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(call.init.redirect, "error");
  assert.ok(call.body.questions.answers_same);
});

test("a hung request resolves with error 'timeout' after timeoutMs and aborts the fetch", async () => {
  let signal;
  const fetchImpl = async (_url, init) => {
    signal = init.signal;
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  };
  const judge = createJudge({ apiKey: KEY, features: "gate", fetchImpl, timeoutMs: 60 });
  const started = Date.now();
  const v = await judge.evaluate({ utterance: "how much is it" });
  assert.equal(v.error, "timeout");
  assert.equal(v.isQuestion, null);
  assert.ok(Date.now() - started < 1000);
  assert.equal(signal.aborted, true);
});

test("HTTP errors resolve (never reject) and are not cached", async () => {
  const fetchImpl = fakeFetch((_u, _i, n) => (n === 1 ? jsonResponse({ error: "slow down" }, 429) : ok(0.9)));
  const judge = createJudge({ apiKey: KEY, features: "gate", fetchImpl });
  const first = await judge.evaluate({ utterance: "what does it cost" });
  assert.equal(first.error, "http_429");
  const second = await judge.evaluate({ utterance: "what does it cost" });
  assert.equal(second.isQuestion, 0.9);
  assert.equal(fetchImpl.calls.length, 2);
});

test("transport errors never leak the key", async () => {
  const fetchImpl = async () => {
    throw new Error(`connect failed with header Bearer ${KEY}`);
  };
  const logs = [];
  const judge = createJudge({ apiKey: KEY, features: "gate", fetchImpl, log: (e) => logs.push(e) });
  const v = await judge.evaluate({ utterance: "how much is it" });
  assert.ok(v.error);
  assert.ok(!v.error.includes(KEY));
  assert.ok(!JSON.stringify(logs).includes(KEY));
});

test("identical evaluations share one request (cache), different ones do not", async () => {
  const fetchImpl = fakeFetch(() => ok(0.2));
  const judge = createJudge({ apiKey: KEY, features: "gate", fetchImpl });
  await Promise.all([judge.evaluate({ utterance: "Yeah  OK" }), judge.evaluate({ utterance: "yeah ok" })]);
  await judge.evaluate({ utterance: "yeah ok", answeredFor: "something else" });
  assert.equal(fetchImpl.calls.length, 2);
});

test("close aborts in-flight requests and later calls resolve 'closed'", async () => {
  const fetchImpl = async (_url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const judge = createJudge({ apiKey: KEY, features: "gate", fetchImpl, timeoutMs: 5000 });
  const pending = judge.evaluate({ utterance: "how much is it" });
  await sleep(10);
  judge.close();
  assert.equal((await pending).error, "closed");
  assert.equal((await judge.evaluate({ utterance: "again" })).error, "closed");
});

test("empty utterances are not sent", async () => {
  const fetchImpl = fakeFetch(() => ok(0.9));
  const judge = createJudge({ apiKey: KEY, features: "gate", fetchImpl });
  assert.equal((await judge.evaluate({ utterance: "   " })).error, "empty");
  assert.equal(fetchImpl.calls.length, 0);
});

test("judgeOptionsFromEnv: off without TYPESAFE_API_KEY or JEV_JUDGMENTS; never borrows the LLM key", () => {
  assert.equal(judgeOptionsFromEnv({ LLM_API_KEY: "llm-secret", JEV_JUDGMENTS: "gate" }), null);
  assert.equal(judgeOptionsFromEnv({ TYPESAFE_API_KEY: KEY }), null);
  const opts = judgeOptionsFromEnv({ TYPESAFE_API_KEY: KEY, JEV_JUDGMENTS: "gate,rescue", JEV_TIMEOUT_MS: "9" });
  assert.equal(opts.apiKey, KEY);
  assert.equal(opts.baseUrl, "https://api.typesafe.ai");
  assert.equal(opts.model, "jev-latest");
  assert.equal(opts.timeoutMs, 50, "clamped to the 50 ms floor");
  assert.deepEqual(opts.features, { gate: true, rescue: true });
});

test("buildEngineConfig exposes judgeOptions from the environment", async () => {
  const { buildEngineConfig } = await import("../src/server/main.js");
  assert.equal(buildEngineConfig({}).judgeOptions, null);
  const config = buildEngineConfig({ TYPESAFE_API_KEY: KEY, JEV_JUDGMENTS: "rescue", LLM_API_KEY: "llm-secret" });
  assert.equal(config.judgeOptions.apiKey, KEY);
  assert.deepEqual(config.judgeOptions.features, { gate: false, rescue: true });
});
