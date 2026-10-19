import test from "node:test";
import assert from "node:assert/strict";
import { createAnswerer } from "../src/server/engines/answerer.js";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 2000, interval = 5, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

const OPTIONS = { provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m" };
const DONE = Symbol("done");
const PING = ": ping\n\n";
const encoder = new TextEncoder();
const contentEvent = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

/**
 * Replaces globalThis.fetch with a provider whose SSE body is driven by
 * `pull`. Each read calls `pull()`, which returns a content event (string),
 * DONE (the [DONE] event), a Uint8Array (raw bytes), or null (close the body).
 * `state` records when [DONE] was sent, when the body was cancelled or
 * aborted, and when it was closed; bytesAtCancel counts the bytes sent after
 * [DONE] when the body was cancelled.
 */
function fakeProvider(pull) {
  const state = {
    doneAt: null,
    cancelAt: null,
    abortedAt: null,
    closedAt: null,
    bytesAfterDone: 0,
    bytesAtCancel: null,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
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
          if (chunk === null) {
            state.closedAt = Date.now();
            stop = true;
            controller.close();
            return;
          }
          let bytes;
          if (chunk === DONE) {
            state.doneAt = Date.now();
            bytes = encoder.encode("data: [DONE]\n\n");
          } else if (typeof chunk === "string") {
            bytes = encoder.encode(chunk);
          } else {
            bytes = chunk;
          }
          if (state.doneAt != null && chunk !== DONE) state.bytesAfterDone += bytes.byteLength;
          controller.enqueue(bytes);
        },
        cancel() {
          stop = true;
          state.cancelAt ??= Date.now();
          state.bytesAtCancel = state.bytesAfterDone;
        },
      },
      { highWaterMark: 0 },
    );
    init.signal?.addEventListener(
      "abort",
      () => {
        stop = true;
        state.abortedAt ??= Date.now();
        controllerRef.error(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return {
    state,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

/**
 * A scripted SSE body: `pieces` as content deltas (`gapMs` apart), then
 * [DONE] when `done` is set, then whatever `afterDone` says: "ping" (a
 * keep-alive comment every 20 ms), "close", or "bytes" (16 KB chunks at once).
 * Without `done`, the body pings after the pieces and never sends [DONE].
 */
function scriptedBody({ pieces = [], gapMs = 0, done = true, afterDone = "ping" } = {}) {
  let next = 0;
  let doneSent = false;
  return fakeProvider(async () => {
    if (next < pieces.length) {
      if (gapMs) await sleep(gapMs);
      return contentEvent(pieces[next++]);
    }
    if (done && !doneSent) {
      doneSent = true;
      return DONE;
    }
    if (done && afterDone === "close") return null;
    if (done && afterDone === "bytes") return new Uint8Array(16 * 1024);
    await sleep(20);
    return PING;
  });
}

test("the answer ends at [DONE] even when the body keeps sending", async () => {
  const body = scriptedBody({ pieces: ["Use a queue to absorb bursts."] });
  try {
    const { streamAnswer } = createAnswerer(OPTIONS);
    const delivered = [];
    for await (const delta of streamAnswer({ question: "q" })) delivered.push(delta);
    const endedAt = Date.now();

    assert.ok(body.state.doneAt != null, "[DONE] was sent");
    assert.ok(endedAt - body.state.doneAt < 100, `answer ended ${endedAt - body.state.doneAt} ms after [DONE]`);
    assert.equal(body.state.cancelAt, null, "the body is not cancelled before the drain cap");
    assert.equal(delivered.join(""), "• Use a queue to absorb bursts.");

    await waitFor(() => body.state.cancelAt != null, { timeout: 2000, label: "drain cap" });
    const cancelledAfter = body.state.cancelAt - body.state.doneAt;
    assert.ok(cancelledAfter >= 900 && cancelledAfter <= 1500, `cancelled ${cancelledAfter} ms after [DONE]`);
  } finally {
    body.restore();
  }
});

test("a card answer ends at [DONE] even when the body keeps sending", async () => {
  const body = scriptedBody({ pieces: ["- VERDICT: use a queue.\n- HOW: a queue absorbs bursts."] });
  try {
    const { streamAnswer } = createAnswerer(OPTIONS);
    const delivered = [];
    for await (const delta of streamAnswer({ question: "q", cards: true })) delivered.push(delta);
    const endedAt = Date.now();

    assert.ok(body.state.doneAt != null, "[DONE] was sent");
    assert.ok(endedAt - body.state.doneAt < 100, `card ended ${endedAt - body.state.doneAt} ms after [DONE]`);
    assert.equal(body.state.cancelAt, null, "the body is not cancelled before the drain cap");
    const text = delivered.join("");
    assert.ok(text.includes("VERDICT: use a queue."), text);
    assert.ok(text.includes("HOW: a queue absorbs bursts."), text);

    await waitFor(() => body.state.cancelAt != null, { timeout: 2000, label: "drain cap" });
    const cancelledAfter = body.state.cancelAt - body.state.doneAt;
    assert.ok(cancelledAfter >= 900 && cancelledAfter <= 1500, `cancelled ${cancelledAfter} ms after [DONE]`);
  } finally {
    body.restore();
  }
});

test("a body that ends after [DONE] is read to its end and never cancelled", async () => {
  const body = scriptedBody({ pieces: ["Use a queue to absorb bursts."], afterDone: "close" });
  try {
    const { streamAnswer } = createAnswerer(OPTIONS);
    for await (const delta of streamAnswer({ question: "q" })) assert.ok(delta);

    await sleep(200);
    assert.equal(body.state.cancelAt, null, "a body that closed on its own is never cancelled");
    assert.ok(body.state.closedAt != null, "the drain pulled the body until it closed");
    assert.ok(body.state.closedAt >= body.state.doneAt, "the body closed after [DONE]");
  } finally {
    body.restore();
  }
});

test("the byte cap stops the drain", async () => {
  const body = scriptedBody({ pieces: ["Use a queue to absorb bursts."], afterDone: "bytes" });
  try {
    const { streamAnswer } = createAnswerer(OPTIONS);
    for await (const delta of streamAnswer({ question: "q" })) assert.ok(delta);

    await waitFor(() => body.state.cancelAt != null, { timeout: 900, label: "byte cap" });
    const cancelledAfter = body.state.cancelAt - body.state.doneAt;
    assert.ok(cancelledAfter < 500, `cancelled ${cancelledAfter} ms after [DONE], before the time cap`);
    const sent = body.state.bytesAtCancel;
    assert.ok(sent > 64 * 1024, `${sent} bytes were read before the cancel`);
    assert.ok(sent < 64 * 1024 + 3 * 16 * 1024, `${sent} bytes were read before the cancel`);
  } finally {
    body.restore();
  }
});

test("a consumer that stops before [DONE] cancels the body at once", async () => {
  const body = scriptedBody({
    pieces: Array.from({ length: 200 }, () => "Use a queue to absorb bursts. "),
    gapMs: 20,
    done: false,
  });
  try {
    const { streamAnswer } = createAnswerer(OPTIONS);
    let stoppedAt = 0;
    for await (const delta of streamAnswer({ question: "q" })) {
      assert.ok(delta);
      stoppedAt = Date.now();
      break;
    }
    await waitFor(() => body.state.cancelAt != null, { timeout: 200, label: "cancel" });
    assert.ok(body.state.cancelAt - stoppedAt < 50, `cancelled ${body.state.cancelAt - stoppedAt} ms after the consumer stopped`);
    assert.equal(body.state.doneAt, null, "[DONE] was never sent");
  } finally {
    body.restore();
  }
});

test("an abort before [DONE] reaches the body and ends the answer at once", async () => {
  const body = scriptedBody({
    pieces: Array.from({ length: 200 }, () => "Use a queue to absorb bursts. "),
    gapMs: 20,
    done: false,
  });
  try {
    const { streamAnswer } = createAnswerer(OPTIONS);
    const controller = new AbortController();
    let abortedAt = 0;
    let endedAt = 0;
    try {
      for await (const delta of streamAnswer({ question: "q", signal: controller.signal })) {
        assert.ok(delta);
        abortedAt = Date.now();
        controller.abort();
      }
    } catch {
      // the aborted body errors the read: the answer ends by throwing
    }
    endedAt = Date.now();

    assert.ok(endedAt - abortedAt < 50, `answer ended ${endedAt - abortedAt} ms after the abort`);
    const reached = body.state.abortedAt ?? body.state.cancelAt;
    assert.ok(reached != null, "the abort or a cancel reached the body");
    assert.ok(reached - abortedAt < 50, `the body saw the abort ${reached - abortedAt} ms later`);
    assert.equal(body.state.doneAt, null, "[DONE] was never sent");
  } finally {
    body.restore();
  }
});

test("the length cap cancels the body at once", async () => {
  const body = scriptedBody({ pieces: ["Use a queue to absorb bursts."], done: false });
  try {
    const { streamAnswer } = createAnswerer({ ...OPTIONS, maxAnswerChars: 5 });
    const delivered = [];
    let cut = null;
    for await (const delta of streamAnswer({ question: "q", onCut: (reason) => (cut = reason) })) {
      delivered.push(delta);
    }
    const endedAt = Date.now();

    await waitFor(() => body.state.cancelAt != null, { timeout: 200, label: "cancel" });
    assert.ok(Math.abs(body.state.cancelAt - endedAt) < 50, `cancel ${body.state.cancelAt - endedAt} ms from the cut`);
    assert.equal(cut, "length");
    assert.equal(delivered.join(""), "• Use a");
    assert.equal(body.state.doneAt, null, "[DONE] was never sent");
  } finally {
    body.restore();
  }
});

test("turn.done does not wait for the drain", async () => {
  const content = "It costs about forty dollars a seat.";
  const body = scriptedBody({ pieces: [content], afterDone: "ping" });
  const frames = [];
  const engine = createPipelineEngine({
    answerer: createAnswerer(OPTIONS),
    emit: (frame) => frames.push({ at: Date.now(), frame }),
    asr: { pushAudio() {}, finalize() { return true; }, close() {}, onTranscript() {} },
    answerCards: false,
    highlights: false,
  });
  try {
    engine.onSessionStart({ sessionId: "drain" });
    engine.onAnswerRequest({ utterance: "What does it cost?" });
    const done = await waitFor(() => frames.find((f) => f.frame.type === "turn.done"), {
      timeout: 1000,
      label: "turn.done",
    });

    assert.ok(body.state.doneAt != null, "[DONE] was sent");
    assert.ok(done.at - body.state.doneAt < 150, `turn.done ${done.at - body.state.doneAt} ms after [DONE]`);
    assert.equal(body.state.cancelAt, null, "turn.done goes out while the body is still being drained");
    assert.equal(done.frame.data.text, "• It costs about forty dollars a seat.");

    await waitFor(() => body.state.cancelAt != null, { timeout: 1500, label: "drain cap" });
  } finally {
    engine.dispose();
    body.restore();
  }
});
