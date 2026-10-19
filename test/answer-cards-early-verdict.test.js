import test from "node:test";
import assert from "node:assert/strict";
import { CARD_RETRY_NOTE, createAnswerer } from "../src/server/engines/answerer.js";
import { isVerdictLine, verdictLineState } from "../src/shared/answer-cards.js";

/**
 * A streaming chat endpoint that serves one SSE event per read. `pauseBefore`
 * maps a request index to a piece index: that request's stream waits before
 * sending that piece until `release()`. `served[k]` counts the provider pieces
 * request k has sent so far; `servedBeforeRequest[k]` holds the served counts
 * of the earlier requests at the moment request k was made.
 */
function pacedChat(responses, { pauseBefore = {} } = {}) {
  const bodies = [];
  const served = [];
  const servedBeforeRequest = [];
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const encoder = new TextEncoder();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const call = bodies.length;
    bodies.push(JSON.parse(init.body));
    servedBeforeRequest.push([...served]);
    served.push(0);
    const pieces = responses[call] ?? [];
    const events = [
      ...pieces.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
      "data: [DONE]\n\n",
    ];
    let next = 0;
    const stream = new ReadableStream(
      {
        async pull(controller) {
          if (next >= events.length) {
            controller.close();
            return;
          }
          if (next === pauseBefore[call]) await gate;
          controller.enqueue(encoder.encode(events[next]));
          if (next < pieces.length) served[call] += 1;
          next += 1;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return {
    bodies,
    served,
    servedBeforeRequest,
    release: () => open(),
    restore: () => {
      open();
      globalThis.fetch = realFetch;
    },
  };
}

function chatAnswerer(log) {
  return createAnswerer({ provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m", log });
}

/** The value of a promise, or a rejection when it has not settled within `ms` (the stream is stuck). */
function within(promise, ms = 2000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no chunk within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The text of every chunk the iterator still yields. */
async function drain(iterator) {
  let text = "";
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) text += next.value;
  return text;
}

test("verdictLineState: yes, maybe and no for a first line so far", () => {
  const cases = {
    yes: ["• VERDICT:", "• VERDICT: use a queue", "- verdict :", "**VERDICT:**", "• **VERDICT:** x", "  •  verdict:"],
    maybe: ["", " ", "•", "• ", "-", "• *", "• **", "**", "• V", "• VERD", "• verdict", "• VERDICT ", "• ** VERDI"],
    no: ["• The answer", "• HOW: x", "• *V", "• VERDICTS:", "• VERDICT,", "1. VERDICT:", "• • VERDICT:"],
  };
  for (const [state, lines] of Object.entries(cases)) {
    for (const line of lines) {
      assert.equal(verdictLineState(line), state, JSON.stringify(line));
      assert.equal(verdictLineState(line) === "yes", isVerdictLine(line), JSON.stringify(line));
    }
  }
});

test("a VERDICT line is shown as soon as its label is complete, before line 2 starts", async () => {
  const pieces = ["- VERDICT:", " use a queue.", "\n", "- HOW: a queue absorbs bursts.", "\n- TRADE-OFF: more parts."];
  const chat = pacedChat([pieces], { pauseBefore: { 0: 3 } });
  try {
    const stream = chatAnswerer().streamAnswer({ question: "How to handle bursts?", cards: true })[Symbol.asyncIterator]();
    const first = await within(stream.next());
    assert.equal(chat.served[0], 1, "the first chunk came right after piece 0, while line 2 was still held back");
    assert.ok(first.value.startsWith("• VERDICT:"), JSON.stringify(first.value));
    chat.release();
    const delivered = first.value + (await drain(stream));
    assert.equal(delivered, "• VERDICT: use a queue.\n• HOW: a queue absorbs bursts.\n• TRADE-OFF: more parts.");
    assert.equal(chat.bodies.length, 1);
  } finally {
    chat.restore();
  }
});

test("a highlighted VERDICT label is shown as soon as it is complete", async () => {
  const chat = pacedChat([["- **VERDICT:**", " use a queue.\n- HOW: x."]]);
  try {
    const stream = chatAnswerer().streamAnswer({ question: "How to handle bursts?", cards: true, highlights: true })[Symbol.asyncIterator]();
    const first = await within(stream.next());
    // The filter releases a key phrase only when the character after its closing ** arrives, so the
    // label goes out with piece 1 rather than piece 0.
    assert.equal(chat.served[0], 2, "the first chunk came as soon as the highlighted label was complete");
    assert.ok(first.value.startsWith("• **VERDICT:**"), JSON.stringify(first.value));
    const delivered = first.value + (await drain(stream));
    assert.equal(delivered, "• **VERDICT:** use a queue.\n• HOW: x.");
    assert.equal(chat.bodies.length, 1);
  } finally {
    chat.restore();
  }
});

test("attempt 0 with a non-VERDICT first line retries before its newline, and none of it is shown", async () => {
  const attempt0 = ["- Clarifying", " the requirements first", " and more", "\n- Scale: big."];
  const attempt1 = ["- VERDICT: start with ingest.\n- HOW: a queue."];
  const chat = pacedChat([attempt0, attempt1]);
  const logs = [];
  try {
    let delivered = "";
    for await (const delta of chatAnswerer((e) => logs.push(e)).streamAnswer({ question: "How to scale?", cards: true })) {
      delivered += delta;
    }
    assert.equal(chat.bodies.length, 2);
    assert.equal(chat.servedBeforeRequest[1][0], 1, "the retry began right after piece 0, long before the newline (piece 3)");
    assert.ok(chat.bodies[1].messages[1].content.endsWith(CARD_RETRY_NOTE));
    assert.equal(delivered, "• VERDICT: start with ingest.\n• HOW: a queue.");
    assert.ok(logs.some((l) => l.type === "answerer.card_retry" && l.reason === "no_verdict"));
  } finally {
    chat.restore();
  }
});

test("attempt 1 with a non-VERDICT first line is held until the line is complete, as before", async () => {
  const chat = pacedChat([["- Nope here\n- x"], ["- Second", " attempt line", "\n- Line 2"]]);
  try {
    const stream = chatAnswerer().streamAnswer({ question: "How to scale?", cards: true })[Symbol.asyncIterator]();
    const first = await within(stream.next());
    assert.equal(chat.bodies.length, 2);
    assert.equal(chat.served[1], 3, "the first line is shown only once its newline piece (index 2) is served");
    // The filter holds a trailing digit until the next character, so "2" follows in the rest of the answer.
    assert.equal(first.value, "• Second attempt line\n• Line");
    assert.equal(first.value + (await drain(stream)), "• Second attempt line\n• Line 2");
  } finally {
    chat.restore();
  }
});

test("a first line that is still a maybe when its newline arrives is retried, as before", async () => {
  const chat = pacedChat([["- Verd\n- x"], ["- VERDICT: use a queue.\n- HOW: x."]]);
  try {
    let delivered = "";
    for await (const delta of chatAnswerer().streamAnswer({ question: "How to handle bursts?", cards: true })) {
      delivered += delta;
    }
    assert.equal(chat.bodies.length, 2);
    assert.equal(delivered, "• VERDICT: use a queue.\n• HOW: x.");
  } finally {
    chat.restore();
  }
});
