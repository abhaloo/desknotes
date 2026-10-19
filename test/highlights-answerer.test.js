import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SYSTEM_PROMPT, HIGHLIGHT_RULE, createAnswerer, systemMessage } from "../src/server/engines/answerer.js";
import { HIGHLIGHT_LIMITS } from "../src/shared/highlights.js";

/** systemMessage output captured on 0926e36, before highlights existed. */
const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(here, "fixtures", "highlights-off-baseline.json"), "utf8"));

/** A streaming chat endpoint that sends `pieces` as SSE deltas and records each request body. */
function fakeChat(pieces) {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const sse = pieces.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { bodies, restore: () => (globalThis.fetch = realFetch) };
}

async function answer(args, options = {}) {
  const answerer = createAnswerer({ provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m", ...options });
  let text = "";
  for await (const delta of answerer.streamAnswer({ question: "How many sessions can I run?", ...args })) text += delta;
  return text;
}

const MARKED = ["- You can run **one session", " at a time**.\n- Click **Go", " Live** to start."];

test("off: systemMessage is byte-identical to the prompt before highlights", () => {
  assert.equal(BASELINE.prompts.length, 7);
  for (const { args, system } of BASELINE.prompts) {
    const [prompt, context, mode, options] = args;
    assert.equal(systemMessage(prompt, context, mode, options), system, JSON.stringify(args));
    assert.equal(systemMessage(prompt, context, mode, { ...options, highlights: false }), system, JSON.stringify(args));
  }
});

test("on: the rule follows the base prompt and section 4, before the Context rules, in every mode", () => {
  const plain = systemMessage(undefined, "", "spoken", { highlights: true });
  assert.equal(plain, `${DEFAULT_SYSTEM_PROMPT}\n\n${HIGHLIGHT_RULE}`);
  const screen = systemMessage(undefined, "SCREEN:\nS", "spoken", { screenUse: "capture", screenSection: "Section four.", highlights: true });
  assert.ok(screen.indexOf("Section four.") < screen.indexOf(HIGHLIGHT_RULE));
  assert.ok(screen.indexOf(HIGHLIGHT_RULE) < screen.indexOf("SCREEN in the Context below"));
  assert.ok(screen.endsWith("Context:\nSCREEN:\nS"));
  assert.ok(systemMessage(undefined, "", "technical", { highlights: true }).endsWith(HIGHLIGHT_RULE));
  assert.equal(systemMessage("custom", "", "spoken", { highlights: true }), `custom\n\n${HIGHLIGHT_RULE}`);
});

test("the rule states the limits the filter enforces", () => {
  assert.equal(HIGHLIGHT_LIMITS.perBullet, 1);
  assert.equal(HIGHLIGHT_LIMITS.perAnswer, 3);
  assert.equal(HIGHLIGHT_LIMITS.words, 5);
  assert.match(HIGHLIGHT_RULE, /at most one phrase per bullet and at most three per answer/);
  assert.match(HIGHLIGHT_RULE, /five words or fewer/);
  assert.match(HIGHLIGHT_RULE, /overrides any rule above against bold/);
  // Its own examples must pass the filter's word limit.
  for (const [, phrase] of HIGHLIGHT_RULE.matchAll(/\*\*([^*]+)\*\*/g)) assert.ok(phrase.split(/\s+/).length <= HIGHLIGHT_LIMITS.words, phrase);
});

test("streamAnswer({highlights: true}) asks for key phrases and keeps their markers", async () => {
  const chat = fakeChat(MARKED);
  try {
    assert.equal(await answer({ highlights: true }), "• You can run **one session at a time**.\n• Click **Go Live** to start.");
    assert.ok(chat.bodies[0].messages[0].content.includes(HIGHLIGHT_RULE));
  } finally {
    chat.restore();
  }
});

test("streamAnswer without highlights: today's prompt and every marker stripped", async () => {
  for (const args of [{}, { highlights: false }, { highlights: "true" }, { highlights: 1 }]) {
    const chat = fakeChat(MARKED);
    try {
      assert.equal(await answer(args), "• You can run one session at a time.\n• Click Go Live to start.", JSON.stringify(args));
      assert.equal(chat.bodies[0].messages[0].content, DEFAULT_SYSTEM_PROMPT, JSON.stringify(args));
    } finally {
      chat.restore();
    }
  }
});

test("the rule applies even when the user's instructions file says no bold", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "highlights-"));
  const file = path.join(dir, "answer-instructions.txt");
  await writeFile(file, "1. Tone and writing style\nShort answers. No bold, ever.\n2. Role\nYou are a coach.\n");
  const chat = fakeChat(MARKED);
  try {
    await answer({ highlights: true }, { answerInstructionsPath: file });
    const system = chat.bodies[0].messages[0].content;
    assert.ok(system.includes("No bold, ever."));
    assert.ok(system.indexOf("No bold, ever.") < system.indexOf(HIGHLIGHT_RULE), "the rule comes after the user's text");
  } finally {
    chat.restore();
    await rm(dir, { recursive: true, force: true });
  }
});
