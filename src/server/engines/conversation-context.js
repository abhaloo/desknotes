/**
 * Rep context: what both speakers actually said, for answers that start later.
 *
 * The answer model otherwise never hears the rep: RECENT EXCHANGE holds the
 * app's SUGGESTED answers, so when the rep goes off-card ("it's fifty-five a
 * seat now"), a follow-up would build on the card, not on what was said.
 * The pipeline (pipeline.js) records every final transcript of both speakers
 * here and renders the result into the context of the NEXT generation; a
 * generation already streaming keeps the context it started with.
 *
 * Code filters, applied to REP lines only (prospect lines are what the
 * answer is for and are kept as heard):
 * - echo: without echo cancellation the rep's mic picks up the prospect. A
 *   rep final whose content words are mostly (ECHO_SHARE) in prospect speech
 *   heard within ECHO_WINDOW_MS either side is that echo. Prospect speech
 *   that lands AFTER the rep line removes it then.
 * - filler: once filler phrases and stopwords are removed, nothing is left
 *   ("yeah", "let me think"), or, in a line under MIN_REP_WORDS words, under
 *   2 content words ("got it, thanks"). "Use Rust instead" stays.
 * - card reading: a rep line mostly (CARD_SHARE) made of the latest answer
 *   shown to the client is the rep reading the card, which RECENT EXCHANGE
 *   already carries.
 * Echo and card reading never drop a line that adds a number ("12", "100k",
 * "fifty") or a correction word ("not", "instead", "actually") the prospect
 * speech or the card lacks: "12 partitions" over a card's "6 partitions" is
 * the rep correcting it.
 *
 * The block renders only when a REP line survives: with only prospect lines
 * the existing context already covers it, so nothing changes.
 */

import { shippedPrompt } from "./prompts.js";

/** Lines kept and rendered (oldest dropped first). */
export const CONVERSATION_LINES = 8;
/** The rendered body's cap, heading excluded (like PROSPECT SPEECH's). */
export const CONVERSATION_CHARS = 1_200;
/** One line's cap, before its speaker label. */
export const CONVERSATION_LINE_CHARS = 300;
export const CONVERSATION_HEADING = "RECENT CONVERSATION (oldest first; REP lines are what the rep actually said):";
/** Rep speech this close in time to prospect speech may be the prospect, picked up by the mic. */
export const ECHO_WINDOW_MS = 3_000;
export const ECHO_SHARE = 0.6;
export const CARD_SHARE = 0.7;
export const MIN_REP_WORDS = 4;

/**
 * Added to the system prompt (answerer.js systemMessage) only when the
 * Context carries a REP line: what the lines are and how to use them.
 */
export const REP_CONTEXT_RULE = shippedPrompt("rules/rep-context");

/**
 * The REP_CONTEXT switch: 0/false/off -> false, 1/true/on or unset -> true,
 * anything else -> null (the caller keeps the default and says so).
 */
export function parseRepContextSwitch(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "" || value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  return null;
}

/** Small on purpose: the shares only need the words that carry meaning. */
const STOPWORDS = new Set(
  (
    "a an the and or but so if then than to of in on at by for from with as about into over " +
    "is are was were be been being am do does did done have has had can could will would should may might " +
    "i me my we us our you your he him his she her it its they them their this that these those there here " +
    "what which who how when where why any some all just very really also too not"
  ).split(" "),
);

/** Whole-line filler, longest first so "let me think" goes before "let". */
const FILLER_PHRASES = [
  "that's a good question",
  "thats a good question",
  "that's a great question",
  "that makes sense",
  "thanks so much",
  "good question",
  "makes sense",
  "sounds good",
  "thank you",
  "no problem",
  "thanks",
  "perfect",
  "great question",
  "let me think",
  "let me see",
  "you know",
  "i mean",
  "i see",
  "got it",
  "uh huh",
  "mm hmm",
  "mhm",
  "yeah",
  "yep",
  "yes",
  "yup",
  "okay",
  "ok",
  "alright",
  "right",
  "sure",
  "so",
  "um",
  "umm",
  "uh",
  "er",
  "ah",
  "oh",
  "hmm",
  "mm",
  "well",
  "like",
  "cool",
  "great",
  "nice",
  "totally",
  "exactly",
  "absolutely",
];

/** Number words; digits are matched by DIGIT_RUN. */
const NUMBER_WORDS = new Set(
  (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen " +
    "seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion"
  ).split(" "),
);

/** Words that mark a correction, apostrophes joined as normalizeWords does. */
const CORRECTION_WORDS = new Set("instead rather actually not no never wrong isnt arent dont doesnt wont cant".split(" "));

/** "12", "100k"; "1.5" reaches it as "1" and "5". */
const DIGIT_RUN = /^\d+[a-z]*$/;

/** Lowercase, apostrophes joined ("it's" -> "its"), every other symbol a space. */
function normalizeWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** @returns {string[]} the line's content words, in order. */
export function contentWords(text) {
  const clean = normalizeWords(text);
  return clean ? clean.split(" ").filter((word) => !STOPWORDS.has(word)) : [];
}

/**
 * Once filler and stopwords are removed: nothing left, or under 2 content
 * words in a line under MIN_REP_WORDS words.
 */
export function isFillerLine(text) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  let rest = ` ${normalizeWords(text)} `;
  for (const phrase of FILLER_PHRASES) {
    const spaced = ` ${normalizeWords(phrase)} `;
    while (rest.includes(spaced)) rest = rest.replace(spaced, " ");
  }
  const left = contentWords(rest).length;
  return words.length < MIN_REP_WORDS ? left < 2 : left === 0;
}

/** Share of `text`'s content words found in `pool` (0 when `text` has none). */
function sharedShare(text, pool) {
  const words = contentWords(text);
  if (words.length === 0) return 0;
  const known = new Set(pool.flatMap((entry) => contentWords(entry)));
  return words.filter((word) => known.has(word)).length / words.length;
}

/** `text` has a number or a correction word that `pool` lacks: the rep changed it, not repeated it. */
function addsNumberOrCorrection(text, pool) {
  const known = new Set(pool.flatMap((entry) => normalizeWords(entry).split(" ")));
  return normalizeWords(text)
    .split(" ")
    .some((word) => (DIGIT_RUN.test(word) || NUMBER_WORDS.has(word) || CORRECTION_WORDS.has(word)) && !known.has(word));
}

/** @param {string[]} prospectTexts  prospect speech heard near the rep line */
export function isEcho(repText, prospectTexts) {
  const pool = Array.isArray(prospectTexts) ? prospectTexts : [];
  return pool.length > 0 && sharedShare(repText, pool) >= ECHO_SHARE && !addsNumberOrCorrection(repText, pool);
}

/** @param {string} cardText  the latest answer shown to the client */
export function isCardReading(repText, cardText) {
  return (
    typeof cardText === "string" &&
    cardText.trim() !== "" &&
    sharedShare(repText, [cardText]) >= CARD_SHARE &&
    !addsNumberOrCorrection(repText, [cardText])
  );
}

/**
 * The ring of lines, `{who: "prospect"|"rep", text, at}`, oldest first.
 * `now` is the pipeline's injected clock.
 *
 * @param {{now?: () => number}} [options]
 */
export function createConversationLog({ now = Date.now } = {}) {
  const ring = [];
  let partial = null; // latest prospect speech not yet a line: { text, at }

  function push(entry) {
    ring.push(entry);
    while (ring.length > CONVERSATION_LINES) ring.shift();
  }

  /** Prospect speech within the echo window of `at`: finals in the ring plus the latest partial. */
  function prospectNear(at) {
    const near = (entry) => Math.abs(entry.at - at) <= ECHO_WINDOW_MS;
    const texts = ring.filter((entry) => entry.who === "prospect" && near(entry)).map((entry) => entry.text);
    if (partial && near(partial)) texts.push(partial.text);
    return texts;
  }

  /** Prospect speech just arrived: drop rep lines it shows were an echo of it. */
  function dropLateEchoes(at) {
    for (let i = ring.length - 1; i >= 0; i -= 1) {
      const entry = ring[i];
      if (entry.who === "rep" && Math.abs(entry.at - at) <= ECHO_WINDOW_MS && isEcho(entry.text, prospectNear(entry.at))) {
        ring.splice(i, 1);
      }
    }
  }

  function addProspect(text) {
    const clean = String(text ?? "").trim();
    if (!clean) return;
    const at = now();
    push({ who: "prospect", text: clean, at });
    dropLateEchoes(at);
  }

  /**
   * Prospect words heard but not (yet) a line: a partial, or a final before
   * the turn it starts reads the ring (an echo that landed first must not
   * reach that turn). Only the echo check uses it.
   */
  function noteProspectSpeech(text) {
    const clean = String(text ?? "").trim();
    if (!clean) return;
    const at = now();
    partial = { text: clean, at };
    dropLateEchoes(at);
  }

  /**
   * @param {string} text  a rep final
   * @param {{card?: string}} [options]  card: the latest answer shown to the client
   * @returns {null|"filler"|"card"|"echo"}  null = kept, else why it was dropped
   */
  function addRep(text, { card = "" } = {}) {
    const clean = String(text ?? "").trim();
    if (isFillerLine(clean)) return "filler";
    if (isCardReading(clean, card)) return "card";
    const at = now();
    if (isEcho(clean, prospectNear(at))) return "echo";
    push({ who: "rep", text: clean, at });
    return null;
  }

  function clear() {
    ring.length = 0;
    partial = null;
  }

  return {
    addProspect,
    noteProspectSpeech,
    addRep,
    clear,
    /** A copy: a generation's context must not move when later lines arrive. */
    lines: () => ring.map((entry) => ({ ...entry })),
  };
}

export function hasRepLine(lines) {
  return Array.isArray(lines) && lines.some((entry) => entry?.who === "rep");
}

function sameLine(a, b) {
  const clean = (value) => String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return clean(a) === clean(b);
}

/**
 * The RECENT CONVERSATION block, or "" when no REP line is left to show.
 *
 * @param {{who: string, text: string}[]} lines  oldest first
 * @param {{skipProspect?: string[]}} [options]  skipProspect: prospect lines the
 *   context already carries (a screen turn's PROSPECT SPEECH): not repeated.
 */
export function renderConversation(lines, { skipProspect = [] } = {}) {
  const skip = Array.isArray(skipProspect) ? skipProspect : [];
  const kept = (Array.isArray(lines) ? lines : [])
    .filter((entry) => (entry?.who === "rep" || entry?.who === "prospect") && typeof entry.text === "string" && entry.text.trim())
    .filter((entry) => entry.who === "rep" || !skip.some((other) => sameLine(other, entry.text)))
    .slice(-CONVERSATION_LINES)
    .map((entry) => ({
      who: entry.who,
      line: `${entry.who === "rep" ? "REP" : "PROSPECT"}: ${entry.text.trim().slice(0, CONVERSATION_LINE_CHARS)}`,
    }));
  // Newest last and kept first when the cap bites.
  while (kept.length > 1 && kept.map((entry) => entry.line).join("\n").length > CONVERSATION_CHARS) kept.shift();
  if (!hasRepLine(kept)) return "";
  return `${CONVERSATION_HEADING}\n${kept.map((entry) => entry.line).join("\n").slice(0, CONVERSATION_CHARS)}`;
}
