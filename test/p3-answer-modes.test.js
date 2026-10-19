import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createAnswerer,
  DEFAULT_SYSTEM_PROMPT,
  GROUNDING_RULE,
  GROUNDING_RULE_TECHNICAL,
  NO_CHATBOT_RULES,
  SURFACE_RULES,
  TECHNICAL_SYSTEM_PROMPT,
} from "../src/server/engines/answerer.js";

async function captureServer() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"answer -- text"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { bodies, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

const answererFor = (url, extra = {}) =>
  createAnswerer({ provider: "openai-compatible", baseUrl: url, apiKey: "test-key", model: "test-model", ...extra });

test("DEFAULT_SYSTEM_PROMPT is byte-identical to the bullet-style text", () => {
  const expected = [
    "You are a quiet call coach. Write the words the rep will say next, in the rep's voice: first person, spoken, short (two to four bullets). Put the direct answer in the first bullet. Add one concrete detail or example only if it helps, then stop. Never invent credentials: degrees, certifications, licences, employers or job titles.",
    'Talk like a person, not a chatbot. Use plain words and simple verbs (is, are, has, can) and contractions. Don\'t open with praise or filler like "Great question", "Certainly" or "Let\'s dive in", and don\'t end with a summary, a slogan or an offer to say more. Don\'t list things in threes by habit, and don\'t use "not only... but", "not just X" or "it\'s not X, it\'s Y". When you don\'t know a detail such as a price, answer as the rep would: say what it depends on and offer to send the exact figure. Write every answer as a bulleted list, never as paragraphs. Start every line with a dash and a space ("- "), and write one or two short sentences per bullet. Use Simplified Technical English: short sentences, plain verbs and simple words. Avoid these words: actually, delve, crucial, pivotal, robust, seamless, leverage, showcase, testament, landscape, vibrant, additionally, furthermore, underscore, foster. No em dashes: use commas, periods or colons. No bold, headings, numbered lists or emojis.',
  ].join("\n\n");
  assert.equal(DEFAULT_SYSTEM_PROMPT, expected);
});

test("TECHNICAL_SYSTEM_PROMPT shares the rule blocks and states the technical contract", () => {
  assert.ok(TECHNICAL_SYSTEM_PROMPT.includes(SURFACE_RULES));
  assert.ok(TECHNICAL_SYSTEM_PROMPT.includes(NO_CHATBOT_RULES));
  assert.match(TECHNICAL_SYSTEM_PROMPT, /solutions engineer/);
  assert.match(TECHNICAL_SYSTEM_PROMPT, /every constraint the question states/);
  assert.match(TECHNICAL_SYSTEM_PROMPT, /security and data handling, limits, and what setup takes/);
  assert.match(TECHNICAL_SYSTEM_PROMPT, /never invent\s+facts/);
  assert.match(TECHNICAL_SYSTEM_PROMPT, /say who can confirm it and offer to follow up/);
  assert.doesNotMatch(TECHNICAL_SYSTEM_PROMPT, /rep's voice/);
  assert.equal(DEFAULT_SYSTEM_PROMPT.includes(NO_CHATBOT_RULES), true);
  assert.equal(DEFAULT_SYSTEM_PROMPT.includes(SURFACE_RULES), true);
});

test("system message: spoken prompt and grounding rule by default", async () => {
  const server = await captureServer();
  try {
    await answererFor(server.url).answerOnce({ question: "q", context: "DOC" });
    assert.equal(server.bodies[0].messages[0].content, `${DEFAULT_SYSTEM_PROMPT}\n\n${GROUNDING_RULE}\n\nContext:\nDOC`);
  } finally { await server.close(); }
});

test("system message: technical prompt and technical grounding rule", async () => {
  const server = await captureServer();
  try {
    await answererFor(server.url, { promptMode: "technical" }).answerOnce({ question: "q", context: "DOC" });
    assert.equal(server.bodies[0].messages[0].content, `${TECHNICAL_SYSTEM_PROMPT}\n\n${GROUNDING_RULE_TECHNICAL}\n\nContext:\nDOC`);
  } finally { await server.close(); }
});

test("user message: spoken keeps the intent prefix, technical sends the question verbatim", async () => {
  const server = await captureServer();
  try {
    await answererFor(server.url).answerOnce({ question: "Q?", intent: "final" });
    assert.equal(server.bodies[0].messages[1].content, "Sales-call intent: final\n\nQ?");
    await answererFor(server.url, { promptMode: "technical" }).answerOnce({ question: "Q?", intent: "final" });
    assert.equal(server.bodies[1].messages[1].content, "Q?");
  } finally { await server.close(); }
});

test("per-call mode overrides promptMode for that call only", async () => {
  const server = await captureServer();
  try {
    const answerer = answererFor(server.url, { promptMode: "technical" });
    await answerer.answerOnce({ question: "q1" });
    await answerer.answerOnce({ question: "q2", mode: "spoken" });
    assert.ok(server.bodies[0].messages[0].content.startsWith("You are a solutions engineer"));
    assert.ok(server.bodies[1].messages[0].content.startsWith("You are a quiet call coach"));
  } finally { await server.close(); }
});

test("routes.technical sends technical calls to the technical slot, spoken to the base slot", async () => {
  const base = await captureServer();
  const tech = await captureServer();
  try {
    const answerer = createAnswerer({
      provider: "openai-compatible", baseUrl: base.url, apiKey: "base-key", model: "base-model",
      routes: { technical: { baseUrl: tech.url, apiKey: "tech-key", model: "tech-model" } },
    });
    await answerer.answerOnce({ question: "s" });
    await answerer.answerOnce({ question: "t", mode: "technical" });
    assert.equal(base.bodies[0].model, "base-model");
    assert.equal(tech.bodies[0].model, "tech-model");
    assert.equal(base.bodies.length, 1);
    assert.equal(tech.bodies.length, 1);
  } finally { await base.close(); await tech.close(); }
});

test("a slot without its own config falls back to the base slot", async () => {
  const server = await captureServer();
  try {
    await answererFor(server.url, { promptMode: "technical", routes: { technical: { model: "tech-model" } } })
      .answerOnce({ question: "q" });
    assert.equal(server.bodies[0].model, "tech-model"); // same endpoint as the base slot
  } finally { await server.close(); }
});

test("the spoken filter runs in technical mode too", async () => {
  const server = await captureServer();
  try {
    // The capture server streams "answer -- text"; the filter swallows the
    // whitespace around the double hyphen and emits ", " in every mode.
    const text = await answererFor(server.url, { promptMode: "technical" }).answerOnce({ question: "q" });
    assert.equal(text, "• answer, text");
  } finally { await server.close(); }
});
