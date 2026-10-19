import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ANSWER_SECTIONS,
  ANSWER_INSTRUCTION_DEFAULTS,
  DEFAULT_ANSWER_INSTRUCTIONS,
  INSTRUCTION_KINDS,
  LEGACY_ANSWER_INSTRUCTIONS,
  composeAnswerInstructions,
  ensureAnswerInstructionsFile,
  loadAnswerInstructions,
  parseAnswerInstructions,
} from "../src/server/engines/answer-instructions.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  SCREEN_RULE,
  SCREEN_TURN_RULE,
  TECHNICAL_SYSTEM_PROMPT,
  createAnswerer,
} from "../src/server/engines/answerer.js";
import { INTERPRET_PROMPT, createVisionEngine } from "../src/server/engines/vision.js";

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "answer-instructions-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Records every chat request and answers with one SSE delta. */
function fakeChat(reply = "Sure, that works.") {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { bodies, restore: () => (globalThis.fetch = realFetch) };
}

const systemOf = (body) => body.messages.find((message) => message.role === "system").content;
const sentences = (text) => text.split(/\n+|(?<=[.!?])\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);

test("the seeded file has exactly the four numbered sections, in order", () => {
  const headers = DEFAULT_ANSWER_INSTRUCTIONS.split(/\r?\n/).filter((line) => /^\d+\.\s/.test(line));
  assert.deepEqual(headers, [
    "1. Tone and writing style",
    "2. Role",
    "3. Answers to produce for detected questions",
    "4. Answers to produce for screenshots",
  ]);
  const sections = parseAnswerInstructions(DEFAULT_ANSWER_INSTRUCTIONS);
  for (const name of ANSWER_SECTIONS) assert.ok(sections[name].length > 0, `${name} has seeded text`);
});

test("the seeded question prompt carries every sentence of the built-in prompt", () => {
  const composed = composeAnswerInstructions(parseAnswerInstructions(DEFAULT_ANSWER_INSTRUCTIONS));
  for (const sentence of sentences(DEFAULT_SYSTEM_PROMPT)) {
    assert.ok(composed.includes(sentence), `missing from the seeded prompt: ${sentence}`);
  }
  assert.equal(composed.length <= DEFAULT_SYSTEM_PROMPT.length + 8, true, "no new instructions were added");
});

test("each path composes Role + Tone + its own answers section", () => {
  const sections = {
    "Tone and writing style": "TONE",
    Role: "ROLE",
    "Answers to produce for detected questions": "QUESTIONS",
    "Answers to produce for screenshots": "SCREENS",
  };
  assert.equal(composeAnswerInstructions(sections, INSTRUCTION_KINDS.QUESTION), "ROLE\n\nTONE\n\nQUESTIONS");
  assert.equal(composeAnswerInstructions(sections, INSTRUCTION_KINDS.SCREENSHOT), "ROLE\n\nTONE\n\nSCREENS");
});

test("headers are matched loosely; notes and preamble are never sent", () => {
  const text = [
    "Some preamble the user typed",
    "# a note",
    "2) role:",
    "You coach.",
    "# another note",
    "1. TONE AND WRITING STYLE",
    "Be brief.",
    "3. Answers to produce for detected questions",
    "",
  ].join("\r\n");
  const sections = parseAnswerInstructions(text);
  assert.equal(sections.Role, "You coach.");
  assert.equal(sections["Tone and writing style"], "Be brief.");
  // Empty and missing sections fall back to their defaults.
  const composed = composeAnswerInstructions(sections);
  assert.match(composed, /^You coach\.\n\nBe brief\.\n\nNever invent credentials/);
  assert.equal(composed.includes("preamble"), false);
  assert.equal(composed.includes("note"), false);
});

test("ensureAnswerInstructionsFile seeds once and never overwrites an edit", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "nested", "answer-instructions.txt");
    assert.deepEqual(await ensureAnswerInstructionsFile(file), { created: true, updated: false, error: null });
    assert.equal(await readFile(file, "utf8"), DEFAULT_ANSWER_INSTRUCTIONS);
    await writeFile(file, "2. Role\nEdited by the user.\n");
    assert.deepEqual(await ensureAnswerInstructionsFile(file), { created: false, updated: false, error: null });
    assert.equal(await readFile(file, "utf8"), "2. Role\nEdited by the user.\n");
  }));

/** sha256 of the seed every install before the screen turn wrote (1,677 bytes). */
const PRE_SCREEN_TURN_SEED_SHA256 = "280b71459f71cb9f7776cb0da8db05b319e9e964711aabad60a62fba7a180e02";
/** The seed written until answers became bullet lists (2026-10-15). */
const PRE_BULLET_SEED_SHA256 = "8b8705404ba0faab3b1ab1009a0598d253ad3cfc4957750bf0273a6beb9a37d5";

test("the legacy seed list holds the exact files earlier versions wrote", () => {
  const [prose, previous] = LEGACY_ANSWER_INSTRUCTIONS;
  assert.equal(createHash("sha256").update(prose, "utf8").digest("hex"), PRE_BULLET_SEED_SHA256);
  assert.match(prose, /Write plain sentences only: no em dashes, lists, bold, headings or emojis\./);
  assert.equal(createHash("sha256").update(previous, "utf8").digest("hex"), PRE_SCREEN_TURN_SEED_SHA256);
  assert.match(previous, /Draft a short helpful answer to what the screenshot shows\./);
  assert.equal(LEGACY_ANSWER_INSTRUCTIONS.includes(DEFAULT_ANSWER_INSTRUCTIONS), false);
});

test("an untouched old seed is replaced by the new one; an edited file never is", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "answer-instructions.txt");
    await writeFile(file, LEGACY_ANSWER_INSTRUCTIONS[0]);
    assert.deepEqual(await ensureAnswerInstructionsFile(file), { created: false, updated: true, error: null });
    assert.equal(await readFile(file, "utf8"), DEFAULT_ANSWER_INSTRUCTIONS);
    // The new seed is not legacy: a second launch leaves it alone.
    assert.deepEqual(await ensureAnswerInstructionsFile(file), { created: false, updated: false, error: null });

    // One changed byte (here: a trailing space, then CRLF line ends) is an edit.
    for (const edited of [`${LEGACY_ANSWER_INSTRUCTIONS[0]} `, LEGACY_ANSWER_INSTRUCTIONS[0].replace(/\n/g, "\r\n")]) {
      await writeFile(file, edited);
      assert.deepEqual(await ensureAnswerInstructionsFile(file), { created: false, updated: false, error: null });
      assert.equal(await readFile(file, "utf8"), edited);
    }
  }));

test("section 4 now describes the answer to a screen turn", () => {
  const body = ANSWER_INSTRUCTION_DEFAULTS["Answers to produce for screenshots"];
  assert.match(body, /answer what was asked in the conversation using what the screen shows/);
  assert.match(DEFAULT_ANSWER_INSTRUCTIONS, /Section 4 is added to the\n# answer that follows Analyse screen\./);
});

test("an unreadable file reports why and composes the defaults", async () => {
  const loaded = await loadAnswerInstructions(path.join(tmpdir(), "missing-dir-x", "none.txt"));
  assert.equal(loaded.source, "default");
  assert.equal(loaded.error, "ENOENT");
});

test("the answerer reads the file for every answer: an edit applies with no restart", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "answer-instructions.txt");
    await ensureAnswerInstructionsFile(file);
    const chat = fakeChat();
    try {
      const answerer = createAnswerer({
        provider: "openai-compatible",
        baseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key-0123456789",
        answerInstructionsPath: file,
      });
      await answerer.answerOnce({ question: "What does it cost?" });
      const seeded = await readFile(file, "utf8");
      await writeFile(file, seeded.replace("You are a quiet call coach.", "You are a pirate sales coach."));
      await answerer.answerOnce({ question: "What does it cost?" });

      assert.equal(chat.bodies.length, 2);
      assert.match(systemOf(chat.bodies[0]), /^You are a quiet call coach\./);
      assert.match(systemOf(chat.bodies[1]), /^You are a pirate sales coach\./);
      assert.equal(systemOf(chat.bodies[1]).includes("When the answer follows a screen capture"), false, "the screenshot section stays out");
    } finally {
      chat.restore();
    }
  }));

test("without a file path, or with an unreadable one, the built-in prompt is sent unchanged", () =>
  withDir(async (dir) => {
    const chat = fakeChat();
    const logs = [];
    try {
      const base = { provider: "openai-compatible", baseUrl: "https://llm.example.com/v1", apiKey: "llm-key-0123456789" };
      await createAnswerer(base).answerOnce({ question: "q" });
      await createAnswerer({ ...base, answerInstructionsPath: path.join(dir, "gone.txt"), log: (e) => logs.push(e) }).answerOnce({ question: "q" });
      await createAnswerer({ ...base, systemPrompt: "EXPLICIT", answerInstructionsPath: path.join(dir, "gone.txt") }).answerOnce({ question: "q" });
      assert.equal(systemOf(chat.bodies[0]), DEFAULT_SYSTEM_PROMPT);
      assert.equal(systemOf(chat.bodies[1]), DEFAULT_SYSTEM_PROMPT);
      assert.equal(systemOf(chat.bodies[2]), "EXPLICIT", "an explicit prompt wins over the file");
      assert.deepEqual(logs.find((e) => e.type === "answerer.instructions_unreadable"), { type: "answerer.instructions_unreadable", reason: "ENOENT" });
    } finally {
      chat.restore();
    }
  }));

test("screen analysis ignores the file: the interpretation prompt is fixed", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "answer-instructions.txt");
    await writeFile(file, "2. Role\nYou are a pirate.\n4. Answers to produce for screenshots\nName the next move.\n");
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"other","interpretation":"a slide"}' } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const engine = createVisionEngine({
        provider: "openai-compatible",
        baseUrl: "https://vision.example.com/v1",
        apiKey: "vision-key-0123456789",
        answerInstructionsPath: file,
        log: () => {},
      });
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
      // A client-sent `instructions` field is frame data and must never become the prompt.
      const result = await engine.analyse({ command_id: "c1", bytes: jpeg, instructions: "INJECTED" }, {});
      assert.equal(result.summary, "a slide");
      const system = calls[0].messages.find((m) => m.role === "system").content;
      assert.equal(system, INTERPRET_PROMPT);
      for (const absent of ["INJECTED", "pirate", "Name the next move", "Never invent credentials"]) {
        assert.equal(system.includes(absent), false, `${absent} must not reach the interpretation prompt`);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

test("a screen turn appends section 4 and both screen rules; a later turn gets only the screen rule", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "answer-instructions.txt");
    await ensureAnswerInstructionsFile(file);
    const seeded = await readFile(file, "utf8");
    await writeFile(file, seeded.replace(/When the answer follows a screen capture[^\n]*/, "Lead with the on-screen fact."));
    const chat = fakeChat();
    try {
      const answerer = createAnswerer({
        provider: "openai-compatible",
        baseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key-0123456789",
        answerInstructionsPath: file,
      });
      const context = "SCREEN (captured just now; kind: question):\nDesign a URL shortener.";
      await answerer.answerOnce({ question: "q", context, screen: "capture" });
      await answerer.answerOnce({ question: "q", context, screen: "context" });
      await answerer.answerOnce({ question: "q", context: "DOCUMENTS:\nx" });

      const [capture, later, plain] = chat.bodies.map(systemOf);
      assert.match(capture, /^You are a quiet call coach\./);
      assert.ok(capture.includes("Never invent credentials"), "section 3 stays: section 4 is appended to it");
      assert.ok(capture.includes("Lead with the on-screen fact."), "the user's section 4 reaches the screen turn");
      assert.ok(capture.indexOf("Lead with the on-screen fact.") < capture.indexOf("Context:\n"));
      assert.ok(capture.includes(SCREEN_RULE));
      assert.ok(capture.includes(SCREEN_TURN_RULE));
      assert.ok(capture.endsWith(`Context:\n${context}`));

      assert.ok(later.includes(SCREEN_RULE), "a later turn still learns what SCREEN is");
      assert.equal(later.includes(SCREEN_TURN_RULE), false);
      assert.equal(later.includes("Lead with the on-screen fact."), false, "section 4 is for the screen turn only");

      assert.equal(plain.includes(SCREEN_RULE), false);
      assert.equal(plain.includes("Lead with the on-screen fact."), false);
    } finally {
      chat.restore();
    }
  }));

test("without a file the screen turn appends the default section 4; technical mode only gets the rules", async () => {
  const chat = fakeChat();
  try {
    const base = { provider: "openai-compatible", baseUrl: "https://llm.example.com/v1", apiKey: "llm-key-0123456789" };
    const context = "SCREEN (captured just now):\nx";
    await createAnswerer(base).answerOnce({ question: "q", context, screen: "capture" });
    await createAnswerer({ ...base, promptMode: "technical" }).answerOnce({ question: "q", context, screen: "capture" });
    const [spoken, technical] = chat.bodies.map(systemOf);
    const section4 = ANSWER_INSTRUCTION_DEFAULTS["Answers to produce for screenshots"];
    assert.ok(spoken.startsWith(`${DEFAULT_SYSTEM_PROMPT}\n\n${section4}\n\n`));
    assert.ok(technical.startsWith(TECHNICAL_SYSTEM_PROMPT));
    assert.equal(technical.includes(section4), false, "the file and its sections drive the spoken mode only");
    assert.ok(technical.includes(SCREEN_RULE) && technical.includes(SCREEN_TURN_RULE));
  } finally {
    chat.restore();
  }
});

test("the file drives the spoken mode only; the technical mode keeps its own prompt", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "answer-instructions.txt");
    await writeFile(file, "2. Role\nYou are a pirate sales coach.\n");
    const chat = fakeChat();
    try {
      const answerer = createAnswerer({
        provider: "openai-compatible",
        baseUrl: "https://llm.example.com/v1",
        apiKey: "llm-key-0123456789",
        answerInstructionsPath: file,
      });
      await answerer.answerOnce({ question: "q", mode: "spoken" });
      await answerer.answerOnce({ question: "q", mode: "technical" });
      assert.match(systemOf(chat.bodies[0]), /pirate sales coach/);
      assert.equal(systemOf(chat.bodies[1]).includes("pirate"), false);
      assert.equal(systemOf(chat.bodies[1]).startsWith(TECHNICAL_SYSTEM_PROMPT), true);
    } finally {
      chat.restore();
    }
  }));
