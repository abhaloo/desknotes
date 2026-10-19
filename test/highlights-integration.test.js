import test from "node:test";
import assert from "node:assert/strict";
import { HIGHLIGHT_RULE } from "../src/server/engines/answerer.js";
import { createEngineFactory } from "../src/server/engines/index.js";
import { SCRIPT_ANSWER, runScriptedCall } from "./fixtures/rep-context-script.mjs";

/** End to end: the switch, the real answerer and filter, the pipeline and the frames. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MARKED = SCRIPT_ANSWER.replace("$45 a seat", "**$45 a seat**").replace("50 seats", "**50 seats**");

test("on: the provider is asked for key phrases, the client gets them, the next prompt gets plain words", async () => {
  const { requests, frames } = await runScriptedCall({ highlights: true }, { answer: MARKED }); // answer cards off (fixture default)
  const systems = requests.map(([system]) => system.content);
  assert.ok(systems.every((system) => system.includes(HIGHLIGHT_RULE)), "every answer asks");
  const done = frames.filter((frame) => frame.type === "turn.done");
  assert.equal(done[0].data.text, "• The Team plan is **$45 a seat** per month.\n• Volume discounts start at **50 seats**.");
  const history = systems[1].slice(systems[1].indexOf("RECENT EXCHANGE:"));
  assert.ok(history.includes("• The Team plan is $45 a seat per month."), history);
  assert.equal(history.includes("**"), false, "history carries no markers");
});

/** One prospect question through the engine factory with the real answerer (fetch faked). */
async function factoryAnswer(config) {
  const systems = [];
  const frames = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    systems.push(JSON.parse(init.body).messages[0].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: "- Click **Go Live** to start." } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const factory = createEngineFactory({
      asrOptions: { provider: "mock-scripted", script: { 1: ["How do I start a live session today?"] } },
      answerProvider: "openai-compatible",
      answererOptions: { baseUrl: "https://llm.test/v1", apiKey: "k", model: "m" },
      // Highlights are tested on the path they shipped on: answer cards off.
      answerCards: false,
      ...config,
    });
    const engine = factory({ emit: (frame) => frames.push(frame), log: () => {} });
    engine.onSessionStart({ sessionId: "f" });
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

test("the engine factory forwards the switch: the fixed value, or a resolver read per answer", async () => {
  const on = await factoryAnswer({});
  assert.equal(on.text, "• Click **Go Live** to start.", "default on");
  assert.ok(on.system.includes(HIGHLIGHT_RULE));
  const env = await factoryAnswer({ highlights: false });
  assert.equal(env.text, "• Click Go Live to start.", "HIGHLIGHTS=0");
  assert.equal(env.system.includes(HIGHLIGHT_RULE), false);
  const settings = await factoryAnswer({ highlights: true, highlightsResolver: () => false });
  assert.equal(settings.text, "• Click Go Live to start.", "Settings off wins");
  assert.equal(settings.system.includes(HIGHLIGHT_RULE), false);
});
