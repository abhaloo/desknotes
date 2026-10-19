import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  INTERPRET_PROMPT,
  MAX_INTERPRETATION_CHARS,
  classifyKind,
  createVisionEngine,
  parseModelAnswer,
} from "../src/server/engines/vision.js";
import { hashImage } from "../src/vision/index.js";

const KINDS = new Set(["question", "code", "other"]);

/*
 * Provider resolution reads process.env when the engine is built, so every
 * test starts from a clean vision/LLM environment; the previous values are
 * restored afterwards and never leak into other files.
 */
const ENV_KEYS = [
  "VISION_PROVIDER",
  "VISION_BASE_URL",
  "VISION_API_KEY",
  "VISION_MODEL",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "DEEPSEEK_API_KEY",
];
let savedEnv = null;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  if (savedEnv === null) return;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  savedEnv = null;
});

/** Provider double: records the request and replies with the chat JSON. */
function serveAnswer({ kind = "question", solve = "model answer" } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind, solve }) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function hashFor(seed) {
  return hashImage(new Uint8Array([seed, seed + 1, seed + 2, seed + 3]));
}

function collect() {
  const frames = [];
  return { frames, emit: (frame) => frames.push(frame) };
}

test("vision engine returns the frozen result shape and emits screen.result", async () => {
  const engine = createVisionEngine({ log: () => {} });
  const { frames, emit } = collect();
  const hash = hashFor(1);
  const result = await engine.analyse(
    { command_id: "cmd-1", image_hash: hash, purpose: "context", origin: "manual" },
    { emit, sessionId: "s-1" },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.dedup, false);
  assert.ok(KINDS.has(result.kind), `unexpected kind ${result.kind}`);
  if (result.kind === "other") assert.equal(result.solve, null);
  else assert.equal(typeof result.solve, "string");
  if (typeof result.solve === "string") assert.ok(result.solve.length > 0);

  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "screen.result");
  assert.equal(frames[0].data.command_id, "cmd-1");
  assert.equal(frames[0].data.status, result.status);
  assert.equal(frames[0].data.kind, result.kind);
  assert.equal(frames[0].data.dedup, result.dedup);
  assert.equal(frames[0].data.solve, result.solve);
});

test("vision engine classifies deterministically for the same image_hash", async () => {
  const engine = createVisionEngine({ log: () => {} });
  const hash = hashFor(2);
  const first = await engine.analyse({ command_id: "a", image_hash: hash }, {});
  const again = await engine.analyse({ command_id: "b", image_hash: hash }, {});
  assert.equal(again.kind, first.kind);
  assert.equal(again.solve, first.solve);
});

test("vision engine short-circuits repeated image_hash with dedup:true", async () => {
  const engine = createVisionEngine({ log: () => {} });
  const hash = hashFor(3);
  const { frames, emit } = collect();
  const first = await engine.analyse({ command_id: "c1", image_hash: hash }, { emit });
  const second = await engine.analyse({ command_id: "c2", image_hash: hash }, { emit });

  assert.equal(first.dedup, false);
  assert.equal(second.dedup, true);
  assert.equal(second.kind, first.kind);
  assert.equal(second.solve, first.solve);
  assert.equal(engine.stats().hits, 1);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].data.dedup, true);
});

test("vision engine LRU bound is respected and evicted hashes are analysed again", async () => {
  const engine = createVisionEngine({ log: () => {}, maxEntries: 2 });
  const h1 = hashFor(10);
  const h2 = hashFor(11);
  const h3 = hashFor(12);

  await engine.analyse({ command_id: "1", image_hash: h1 }, {});
  await engine.analyse({ command_id: "2", image_hash: h2 }, {});
  await engine.analyse({ command_id: "3", image_hash: h3 }, {});
  assert.equal(engine.stats().size, 2);

  // h1 was evicted (h2 was touched most recently), so this is a fresh analysis.
  const replay = await engine.analyse({ command_id: "4", image_hash: h1 }, {});
  assert.equal(replay.dedup, false);
  assert.equal(engine.stats().size, 2);

  // The most recent entry is still deduped.
  const hit = await engine.analyse({ command_id: "5", image_hash: h1 }, {});
  assert.equal(hit.dedup, true);
});

test("vision engine derives the hash from raw bytes when image_hash is absent", async () => {
  const engine = createVisionEngine({ log: () => {} });
  const bytes = new Uint8Array([7, 7, 7]);
  const result = await engine.analyse({ command_id: "bytes", bytes }, {});
  assert.equal(result.status, "ok");
  assert.equal(engine.stats().size, 1);
  const again = await engine.analyse({ command_id: "bytes2", bytes }, {});
  assert.equal(again.dedup, true);
});

test("vision engine returns a typed failure when no hash and no bytes are available", async () => {
  const engine = createVisionEngine({ log: () => {} });
  const { frames, emit } = collect();
  const result = await engine.analyse({ command_id: "bad" }, { emit });
  assert.equal(result.status, "failed");
  // The `failure` field is a string tag; `solve` defaults to "not_requested".
  assert.equal(result.failure, "invalid_request");
  assert.equal(result.solve, "not_requested");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.command_id, "bad");
});

test("vision engine uses a custom provider hook when injected", async () => {
  const calls = [];
  const engine = createVisionEngine({
    log: () => {},
    provider: {
      name: "test-provider",
      analyse: async (request) => {
        calls.push(request);
        return { kind: "code", solve: "provider answer" };
      },
    },
  });
  const result = await engine.analyse(
    { command_id: "p1", image_hash: hashFor(20), purpose: "context" },
    { sessionId: "session-3" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "session-3");
  assert.equal(calls[0].imageHash, hashFor(20));
  assert.equal(result.kind, "code");
  // The provider's answer text travels in `summary`; `solve` is the enum.
  assert.equal(result.summary, "provider answer");
  assert.equal(result.solve, "not_requested");
});

test("unconfigured openai-compatible vision falls back to the mock classification", async () => {
  const engine = createVisionEngine({ log: () => {}, provider: "openai-compatible" });
  const result = await engine.analyse({ command_id: "u1", image_hash: hashFor(21) }, {});
  assert.equal(result.status, "ok");
  assert.ok(KINDS.has(result.kind));
});

test("classifyKind honours purpose/origin hints and stays hash-stable otherwise", () => {
  assert.equal(classifyKind(hashFor(30), "code", "manual"), "code");
  assert.equal(classifyKind(hashFor(30), "question", "manual"), "question");
  const hash = hashFor(31);
  assert.equal(classifyKind(hash, "context", "manual"), classifyKind(hash, "context", "manual"));
  assert.ok(KINDS.has(classifyKind(hash, "context", "manual")));
  for (let seed = 0; seed < 12; seed += 1) {
    const kind = classifyKind(hashFor(seed), "context", "manual");
    assert.ok(KINDS.has(kind));
  }
});

/* ------------------------- DeepSeek vision preset ------------------------ */

test("a bare DEEPSEEK_API_KEY auto-selects the DeepSeek vision endpoint", async () => {
  process.env.DEEPSEEK_API_KEY = "deepseek-key-0123456789";
  const provider = serveAnswer({ kind: "question", solve: "deepseek answer" });
  try {
    const logs = [];
    const engine = createVisionEngine({ log: (entry) => logs.push(entry) });
    const result = await engine.analyse({ command_id: "ds-a", bytes: JPEG, purpose: "context", origin: "manual" }, {});

    assert.equal(result.status, "ok");
    assert.equal(result.kind, "question");
    assert.equal(result.summary, "deepseek answer");
    assert.equal("stub" in result, false, "a model answer is not a stub");

    assert.equal(provider.calls.length, 1);
    const [{ url, init }] = provider.calls;
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(init.headers.authorization, "Bearer deepseek-key-0123456789");

    const body = JSON.parse(init.body);
    // DeepSeek's real id for V4.1 Flash; thinking off, or a 400-token reply is all reasoning.
    assert.equal(body.model, "deepseek-flash");
    assert.deepEqual(body.thinking, { type: "disabled" });
    const system = body.messages.find((message) => message.role === "system");
    const user = body.messages.find((message) => message.role === "user");
    assert.equal(system.content, INTERPRET_PROMPT, "stage 1 interprets with the fixed prompt");
    const textPart = user.content.find((part) => part.type === "text");
    const imagePart = user.content.find((part) => part.type === "image_url");
    assert.ok(textPart, "the prompt travels with the image");
    assert.match(textPart.text, /purpose=context/);
    assert.equal(imagePart.image_url.url, `data:image/jpeg;base64,${Buffer.from(JPEG).toString("base64")}`);
    assert.equal(logs.some((entry) => entry.type === "vision.provider_unconfigured"), false);
  } finally {
    provider.restore();
  }
});

test("explicit VISION_* settings override the DeepSeek preset", async () => {
  process.env.DEEPSEEK_API_KEY = "deepseek-key-0123456789";
  process.env.VISION_PROVIDER = "deepseek";
  process.env.VISION_BASE_URL = "https://vision.example.com/v1";
  process.env.VISION_MODEL = "vision-custom-model";
  process.env.VISION_API_KEY = "vision-explicit-key-0123";
  const provider = serveAnswer({ kind: "code", solve: "overridden answer" });
  try {
    const engine = createVisionEngine({ log: () => {} });
    const result = await engine.analyse({ command_id: "ds-b", bytes: JPEG }, {});
    assert.equal(result.status, "ok");
    assert.equal(result.kind, "code");

    assert.equal(provider.calls.length, 1);
    const [{ url, init }] = provider.calls;
    assert.equal(url, "https://vision.example.com/v1/chat/completions");
    assert.equal(init.headers.authorization, "Bearer vision-explicit-key-0123");
    assert.equal(JSON.parse(init.body).model, "vision-custom-model");
    assert.equal("thinking" in JSON.parse(init.body), false, "the DeepSeek switch is only sent to DeepSeek");
  } finally {
    provider.restore();
  }
});

test("engine options override the DeepSeek preset as well", async () => {
  process.env.DEEPSEEK_API_KEY = "deepseek-key-0123456789";
  const provider = serveAnswer({ kind: "other", solve: "option answer" });
  try {
    const engine = createVisionEngine({
      log: () => {},
      provider: "deepseek",
      baseUrl: "https://options.example.com/v1",
      model: "options-model",
      apiKey: "options-key-0123456789",
    });
    const result = await engine.analyse({ command_id: "ds-c", bytes: JPEG }, {});
    assert.equal(result.status, "ok");

    assert.equal(provider.calls.length, 1);
    const [{ url, init }] = provider.calls;
    assert.equal(url, "https://options.example.com/v1/chat/completions");
    assert.equal(init.headers.authorization, "Bearer options-key-0123456789");
    assert.equal(JSON.parse(init.body).model, "options-model");
  } finally {
    provider.restore();
  }
});

test("the DeepSeek key is never sent to a foreign vision origin", async () => {
  process.env.DEEPSEEK_API_KEY = "deepseek-key-0123456789";
  process.env.VISION_PROVIDER = "openai-compatible";
  process.env.VISION_BASE_URL = "https://vision.example.com/v1";
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    throw new Error("must not be called");
  };
  try {
    const logs = [];
    const engine = createVisionEngine({ log: (entry) => logs.push(entry) });
    const result = await engine.analyse({ command_id: "scope-1", bytes: JPEG }, {});
    assert.equal(result.status, "ok");
    assert.equal(fetched, 0, "no request may carry the DeepSeek key to a foreign origin");
    assert.ok(logs.some((entry) => entry.type === "vision.provider_unconfigured"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ---------------------------- stub honesty ------------------------------- */

test("mock analyses are marked stub:true and model analyses are not", async () => {
  const provider = serveAnswer({ kind: "question", solve: "real answer" });
  try {
    const mockEngine = createVisionEngine({ log: () => {} });
    const { frames, emit } = collect();
    const hash = hashFor(60);
    const mock = await mockEngine.analyse(
      { command_id: "stub-1", image_hash: hash, purpose: "context", origin: "manual" },
      { emit },
    );
    assert.equal(mock.status, "ok");
    assert.equal(mock.stub, true);
    assert.equal(frames[0].data.stub, true, "the emitted screen.result carries the stub flag");

    const replay = await mockEngine.analyse({ command_id: "stub-2", image_hash: hash }, {});
    assert.equal(replay.dedup, true);
    assert.equal(replay.stub, true, "a dedup replay of a stub stays a stub");

    process.env.VISION_PROVIDER = "openai-compatible";
    process.env.VISION_BASE_URL = "https://vision.example.com/v1";
    process.env.VISION_API_KEY = "vision-key-0123456789";
    const modelEngine = createVisionEngine({ log: () => {} });
    const model = await modelEngine.analyse({ command_id: "model-1", bytes: JPEG }, {});
    assert.equal(model.status, "ok");
    assert.equal(model.summary, "real answer");
    assert.equal("stub" in model, false, "a model answer never carries the stub flag");
  } finally {
    provider.restore();
  }
});

test("no configuration at all still uses the hash-bucket mock (no network)", async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    throw new Error("must not be called");
  };
  try {
    const engine = createVisionEngine({ log: () => {} });
    const hash = hashFor(61);
    const result = await engine.analyse(
      { command_id: "plain-1", image_hash: hash, purpose: "context", origin: "manual" },
      {},
    );
    assert.equal(result.status, "ok");
    assert.equal(result.kind, classifyKind(hash, "context", "manual"));
    assert.equal(result.stub, true);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ---------------------- stage 1: interpretation only ---------------------- */

test("the model reply is an interpretation: kind, title and a bounded description", async () => {
  const long = `Design a URL shortener. ${"Handle 10k writes per second. ".repeat(80)}`;
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const content = JSON.stringify({ kind: "question", title: "URL shortener design", interpretation: long });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const engine = createVisionEngine({
      log: () => {},
      provider: "openai-compatible",
      baseUrl: "https://vision.example.com/v1",
      apiKey: "vision-key-0123456789",
    });
    const result = await engine.analyse({ command_id: "i1", bytes: JPEG }, {});
    assert.equal(result.status, "ok");
    assert.equal(result.kind, "question");
    assert.equal(result.title, "URL shortener design");
    assert.ok(result.summary.startsWith("Design a URL shortener."));
    assert.ok(result.summary.length <= MAX_INTERPRETATION_CHARS, `summary is ${result.summary.length} chars`);
    assert.equal(result.solve, "not_requested");
    assert.equal(bodies[0].messages[0].content, INTERPRET_PROMPT);
    assert.match(INTERPRET_PROMPT, /word for word/);
    assert.match(INTERPRET_PROMPT, /Do not answer or solve anything/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a configured model that fails is a typed failure, never an invented stub reading", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("overloaded", { status: 503 });
  try {
    const logs = [];
    const engine = createVisionEngine({
      log: (entry) => logs.push(entry),
      provider: "openai-compatible",
      baseUrl: "https://vision.example.com/v1",
      apiKey: "vision-key-0123456789",
    });
    const { frames, emit } = collect();
    const result = await engine.analyse({ command_id: "f1", bytes: JPEG }, { emit });
    assert.equal(result.status, "failed");
    assert.equal(result.failure, "provider");
    assert.equal(result.summary, "");
    assert.equal("stub" in result, false);
    assert.equal(frames[0].data.status, "failed");
    assert.ok(logs.some((entry) => entry.type === "vision.error"));
    // Failures are not cached: the next try reaches the model again.
    assert.equal(engine.stats().size, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a reply cut off by the token cap still yields its interpretation", () => {
  const cut = '{"kind":"code","title":"Two sum","interpretation":"Python. def two_sum(nums, target):\n    seen = {}';
  assert.deepEqual(parseModelAnswer(cut), {
    kind: "code",
    title: "Two sum",
    interpretation: "Python. def two_sum(nums, target):\n    seen = {}",
  });
  // Older {"kind","solve"} replies and plain prose still parse.
  assert.deepEqual(parseModelAnswer('{"kind":"other","solve":"a dashboard"}'), { kind: "other", title: "", interpretation: "a dashboard" });
  assert.equal(parseModelAnswer("A slide about caching").interpretation, "A slide about caching");
});

test("the offline mock gives every kind a deterministic, non-empty reading", async () => {
  const engine = createVisionEngine({ log: () => {} });
  const seen = new Map();
  for (let seed = 0; seed < 24 && seen.size < 3; seed += 1) {
    const result = await engine.analyse({ command_id: `m${seed}`, image_hash: hashFor(100 + seed) }, {});
    assert.equal(result.status, "ok");
    assert.equal(result.stub, true);
    assert.ok(result.summary.length > 0 && result.title.length > 0);
    assert.match(result.summary, /^Stub screen reading/);
    seen.set(result.kind, result.summary);
  }
  assert.equal(seen.size, 3, "question, code and other all have a reading");
  const again = await createVisionEngine({ log: () => {} }).analyse({ command_id: "m-again", image_hash: hashFor(100) }, {});
  const first = await createVisionEngine({ log: () => {} }).analyse({ command_id: "m-first", image_hash: hashFor(100) }, {});
  assert.equal(again.summary, first.summary);
});
