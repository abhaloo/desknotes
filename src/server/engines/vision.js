/**
 * Server-side vision engine for DeskNotes.
 *
 * The engine owns the authoritative dedup cache: the same `image_hash` seen
 * again (hotkey spam, reconnect retry, two clients on one session) is answered
 * from the LRU instead of paying another model round trip. The cache is
 * bounded so a long call cannot grow it without limit.
 *
 * Stage 1 of the screen turn: the model INTERPRETS the screenshot. It writes
 * a factual, bounded description (visible question or task text verbatim, key
 * code lines verbatim, diagrams and tables summarised, the kind of screen) and
 * never answers. The pipeline puts that description into the normal answer
 * stream's context (stage 2), so the answer model never needs to see pixels.
 *
 * The mock classification is deterministic for a given hash so the UI and
 * tests see stable shapes even though the mock cannot decode the image. A
 * real vision model plugs in behind the same `analyse()` interface. With no
 * model configured the mock answers; a configured model that fails is a typed
 * failure, never a made-up description that an answer would then rely on.
 */
import { hashImage } from "../../vision/index.js";
import { checkProviderUrl, providerFetch, readJsonCapped, scopedApiKey } from "./provider-http.js";
import { DEEPSEEK as DEEPSEEK_VENDOR, providerRequestExtras } from "./answer-models.js";
import { prompt, shippedPrompt } from "./prompts.js";

const DEFAULT_MAX_ENTRIES = 64;
/**
 * Provider call deadline. A vision request with no timeout used to hold the
 * connection's message queue (and with it all audio) for as long as the
 * provider hung; the transport now runs it off-queue, and this bounds what
 * a hung provider can cost even then.
 */
const PROVIDER_TIMEOUT_MS = 25_000;
const KINDS = new Set(["question", "code", "other"]);

/*
 * Inbound validation. Every screen_analyse field is client-controlled and
 * some flow into a third-party request (data: URL, prompt text), so they are
 * checked here, at the last hop before egress, whatever the transport did.
 */
/** Matches the server's upload cap; a 1920-wide JPEG is far below it. */
const DEFAULT_MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Declared type -> magic-number check run before bytes leave the process. */
const IMAGE_SIGNATURES = {
  "image/jpeg": (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) =>
    b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  "image/webp": (b) =>
    b.length >= 12 &&
    String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" &&
    String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP",
};
/** purpose/origin are routing hints, not free text: they reach the model prompt. */
const HINT_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Upper bound on the description that reaches the answer prompt. */
export const MAX_INTERPRETATION_CHARS = 1_200;
const MAX_TITLE_CHARS = 80;
/** ~1,200 characters of JSON-escaped prose plus the envelope. */
const MAX_REPLY_TOKENS = 700;

/**
 * The stage-1 prompt. Internal and fixed: the user's answer-instructions file
 * shapes the ANSWER (section 4), never what the model reads off the screen.
 */
export const INTERPRET_PROMPT = shippedPrompt("vision/interpret", { max_chars: MAX_INTERPRETATION_CHARS });

/** Why a live screen analysis fails when no vision model is configured. */
const NO_VISION_MODEL_TEXT = "no vision model is set up: add DEEPSEEK_API_KEY, then restart the app";

/** Deterministic stand-ins for the offline mock (no vision model configured). */
const STUB_READINGS = Object.freeze({
  question: {
    title: "Question on screen",
    interpretation:
      "Stub screen reading (no vision model configured): a question or task is on screen. " +
      "Its exact text cannot be read without a vision model.",
  },
  code: {
    title: "Code on screen",
    interpretation:
      "Stub screen reading (no vision model configured): code is on screen. " +
      "Its exact lines cannot be read without a vision model.",
  },
  other: {
    title: "Screen",
    interpretation:
      "Stub screen reading (no vision model configured): nothing specific could be read from the screen.",
  },
});

/**
 * @param {{log?: Function, provider?: string|{name?: string, analyse: Function}, model?: string, baseUrl?: string, apiKey?: string, maxEntries?: number, maxImageBytes?: number, allowMockFallback?: boolean}} [options]
 *   The interpretation prompt is fixed (INTERPRET_PROMPT). An
 *   `answerInstructionsPath` option is accepted and ignored: section 4 of that
 *   file now shapes the answer to a screen turn (answerer.js) instead.
 *   allowMockFallback: false (live mode, config.js) never uses the stub
 *   reading. With no vision model, or no pixels to send, the analysis fails
 *   with a reason instead, so no answer is built on a screen nobody read.
 * @returns {{analyse: (request: object, ctx?: {emit?: Function, sessionId?: string}) => Promise<object>, stats: () => object}}
 */
export function createVisionEngine({
  log,
  provider,
  model,
  baseUrl,
  apiKey,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  allowMockFallback = true,
} = {}) {
  const logger = typeof log === "function" ? log : () => {};
  const found = resolveProvider({ provider, model, baseUrl, apiKey, logger });
  const resolved = found.stub && !allowMockFallback ? { name: "none", redact: found.redact } : found;
  const cache = new Map(); // insertion order doubles as LRU order
  const counters = { hits: 0, misses: 0, errors: 0 };

  function cacheGet(hash) {
    if (!cache.has(hash)) return null;
    const value = cache.get(hash);
    cache.delete(hash);
    cache.set(hash, value); // refresh recency
    return value;
  }

  function cacheSet(hash, result) {
    if (cache.has(hash)) cache.delete(hash);
    cache.set(hash, result);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  return {
    /**
     * @param {object} request `screen_analyse` frame fields: command_id,
     *   image_hash, object_path, content_type, purpose, origin (or `bytes`).
     * @param {{emit?: Function, sessionId?: string}} [ctx]
     * @returns {Promise<{status: string, kind: string, title: string, summary: string, dedup: boolean, solve: string, failure?: string}>}
     *   `summary` is the interpretation (at most MAX_INTERPRETATION_CHARS).
     */
    async analyse(request = {}, { emit, sessionId } = {}) {
      const commandId = request.command_id ?? request.commandId ?? null;
      const input = validateRequest(request, { maxImageBytes });
      if (!input.ok) {
        logger({ type: "vision.rejected", sessionId, command_id: commandId, reason: input.reason });
        const result = failed("invalid_request", input.reason);
        emitResult(emit, commandId, result);
        return result;
      }
      const { hash, bytes, contentType, purpose, origin } = input;

      if (resolved.name === "none") {
        logger({ type: "vision.unconfigured", sessionId, command_id: commandId });
        const result = failed("unconfigured", NO_VISION_MODEL_TEXT);
        emitResult(emit, commandId, result);
        return result;
      }

      const cached = cacheGet(hash);
      if (cached) {
        counters.hits += 1;
        const result = { ...cached, dedup: true };
        logger({ type: "vision.dedup", sessionId, command_id: commandId, image_hash: hash });
        emitResult(emit, commandId, result);
        return result;
      }

      // Bytes only leave the process as the image they claim to be.
      if (resolved.name !== "mock" && bytes && !IMAGE_SIGNATURES[contentType ?? "image/jpeg"]?.(bytes)) {
        logger({ type: "vision.rejected", sessionId, command_id: commandId, reason: "content_mismatch" });
        const result = failed("invalid_request", "image bytes do not match the declared content_type");
        emitResult(emit, commandId, result);
        return result;
      }

      counters.misses += 1;
      let analysis = null;
      try {
        analysis = await resolved.analyse({
          ...request,
          purpose,
          origin,
          image_hash: hash,
          imageHash: hash,
          imageBytes: bytes ?? undefined,
          content_type: contentType ?? "image/jpeg",
          contentType: contentType ?? "image/jpeg",
          sessionId,
        });
      } catch (err) {
        counters.errors += 1;
        logger({
          type: "vision.error",
          provider: resolved.name,
          message: resolved.redact(String(err?.message ?? err)),
        });
        // A configured model that failed: an invented description would put
        // a screen nobody read into the answer, so this is a typed failure.
        const result = failed("provider", "the vision model could not read the screen");
        emitResult(emit, commandId, result);
        return result;
      }
      if (!analysis && !allowMockFallback) {
        const result = failed("provider", "the screen image did not reach the vision model");
        emitResult(emit, commandId, result);
        return result;
      }
      if (!analysis) {
        // No pixels to send (or no fetch support): the heuristic keeps the
        // overlay usable and is marked as the stub it is.
        analysis = mockAnalyse({ imageHash: hash, purpose, origin });
      }

      const kind = KINDS.has(analysis.kind) ? analysis.kind : "other";
      const interpretation = clip(
        [analysis.interpretation, analysis.solve].find((value) => typeof value === "string") ?? "",
        MAX_INTERPRETATION_CHARS,
      );
      if (!interpretation) {
        logger({ type: "vision.empty", sessionId, command_id: commandId, provider: resolved.name });
        const result = { analysisId: "", status: "empty", kind, title: "", summary: "", error: "", dedup: false, solve: "not_requested" };
        emitResult(emit, commandId, result);
        return result;
      }
      const result = {
        analysisId: analysis.analysisId ?? `an_${hash.slice(0, 12)}`,
        status: "ok",
        kind,
        title: clip(typeof analysis.title === "string" ? analysis.title : "", MAX_TITLE_CHARS),
        // The interpretation: what the screen shows, never an answer to it.
        summary: interpretation,
        error: "",
        dedup: false,
        // `solve` is the protocol's ENUM, not text.
        solve: "not_requested",
        // Only the local heuristic is a stub; a model reading is never marked.
        ...(analysis.stub === true ? { stub: true } : {}),
      };
      cacheSet(hash, result);
      logger({ type: "vision.analysed", sessionId, command_id: commandId, kind: result.kind });
      emitResult(emit, commandId, result);
      return result;
    },

    /** Test/introspection hook: bounded cache plus hit/miss counters. */
    stats() {
      return { ...counters, size: cache.size, maxEntries };
    },
  };
}

/**
 * The engine emits `screen.result` itself so the caller (pipeline or server)
 * does not have to know the frame shape; it also returns the result for
 * direct callers and tests.
 */
function emitResult(emit, commandId, result) {
  if (typeof emit !== "function" || commandId == null) return;
  emit({ type: "screen.result", data: { command_id: commandId, ...result } });
}

function failed(kind, message) {
  // The `failure` field is a string tag and every text field is a string.
  return {
    analysisId: "",
    status: "failed",
    kind: "",
    title: "",
    summary: "",
    error: message,
    dedup: false,
    solve: "not_requested",
    failure: kind,
  };
}

/**
 * @returns {{ok: true, hash: string, bytes: Uint8Array|null, contentType: string|null, purpose: string, origin: string} | {ok: false, reason: string}}
 */
function validateRequest(request, { maxImageBytes }) {
  const rawType = request.content_type ?? request.contentType;
  let contentType = null;
  if (rawType !== undefined && rawType !== null && rawType !== "") {
    contentType = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
    if (!Object.hasOwn(IMAGE_SIGNATURES, contentType)) return { ok: false, reason: "unsupported content_type" };
  }

  const rawBytes = request.imageBytes ?? request.image_bytes ?? request.bytes;
  let bytes = null;
  if (rawBytes !== undefined && rawBytes !== null) {
    if (rawBytes instanceof Uint8Array) bytes = rawBytes;
    else if (rawBytes instanceof ArrayBuffer) bytes = new Uint8Array(rawBytes);
    else if (ArrayBuffer.isView(rawBytes)) bytes = new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    else return { ok: false, reason: "image bytes must be binary" };
    if (bytes.byteLength > maxImageBytes) return { ok: false, reason: "image exceeds the size limit" };
    if (bytes.byteLength === 0) bytes = null;
  }

  const rawHash = request.image_hash ?? request.imageHash;
  let hash = null;
  if (rawHash !== undefined && rawHash !== null) {
    hash = typeof rawHash === "string" ? rawHash.toLowerCase() : "";
    if (!SHA256_HEX.test(hash)) return { ok: false, reason: "image_hash must be a sha256 hex digest" };
  }
  if (bytes) {
    const actual = hashImage(bytes);
    // The hash keys the dedup cache: bytes under someone else's hash would
    // poison every later hit for that hash.
    if (hash && hash !== actual) return { ok: false, reason: "image_hash does not match the image bytes" };
    hash = actual;
  }
  if (!hash) return { ok: false, reason: "screen_analyse frame has no image_hash" };

  return {
    ok: true,
    hash,
    bytes,
    contentType,
    purpose: hintToken(request.purpose, "context"),
    origin: hintToken(request.origin, "manual"),
  };
}

function hintToken(value, fallback) {
  return typeof value === "string" && HINT_TOKEN.test(value) ? value : fallback;
}

function mockAnalyse({ imageHash, purpose = "", origin = "" }) {
  const kind = classifyKind(imageHash, purpose, origin);
  return { kind, ...STUB_READINGS[kind], stub: true };
}

/** Collapse runs of spaces and blank lines, then cut at a word near `max`. */
function clip(text, max) {
  const clean = String(text ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.8 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}

export function classifyKind(imageHash, purpose = "", origin = "") {
  const clue = `${purpose} ${origin}`.toLowerCase();
  if (clue.includes("code")) return "code";
  if (clue.includes("question")) return "question";
  // Deterministic hash bucket: identical frames must classify identically so
  // dedup replays and UI state stay consistent.
  const bucket = parseInt(imageHash.slice(0, 2), 16) % 3;
  return bucket === 0 ? "question" : bucket === 1 ? "code" : "other";
}

/**
 * DeepSeek preset. Like the answerer's vendor presets, the key fills in the
 * generic settings only when nothing else names an endpoint, model or key.
 * `https://api.deepseek.com` is the OpenAI-compatible base; the transport
 * appends `/chat/completions`.
 */
const DEEPSEEK = Object.freeze({
  baseUrl: DEEPSEEK_VENDOR.baseUrl,
  // DeepSeek-V4.1-Flash, the DeepSeek model that takes images (answer-models.js).
  model: DEEPSEEK_VENDOR.models.flash,
});

/** Any explicit VISION_/LLM setting stops the vendor key from auto-selecting. */
function visionLlmConfigured() {
  return [
    "VISION_BASE_URL",
    "VISION_API_KEY",
    "VISION_MODEL",
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL",
  ].some((key) => present(env(key)));
}

function present(value) {
  return typeof value === "string" && value.length > 0;
}

function resolveProvider({ provider, model, baseUrl, apiKey, logger }) {
  const plain = (text) => text;
  if (provider && typeof provider === "object" && typeof provider.analyse === "function") {
    return { name: provider.name ?? "custom", analyse: provider.analyse, redact: plain };
  }
  const requested = provider ?? env("VISION_PROVIDER");
  // `VISION_PROVIDER=deepseek` always selects the preset; a bare DeepSeek key
  // only selects it in auto-mode, when no VISION_/LLM setting exists.
  const deepseek =
    requested === "deepseek" ||
    (requested == null && present(env("DEEPSEEK_API_KEY")) && !visionLlmConfigured());
  const preset = deepseek ? DEEPSEEK : null;
  const name = requested ?? (deepseek ? "deepseek" : "mock");
  const resolvedBaseUrl = baseUrl ?? env("VISION_BASE_URL") ?? preset?.baseUrl ?? env("LLM_BASE_URL");
  // The LLM key only follows the vision provider onto the LLM's own origin;
  // the DeepSeek key is the last fallback and is scoped the same way.
  const resolvedApiKey =
    apiKey ??
    scopedApiKey({
      explicitKey: env("VISION_API_KEY"),
      baseUrl: resolvedBaseUrl,
      fallback: { baseUrl: env("LLM_BASE_URL"), apiKey: env("LLM_API_KEY") },
    }) ??
    scopedApiKey({
      baseUrl: resolvedBaseUrl,
      fallback: { baseUrl: DEEPSEEK.baseUrl, apiKey: env("DEEPSEEK_API_KEY") },
    });
  const resolvedModel = model ?? env("VISION_MODEL") ?? preset?.model ?? env("LLM_MODEL") ?? "vision-mock";
  if ((name === "openai-compatible" || name === "deepseek") && resolvedBaseUrl && resolvedApiKey) {
    const endpoint = checkProviderUrl(resolvedBaseUrl);
    if (endpoint.ok) {
      return {
        name,
        redact: (text) => redactKey(text, resolvedApiKey),
        analyse: (request) =>
          analyseWithModel({
            request,
            provider: name,
            model: resolvedModel,
            baseUrl: endpoint.url,
            apiKey: resolvedApiKey,
            logger,
          }),
      };
    }
    // Log the reason, never the URL: it may embed credentials.
    logger({ type: "vision.provider_insecure_url", provider: name, reason: endpoint.reason });
    return { name: "mock", stub: true, analyse: async (request) => mockAnalyse(request), redact: plain };
  }
  if (name !== "mock") {
    logger({ type: "vision.provider_unconfigured", provider: name });
  }
  return { name: "mock", stub: true, analyse: async (request) => mockAnalyse(request), redact: plain };
}

function redactKey(text, key) {
  return typeof key === "string" && key.length >= 6 ? String(text).split(key).join("[redacted]") : String(text);
}

async function analyseWithModel({ request, provider = "openai-compatible", model, baseUrl, apiKey, logger }) {
  const bytes = request.imageBytes;
  const fetchImpl = globalThis.fetch;
  if (!bytes || typeof fetchImpl !== "function") {
    // No pixels to send (object store not materialised) or no fetch support:
    // degrade to the heuristic rather than failing the command.
    logger({ type: "vision.provider_no_image", provider });
    return null;
  }
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const response = await providerFetch(url, {
    method: "POST",
    signal: withTimeout(request.signal, PROVIDER_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      ...providerRequestExtras(baseUrl),
      model,
      max_tokens: MAX_REPLY_TOKENS,
      messages: [
        { role: "system", content: prompt("vision/interpret", { max_chars: MAX_INTERPRETATION_CHARS }) },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Describe this screenshot. purpose=${request.purpose ?? "context"} origin=${request.origin ?? "manual"}`,
            },
            {
              type: "image_url",
              image_url: { url: `data:${request.content_type ?? "image/jpeg"};base64,${toBase64(bytes)}` },
            },
          ],
        },
      ],
    }),
  }, { apiKey, fetchImpl });
  if (!response.ok) throw new Error(`vision provider HTTP ${response.status}`);
  const payload = await readJsonCapped(response);
  return parseModelAnswer(payload?.choices?.[0]?.message?.content ?? "");
}

/**
 * The model's JSON reply -> {kind, title, interpretation}. A reply cut off by
 * the token cap is not valid JSON, so the interpretation string is recovered
 * from the partial reply before falling back to the raw text.
 */
export function parseModelAnswer(text) {
  const raw = String(text ?? "");
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      const kind = KINDS.has(parsed.kind) ? parsed.kind : "other";
      const body = [parsed.interpretation, parsed.summary, parsed.solve].find((value) => typeof value === "string");
      return { kind, title: typeof parsed.title === "string" ? parsed.title : "", interpretation: body ?? "" };
    } catch {
      /* fall through to partial recovery */
    }
  }
  const field = (name) => {
    const found = raw.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
    if (!found) return null;
    try {
      return JSON.parse(`"${found[1].replace(/\\$/, "")}"`);
    } catch {
      return found[1];
    }
  };
  const partial = field("interpretation");
  const kindText = field("kind");
  const lower = raw.toLowerCase();
  const kind = KINDS.has(kindText) ? kindText : lower.includes("code") ? "code" : lower.includes("question") ? "question" : "other";
  if (partial != null) return { kind, title: field("title") ?? "", interpretation: partial };
  return { kind, title: "", interpretation: raw.trim() };
}

/** The caller's abort (connection gone, server deadline) OR our own deadline. */
function withTimeout(signal, ms) {
  const timeout = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : null;
  if (!signal) return timeout ?? undefined;
  if (!timeout) return signal;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== "undefined") return Buffer.from(view).toString("base64");
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function env(key) {
  return typeof process !== "undefined" && process.env ? process.env[key] : undefined;
}
