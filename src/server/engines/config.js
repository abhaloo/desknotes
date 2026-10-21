/**
 * Provider configuration for the realtime server.
 *
 * Live mode uses a real ASR endpoint, answer model and vision model, or an
 * explicit unconfigured engine that fails with a reason. Demo mode may use
 * the mock segmenter, answerer and screen reading. Keys stay on the origin they belong
 * to: an ASR key is explicit, and a shared LLM key is reused only for that
 * LLM origin. OPENAI_API_KEY is reused only for the default OpenAI origin.
 */
import { checkProviderUrl, sameOrigin } from "../../security/url-policy.js";
import { recorderOptionsFromEnv } from "../telemetry/session-recorder.js";
import { parseRepContextSwitch } from "./conversation-context.js";
import { parseHighlightsSwitch } from "../../shared/highlights.js";
import { parseAnswerCardsSwitch } from "../../shared/answer-cards.js";
import { parseGlossarySwitch } from "./glossary.js";
import { judgeOptionsFromEnv } from "./judge.js";
import { scopedApiKey } from "./provider-http.js";

const DEFAULT_OPENAI_ORIGIN = "https://api.openai.com";

/**
 * Vendor presets: a well-known vendor key fills the generic provider
 * variables that are still unset. Explicit settings always win, and each
 * vendor key is only ever sent to that vendor's own origin.
 */
const CEREBRAS = Object.freeze({
  baseUrl: "https://api.cerebras.ai/v1",
  model: "qwen-3.8-27b",
  // Reasoning on, so Qwen answers with thinking. Cerebras streams the
  // reasoning in a separate field the answer stream never shows, and the first
  // answer token still arrives in about 0.3-1.3 s. LLM_REASONING_EFFORT wins.
  reasoningEffort: "high",
});
const GROQ = Object.freeze({
  baseUrl: "https://api.groq.com/openai/v1",
  asrModel: "whisper-large-v3-turbo",
  // Groq's Whisper limit; the HTTP STT budget keeps finals under it.
  asrRequestsPerMinute: "20",
});

/**
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, string|undefined>}
 */
export function applyVendorPresets(env = {}) {
  const out = { ...env };
  const cerebrasKey = present(env.CEREBRAS_API_KEY);
  if (cerebrasKey && env.ANSWER_PROVIDER == null && !present(env.LLM_BASE_URL) && !present(env.LLM_API_KEY)) {
    out.ANSWER_PROVIDER = "openai-compatible";
    out.LLM_BASE_URL = CEREBRAS.baseUrl;
    out.LLM_API_KEY = cerebrasKey;
    out.LLM_MODEL = present(env.LLM_MODEL) ?? CEREBRAS.model;
    out.LLM_REASONING_EFFORT = present(env.LLM_REASONING_EFFORT) ?? CEREBRAS.reasoningEffort;
  }
  const groqKey = present(env.GROQ_API_KEY);
  if (groqKey && !present(env.ASR_PROVIDER) && !present(env.ASR_BASE_URL) && !present(env.ASR_API_KEY)) {
    out.ASR_PROVIDER = "openai-compatible";
    out.ASR_BASE_URL = GROQ.baseUrl;
    out.ASR_API_KEY = groqKey;
    out.ASR_MODEL = present(env.ASR_MODEL) ?? GROQ.asrModel;
    out.ASR_MAX_RPM = present(env.ASR_MAX_RPM) ?? GROQ.asrRequestsPerMinute;
  }
  // A TypeSafe key turns both judgments on; JEV_JUDGMENTS=off turns them off.
  if (present(env.TYPESAFE_API_KEY) && env.JEV_JUDGMENTS == null) out.JEV_JUDGMENTS = "gate,rescue";
  return out;
}

/**
 * REP_CONTEXT: 0/false/off turns rep context off, 1/true/on (or unset) keeps
 * it on. Any other value keeps the default: a typo must not change answers
 * silently, so it is logged.
 */
function repContextFromEnv(raw) {
  const parsed = parseRepContextSwitch(raw);
  if (parsed !== null) return parsed;
  console.warn(`[server] REP_CONTEXT=${raw} must be 0 or 1; using 1`);
  return true;
}

/**
 * HIGHLIGHTS: 0/false/off turns key-phrase highlights off, 1/true/on (or
 * unset) keeps them on. Any other value keeps the default and is logged.
 */
function highlightsFromEnv(raw) {
  const parsed = parseHighlightsSwitch(raw);
  if (parsed !== null) return parsed;
  console.warn(`[server] HIGHLIGHTS=${raw} must be 0 or 1; using 1`);
  return true;
}

/**
 * ANSWER_CARDS: 0/false/off turns answer cards off, 1/true/on (or unset) keeps
 * them on. Any other value keeps the default and is logged.
 */
function answerCardsFromEnv(raw) {
  const parsed = parseAnswerCardsSwitch(raw);
  if (parsed !== null) return parsed;
  console.warn(`[server] ANSWER_CARDS=${raw} must be 0 or 1; using 1`);
  return true;
}

/**
 * GLOSSARY: 0/false/off turns Terms off, 1/true/on (or unset) keeps it on.
 * Any other value keeps the default and is logged.
 */
function glossaryFromEnv(raw) {
  const parsed = parseGlossarySwitch(raw);
  if (parsed !== null) return parsed;
  console.warn(`[server] GLOSSARY=${raw} must be 0 or 1; using 1`);
  return true;
}

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Accept https, or http to loopback. Throws a reason code and no raw URL.
 * @param {unknown} raw
 * @returns {string}
 */
export function assertProviderUrlAllowed(raw) {
  const result = checkProviderUrl(raw);
  if (!result.ok) {
    const error = new Error(`provider URL is not allowed (${result.reason})`);
    error.reason = result.reason;
    throw error;
  }
  return result.url;
}

/**
 * @param {unknown} mode
 * @param {Record<string, string|undefined>} env
 */
function resolveMode(mode, env) {
  const resolved = mode ?? env?.COPILOT_MODE ?? "live";
  if (resolved !== "live" && resolved !== "demo") {
    throw new Error(`COPILOT_MODE must be "live" or "demo" (got ${JSON.stringify(resolved)})`);
  }
  return resolved;
}

/**
 * The answer provider the engine gets. Live mode never answers with the mock:
 * demo text on a real call reads like advice. So in live mode a missing or
 * incomplete configuration, and an explicit mock, are "unconfigured", and
 * every answer fails with a reason the overlay names. Demo mode keeps the mock
 * for tests and the demo script.
 * @param {string|undefined} requested ANSWER_PROVIDER
 * @param {{baseUrl?: string, apiKey?: string, mode: "live"|"demo"}} config
 */
function resolveAnswerProvider(requested, { baseUrl, apiKey, mode }) {
  const missing = mode === "demo" ? "mock" : "unconfigured";
  if (requested == null) return missing;
  if (requested === "openai-compatible" && (!baseUrl || !apiKey)) {
    console.warn(`[server] ANSWER_PROVIDER=${requested} requires LLM_BASE_URL and LLM_API_KEY; using ${missing}`);
    return missing;
  }
  if (mode !== "demo" && (requested === "mock" || requested === "mock-scripted")) {
    console.warn(`[server] ANSWER_PROVIDER=${requested} is for COPILOT_MODE=demo only; live answers are unconfigured`);
    return "unconfigured";
  }
  return requested;
}

function present(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * ASR_API_KEY wins. Otherwise the LLM key is reused only on the LLM origin.
 * OPENAI_API_KEY is reused only when the ASR origin is the default OpenAI origin.
 */
function resolveAsrKey(env, asrBaseUrl, llm) {
  const explicit = present(env.ASR_API_KEY);
  if (explicit) return explicit;
  const scoped = scopedApiKey({ baseUrl: asrBaseUrl, fallback: llm });
  if (scoped) return scoped;
  const openaiKey = present(env.OPENAI_API_KEY);
  if (openaiKey && sameOrigin(asrBaseUrl, DEFAULT_OPENAI_ORIGIN)) return openaiKey;
  return undefined;
}

function liveAsrReadiness(provider, baseUrl, apiKey) {
  if (!present(provider)) return { ok: false, reason: "missing_provider" };
  if (provider === "mock" || provider === "mock-scripted") return { ok: false, reason: "mock_refused" };
  if (provider !== "openai-compatible") return { ok: false, reason: "unknown_provider" };
  if (!present(apiKey)) return { ok: false, reason: "missing_api_key" };
  if (!present(baseUrl)) return { ok: false, reason: "missing_url" };
  try {
    return { ok: true, url: assertProviderUrlAllowed(baseUrl) };
  } catch (error) {
    const reason = typeof error?.reason === "string" ? error.reason : "invalid_url";
    return { ok: false, reason };
  }
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @param {{mode?: string, answerInstructionsPath?: string, telemetryDir?: string, knownTermsPath?: string}} [options]
 *   answerInstructionsPath: the user's answer-instructions.txt (the desktop
 *   shell passes its own; ANSWER_INSTRUCTIONS_PATH serves a standalone server).
 *   telemetryDir: base directory for session telemetry logs.
 *   knownTermsPath: the user's known-terms.txt (the desktop shell passes its
 *   own; KNOWN_TERMS_PATH serves a standalone server).
 */
export function buildEngineConfig(rawEnv = process.env, { mode, answerInstructionsPath, telemetryDir, knownTermsPath } = {}) {
  const env = applyVendorPresets(rawEnv);
  const resolvedMode = resolveMode(mode, env);
  const baseUrl = env.LLM_BASE_URL;
  const apiKey = env.LLM_API_KEY;
  const model = env.LLM_MODEL;
  const answerProvider = resolveAnswerProvider(env.ANSWER_PROVIDER, { baseUrl, apiKey, mode: resolvedMode });

  const answerRoles = env.ANSWER_ROLES
    ? env.ANSWER_ROLES.split(",").map((role) => role.trim()).filter(Boolean)
    : undefined;

  // Prompt mode is session intent set by the operator ("technical" for
  // practice/rehearsal), never inferred from content. Unknown values fall back
  // to the spoken default: a typo must not take a live session down.
  const rawMode = env.ANSWER_PROMPT_MODE;
  if (rawMode && rawMode !== "spoken" && rawMode !== "technical") {
    console.warn(`[server] ANSWER_PROMPT_MODE=${rawMode} must be "spoken" or "technical"; using spoken`);
  }
  const promptMode = rawMode === "technical" ? "technical" : "spoken";
  const instructionsPath = present(answerInstructionsPath) ?? present(env.ANSWER_INSTRUCTIONS_PATH) ?? null;

  const llm = { baseUrl, apiKey };

  // The technical slot is opt-in: with no LLM_TECHNICAL_* set, both modes use
  // the base configuration and behavior is unchanged. The slot overrides
  // endpoint/model/key inside the provider the operator chose above
  // (answerProvider): LLM_TECHNICAL_* must never upgrade an explicit
  // ANSWER_PROVIDER=mock session to live answering. The shared LLM key only
  // follows the technical slot onto the LLM origin (scopedApiKey), so a second
  // origin can never silently receive the first one's key.
  const technicalBaseUrl = present(env.LLM_TECHNICAL_BASE_URL) ?? baseUrl;
  const technicalOverrides = {
    model: present(env.LLM_TECHNICAL_MODEL),
    reasoningEffort: present(env.LLM_TECHNICAL_REASONING_EFFORT),
    baseUrl: present(env.LLM_TECHNICAL_BASE_URL),
  };
  const technicalSlot =
    technicalOverrides.baseUrl || technicalOverrides.model || technicalOverrides.reasoningEffort || present(env.LLM_TECHNICAL_API_KEY)
      ? {
          provider: answerProvider,
          baseUrl: technicalBaseUrl,
          apiKey: scopedApiKey({ explicitKey: present(env.LLM_TECHNICAL_API_KEY), baseUrl: technicalBaseUrl, fallback: llm }),
          model: technicalOverrides.model ?? model,
          reasoningEffort: technicalOverrides.reasoningEffort,
        }
      : undefined;

  const asrBaseUrl = env.ASR_BASE_URL ?? baseUrl;
  // Vendor presets configure TEXT answers (Qwen on Cerebras takes no images),
  // so vision inherits only the LLM settings the operator set; with none, it
  // resolves its own provider (the DeepSeek preset, else the mock).
  const operatorLlm = { baseUrl: present(rawEnv.LLM_BASE_URL), apiKey: present(rawEnv.LLM_API_KEY) };
  const visionBaseUrl = env.VISION_BASE_URL ?? operatorLlm.baseUrl;
  const asrKey = resolveAsrKey(env, asrBaseUrl, llm);
  const asrModel = env.ASR_MODEL ?? model;
  const readiness = liveAsrReadiness(env.ASR_PROVIDER, asrBaseUrl, asrKey);

  let asrProvider;
  let asrReason;
  let asrConfigured = false;
  let asrUrl = asrBaseUrl;
  if (resolvedMode === "live") {
    if (readiness.ok) {
      asrProvider = "openai-compatible";
      asrConfigured = true;
      asrUrl = readiness.url;
    } else {
      asrProvider = "unconfigured";
      asrReason = readiness.reason;
      console.warn(`[server] ASR is not configured (${asrReason})`);
    }
  } else {
    asrProvider = env.ASR_PROVIDER ?? "mock";
    asrConfigured = readiness.ok;
    if (readiness.ok) asrUrl = readiness.url;
  }

  const asr = {
    provider: asrProvider,
    mode: resolvedMode,
    configured: asrConfigured,
    ...(asrReason ? { reason: asrReason } : {}),
  };

  return {
    mode: resolvedMode,
    asr,
    judgeOptions: judgeOptionsFromEnv(env),
    answerRoles,
    answerProvider,
    // Answer-model selection (answer-models.js): ANSWER_MODEL is the env
    // spelling of the Settings choice; the factory applies it per answer.
    answerModel: present(env.ANSWER_MODEL) ?? null,
    // Rep context (conversation-context.js): REP_CONTEXT is the env spelling
    // of the Settings checkbox "Use what I say in answers".
    repContext: repContextFromEnv(env.REP_CONTEXT),
    // Highlights (src/shared/highlights.js): HIGHLIGHTS is the env spelling
    // of the Settings checkbox "Highlight key phrases".
    highlights: highlightsFromEnv(env.HIGHLIGHTS),
    // Answer cards (src/shared/answer-cards.js): ANSWER_CARDS is the env spelling
    // of the Settings checkbox "Short answer cards".
    answerCards: answerCardsFromEnv(env.ANSWER_CARDS),
    // Terms (glossary.js): GLOSSARY is the env spelling of the Settings
    // checkbox "Explain terms". The glossary runs only on DeepSeek with
    // DEEPSEEK_API_KEY: no other engine or key stands in.
    glossary: glossaryFromEnv(env.GLOSSARY),
    glossaryOptions: present(env.DEEPSEEK_API_KEY)
      ? { apiKey: env.DEEPSEEK_API_KEY, knownTermsPath: present(knownTermsPath) ?? present(env.KNOWN_TERMS_PATH) ?? null }
      : null,
    deepseekApiKey: present(env.DEEPSEEK_API_KEY) ?? null,
    // The Qwen default is the CEREBRAS_API_KEY preset above.
    cerebrasAvailable: Boolean(present(env.CEREBRAS_API_KEY)),
    asrProvider,
    asrOptions: {
      provider: asrProvider,
      mode: resolvedMode,
      configured: asrConfigured,
      allowMockFallback: resolvedMode === "demo",
      ...(asrReason ? { reason: asrReason } : {}),
      baseUrl: asrUrl,
      apiKey: asrKey,
      model: asrModel,
      maxRequestsPerMinute: positiveInt(env.ASR_MAX_RPM),
    },
    answererOptions: {
      baseUrl,
      apiKey,
      model: model ?? "mock",
      temperature: env.LLM_TEMPERATURE ? Number(env.LLM_TEMPERATURE) : undefined,
      reasoningEffort: present(env.LLM_REASONING_EFFORT),
      promptMode,
      ...(technicalSlot ? { routes: { technical: technicalSlot } } : {}),
      answerInstructionsPath: instructionsPath,
    },
    visionOptions: {
      provider: env.VISION_PROVIDER,
      baseUrl: visionBaseUrl,
      apiKey: scopedApiKey({ explicitKey: env.VISION_API_KEY, baseUrl: visionBaseUrl, fallback: operatorLlm }),
      model: env.VISION_MODEL ?? present(rawEnv.LLM_MODEL),
      answerInstructionsPath: instructionsPath,
      // Like ASR: the stub screen reading is for demo mode only. Live screen
      // analysis with no vision model fails instead of inventing a reading.
      allowMockFallback: resolvedMode === "demo",
    },
    telemetryOptions: recorderOptionsFromEnv(env, { dir: telemetryDir }),
  };
}
