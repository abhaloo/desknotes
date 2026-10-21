/**
 * Pipeline engine: ASR -> gate -> turn orchestration.
 *
 * Wire vocabulary (docs/protocol.md): a server-side gate decides, then
 * `gate.verdict` / `turn.started` / `turn.token` / `turn.done` /
 * `turn.superseded` frames flow down. The gate's trigger lives server-side
 * and is not observable from the client; this
 * engine implements the contract with a documented accelerator of our
 * own: an answer starts while the speaker is still talking. Every `final:false`
 * transcript is a candidate question; once a partial is long enough (>= 8
 * words) or its last word has been stable for 250 ms, generation starts. With
 * a batch ASR (`batch` on the ASR object) a partial of three words or more
 * starts at once: its next partial is about a second away.
 * Converging partials (prefix-related wording) update the tracked question
 * WITHOUT restarting — regressed partials must never throw away completed
 * work — and a materially different question supersedes the in-flight turn.
 * A partial that EXTENDS the question by material wording (see
 * MATERIAL_* below) restarts the prefetch from the longer text: the old
 * stream answers a shorter question and could never be committed.
 * The `final:true` transcript commits the turn only if it matches the text the
 * generation was started from (`generatedFor`); then the already-running
 * (often already-finished) stream owns the answer, which is the difference
 * between "answer appears after the question" and "answer appears with the
 * question". Otherwise the final starts a fresh committed turn.
 *
 * Only answering roles (default: the prospect / system-audio stream) open or
 * commit turns; the rep is the person being coached.
 *
 * Held answers (`holdSpeculation`, on by default): every turn started before
 * the prospect is done (partial triggers, extensions, divergences, pause
 * hints) generates as described here but stays off screen: its frames are
 * buffered, and a held turn retired unseen sends nothing at all. It is shown
 * when the prospect is done: at a pause hint for which the judge says they
 * finished a question (no judge: the pause itself), or when the final
 * transcript commits it. A fast answer model otherwise wrote answers while
 * the prospect was still mid-sentence.
 *
 * End-of-turn hints (`onTurnHint`, wire frame `turn_hint`): the client VAD
 * says "probably done" ~0.7 s into a pause, just before its 24-frame
 * hangover closes the segment. A pause starts an UNCOMMITTED turn on the
 * latest partial right away (short questions never reach the 8-word
 * trigger, so this is where their head start comes from); a resume
 * cancels that turn if it is still streaming. Commit is unchanged: only
 * the final transcript commits, so a pause can never split one question
 * into two committed turns.
 *
 * The documented 250 ms stability rule now runs on a timer: it used to be
 * re-evaluated only when a NEW partial arrived, and the ASR suppresses
 * repeats, so it never fired for a question that had stopped growing. The
 * timer serves streaming ASR only (a batch ASR has no stability wait). The
 * two signals complement each other: the timer fires 250 ms after the last
 * word ARRIVES (ASR-paced), the hint 256 ms after the speaker went quiet
 * (VAD-paced), whichever is first starts the speculation.
 *
 * `answer_request` is the manual override (user-action only on the client,
 * as docs/protocol.md defines it). It never supersedes a live turn (that would thrash
 * the UI); it only fires when the answer lane is idle.
 *
 * Session context (resume/playbook/documents) is assembled once at session
 * start and passed verbatim on every generation so prompts stay consistent
 * across prefetch restarts.
 *
 * Screen turns (`onScreenAnalyse`) run in two stages. Stage 1, the vision
 * engine, only INTERPRETS the screenshot (a bounded description, never an
 * answer). Stage 2 is a normal committed turn in the answer lane, started the
 * moment the interpretation lands: the same answerer, cancellation and
 * telemetry paths as `answer_request`, with a SCREEN block plus the latest
 * prospect speech in its context. It replaces whatever holds the lane (the
 * capture is an explicit user action, and its prompt carries the question the
 * replaced answer was for). The latest interpretation then stays in the
 * context of later turns until `onScreenClear`, a newer capture or
 * SCREEN_CONTEXT_TTL_MS, whichever comes first. Only the latest is kept.
 *
 * Optional judge (judge.js, TypeSafe Jev): verdicts never gate the START of
 * work. The gate asks, in parallel with a turn that just started, whether the
 * utterance needs an answer at all and cancels small talk so it cannot hold
 * the lane. It also asks whether the thought is complete, so a pause reveal of
 * the same utterance can reuse that verdict. The rescue keeps a prefetch that
 * a reworded final no longer prefix-matches generating as a hidden "shadow"
 * while the fresh answer starts as before, and promotes the shadow if its
 * start text grew only non-materially into the last interim (code decides) and
 * the judge says that interim asks what the final asks. Without a judge,
 * nothing here changes.
 *
 * Rep context (`repContext`, on by default; conversation-context.js): the
 * final transcripts of BOTH speakers, rep lines filtered (echo, filler, the
 * rep reading the card), feed a RECENT CONVERSATION block into answers that
 * start later, and RECENT EXCHANGE then labels its answers `Suggested:`.
 * It changes context only: the speaker gate above is untouched, so the rep
 * still never opens, commits or supersedes a turn. `repContext` may be a
 * function, read for every transcript and every answer (the desktop Settings
 * checkbox). Off, the rep's speech is not kept and every prompt, context and
 * frame is what it was before the feature existed.
 *
 * Highlights (`highlights`, on by default; src/shared/highlights.js): every
 * answer is asked for `**` key phrases (`streamAnswer({highlights: true})`)
 * and the markers reach the client inside `turn.token` / `turn.done` text.
 * Answer text reused as plain words (RECENT EXCHANGE history, the rep-context
 * card comparison) has them stripped. `highlights` may be a function, read
 * for every answer (the desktop Settings checkbox). Off, `streamAnswer` gets
 * no `highlights` argument, so every prompt and frame is what it was before
 * the feature existed.
 *
 * Answer cards (`answerCards`, on by default; src/shared/answer-cards.js):
 * every answer is asked as a short card (`streamAnswer({cards: true})`).
 * `answerCards` may be a function, read for every answer (the desktop Settings
 * checkbox). Off, `streamAnswer` gets no `cards` argument, so every prompt,
 * filter output and frame is what it was before the feature existed.
 *
 * Priming (`answererImpl.prime`, answerer.js prime; Cerebras only): once the
 * session's document, resume or playbook is loaded, one request with
 * max_tokens 1 sends the system message the next default-card answer will
 * send, so the provider's prompt cache is warm for it. It is debounced
 * (PRIME_DEBOUNCE_MS), fire-and-forget, and skipped without session context.
 * The answerer skips arguments it has already primed. A partial never primes:
 * the speculative answer it starts sends the same prefix at the same moment,
 * so a prime there would only add a request beside the answer.
 *
 * Terms (`glossary`, on by default, with a `glossaryEngine`; glossary.js):
 * once the client has a committed card's `turn.done` (a rescue counts;
 * superseded, held, shadow and failed turns never do), one background request
 * asks the engine to explain up to three terms in that card, and a `terms`
 * frame carries them. The request starts a macrotask after `turn.done`, so a
 * final queued behind the card starts first, and only if the client still
 * shows that card; nothing on the answer path waits for it. It is aborted when
 * the client's card changes: when a newer `turn.started` is actually sent (an
 * unheld turn at its start, a held turn at its reveal, a rescue), and at
 * session start and end. A held turn that is never shown aborts nothing, and
 * a reply for a card the client no longer shows (Clear) is dropped.
 * `glossary` may be a function, read once per turn (the desktop Settings
 * checkbox). Off, or without an engine, no request is made and no frame is
 * sent.
 */
import { PROTOCOL_VERSION, STREAM } from "../../shared/protocol.js";
import { createAnswerer } from "./answerer.js";
import { createAsr } from "./asr.js";
import { createConversationLog, renderConversation } from "./conversation-context.js";
import { stripHighlights } from "../../shared/highlights.js";
import { isNoiseUtterance } from "./noise-utterance.js";

const PREFETCH_STABLE_MS = 250;
const PREFETCH_MIN_WORDS = 8;
/**
 * The stability timer needs a real phrase: below
 * three words a speculative answer could never be committed anyway (see
 * questionMatches) and would only flash a card for "could you".
 */
const STABLE_TIMER_MIN_WORDS = 3;
/**
 * "Material" growth of a question past the text a generation was started
 * from: at least this many new words AND the generated-for text covering
 * less than this share of the new wording. Below it, an extension is the same
 * question converging (keep the stream); above it, an answer to the prefix
 * would answer a different, shorter question. The coverage ratio makes
 * restarts logarithmic in question length, so word-by-word ASR growth cannot
 * thrash the answer lane.
 */
const MATERIAL_MIN_NEW_WORDS = 3;
const MATERIAL_MAX_COVERAGE = 2 / 3;
/** Only these speaker roles open or commit turns (the rep is the user). */
const DEFAULT_ANSWER_ROLES = Object.freeze(["prospect"]);

/** Judge gate: cancel a turn whose utterance is this unlikely to need an answer. */
const GATE_CANCEL_BELOW = 0.15;
/** Judge rescue: reuse the answer a reworded final still matches at or above this. */
const RESCUE_AT_LEAST = 0.8;
/** Judge reveal: at a pause, show a held answer once both are at or above these. */
const REVEAL_QUESTION_AT_LEAST = 0.5;
const REVEAL_COMPLETE_AT_LEAST = 0.5;
/** Speculative turns: generated while the prospect talks, held off screen until they are done. */
const HELD_REASONS = new Set(["partial_trigger", "partial_extend", "partial_diverge", "pause_hint"]);
const RECENT_PROSPECT_LINES = 3;
/** A screen interpretation stops reaching answers this long after its capture. */
export const SCREEN_CONTEXT_TTL_MS = 10 * 60_000;
/** The screen turn's question when the prospect has said nothing yet. */
const SCREEN_ONLY_QUESTION = "Answer the question or task shown on the screen.";
/** Priming waits this long for more changes (a session start and its document arrive together). */
const PRIME_DEBOUNCE_MS = 300;
/** Turn reasons the gate judges. Manual requests and rescues are never gated. */
const GATED_REASONS = new Set([
  "partial_trigger",
  "partial_extend",
  "partial_diverge",
  "pause_hint",
  "final",
  "final_restart",
  "queued_final",
]);

/**
 * @param {{emit?: Function, asr?: object|Function, answerer?: object,
 *   vision?: object|Function, log?: Function, asrOptions?: object,
 *   answererOptions?: object, visionOptions?: object, now?: Function,
 *   judge?: object, judgePolicy?: object, telemetry?: object,
 *   holdSpeculation?: boolean, repContext?: boolean|(() => boolean),
 *   highlights?: boolean|(() => boolean),
 *   answerCards?: boolean|(() => boolean),
 *   glossary?: boolean|(() => boolean), glossaryEngine?: object}} [options]
 *   repContext: feed what both speakers said into later answers (default on);
 *   a function is read per transcript and per answer, and a throw reads as off.
 *   highlights: ask every answer for `**` key phrases (default on); a function
 *   is read per answer, and a throw reads as off.
 *   answerCards: ask every answer as a short card (default on); a function
 *   is read per answer, and a throw reads as off.
 *   glossary: explain the terms of every finished card (default on); a
 *   function is read once per turn, and a throw reads as off.
 *   glossaryEngine: `{explain({text, signal}), close?()}` (glossary.js
 *   createGlossary); absent or `enabled: false` means no terms.
 * @returns {object} engine implementing the server engine contract
 */
export function createPipelineEngine({
  emit,
  asr,
  answerer,
  vision,
  log,
  asrOptions = {},
  answererOptions = {},
  visionOptions = {},
  now = Date.now,
  answerRoles = DEFAULT_ANSWER_ROLES,
  judge,
  judgePolicy = {},
  telemetry,
  holdSpeculation = true,
  repContext = true,
  highlights = true,
  answerCards = true,
  glossary = true,
  glossaryEngine,
} = {}) {
  const outbound = typeof emit === "function" ? emit : () => {};
  const logger = typeof log === "function" ? log : () => {};
  const answeringRoles = new Set(
    Array.isArray(answerRoles) && answerRoles.length > 0 ? answerRoles : DEFAULT_ANSWER_ROLES,
  );

  let closed = false;
  let sessionId = null;
  let contextParts = {}; // resume/playbook/docs strings; rendered per generation
  let contextString = ""; // last rendered static context (logs only)
  let turn = null; // generation currently owning the answer lane
  let pendingFinal = null; // one-slot queue while a committed answer streams
  // Stability is per stream: an interleaved speaker must not reset the clock
  // for the partial the prefetch rule is actually watching.
  const partialByStream = new Map();
  let lastQuestionText = "";
  let lastSayText = "";
  let turnSeq = 0;
  let saySeq = 0;
  let wireSeq = 0; // telemetry's own counter: the transport stamps its downlink seq later

  // Optional System One judge. Absent or disabled = the behaviour without it.
  const judgeImpl = judge && judge.enabled && typeof judge.evaluate === "function" ? judge : null;
  const gateOn = !!judgeImpl?.features?.gate;
  const rescueOn = !!judgeImpl?.features?.rescue;
  const policy = {
    gateCancelBelow: GATE_CANCEL_BELOW,
    rescueAtLeast: RESCUE_AT_LEAST,
    revealQuestionAtLeast: REVEAL_QUESTION_AT_LEAST,
    revealCompleteAtLeast: REVEAL_COMPLETE_AT_LEAST,
    ...judgePolicy,
  };
  const heldFrames = new Map(); // turn_id -> frames a held (speculative) turn has not shown yet
  let gatedOut = null; // { text }: normalized prefetch the gate judged small talk (current segment)
  let shadow = null; // superseded prefetch still generating while its rescue verdict is pending
  const recentProspect = []; // last few answering-role finals: judge context
  const recentExchange = []; // last finished committed answers: follow-up context
  // Latest screen interpretation: { text, kind, title, analysisId, capturedAt }.
  let screenContext = null;
  let screenEpoch = 0; // bumped by Clear/session start: older in-flight captures are dropped
  let screenSeq = 0; // per capture; an older capture landing late never replaces a newer one
  let screenApplied = 0;
  // Rep context: both speakers' finals, and the latest answer the client was shown.
  const conversation = createConversationLog({ now });
  let shownCard = null; // { id, text }
  let primeTimer = null; // the pending debounced answerer prime (schedulePrime)
  // Terms: the session's glossary, and the one request in flight ({ turnId, controller }).
  const glossaryImpl =
    glossaryEngine && glossaryEngine.enabled !== false && typeof glossaryEngine.explain === "function" ? glossaryEngine : null;
  let termsRequest = null;

  /** The rep-context switch as it is now; a resolver that throws reads as off. */
  function repContextOn() {
    if (typeof repContext !== "function") return repContext !== false;
    try {
      return repContext() !== false;
    } catch {
      return false;
    }
  }

  /** The highlights switch as it is now; a resolver that throws reads as off. */
  function highlightsOn() {
    if (typeof highlights !== "function") return highlights !== false;
    try {
      return highlights() !== false;
    } catch {
      return false;
    }
  }

  /** The answerCards switch as it is now; a resolver that throws reads as off. */
  function answerCardsOn() {
    if (typeof answerCards !== "function") return answerCards !== false;
    try {
      return answerCards() !== false;
    } catch {
      return false;
    }
  }

  /** The glossary switch as it is now; a resolver that throws reads as off. */
  function glossaryOn() {
    if (typeof glossary !== "function") return glossary !== false;
    try {
      return glossary() !== false;
    } catch {
      return false;
    }
  }

  /** A follow-up question is unanswerable without the exchange it follows. */
  function pushHistory(question, answer) {
    recentExchange.push({ q: question, a: answer });
    while (recentExchange.length > HISTORY_PAIRS) recentExchange.shift();
  }

  /**
   * Exactly once per turn, and only for an answer the client saw: a done,
   * committed, delivered turn. Superseded, cancelled and shadow turns never
   * become follow-up context.
   */
  function rememberExchange(target) {
    if (target.historyRecorded || !target.doneEmitted || !target.committed || target.cancelled) return;
    if (!(target.text ?? "").trim()) return;
    target.historyRecorded = true;
    pushHistory(target.historyQuestion ?? target.generatedFor, target.text);
  }

  const asrImpl = resolveAsr(asr, asrOptions);
  // A batch ASR's next partial is about a second away, so waiting for the
  // last word to stay stable only delays the speculative answer.
  const stableWaitMs = asrImpl?.batch === true ? 0 : PREFETCH_STABLE_MS;
  const answererImpl = resolveAnswerer(answerer, answererOptions);
  let visionImpl = typeof vision === "object" && vision ? vision : null;
  let visionPromise = null;

  /**
   * Additive session telemetry. `record` never throws by contract, but a bad
   * injected recorder must not be able to break a turn either, so every call
   * goes through here.
   */
  function recordTelemetry(event) {
    if (!telemetry || typeof telemetry.record !== "function") return;
    try {
      telemetry.record({ sessionId, ...event });
    } catch {
      /* telemetry is best effort; the turn must keep running */
    }
  }

  /** One `gate.verdict` per judge verdict consumed, whichever path consumed it. */
  function recordGateVerdict(turnId, verdict) {
    const event = {
      type: "gate.verdict",
      turnId,
      isQuestion: verdict?.isQuestion ?? null,
    };
    if (verdict?.answersSame != null) event.answersSame = verdict.answersSame;
    if (verdict?.latencyMs != null) event.latencyMs = verdict.latencyMs;
    recordTelemetry(event);
  }

  /** `{ type, ...payload }` of the frame as sent: client-visible fields flattened, no version. */
  function wireFrameSnapshot(frame) {
    const { data, v, ...rest } = frame ?? {};
    return { ...(data && typeof data === "object" ? data : {}), ...rest };
  }

  /** Frames of a held turn wait for its reveal; a held turn retired unseen leaves no trace. */
  function emitFrame(frame) {
    const id = frame?.data?.turn_id;
    const held = id != null ? heldFrames.get(id) : null;
    if (held) {
      if (frame.type === "turn.superseded") heldFrames.delete(id);
      else held.push(frame);
      return;
    }
    sendFrame(frame);
  }

  function sendFrame(frame) {
    noteShownCard(frame);
    // Snapshot before the send (it records the frame as sent), but record
    // after it: the recorder's redact and stringify stay off the token's path.
    const snapshot = wireFrameSnapshot(frame);
    try {
      outbound(frame);
    } catch (err) {
      logger({ type: "pipeline.emit_error", message: String(err?.message ?? err) });
    }
    recordTelemetry({ type: "wire.frame", seq: ++wireSeq, frame: snapshot });
  }

  /** The card text the client sees now: a rep line made of it is the rep reading it out. */
  function noteShownCard(frame) {
    const id = frame?.data?.turn_id;
    if (id == null) return;
    if (frame.type === "turn.started") {
      shownCard = { id, text: "" };
      // The client's card just changed: the older card's terms are moot. A
      // held turn gets here only at its reveal, so one never shown aborts nothing.
      if (termsRequest && termsRequest.turnId !== id) abortTerms();
    } else if (shownCard?.id !== id) return;
    else if (frame.type === "turn.token" && typeof frame.data.delta === "string") shownCard.text += frame.data.delta;
    else if (frame.type === "turn.done" && typeof frame.data.text === "string") shownCard.text = frame.data.text;
  }

  /**
   * Rep context: keep a final of either speaker (rep lines filtered), or note
   * the prospect's latest partial for the echo check. Off, nothing is kept and
   * what was kept goes, so switching on never revives old speech.
   */
  function recordConversation(data, text, answering) {
    if (!repContextOn()) {
      conversation.clear();
      return;
    }
    if (answering) {
      if (data.final) conversation.addProspect(text);
      else conversation.noteProspectSpeech(text);
      return;
    }
    if (!data.final || roleOf(data) !== "rep") return; // rep partials are ignored
    const dropped = conversation.addRep(text, { card: stripHighlights(shownCard?.text ?? "") });
    // Length and reason only: the text is the rep's own speech.
    if (dropped) logger({ type: "conversation.rep_dropped", reason: dropped, chars: text.length });
  }

  /* ------------------------------------------------------------- ASR tap -- */

  function onTranscript(data) {
    if (closed || !data || typeof data.text !== "string") return;
    const streamIdx = data.stream ?? data.streamIdx ?? STREAM.MICROPHONE;
    if (!data.final) {
      // Every interim hypothesis exactly as received, before the empty filter
      // and before any matching: re-emitted and revised interims are the
      // behaviour this telemetry exists to measure.
      recordTelemetry({ type: "asr.partial", stream: streamIdx, text: data.text });
    }
    const text = data.text.trim();
    if (!text) return;
    if (data.final && isProspect(data)) emitSay(data, text);
    // Speaker gate: the rep is the person being coached, so their speech is
    // never a question to answer — it must not open, supersede or queue a
    // turn (a long rep partial used to retire the prospect's prefetch).
    const answering = answeringRoles.has(roleOf(data));
    if (data.final) {
      // Rep context: the prospect's words count for the echo check before the
      // turn they start reads the conversation.
      if (answering && repContextOn()) conversation.noteProspectSpeech(text);
      // `handleFinal` reports whether this transcript opened or committed a
      // turn; finals that were gated out or ignored still get recorded.
      const outcome = answering ? handleFinal(data, text) : null;
      recordTelemetry({
        type: "asr.final",
        stream: streamIdx,
        text: data.text,
        ...(outcome?.gateSeq != null ? { gateSeq: outcome.gateSeq } : {}),
        committed: outcome?.committed ?? false,
      });
      // After handleFinal: the turn this final starts already answers it.
      recordConversation(data, text, answering);
      if (!answering) return;
      recentProspect.push(text);
      if (recentProspect.length > RECENT_PROSPECT_LINES) recentProspect.shift();
    } else {
      if (!answering) return;
      recordConversation(data, text, answering);
      handlePartial(data, text);
    }
  }

  function handlePartial(data, text) {
    const at = now();
    const streamIdx = data.stream ?? data.streamIdx ?? STREAM.MICROPHONE;
    let partial = partialByStream.get(streamIdx);
    if (!partial) {
      partial = { lastWord: "", lastWordAt: 0, text: "", data: null, timer: null };
      partialByStream.set(streamIdx, partial);
    }
    partial.text = text;
    partial.data = data;
    clearStableTimer(partial);
    const words = text.split(/\s+/).filter(Boolean);
    const lastWord = words[words.length - 1] ?? "";
    if (lastWord !== partial.lastWord) {
      partial.lastWord = lastWord;
      partial.lastWordAt = at;
    }
    const stableMs = at - partial.lastWordAt;
    lastQuestionText = text;

    const triggered =
      words.length >= PREFETCH_MIN_WORDS ||
      (partial.lastWord !== "" && stableMs >= PREFETCH_STABLE_MS) ||
      (words.length >= STABLE_TIMER_MIN_WORDS && stableMs >= stableWaitMs);

    if (turn && turn.committed) return; // committed turn owns the lane
    if (turn && turn.question === text) return; // not a newer partial
    if (turn) {
      if (isContinuation(turn.question, text)) {
        // Same question converging (extended or regressed partial): update
        // the tracked text and KEEP the generation. Restarting here is what
        // threw away completed answers for zero fidelity gain — a
        // continuation is not a new question.
        turn.question = text;
        // ...unless the question has outgrown what the generation answers
        // ("how much" -> "how much does the enterprise tier cost per seat").
        // That answer would be discarded at the final anyway, so restarting
        // NOW keeps the prefetch's head start. Regressions never restart.
        if (extendsMaterially(turn.generatedFor, text)) {
          speculate(partial, streamIdx, { question: text, intent: data.intent, reason: "partial_extend" });
        }
        return;
      }
      if (turn.finished) {
        // A complete answer exists — never discard it for a partial. The
        // final transcript arbitrates (commits it, or starts a new turn).
        return;
      }
      // Materially different question mid-stream: supersede and restart.
      speculate(partial, streamIdx, { question: text, intent: data.intent, reason: "partial_diverge" });
      return;
    }
    if (isGatedOut(text)) return; // the gate already judged this utterance small talk
    if (triggered) {
      emitSay(data, text);
      speculate(partial, streamIdx, { question: text, intent: data.intent, reason: "partial_trigger" });
      return;
    }
    if (words.length >= STABLE_TIMER_MIN_WORDS) {
      // Re-evaluate the stability rule when it COULD fire, not only when the
      // next (possibly never-arriving) partial does.
      partial.timer = setTimeout(() => {
        partial.timer = null;
        if (!closed && partial.text === text) handlePartial(data, text);
      }, Math.max(1, PREFETCH_STABLE_MS - stableMs + 1));
    }
  }

  function clearStableTimer(partial) {
    if (partial?.timer) clearTimeout(partial.timer);
    if (partial) partial.timer = null;
  }

  /**
   * Start an uncommitted turn on `streamIdx`. A partial that lands while the
   * speaker is already paused (the flush a pause asks for) is checked for
   * reveal straight away: no further pause hint is coming for it.
   */
  function speculate(partial, streamIdx, { question, intent, reason }) {
    const started = startTurn({ question, committed: false, intent, reason });
    if (!started) return null;
    started.streamIdx = streamIdx;
    if (partial?.paused) void checkReveal(started, partial, question);
    return started;
  }

  /**
   * Held turn, speaker paused: show it when the prospect is done. With a
   * judge, "done" is Jev's call (finished thought AND a question to answer);
   * a slow or failed verdict leaves it to the final transcript. Without a
   * judge, the pause itself is the signal.
   */
  async function checkReveal(target, partial, text) {
    if (!target?.held) return;
    const pauseSeq = partial.pauseSeq;
    const current = () =>
      !closed && turn === target && target.held && !target.cancelled && partial.paused && partial.pauseSeq === pauseSeq;
    if (!gateOn) {
      if (current()) revealTurn(target, "pause");
      return;
    }
    const verdict = await judgeImpl.evaluate({ utterance: text, recent: recentProspect.slice(), askComplete: true });
    if (closed) return;
    recordGateVerdict(target.id, verdict);
    logger({
      type: "judge.reveal",
      turn_id: target.id,
      p_question: verdict.isQuestion,
      p_complete: verdict.isComplete,
      latency_ms: verdict.latencyMs,
      error: verdict.error,
    });
    applyGate(target, verdict); // small talk: retire it unseen
    if (!current()) return;
    const done =
      verdict.isQuestion != null &&
      verdict.isComplete != null &&
      verdict.isQuestion >= policy.revealQuestionAtLeast &&
      verdict.isComplete >= policy.revealCompleteAtLeast;
    if (done) revealTurn(target, "pause_judged");
  }

  /** Send a held turn's buffered frames (tokens coalesced) and stream it live from here on. */
  function revealTurn(target, why) {
    if (!target?.held) return false;
    target.held = false;
    const frames = heldFrames.get(target.id) ?? [];
    heldFrames.delete(target.id);
    if (target.cancelled) return false;
    logger({
      type: "turn.revealed",
      turn_id: target.id,
      why,
      held_ms: now() - target.startedAt,
      chars: (target.text ?? "").length,
    });
    recordTelemetry({ type: "turn.revealed", turnId: target.id, reason: why });
    let pending = null;
    for (let frame of frames) {
      // Partials kept growing while the turn was held: the question shown
      // above the answer is the latest wording (the final, after a commit).
      if (frame.type === "turn.started" && target.question && frame.data.question !== target.question) {
        frame = { ...frame, data: { ...frame.data, question: target.question } };
      }
      if (frame.type === "turn.token") {
        if (pending) pending.data.delta += frame.data.delta;
        else pending = { ...frame, data: { ...frame.data } };
        continue;
      }
      if (pending) sendFrame(pending);
      pending = null;
      sendFrame(frame);
    }
    if (pending) sendFrame(pending);
    return true;
  }

  /**
   * Client VAD end-of-turn hint for one stream: "pause" = probable end of
   * turn (speculate now), "resume" = the speaker kept going.
   */
  function onTurnHint({ streamIdx, state } = {}) {
    if (closed) return;
    const partial = partialByStream.get(streamIdx);
    if (state === "resume") {
      if (partial) partial.paused = false;
      // Retract our speculation if it is still streaming; a finished answer
      // stays for the final to arbitrate, like any other prefetch.
      if (turn && !turn.committed && !turn.finished && turn.reason === "pause_hint" && turn.streamIdx === streamIdx) {
        cancelTurn(turn, "hint_retracted");
        turn = null;
        logger({ type: "turn.hint_retracted", stream: streamIdx });
      }
      return;
    }
    if (state !== "pause") return;
    // A batch ASR's latest interim can trail the audio by up to a second:
    // ask for one covering everything said so far (it extends the turn
    // through the normal partial path if it adds material wording).
    try {
      asrImpl.flushInterim?.(streamIdx);
    } catch {
      /* optional ASR capability */
    }
    // Only the current segment's partial counts (cleared on its final), and
    // only answering roles ever reach partialByStream.
    if (!partial?.text) return;
    partial.paused = true;
    partial.pauseSeq = (partial.pauseSeq ?? 0) + 1;
    clearStableTimer(partial);
    if (turn) {
      // Something already answers (or owns) the lane; a held answer on this
      // stream may now be shown.
      if (turn.held && turn.streamIdx === streamIdx) void checkReveal(turn, partial, partial.text);
      return;
    }
    if (isNoiseUtterance(partial.text)) return;
    if (isGatedOut(partial.text)) return;
    emitSay(partial.data ?? {}, partial.text);
    speculate(partial, streamIdx, { question: partial.text, intent: partial.data?.intent, reason: "pause_hint" });
  }

  function handleFinal(data, text) {
    lastQuestionText = text;
    // The segment is closed: its partial must never seed a later hint.
    const segment = partialByStream.get(data.stream ?? data.streamIdx ?? STREAM.MICROPHONE);
    if (segment) {
      clearStableTimer(segment);
      segment.text = "";
      segment.data = null;
      segment.lastWord = "";
      segment.paused = false;
    }
    const gateSeq = data.gateSeq ?? data.gate_seq ?? null;
    if (isNoiseUtterance(text)) {
      logger({ type: "turn.final_noise", chars: text.length });
      return { committed: false, gateSeq };
    }
    // The gate judged this segment's prefetch small talk: its final is too.
    const wasGatedOut = isGatedOut(text);
    gatedOut = null;

    if (turn && turn.committed) {
      if (wasGatedOut) return { committed: false, gateSeq };
      // One slot, latest wins: the client should see every question answered
      // but interleaving two streams would scramble the overlay.
      pendingFinal = { text, gateSeq };
      logger({ type: "pipeline.final_queued", turn_id: turn.id });
      return { committed: true, gateSeq };
    }
    if (turn && !turn.committed) {
      // Judge the final against the question the generation was STARTED
      // from, not the latest partial: partials update `turn.question` while
      // the stream keeps answering the older text.
      if (questionMatches(turn.generatedFor, text)) {
        turn.question = text;
        turn.committed = true;
        turn.intent = "final";
        turn.reason = "final_commit";
        revealTurn(turn, "final");
        if (gateSeq != null) {
          turn.gateSeq = gateSeq;
          // The turn opened (and may already be done) without a gate_seq:
          // announce the verdict now so the client can still attach this
          // answer to the question the final committed.
          emitFrame({
            v: PROTOCOL_VERSION,
            type: "gate.verdict",
            data: { gate_seq: gateSeq, verdict: "answer", turn_id: turn.id },
          });
        }
        logger({
          type: "turn.commit",
          turn_id: turn.id,
          question: turn.question,
          generated_for: turn.generatedFor,
          already_finished: turn.finished,
        });
        // A finished prefetch is the best case: zero extra latency.
        if (turn.finished) {
          const shown = turn;
          finishTurn(shown, "final_commit");
          // Its turn.done reached the client with the reveal, or before it,
          // so finishTurn already ran once, uncommitted: record it now.
          if (!shown.failed) rememberExchange(shown);
          scheduleTerms(shown);
        }
        return { committed: true, gateSeq };
      }
      if (rescueOn && !turn.cancelled) {
        // Keep the prefetch generating, unseen, while the judge decides
        // whether it answers the reworded final; regenerate meanwhile.
        const contender = turn;
        // The latest interim, captured before anything below can move it.
        const lastInterim = contender.question || contender.generatedFor;
        keepAsShadow(contender);
        const fresh = startTurn({
          question: text,
          committed: true,
          gateSeq,
          intent: "final",
          reason: "final_restart",
          gate: false, // the rescue request carries is_question too
          keepShadow: true,
        });
        if (fresh) void judgeRescue(contender, fresh, text, lastInterim);
        else dropShadow("no_fresh_turn");
        return { committed: !!fresh, gateSeq };
      }
      startTurn({ question: text, committed: true, gateSeq, intent: "final", reason: "final_restart" });
      return { committed: true, gateSeq };
    }
    if (wasGatedOut) {
      logger({ type: "turn.final_gated_out", chars: text.length });
      return { committed: false, gateSeq };
    }
    startTurn({ question: text, committed: true, gateSeq, intent: "final", reason: "final" });
    return { committed: true, gateSeq };
  }

  /* ------------------------------------------------------------ turns ---- */

  function startTurn({
    question,
    committed = false,
    gateSeq = null,
    intent = null,
    reason = "start",
    gate = true,
    keepShadow = false,
    screenTurn = null,
    prospect = null,
    historyQuestion = null,
    displayQuestion = null,
  }) {
    if (closed) return null;
    const clean = String(question ?? "").trim();
    if (!clean) return null;
    if (shadow && !keepShadow) dropShadow("lane_moved");
    if (turn) cancelTurn(turn, reason);

    const id = `turn_${++turnSeq}`;
    const next = {
      id,
      question: clean, // latest tracked wording (partials update it)
      generatedFor: clean, // what the stream actually answers (never changes)
      committed: !!committed,
      gateSeq: gateSeq ?? null,
      intent: intent ?? (committed ? "final" : "prefetch"),
      reason,
      controller: new AbortController(),
      iterator: null,
      text: "",
      finished: false,
      doneEmitted: false,
      cancelled: false,
      retried: false,
      startedAt: now(),
      // Screen turns only: stage timings, the prospect lines the prompt
      // carries, and the shorter question follow-ups see in RECENT EXCHANGE.
      screenTurn,
      prospect,
      historyQuestion,
    };
    turn = next;
    if (holdSpeculation && !next.committed && HELD_REASONS.has(reason)) {
      next.held = true;
      heldFrames.set(id, []);
    }
    // The gate announces its decision first, then the turn opens with
    // `gate_seq` on the FIRST frame so the client can render the
    // answer under the question it answers.
    if (next.gateSeq != null) {
      emitFrame({
        v: PROTOCOL_VERSION,
        type: "gate.verdict",
        data: { gate_seq: next.gateSeq, verdict: "answer", turn_id: id },
      });
    }
    emitFrame({
      v: PROTOCOL_VERSION,
      type: "turn.started",
      data: {
        turn_id: id,
        question: clean,
        intent: next.intent,
        ...(next.gateSeq != null ? { gate_seq: next.gateSeq } : {}),
        // What the answer window shows above the answer when `question` is
        // prompt text rather than the prospect's words (screen turns).
        ...(displayQuestion ? { display_question: displayQuestion } : {}),
      },
    });
    logger({
      type: "turn.start",
      turn_id: id,
      question: clean,
      committed: next.committed,
      reason,
    });
    recordTelemetry({
      type: "turn.started",
      turnId: id,
      reason,
      committed: next.committed,
      intent: next.intent,
      chars: clean.length,
      ...(screenTurn
        ? {
            screen: {
              analysisId: screenTurn.analysisId,
              kind: screenTurn.kind,
              chars: screenTurn.chars,
              dedup: screenTurn.dedup,
              stub: screenTurn.stub,
              visionMs: screenTurn.visionMs,
            },
          }
        : {}),
    });
    void runGeneration(next);
    if (gate && gateOn && GATED_REASONS.has(reason)) void gateTurn(next);
    return next;
  }

  function cancelTurn(target, reason = "superseded") {
    if (!target || target.cancelled) return;
    target.cancelled = true;
    // An in-flight turn that is replaced tells the client so its card can be
    // retired instead of hanging forever.
    if (!target.doneEmitted) {
      target.doneEmitted = true;
      recordTelemetry({ type: "turn.superseded", turnId: target.id, reason });
      emitFrame({ v: PROTOCOL_VERSION, type: "turn.superseded", data: { turn_id: target.id } });
    }
    try {
      target.controller.abort();
    } catch {
      /* controller already gone */
    }
    try {
      target.iterator?.return?.();
    } catch {
      /* iterator may not be ready yet */
    }
  }

  /**
   * streamAnswer's arguments for an answer to `question` started now. A
   * priming request uses them too (no question), so its system message is the
   * one the next answer sends.
   */
  function answerArgs({ question, prospect = null, screenTurn = false }) {
    const screen = currentScreen();
    // Read once per generation: a change applies from the next answer.
    const lines = repContextOn() ? conversation.lines() : null;
    const repLines = !!lines && renderConversation(lines, { skipProspect: prospect ?? [] }) !== "";
    return {
      question,
      // History is rendered per generation (the static parts are fixed for
      // the session); a generation already streaming keeps the context it
      // started with, as before.
      context: buildContext({
        ...contextParts,
        question,
        history: recentExchange.slice(),
        screen,
        prospect,
        ...(lines ? { conversation: lines } : {}),
      }),
      ...(screen ? { screen: screenTurn ? "capture" : "context" } : {}),
      // Like `screen`: the Context carries a REP line (the answerer adds its rule).
      ...(repLines ? { repContext: true } : {}),
      // Read once per generation, like repContext: a change applies from the next answer.
      ...(highlightsOn() ? { highlights: true } : {}),
      ...(answerCardsOn() ? { cards: true } : {}),
    };
  }

  async function runGeneration(target) {
    let iterator = null;
    let text = "";
    // Only the attempt that answers names its model: a retry starts clean.
    target.fallback = null;
    try {
      const stream = answererImpl.streamAnswer({
        ...answerArgs({ question: target.generatedFor, prospect: target.prospect ?? null, screenTurn: !!target.screenTurn }),
        intent: target.intent,
        signal: target.controller.signal,
        // The answerer says when the delivered text is not the whole answer;
        // turn.done carries it so the card can say so.
        onCut: (reason) => {
          if (typeof reason === "string" && reason) target.cut ??= reason;
        },
        // The answerer says when a model other than the chosen one answers;
        // turn.done carries it, like `cut`, for a quiet note under the card.
        onFallback: (note) => {
          target.fallback = fallbackNote(note);
        },
      });
      iterator = stream?.[Symbol.asyncIterator]?.();
      if (!iterator) throw new Error("answerer.streamAnswer did not return an async iterable");
      target.iterator = iterator;

      for (;;) {
        const step = await iterator.next();
        if (!step || step.done) break;
        const delta = step.value;
        // A shadow keeps buffering after its card was retired: a rescue may
        // still promote it, and then forwards what it generates next.
        if (target.shadow || target.rescuedBy) {
          if (typeof delta === "string" && delta.length > 0) {
            text += delta;
            target.text = text;
            forwardRescue(target, delta);
          }
          continue;
        }
        // Superseded mid-flight: stop emitting, the new turn owns the lane.
        if (turn !== target || target.cancelled) return;
        if (typeof delta !== "string" || delta.length === 0) continue;
        text += delta;
        target.text = text;
        if (target.screenTurn && target.screenTurn.firstDeltaAt == null) target.screenTurn.firstDeltaAt = now();
        emitFrame({
          v: PROTOCOL_VERSION,
          type: "turn.token",
          data: { turn_id: target.id, delta },
        });
      }

      if (target.shadow || target.rescuedBy) {
        target.text = text;
        target.finished = true;
        if (target.rescuedBy) finishRescue(target, "stream_end");
        return;
      }
      if (turn !== target || target.cancelled) return;
      target.text = text;
      target.finished = true;
      logger({
        type: "turn.stream_end",
        turn_id: target.id,
        committed: target.committed,
        chars: text.length,
      });
      // turn.done closes the card whenever generation ends — committed or
      // not: a client must be able to tell "done" from
      // "still streaming", and an uncommitted prefetch that never sees a
      // final would otherwise dangle forever.
      finishTurn(target, "stream_end");
    } catch (err) {
      if (target.rescuedBy) {
        const rescue = target.rescuedBy;
        if (!isAbort(err) && turn === rescue && !rescue.cancelled) {
          rescue.finished = true;
          emitFrame({
            v: PROTOCOL_VERSION,
            type: "error",
            data: { code: "generation_failed", turn_id: rescue.id, message: String(err?.message ?? err) },
          });
          finishTurn(rescue, "error");
        }
        return;
      }
      if (target.shadow) {
        if (shadow === target) dropShadow("error");
        return;
      }
      if (target.cancelled || turn !== target || isAbort(err)) return;
      target.text = text;
      target.error = String(err?.message ?? err);
      if (!target.retried && text.length === 0 && err?.retryable !== false) {
        // One transparent retry: the client is told a retry is
        // happening so a slow answer reads as "working", not "broken".
        // A refusal is not retried: the provider already said no (402 out of
        // credit carries `x-should-retry: false`), so the second attempt would
        // land on the same wall and only delay the error the user needs.
        target.retried = true;
        emitFrame({
          v: PROTOCOL_VERSION,
          type: "error.retry",
          data: { turn_id: target.id, attempt: 2 },
        });
        target.controller = new AbortController();
        return void runGeneration(target);
      }
      target.finished = true;
      logger({ type: "turn.error", turn_id: target.id, message: target.error });
      emitFrame({
        v: PROTOCOL_VERSION,
        type: "error",
        data: { code: "generation_failed", turn_id: target.id, message: target.error },
      });
      // Even a failed generation must close the client's answer card.
      finishTurn(target, "error");
    } finally {
      try {
        await iterator?.return?.();
      } catch {
        /* already disposed */
      }
    }
  }

  function finishTurn(target, reason) {
    // A failed answer gets no terms, even if a final commits it later.
    if (reason === "error") target.failed = true;
    if (!target.doneEmitted) {
      target.doneEmitted = true;
      if (!target.cancelled) {
        const data = { turn_id: target.id, text: target.text ?? "" };
        if (target.gateSeq != null) data.gate_seq = target.gateSeq;
        if (target.cut) data.cut = target.cut;
        if (target.fallback) data.fallback = target.fallback;
        emitFrame({ v: PROTOCOL_VERSION, type: "turn.done", data });
        logger({
          type: "turn.done",
          turn_id: target.id,
          reason,
          chars: (target.text ?? "").length,
          ...(target.cut ? { cut: target.cut } : {}),
          ...(target.fallback ? { fallback: target.fallback } : {}),
        });
        recordTelemetry({
          type: "turn.done",
          turnId: target.id,
          chars: (target.text ?? "").length,
          ...(target.cut ? { cut: target.cut } : {}),
          ...(target.fallback ? { fallback: target.fallback } : {}),
          ...(target.screenTurn ? { screen: screenTimings(target) } : {}),
        });
        // Keyed on the finish reason, not on target.error: a failed empty
        // attempt leaves target.error set when its retry delivers, and that
        // delivered answer must still be recorded.
        if (reason !== "error") rememberExchange(target);
        scheduleTerms(target);
      }
    }
    // Free the lane only once the turn is terminal: done AND (committed or
    // cancelled). An uncommitted-but-finished turn STAYS in the lane so the
    // final transcript can commit it instantly instead of regenerating.
    if (turn === target && (target.committed || target.cancelled)) {
      turn = null;
      drainPendingFinal();
    }
  }

  /* ------------------------------------------------------------ terms ---- */

  /**
   * Once per turn, when the client has its turn.done and the turn is
   * committed: ask the glossary a macrotask later, so a final queued behind
   * this card (a microtask) starts first. If the client shows another card
   * by then (or none, after Clear), there is nothing to explain.
   */
  function scheduleTerms(target) {
    if (!glossaryImpl || !target || target.termsScheduled) return;
    if (!target.committed || !target.doneEmitted || target.cancelled || target.shadow || target.held || target.failed) return;
    target.termsScheduled = true;
    if (!glossaryOn()) return;
    const text = stripHighlights(target.text ?? "").trim();
    if (!text) return;
    setTimeout(() => {
      if (!closed && shownCard?.id === target.id) void requestTerms(target.id, text);
    }, 0);
  }

  /** One glossary request on its own promise; one log entry whatever happens. */
  async function requestTerms(turnId, text) {
    abortTerms();
    const request = { turnId, controller: new AbortController() };
    termsRequest = request;
    let result = null;
    try {
      result = await glossaryImpl.explain({ text, signal: request.controller.signal });
    } catch {
      result = null; // the engine never rejects by contract; a broken one sends nothing
    }
    if (termsRequest === request) termsRequest = null;
    const aborted = request.controller.signal.aborted;
    // A card the client no longer shows (Clear) gets no frame either.
    const error = aborted ? "aborted" : shownCard?.id !== turnId ? "not_shown" : result ? (result.error ?? null) : "engine_error";
    const terms = !closed && !error && Array.isArray(result?.terms) ? result.terms : [];
    const latencyMs = Number.isFinite(result?.latencyMs) ? result.latencyMs : null;
    const added = Number.isFinite(result?.added) ? result.added : 0;
    logger({ type: "glossary.request", turn_id: turnId, latency_ms: latencyMs, entries: terms.length, added, error });
    recordTelemetry({ type: "glossary.request", turnId, latencyMs, entries: terms.length, added, error });
    if (terms.length === 0) return;
    emitFrame({ v: PROTOCOL_VERSION, type: "terms", data: { turn_id: turnId, terms } });
  }

  function abortTerms() {
    const request = termsRequest;
    termsRequest = null;
    try {
      request?.controller.abort();
    } catch {
      /* already aborted */
    }
  }

  /** The lane just freed: start the final that queued behind the committed answer. */
  function drainPendingFinal() {
    if (!pendingFinal) return;
    const queued = pendingFinal;
    pendingFinal = null;
    queueMicrotask(() => {
      if (closed) return;
      startTurn({
        question: queued.text,
        committed: true,
        gateSeq: queued.gateSeq,
        intent: "final",
        reason: "queued_final",
      });
    });
  }

  /* ------------------------------------------------------------ judge ---- */

  /** This segment's utterance was judged small talk and has not grown materially since. */
  function isGatedOut(text) {
    return !!gatedOut && isContinuation(gatedOut.text, text) && !extendsMaterially(gatedOut.text, text);
  }

  async function gateTurn(target) {
    // The pause reveal asks the same questions about the same utterance. When
    // the utterance has not changed by the pause, the judge's cache answers the
    // reveal, so it costs no second request.
    const verdict = await judgeImpl.evaluate({
      utterance: target.generatedFor,
      recent: recentProspect.slice(),
      askComplete: true,
    });
    if (!closed) recordGateVerdict(target.id, verdict);
    applyGate(target, verdict);
  }

  /** Cancel `target` if the judge is confident its utterance needs no answer. */
  function applyGate(target, verdict) {
    if (closed) return;
    logger({
      type: "judge.gate",
      turn_id: target.id,
      p: verdict.isQuestion,
      latency_ms: verdict.latencyMs,
      error: verdict.error,
    });
    if (verdict.isQuestion == null || verdict.isQuestion >= policy.gateCancelBelow) return;
    if (turn !== target || target.cancelled) return; // the lane already moved on
    if (!target.committed) gatedOut = { text: normalizeQuestion(target.generatedFor) };
    cancelTurn(target, "gated_out");
    turn = null;
    logger({ type: "turn.gated_out", turn_id: target.id, p: verdict.isQuestion, committed: target.committed });
    drainPendingFinal();
  }

  /** Retire `target`'s card but keep its generation running (see runGeneration). */
  function keepAsShadow(target) {
    if (shadow && shadow !== target) dropShadow("replaced");
    target.shadow = true;
    shadow = target;
    if (!target.doneEmitted) {
      target.doneEmitted = true;
      recordTelemetry({ type: "turn.superseded", turnId: target.id, reason: "rescue_pending" });
      emitFrame({ v: PROTOCOL_VERSION, type: "turn.superseded", data: { turn_id: target.id } });
    }
    if (turn === target) turn = null; // startTurn must not abort it
  }

  function dropShadow(reason) {
    const target = shadow;
    shadow = null;
    if (!target) return;
    target.shadow = false;
    target.cancelled = true;
    try {
      target.controller.abort();
    } catch {
      /* controller already gone */
    }
    try {
      target.iterator?.return?.();
    } catch {
      /* iterator may not be ready yet */
    }
    logger({ type: "turn.shadow_dropped", turn_id: target.id, reason });
  }

  /**
   * Split decision. Code owns the extension: the shadow answers the last
   * interim only if that interim is the start text grown non-materially (the
   * rule an unrevised final commits by). Jev owns only the rewording from
   * that interim to the final: asked about the shorter start text instead, it
   * rightly says the final asks more ("...of forty people").
   */
  async function judgeRescue(contender, fresh, finalText, lastInterim) {
    const eligible = questionMatches(contender.generatedFor, lastInterim);
    // Asked even when ineligible: the fresh turn skipped its gate for this.
    const verdict = await judgeImpl.evaluate({
      utterance: finalText,
      answeredFor: lastInterim,
      recent: recentProspect.slice(),
    });
    if (closed) return;
    recordGateVerdict(fresh.id, verdict);
    logger({
      type: "judge.rescue",
      turn_id: fresh.id,
      contender_id: contender.id,
      eligible,
      p_same: verdict.answersSame,
      p_question: verdict.isQuestion,
      latency_ms: verdict.latencyMs,
      error: verdict.error,
    });
    if (gateOn) applyGate(fresh, verdict); // may cancel the fresh turn
    if (shadow !== contender) return; // dropped or replaced meanwhile
    const freshLive = turn === fresh && !fresh.cancelled && !fresh.finished;
    const same = eligible && verdict.answersSame != null && verdict.answersSame >= policy.rescueAtLeast;
    if (!same || !freshLive) {
      dropShadow(same ? "fresh_gone" : eligible ? "not_same" : "ineligible");
      return;
    }
    promoteShadow(contender, fresh, finalText);
  }

  /** Replace the regenerated answer with the shadow's (buffered + still streaming). */
  function promoteShadow(contender, fresh, finalText) {
    shadow = null;
    const gateSeq = fresh.gateSeq;
    cancelTurn(fresh, "rescue");
    turn = null;
    const id = `turn_${++turnSeq}`;
    const rescue = {
      id,
      question: finalText,
      generatedFor: contender.generatedFor,
      committed: true,
      gateSeq: gateSeq ?? null,
      intent: "final",
      reason: "rescue",
      controller: contender.controller, // cancelling the rescue aborts the contender's stream
      iterator: contender.iterator,
      text: contender.text ?? "",
      finished: false,
      doneEmitted: false,
      cancelled: false,
      retried: true,
      startedAt: now(),
    };
    contender.shadow = false;
    contender.rescuedBy = rescue;
    turn = rescue;
    abortTerms();
    if (rescue.gateSeq != null) {
      emitFrame({
        v: PROTOCOL_VERSION,
        type: "gate.verdict",
        data: { gate_seq: rescue.gateSeq, verdict: "answer", turn_id: id },
      });
    }
    emitFrame({
      v: PROTOCOL_VERSION,
      type: "turn.started",
      data: {
        turn_id: id,
        question: finalText,
        intent: "final",
        ...(rescue.gateSeq != null ? { gate_seq: rescue.gateSeq } : {}),
      },
    });
    logger({ type: "turn.start", turn_id: id, question: finalText, committed: true, reason: "rescue" });
    recordTelemetry({
      type: "turn.started",
      turnId: id,
      reason: "rescue",
      committed: true,
      intent: "final",
      chars: finalText.length,
    });
    logger({
      type: "turn.rescued",
      turn_id: id,
      from: contender.id,
      chars: rescue.text.length,
      already_finished: !!contender.finished,
    });
    if (rescue.text) {
      emitFrame({ v: PROTOCOL_VERSION, type: "turn.token", data: { turn_id: id, delta: rescue.text } });
    }
    if (contender.finished) finishRescue(contender, "rescued_finished");
  }

  function forwardRescue(contender, delta) {
    const rescue = contender.rescuedBy;
    if (!rescue || turn !== rescue || rescue.cancelled) return;
    rescue.text += delta;
    emitFrame({ v: PROTOCOL_VERSION, type: "turn.token", data: { turn_id: rescue.id, delta } });
  }

  function finishRescue(contender, reason) {
    const rescue = contender.rescuedBy;
    if (!rescue || turn !== rescue || rescue.cancelled) return;
    rescue.finished = true;
    if (contender.cut) rescue.cut = contender.cut;
    if (contender.fallback) rescue.fallback = contender.fallback;
    finishTurn(rescue, reason);
  }

  /**
   * Same question, converging wording: one text is a prefix of the other
   * (ASR partials extend, and can also regress when the model revises).
   */
  function isContinuation(a, b) {
    const x = normalizeQuestion(a);
    const y = normalizeQuestion(b);
    if (!x || !y) return false;
    return x === y || x.startsWith(y) || y.startsWith(x);
  }

  /** Can an answer generated for `generatedFor` stand as the answer to `finalText`? */
  function questionMatches(generatedFor, finalText) {
    const a = normalizeQuestion(generatedFor);
    const b = normalizeQuestion(finalText);
    if (!a || !b) return false;
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (!longer.startsWith(shorter)) return false;
    // Two-word partials match almost anything; require a real phrase before
    // betting an already-running answer on the prefix.
    if (!(shorter.split(" ").length >= 3 || shorter.length >= 12)) return false;
    // A final that adds material wording asks more than the stream answers.
    return !extendsMaterially(generatedFor, finalText);
  }

  /** `next` extends `base` (prefix-related) by a material amount of wording. */
  function extendsMaterially(base, next) {
    const a = normalizeQuestion(base);
    const b = normalizeQuestion(next);
    if (!a || !b || !b.startsWith(a)) return false;
    const baseWords = a.split(" ").length;
    const nextWords = b.split(" ").length;
    const added = nextWords - baseWords;
    return added >= MATERIAL_MIN_NEW_WORDS && baseWords / nextWords < MATERIAL_MAX_COVERAGE;
  }

  function normalizeQuestion(value) {
    return String(value ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/^[\s"']+|[\s"'.,!?;:]+$/g, "")
      .trim();
  }

  function isProspect(data) {
    return data.role === "prospect" || data.stream === STREAM.SYSTEM || data.streamIdx === STREAM.SYSTEM;
  }

  /** Explicit role first; diarization may leave it "unknown", so fall back to the stream. */
  function roleOf(data) {
    if (data.role === "prospect" || data.role === "rep") return data.role;
    const streamIdx = data.stream ?? data.streamIdx;
    if (streamIdx === STREAM.SYSTEM) return "prospect";
    if (streamIdx === STREAM.MICROPHONE) return "rep";
    return "unknown";
  }

  function emitSay(data, text) {
    if (!isProspect(data) || text === lastSayText) return;
    lastSayText = text;
    emitFrame({
      v: PROTOCOL_VERSION,
      type: "say",
      data: { text, say_id: `say_${++saySeq}` },
    });
  }

  /* ------------------------------------------------------ engine contract -- */

  /** Prime the answerer PRIME_DEBOUNCE_MS after the last call; a later call moves the time. */
  function schedulePrime() {
    if (closed || typeof answererImpl.prime !== "function") return;
    clearTimeout(primeTimer);
    primeTimer = setTimeout(primeAnswerer, PRIME_DEBOUNCE_MS);
  }

  /** The debounced prime: the next default-card answer's system message, once there is session context to answer from. */
  function primeAnswerer() {
    primeTimer = null;
    if (closed || contextString === "") return;
    try {
      answererImpl.prime(answerArgs({ question: "" }));
    } catch {
      /* priming is best effort */
    }
  }

  function onSessionStart(session = {}) {
    sessionId = session.sessionId ?? session.session_id ?? null;
    recordTelemetry({ type: "session.start" });
    contextParts = pickContext(session);
    contextString = buildContext(contextParts);
    screenContext = null;
    screenEpoch += 1;
    conversation.clear();
    shownCard = null;
    cancelTurn(turn, "session_start");
    turn = null;
    pendingFinal = null;
    abortTerms();
    for (const partial of partialByStream.values()) clearStableTimer(partial);
    partialByStream.clear();
    lastQuestionText = "";
    lastSayText = "";
    logger({
      type: "pipeline.session_start",
      sessionId,
      context_chars: contextString.length,
    });
    schedulePrime();
  }

  /**
   * The rep's grounding document (`session_context`). It replaces the whole
   * context; an empty `docs` clears it. A generation already streaming keeps
   * the context it started with (runGeneration reads contextString once).
   */
  function onContextSet({ docs = "", name = "" } = {}) {
    const text = typeof docs === "string" ? docs : "";
    const label = typeof name === "string" ? name.trim() : "";
    // Replaces the whole context (contract: one grounding document).
    contextParts = { docs: text ? (label ? `File: ${label}\n\n${text}` : text) : "" };
    contextString = buildContext(contextParts);
    logger({ type: "pipeline.context_set", sessionId, context_chars: contextString.length });
    schedulePrime();
  }

  function onAudio(audio = {}) {
    if (closed) return;
    asrImpl.pushAudio({
      streamIdx: audio.streamIdx ?? audio.stream ?? STREAM.MICROPHONE,
      seq: audio.seq,
      source: audio.source,
      pcm16: audio.pcm16,
      ts: audio.ts ?? audio.timestampMs,
    });
  }

  function onFinalize({ streamIdx = STREAM.MICROPHONE } = {}) {
    if (closed) return;
    // The client VAD already decided speech ended: close the segment now
    // instead of waiting for trailing silence.
    asrImpl.finalize(streamIdx);
  }

  function onAnswerRequest(request = {}) {
    const live = turn !== null && (turn.committed || !turn.finished);
    if (live) {
      logger({ type: "answer_request.ignored", reason: "turn_in_flight", turn_id: turn.id });
      return false;
    }
    const question = String(request.utterance ?? request.text ?? lastQuestionText ?? "").trim();
    if (!question) {
      logger({ type: "answer_request.empty" });
      return false;
    }
    pendingFinal = null;
    startTurn({
      question,
      committed: true,
      gateSeq: request.gateSeq ?? request.gate_seq ?? null,
      intent: request.intent ?? "manual",
      reason: "answer_request",
    });
    return true;
  }

  /**
   * Stage 1 (vision interprets) then stage 2 (a normal answer turn whose
   * context carries the interpretation). Only an `ok` result with text starts
   * a turn; a failure, an empty screen, a capture the server already timed
   * out (aborted signal), one that Clear or a session start overtook, and one
   * a newer capture overtook start nothing.
   */
  async function onScreenAnalyse(request = {}) {
    const receivedAt = now();
    const epoch = screenEpoch;
    const seq = ++screenSeq;
    let result;
    try {
      const engine = await ensureVision();
      // The transport server turns the returned result into the `screen.result`
      // frame (command_id join). Handing the live emit sink to the vision
      // engine as well would duplicate that frame on the wire, so delegate on
      // session context only and return the result.
      result = await engine.analyse(request, { sessionId });
    } catch (err) {
      logger({ type: "vision.delegate_error", message: String(err?.message ?? err) });
      result = {
        status: "failed",
        kind: "other",
        dedup: false,
        solve: null,
        failure: { kind: "unavailable", message: "vision engine unavailable" },
      };
    }
    const visionMs = now() - receivedAt;
    const interpretation = typeof result?.summary === "string" ? result.summary.trim() : "";
    const overtaken = closed || request.signal?.aborted === true || epoch !== screenEpoch || seq < screenApplied;
    recordTelemetry({
      type: "screen.analysed",
      commandId: request.command_id ?? request.commandId ?? null,
      status: result?.status ?? null,
      kind: result?.kind ?? null,
      dedup: result?.dedup === true,
      stub: result?.stub === true,
      chars: interpretation.length,
      visionMs,
      ...(overtaken ? { overtaken: true } : {}),
    });
    if (!overtaken && result?.status === "ok" && interpretation) {
      screenApplied = seq;
      startScreenTurn(result, interpretation, visionMs);
    }
    return result;
  }

  /** Keep the interpretation as the session's screen context, then answer in the lane. */
  function startScreenTurn(result, interpretation, visionMs) {
    const kind = typeof result.kind === "string" ? result.kind : "";
    const title = typeof result.title === "string" ? result.title.trim() : "";
    const analysisId = typeof result.analysisId === "string" ? result.analysisId : result.analysis_id ?? null;
    screenContext = { text: interpretation, kind, title, analysisId, capturedAt: now() };
    logger({ type: "screen.context_set", kind, chars: interpretation.length });
    const prospect = latestProspectLines();
    const latest = prospect[prospect.length - 1] ?? "";
    // Like answer_request: a final queued behind the lane is already in
    // `prospect` (the screen answer covers it), so it does not run again.
    pendingFinal = null;
    startTurn({
      question: latest ? `The prospect's latest words: "${latest}"` : SCREEN_ONLY_QUESTION,
      committed: true,
      intent: "screen",
      reason: "screen",
      gate: false,
      prospect,
      historyQuestion: `[screen: ${title || kind || "capture"}] ${latest}`.trim(),
      displayQuestion: latest ? `${latest} (with the screen: ${title || kind || "capture"})` : `On screen: ${title || kind || "capture"}`,
      screenTurn: {
        analysisId,
        kind,
        chars: interpretation.length,
        dedup: result.dedup === true,
        stub: result.stub === true,
        visionMs,
        firstDeltaAt: null,
      },
    });
  }

  /** Answering-role speech, oldest first: the last finals plus a segment still being spoken. */
  function latestProspectLines() {
    const lines = recentProspect.slice();
    for (const partial of partialByStream.values()) {
      const text = typeof partial?.text === "string" ? partial.text.trim() : "";
      if (text && lines[lines.length - 1] !== text) lines.push(text);
    }
    return lines.slice(-RECENT_PROSPECT_LINES);
  }

  /** The latest interpretation while it is fresh, with its age; expires it otherwise. */
  function currentScreen() {
    if (!screenContext) return null;
    const ageMs = Math.max(0, now() - screenContext.capturedAt);
    if (ageMs > SCREEN_CONTEXT_TTL_MS) {
      screenContext = null;
      logger({ type: "screen.context_expired" });
      recordTelemetry({ type: "screen.expired" });
      return null;
    }
    return { ...screenContext, ageMs };
  }

  /** Stage timings of a screen turn, measured from the turn's start. */
  function screenTimings(target) {
    const timing = target.screenTurn;
    return {
      visionMs: timing.visionMs,
      firstDeltaMs: timing.firstDeltaAt == null ? null : timing.firstDeltaAt - target.startedAt,
      answerMs: now() - target.startedAt,
    };
  }

  /**
   * Clear: drop the screen context (and a screen answer still streaming, which
   * the UI just dropped too). Captures still in flight are discarded when they
   * land. The rep-context lines go too (the answer display is empty again);
   * the rest of the session state is untouched.
   */
  function onScreenClear() {
    if (closed) return;
    const had = screenContext !== null;
    screenContext = null;
    screenEpoch += 1;
    conversation.clear();
    shownCard = null;
    if (turn && turn.screenTurn && !turn.cancelled && !turn.doneEmitted) {
      cancelTurn(turn, "screen_cleared");
      turn = null;
      drainPendingFinal();
    }
    logger({ type: "screen.context_cleared", had });
    recordTelemetry({ type: "screen.cleared", had });
  }

  function onSessionEnd() {
    if (closed) return;
    closed = true;
    clearTimeout(primeTimer);
    primeTimer = null;
    for (const partial of partialByStream.values()) clearStableTimer(partial);
    dropShadow("session_end");
    try {
      judgeImpl?.close?.();
    } catch {
      /* best effort */
    }
    cancelTurn(turn, "session_end");
    turn = null;
    pendingFinal = null;
    abortTerms();
    try {
      glossaryImpl?.close?.();
    } catch {
      /* best effort */
    }
    try {
      asrImpl.close?.();
    } catch {
      /* best effort */
    }
    logger({ type: "pipeline.session_end", sessionId });
    recordTelemetry({ type: "session.end" });
    try {
      telemetry?.close?.();
    } catch (err) {
      logger({ type: "pipeline.telemetry_close_error", message: String(err?.message ?? err) });
    }
  }

  function dispose() {
    onSessionEnd();
  }

  /* ------------------------------------------------------------- wiring -- */

  function resolveAsr(injected, options) {
    if (typeof injected === "function") {
      try {
        const built = injected({ emit: outbound, onTranscript, log: logger, ...options });
        if (built && typeof built.pushAudio === "function") return built;
      } catch (err) {
        logger({ type: "pipeline.asr_factory_error", message: String(err?.message ?? err) });
      }
    }
    if (injected && typeof injected.pushAudio === "function") {
      attachAsrTap(injected);
      return injected;
    }
    return createAsr({ ...options, emit: outbound, onTranscript, log: logger });
  }

  function attachAsrTap(asrObject) {
    if (typeof asrObject.onTranscript === "function") {
      asrObject.onTranscript(onTranscript);
      return;
    }
    if (typeof asrObject.emit === "function") {
      const previous = asrObject.emit;
      try {
        asrObject.emit = (frame) => {
          if (frame && frame.type === "transcript" && frame.data) onTranscript(frame.data);
          return previous(frame);
        };
        return;
      } catch {
        /* frozen object: fall through to the warning */
      }
    }
    logger({ type: "pipeline.asr_unobservable" });
  }

  function resolveAnswerer(injected, options) {
    if (injected && typeof injected.streamAnswer === "function") {
      if (typeof injected.answerOnce !== "function") {
        try {
          injected.answerOnce = async (args) => {
            let text = "";
            for await (const delta of injected.streamAnswer(args)) text += delta;
            return text;
          };
        } catch {
          /* frozen object: streamAnswer is all the pipeline needs */
        }
      }
      return injected;
    }
    return createAnswerer({ ...options, log: logger });
  }

  async function ensureVision() {
    if (visionImpl) return visionImpl;
    if (typeof vision === "function") {
      visionImpl = vision({ ...visionOptions, log: logger });
      return visionImpl;
    }
    if (!visionPromise) {
      visionPromise = (async () => {
        try {
          // A vision module that fails to load degrades to the local stub
          // instead of failing the screen_analyse command.
          const mod = await import("./vision.js");
          if (typeof mod?.createVisionEngine === "function") {
            return mod.createVisionEngine({ ...visionOptions, log: logger });
          }
        } catch (err) {
          logger({ type: "vision.import_failed", message: String(err?.message ?? err) });
        }
        return createStubVision();
      })();
    }
    visionImpl = await visionPromise;
    return visionImpl;
  }

  function createStubVision() {
    // Delegation returns a typed result; emitting is the transport server's
    // job, so a missing vision package cannot double-send screen.result.
    return {
      async analyse() {
        return {
          status: "failed",
          kind: "other",
          dedup: false,
          solve: null,
          failure: { kind: "unavailable", message: "vision engine not installed" },
        };
      },
    };
  }

  return {
    onSessionStart,
    onContextSet,
    onAudio,
    onFinalize,
    onAnswerRequest,
    onTurnHint,
    onScreenAnalyse,
    onScreenClear,
    onSessionEnd,
    dispose,
  };
}

function pickContext(session) {
  const ctx = session.context && typeof session.context === "object" ? session.context : {};
  const asText = (value) => (typeof value === "string" ? value : "");
  return {
    resume: asText(session.resume ?? session.resumeText ?? ctx.resume ?? ctx.resumeText ?? ctx.resume_text),
    playbook: asText(
      session.playbook ?? session.playbookText ?? ctx.playbook ?? ctx.playbookText ?? ctx.playbook_text,
    ),
    docs: asText(
      session.docs ??
        session.documents ??
        session.doc ??
        ctx.docs ??
        ctx.documents ??
        ctx.doc ??
        (typeof session.context === "string" ? session.context : ""),
    ),
  };
}

/* ------------------------------------------------------ context budget -- */
/**
 * The answerer caps provider input at 32k chars and end-slices there, which
 * would cut whatever section renders last. Assembly therefore budgets here:
 * fixed caps for the other sections (resume, playbook, history, screen,
 * prospect speech), and the grounding document gets everything that remains —
 * a lone document is limited by CONTEXT_CHARS alone. A document over its share
 * loses whole sections, the least relevant to the question first
 * (fitDocuments), never the middle of one. RECENT CONVERSATION (rep context)
 * has its own fixed cap (conversation-context.js CONVERSATION_CHARS) and, like
 * every other section, comes out of the document's share.
 */
const CONTEXT_CHARS = 32_000; // matches the answerer's MAX_CONTEXT_CHARS
const RESUME_CHARS = 4_000;
const PLAYBOOK_CHARS = 4_000;
const HISTORY_CHARS = 1_000;
const HISTORY_PAIRS = 2;
const HISTORY_Q_CHARS = 200;
const HISTORY_A_CHARS = 400;
/** An older exchange cut shorter than this says nothing: it is dropped. */
const HISTORY_MIN_PAIR_CHARS = 40;
/** vision.js bounds the interpretation at 1,200; this is the context's own cap. */
const SCREEN_CHARS = 1_500;
const PROSPECT_LINE_CHARS = 300;
const PROSPECT_CHARS = 900;

/**
 * `suggested`: label the answers `Suggested:` (rep context): beside what the
 * rep actually said, an answer is only what the app suggested.
 */
function cutHistory(history, { suggested = false } = {}) {
  const label = suggested ? "Suggested" : "A";
  const pairs = [];
  for (const pair of Array.isArray(history) ? history : []) {
    const q = typeof pair?.q === "string" ? pair.q.slice(0, HISTORY_Q_CHARS) : "";
    // The model gets the answer as plain words: no key-phrase markers.
    const a = typeof pair?.a === "string" ? stripHighlights(pair.a).slice(0, HISTORY_A_CHARS) : "";
    if (q || a) pairs.push(`Q: ${q}\n${label}: ${a}`);
  }
  // Oldest first: the newest exchanges are the ones a follow-up depends on.
  while (pairs.length > HISTORY_PAIRS) pairs.shift();
  // Newest kept whole; older pairs get what is left, and a stub is dropped.
  const kept = [];
  let room = HISTORY_CHARS;
  for (let i = pairs.length - 1; i >= 0; i -= 1) {
    const space = room - (kept.length ? 2 : 0);
    if (space < HISTORY_MIN_PAIR_CHARS && kept.length) break;
    const pair = pairs[i].slice(0, space);
    kept.unshift(pair);
    room = space - pair.length;
  }
  return kept.join("\n\n");
}

/** Question words that say nothing about which section is relevant. */
const FIT_STOPWORDS = new Set(
  (
    "the and for are but not you your our with what when where which who why how does did can could would " +
    "should will this that these those there here from into about over have has had was were been being " +
    "any some all just very also than then them they their its like more most such tell please " +
    "explain describe walk through between difference way ways"
  ).split(" "),
);

/** The question's content words, lowercase, three letters or more. */
function fitWords(question) {
  const words = String(question ?? "").toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]/g) ?? [];
  return [...new Set(words.filter((word) => word.length >= 3 && !FIT_STOPWORDS.has(word)))];
}

/**
 * The document cut to `budget` characters by whole sections. A section starts
 * at a Markdown heading line; the text before the first heading is one too.
 * When the document is too long, sections are kept in order of relevance to
 * the question (distinct question words found; heading words count double),
 * ties in document order, while they fit, and are put back in document
 * order. A document with no section that fits is cut at the budget.
 */
export function fitDocuments(docs, budget, question = "") {
  const text = typeof docs === "string" ? docs : "";
  if (text.length <= budget) return text;
  const starts = [0];
  for (const match of text.matchAll(/^#{1,6} /gm)) if (match.index > 0) starts.push(match.index);
  const sections = starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length));
  const words = fitWords(question);
  const score = (section) => {
    const lower = section.toLowerCase();
    const end = lower.indexOf("\n");
    const heading = end < 0 ? lower : lower.slice(0, end);
    return words.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0) + (heading.includes(word) ? 1 : 0), 0);
  };
  const ranked = sections.map((section, index) => ({ section, index, score: score(section) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const keep = new Set();
  let used = 0;
  for (const { section, index } of ranked) {
    if (used + section.length > budget) continue;
    keep.add(index);
    used += section.length;
  }
  if (keep.size === 0) return text.slice(0, budget);
  return sections.filter((_, index) => keep.has(index)).join("");
}

/** "just now" / "40 seconds ago" / "3 minutes ago". */
function formatAge(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
}

/** The latest screen interpretation, labelled with its age and kind. */
function renderScreen(screen) {
  const body = typeof screen?.text === "string" ? screen.text.trim() : "";
  if (!body) return "";
  const label = [`captured ${formatAge(screen.ageMs)}`];
  if (screen.kind) label.push(`kind: ${screen.kind}`);
  if (screen.title) label.push(`title: ${String(screen.title).slice(0, 80)}`);
  return `SCREEN (${label.join("; ")}):\n${body}`.slice(0, SCREEN_CHARS);
}

/** What the prospect said, oldest first (screen turns: the turn may not be committed yet). */
function renderProspect(lines) {
  const kept = (Array.isArray(lines) ? lines : [])
    .filter((line) => typeof line === "string" && line.trim())
    .map((line) => `- ${line.trim().slice(0, PROSPECT_LINE_CHARS)}`);
  if (kept.length === 0) return "";
  // Newest last and kept first when the cap bites.
  let body = kept.join("\n");
  while (body.length > PROSPECT_CHARS && kept.length > 1) {
    kept.shift();
    body = kept.join("\n");
  }
  return `PROSPECT SPEECH (latest last):\n${body.slice(0, PROSPECT_CHARS)}`;
}

/**
 * @param {{resume?: string, playbook?: string, docs?: string, history?: {q: string, a: string}[],
 *   screen?: {text: string, kind?: string, title?: string, ageMs?: number}|null,
 *   prospect?: string[]|null, conversation?: {who: string, text: string}[]|null,
 *   question?: string}} [parts]
 *   question: the question being answered, which picks the document sections
 *   kept when the document is over its share (fitDocuments).
 *   screen: the latest interpretation (SCREEN block); prospect: recent
 *   prospect speech (screen turns only); conversation: both speakers' lines
 *   (rep context). The RECENT CONVERSATION block renders only when a REP line
 *   survives, after SCREEN and before RECENT EXCHANGE (whose answers it then
 *   labels `Suggested:`), with its own fixed cap; prospect lines a screen
 *   turn's PROSPECT SPEECH already carries are not repeated. Without a REP
 *   line the context is exactly what it is without `conversation`.
 */
export function buildContext({ resume, playbook, docs, history, screen, prospect, conversation, question } = {}) {
  const text = (value) => (typeof value === "string" ? value : "");
  const head = [
    text(resume) && `RESUME:\n${text(resume).slice(0, RESUME_CHARS)}`,
    text(playbook) && `PLAYBOOK:\n${text(playbook).slice(0, PLAYBOOK_CHARS)}`,
  ].filter(Boolean);
  const tail = [];
  const screenText = renderScreen(screen);
  if (screenText) tail.push(screenText);
  const conversationText = renderConversation(conversation, { skipProspect: Array.isArray(prospect) ? prospect : [] });
  if (conversationText) tail.push(conversationText);
  const historyText = cutHistory(history, { suggested: conversationText !== "" });
  if (historyText) tail.push(`RECENT EXCHANGE:\n${historyText}`);
  const prospectText = renderProspect(prospect);
  if (prospectText) tail.push(prospectText);
  // Budget for DOCUMENTS: total minus every other section, its own heading and
  // the "\n\n" separators it will sit between.
  const separators = (head.length ? 2 : 0) + (tail.length ? 2 : 0);
  const usedElsewhere = head.join("\n\n").length + tail.join("\n\n").length + separators + "DOCUMENTS:\n".length;
  const docsText = fitDocuments(text(docs), Math.max(0, CONTEXT_CHARS - usedElsewhere), question);
  return [...head, docsText && `DOCUMENTS:\n${docsText}`, ...tail].filter(Boolean).join("\n\n");
}

/**
 * turn.done's `fallback`: which model answered instead of the chosen one, and
 * why, as short names and a reason code. Only those three strings reach the
 * wire; anything without a model name is no note.
 * @param {unknown} note the answerer's onFallback argument
 * @returns {{to: string, from?: string, reason?: string}|null}
 */
function fallbackNote(note) {
  const text = (value) => (typeof value === "string" && value.length > 0 ? value : null);
  const to = text(note?.to);
  if (!to) return null;
  const from = text(note.from);
  const reason = text(note.reason);
  return { to, ...(from ? { from } : {}), ...(reason ? { reason } : {}) };
}

function isAbort(err) {
  return (
    err?.name === "AbortError" ||
    err?.code === "ABORT_ERR" ||
    /abort/i.test(String(err?.message ?? ""))
  );
}
