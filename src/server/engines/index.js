/**
 * Engine wiring for the realtime server.
 *
 * `createEngineFactory` bakes the environment/provider configuration once and
 * returns the `{ emit, log } -> engine` function that RealtimeServer calls per
 * connection, so every session gets fresh ASR/answer state but shares config.
 */
import { createAnswerer } from "./answerer.js";
import { CEREBRAS, CEREBRAS_THINKING_MODEL, answerModelChoice, applyAnswerModelSelection, engineShortName } from "./answer-models.js";
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
 *   set, so the Qwen default can run (logged as unavailable otherwise);
 *   cerebrasApiKey: that key, the Cerebras rung of the stand-in ladder.
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
  const cerebrasApiKey = config.cerebrasApiKey ?? null;
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
      answerer: createSelectableAnswerer({ options: answererOptions, selectModel, deepseekApiKey, cerebrasAvailable, cerebrasApiKey, log }),
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
 * The DeepSeek rung of the ladder, and the engine that stands in for a choice
 * with no key: DeepSeek V4.1 Flash with thinking on, the same model as the
 * default Settings choice, so a substitute answer reads like the one the
 * session was configured for.
 */
const FAILOVER_ANSWER_MODEL = "deepseek-flash-thinking";

/** The fallback note's reason for a stand-in the pipeline asked for (`streamAnswer({standIn, retryOf})`). */
const STAND_IN_REASONS = Object.freeze({ stalled: "stalled", error: "failed" });

/** An engine the answerer can really call (live mode never configures the mock). */
function isLiveEngine(options) {
  return options?.provider === "openai-compatible" && Boolean(options.baseUrl) && Boolean(options.apiKey);
}

/** The origin of a base URL, or null when it is not a URL. */
function originOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).origin;
  } catch {
    return null;
  }
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
 * Another engine stands in for the chosen one in three cases. Each answer it
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
 *   replayed on the next rung of the ladder (below), and
 *   `engine.answer_failover` is logged. The refused engine is then skipped
 *   for RATE_LIMIT_PAUSE_MS (429) or REFUSAL_PAUSE_MS, so later answers do
 *   not wait for the same refusal. A rung that refuses is paused the same
 *   way and the next rung is tried.
 * - The pipeline asks for a stand-in (`streamAnswer({standIn: true,
 *   retryOf})`, its last retry after the chosen engine failed twice: a
 *   stall, a 5xx, a dropped connection): the answer goes to the first rung
 *   of the ladder that is not paused (reason "stalled" or "failed"). Nothing
 *   is paused for it: the next answer goes to the chosen engine again.
 *
 * The ladder (`ladderFor`) is every engine with a key, fastest first:
 * Cerebras Qwen (CEREBRAS_API_KEY; the configured options when they are on
 * that origin), DeepSeek Flash with thinking (DEEPSEEK_API_KEY), then a
 * configured LLM_* engine on any other origin. The chosen engine's origin is
 * never on its own ladder: the same provider would fail the same way. With
 * no rung left, the chosen engine answers again, with no note.
 *
 * @param {{options?: object, selectModel?: () => string|null, deepseekApiKey?: string|null,
 *   cerebrasAvailable?: boolean, cerebrasApiKey?: string|null, log?: Function, now?: () => number}} [config]
 */
export function createSelectableAnswerer({
  options = {},
  selectModel = () => null,
  deepseekApiKey = null,
  cerebrasAvailable,
  cerebrasApiKey = null,
  log,
  now = Date.now,
} = {}) {
  let current = null;
  /** Rung key -> answerer: a rung's answerer is built when first needed, then kept. */
  const rungAnswerers = new Map();
  /** Engine key -> {until, reason, status}: engines skipped after a refusal. */
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
      current = { key, choice: applied.choice, options: effective, note, answerer: createAnswerer({ ...effective, log }) };
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

  /** The Cerebras rung: the configured options when they are on that origin, else the preset with the Cerebras key. */
  function cerebrasRung() {
    if (isLiveEngine(options) && sameOrigin(options.baseUrl, CEREBRAS.baseUrl)) return { options, choice: CEREBRAS_THINKING_MODEL };
    if (!cerebrasApiKey) return null;
    return {
      options: { ...options, provider: "openai-compatible", baseUrl: CEREBRAS.baseUrl, apiKey: cerebrasApiKey, model: CEREBRAS.model, reasoningEffort: CEREBRAS.reasoningEffort, thinking: undefined },
      choice: CEREBRAS_THINKING_MODEL,
    };
  }

  /** The DeepSeek rung, or null without its key. */
  function deepseekRung() {
    const applied = deepseekStandIn();
    return applied ? { options: applied.options, choice: applied.choice } : null;
  }

  /** The configured LLM_* engine as a rung, when it is a real engine. */
  function configuredRung() {
    return isLiveEngine(options) ? { options, choice: "configured" } : null;
  }

  /**
   * The engines that can stand in for `selection`, fastest first, one per
   * origin, never the chosen engine's own origin. Each rung carries the key
   * its pause is kept under; its answerer is built when first asked
   * (`answererOf`), so a session that never fails never touches another engine.
   */
  function ladderFor(selection) {
    const rungs = [];
    const seen = new Set();
    const chosen = selection.options.baseUrl ?? null;
    for (const rung of [cerebrasRung(), deepseekRung(), configuredRung()]) {
      if (!rung) continue;
      const origin = originOf(rung.options.baseUrl);
      if (!origin || seen.has(origin) || (chosen && sameOrigin(rung.options.baseUrl, chosen))) continue;
      seen.add(origin);
      const key = `${rung.options.baseUrl}|${rung.options.model}|${rung.options.thinking ?? ""}`;
      rungs.push({ key, options: rung.options, choice: rung.choice });
    }
    return rungs;
  }

  /** The answerer of the chosen engine or a rung, built once per rung. */
  function answererOf(engine) {
    if (engine.answerer) return engine.answerer;
    if (!rungAnswerers.has(engine.key)) rungAnswerers.set(engine.key, createAnswerer({ ...engine.options, log }));
    return rungAnswerers.get(engine.key);
  }

  /** The first rung after index `from` that is not paused, or null. */
  function nextRung(rungs, from) {
    for (let i = from + 1; i < rungs.length; i += 1) {
      if (!pauseOf(rungs[i].key)) return { rung: rungs[i], index: i };
    }
    return null;
  }

  /** The pause on `key`, or null once it has run out. */
  function pauseOf(key) {
    const pause = paused.get(key);
    if (!pause) return null;
    if (now() < pause.until) return pause;
    paused.delete(key);
    return null;
  }

  function logFailover(from, next, status, extra = {}) {
    // Names and a status only: the log is written beside the session files.
    log?.({
      type: "engine.answer_failover",
      status,
      from: from.options.model ?? "configured",
      to: next.options.model,
      // Both DeepSeek choices share one model id: the choice and the thinking
      // flag are what tell the two apart in a session file.
      choice: next.choice,
      thinking: next.options.thinking ?? null,
      ...extra,
    });
  }

  function report(args, note) {
    if (note && typeof args?.onFallback === "function") args.onFallback(note);
  }

  async function* streamAnswer(args = {}) {
    const selection = selectionNow();
    const rungs = ladderFor(selection);
    const chosen = { key: selection.key, options: selection.options, choice: selection.choice, answerer: selection.answerer };
    // Where the answer starts: the chosen engine, unless the pipeline asked
    // for a stand-in or the chosen engine is paused; then the first open rung.
    let engine = chosen;
    let index = -1;
    const pause = pauseOf(selection.key);
    const standIn = args.standIn === true ? nextRung(rungs, -1) : null;
    if (standIn) {
      const reason = STAND_IN_REASONS[args.retryOf] ?? STAND_IN_REASONS.error;
      ({ rung: engine, index } = standIn);
      log?.({ type: "engine.answer_stand_in", reason, from: chosen.options.model ?? "configured", to: engine.options.model, choice: engine.choice });
      report(args, { to: engineShortName(engine.options), from: engineShortName(chosen.options), reason });
    } else if (pause && nextRung(rungs, -1)) {
      ({ rung: engine, index } = nextRung(rungs, -1));
      logFailover(chosen, engine, pause.status, { paused: true });
      report(args, { to: engineShortName(engine.options), from: engineShortName(chosen.options), reason: pause.reason });
    } else {
      report(args, selection.note);
    }
    for (;;) {
      let emitted = false;
      try {
        for await (const delta of answererOf(engine).streamAnswer(args)) {
          emitted = true;
          yield delta;
        }
        return;
      } catch (error) {
        // A refusal before the first token moves to the next rung; anything
        // else (a failure after the first token, a 5xx, a stall) is the
        // pipeline's to retry.
        const status = Number(error?.status);
        const reason = REFUSAL_REASONS[status];
        const next = !emitted && reason ? nextRung(rungs, index) : null;
        if (!next) throw error;
        paused.set(engine.key, { until: now() + (status === 429 ? RATE_LIMIT_PAUSE_MS : REFUSAL_PAUSE_MS), reason, status });
        logFailover(engine, next.rung, status);
        report(args, { to: engineShortName(next.rung.options), from: engineShortName(engine.options), reason });
        ({ rung: engine, index } = next);
      }
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
