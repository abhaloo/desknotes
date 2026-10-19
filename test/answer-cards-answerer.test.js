import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CARD_HIGHLIGHT_RULE,
  CARD_RETRY_NOTE,
  CARD_RULE,
  DEFAULT_SYSTEM_PROMPT,
  CARD_REMINDER,
  DETAIL_CARD_RULE,
  HIGHLIGHT_RULE,
  TECHNICAL_CARD_PROMPT,
  createAnswerer,
  systemMessage,
} from "../src/server/engines/answerer.js";
import { CARD_LIMITS } from "../src/shared/answer-cards.js";
import { CONTINUATION } from "../src/server/engines/card-line-cap.js";

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(here, "fixtures", "highlights-off-baseline.json"), "utf8"));

/** A streaming chat endpoint that sends pieces as SSE deltas and records each request body and stream cancellations. */
function fakeChat(responses) {
  const bodies = [];
  const cancelled = [];
  let callIndex = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const callIdx = callIndex++;
    const pieces = typeof responses === "function"
      ? responses(callIdx)
      : (Array.isArray(responses) && Array.isArray(responses[0]) ? (responses[callIdx] ?? []) : responses);

    const sseChunks = pieces.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    sseChunks.push("data: [DONE]\n\n");

    const encoder = new TextEncoder();
    let pushIdx = 0;

    const stream = new ReadableStream({
      pull(controller) {
        if (pushIdx < sseChunks.length) {
          controller.enqueue(encoder.encode(sseChunks[pushIdx++]));
        } else {
          controller.close();
        }
      },
      cancel(reason) {
        cancelled.push({ callIndex: callIdx, reason });
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return {
    bodies,
    cancelled,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

test("off: systemMessage and the request body are byte-identical", async () => {
  assert.equal(BASELINE.prompts.length, 7);
  for (const { args, system } of BASELINE.prompts) {
    const [prompt, context, mode, options] = args;
    assert.equal(systemMessage(prompt, context, mode, { ...options, card: null }), system, JSON.stringify(args));
  }

  const pieces = ["- First line.\n", "- Second line."];
  const chatWithout = fakeChat(pieces);
  let textWithout = "";
  try {
    const answerer = createAnswerer({ provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m" });
    for await (const delta of answerer.streamAnswer({ question: "Tell me something" })) textWithout += delta;
  } finally {
    chatWithout.restore();
  }

  const chatWithFalse = fakeChat(pieces);
  let textWithFalse = "";
  try {
    const answerer = createAnswerer({ provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m" });
    for await (const delta of answerer.streamAnswer({ question: "Tell me something", cards: false })) textWithFalse += delta;
  } finally {
    chatWithFalse.restore();
  }

  assert.deepEqual(chatWithFalse.bodies, chatWithout.bodies);
  assert.equal(textWithFalse, textWithout);
});

test("default card: the rule follows the base prompt, no HIGHLIGHT_RULE", () => {
  assert.equal(systemMessage(undefined, "", "spoken", { card: "default" }), `${DEFAULT_SYSTEM_PROMPT}\n\n${CARD_RULE}`);
  const withHighlights = systemMessage(undefined, "", "spoken", { card: "default", highlights: true });
  assert.ok(withHighlights.endsWith(`${CARD_RULE}\n\n${CARD_HIGHLIGHT_RULE}`));
  assert.equal(withHighlights.includes(HIGHLIGHT_RULE), false);
});

test("detail card for a question that asks for specifics", async () => {
  const pieces = ["- VERDICT: direct answer.\n- TRADE-OFF: none."];
  const chat = fakeChat(pieces);
  try {
    const answerer = createAnswerer({ provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m" });
    for await (const _ of answerer.streamAnswer({
      question: "Walk me through exactly how a sliding window limiter works, step by step.",
      cards: true,
    })) {
      // consume
    }
    assert.equal(chat.bodies.length, 1);
    const system = chat.bodies[0].messages[0].content;
    assert.ok(system.includes(DETAIL_CARD_RULE), "system message must contain DETAIL_CARD_RULE");
    assert.equal(system.includes(CARD_RULE), false, "system message must not contain CARD_RULE");
  } finally {
    chat.restore();
  }
});

test("a turn started by a screen capture gets a detail card; a later turn that only carries the screen does not", async () => {
  const pieces = ["- VERDICT: the bug is on line 3.\n- TRADE-OFF: none."];
  const systemFor = async (screen) => {
    const chat = fakeChat(pieces);
    try {
      const answerer = createAnswerer({ provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m" });
      for await (const _ of answerer.streamAnswer({ question: "What do you think?", context: "SCREEN:\nS", screen, cards: true })) {
        // consume
      }
      return chat.bodies[0].messages[0].content;
    } finally {
      chat.restore();
    }
  };
  const capture = await systemFor("capture");
  assert.ok(capture.includes(DETAIL_CARD_RULE), "the capture turn answers the screen in detail");
  const later = await systemFor("context");
  assert.ok(later.includes(CARD_RULE) && !later.includes(DETAIL_CARD_RULE), "a later turn is a default card");
});

test("technical mode with a card uses the technical card prompt", () => {
  const msg = systemMessage(undefined, "", "technical", { card: "default" });
  assert.ok(msg.startsWith(TECHNICAL_CARD_PROMPT));
  assert.equal(msg.includes("three hundred and fifty"), false);
});

test("screen turn order: section 4, card rule, then the Context rules", () => {
  const screen = systemMessage(undefined, "SCREEN:\nS", "spoken", {
    screenUse: "capture",
    screenSection: "Section four.",
    card: "default",
  });
  assert.ok(screen.indexOf("Section four.") < screen.indexOf(CARD_RULE));
  assert.ok(screen.indexOf(CARD_RULE) < screen.indexOf("SCREEN in the Context below"));
  assert.ok(screen.endsWith("Context:\nSCREEN:\nS"));
});

test("a VERDICT card is streamed once, shown as soon as its first line starts with the label", async () => {
  const pieces = ["- VERDICT: use ", "a queue.\n- HOW: a", " queue absorbs bursts."];
  const chat = fakeChat(pieces);
  const chunks = [];
  try {
    const answerer = createAnswerer({ provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m" });
    for await (const delta of answerer.streamAnswer({ question: "How to handle bursts?", cards: true })) {
      chunks.push(delta);
    }
    assert.equal(chat.bodies.length, 1);
    assert.equal(chunks.join(""), "• VERDICT: use a queue.\n• HOW: a queue absorbs bursts.");
    assert.equal(chunks[0], "• VERDICT: use");
  } finally {
    chat.restore();
  }
});

test("a runaway is cut at the budget and the request is cancelled", async () => {
  // Long enough that the look for a late TRADE-OFF line gives up.
  const total = Math.max(CARD_LIMITS.lines, CARD_LIMITS.detailLines) + 200;
  const pieces = ["- VERDICT: line 1\n", ...Array.from({ length: total - 1 }, (_, i) => `- LINE: line ${i + 2}\n`)];
  const chatDefault = fakeChat(pieces);
  const logsDefault = [];
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: "https://llm.test/v1",
      apiKey: "k",
      model: "m",
      log: (e) => logsDefault.push(e),
    });
    let deliveredDefault = "";
    for await (const delta of answerer.streamAnswer({ question: "How to handle bursts?", cards: true })) {
      deliveredDefault += delta;
    }
    const lines = deliveredDefault.trim().split("\n");
    assert.equal(lines.length, CARD_LIMITS.lines);
    assert.ok(chatDefault.cancelled.length > 0, "request body stream was cancelled");
    assert.ok(logsDefault.some((l) => l.type === "answerer.card_cut"), "logged answerer.card_cut");
  } finally {
    chatDefault.restore();
  }

  const chatDetail = fakeChat(pieces);
  const logsDetail = [];
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: "https://llm.test/v1",
      apiKey: "k",
      model: "m",
      log: (e) => logsDetail.push(e),
    });
    let deliveredDetail = "";
    for await (const delta of answerer.streamAnswer({
      question: "Walk me through step by step how to handle bursts?",
      cards: true,
    })) {
      deliveredDetail += delta;
    }
    const lines = deliveredDetail.trim().split("\n");
    assert.equal(lines.length, CARD_LIMITS.detailLines);
    assert.ok(chatDetail.cancelled.length > 0, "request body stream was cancelled");
    assert.ok(logsDetail.some((l) => l.type === "answerer.card_cut"), "logged answerer.card_cut");
  } finally {
    chatDetail.restore();
  }
});

test("no VERDICT line: asked again once, first attempt never shown", async () => {
  const call1 = ["1. Clarifying requirements\n- Scale: how many?"];
  const call2 = ["- VERDICT: start with the ingest path.\n- HOW: a queue."];
  const chat = fakeChat([call1, call2]);
  const logs = [];
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: "https://llm.test/v1",
      apiKey: "k",
      model: "m",
      log: (e) => logs.push(e),
    });
    let delivered = "";
    for await (const delta of answerer.streamAnswer({ question: "How to scale?", cards: true })) {
      delivered += delta;
    }
    assert.equal(chat.bodies.length, 2);
    assert.ok(chat.bodies[1].messages[1].content.endsWith(CARD_RETRY_NOTE));
    assert.equal(delivered, "• VERDICT: start with the ingest path.\n• HOW: a queue.");
    assert.equal(delivered.includes("Clarifying"), false);
    assert.ok(logs.some((l) => l.type === "answerer.card_retry" && l.reason === "no_verdict"));
  } finally {
    chat.restore();
  }
});

test("a second answer without VERDICT is shown as it is, within the budget", async () => {
  const call1 = ["1. First attempt\n- Line 2\n"];
  const call2 = [
    "1. Second attempt\n",
    "- Line 2\n",
    "- Line 3\n",
    "- Line 4\n",
    "- Line 5\n",
    "- Line 6\n",
    "- Line 7\n",
  ];
  const chat = fakeChat([call1, call2]);
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: "https://llm.test/v1",
      apiKey: "k",
      model: "m",
    });
    let delivered = "";
    for await (const delta of answerer.streamAnswer({ question: "How to scale?", cards: true })) {
      delivered += delta;
    }
    assert.equal(chat.bodies.length, 2);
    const lines = delivered.trim().split("\n");
    assert.ok(lines.length <= CARD_LIMITS.lines);
    assert.ok(delivered.includes("Second attempt"));
    assert.equal(delivered.includes("First attempt"), false);
  } finally {
    chat.restore();
  }
});

test("highlights with a card: every line keeps the mark of its main point, one per line", async () => {
  const pieces = ["- VERDICT: click **Go Live** now.\n- HOW: press **Start**, then **Share**.\n- EXAMPLE: the **home page** button.\n- TRADE-OFF: one **session at a time**."];
  const chat = fakeChat(pieces);
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: "https://llm.test/v1",
      apiKey: "k",
      model: "m",
    });
    let delivered = "";
    for await (const delta of answerer.streamAnswer({
      question: "How to start?",
      cards: true,
      highlights: true,
    })) {
      delivered += delta;
    }
    assert.equal(
      delivered,
      "• VERDICT: click **Go Live** now.\n• HOW: press **Start**, then Share.\n• EXAMPLE: the **home page** button.\n• TRADE-OFF: one **session at a time**.",
    );
  } finally {
    chat.restore();
  }
});

test("code in a detail card stays code", async () => {
  const pieces = ["- VERDICT: use a map.\n```python\ndef f(a, b):\n    return a - b\n```\n- TRADE-OFF: memory."];
  const chat = fakeChat(pieces);
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible",
      baseUrl: "https://llm.test/v1",
      apiKey: "k",
      model: "m",
    });
    let delivered = "";
    for await (const delta of answerer.streamAnswer({
      question: "Can you write the code for two-sum?",
      cards: true,
    })) {
      delivered += delta;
    }
    assert.equal(
      delivered,
      "• VERDICT: use a map.\n```python\ndef f(a, b):\n    return a - b\n```\n• TRADE-OFF: memory.",
    );
  } finally {
    chat.restore();
  }
});

test("the mock provider ignores cards", async () => {
  const answerer = createAnswerer();
  const withCards = await answerer.answerOnce({ question: "Q", cards: true });
  const withoutCards = await answerer.answerOnce({ question: "Q" });
  assert.equal(withCards, withoutCards);
});

/** One card answer through a fake chat; returns the request bodies, the delivered text and the log. */
async function cardAnswer(question, responses) {
  const chat = fakeChat(responses);
  const logs = [];
  const cuts = [];
  try {
    const answerer = createAnswerer({ provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m", log: (e) => logs.push(e) });
    let delivered = "";
    for await (const delta of answerer.streamAnswer({ question, cards: true, onCut: (reason) => cuts.push(reason) })) delivered += delta;
    return { bodies: chat.bodies, delivered, logs, cuts };
  } finally {
    chat.restore();
  }
}

test("the card rule covers every part the question names in connected sentences, with no arrows", () => {
  assert.match(CARD_RULE, /Then one line for each part the prospect asks about, in the order they ask/);
  assert.match(CARD_RULE, /one full sentence of 20 words or fewer that follows from the line before it/);
  assert.match(CARD_RULE, /Never use arrows or chains of symbols/);
  assert.match(CARD_RULE, /each with a short uppercase label that names the part/);
  assert.match(CARD_RULE, /For an objection, acknowledge the concern in the VERDICT line, then say how the product handles it/);
  assert.doesNotMatch(CARD_RULE, /opening move/, "a walk-through is covered, not paged");
  assert.doesNotMatch(CARD_RULE, /exact numbers/, "estimates are allowed");
  assert.doesNotMatch(CARD_RULE, /→|->/, "the example has no arrows");
});

test("the default card keeps the question's constraints and the exact technical names it needs", () => {
  assert.match(CARD_RULE, /one line for each part the prospect asks about, in the order they ask/);
  assert.match(CARD_RULE, /Prices, discounts, features, integrations, certifications, customer names and results must come from the Context or the question/);
  assert.doesNotMatch(CARD_RULE, /code block/, "the default card has no code block rule");
  assert.match(DETAIL_CARD_RULE, /When the question asks for code or a configuration, write the VERDICT line, then the complete code in one fenced code block/);
});

test("both cards need measured figures to come from the Context or the question", () => {
  for (const rule of [CARD_RULE, DETAIL_CARD_RULE]) {
    assert.match(rule, /customer names and results must come from the Context or the question/);
    assert.match(rule, /When they don't, say (?:what the answer depends on|who can confirm it)/);
  }
});

test("the detail rule uses the same connected sentences and keeps its worked example", () => {
  assert.match(DETAIL_CARD_RULE, /one full sentence of 20 words or fewer that follows from the line before it/);
  assert.match(DETAIL_CARD_RULE, /Never use arrows or chains of symbols/);
  assert.match(DETAIL_CARD_RULE, /Split a long point into two lines/);
  assert.match(DETAIL_CARD_RULE, /Example detail card, for "What would pricing look like for fifty reps, and is there an annual discount\?", when the Context has no price list:/);
  assert.equal(CARD_REMINDER, "Card: one connected sentence per line, 20 words or fewer, no arrows.");
});

test("every card repeats the line rule at the end of the user message", async () => {
  const card = ["- VERDICT: yes.\n- TRADE-OFF: none."];
  const detail = await cardAnswer("Walk me through exactly how it works, step by step.", card);
  assert.ok(detail.bodies[0].messages[1].content.endsWith(`\n\n${CARD_REMINDER}`));
  const general = await cardAnswer("Why Kafka over RabbitMQ?", card);
  assert.ok(general.bodies[0].messages[1].content.endsWith(`\n\n${CARD_REMINDER}`));
});

test("on a retry the retry note follows the reminder", async () => {
  const { bodies } = await cardAnswer("Walk me through exactly how it works.", [["1. Clarifying\n- x"], ["- VERDICT: yes.\n- TRADE-OFF: none."]]);
  assert.equal(bodies.length, 2);
  assert.ok(bodies[1].messages[1].content.endsWith(`${CARD_REMINDER}\n\n${CARD_RETRY_NOTE}`));
});

test("a card line past CARD_LIMITS.lineWords continues on the next line at a clause break, and nothing is cut", async () => {
  const head = Array.from({ length: CARD_LIMITS.lineWords - 6 }, (_, i) => `w${i + 1}`).join(" ");
  const tail = Array.from({ length: 20 }, (_, i) => `x${i + 1}`).join(" ");
  const { delivered, logs, cuts } = await cardAnswer("Why Kafka over RabbitMQ?", [`- VERDICT: use Kafka.\n- HOW: ${head}, ${tail}.\n- TRADE-OFF: cost.`]);
  assert.equal(delivered, `• VERDICT: use Kafka.\n• HOW: ${head},\n${CONTINUATION}${tail}.\n• TRADE-OFF: cost.`);
  assert.ok(logs.some((l) => l.type === "answerer.card_line_wrap" && l.lines === 1), JSON.stringify(logs));
  assert.deepEqual(cuts, []);
});

test("a card line longer than CARD_LIMITS.lineSegments lines is cut, and onCut says so", async () => {
  const long = Array.from({ length: CARD_LIMITS.lineWords * (CARD_LIMITS.lineSegments + 1) }, (_, i) => `w${i + 1}`).join(" ");
  const { delivered, logs, cuts } = await cardAnswer("Why Kafka over RabbitMQ?", [`- VERDICT: use Kafka.\n- HOW: ${long}\n- TRADE-OFF: cost.`]);
  const lines = delivered.split("\n");
  assert.equal(lines.length, 2 + CARD_LIMITS.lineSegments);
  assert.ok(lines[CARD_LIMITS.lineSegments].endsWith("…"), delivered);
  assert.equal(lines.at(-1), "• TRADE-OFF: cost.");
  assert.ok(logs.some((l) => l.type === "answerer.card_line_cut" && l.lines === 1), JSON.stringify(logs));
  assert.deepEqual(cuts, ["line"]);
});

test("past the line budget the TRADE-OFF line still shows, and onCut reports the cut", async () => {
  const body = Array.from({ length: CARD_LIMITS.lines + 2 }, (_, i) => `- PART ${i + 1}: point ${i + 1}.\n`).join("");
  const { delivered, cuts } = await cardAnswer("How to handle bursts?", [`- VERDICT: use a queue.\n${body}- TRADE-OFF: more moving parts.`]);
  const lines = delivered.split("\n");
  assert.equal(lines.length, CARD_LIMITS.lines + 1);
  assert.equal(lines.at(-1), "• TRADE-OFF: more moving parts.");
  assert.deepEqual(cuts, ["lines"]);
});

test("a code block past CARD_LIMITS.codeLines ends with a cut mark, and onCut says code", async () => {
  const code = Array.from({ length: CARD_LIMITS.codeLines + 5 }, (_, i) => `line_${i + 1}()`).join("\n");
  const { delivered, cuts } = await cardAnswer("Write the code for it.", [`- VERDICT: here it is.\n\`\`\`python\n${code}\n\`\`\`\n- TRADE-OFF: memory.`]);
  assert.ok(delivered.includes(`line_${CARD_LIMITS.codeLines}()\n…\n\`\`\``), delivered.slice(-200));
  assert.equal(delivered.includes(`line_${CARD_LIMITS.codeLines + 1}()`), false);
  assert.ok(delivered.endsWith("• TRADE-OFF: memory."), delivered.slice(-80));
  assert.deepEqual(cuts, ["code"]);
});

test("onCut is not called when the card fits", async () => {
  const { cuts } = await cardAnswer("How to handle bursts?", ["- VERDICT: use a queue.\n- HOW: it absorbs bursts.\n- TRADE-OFF: latency."]);
  assert.deepEqual(cuts, []);
});

test("an answer cut at maxAnswerChars reports length", async () => {
  const chat = fakeChat(["- First line is long enough.\n", "- Second line."]);
  const cuts = [];
  try {
    const answerer = createAnswerer({ provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m", maxAnswerChars: 12 });
    let delivered = "";
    for await (const delta of answerer.streamAnswer({ question: "q", onCut: (reason) => cuts.push(reason) })) delivered += delta;
    assert.ok(delivered.length <= 14, delivered);
    assert.deepEqual(cuts, ["length"]);
  } finally {
    chat.restore();
  }
});

test("the card key-phrase rule asks for each line's main point, not one phrase per answer", () => {
  assert.match(CARD_HIGHLIGHT_RULE, /in each line, put the phrase that carries that line's main point between double asterisks/);
  assert.match(CARD_HIGHLIGHT_RULE, /Never mark the label/);
  assert.match(CARD_HIGHLIGHT_RULE, /at most one phrase per line/);
});
