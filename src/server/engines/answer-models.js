/**
 * Answer-model choices for the Settings dialog, and the DeepSeek preset two of
 * them point at.
 *
 * Model ids are DeepSeek's real API names (GET https://api.deepseek.com/models,
 * checked 2026-10-15): `deepseek-flash` is DeepSeek-V4.1-Flash. There is no
 * non-Flash "V4.1" model; any other name is refused with HTTP 400.
 *
 * DeepSeek models think by default; `thinking: {type: "enabled"|"disabled"}`
 * is the switch (api-docs.deepseek.com/guides/thinking_mode). The reasoning
 * arrives in a separate `reasoning_content` field that the answer stream never
 * shows, so the first spoken word waits for it, and a capped vision reply can
 * spend every token thinking and return no answer at all. So every request to
 * the DeepSeek origin turns it off, except an answer on the "DeepSeek V4.1
 * Flash" choice (the default), which asks for it. Thinking ignores
 * `temperature`, and `reasoning_effort` is never sent to DeepSeek: it would
 * apply a Cerebras value, and DeepSeek refuses it with thinking off.
 */
import { sameOrigin } from "../../security/url-policy.js";

export const DEEPSEEK = Object.freeze({
  baseUrl: "https://api.deepseek.com",
  models: Object.freeze({ flash: "deepseek-flash" }),
});

/** The default: DeepSeek V4.1 Flash with thinking on. */
export const DEFAULT_ANSWER_MODEL = "deepseek-flash-thinking";

/**
 * The engine the environment configured (CEREBRAS_API_KEY's preset, config.js)
 * with reasoning on. Cerebras streams the reasoning in a separate `reasoning`
 * delta field that the answer stream never shows, and qwen-3.8-27b still
 * starts answering in about 0.3 to 1.3 s with it (measured 2026-10-15),
 * unlike DeepSeek's thinking mode.
 */
export const CEREBRAS_THINKING_MODEL = "cerebras-qwen-thinking";
const CEREBRAS_ORIGIN = "https://api.cerebras.ai";
const CEREBRAS_THINKING_EFFORT = "high";

/**
 * The Cerebras preset: what CEREBRAS_API_KEY configures when no LLM_*
 * variable overrides it (config.js applyVendorPresets), and the Cerebras rung
 * of the stand-in ladder (index.js createSelectableAnswerer).
 */
export const CEREBRAS = Object.freeze({
  baseUrl: `${CEREBRAS_ORIGIN}/v1`,
  model: "qwen-3.8-27b",
  reasoningEffort: CEREBRAS_THINKING_EFFORT,
});

/**
 * The three Settings choices, default first. "cerebras-qwen-thinking" is the
 * configured engine with reasoning_effort "high"; that engine is the Cerebras
 * preset (qwen-3.8-27b) whenever CEREBRAS_API_KEY is set and no LLM_*
 * variable overrides it. A DeepSeek choice without DEEPSEEK_API_KEY keeps the
 * configured engine.
 */
export const ANSWER_MODEL_CHOICES = Object.freeze([
  Object.freeze({
    id: DEFAULT_ANSWER_MODEL,
    label: "DeepSeek V4.1 Flash",
    short: "DeepSeek Flash",
    model: DEEPSEEK.models.flash,
    thinking: "enabled",
  }),
  Object.freeze({
    id: "deepseek-flash",
    label: "DeepSeek V4.1 Flash (fast)",
    short: "DeepSeek Flash (fast)",
    model: DEEPSEEK.models.flash,
    thinking: "disabled",
  }),
  Object.freeze({ id: CEREBRAS_THINKING_MODEL, label: "Qwen 27B thinking (Cerebras)", short: "Qwen 27B" }),
]);

/**
 * The few words that name an engine in the overlay's fallback note:
 * "DeepSeek Flash", "Qwen 27B", or the model id of any other engine.
 * @param {{baseUrl?: string, model?: string, thinking?: string}} [options]
 */
export function engineShortName({ baseUrl, model, thinking } = {}) {
  if (baseUrl && sameOrigin(baseUrl, DEEPSEEK.baseUrl)) return thinking === "enabled" ? "DeepSeek Flash" : "DeepSeek Flash (fast)";
  if (isCerebrasEngine(baseUrl) && /^qwen-[\d.]+-27b$/i.test(String(model ?? ""))) return "Qwen 27B";
  return typeof model === "string" && model.length > 0 ? model : "another model";
}

/**
 * Ids that earlier builds saved, and the choice each one now means. "" was
 * Automatic, which now is the default. DeepSeek V4 Pro answered with thinking
 * off, so it maps to the choice with the same key and the same latency class.
 * "deepseek-flash" keeps its id and its meaning (thinking off). "cerebras-qwen"
 * (Qwen with reasoning off) maps to the only Qwen choice, which thinks.
 */
export const LEGACY_ANSWER_MODELS = Object.freeze({
  "": DEFAULT_ANSWER_MODEL,
  "deepseek-v4-pro": "deepseek-flash",
  "cerebras-qwen": CEREBRAS_THINKING_MODEL,
});

export function isAnswerModelChoice(value) {
  return typeof value === "string" && ANSWER_MODEL_CHOICES.some((choice) => choice.id === value);
}

/** A saved or env value as a listed choice: legacy ids migrate, anything else is the default. */
export function normalizeAnswerModel(value) {
  if (isAnswerModelChoice(value)) return value;
  if (typeof value === "string" && Object.hasOwn(LEGACY_ANSWER_MODELS, value)) return LEGACY_ANSWER_MODELS[value];
  return DEFAULT_ANSWER_MODEL;
}

export function answerModelChoice(value) {
  const id = normalizeAnswerModel(value);
  return ANSWER_MODEL_CHOICES.find((choice) => choice.id === id);
}

/**
 * Request-body fields a provider origin needs; empty for every other origin.
 * On the DeepSeek origin thinking is off unless `thinking` is "enabled".
 *
 * @param {string|undefined} baseUrl
 * @param {{thinking?: "enabled"|"disabled"}} [options]
 */
export function providerRequestExtras(baseUrl, { thinking } = {}) {
  if (!baseUrl || !sameOrigin(baseUrl, DEEPSEEK.baseUrl)) return {};
  return { thinking: { type: thinking === "enabled" ? "enabled" : "disabled" } };
}

/** True when `baseUrl` is set and on the Cerebras origin. */
export function isCerebrasEngine(baseUrl) {
  return Boolean(baseUrl) && sameOrigin(baseUrl, CEREBRAS_ORIGIN);
}

/**
 * The Settings selection applied to the configured answerer options. An
 * unknown or empty id is the default (DeepSeek V4.1 Flash, thinking on).
 * A DeepSeek choice needs a DeepSeek key: without one the options stay as
 * configured (the Cerebras Qwen preset when CEREBRAS_API_KEY is set) and
 * `unavailable` says why, so a missing key never breaks answering. The Qwen
 * choice sets reasoning_effort "high" on the configured engine; it is
 * `unavailable`, with the options unchanged, when `cerebrasAvailable` is false
 * (no CEREBRAS_API_KEY) or the configured engine is not on the Cerebras
 * origin, because then the configured engine is not Qwen.
 *
 * @param {object} options answerer options built from the environment
 * @param {{answerModel?: string|null, deepseekApiKey?: string|null, cerebrasAvailable?: boolean}} [selection]
 * @returns {{options: object, unavailable: boolean, choice: string}}
 */
export function applyAnswerModelSelection(
  options = {},
  { answerModel = null, deepseekApiKey = null, cerebrasAvailable } = {},
) {
  const choice = answerModelChoice(answerModel);
  if (choice.id === CEREBRAS_THINKING_MODEL) {
    // Only the Cerebras engine takes this effort; any other configured engine is left alone.
    const onCerebras = cerebrasAvailable !== false && Boolean(options.baseUrl) && sameOrigin(options.baseUrl, CEREBRAS_ORIGIN);
    if (!onCerebras) return { options, unavailable: true, choice: choice.id };
    return { options: { ...options, reasoningEffort: CEREBRAS_THINKING_EFFORT }, unavailable: false, choice: choice.id };
  }
  const key = present(deepseekApiKey);
  if (!key) return { options, unavailable: true, choice: choice.id };
  return {
    options: {
      ...options,
      provider: "openai-compatible",
      baseUrl: DEEPSEEK.baseUrl,
      apiKey: key,
      model: choice.model,
      thinking: choice.thinking,
      // Another vendor's setting (Cerebras sends "high") is not a DeepSeek
      // value, and DeepSeek refuses reasoning_effort with thinking off.
      reasoningEffort: undefined,
    },
    unavailable: false,
    choice: choice.id,
  };
}

function present(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
