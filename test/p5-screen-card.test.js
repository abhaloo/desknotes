import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScreenCards,
  SCREEN_LABEL_WORDS,
  SCREEN_STUB_NOTE,
  screenCardNotes,
  screenLabel,
} from "../src/desktop/renderer/answer-buffer.js";

/**
 * "Analyse screen shows visible results": a compact card recording what was
 * captured (the vision reading and a status). The answer to a screen turn
 * streams in the main Streaming answer field like any other answer.
 *
 * The renderer has no DOM under `bun test`, so the card model (numbering,
 * dedup, states, notes) is covered behaviorally here and the DOM surface
 * (containers, frame wiring, styles) gets static contract checks against the
 * real renderer files.
 */
const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, "..", "src", "desktop", "renderer");
const readRenderer = (file) => readFileSync(join(rendererDir, file), "utf8");

const okQuestion = (overrides = {}) => ({
  status: "ok",
  kind: "question",
  dedup: false,
  solve: "not_requested",
  summary: 'Visible question: "How would you cache this?"',
  ...overrides,
});

test("the command reply and the pushed frame render one card", () => {
  const cards = new ScreenCards();
  const reply = { commandId: "cmd_1", analysisId: "an_1", ...okQuestion() };
  const frame = { command_id: "cmd_1", analysisId: "an_1", ...okQuestion() };

  const first = cards.ingest(reply, 10);
  const second = cards.ingest(frame, 20);

  assert.equal(first.created, true);
  assert.equal(first.card.number, 1);
  assert.equal(first.card.summary, 'Visible question: "How would you cache this?"');
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.card, first.card, "the duplicate returns the already-rendered card");
  assert.equal(cards.count, 1);
});

test("arrival order does not matter: the frame may create the card first", () => {
  const cards = new ScreenCards();
  const frame = { command_id: "cmd_2", analysisId: "an_2", ...okQuestion() };
  const reply = { commandId: "cmd_2", analysisId: "an_2", ...okQuestion() };

  assert.equal(cards.ingest(frame, 1).created, true);
  assert.equal(cards.ingest(reply, 2).created, false);
  assert.equal(cards.count, 1);
});

test("the HTTP fallback reply (no command id) dedups on the analysis id", () => {
  const cards = new ScreenCards();
  const first = cards.ingest({ analysisId: "an_http", ...okQuestion() }, 1);
  const second = cards.ingest({ analysis_id: "an_http", ...okQuestion() }, 2);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(cards.count, 1);
});

test("a command-less reply is adopted by a later frame carrying its analysis id", () => {
  const cards = new ScreenCards();
  const reply = cards.ingest({ analysisId: "an_x", ...okQuestion() }, 1);
  const frame = cards.ingest({ command_id: "cmd_x", analysis_id: "an_x", ...okQuestion() }, 2);
  assert.equal(reply.created, true);
  assert.equal(frame.created, false, "one analysis must not render twice");
  assert.equal(cards.count, 1);
});

test("a re-analysis of the same image is a new numbered card with the seen-before badge", () => {
  const cards = new ScreenCards();
  const first = cards.ingest({ command_id: "c1", analysis_id: "an_same", ...okQuestion() }, 1);
  const second = cards.ingest({ command_id: "c2", analysis_id: "an_same", ...okQuestion({ dedup: true }) }, 2);
  assert.equal(first.created, true);
  assert.equal(second.created, true, "the server dedup verdict is a badge, not a suppression");
  assert.equal(second.card.number, 2);
  assert.equal(second.card.dedup, true);
  assert.equal(cards.count, 2);
});

test("cards number per session; reset starts the numbering over", () => {
  const cards = new ScreenCards();
  assert.equal(cards.ingest({ command_id: "a", ...okQuestion() }, 1).card.number, 1);
  assert.equal(cards.ingest({ command_id: "b", ...okQuestion() }, 2).card.number, 2);
  assert.equal(cards.ingest({ command_id: "c", ...okQuestion() }, 3).card.number, 3);
  cards.reset();
  assert.equal(cards.count, 0);
  assert.equal(cards.ingest({ command_id: "d", ...okQuestion() }, 4).card.number, 1);
});

test("the card list is bounded; evicted keys may render again", () => {
  const cards = new ScreenCards({ maxCards: 2 });
  cards.ingest({ command_id: "a", ...okQuestion() }, 1);
  cards.ingest({ command_id: "b", ...okQuestion() }, 2);
  const third = cards.ingest({ command_id: "c", ...okQuestion() }, 3);
  assert.equal(third.card.number, 3);
  assert.deepEqual(
    cards.cards.map((card) => card.number),
    [2, 3],
  );
  assert.equal(cards.ingest({ command_id: "a", ...okQuestion() }, 4).created, true);
});

test("stub analyses keep the honest no-vision-model note", () => {
  const cards = new ScreenCards();
  const { card } = cards.ingest({ command_id: "stub_1", ...okQuestion({ stub: true, summary: "a slide about caching" }) }, 1);
  assert.equal(card.stub, true);
  assert.equal(card.solve, null, "enum sentinels are never text");
  assert.equal(screenLabel(card), "a slide about caching");
  assert.deepEqual(screenCardNotes(card), [SCREEN_STUB_NOTE]);
  assert.match(SCREEN_STUB_NOTE, /DEEPSEEK_API_KEY/);
  assert.equal(SCREEN_STUB_NOTE, "stub analysis - no vision LLM configured (set DEEPSEEK_API_KEY for real analysis)");
});

test("a successful capture is a one-line record: a label of at most six words, no description", () => {
  assert.equal(SCREEN_LABEL_WORDS, 6);
  const cards = new ScreenCards();
  // The title wins over the full reading, which is answer context only.
  const { card } = cards.ingest({ command_id: "ok_1", ...okQuestion({ title: "Caching question" }) }, 1);
  assert.equal(screenLabel(card), "Caching question");
  assert.deepEqual(screenCardNotes(card), []);
  // A long title is cut to six words.
  const wordy = cards.ingest({ command_id: "w1", ...okQuestion({ title: "Design a URL shortener for one hundred million users" }) }, 2).card;
  assert.equal(screenLabel(wordy), "Design a URL shortener for one…");
  // No title: the start of the reading; nothing at all: the kind; bare: empty.
  const untitled = cards.ingest({ command_id: "o1", status: "ok", kind: "other", dedup: false, summary: "a video call with two people and a shared slide" }, 3).card;
  assert.equal(screenLabel(untitled), "a video call with two people…");
  const kindOnly = cards.ingest({ command_id: "k1", status: "ok", kind: "code", dedup: false }, 4).card;
  assert.equal(screenLabel(kindOnly), "code");
  const bare = cards.ingest({ command_id: "b1", status: "ok", kind: "", dedup: false }, 5).card;
  assert.equal(screenLabel(bare), "");
});

test("failed and empty results surface their own state", () => {
  const cards = new ScreenCards();
  const failed = cards.ingest(
    { command_id: "f1", status: "failed", kind: "", dedup: false, solve: null, error: "capture failed", failure: "upload" },
    1,
  ).card;
  assert.equal(screenLabel(failed), "analysis failed");
  assert.deepEqual(screenCardNotes(failed), ["capture failed", "failure: upload"]);

  const failedNoError = cards.ingest(
    { command_id: "f2", status: "failed", kind: "", dedup: false, solve: null, failure: "timeout" },
    2,
  ).card;
  assert.deepEqual(screenCardNotes(failedNoError), ["failure: timeout"]);

  const empty = cards.ingest({ command_id: "e1", status: "empty", kind: "", dedup: false, solve: null }, 3).card;
  assert.equal(screenLabel(empty), "nothing on screen");
  assert.deepEqual(screenCardNotes(empty), []);
});

test("renderer surface: numbered record cards in the answer area, no second answer on the lane", () => {
  const html = readRenderer("index.html");
  const app = readRenderer("app.js");
  const css = readRenderer("styles.css");

  // #screen-cards sits inside the streaming-answer section.
  assert.match(html, /id="screen-cards" class="screen-cards"/);
  assert.match(html, /id="answer-text"[\s\S]*id="screen-cards"/);

  // Both delivery paths feed the same deduped ingest; the pushed frame is not
  // dropped on the floor.
  assert.match(app, /frame\.type === "screen\.result"/);
  assert.match(app, /onScreenResult\(frame\.data \?\? frame\)/);
  assert.match(app, /const card = onScreenResult\(result\)/);
  assert.match(app, /new ScreenCards\(\)/);
  assert.match(app, /els\.screenCards\.append/);
  assert.match(app, /createScreenCard/);

  // The screen turn's answer is an ordinary turn: nothing screen-specific
  // writes answer text anywhere else.
  for (const gone of ["createScreenAnswer", "screenAnswerText", "laneScreen"]) {
    assert.equal(app.includes(gone), false, `app.js must not keep ${gone}`);
  }

  // A failure still toasts, with its typed tag.
  assert.match(app, /card\?\.status === "failed"/);
  assert.match(app, /showToast\(`screen: /);

  // Untrusted analysis text is never injected as HTML.
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(app), "cards must be built with textContent");

  // The card is one line: number, short label, badges. No description body.
  assert.match(app, /label\.textContent = screenLabel\(card\)/);
  assert.equal(app.includes("screen-card-summary"), false, "no description paragraph");
  for (const selector of [".screen-cards", ".screen-card", ".screen-card-label", ".screen-dedup", ".screen-card-note"]) {
    assert.ok(css.includes(selector), `styles.css must define ${selector}`);
  }
});

test("the answer badge turns orange the instant a capture starts, until its reading lands", () => {
  const app = readRenderer("app.js");
  const css = readRenderer("styles.css");
  assert.match(app, /bridge\?\.on\(CH\.SCREEN_ANALYSIS_STATE \?\? IPC\.SCREEN_ANALYSIS_STATE, \(payload\) => setScreenBusy\(payload\?\.busy === true\)\)/);
  assert.match(app, /if \(view\.screenBusy\) \{\s*state = "analysing screen";\s*dataState = "screen";/);
  assert.match(app, /SCREEN_BUSY_MAX_MS/, "a lost idle broadcast never leaves it orange");
  assert.match(css, /#answer-state\[data-state="screen"\] \{[^}]*rgba\(251, 146, 60/, "orange while a screen is read");
  assert.match(css, /#answer-state\[data-state="active"\] \{[^}]*var\(--accent\)/, "green while an answer streams");
  assert.match(css, /prefers-reduced-motion: reduce/);
});
