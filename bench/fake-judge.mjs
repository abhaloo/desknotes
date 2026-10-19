/**
 * Deterministic stand-in for the Jev judge (src/server/engines/judge.js
 * contract) so the bench measures the pipeline's mechanics at a chosen judge
 * latency, not model accuracy. `bench/jev-live.mjs` measures the real model.
 */
const INTERROGATIVE = /^(how|what|why|when|where|which|who|can|could|does|do|did|is|are|will|would|should|walk me through)\b/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tokens = (text) => String(text ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? [];

/**
 * "Same question" as the pipeline already defines it for an unrevised final
 * (a prefix whose extension is not material: < 3 new words, or the prefix
 * covers >= 2/3 of the words), but tolerating ONE substituted word, which is
 * exactly the case the rescue exists for ("pro tier" -> "pro plan").
 */
function sameQuestion(answeredFor, utterance) {
  const a = tokens(answeredFor);
  const b = tokens(utterance);
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 3) return false;
  let substitutions = 0;
  for (let i = 0; i < shorter.length; i += 1) if (shorter[i] !== longer[i]) substitutions += 1;
  const added = longer.length - shorter.length;
  const material = added >= 3 && shorter.length / longer.length < 2 / 3;
  return substitutions <= 1 && !material;
}

export function createFakeJudge({ latencyMs = 270, features = { gate: true, rescue: true } } = {}) {
  let closed = false;
  return {
    enabled: true,
    features,
    async evaluate({ utterance = "", answeredFor } = {}) {
      await sleep(latencyMs);
      if (closed) return { isQuestion: null, answersSame: null, latencyMs, error: "closed" };
      const text = String(utterance).trim();
      const isQuestion = INTERROGATIVE.test(text) || text.includes("?") ? 0.95 : 0.05;
      const answersSame = answeredFor == null ? null : sameQuestion(answeredFor, text) ? 0.95 : 0.05;
      return { isQuestion, answersSame, latencyMs, error: null };
    },
    close() {
      closed = true;
    },
  };
}
