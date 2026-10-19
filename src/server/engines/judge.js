/**
 * Optional System One judge (TypeSafe Jev) for the turn pipeline.
 *
 * Up to three yes/no judgments, asked together in ONE request when they apply:
 *   is_question  - is the prospect's utterance something the rep should answer now?
 *   answers_same - would the answer already written for `answeredFor` answer `utterance`?
 *   is_complete  - has the prospect finished their thought? Asked only with
 *                  `askComplete`, at a pause, to decide whether a held answer is shown.
 * The pipeline never waits on a verdict before starting work: verdicts only
 * cancel a turn or rescue an existing answer, so a slow, failed or disabled
 * judge degrades to the behaviour without it. `evaluate` never rejects.
 *
 * Transport: the same hardening as the other providers (provider-http.js):
 * https or loopback only, no redirects, key-free errors, capped body.
 */
import { checkProviderUrl, providerFetch, readJsonCapped } from "./provider-http.js";
import { promptJson, shippedPrompt } from "./prompts.js";

export const DEFAULT_JUDGE_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_JUDGE_MODEL = "jev-latest";
export const DEFAULT_JUDGE_TIMEOUT_MS = 500;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 5000;
const MAX_JUDGE_JSON_BYTES = 64 * 1024;
const MAX_RECENT_LINES = 3;

/** The criteria come from prompts/<set>/judge.json: literal on purpose, Jev reads instructions at face value. */
export const JUDGE_QUESTIONS = Object.freeze(JSON.parse(shippedPrompt("judge")));

const verdict = (isQuestion, answersSame, latencyMs, error, isComplete = null) => ({
  isQuestion,
  answersSame,
  isComplete,
  latencyMs,
  error,
});

export const DISABLED_JUDGE = Object.freeze({
  enabled: false,
  features: Object.freeze({ gate: false, rescue: false }),
  evaluate: async () => verdict(null, null, 0, "disabled"),
  close() {},
});

/** "gate,rescue" | ["gate"] | { gate: true } -> { gate, rescue } */
export function parseFeatures(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { gate: !!value.gate, rescue: !!value.rescue };
  }
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  const names = new Set(list.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
  return { gate: names.has("gate"), rescue: names.has("rescue") };
}

/**
 * Judge options from the environment, or null when the judge is off.
 * TYPESAFE_API_KEY is the only key it uses: it never borrows the LLM key.
 * @param {Record<string, string|undefined>} env
 */
export function judgeOptionsFromEnv(env = process.env) {
  const apiKey = env.TYPESAFE_API_KEY;
  const features = parseFeatures(env.JEV_JUDGMENTS);
  if (!apiKey || (!features.gate && !features.rescue)) return null;
  const requested = Number.parseInt(env.JEV_TIMEOUT_MS ?? "", 10);
  return {
    apiKey,
    baseUrl: env.TYPESAFE_BASE_URL || DEFAULT_JUDGE_BASE_URL,
    model: env.TYPESAFE_MODEL || DEFAULT_JUDGE_MODEL,
    timeoutMs: Number.isFinite(requested)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, requested))
      : DEFAULT_JUDGE_TIMEOUT_MS,
    features,
  };
}

/** The `/v1/systemone` body: one state, one to three Noul questions. */
export function buildJudgeRequest({ model = DEFAULT_JUDGE_MODEL, utterance, answeredFor, recent, askComplete = false } = {}) {
  const state = { utterance: String(utterance ?? "").trim() };
  const answered = String(answeredFor ?? "").trim();
  if (answered) state.answered_question = answered;
  const lines = Array.isArray(recent) ? recent.map((line) => String(line ?? "").trim()).filter(Boolean) : [];
  if (lines.length > 0) state.recent_prospect_lines = lines.slice(-MAX_RECENT_LINES);
  const criteria = promptJson("judge");
  const questions = { is_question: criteria.is_question };
  if (answered) questions.answers_same = criteria.answers_same;
  if (askComplete) questions.is_complete = criteria.is_complete;
  return { model, state, questions };
}

function probability(answer) {
  const value = answer?.noul;
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

export function parseJudgeResponse(payload) {
  const answers = payload && typeof payload === "object" ? payload.answers : null;
  return {
    isQuestion: probability(answers?.is_question),
    answersSame: probability(answers?.answers_same),
    isComplete: probability(answers?.is_complete),
  };
}

const normalize = (value) => String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * @param {{apiKey?: string, baseUrl?: string, model?: string, timeoutMs?: number,
 *   features?: string|string[]|{gate?: boolean, rescue?: boolean}, fetchImpl?: Function,
 *   log?: Function, now?: Function, cacheSize?: number}} [options]
 */
export function createJudge({
  apiKey,
  baseUrl = DEFAULT_JUDGE_BASE_URL,
  model = DEFAULT_JUDGE_MODEL,
  timeoutMs = DEFAULT_JUDGE_TIMEOUT_MS,
  features,
  fetchImpl = globalThis.fetch,
  log,
  now = Date.now,
  cacheSize = 64,
} = {}) {
  const logger = typeof log === "function" ? log : () => {};
  const flags = parseFeatures(features);
  if (!apiKey || (!flags.gate && !flags.rescue)) return DISABLED_JUDGE;
  const endpoint = checkProviderUrl(baseUrl);
  if (!endpoint.ok) {
    logger({ type: "judge.provider_insecure_url", reason: endpoint.reason });
    return DISABLED_JUDGE;
  }
  const url = `${String(endpoint.url).replace(/\/+$/, "")}/v1/systemone`;
  const cache = new Map(); // normalized input -> Promise<JudgeVerdict>
  const inflight = new Set(); // AbortControllers
  let closed = false;

  async function request(input) {
    const started = now();
    const controller = new AbortController();
    inflight.add(controller);
    // Not unref'd: it is short-lived and always cleared, and an unref'd timer
    // may never fire when it is the only pending work (a hung fetch would hang).
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await providerFetch(
        url,
        {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(buildJudgeRequest({ model, ...input })),
          signal: controller.signal,
        },
        { apiKey, fetchImpl },
      );
      if (!response.ok) return verdict(null, null, now() - started, `http_${response.status}`);
      const parsed = parseJudgeResponse(await readJsonCapped(response, MAX_JUDGE_JSON_BYTES));
      return verdict(parsed.isQuestion, parsed.answersSame, now() - started, null, parsed.isComplete);
    } catch (error) {
      const reason = controller.signal.aborted ? (closed ? "closed" : "timeout") : String(error?.message ?? error);
      return verdict(null, null, now() - started, reason.split(apiKey).join("[redacted]"));
    } finally {
      clearTimeout(timer);
      inflight.delete(controller);
    }
  }

  async function evaluate({ utterance, answeredFor, recent, askComplete = false } = {}) {
    if (closed) return verdict(null, null, 0, "closed");
    const text = String(utterance ?? "").trim();
    if (!text) return verdict(null, null, 0, "empty");
    const key = `${normalize(text)}\u0000${normalize(answeredFor)}\u0000${askComplete ? 1 : 0}`;
    if (cacheSize > 0 && cache.has(key)) return cache.get(key);
    const pending = request({ utterance: text, answeredFor, recent, askComplete }).then((result) => {
      if (result.error) cache.delete(key);
      logger({
        type: "judge.verdict",
        latency_ms: result.latencyMs,
        is_question: result.isQuestion,
        answers_same: result.answersSame,
        ...(askComplete ? { is_complete: result.isComplete } : {}),
        error: result.error,
      });
      return result;
    });
    if (cacheSize > 0) {
      cache.set(key, pending);
      if (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    }
    return pending;
  }

  function close() {
    closed = true;
    for (const controller of inflight) controller.abort();
    inflight.clear();
    cache.clear();
  }

  return { enabled: true, features: Object.freeze({ ...flags }), evaluate, close };
}
