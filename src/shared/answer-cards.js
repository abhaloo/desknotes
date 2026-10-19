/**
 * Answer cards: an answer
 * is a short card a rep can read in a few seconds.
 *
 * A card is a "VERDICT:" line, then one labelled line for each part the
 * question asks about, then a "TRADE-OFF:" line: full sentences that follow
 * from each other, with real technical content. A detail card (the question
 * asks for specifics, `wantsDetail`) gives exact names, steps, formulas or
 * code in the same shape. The answerer adds the card rule after
 * the user's own instructions and checks the first line; the spoken-text
 * filter stops the answer at CARD_LIMITS; the renderer shows the VERDICT line
 * as a headline and a line's leading label as a quiet tag.
 *
 * Off (Settings "Short answer cards", ANSWER_CARDS=0) every prompt, filter
 * output and frame is what it was before the feature.
 */

/** app-preferences.json field and settings:get/set key. */
export const ANSWER_CARDS_SETTING = "answerCards";

/** Env spelling of the setting for a standalone server: 0/false/off turns it off. */
export const ANSWER_CARDS_ENV = "ANSWER_CARDS";

/**
 * lines: bullet lines in a card (VERDICT, up to six parts, TRADE-OFF, one spare);
 * detailLines: the same for a detail card;
 * codeLines: lines inside fenced code blocks, per answer;
 * lineWords: words in one card line, bullet and label included (the prompt
 * asks for 20 or fewer; a longer line continues on the next line,
 * src/server/engines/card-line-cap.js);
 * lineSegments: lines one card line may fill before the rest of it is cut.
 */
export const CARD_LIMITS = Object.freeze({ lines: 9, detailLines: 9, codeLines: 80, lineWords: 30, lineSegments: 3 });

export const VERDICT_LABEL = "VERDICT";

/** The closing line: past the line budget the filter still lets one line with this label through. */
export const TRADE_OFF_LABEL = "TRADE-OFF";

/** Labels of a card's closing line: the one line kept after the line budget is spent. */
export const CLOSING_LABELS = Object.freeze([TRADE_OFF_LABEL, "NEXT STEP"]);

/**
 * Words that ask for specifics. "exactly-once" is a term, not a request;
 * "walk through how you would..." asks for a walk-through, which the default
 * card answers with its opening move.
 */
const DETAIL_CUES = Object.freeze([
  /\bexact(?:ly)?\b(?![\s-]+once)/i,
  /\bunder the hood\b/i,
  /\binternals?\b/i,
  /\bstep[\s-]by[\s-]step\b/i,
  /\bwalk (?:me|us) through (?:how|the code|exactly)\b/i,
  /\b(?:which|what) (?:exact )?(?:fields|columns|keys|indexes)\b/i,
  /\bschema\b/i,
  /\bformulas?\b/i,
  /\b(?:time|space|memory|runtime) complexity\b|\bbig[\s-]?o\b|\btime and (?:memory|space)\b|\bamorti[sz]ed\b/i,
  // "code-generation" and "code review" name a topic, not a request for code.
  /\b(?:pseudo-?)?code\b(?![\s-]+(?:generation|review|reviews|reviewers?|quality|coverage))/i,
  // Coding rounds: the answer is the code. "Implement a hiring process" is not one.
  /\bimplement (?:it|this|that|the (?:solution|function|method|class|algorithm|code)|an? (?:[\w-]+ ){0,2}(?:function|method|class|algorithm|cache|queue|stack|heap|trie|parser|iterator|list|tree|graph|map|limiter|data structure))\b/i,
  /\bwrite (?:a|an|the|some) (?:\w+ )?(?:function|method|class|program|query|script|solution)\b/i,
  /\bsolve (?:it|this|that|the problem)\b|\bgiven (?:an?|the) (?:\w+ )?(?:array|list|string|tree|graph|matrix|integer|number|linked list)\b/i,
  /\boptimi[sz]e (?:it|this|that|the code|the solution)\b|\bdo better\b|\broom for improvement\b/i,
  /\bhow many\b|\bwhat numbers\b/i,
  /\bin (?:more )?detail\b|\bdeep[\s-]?dive\b|\bgo deeper\b|\bmore detail\b/i,
]);

/** True when the question asks for specifics: the answer is a detail card. */
export function wantsDetail(question) {
  const text = typeof question === "string" ? question : "";
  return DETAIL_CUES.some((cue) => cue.test(text));
}

/** True when a delivered line ("• VERDICT: ...") is the card's VERDICT line. */
export function isVerdictLine(line) {
  return /^\s*(?:[•-]\s*)?(?:\*\*)?\s*verdict\s*:/i.test(typeof line === "string" ? line : "");
}

const VERDICT_HEAD = /^\s*(?:[•-]\s*)?(?:\*\*)?\s*/;

/** "yes" when a first line so far is a VERDICT line, "maybe" while it could still become one, "no" once it cannot. */
export function verdictLineState(line) {
  const text = typeof line === "string" ? line : "";
  if (isVerdictLine(text)) return "yes";
  if (/^\s*(?:[•-]\s*)?\*?$/.test(text)) return "maybe"; // the list marker is still growing: "", "•", "• ", "• *"
  const label = text.slice(VERDICT_HEAD.exec(text)[0].length);
  return /^(?:v(?:e(?:r(?:d(?:i(?:c(?:t\s*)?)?)?)?)?)?)?$/i.test(label) ? "maybe" : "no";
}

/**
 * A line's leading uppercase label ("VERDICT", "TRADE-OFF", "METRICS & SLA",
 * "PITFALLS (Java collisions)"), or null. The renderer keeps its own copy of
 * this pattern (stream-paint.js CARD_LABEL; a test keeps them equal).
 */
export const CARD_LABEL = /^(\s*(?:•\s*|-\s+)?)([A-Z][A-Z0-9&/'-]+(?: [A-Z0-9&/'-]+)*(?: \([^)\n]{1,40}\))?):\s+([\s\S]*)$/;

/** @returns {{bullet: string, label: string, rest: string}|null} */
export function cardLabel(line) {
  const match = CARD_LABEL.exec(typeof line === "string" ? line : "");
  return match ? { bullet: match[1], label: match[2], rest: match[3] } : null;
}

/**
 * The ANSWER_CARDS switch: 0/false/off -> false, 1/true/on or unset -> true,
 * anything else -> null (the caller keeps the default and says so).
 */
export function parseAnswerCardsSwitch(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "" || value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  return null;
}
