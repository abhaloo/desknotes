import test from "node:test";
import assert from "node:assert/strict";
import { CARD_HIGHLIGHT_RULE, CARD_RULE, HIGHLIGHT_RULE } from "../src/server/engines/answerer.js";
import { createEngineFactory } from "../src/server/engines/index.js";
import { CARD_LIMITS } from "../src/shared/answer-cards.js";

/** End to end: the switch, the engine factory, the pipeline, the real answerer and filter, and the frames. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A card one line past the budget: the VERDICT line, then numbered parts, then two extra lines. */
const CARD_LINES = [
  "- VERDICT: Click **Go Live** to start.",
  ...Array.from({ length: CARD_LIMITS.lines - 1 }, (_, i) => `- PART ${i + 1}: line ${i + 2} of the card.`),
  "- MORE: this line is past the budget.",
];
const CARD = CARD_LINES.join("\n");

async function factoryAnswer(config) {
  const systems = [];
  const frames = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    systems.push(JSON.parse(init.body).messages[0].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: CARD } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const factory = createEngineFactory({
      asrOptions: { provider: "mock-scripted", script: { 1: ["How do I start a live session today?"] } },
      answerProvider: "openai-compatible",
      answererOptions: { baseUrl: "https://llm.test/v1", apiKey: "k", model: "m" },
      ...config,
    });
    const engine = factory({ emit: (frame) => frames.push(frame), log: () => {} });
    engine.onSessionStart({ sessionId: "c" });
    const chunk = new Int16Array(4800).fill(9000);
    for (let i = 0; i < 12; i += 1) engine.onAudio({ streamIdx: 1, seq: i, pcm16: chunk });
    engine.onFinalize({ streamIdx: 1 });
    for (let i = 0; i < 200 && !frames.some((frame) => frame.type === "turn.done"); i += 1) await sleep(5);
    engine.dispose();
    return { system: systems[0] ?? "", text: frames.find((frame) => frame.type === "turn.done")?.data.text ?? null };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("on by default: the card rule is asked for and the card reaches the client within its budget", async () => {
  const on = await factoryAnswer({});
  assert.ok(on.system.includes(CARD_RULE), "the card rule follows the base prompt");
  assert.ok(on.system.includes(CARD_HIGHLIGHT_RULE), "highlights on: the VERDICT key-phrase rule");
  assert.equal(on.system.includes(HIGHLIGHT_RULE), false, "not the three-per-answer rule");
  assert.equal(
    on.text,
    CARD_LINES.slice(0, CARD_LIMITS.lines).map((line) => line.replace(/^- /, "• ")).join("\n"),
    "the budget cut the line past CARD_LIMITS.lines",
  );
});

test("off, fixed or by resolver: no card rule and the old filter path", async () => {
  for (const config of [{ answerCards: false }, { answerCards: true, answerCardsResolver: () => false }]) {
    const off = await factoryAnswer(config);
    assert.equal(off.system.includes(CARD_RULE), false, JSON.stringify(config));
    assert.ok(off.system.includes(HIGHLIGHT_RULE), JSON.stringify(config));
    assert.ok(off.text.includes("MORE: this line is past the budget."), "no line budget when off");
  }
});
