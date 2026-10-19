import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROMPTS_ROOT, configurePrompts, prompt, shippedPrompt } from "../src/server/engines/prompts.js";
import { CARD_RULE, createAnswerer, systemMessage } from "../src/server/engines/answerer.js";
import { buildGlossaryRequest } from "../src/server/engines/glossary.js";
import { INTERPRET_PROMPT, MAX_INTERPRETATION_CHARS } from "../src/server/engines/vision.js";
import { JUDGE_QUESTIONS, buildJudgeRequest } from "../src/server/engines/judge.js";

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

/**
 * Runs `body` with a temp set "t" (a copy of the sales set) and the given
 * override files, then restores the default store and removes the temp files.
 */
async function withPrompts(overrides, body) {
  const root = mkdtempSync(join(tmpdir(), "prompts-engines-"));
  const overrideDir = mkdtempSync(join(tmpdir(), "prompts-overrides-"));
  try {
    writeFileSync(join(root, "sets.json"), JSON.stringify({ default: "t", sets: { t: "test copy of the sales set" } }));
    cpSync(join(PROMPTS_ROOT, "sales"), join(root, "t"), { recursive: true });
    for (const [path, text] of Object.entries(overrides)) {
      mkdirSync(dirname(join(overrideDir, "t", path)), { recursive: true });
      writeFileSync(join(overrideDir, "t", path), text);
    }
    configurePrompts({ root, set: "t", overrideDir });
    return await body();
  } finally {
    configurePrompts({});
    rmSync(root, { recursive: true, force: true });
    rmSync(overrideDir, { recursive: true, force: true });
  }
}

test("an override reaches the answer system message", async () => {
  await withPrompts({ "cards/card.md": "MY CARD RULE" }, () => {
    const system = systemMessage(undefined, "", "spoken", { card: "default" });
    assert.ok(system.includes("MY CARD RULE"));
    assert.equal(system.includes(CARD_RULE), false);
  });
});

test("an override reaches the user message reminder", async () => {
  await withPrompts({ "cards/reminder.md": "MY REMINDER" }, async () => {
    const { bodies } = await cardAnswer("Why Kafka over RabbitMQ?", ["- VERDICT: yes.\n- TRADE-OFF: none."]);
    assert.ok(bodies[0].messages[1].content.endsWith("\n\nMY REMINDER"));
  });
});

test("an override reaches the Terms request", async () => {
  await withPrompts({ "terms/user.md": "S={{skip}} C={{card}}" }, () => {
    assert.equal(buildGlossaryRequest({ model: "m", text: "card", skip: ["a"] }).messages[1].content, "S=- a C=card");
  });
});

test("an override reaches the judge request", async () => {
  const judge = JSON.parse(readFileSync(join(PROMPTS_ROOT, "sales", "judge.json"), "utf8"));
  judge.is_question.instructions = "MINE";
  await withPrompts({ "judge.json": JSON.stringify(judge, null, 2) }, () => {
    assert.equal(buildJudgeRequest({ utterance: "u" }).questions.is_question.instructions, "MINE");
  });
});

test("the vision prompt carries the character cap", async () => {
  await withPrompts({}, () => {
    assert.equal(prompt("vision/interpret", { max_chars: MAX_INTERPRETATION_CHARS }), INTERPRET_PROMPT);
    assert.ok(INTERPRET_PROMPT.includes(`under ${MAX_INTERPRETATION_CHARS} characters`));
  });
});

test("exported constants keep the shipped text whatever the override says", async () => {
  await withPrompts({ "cards/card.md": "MY CARD RULE", "judge.json": "{\"is_question\":{}}" }, () => {
    assert.equal(CARD_RULE, shippedPrompt("cards/card"));
    assert.equal(CARD_RULE.includes("MY CARD RULE"), false);
    assert.equal(JUDGE_QUESTIONS.is_question.type, "noul");
  });
});
