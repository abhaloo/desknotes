/**
 * Engine wiring for the realtime server.
 *
 * `createEngineFactory` bakes the environment/provider configuration once and
 * returns the `{ emit, log } -> engine` function that RealtimeServer calls per
 * connection, so every session gets fresh ASR/answer state but shares config.
 */
import { createAnswerer } from "./answerer.js";
import { CEREBRAS_THINKING_MODEL, DEEPSEEK, answerModelChoice, applyAnswerModelSelection, engineShortName } from "./answer-models.js";
import { sameOrigin } from "../../security/url-policy.js";
import { createAsr } from "./asr.js";
import { createGlossary } from "./glossary.js";
import { createJudge } from "./judge.js";
import { createPipelineEngine } from "./pipeline.js";
import { createSessionRecorder } from "../telemetry/session-recorder.js";

export { buildEngineConfig } from "./config.js";
export { configurePrompts, readPromptSets } from "./prompts.js";
export { createAnswerer, createAsr, createGlossary, createJudge, createPipelineEngine };

/**
 * @param {{asrProvider?: string, answerProvider?: string, answererProvider?: string,
 *   asrOptions?: object, answererOptions?: object, visionOptions?: object,
 *   answerRoles?: string[], judgeOptions?: object, telemetryOptions?: object,
 *   answerModel?: string|null, answerModelResolver?: () => string|null,
 *   deepseekApiKey?: string|null, cerebrasAvailable?: boolean,
 *   repContext?: boolean, repContextResolver?: () => boolean,
 *   highlights?: boolean, highlightsResolver?: () => boolean,
 *   answerCards?: boolean, answerCardsResolver?: () => boolean,
 *   glossary?: boolean, glossaryResolver?: () => boolean, glossaryOptions?: object|null}} [config]
 *   answerRoles: speaker roles whose speech opens/commits turns (default
 *   ["prospect"]). answerModelResolver: the Settings answer-model choice, read
 *   for every answer (answerModel is the fixed fallback); deepseekApiKey: the
 *   key a DeepSeek choice uses; cerebrasAvailable: whether CEREBRAS_API_KEY is
 *   set, so the Qwen default can run (logged as unavailable otherwise).
 *   repContextResolver: the Settings "Use what I say in answers" choice, read
 *   for every answer (repContext, from REP_CONTEXT, is the fixed fallback;
 *   both default on). highlightsResolver: the Settings "Highlight key
 *   phrases" choice, read for every answer (highlights, from HIGHLIGHTS, is
 *   the fixed fallback; both default on). answerCardsResolver: the Settings
 *   "Short answer cards" choice, read for every answer (answerCards, from
 *   ANSWER_CARDS, is the fixed fallback; both default on).
 *   glossaryResolver: the Settings "Explain terms" choice, read once per turn
 *   (glossary, from GLOSSARY, is the fixed fallback; both default on).
 *   glossaryOptions: createGlossary options (DEEPSEEK_API_KEY, known-terms
 *   path); null means no Terms.
 * @returns {(ctx: {emit: Function, log?: Function}) => object}
 */
export function createEngineFactory(config = {}) {
  const asrOptions = {
    provider: config.asrProvider ?? config.asrOptions?.provider ?? "mock",
    ...config.asrOptions,
  };
  const answererOptions = {
    provider:
      config.answerProvider ?? config.answererProvider ?? config.answererOptions?.provider ?? "mock",
    ...config.answererOptions,
  };
  const visionOptions = { ...config.visionOptions };
  const answerRoles = Array.isArray(config.answerRoles) ? [...config.answerRoles] : undefined;
  const judgeOptions = config.judgeOptions ?? null;
  const telemetryOptions = config.telemetryOptions ?? {};
  const selectModel =
    typeof config.answerModelResolver === "function" ? config.answerModelResolver : () => config.answerModel ?? null;
  const deepseekApiKey = config.deepseekApiKey ?? null;
  const cerebrasAvailable = config.cerebrasAvailable;
  const repContext =
    typeof config.repContextResolver === "function" ? config.repContextResolver : config.repContext !== false;
  const highlights =
    typeof config.highlightsResolver === "function" ? config.highlightsResolver : config.highlights !== false;
  const answerCards =
    typeof config.answerCardsResolver === "function" ? config.answerCardsResolver : config.answerCards !== false;
  const glossary =
    typeof config.glossaryResolver === "function" ? config.glossaryResolver : config.glossary !== false;
  const glossaryOptions = config.glossaryOptions ?? null;

  return function createEngine({ emit, log } = {}) {
    // One judge per session: its verdict cache must not outlive the call.
    const judge = judgeOptions ? createJudge({ ...judgeOptions, log }) : undefined;
    // One glossary per session: its term cache is the session's.
    const glossaryEngine = glossaryOptions ? createGlossary({ ...glossaryOptions, log }) : undefined;
    // One recorder per session: it owns that session's file and dropped count.
    const telemetry = createSessionRecorder({ ...telemetryOptions, log });
    return createPipelineEngine({
      emit,
      log,
      asrOptions,
      answerer: createSelectableAnswerer({ options: answererOptions, selectModel, deepseekApiKey, cerebrasAvailable, log }),
      answererOptions,
      visionOptions,
      answerRoles,
      judge,
      telemetry,
      repContext,
      highlights,
      answerCards,
      glossary,
      glossaryEngine,
    });
  };
}

/**
 * Statuses that mean "this provider will not answer now, another one might",
 * each with the reason the overlay's fallback note shows: a rejected key, an
 * unpaid or paywalled model, an exhausted quota or a rate limit. A 5xx is not
 * here: the pipeline's own retry covers it.
 */
const REFUSAL_REASONS = Object.freeze({ 401: "key_rejected", 402: "out_of_credit", 403: "refused", 429: "rate_limited" });

/**
 * How long a refused engine is skipped: later answers go straight to the
 * stand-in instead of paying for the same refusal first. A rate limit clears
 * by itself within seconds; a key or billing problem does not clear during a
 * call, so it waits longer before the chosen engine is tried again.
 */
const RATE_LIMIT_PAUSE_MS = 30_000;
const REFUSAL_PAUSE_MS = 5 * 60_000;

/**
 * The engine a refused answer is replayed on: DeepSeek V4.1 Flash with
 * thinking on, the same model as the default Settings choice, so a substitute
 * answer reads like the one the session was configured for.
 */
const FAILOVER_ANSWER_MODEL = "deepseek-flash-thinking";

/** An engine the answerer can really call (live mode never configures the mock). */
function isLiveEngine(options) {
  return options?.provider === "openai-compatible" && Boolean(options.baseUrl) && Boolean(options.apiKey);
}

/**
 * An answerer that follows the Settings answer-model choice. The choice is
 * read for every answer, so a change applies to the next answer of a live
 * session; an answer already streaming finishes on the model it started with.
 * Every choice keeps the configured answerInstructionsPath, so the user's
 * answer-instructions.txt applies whichever model answers. A priming request
 * (answerer.js prime) follows the same choice: a new choice is a new answerer,
 * so the next prime (session start, document change) is sent for it, and a
 * DeepSeek choice never primes.
 *
 * Another engine stands in for the chosen one in two cases. Each answer it
 * gives is reported once through `streamAnswer({onFallback})` as
 * `{to, from, reason}` (short names, never keys); the pipeline puts it on
 * turn.done so the card can say so.
 * - The chosen engine has no key: DeepSeek V4.1 Flash with thinking answers
 *   when DEEPSEEK_API_KEY is present, else the configured engine when it is a
 *   real one (reason "no_key", or "unavailable" when a Cerebras key exists but
 *   the configured engine is not Cerebras). With neither, the answer fails as
 *   `no_answer_model`.
 * - The chosen engine REFUSES the request before its first token (401 key,
 *   402 out of credit, 403 paywalled model, 429 quota): the same request is
 *   replayed once on DeepSeek V4.1 Flash with thinking on when
 *   DEEPSEEK_API_KEY is present, and `engine.answer_failover` is logged. The
 *   refused engine is then skipped for RATE_LIMIT_PAUSE_MS (429) or
 *   REFUSAL_PAUSE_MS, so later answers do not wait for the same refusal.
 *
 * @param {{options?: object, selectModel?: () => string|null, deepseekApiKey?: string|null,
 *   cerebrasAvailable?: boolean, log?: Function, now?: () => number}} [config]
 */
export function createSelectableAnswerer({
  options = {},
  selectModel = () => null,
  deepseekApiKey = null,
  cerebrasAvailable,
  log,
  now = Date.now,
} = {}) {
  let current = null;
  let failover = null;
  /** Selection key -> {until, reason, status}: engines skipped after a refusal. */
  const paused = new Map();

  /** DeepSeek V4.1 Flash with thinking, as an applied selection, or null without its key. */
  function deepseekStandIn() {
    const applied = applyAnswerModelSelection(options, {
      answerModel: FAILOVER_ANSWER_MODEL,
      deepseekApiKey,
      cerebrasAvailable: true,
    });
    return applied.unavailable ? null : applied;
  }

  /**
   * The engine that answers for this selection, and the note that names it
   * when it is not the chosen one (null when the chosen engine answers, and
   * when nothing can: the answer then fails, or the demo-mode mock answers).
   */
  function standInFor(applied) {
    if (!applied.unavailable) return { options: applied.options, note: null };
    const from = answerModelChoice(applied.choice).short;
    const reason =
      applied.choice === CEREBRAS_THINKING_MODEL && cerebrasAvailable !== false ? "unavailable" : "no_key";
    // DeepSeek thinking first, like a refusal's replay; a DeepSeek choice is
    // only unavailable without its key, so it never lands here.
    const deepseek = deepseekStandIn();
    if (deepseek) return { options: deepseek.options, note: { to: engineShortName(deepseek.options), from, reason } };
    if (isLiveEngine(applied.options)) {
      return { options: applied.options, note: { to: engineShortName(applied.options), from, reason } };
    }
    return { options: applied.options, note: null };
  }

  /** The answerer for the Settings choice now, with its options, note and key. */
  function selectionNow() {
    let selected = null;
    try {
      selected = selectModel();
    } catch {
      selected = null;
    }
    const applied = applyAnswerModelSelection(options, {
      answerModel: selected,
      deepseekApiKey,
      cerebrasAvailable,
    });
    const { options: effective, note } = standInFor(applied);
    // The choice is in the key: both DeepSeek choices use one model id.
    const key = [applied.choice, effective.provider, effective.baseUrl, effective.model, effective.thinking, applied.unavailable]
      .map((part) => part ?? "")
      .join("|");
    if (!current || key !== current.key) {
      current = { key, options: effective, note, answerer: createAnswerer({ ...effective, log }) };
      log?.({
        type: "engine.answer_model",
        selected: applied.choice || "qwen",
        provider: effective.provider ?? "mock",
        model: effective.model ?? "mock",
        thinking: effective.thinking ?? null,
        unavailable: applied.unavailable,
        standIn: note?.reason ?? null,
      });
    }
    return current;
  }

  /**
   * The answerer to replay on instead of `selection`, or null. Built and
   * cached only when first needed: a session that never fails never touches
   * DeepSeek. Never onto the DeepSeek origin itself (it would refuse the same way).
   */
  function failoverFrom(selection) {
    if (selection.options.baseUrl && sameOrigin(selection.options.baseUrl, DEEPSEEK.baseUrl)) return null;
    const applied = deepseekStandIn();
    if (!applied) return null;
    const key = `${applied.options.baseUrl}|${applied.options.model}`;
    if (!failover || key !== failover.key) {
      failover = { key, applied, answerer: createAnswerer({ ...applied.options, log }) };
    }
    return failover;
  }

  /** The pause on `key`, or null once it has run out. */
  function pauseOf(key) {
    const pause = paused.get(key);
    if (!pause) return null;
    if (now() < pause.until) return pause;
    paused.delete(key);
    return null;
  }

  function logFailover(selection, next, status, extra = {}) {
    // Names and a status only: the log is written beside the session files.
    log?.({
      type: "engine.answer_failover",
      status,
      from: selection.options.model ?? "configured",
      to: next.applied.options.model,
      // Both DeepSeek choices share one model id: the choice and the thinking
      // flag are what tell the two apart in a session file.
      choice: next.applied.choice,
      thinking: next.applied.options.thinking ?? null,
      ...extra,
    });
  }

  function report(args, note) {
    if (note && typeof args?.onFallback === "function") args.onFallback(note);
  }

  async function* streamAnswer(args = {}) {
    const selection = selectionNow();
    const pause = pauseOf(selection.key);
    const skip = pause ? failoverFrom(selection) : null;
    if (skip) {
      logFailover(selection, skip, pause.status, { paused: true });
      report(args, { to: engineShortName(skip.applied.options), from: engineShortName(selection.options), reason: pause.reason });
      yield* skip.answerer.streamAnswer(args);
      return;
    }
    report(args, selection.note);
    let emitted = false;
    try {
      for await (const delta of selection.answerer.streamAnswer(args)) {
        emitted = true;
        yield delta;
      }
    } catch (error) {
      // A provider that stops mid-answer is not replayed: the text already on
      // screen is the answer.
      const status = Number(error?.status);
      const reason = REFUSAL_REASONS[status];
      const next = !emitted && reason ? failoverFrom(selection) : null;
      if (!next) throw error;
      paused.set(selection.key, { until: now() + (status === 429 ? RATE_LIMIT_PAUSE_MS : REFUSAL_PAUSE_MS), reason, status });
      logFailover(selection, next, status);
      report(args, { to: engineShortName(next.applied.options), from: engineShortName(selection.options), reason });
      yield* next.answerer.streamAnswer(args);
    }
  }

  async function answerOnce(args) {
    let text = "";
    for await (const delta of streamAnswer(args)) text += delta;
    return text;
  }

  /** Warm the chosen engine's cache, unless it is paused: the warm-up would meet the same refusal. */
  function prime(args) {
    const selection = selectionNow();
    if (pauseOf(selection.key)) return false;
    return selection.answerer.prime?.(args) ?? false;
  }

  return { streamAnswer, answerOnce, prime };
}
