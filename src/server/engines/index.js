/**
 * Engine wiring for the realtime server.
 *
 * `createEngineFactory` bakes the environment/provider configuration once and
 * returns the `{ emit, log } -> engine` function that RealtimeServer calls per
 * connection, so every session gets fresh ASR/answer state but shares config.
 */
import { createAnswerer } from "./answerer.js";
import { applyAnswerModelSelection } from "./answer-models.js";
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
 * An answerer that follows the Settings answer-model choice. The choice is
 * read for every answer, so a change applies to the next answer of a live
 * session; an answer already streaming finishes on the model it started with.
 * Every choice keeps the configured answerInstructionsPath, so the user's
 * answer-instructions.txt applies whichever model answers. A priming request
 * (answerer.js prime) follows the same choice: a new choice is a new answerer,
 * so the next prime (session start, document change) is sent for it, and a
 * DeepSeek choice never primes.
 */
export function createSelectableAnswerer({
  options = {},
  selectModel = () => null,
  deepseekApiKey = null,
  cerebrasAvailable,
  log,
} = {}) {
  let current = null;
  let currentKey = null;
  function answererNow() {
    let selected = null;
    try {
      selected = selectModel();
    } catch {
      selected = null;
    }
    const { options: effective, unavailable, choice } = applyAnswerModelSelection(options, {
      answerModel: selected,
      deepseekApiKey,
      cerebrasAvailable,
    });
    // The choice is in the key: both DeepSeek choices use one model id.
    const key = `${choice}|${effective.provider ?? ""}|${effective.model ?? ""}|${unavailable}`;
    if (!current || key !== currentKey) {
      current = createAnswerer({ ...effective, log });
      currentKey = key;
      log?.({
        type: "engine.answer_model",
        selected: choice || "qwen",
        provider: effective.provider ?? "mock",
        model: effective.model ?? "mock",
        thinking: effective.thinking ?? null,
        unavailable,
      });
    }
    return current;
  }
  return {
    streamAnswer: (args) => answererNow().streamAnswer(args),
    answerOnce: (args) => answererNow().answerOnce(args),
    prime: (args) => answererNow().prime?.(args) ?? false,
  };
}
