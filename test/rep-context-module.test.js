import test from "node:test";
import assert from "node:assert/strict";
import {
  CONVERSATION_CHARS,
  CONVERSATION_HEADING,
  CONVERSATION_LINES,
  REP_CONTEXT_RULE,
  contentWords,
  createConversationLog,
  hasRepLine,
  isCardReading,
  isEcho,
  isFillerLine,
  renderConversation,
} from "../src/server/engines/conversation-context.js";

/* ------------------------------------------------------------ words ---- */

test("content words: lowercased, punctuation stripped, stopwords removed", () => {
  assert.deepEqual(contentWords("Actually, it's FIFTY-FIVE a seat now!"), ["actually", "fifty", "five", "seat", "now"]);
  assert.deepEqual(contentWords("$55 per seat."), ["55", "per", "seat"]);
  assert.deepEqual(contentWords("the and of to"), []);
  assert.deepEqual(contentWords(""), []);
  assert.deepEqual(contentWords(null), []);
});

/* ---------------------------------------------------------- filters ---- */

test("filler: nothing but filler, or under two content words when under four words, is dropped", () => {
  for (const line of ["yeah", "mm-hmm", "um okay", "so right", "yeah yeah okay right", "Um, let me think.", "Good question, let me think about that", "okay so um yeah", "yeah okay sure", "got it, thanks", "let me think", "Sounds good.", "That makes sense.", "Thanks so much!", "No problem.", "Thank you.", "Perfect, sounds good"]) {
    assert.equal(isFillerLine(line), true, line);
  }
  for (const line of ["It's fifty-five a seat now.", "yeah so we moved to fifty-five", "We ship the export in March", "it's fifty-five", "Use Rust instead", "Postgres, not Mongo"]) {
    assert.equal(isFillerLine(line), false, line);
  }
});

test("echo: 60% or more of the rep line's content words were in prospect speech", () => {
  const prospect = ["Do you offer any volume discounts for larger teams?"];
  assert.equal(isEcho("do you offer any volume discounts for larger teams", prospect), true);
  assert.equal(isEcho("volume discounts for larger teams, sure we do", prospect), true, "4 of 5 content words");
  assert.equal(isEcho("Yes, discounts start at fifty seats and grow from there", prospect), false);
  assert.equal(isEcho("anything at all", []), false, "no prospect speech, no echo");
});

test("echo: a number or a correction word the prospect did not say keeps the line", () => {
  const prospect = ["Do you offer volume discounts for 80 seats?"];
  assert.equal(isEcho("volume discounts for 100 seats", prospect), false, "100 is not in prospect speech");
  assert.equal(isEcho("volume discounts for 80 seats", prospect), true, "the prospect's own number");
  assert.equal(isEcho("We don't support single sign-on with Okta", ["Do you support single sign-on with Okta?"]), false, "don't");
});

test("card reading: 70% or more of the rep line's content words are on the card", () => {
  const card = "• The Team plan is $45 a seat per month.\n• Volume discounts start at 50 seats.";
  assert.equal(isCardReading("Volume discounts start at 50 seats.", card), true);
  assert.equal(isCardReading("So the team plan is 45 a seat", card), true);
  assert.equal(isCardReading("Actually it's fifty-five a seat now since the October update.", card), false);
  assert.equal(isCardReading("Volume discounts start at 50 seats.", ""), false, "no card shown");
});

test("card reading: a number or a correction word the card lacks keeps the line", () => {
  const card = "Use Kafka with 6 partitions keyed by sensor id.";
  assert.equal(isCardReading("We'd use Kafka with 12 partitions", card), false);
  assert.equal(isCardReading("We'd use Kafka with 6 partitions", card), true);
  assert.equal(isCardReading("Use Kafka with 12 partitions keyed by sensor id", card), false, "6 of 7 content words on the card");
  assert.equal(isCardReading("Use Kafka with twelve partitions keyed by sensor id", card), false, "a number word");
  assert.equal(isCardReading("We would not use Redis for this", "We would use Redis for this"), false, "not is missing from the card");
  assert.equal(isCardReading("We would not use Redis for this", "We would not use Redis for this."), true, "the card's own not");
});

/* -------------------------------------------------------------- log ---- */

function clock(start = 0) {
  let value = start;
  return { now: () => value, advance: (ms) => (value += ms) };
}

test("the log keeps both speakers in order and reports why a rep line was dropped", () => {
  const time = clock(10_000);
  const log = createConversationLog({ now: time.now });
  log.addProspect("How much is the Team plan per seat?");
  time.advance(1000);
  assert.equal(log.addRep("Actually it's fifty-five a seat now since October."), null);
  assert.equal(log.addRep("yeah okay"), "filler");
  assert.equal(log.addRep("The Team plan is $45 a seat per month.", { card: "• The Team plan is $45 a seat per month." }), "card");
  assert.deepEqual(
    log.lines().map(({ who, text }) => [who, text]),
    [
      ["prospect", "How much is the Team plan per seat?"],
      ["rep", "Actually it's fifty-five a seat now since October."],
    ],
  );
  assert.equal(log.lines()[0].at, 10_000);
  assert.equal(log.lines()[1].at, 11_000);
});

test("a short correction is kept", () => {
  const time = clock(10_000);
  const log = createConversationLog({ now: time.now });
  log.addProspect("Which language would you use for the ingest service?");
  time.advance(1000);
  assert.equal(log.addRep("Use Rust instead", { card: "• Use Go for the ingest service." }), null);
  assert.deepEqual(log.lines().at(-1), { who: "rep", text: "Use Rust instead", at: 11_000 });
});

test("echo is checked against prospect speech within 3 s either side, the latest partial included", () => {
  const time = clock(0);
  const log = createConversationLog({ now: time.now });
  log.noteProspectSpeech("do you offer any volume discounts");
  time.advance(2_500);
  assert.equal(log.addRep("do you offer any volume discounts"), "echo", "partial 2.5 s ago");

  time.advance(10_000);
  log.addProspect("we need single sign-on for every team");
  time.advance(3_500);
  assert.equal(log.addRep("we need single sign-on for every team"), null, "3.5 s later is not an echo");

  // The prospect's own words land after the rep's mic picked them up.
  time.advance(10_000);
  assert.equal(log.addRep("can you send the security review document today"), null);
  time.advance(1_000);
  log.addProspect("Can you send the security review document today?");
  assert.equal(
    log.lines().some((line) => line.who === "rep" && /security review/.test(line.text)),
    false,
    "an echo found after the fact is removed",
  );
  assert.ok(log.lines().some((line) => line.who === "rep" && /single sign-on/.test(line.text)), "older rep lines stay");
});

test("the log is a ring and clear empties it", () => {
  const log = createConversationLog({ now: () => 0 });
  for (let i = 0; i < CONVERSATION_LINES + 5; i += 1) log.addProspect(`prospect line number ${i}`);
  assert.equal(log.lines().length, CONVERSATION_LINES);
  assert.equal(log.lines().at(-1).text, `prospect line number ${CONVERSATION_LINES + 4}`);
  log.clear();
  assert.deepEqual(log.lines(), []);
});

/* -------------------------------------------------------- rendering ---- */

const line = (who, text) => ({ who, text, at: 0 });

test("rendering: oldest first, labelled, only when a REP line exists", () => {
  assert.equal(renderConversation([line("prospect", "How much is it?"), line("prospect", "And volume?")]), "");
  assert.equal(renderConversation([]), "");
  assert.equal(renderConversation(null), "");
  const block = renderConversation([line("prospect", "How much is it?"), line("rep", "It's fifty-five a seat now."), line("prospect", "And volume?")]);
  assert.equal(
    block,
    `${CONVERSATION_HEADING}\nPROSPECT: How much is it?\nREP: It's fifty-five a seat now.\nPROSPECT: And volume?`,
  );
  assert.equal(CONVERSATION_HEADING, "RECENT CONVERSATION (oldest first; REP lines are what the rep actually said):");
  assert.equal(hasRepLine([line("prospect", "x")]), false);
  assert.equal(hasRepLine([line("rep", "x")]), true);
});

test("rendering: the last 8 lines, capped at 1,200 characters by dropping the oldest", () => {
  const many = Array.from({ length: 12 }, (_, i) => line(i % 2 ? "rep" : "prospect", `line ${i}`));
  const block = renderConversation(many);
  const body = block.split("\n").slice(1);
  assert.equal(body.length, 8);
  assert.equal(body[0], "PROSPECT: line 4");
  assert.equal(body.at(-1), "REP: line 11");

  const long = Array.from({ length: 8 }, (_, i) => line("rep", `${i} ${"w".repeat(290)}`));
  const capped = renderConversation(long);
  const cappedBody = capped.slice(CONVERSATION_HEADING.length + 1);
  assert.ok(cappedBody.length <= CONVERSATION_CHARS, `${cappedBody.length}`);
  assert.ok(cappedBody.startsWith("REP: 4 "), "oldest dropped first");
  assert.ok(cappedBody.includes("REP: 7 "), "newest kept");
});

test("rendering: an over-long line is cut, and the cap can never leave only prospect lines", () => {
  const block = renderConversation([line("rep", "r".repeat(2_000))]);
  assert.ok(block.length <= CONVERSATION_HEADING.length + 1 + CONVERSATION_CHARS);
  const repFirst = [line("rep", "short rep line here"), ...Array.from({ length: 7 }, () => line("prospect", "p".repeat(290)))];
  assert.equal(renderConversation(repFirst), "", "the cap dropped the only REP line: no block");
});

test("rendering skips prospect lines a screen turn already carries in PROSPECT SPEECH", () => {
  const block = renderConversation(
    [line("prospect", "How much is it?"), line("rep", "It's fifty-five a seat now."), line("prospect", "And volume?")],
    { skipProspect: ["and volume? "] },
  );
  assert.equal(block, `${CONVERSATION_HEADING}\nPROSPECT: How much is it?\nREP: It's fifty-five a seat now.`);
});

test("the prompt rule is short and names RECENT CONVERSATION and the correction bullet", () => {
  assert.match(REP_CONTEXT_RULE, /^REP lines in RECENT CONVERSATION are what the rep already said\./);
  assert.match(REP_CONTEXT_RULE, /one short bullet/);
  assert.ok(REP_CONTEXT_RULE.length < 400);
  assert.ok(!/—/.test(REP_CONTEXT_RULE), "no em dashes");
});
