import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createAnswerer, DEFAULT_SYSTEM_PROMPT, GROUNDING_RULE } from "../src/server/engines/answerer.js";

async function captureServer(chunks) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of chunks) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    bodies,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const answererFor = (url, extra = {}) =>
  createAnswerer({ provider: "openai-compatible", baseUrl: url, apiKey: "test-key", model: "test-model", ...extra });

test("the default prompt follows the plain-prose rules and keeps 'never invent credentials'", () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /Never invent credentials: degrees, certifications, licences, employers or job titles\./);
  assert.match(DEFAULT_SYSTEM_PROMPT, /two to four bullets/);
  // The user's writing style (2026-10-15): bullets only, Simplified Technical English.
  assert.match(DEFAULT_SYSTEM_PROMPT, /Write every answer as a bulleted list, never as paragraphs\./);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Start every line with a dash and a space \("- "\)/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /one or two short sentences per bullet/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Simplified Technical English/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /"Let's dive in"/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /No em dashes: use commas, periods or colons\./);
  for (const word of ["delve", "crucial", "pivotal", "robust", "seamless", "leverage", "furthermore"]) {
    assert.match(DEFAULT_SYSTEM_PROMPT, new RegExp(`Avoid these words:[^.]*\\b${word}\\b`));
  }
  assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /closing bridge/);
  // Phrases an early live audit found in answers.
  assert.match(DEFAULT_SYSTEM_PROMPT, /"not just X"/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /When you don't know a detail such as a price, answer as the rep would/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Avoid these words: actually, /);
  assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT + GROUNDING_RULE, /[\u2013\u2014]/);
});

test("without context the system message is the default prompt alone", async () => {
  const server = await captureServer(["Hi."]);
  try {
    await answererFor(server.url).answerOnce({ question: "q" });
    assert.equal(server.bodies[0].messages[0].content, DEFAULT_SYSTEM_PROMPT);
  } finally {
    await server.close();
  }
});

test("with context the grounding rule sits between the prompt and the Context block", async () => {
  const server = await captureServer(["Hi."]);
  const context = "DOCUMENTS:\nFile: resume.md\n\nLed the Acme migration.";
  try {
    await answererFor(server.url).answerOnce({ question: "q", context });
    assert.equal(server.bodies[0].messages[0].content, `${DEFAULT_SYSTEM_PROMPT}\n\n${GROUNDING_RULE}\n\nContext:\n${context}`);
  } finally {
    await server.close();
  }
});

test("provider answers come out cleaned; spokenFilter:false keeps the raw text", async () => {
  const chunks = ["We cut costs ", "\u2014 about 30% \u2014 ", "and **shipped** it 2019\u2013", "2021. \uD83D\uDE80"];
  const server = await captureServer(chunks);
  try {
    const cleaned = await answererFor(server.url).answerOnce({ question: "q" });
    assert.equal(cleaned, "• We cut costs, about 30%, and shipped it 2019 to 2021.");
    const raw = await answererFor(server.url, { spokenFilter: false }).answerOnce({ question: "q" });
    assert.equal(raw, chunks.join(""));
  } finally {
    await server.close();
  }
});

test("the grounding rule separates the rep's material from what was said, and never invents product facts", () => {
  assert.match(GROUNDING_RULE, /DOCUMENTS, RESUME and PLAYBOOK are the rep's own material/);
  assert.match(GROUNDING_RULE, /SCREEN, PROSPECT SPEECH, RECENT CONVERSATION and RECENT EXCHANGE show what was on screen, said or suggested, and are not facts about the product/);
  assert.match(GROUNDING_RULE, /Never invent product facts/);
  assert.doesNotMatch(GROUNDING_RULE, /plausible/);
});
