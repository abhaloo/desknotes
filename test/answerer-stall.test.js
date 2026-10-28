import test from "node:test";
import assert from "node:assert/strict";
import * as answererModule from "../src/server/engines/answerer.js";
import { buildEngineConfig } from "../src/server/engines/config.js";

/**
 * A provider that goes silent mid-answer must not park the turn until the
 * user ends the session. The answerer watches the bytes it receives (any
 * bytes: content deltas, reasoning-only events, keep-alive comments) and
 * after `stallMs` of none it drops the request and fails the answer with a
 * `stalled` error the pipeline can retry. A caller's own abort is still an
 * abort, never a stall.
 */
const { createAnswerer } = answererModule;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OPTIONS = { provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m" };
const STALL_MS = 150;
/** How late a stall may be noticed past the budget (timer granularity, a loaded CI box). */
const SLACK_MS = 400;
const DONE = Symbol("done");
const HANG = Symbol("hang");
const encoder = new TextEncoder();
const contentEvent = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const reasoningEvent = (reasoning) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`;

/**
 * `pull()` answers a string (SSE bytes), DONE, HANG (never answer again) or
 * null (close). `headers: false` never answers the request at all;
 * `headersAfterMs` answers it late. `ignoreAbort`: the provider's pending
 * waits never settle when the request is aborted (a runtime or a transport
 * that does not fail a read in flight), so only the answerer's own clock can
 * end the answer. `json` answers with a non-streaming JSON body instead of SSE.
 */
function fakeProvider(pull, { headers = true, headersAfterMs = 0, ignoreAbort = false, json = false } = {}) {
  const state = { abortedAt: null, cancelAt: null, fetchedAt: null };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    state.fetchedAt = Date.now();
    if (!headers) {
      // The provider accepted the connection and never answers.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => {
            state.abortedAt ??= Date.now();
            if (!ignoreAbort) reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    if (headersAfterMs) await sleep(headersAfterMs);
    let controllerRef = null;
    let stop = false;
    const stream = new ReadableStream(
      {
        start(controller) {
          controllerRef = controller;
        },
        async pull(controller) {
          const chunk = await pull();
          if (stop) return;
          if (chunk === HANG) return new Promise(() => {});
          if (chunk === null) {
            stop = true;
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunk === DONE ? "data: [DONE]\n\n" : chunk));
        },
        cancel() {
          stop = true;
          state.cancelAt ??= Date.now();
        },
      },
      { highWaterMark: 0 },
    );
    init.signal?.addEventListener(
      "abort",
      () => {
        stop = true;
        state.abortedAt ??= Date.now();
        if (!ignoreAbort) controllerRef.error(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
    const contentType = json ? "application/json" : "text/event-stream";
    return new Response(stream, { status: 200, headers: { "content-type": contentType } });
  };
  return {
    state,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

/** A body that sends `pieces`, then what `then` says (HANG by default). */
function scripted(pieces, { then = HANG, gapMs = 0, ...provider } = {}) {
  let next = 0;
  let afterPieces = false;
  return fakeProvider(async () => {
    if (next < pieces.length) {
      if (gapMs) await sleep(gapMs);
      return pieces[next++];
    }
    if (typeof then === "function") return then();
    if (afterPieces) return HANG;
    afterPieces = true;
    return then;
  }, provider);
}

function answererWith(overrides = {}) {
  const logs = [];
  const answerer = createAnswerer({ ...OPTIONS, spokenFilter: false, stallMs: STALL_MS, log: (entry) => logs.push(entry), ...overrides });
  return { answerer, logs };
}

/** Drains `stream`; a stream still open after `limitMs` is reported as hung instead of parking the run. */
async function collect(stream, limitMs = 3_000) {
  const deltas = [];
  let error = null;
  let timer = null;
  const hung = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the stream was still open after ${limitMs} ms (${deltas.length} deltas)`)), limitMs);
  });
  try {
    await Promise.race([
      (async () => {
        for await (const delta of stream) deltas.push(delta);
      })(),
      hung,
    ]);
  } catch (err) {
    error = err;
  } finally {
    clearTimeout(timer);
  }
  return { deltas, error };
}

function assertStalled(error) {
  assert.ok(error, "the answer failed");
  assert.equal(error.code, "stalled");
  assert.equal(error.retryable, true, "a stall is worth one more attempt");
  assert.doesNotMatch(error.message, /abort/i, "the pipeline would read an abort as its own cancel and stay silent");
  assert.notEqual(error.name, "AbortError");
}

test("a provider that goes silent mid-answer stalls: the text so far, then a retryable `stalled` error", async () => {
  const body = scripted([contentEvent("Hello "), contentEvent("world")]);
  try {
    const { answerer, logs } = answererWith();
    const started = Date.now();
    const { deltas, error } = await collect(answerer.streamAnswer({ question: "q" }));
    const took = Date.now() - started;

    assert.deepEqual(deltas, ["Hello ", "world"]);
    assertStalled(error);
    assert.ok(took >= STALL_MS, `failed after ${took} ms, before the ${STALL_MS} ms budget`);
    assert.ok(took < STALL_MS + SLACK_MS, `failed after ${took} ms, long past the ${STALL_MS} ms budget`);
    assert.ok(body.state.abortedAt != null, "the provider request is dropped, not left open");
    const stalled = logs.find((entry) => entry.type === "answerer.stalled");
    assert.ok(stalled, "the stall is logged");
    assert.ok(stalled.after_ms >= STALL_MS, `after_ms ${stalled.after_ms}`);
    assert.equal(stalled.emitted, "Hello world".length);
  } finally {
    body.restore();
  }
});

test("a provider that never sends its response headers stalls the same way", async () => {
  const body = fakeProvider(null, { headers: false });
  try {
    const { answerer, logs } = answererWith();
    const started = Date.now();
    const { deltas, error } = await collect(answerer.streamAnswer({ question: "q" }));
    const took = Date.now() - started;

    assert.deepEqual(deltas, []);
    assertStalled(error);
    assert.ok(took >= STALL_MS && took < STALL_MS + SLACK_MS, `failed after ${took} ms`);
    assert.ok(body.state.abortedAt != null, "the pending request is aborted");
    assert.equal(logs.find((entry) => entry.type === "answerer.stalled")?.emitted, 0);
  } finally {
    body.restore();
  }
});

test("a provider that sends headers and then nothing stalls before its first token", async () => {
  const body = scripted([]);
  try {
    const { answerer } = answererWith();
    const { deltas, error } = await collect(answerer.streamAnswer({ question: "q" }));
    assert.deepEqual(deltas, []);
    assertStalled(error);
    assert.ok(body.state.abortedAt != null);
  } finally {
    body.restore();
  }
});

test("keep-alive comments and reasoning-only events are progress: a thinking model is not a stall", async () => {
  // Far longer than the budget in total, but never `STALL_MS` between two chunks.
  const quiet = [];
  for (let i = 0; i < 6; i += 1) quiet.push(": ping\n\n");
  for (let i = 0; i < 6; i += 1) quiet.push(reasoningEvent(`step ${i} `));
  const body = scripted([...quiet, contentEvent("Answer."), DONE], { gapMs: 60, then: null });
  try {
    const { answerer, logs } = answererWith();
    const { deltas, error } = await collect(answerer.streamAnswer({ question: "q" }));
    assert.equal(error, null, `failed: ${error?.message}`);
    assert.deepEqual(deltas, ["Answer."]);
    assert.equal(logs.filter((entry) => entry.type === "answerer.stalled").length, 0);
    assert.equal(body.state.abortedAt, null, "a live stream is never dropped");
  } finally {
    body.restore();
  }
});

test("the response headers are progress: slow headers and then a slow first byte are two gaps, not one", async () => {
  // Each wait is under the budget; only from the start of the request are
  // they over it. A watchdog that forgot to count the headers would drop a
  // live stream here.
  const late = Math.round(STALL_MS * 0.7);
  const body = scripted([contentEvent("Late "), contentEvent("but alive."), DONE], { headersAfterMs: late, gapMs: late, then: null });
  try {
    const { answerer, logs } = answererWith();
    const { deltas, error } = await collect(answerer.streamAnswer({ question: "q" }));
    assert.equal(error, null, `failed: ${error?.message}`);
    assert.equal(deltas.join(""), "Late but alive.");
    assert.equal(body.state.abortedAt, null, "a live stream is never dropped");
    assert.equal(logs.filter((entry) => entry.type === "answerer.stalled").length, 0);
  } finally {
    body.restore();
  }
});

test("a provider whose pending waits ignore the abort still stalls on time: headers, body, and a JSON body", async () => {
  // The answerer cannot rely on the runtime failing a read in flight when
  // the request is aborted: its own clock must end the wait.
  const cases = [
    ["headers", () => fakeProvider(null, { headers: false, ignoreAbort: true })],
    ["body", () => scripted([contentEvent("Hello ")], { ignoreAbort: true })],
    ["json", () => scripted([], { ignoreAbort: true, json: true })],
  ];
  for (const [label, open] of cases) {
    const body = open();
    try {
      const { answerer } = answererWith();
      const started = Date.now();
      const { error } = await collect(answerer.streamAnswer({ question: "q" }));
      const took = Date.now() - started;
      assert.ok(error, `${label}: the answer failed`);
      assert.equal(error.code, "stalled", `${label}: ${error.message}`);
      assert.ok(took >= STALL_MS && took < STALL_MS + SLACK_MS, `${label}: failed after ${took} ms`);
      assert.ok(body.state.abortedAt != null, `${label}: the request was still dropped`);
    } finally {
      body.restore();
    }
  }
});

test("a stream with gaps under the budget ends at [DONE] as before", async () => {
  const body = scripted([contentEvent("One "), contentEvent("two "), contentEvent("three."), DONE], { gapMs: 50, then: null });
  try {
    const { answerer } = answererWith();
    const { deltas, error } = await collect(answerer.streamAnswer({ question: "q" }));
    assert.equal(error, null);
    assert.equal(deltas.join(""), "One two three.");
    assert.equal(body.state.abortedAt, null);
  } finally {
    body.restore();
  }
});

test("the caller's own abort during silence is an abort, not a stall", async () => {
  const body = scripted([contentEvent("Hello ")]);
  try {
    const { answerer, logs } = answererWith({ stallMs: 2_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const started = Date.now();
    const { deltas, error } = await collect(answerer.streamAnswer({ question: "q", signal: controller.signal }));
    assert.deepEqual(deltas, ["Hello "]);
    assert.ok(error, "the stream ends on the abort");
    assert.notEqual(error.code, "stalled");
    assert.ok(error.name === "AbortError" || /abort/i.test(error.message), `got ${error.name}: ${error.message}`);
    assert.ok(Date.now() - started < 1_000, "the abort is not held until the stall budget");
    assert.equal(logs.filter((entry) => entry.type === "answerer.stalled").length, 0);
  } finally {
    body.restore();
  }
});

test("a stall reaches the caller through the card check: after the VERDICT line, and while the first line is still held", async () => {
  // After the first line: what was shown, then the error.
  let body = scripted([contentEvent("- VERDICT: yes, it fits.\n- HOW: it plugs"), contentEvent(" into")]);
  try {
    const { answerer } = answererWith({ spokenFilter: true });
    const { deltas, error } = await collect(answerer.streamAnswer({ question: "q", cards: true }));
    assertStalled(error);
    assert.ok(deltas.join("").includes("VERDICT: yes, it fits."), deltas.join(""));
    assert.ok(body.state.abortedAt != null);
  } finally {
    body.restore();
  }
  // While the first line is still undecided (it may yet become a VERDICT line): nothing shown, still the error, and no card retry.
  body = scripted([contentEvent("- VERD")]);
  try {
    const { answerer, logs } = answererWith({ spokenFilter: true });
    const { deltas, error } = await collect(answerer.streamAnswer({ question: "q", cards: true }));
    assertStalled(error);
    assert.deepEqual(deltas, []);
    assert.equal(logs.filter((entry) => entry.type === "answerer.card_retry").length, 0, "a stall is not a missing VERDICT line");
  } finally {
    body.restore();
  }
});

test("the stall budget defaults to 8 s and ANSWER_STALL_MS sets it", () => {
  assert.equal(answererModule.DEFAULT_STALL_MS, 8_000);
  const env = { COPILOT_MODE: "demo", ANSWER_PROVIDER: "mock" };
  assert.equal(buildEngineConfig({ ...env }).answererOptions.stallMs, undefined, "unset: the answerer's default");
  assert.equal(buildEngineConfig({ ...env, ANSWER_STALL_MS: "5000" }).answererOptions.stallMs, 5_000);
  assert.equal(buildEngineConfig({ ...env, ANSWER_STALL_MS: "0" }).answererOptions.stallMs, undefined);
  assert.equal(buildEngineConfig({ ...env, ANSWER_STALL_MS: "soon" }).answererOptions.stallMs, undefined);
});
