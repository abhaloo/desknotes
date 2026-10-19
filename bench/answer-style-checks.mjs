/**
 * Humanizer tells, scored per answer (see ~/.claude/skills/humanizer). Pure
 * functions so the scoring itself is tested; bench/answer-style.mjs runs the
 * live answers through them.
 */
export const AI_VOCABULARY = Object.freeze([
  "actually", "delve", "crucial", "pivotal", "robust", "seamless", "seamlessly", "leverage",
  "leveraging", "showcase", "showcasing", "testament", "landscape", "vibrant",
  "additionally", "furthermore", "underscore", "underscores", "foster", "fostering",
  "tapestry", "intricate", "garner", "interplay", "streamline", "streamlined",
  "empower", "elevate", "synergy", "holistic",
]);

const OPENERS = /^\s*(?:(?:great|good|excellent|fantastic) question\b|(?:certainly|absolutely|of course|sure thing)\b)/i;
const CLOSERS = /\b(?:hope (?:this|that) helps|let me know|happy to (?:go deeper|elaborate|share more|dive)|feel free to|does that make sense)\b/i;
/** "not only... but", "it's not X, it's Y", and the tailing contrast "..., not just X". */
const NEGATIVE_PARALLEL = /\bnot (?:only|just)\b[^.!?]*\bbut\b|\bit'?s not\b[^.!?]*,\s*it'?s\b|,\s*not just\b/i;
/** The answer breaks the rep's voice to talk about itself as a model. */
const DISCLAIMER = /\b(?:i don'?t have (?:any )?(?:access|information)|i can'?t access|as an ai\b|i'?m an ai\b|language model)/i;
const HARD = {
  dashes: /[\u2013\u2014]|\s--\s/g,
  markdown: /\*\*|__|^[ \t]*(?:#{1,6}|[-*\u2022]|\d{1,3}[.)])[ \t]+/gm,
  emoji: /\p{Extended_Pictographic}/gu,
  curly: /[\u2018\u2019\u201C\u201D]/g,
};
const REFUSAL = /\b(?:i don'?t know|i'?m not sure|no information|can'?t say|not mentioned|don'?t have (?:that|those) details)\b/i;

const count = (re, text) => (String(text).match(re) ?? []).length;

export function scoreAnswer({ raw = "", delivered = "", expect = [], uncovered = false } = {}) {
  const trimmed = delivered.trim();
  const deliveredHard = Object.fromEntries(Object.entries(HARD).map(([key, re]) => [key, count(re, delivered)]));
  const lower = delivered.toLowerCase();
  return {
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    sentences: delivered.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim()).length,
    opener: OPENERS.test(delivered),
    closer: CLOSERS.test(delivered),
    negativeParallel: NEGATIVE_PARALLEL.test(delivered),
    disclaimer: DISCLAIMER.test(delivered),
    aiHits: AI_VOCABULARY.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(delivered)),
    rawDashes: count(HARD.dashes, raw),
    deliveredHard,
    hardTotal: Object.values(deliveredHard).reduce((sum, value) => sum + value, 0),
    factsMissing: expect.filter((fact) => !lower.includes(String(fact).toLowerCase())),
    refused: uncovered ? REFUSAL.test(delivered) : false,
  };
}

export function summarize(scores) {
  const n = scores.length;
  const total = (pick) => scores.reduce((sum, score) => sum + pick(score), 0);
  return {
    answers: n,
    openers: scores.filter((score) => score.opener).length,
    closers: scores.filter((score) => score.closer).length,
    negativeParallel: scores.filter((score) => score.negativeParallel).length,
    disclaimers: scores.filter((score) => score.disclaimer).length,
    aiHits: total((score) => score.aiHits.length),
    rawDashes: total((score) => score.rawDashes),
    hardTotal: total((score) => score.hardTotal),
    avgSentences: n ? Number((total((score) => score.sentences) / n).toFixed(1)) : 0,
    avgWords: n ? Math.round(total((score) => score.words) / n) : 0,
    factsMissing: total((score) => score.factsMissing.length),
    refusals: scores.filter((score) => score.refused).length,
  };
}

export function passes(summary) {
  return (
    summary.hardTotal === 0 &&
    summary.openers === 0 &&
    summary.closers === 0 &&
    summary.disclaimers === 0 &&
    summary.aiHits * 10 <= summary.answers
  );
}
