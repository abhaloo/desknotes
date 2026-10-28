/**
 * Answer engine: question -> streamed answer deltas.
 *
 * The mock provider is the default so the prefetch pipeline is fully testable
 * without credentials. It answers in a fixed structure (acknowledge ->
 * approach -> example -> bridge) and spaces deltas 40-80 ms apart so callers
 * can observe real streaming behavior rather than one buffered blob. Only an
 * explicit "mock" provider gets it: live mode never configures it
 * (config.js), because demo text on a real call reads like advice.
 *
 * An openai-compatible chat-completions endpoint plugs in behind the same
 * `streamAnswer` interface. Any other configuration (no key, an unknown
 * provider, "unconfigured", or an endpoint that fails the transport policy:
 * plaintext to a remote host, credentials in the URL) answers nothing: each
 * answer throws a `no_answer_model` error and no key is sent anywhere. The
 * session stays up; the overlay names the missing model.
 *
 * Answer cards (src/shared/answer-cards.js, `streamAnswer({cards: true})`):
 * an answer is a short card starting with a VERDICT line, capped at
 * CARD_LIMITS lines by the spoken-text filter. The answerer adds the card
 * rule, checks that line 1 is a VERDICT line (one retry), and cuts runaway
 * streams.
 *
 * Stalls: a provider that stops sending bytes (`stallMs`, default
 * DEFAULT_STALL_MS) is dropped and the answer fails with a `stalled` error
 * (code "stalled", retryable), so the pipeline can generate the answer again
 * instead of parking the turn until the session ends. Any bytes count as
 * progress (a reasoning-only event, a keep-alive comment), never just visible
 * tokens: a thinking model is quiet on content for seconds while it streams
 * its reasoning.
 */
import { checkProviderUrl, httpStatusError, providerFetch, readJsonCapped } from "./provider-http.js";
import { unrefTimer } from "../../shared/timers.js";
import { createSpokenTextFilter } from "./spoken-text-filter.js";
import { createLineCap } from "./card-line-cap.js";
import { loadAnswerInstructions, screenAnswerSection } from "./answer-instructions.js";
import { isCerebrasEngine, providerRequestExtras } from "./answer-models.js";
import { REP_CONTEXT_RULE } from "./conversation-context.js";
import { prompt, shippedPrompt } from "./prompts.js";
import { CARD_LIMITS, CLOSING_LABELS, isVerdictLine, verdictLineState, wantsDetail } from "../../shared/answer-cards.js";

/**
 * Spoken answers in the rep's voice, in plain human prose and a bullet
 * style: a short bulleted
 * list in Simplified Technical English, answer first, no chatbot openers or
 * closers, no formulaic threes. spoken-text-filter.js enforces the rules the
 * model can still break (the "- " on every line, two sentences per bullet,
 * no em dashes).
 *
 * Both prompt modes share the rule blocks below: the surface rules must
 * hold everywhere, so they live in exactly one place per prompt family.
 */
export const NO_CHATBOT_RULES = shippedPrompt("rules/no-chatbot");
export const SURFACE_RULES = shippedPrompt("rules/surface");

export const DEFAULT_SYSTEM_PROMPT = shippedPrompt("answer/spoken");

/** Technical answers are read silently: depth and honesty over spoken brevity. */
export const TECHNICAL_SYSTEM_PROMPT = shippedPrompt("answer/technical");

/**
 * Added whenever there is a Context, just before `Context:`: which blocks are
 * the rep's own material and which only report what was shown or said.
 */
export const GROUNDING_RULE = shippedPrompt("rules/grounding");

/** Technical grounding fallback: honesty over plausibility. */
export const GROUNDING_RULE_TECHNICAL = shippedPrompt("rules/grounding-technical");

/**
 * Added whenever the Context carries a SCREEN block (pipeline.js
 * buildContext), in every prompt mode: what the block is and how to use it.
 */
export const SCREEN_RULE = shippedPrompt("rules/screen");

/** Added only to the turn that a screen capture started. */
export const SCREEN_TURN_RULE = shippedPrompt("rules/screen-turn");

/**
 * Added whenever the Context carries a REP line in RECENT CONVERSATION
 * (`streamAnswer({repContext: true})`), in every prompt mode. The text lives
 * with the rest of rep context in conversation-context.js.
 */
export { REP_CONTEXT_RULE };

/**
 * Added after the base prompt (and a screen turn's section 4) when
 * `streamAnswer({highlights: true})`, in every prompt mode and whatever the
 * user's answer-instructions.txt says. spoken-text-filter.js enforces the same
 * shape (src/shared/highlights.js HIGHLIGHT_LIMITS).
 */
export const HIGHLIGHT_RULE = shippedPrompt("rules/highlight");

/**
 * The card rule added to answers with cards on: a VERDICT line, one labelled
 * line per part the question asks about, then a closing line (TRADE-OFF or
 * NEXT STEP), in full sentences that follow from each other.
 */
export const CARD_RULE = shippedPrompt("cards/card");

/** The card rule when the question asks for specifics (`wantsDetail`) or a screen capture starts the turn. */
export const DETAIL_CARD_RULE = shippedPrompt("cards/detail-card");

/**
 * Added to the user message of every card: models that weigh the end of the
 * prompt most see the line rule last, too.
 */
export const CARD_REMINDER = shippedPrompt("cards/reminder");

/**
 * Key-phrase rule for answer cards: each line marks the phrase that carries
 * its own main point, so the eye can scan the card line by line. The filter
 * keeps at most one mark per line, each five words or fewer.
 */
export const CARD_HIGHLIGHT_RULE = shippedPrompt("cards/card-highlight");

/** Base prompt for technical mode with cards on. */
export const TECHNICAL_CARD_PROMPT = shippedPrompt("answer/technical-card");

/** Retry note appended to the user message when the first attempt has no VERDICT line. */
export const CARD_RETRY_NOTE = shippedPrompt("cards/retry");

/** `streamAnswer({screen})` values: the turn a capture started, or a later turn that still carries it. */
export const SCREEN_USE = Object.freeze({ CAPTURE: "capture", CONTEXT: "context" });

const DEFAULT_DELTA_MIN_MS = 40;
const DEFAULT_DELTA_MAX_MS = 80;
/** A spoken answer is a few hundred words; anything far beyond is a runaway stream. */
const DEFAULT_MAX_ANSWER_CHARS = 32_000;
/** No real SSE line approaches this; a provider that never sends a newline must not grow the buffer forever. */
const MAX_SSE_LINE_CHARS = 1024 * 1024;
/** After [DONE], at most this much of the body is read in the background before the stream is cancelled. */
const DRAIN_MAX_BYTES = 64 * 1024;
const DRAIN_MAX_MS = 1000;
/**
 * Provider input bounds: a spoken question is a sentence or two and the
 * session context is a resume/playbook digest. Far beyond that is a runaway
 * transcript or abuse (paid tokens, prompt stuffing).
 */
const MAX_QUESTION_CHARS = 4_000;
const MAX_CONTEXT_CHARS = 32_000;
/** A priming request that has not answered by then is dropped: nothing waits for it. */
const PRIME_TIMEOUT_MS = 10_000;
/**
 * No bytes from the provider for this long and the answer has stalled. Normal
 * gaps between chunks are well under a second on every supported engine, and
 * a thinking phase still streams reasoning bytes; an empty card for longer
 * than this is already past what a rep on a call tolerates.
 */
export const DEFAULT_STALL_MS = 8_000;

/**
 * @param {{provider?: string, model?: string, baseUrl?: string, apiKey?: string,
 *   systemPrompt?: string, temperature?: number, reasoningEffort?: string,
 *   thinking?: "enabled" | "disabled",
 *   promptMode?: "spoken" | "technical", routes?: object,
 *   answerInstructionsPath?: string|null,
 *   deltaMinMs?: number, deltaMaxMs?: number, maxAnswerChars?: number,
 *   stallMs?: number, spokenFilter?: boolean, log?: Function}} [options]  reasoningEffort: sent as
 *   `reasoning_effort` when set (e.g. "none" on a reasoning model, whose hidden
 *   reasoning would otherwise delay the first visible token). thinking: the
 *   DeepSeek thinking switch (answer-models.js providerRequestExtras); off
 *   unless "enabled", and ignored on every other origin. spokenFilter:
 *   false keeps raw provider text (style bench only). promptMode: "spoken" |
 *   "technical", the mode a call gets when it names none. routes: per-mode
 *   provider overrides ({spoken|technical: {provider?, model?, baseUrl?,
 *   apiKey?, temperature?, reasoningEffort?, systemPrompt?}}), merged over the
 *   base options. answerInstructionsPath: the user's answer-instructions.txt,
 *   read again for every spoken-mode provider answer (an explicit systemPrompt
 *   wins; an unreadable file uses the built-in one). The technical mode keeps
 *   its own prompt. stallMs: how long a provider may send nothing before the
 *   answer fails as `stalled` (DEFAULT_STALL_MS; provider answers only).
 * @returns {{streamAnswer: Function, answerOnce: Function, prime: Function}}
 */
export function createAnswerer({
  provider = "mock",
  model = "mock",
  baseUrl,
  apiKey,
  systemPrompt,
  answerInstructionsPath = null,
  temperature = 0.4,
  reasoningEffort,
  thinking,
  promptMode = "spoken",
  routes = {},
  deltaMinMs = DEFAULT_DELTA_MIN_MS,
  deltaMaxMs = DEFAULT_DELTA_MAX_MS,
  maxAnswerChars = DEFAULT_MAX_ANSWER_CHARS,
  stallMs = DEFAULT_STALL_MS,
  spokenFilter = true,
  log,
} = {}) {
  const warn = typeof log === "function" ? log : () => {};
  // Two resolved slots, one per prompt mode: a thinking model can serve the
  // technical slot while the spoken slot keeps its latency class. Each slot is
  // resolved through the same transport policy; a slot that fails it answers
  // nothing, exactly like the base configuration.
  const baseSlot = { provider, model, baseUrl, apiKey, temperature, reasoningEffort, thinking, systemPrompt };
  const slots = {
    spoken: resolveSlot({ ...baseSlot, ...(routes.spoken ?? {}) }),
    technical: resolveSlot({ ...baseSlot, ...(routes.technical ?? {}) }),
  };
  function resolveSlot(slot) {
    return {
      ...slot,
      resolved: resolveProvider({ provider: slot.provider, baseUrl: slot.baseUrl, apiKey: slot.apiKey, warn, model: slot.model }),
    };
  }

  /**
   * The prompt for this answer: explicit, else (spoken) the user's file as it
   * is now. `screen` is section 4 of the same read, appended to the spoken
   * answer of a screen turn (null: nothing to append).
   */
  async function currentSystemPrompt(kind, slot, screenUse) {
    const wantsScreen = screenUse === SCREEN_USE.CAPTURE && kind === "spoken";
    if (slot.systemPrompt != null) return { prompt: slot.systemPrompt, screen: null };
    if (kind !== "spoken") return { prompt: undefined, screen: null };
    if (!answerInstructionsPath) return { prompt: undefined, screen: wantsScreen ? screenAnswerSection(null) : null };
    const loaded = await loadAnswerInstructions(answerInstructionsPath);
    if (loaded.error) warn({ type: "answerer.instructions_unreadable", reason: loaded.error });
    return { prompt: loaded.error ? undefined : loaded.prompt, screen: wantsScreen ? loaded.screen : null };
  }

  /**
   * @param {{question?: string, context?: string, intent?: string, mode?: string,
   *   signal?: AbortSignal, screen?: "capture"|"context", repContext?: boolean,
   *   highlights?: boolean, cards?: boolean, onCut?: (reason: string) => void}} [args]
   *   screen: the Context carries a SCREEN block; "capture" = this turn was
   *   started by the capture (adds SCREEN_TURN_RULE and section 4 of the
   *   user's file). repContext: the Context carries a REP line (adds
   *   REP_CONTEXT_RULE). highlights: ask for `**` key phrases (adds
   *   HIGHLIGHT_RULE) and keep them through the spoken-text filter; anything
   *   but true is today's prompt and filter, byte for byte.
   *   cards: the answer is a card; see src/shared/answer-cards.js.
   *   onCut: called once, before the stream ends, when the delivered answer is
   *   not the whole answer: "lines" or "code" (a card budget ran out), "line"
   *   (one card line was too long), "length" (maxAnswerChars).
   */
  async function* streamAnswer({ question = "", context = "", intent = "answer", mode, signal, screen, repContext, highlights, cards, onCut } = {}) {
    const kind = resolveMode(mode ?? promptMode, warn);
    const slot = slots[kind];
    const screenUse = screen === SCREEN_USE.CAPTURE || screen === SCREEN_USE.CONTEXT ? screen : null;
    let cutReason = null;
    const noteCut = (reason) => {
      cutReason ??= reason;
    };
    try {
      yield* answerFor({ question, context, intent, kind, slot, signal, screenUse, repContext, highlights, cards, noteCut });
    } finally {
      if (cutReason && !signal?.aborted && typeof onCut === "function") onCut(cutReason);
    }
  }

  /** What one answer sends: the same fields for streamAnswer and prime. */
  async function answerFields({ question, context, intent, kind, slot, screenUse, repContext, highlights, cards }) {
    const { prompt, screen: screenSection } = await currentSystemPrompt(kind, slot, screenUse);
    // A capture turn answers what the screen shows (code, a stack trace, a
    // diagram): specifics, so a detail card, which can carry a code block.
    const card = cards === true ? (wantsDetail(question) || screenUse === SCREEN_USE.CAPTURE ? "detail" : "default") : null;
    return {
      question,
      context,
      intent,
      mode: kind,
      screenUse,
      screenSection,
      repContext: repContext === true,
      highlights: highlights === true,
      card,
      model: slot.model,
      baseUrl: slot.resolved.baseUrl,
      apiKey: slot.apiKey,
      systemPrompt: prompt,
      temperature: slot.temperature,
      reasoningEffort: slot.reasoningEffort,
      thinking: slot.thinking,
    };
  }

  async function* answerFor({ question, context, intent, kind, slot, signal, screenUse, repContext, highlights, cards, noteCut }) {
    if (slot.resolved.name === "openai-compatible") {
      const fields = await answerFields({ question, context, intent, kind, slot, screenUse, repContext, highlights, cards });
      const open = (attempt, onLimit) =>
        streamFromChat({
          ...fields,
          signal,
          retry: attempt > 0,
          maxAnswerChars,
          stallMs,
          onLimit,
          warn,
        });
      const lengthCut = () => noteCut("length");
      if (!spokenFilter) {
        yield* open(0, lengthCut);
        return;
      }
      if (fields.card) {
        yield* cardStream(
          open,
          {
            highlights: highlights === true,
            maxLines: fields.card === "detail" ? CARD_LIMITS.detailLines : CARD_LIMITS.lines,
            maxCodeLines: CARD_LIMITS.codeLines,
            highlightsPerAnswer: CARD_LIMITS.detailLines,
            sentencesPerBullet: Infinity,
            reserveLabel: CLOSING_LABELS,
          },
          signal,
          warn,
          noteCut,
        );
        return;
      }
      yield* cleanSpoken(open(0, lengthCut), signal, { highlights: highlights === true });
      return;
    }
    if (slot.resolved.name === "mock") {
      yield* streamMock({ question, context, intent, signal, deltaMinMs, deltaMaxMs });
      return;
    }
    throw noAnswerModelError(slot.resolved.reason);
  }

  async function answerOnce(args = {}) {
    let text = "";
    for await (const delta of streamAnswer(args)) text += delta;
    return text;
  }

  // The arguments last primed (the dedupe key); a failed priming clears it.
  let primedKey = null;

  /**
   * Warm the provider's prompt cache for the next answer: one request with
   * max_tokens 1 and the same system message that answer will send (the
   * streamAnswer fields, with no question, so a default card). Cerebras only.
   * Fire-and-forget: nothing waits for it, and errors are logged as codes.
   * The same arguments are primed once per answerer. Returns whether a
   * request was sent.
   */
  function prime({ context = "", mode, screen, repContext, highlights, cards } = {}) {
    const kind = resolveMode(mode ?? promptMode, warn);
    const slot = slots[kind];
    if (slot.resolved.name !== "openai-compatible" || !isCerebrasEngine(slot.resolved.baseUrl)) return false;
    const screenUse = screen === SCREEN_USE.CONTEXT ? SCREEN_USE.CONTEXT : null;
    const key = JSON.stringify([kind, String(context), screenUse, repContext === true, highlights === true, cards === true]);
    if (key === primedKey) return false;
    primedKey = key;
    const timeout = AbortSignal.timeout(PRIME_TIMEOUT_MS);
    void (async () => {
      const fields = await answerFields({ question: "", context, intent: "final", kind, slot, screenUse, repContext, highlights, cards });
      const { url, payload } = chatRequest(fields);
      const response = await providerFetch(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${slot.apiKey}` },
          body: JSON.stringify({ ...payload, stream: false, max_tokens: 1 }),
          signal: timeout,
        },
        { apiKey: slot.apiKey },
      );
      if (!response.ok) throw primeFailure(`http_${response.status}`);
      await readJsonCapped(response);
    })().catch((error) => {
      if (primedKey === key) primedKey = null;
      warn({ type: "answerer.prime_failed", reason: primeReason(error, timeout.aborted) });
    });
    return true;
  }

  return { streamAnswer, answerOnce, prime };
}

/** A failed priming request, carrying the reason code the log names. */
function primeFailure(reason) {
  return Object.assign(new Error(reason), { primeReason: reason });
}

/** The reason code a failed priming request is logged with: never the error text, which can carry a URL or a key. */
function primeReason(error, timedOut) {
  return error?.primeReason ?? (timedOut ? "timeout" : "failed");
}

/** Provider deltas through the spoken-text filter; nothing is yielded after an abort. */
async function* cleanSpoken(source, signal, filterOptions) {
  const filter = createSpokenTextFilter(filterOptions);
  for await (const delta of source) {
    const clean = filter.push(delta);
    if (clean) yield clean;
  }
  if (signal?.aborted) return;
  const rest = filter.flush();
  if (rest) yield rest;
}

/** Longest first line the card check waits for before it decides. */
const CARD_FIRST_LINE_MAX_CHARS = 400;

/**
 * A card answer through the filter, with its budget. The first line is held
 * only until it is known to be (or not to be) a VERDICT line: a line that
 * starts with the label is shown at once, and a line that can no longer start
 * with it means the model ignored the card rule, so that stream is dropped and
 * asked once more. Nothing of a dropped stream reaches the caller, so a retry
 * never shows twice. When the filter is full, leaving the loop returns the
 * provider stream, which cancels it.
 * Each line then passes the per-line word cap (card-line-cap.js). The shown
 * attempt reports a cut to `noteCut`: the filter's budget first, then a cut
 * line, then the provider's length cap.
 */
async function* cardStream(open, filterOptions, signal, warn, noteCut) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const filter = createSpokenTextFilter(filterOptions);
    const cap = createLineCap({ maxWords: CARD_LIMITS.lineWords, maxSegments: CARD_LIMITS.lineSegments });
    let held = "";
    let checked = false;
    let retry = false;
    let lengthCut = false;
    for await (const delta of open(attempt, () => (lengthCut = true))) {
      const clean = cap.push(filter.push(delta));
      if (checked) {
        if (clean) yield clean;
      } else {
        held += clean;
        const end = held.indexOf("\n");
        const verdict = verdictLineState(end < 0 ? held : held.slice(0, end));
        const complete = end >= 0 || held.length >= CARD_FIRST_LINE_MAX_CHARS || filter.full;
        // Hold only while the first line is undecided: a line that may still become a
        // VERDICT line, or on the retry any first line until it is complete.
        if (!complete && (verdict === "maybe" || (verdict === "no" && attempt > 0))) continue;
        checked = true;
        if (attempt === 0 && verdict !== "yes") {
          retry = true;
          break;
        }
        if (held) yield held;
      }
      if (filter.full) {
        warn({ type: "answerer.card_cut", reason: filter.cut });
        break;
      }
    }
    if (signal?.aborted) return;
    if (retry) {
      warn({ type: "answerer.card_retry", reason: "no_verdict" });
      continue;
    }
    const rest = cap.push(filter.flush()) + cap.flush();
    const text = checked ? rest : held + rest;
    if (!checked && attempt === 0 && text && !isVerdictLine(text.split("\n")[0])) {
      warn({ type: "answerer.card_retry", reason: "no_verdict" });
      continue;
    }
    if (cap.wraps) warn({ type: "answerer.card_line_wrap", lines: cap.wraps });
    if (cap.cuts) warn({ type: "answerer.card_line_cut", lines: cap.cuts });
    const cut = filter.cut ?? (cap.cuts ? "line" : null) ?? (lengthCut ? "length" : null);
    if (cut) noteCut(cut);
    if (text) yield text;
    return;
  }
}

function resolveMode(mode, warn) {
  if (mode === "technical" || mode === "spoken") return mode;
  if (mode !== undefined) warn({ type: "answerer.unknown_prompt_mode", mode: String(mode) });
  return "spoken";
}

function resolveProvider({ provider, baseUrl, apiKey, warn, model }) {
  if (provider === "mock" || provider === "mock-scripted") return { name: "mock" };
  if (provider === "openai-compatible") {
    if (baseUrl && apiKey && typeof globalThis.fetch === "function") {
      const endpoint = checkProviderUrl(baseUrl);
      if (endpoint.ok) return { name: "openai-compatible", baseUrl: endpoint.url };
      // Log the reason, never the URL itself: it may embed credentials.
      warn({ type: "answerer.provider_insecure_url", provider, model, reason: endpoint.reason });
      return { name: "none", reason: endpoint.reason };
    }
    warn({ type: "answerer.provider_unconfigured", provider, model });
    return { name: "none", reason: "unconfigured" };
  }
  if (provider === "unconfigured") return { name: "none", reason: "unconfigured" };
  warn({ type: "answerer.provider_unknown", provider });
  return { name: "none", reason: "unknown_provider" };
}

/**
 * No model can answer. The turn fails instead of showing demo text:
 * `retryable: false` skips the pipeline's retry (it would fail the same way),
 * and `code` lets the overlay name the fix.
 * @param {string} reason a code: unconfigured, unknown_provider, or a URL policy reason
 */
function noAnswerModelError(reason = "unconfigured") {
  const error = new Error(`answerer: no answer model is set up (${reason})`);
  error.code = "no_answer_model";
  error.retryable = false;
  return error;
}

/* ------------------------------------------------------------------ mock -- */

async function* streamMock({ question, intent, signal, deltaMinMs, deltaMaxMs }) {
  const text = buildMockAnswer({ question, intent });
  const pieces = splitIntoDeltas(text);
  for (let i = 0; i < pieces.length; i += 1) {
    if (signal?.aborted) return;
    // Deterministic jitter: identical input streams identically, which keeps
    // tests honest while still looking organic in a demo.
    const span = Math.max(0, deltaMaxMs - deltaMinMs);
    const delay = deltaMinMs + (span === 0 ? 0 : (i * 37) % (span + 1));
    await wait(delay, signal);
    if (signal?.aborted) return;
    yield pieces[i];
  }
}

function buildMockAnswer({ question = "", intent = "" } = {}) {
  const subject = shorten(question) || "that";
  const opener = intent === "clarify" ? "Let me clarify. " : "Good question. ";
  return (
    `${opener}On "${subject}", the short answer is that it depends on how ` +
    "your team works today, so let me check one thing first. How many reps " +
    "would use it, and which tools do they already have open on a call? With " +
    "that I can show you the setup that fits, what it would cost for your " +
    "team, and how long it takes to get the first reps live. If it helps, " +
    "we can run a short trial with a few of your reps and look at the " +
    "results together before you decide."
  );
}

function shorten(value) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim().replace(/[?!.]+$/, "");
  if (!clean) return "";
  return clean.length > 90 ? `${clean.slice(0, 90)}...` : clean;
}

function splitIntoDeltas(text) {
  const tokens = text.match(/\S+\s*/g) ?? [];
  const out = [];
  let buffer = "";
  let target = 5;
  for (let i = 0; i < tokens.length; i += 1) {
    buffer += tokens[i];
    if (i % target === target - 1) {
      out.push(buffer);
      buffer = "";
      target = 3 + ((i * 7) % 5);
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

function wait(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener?.("abort", onAbort, { once: true });
  });
}

/* ------------------------------------------------- chat-completions (opt) -- */

/**
 * Base prompt, then (screen turn) the user's section 4, then (card) the card
 * rule, then (highlights) the key-phrase rule, then the fixed rules for what
 * the Context holds, then the Context itself.
 */
export function systemMessage(
  systemPrompt,
  context,
  mode = "spoken",
  { screenUse = null, screenSection = null, repContext = false, highlights = false, card = null } = {},
) {
  const technical = mode === "technical";
  const base = systemPrompt ?? (technical ? (card ? prompt("answer/technical-card") : prompt("answer/technical")) : prompt("answer/spoken"));
  const capture = screenUse === SCREEN_USE.CAPTURE;
  const cardRule = card ? (card === "detail" ? prompt("cards/detail-card") : prompt("cards/card")) : "";
  const highlightRule = highlights === true ? (card ? prompt("cards/card-highlight") : prompt("rules/highlight")) : "";
  const head = [base, capture && screenSection ? screenSection : "", cardRule, highlightRule]
    .filter(Boolean)
    .join("\n\n");
  if (!context) return head;
  const rules = [technical ? prompt("rules/grounding-technical") : prompt("rules/grounding")];
  if (screenUse) rules.push(prompt("rules/screen"));
  if (capture) rules.push(prompt("rules/screen-turn"));
  if (repContext) rules.push(prompt("rules/rep-context"));
  return `${head}\n\n${rules.join("\n\n")}\n\nContext:\n${context}`;
}

function userMessage(question, intent, mode, retry = false, card = null) {
  // Turn bookkeeping ("final", "prefetch") is not content: the technical
  // question carries its own constraints and nothing else is prepended.
  let text = mode === "technical" ? question : (intent ? `Sales-call intent: ${intent}\n\n${question}` : question);
  if (card) text += `\n\n${prompt("cards/reminder")}`;
  if (retry) text += `\n\n${prompt("cards/retry")}`;
  return text;
}

/** The chat-completions URL and JSON body of one answer request. */
function chatRequest({
  question,
  context,
  intent,
  mode = "spoken",
  screenUse = null,
  screenSection = null,
  repContext = false,
  highlights = false,
  card = null,
  retry = false,
  model,
  baseUrl,
  systemPrompt,
  temperature,
  reasoningEffort,
  thinking,
}) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  question = String(question ?? "").slice(0, MAX_QUESTION_CHARS);
  context = String(context ?? "").slice(0, MAX_CONTEXT_CHARS);
  const messages = [
    { role: "system", content: systemMessage(systemPrompt, context, mode, { screenUse, screenSection, repContext, highlights, card }) },
    { role: "user", content: userMessage(question, intent, mode, retry, card) },
  ];
  const payload = {
    ...providerRequestExtras(baseUrl, { thinking }),
    model,
    temperature,
    stream: true,
    messages,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
  return { url, payload };
}

async function* streamFromChat({
  question,
  context,
  intent,
  mode = "spoken",
  signal,
  screenUse = null,
  screenSection = null,
  repContext = false,
  highlights = false,
  card = null,
  retry = false,
  model,
  baseUrl,
  apiKey,
  systemPrompt,
  temperature,
  reasoningEffort,
  thinking,
  maxAnswerChars = DEFAULT_MAX_ANSWER_CHARS,
  stallMs = DEFAULT_STALL_MS,
  onLimit = () => {},
  warn = () => {},
}) {
  if (!baseUrl || !apiKey) {
    throw new Error("answerer: provider openai-compatible requires baseUrl and apiKey");
  }
  const { url, payload } = chatRequest({
    question,
    context,
    intent,
    mode,
    screenUse,
    screenSection,
    repContext,
    highlights,
    card,
    retry,
    model,
    baseUrl,
    systemPrompt,
    temperature,
    reasoningEffort,
    thinking,
  });

  // A per-call controller lets an aborted prefetch drop the HTTP stream
  // immediately instead of draining tokens nobody will read.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) return;
    signal.addEventListener?.("abort", onAbort, { once: true });
  }

  // The stall watchdog: every byte from the provider (headers, any chunk)
  // is progress. When `stallMs` pass with none, the request is aborted and
  // the answer fails as `stalled`. The wait on the provider is also raced
  // against the watchdog's own rejection, so the answer ends on time even on
  // a runtime that does not fail a pending read when its fetch is aborted.
  const watchdog = createStallWatchdog(stallMs, () => controller.abort());
  let reader = null;
  let doneSeen = false;
  let emitted = 0;
  try {
    const response = await watchdog.race(
      providerFetch(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
        { apiKey },
      ),
    );
    watchdog.progress();
    // The status rides on the error: the pipeline retries a 5xx, never a
    // refusal (402 out of credit, 401 key, 403 paywalled model).
    if (!response.ok) throw httpStatusError("answerer: chat endpoint", response);

    const contentType = response.headers?.get?.("content-type") ?? "";
    if (!response.body || !contentType.includes("event-stream")) {
      const payload = await watchdog.race(readJsonCapped(response));
      const text = payload?.choices?.[0]?.message?.content;
      if (text && String(text).length > maxAnswerChars) onLimit();
      if (text) yield String(text).slice(0, maxAnswerChars);
      return;
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await watchdog.race(reader.read());
      if (done) break;
      watchdog.progress();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_LINE_CHARS && buffer.indexOf("\n") < 0) {
        throw new Error("answerer: provider SSE line exceeds limit");
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          doneSeen = true;
          return;
        }
        let delta;
        try {
          delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        } catch {
          continue; // keep-alive or partial SSE line: ignore
        }
        if (typeof delta !== "string" || !delta) continue;
        // Truncate, never discard: the answer so far is still useful.
        const room = maxAnswerChars - emitted;
        const piece = delta.length > room ? delta.slice(0, room) : delta;
        emitted += piece.length;
        if (piece) yield piece;
        if (emitted >= maxAnswerChars) {
          onLimit();
          return;
        }
      }
    }
  } catch (error) {
    // The watchdog's abort surfaces as the runtime's AbortError (or as its
    // own rejection): name it as a stall unless the caller aborted, which
    // stays an abort.
    if (watchdog.stalled && !signal?.aborted) {
      const afterMs = watchdog.stalled;
      warn({ type: "answerer.stalled", after_ms: afterMs, emitted });
      throw stalledError(afterMs, emitted);
    }
    throw error;
  } finally {
    watchdog.stop();
    signal?.removeEventListener?.("abort", onAbort);
    // An early exit (line cap, abort, consumer stop, error) cancels the stream.
    // After [DONE] the rest of the body is read in the background so the
    // connection can be reused; nothing waits for it.
    if (reader && doneSeen) drainThenRelease(reader);
    else if (reader) reader.cancel().catch(() => {});
  }
}

/**
 * Read what is left of a body after [DONE] so the runtime can keep the
 * connection for the next request; cancelling here would close it. Runs in
 * the background (the answer stream never waits for it) and stops after
 * DRAIN_MAX_BYTES or DRAIN_MAX_MS, cancelling the body then.
 */
function drainThenRelease(reader) {
  let bytes = 0;
  const timer = unrefTimer(setTimeout(() => reader.cancel().catch(() => {}), DRAIN_MAX_MS));
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        bytes += value?.byteLength ?? 0;
        if (bytes > DRAIN_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          return;
        }
      }
    } catch {
      // cancelled at the deadline, or the body failed: nothing left to release
    } finally {
      clearTimeout(timer);
    }
  })();
}

/**
 * A provider that sent nothing for `afterMs`. `retryable`: the pipeline
 * generates the answer again (a stall is not a refusal). The message never
 * says "abort": the pipeline reads that word as its own cancel and would
 * stay silent.
 * @param {number} afterMs
 * @param {number} emitted characters delivered before the stall
 */
function stalledError(afterMs, emitted) {
  const error = new Error(`answerer: provider stalled (no data for ${afterMs} ms)`);
  error.code = "stalled";
  error.retryable = true;
  error.emitted = emitted;
  return error;
}

/**
 * Watches the gaps between progress events. One timer, re-armed only when it
 * fires (never per chunk): when it wakes and the last progress is older than
 * `stallMs`, it calls `onStall`, records the gap in `stalled` and rejects
 * every wait raced through it; otherwise it sleeps for what is left of the
 * budget. `race(promise)` settles with the promise or with the stall,
 * whichever comes first. `stop()` releases the timer; nothing fires after it.
 * A budget that is not a positive number disables the watchdog.
 */
function createStallWatchdog(stallMs, onStall) {
  const budget = Number(stallMs);
  const enabled = Number.isFinite(budget) && budget > 0;
  let lastProgressAt = Date.now();
  let timer = null;
  let rejectStall = null;
  const watchdog = { stalled: 0 };
  const stall = new Promise((_resolve, reject) => {
    rejectStall = reject;
  });
  stall.catch(() => {}); // only raced waits observe it; an unraced stall is not an unhandled rejection
  function arm(ms) {
    timer = unrefTimer(
      setTimeout(() => {
        timer = null;
        const idle = Date.now() - lastProgressAt;
        if (idle < budget) {
          arm(budget - idle);
          return;
        }
        watchdog.stalled = idle;
        rejectStall(new Error("stalled"));
        onStall();
      }, ms),
    );
  }
  if (enabled) arm(budget);
  watchdog.progress = () => {
    lastProgressAt = Date.now();
  };
  watchdog.race = (promise) => (enabled ? Promise.race([promise, stall]) : promise);
  watchdog.stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return watchdog;
}
