/**
 * Question segmentation for practice sessions.
 *
 * One decision per final utterance: did the other person ask something? The
 * rule is deliberately local and deterministic — an utterance is a question
 * when it ends with a question mark or opens with an interrogative, and
 * context otherwise — because segmentation sits on the live transcript path
 * and must cost no network round trip and no model call. The decision carries
 * a printable `reason`; the debrief shows it verbatim, so "which utterance
 * triggered which answer" is never a mystery.
 */
export const QUESTION_AT = 0.5;
export const BORDERLINE_AT = 0.2;
export const MAX_RECENT = 3;

/**
 * Interrogative openers (the plan's full list — ASR finals often carry no
 * question mark, so "Which stack did you pick", "Have you used Kafka" and
 * "Describe a hard bug" must still segment as questions). The trailing `\b`
 * keeps near-misses ("issue", "canvas", "howdy") context, `(?!['’])` keeps
 * contractions ("doesn't matter") context, and alternation picks the whole
 * word so "does" wins over "do" and the reported phrase is complete.
 */
const INTERROGATIVE =
  /^(?:what|why|how|who|when|where|which|whose|whom|can|could|should|would|will|do|does|did|is|are|was|were|have|has|had|tell me|walk me through|explain|describe|give me)(?!['’])\b/i;

/** The local rule: a question mark or an interrogative opener, else context. */
export function fallbackQuestion(text) {
  const clean = String(text ?? "").trim();
  if (!clean) return { band: "small-talk", reason: "empty utterance" };
  if (/\?\s*$/.test(clean)) return { band: "question", reason: "ends with a question mark" };
  const opener = clean.match(INTERROGATIVE);
  if (opener) return { band: "question", reason: `opens with "${opener[0].toLowerCase()}"` };
  return { band: "small-talk", reason: "no question signal" };
}

/**
 * @param {{ ask?: unknown }} [options] `ask` is accepted for contract
 *   compatibility with the frozen segmenter interface and is never called:
 *   detection is pure and local, so an injected model hook would only add a
 *   round trip to the live transcript path.
 * @returns {{ consider: (utterance: {text?: string}) => Promise<{
 *   band: "question"|"maybe"|"small-talk", p: number|null,
 *   source: "judge"|"fallback", reason: string }> }}
 */
export function createQuestionSegmenter(_options = {}) {
  /** Never rejects: the transcript tap must not need a try/catch. */
  async function consider(utterance = {}) {
    const text = String(utterance?.text ?? "").trim();
    if (!text) return { band: "small-talk", p: null, source: "fallback", reason: "empty utterance" };
    return { ...fallbackQuestion(text), p: null, source: "fallback" };
  }

  return { consider };
}
