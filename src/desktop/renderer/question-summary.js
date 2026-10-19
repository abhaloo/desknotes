/**
 * The ask inside a long question, as one short line for the question line
 * above an answer. A prospect's question often sets a scene over several
 * sentences before it asks anything ("We run fifty reps across three
 * regions... How would you roll this out?"); the line names the ask
 * ("How would you roll this out"), not the scene.
 *
 * Pure text rules, no model call: split into sentences, drop list numbers and
 * spoken filler, pick the first sentence that asks something (a question mark
 * or an ask cue), else the first sentence, and trim its lead-in.
 */

/** A period after one of these does not end a sentence. */
const ABBREVIATIONS = new Set(["e.g.", "i.e.", "vs.", "etc.", "mr.", "dr.", "approx."]);

/** A sentence ends at `.`, `?` or `!` when the next word starts with a capital or a digit. */
const SENTENCE_END = /[.?!](?=\s+[\p{Lu}\d])/gu;

const LIST_NUMBER = /^\d+[.)]\s+/;
const FILLER = /^(?:so|okay|ok|alright|well|um|uh|and|now|right),?\s+/i;
const LETTER = /\p{L}/u;

/** A sentence that starts with one of these asks for something, even without a question mark. */
const ASK_CUE = new RegExp(
  `^(?:${[
    "your task is",
    "your job is",
    "the task is",
    "i want you to",
    "i['’]d like you to",
    "i would like you to",
    "we['’]d like you to",
    "we want you to",
    "please",
    "design",
    "build",
    "implement",
    "write",
    "walk me through",
    "walk us through",
    "talk me through",
    "explain",
    "describe",
    "compare",
    "tell me",
    "tell us",
    "give me",
    "show me",
    "estimate",
    "define",
    "how",
    "what",
    "why",
    "when",
    "which",
    "where",
    "who",
    "can you",
    "could you",
    "would you",
    "will you",
    "do you",
    "did you",
    "have you",
  ].join("|")})\\b`,
  "i",
);

/** Lead-ins that carry no part of the ask. */
const LEAD_IN =
  /^(?:your task is to|your job is to|the task is to|i want you to|i['’]d like you to|i would like you to|we['’]d like you to|we want you to|please),?\s+/i;

/** "Could you explain X?" names the ask as "Explain X"; "Could you say why?" stays a question. */
const POLITE_REQUEST =
  /^(?:can|could|would|will) you,?\s+(?:please,?\s+)?(?=(?:explain|describe|tell|walk|talk|design|compare|give|show|share|define|estimate|implement|write|build)\b)/i;

/**
 * @param {string} text the question as heard or typed
 * @returns {string} the ask in one short sentence; "" for blank text
 */
export function summarizeQuestion(text) {
  const collapsed = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!collapsed) return "";
  const sentences = splitSentences(collapsed).map(cleanSentence).filter((sentence) => LETTER.test(sentence));
  if (sentences.length === 0) return "";
  const ask = sentences.find((sentence) => sentence.endsWith("?") || ASK_CUE.test(sentence)) ?? sentences[0];
  return rewriteAsk(ask);
}

function splitSentences(text) {
  const sentences = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + 1;
    if (match[0] === "." && endsWithAbbreviation(text.slice(start, end))) continue;
    sentences.push(text.slice(start, end).trim());
    start = end;
  }
  sentences.push(text.slice(start).trim());
  return sentences;
}

function endsWithAbbreviation(sentence) {
  const word = sentence.slice(sentence.lastIndexOf(" ") + 1).replace(/^[^\p{L}]+/u, "");
  return ABBREVIATIONS.has(word.toLowerCase());
}

/** Drops a leading list number ("2. ", "3) ") and spoken filler ("So, um, ..."). */
function cleanSentence(sentence) {
  return stripFiller(sentence.replace(LIST_NUMBER, ""));
}

function stripFiller(sentence) {
  let text = sentence;
  for (let next = text.replace(FILLER, ""); next !== text; next = text.replace(FILLER, "")) text = next;
  return text;
}

function rewriteAsk(sentence) {
  let text = stripFiller(stripLead(sentence, LEAD_IN));
  const request = stripLead(text, POLITE_REQUEST);
  if (request !== text) text = request.replace(/\?$/, "");
  text = text.replace(/\.$/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A lead-in is removed only when words remain after it. */
function stripLead(text, pattern) {
  const rest = text.replace(pattern, "");
  return LETTER.test(rest) ? rest : text;
}
