import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REP_CONTEXT_RULE, systemMessage } from "../src/server/engines/answerer.js";
import { CONVERSATION_HEADING } from "../src/server/engines/conversation-context.js";
import { buildContext, createPipelineEngine } from "../src/server/engines/pipeline.js";
import { runScriptedCall } from "./fixtures/rep-context-script.mjs";

/**
 * Rep context (conversation-context.js): what the rep actually said reaches
 * answers that start later. Off, everything the answerer and the client see
 * is what 8ec5b18 produced for the same call.
 */
const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(here, "fixtures", "rep-context-baseline.json"), "utf8"));

const OFF_CARD = "REP: Actually it's fifty-five a seat now since the October update.";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label = "condition") {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > 3000) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

function fakeAsr() {
  const handlers = [];
  return {
    pushAudio() {},
    finalize() {
      return true;
    },
    close() {},
    onTranscript(cb) {
      handlers.push(cb);
    },
    send(streamIdx, text, final = false) {
      const data = { text, final, stream: streamIdx, role: streamIdx === 1 ? "prospect" : "rep", source: streamIdx === 1 ? "system" : "mic" };
      for (const cb of handlers) cb(data);
    },
  };
}

/** Streams a fixed answer slowly enough to land speech mid-generation. */
function slowAnswerer({ deltaMs = 5, answer = ["- One part.", " Two part."] } = {}) {
  const calls = [];
  async function* streamAnswer(args) {
    calls.push(args);
    for (const piece of answer) {
      await sleep(deltaMs);
      if (args.signal?.aborted) return;
      yield piece;
    }
  }
  return { calls, streamAnswer };
}

function setup(engineOptions = {}) {
  let clock = 50_000;
  const frames = [];
  const asr = fakeAsr();
  const answerer = slowAnswerer();
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer,
    log: () => {},
    now: () => clock,
    ...engineOptions,
  });
  engine.onSessionStart({ sessionId: "s" });
  const done = () => frames.filter((frame) => frame.type === "turn.done").length;
  return { frames, asr, answerer, engine, done, advance: (ms = 1000) => (clock += ms) };
}

/* ------------------------------------------------------------- off ---- */

test("off: the provider and the client receive exactly what they did on 8ec5b18", async () => {
  assert.equal(BASELINE.requests.length, 5);
  assert.deepEqual(await runScriptedCall({ repContext: false }), BASELINE);
  assert.deepEqual(await runScriptedCall({ repContext: () => false }), BASELINE, "a resolver that says off");
});

/* -------------------------------------------------------------- on ---- */

test("on (the default): the rep's own words reach later answers, filtered, and nothing on the wire changes", async () => {
  const { requests, frames } = await runScriptedCall();
  assert.deepEqual(frames, BASELINE.frames, "no new frames, same cards");
  const [first, second, third, screen, afterClear] = requests.map(([system, user]) => ({ system: system.content, user: user.content }));

  // Only the prospect has spoken: today's prompt.
  assert.equal(first.system, BASELINE.requests[0][0].content);

  // The off-card price the rep said reaches the next answer, with the rule.
  assert.ok(second.system.includes(`${CONVERSATION_HEADING}\nPROSPECT: How much is the Team plan per seat?\n${OFF_CARD}`), second.system);
  assert.ok(second.system.includes(REP_CONTEXT_RULE));
  assert.ok(second.system.includes("RECENT EXCHANGE:\nQ: How much is the Team plan per seat?\nSuggested: • The Team plan is $45"), "history says what was suggested");
  assert.ok(!second.system.includes("\nA: "));
  assert.ok(!second.system.includes("yeah okay"), "filler dropped");

  // Echo of the prospect and the rep reading the card never become REP lines.
  assert.ok(third.system.includes(OFF_CARD));
  assert.ok(!third.system.includes("REP: do you offer"), "echo dropped");
  assert.ok(!third.system.includes("REP: Volume discounts start at 50 seats."), "card reading dropped");
  assert.ok(third.system.includes("PROSPECT: Do you offer any volume discounts for larger teams?"));

  // The screen turn keeps PROSPECT SPEECH and does not repeat those lines.
  assert.ok(screen.system.includes("PROSPECT SPEECH (latest last):"));
  assert.ok(screen.system.includes(OFF_CARD));
  assert.ok(!screen.system.includes("PROSPECT: How much is the Team plan per seat?"));
  assert.ok(!screen.system.includes("PROSPECT: Do you offer"));
  const context = screen.system.slice(screen.system.indexOf("Context:\n"));
  assert.ok(context.indexOf("SCREEN (") < context.indexOf(CONVERSATION_HEADING), "after SCREEN");
  assert.ok(context.indexOf(CONVERSATION_HEADING) < context.indexOf("RECENT EXCHANGE:"), "before history");

  // Clear empties the ring: back to today's prompt.
  assert.equal(afterClear.system, BASELINE.requests[4][0].content);
  // The question each answer is for never changes.
  assert.deepEqual(requests.map(([, user]) => user.content), BASELINE.requests.map(([, user]) => user.content));
});

test("a rep final reaches the NEXT answer, never the one already generating", async () => {
  const { asr, answerer, engine, done, advance } = setup();
  asr.send(1, "How much is the Team plan per seat?", true);
  await waitFor(() => answerer.calls.length === 1);
  advance();
  asr.send(0, "It's fifty-five a seat since the October update.", true);
  await waitFor(() => done() === 1);
  assert.ok(!answerer.calls[0].context.includes(CONVERSATION_HEADING), "the card on screen keeps its context");
  assert.equal(answerer.calls[0].repContext, undefined);

  advance();
  asr.send(1, "And what about volume discounts?", true);
  await waitFor(() => answerer.calls.length === 2);
  assert.ok(answerer.calls[1].context.includes("REP: It's fifty-five a seat since the October update."));
  assert.equal(answerer.calls[1].repContext, true, "the answerer is told the Context carries a REP line");
  engine.onSessionEnd();
});

test("an echo heard just BEFORE the prospect's final is kept out of the turn that final starts", async () => {
  const { asr, answerer, engine, done, advance } = setup();
  asr.send(0, "It's fifty-five a seat since the October update.", true);
  advance(5000);
  // No prospect partials (a batch ASR): the mic's copy lands first.
  asr.send(0, "and if we buy for about 80 people is there any volume discount", true);
  advance(200);
  asr.send(1, "Okay, and if we buy for about 80 people, is there any volume discount?", true);
  await waitFor(() => done() === 1);
  assert.ok(answerer.calls[0].context.includes("REP: It's fifty-five a seat since the October update."));
  assert.ok(!answerer.calls[0].context.includes("REP: and if we buy"), answerer.calls[0].context);
  engine.onSessionEnd();
});

test("the rep still cannot open, commit or supersede a turn", async () => {
  const { frames, asr, answerer, engine, done, advance } = setup();
  asr.send(0, "so what we usually do for teams of that size is a custom plan with SSO");
  asr.send(0, "So what we usually do for teams of that size is a custom plan with SSO.", true);
  await sleep(40);
  assert.equal(frames.filter((frame) => frame.type === "turn.started").length, 0);
  assert.equal(answerer.calls.length, 0);

  advance();
  asr.send(1, "how much does the enterprise tier with SSO cost per seat");
  await waitFor(() => answerer.calls.length === 1);
  asr.send(0, "let me pull up the enterprise numbers for you right now while we talk");
  asr.send(0, "Let me pull up the enterprise numbers for you right now while we talk.", true);
  asr.send(1, "how much does the enterprise tier with SSO cost per seat", true);
  await waitFor(() => done() === 1);
  assert.equal(frames.filter((frame) => frame.type === "turn.superseded").length, 0);
  assert.equal(answerer.calls.length, 1, "the prospect's prefetch was committed, not restarted");
  engine.onSessionEnd();
});

test("the setting is read per answer: toggled off, the next answer is today's; on again, it is back", async () => {
  let enabled = true;
  const { asr, answerer, engine, done, advance } = setup({ repContext: () => enabled });
  asr.send(1, "How much is the Team plan per seat?", true);
  await waitFor(() => done() === 1);
  advance();
  asr.send(0, "It's fifty-five a seat since the October update.", true);

  enabled = false;
  advance();
  engine.onAnswerRequest({ utterance: "And volume discounts?" });
  await waitFor(() => done() === 2);
  const off = answerer.calls[1];
  assert.ok(!off.context.includes(CONVERSATION_HEADING));
  assert.ok(off.context.includes("\nA: - One part. Two part."), "history keeps its A: label when off");
  assert.equal("repContext" in off, false);

  enabled = true;
  advance();
  engine.onAnswerRequest({ utterance: "And annual billing?" });
  await waitFor(() => done() === 3);
  assert.ok(answerer.calls[2].context.includes("REP: It's fifty-five a seat since the October update."));
  assert.ok(answerer.calls[2].context.includes("\nSuggested: - One part. Two part."));
  engine.onSessionEnd();
});

test("off, rep speech is not kept: switching on later starts from what is said next", async () => {
  let enabled = false;
  const { asr, answerer, engine, done, advance } = setup({ repContext: () => enabled });
  asr.send(0, "It's fifty-five a seat since the October update.", true);
  enabled = true;
  advance();
  engine.onAnswerRequest({ utterance: "And volume discounts?" });
  await waitFor(() => done() === 1);
  assert.ok(!answerer.calls[0].context.includes(CONVERSATION_HEADING));
  engine.onSessionEnd();
});

test("a session start empties the ring", async () => {
  const { asr, answerer, engine, done, advance } = setup();
  asr.send(0, "It's fifty-five a seat since the October update.", true);
  advance();
  engine.onSessionStart({ sessionId: "s2" });
  engine.onAnswerRequest({ utterance: "And volume discounts?" });
  await waitFor(() => done() === 1);
  assert.ok(!answerer.calls[0].context.includes(CONVERSATION_HEADING));
  engine.onSessionEnd();
});

/* ------------------------------------------------------- assembly ---- */

const LINES = [
  { who: "prospect", text: "How much is it?", at: 0 },
  { who: "rep", text: "It's fifty-five a seat now.", at: 1 },
];

test("buildContext: the block sits between SCREEN and RECENT EXCHANGE, and history says Suggested", () => {
  const text = buildContext({
    docs: "DOC",
    history: [{ q: "How much is it?", a: "It is $45." }],
    screen: { text: "A pricing page.", ageMs: 0 },
    conversation: LINES,
  });
  assert.equal(
    text,
    [
      "DOCUMENTS:\nDOC",
      "SCREEN (captured just now):\nA pricing page.",
      `${CONVERSATION_HEADING}\nPROSPECT: How much is it?\nREP: It's fifty-five a seat now.`,
      "RECENT EXCHANGE:\nQ: How much is it?\nSuggested: It is $45.",
    ].join("\n\n"),
  );
});

test("buildContext: no REP line, or no conversation, renders exactly today's context", () => {
  const parts = { docs: "DOC", history: [{ q: "q", a: "a" }] };
  const today = buildContext(parts);
  assert.equal(buildContext({ ...parts, conversation: [LINES[0]] }), today);
  assert.equal(buildContext({ ...parts, conversation: [] }), today);
  assert.equal(buildContext({ ...parts, conversation: null }), today);
  assert.ok(today.includes("\nA: a"));
});

test("buildContext: the block comes out of the document's share; the total stays within 32k", () => {
  const conversation = Array.from({ length: 8 }, (_, i) => ({ who: "rep", text: `${i} ${"w".repeat(400)}`, at: i }));
  const args = {
    resume: "r".repeat(50_000),
    playbook: "p".repeat(50_000),
    docs: "d".repeat(50_000),
    history: [{ q: "q".repeat(5_000), a: "a".repeat(5_000) }],
    screen: { text: "s".repeat(5_000), ageMs: 0 },
    prospect: ["x".repeat(2_000)],
  };
  const without = buildContext(args);
  const withBlock = buildContext({ ...args, conversation });
  assert.equal(without.length, 32_000);
  assert.equal(withBlock.length, 32_000);
  assert.ok(withBlock.includes(CONVERSATION_HEADING));
  const docsLength = (text) => text.slice(text.indexOf("DOCUMENTS:\n")).indexOf("\n\n");
  assert.ok(docsLength(withBlock) < docsLength(without), "documents gave up the room");
});

/* --------------------------------------------------------- answerer ---- */

test("the system prompt adds the rep rule only when the Context carries a REP line", () => {
  const plain = systemMessage(undefined, "DOCUMENTS:\nDOC");
  const rep = systemMessage(undefined, "DOCUMENTS:\nDOC", "spoken", { repContext: true });
  assert.ok(!plain.includes(REP_CONTEXT_RULE));
  assert.ok(rep.includes(REP_CONTEXT_RULE));
  assert.equal(rep.replace(`\n\n${REP_CONTEXT_RULE}`, ""), plain, "nothing else moves");
  const technical = systemMessage(undefined, "DOCUMENTS:\nDOC", "technical", { repContext: true, screenUse: "context" });
  assert.ok(technical.indexOf("SCREEN in the Context") < technical.indexOf(REP_CONTEXT_RULE), "after the screen rule, every mode");
  assert.equal(systemMessage("custom", "", "spoken", { repContext: true }), "custom", "no Context, no rules");
});
