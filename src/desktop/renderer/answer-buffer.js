/**
 * Pure view-model logic for the overlay renderer.
 *
 * WHY separate: the renderer has no DOM in `bun test`, but the parts that are
 * easy to get wrong — lane mapping, delta accumulation, interim/final
 * replacement and the "still speaking" debounce — are exactly the parts worth
 * testing. `app.js` only paints what these classes expose.
 */

import { summarizeQuestion } from "./question-summary.js";

export const LANE = Object.freeze({
  PROSPECT: "prospect",
  REP: "rep",
});

export const LANES = Object.freeze([LANE.REP, LANE.PROSPECT]);

/**
 * Wire role/source -> UI lane.
 * Role wins over source because the server classifies speakers (a system
 * device may still carry the rep's voice in some topologies); the stream
 * index is the last resort. Unknown frames default to the rep lane so
 * text is never silently dropped from the UI.
 */
export function laneForTranscript(frame = {}) {
  const role = typeof frame.role === "string" ? frame.role.toLowerCase() : "";
  if (role === "prospect") return LANE.PROSPECT;
  if (role === "rep") return LANE.REP;
  const source = typeof frame.source === "string" ? frame.source.toLowerCase() : "";
  if (source === "system") return LANE.PROSPECT;
  if (source === "mic" || source === "microphone") return LANE.REP;
  if (frame.stream === 1 || frame.streamIdx === 1) return LANE.PROSPECT;
  return LANE.REP;
}

/** The question line above an answer is cut to this many characters. */
export const ANSWER_QUESTION_MAX_CHARS = 120;

/** A cut moves back to a space when one is this close to the limit. */
const ANSWER_QUESTION_WORD_SLACK = 20;

/**
 * The question an answer is for, as the answer window shows it: the screen
 * turn's display text, else the ask in the prospect's words
 * (question-summary.js); whitespace collapsed, cut at a word with "…". ""
 * when the turn carries none.
 */
export function answerQuestion(frame = {}) {
  const display = typeof frame.display_question === "string" && frame.display_question.trim() ? frame.display_question : "";
  const raw = display || (typeof frame.question === "string" ? summarizeQuestion(frame.question) : "");
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= ANSWER_QUESTION_MAX_CHARS) return text;
  const limit = ANSWER_QUESTION_MAX_CHARS - 1;
  const space = text.lastIndexOf(" ", limit);
  const cut = space >= limit - ANSWER_QUESTION_WORD_SLACK ? space : limit;
  return `${text.slice(0, cut).trimEnd()}…`;
}

/**
 * Per-answer delta accumulator. Deltas are concatenated as they arrive so the
 * card can repaint on every frame (latency: text appears token-by-token, never
 * batched until `answer.done`).
 */
export class AnswerBuffer {
  #active = null;
  #maxChars;
  #serial = 0;
  /** Turns the user cleared mid-stream: their late frames are dropped. */
  #cleared = new Set();

  constructor({ maxChars = 20_000 } = {}) {
    this.#maxChars = maxChars;
  }

  get active() {
    return this.#active;
  }

  get isStreaming() {
    return Boolean(this.#active && !this.#active.done);
  }

  /**
   * @param {{turn_id?: string, delta?: string}} frame
   * @param {number} [at]
   * @returns {object|null} active entry
   */
  append(frame = {}, at = 0) {
    if (typeof frame.delta !== "string" || frame.delta.length === 0) {
      return this.#active;
    }
    const id = typeof frame.turn_id === "string" && frame.turn_id ? frame.turn_id : null;
    if (id && this.#cleared.has(id)) return this.#active;
    const entry = this.#ensure(id, at);
    if (entry.truncated) {
      // Already cut: the head stays as it is until `done` replaces the text.
      entry.updatedAt = at;
      return entry;
    }
    entry.text += frame.delta;
    if (entry.text.length > this.#maxChars) {
      // Keep the head: it carries the topic sentence, and `done` replaces the
      // whole text anyway. The flag lets the UI hint that rendering is partial.
      // A cut between the two stars of a `**` marker moves back one, so half
      // a marker never shows as a star (src/shared/highlights.js).
      let cut = this.#maxChars;
      if (entry.text[cut - 1] === "*" && entry.text[cut] === "*") cut -= 1;
      entry.text = entry.text.slice(0, cut);
      entry.truncated = true;
    }
    entry.updatedAt = at;
    return entry;
  }

  /**
   * `turn.started` opens the card before the first token arrives — and carries
   * `gate_seq` so the answer can be rendered under its question from
   * the very first frame.
   */
  start(frame = {}, at = 0) {
    const id = typeof frame.turn_id === "string" && frame.turn_id ? frame.turn_id : null;
    if (id && this.#cleared.has(id)) return this.#active;
    const entry = this.#ensure(id, at);
    if (frame.gate_seq !== undefined) entry.gateSeq = frame.gate_seq;
    const question = answerQuestion(frame);
    if (question) entry.question = question;
    entry.updatedAt = at;
    return entry;
  }

  /** `turn.superseded` retires a card whose turn a newer one replaced. */
  supersede(frame = {}, at = 0) {
    const id = typeof frame.turn_id === "string" && frame.turn_id ? frame.turn_id : null;
    const entry = this.#active;
    if (!entry || (id && entry.id !== id)) return entry ?? null;
    entry.done = true;
    entry.superseded = true;
    entry.updatedAt = at;
    return entry;
  }

  /**
   * Final text is authoritative: a `done` frame may arrive with the complete
   * answer even if deltas were dropped, so it always replaces the buffer.
   */
  done(frame = {}, at = 0) {
    const id = typeof frame.turn_id === "string" && frame.turn_id ? frame.turn_id : null;
    if (id && this.#cleared.has(id)) return this.#active;
    const entry = this.#ensure(id, at);
    if (typeof frame.text === "string") entry.text = frame.text;
    entry.done = true;
    entry.truncated = false;
    // The engine cut the answer short ("lines", "code", "line", "length"): the card says so.
    entry.cut = typeof frame.cut === "string" && frame.cut ? frame.cut : null;
    entry.updatedAt = at;
    if (frame.gate_seq !== undefined) entry.gateSeq = frame.gate_seq;
    return entry;
  }

  reset() {
    this.#active = null;
  }

  /**
   * The Clear button: drop the card. A turn still streaming stays dropped, so
   * its remaining tokens cannot repaint half an answer; the next turn shows.
   */
  clear() {
    if (this.#active && !this.#active.done) {
      this.#cleared.add(this.#active.id);
      while (this.#cleared.size > 16) this.#cleared.delete(this.#cleared.values().next().value);
    }
    this.#active = null;
  }

  #ensure(id, at) {
    if (this.#active && (!id || this.#active.id === id)) return this.#active;
    this.#serial += 1;
    this.#active = {
      id: id ?? `turn-${this.#serial}`,
      text: "",
      done: false,
      truncated: false,
      cut: null,
      startedAt: at,
      updatedAt: at,
    };
    return this.#active;
  }
}

/**
 * Two-lane transcript log. Interim frames mutate a single trailing line per
 * lane; finals commit it. This mirrors ASR behavior (partials converge) so the
 * UI never shows the same utterance twice.
 */
export class TranscriptLanes {
  #lines = { [LANE.PROSPECT]: [], [LANE.REP]: [] };
  #current = { [LANE.PROSPECT]: null, [LANE.REP]: null };
  #maxLines;

  constructor({ maxLines = 60 } = {}) {
    this.#maxLines = maxLines;
  }

  /**
   * @returns {{lane: string, entry: object}}
   */
  ingest(frame = {}, at = 0) {
    const lane = laneForTranscript(frame);
    const entry = {
      text: typeof frame.text === "string" ? frame.text : "",
      final: Boolean(frame.final),
      role: frame.role ?? "unknown",
      source: frame.source ?? "unknown",
      seq: frame.seq ?? null,
      at,
    };
    if (entry.final) {
      this.#lines[lane].push(entry);
      this.#current[lane] = null;
      const overflow = this.#lines[lane].length - this.#maxLines;
      if (overflow > 0) this.#lines[lane].splice(0, overflow);
    } else {
      this.#current[lane] = entry;
    }
    return { lane, entry };
  }

  /** Finalized utterances, oldest first. */
  lines(lane) {
    return [...(this.#lines[lane] ?? [])];
  }

  /** In-flight interim utterance or null. */
  current(lane) {
    return this.#current[lane] ?? null;
  }

  reset(lane = null) {
    const targets = lane ? [lane] : LANES;
    for (const target of targets) {
      this.#lines[target] = [];
      this.#current[target] = null;
    }
  }
}

/**
 * Speaking indicator driven by interim transcripts. A fixed quiet window
 * (1.5 s) absorbs ASR gaps between words without needing a per-frame timer,
 * because `speaking()` is evaluated against the caller's clock. `nextExpiry`
 * lets the renderer schedule exactly one repaint when a dot turns off.
 */
export class SpeakingIndicators {
  #last = { [LANE.PROSPECT]: -Infinity, [LANE.REP]: -Infinity };
  #quietMs;

  constructor({ quietMs = 1500 } = {}) {
    this.#quietMs = quietMs;
  }

  get quietMs() {
    return this.#quietMs;
  }

  note(lane, at = Date.now()) {
    // Never move the timestamp backwards: out-of-order frames must not end a
    // speaking window that a newer frame just opened.
    if (at > this.#last[lane]) this.#last[lane] = at;
  }

  speaking(lane, at = Date.now()) {
    return at - this.#last[lane] < this.#quietMs;
  }

  snapshot(at = Date.now()) {
    return {
      [LANE.PROSPECT]: this.speaking(LANE.PROSPECT, at),
      [LANE.REP]: this.speaking(LANE.REP, at),
    };
  }

  /** ms until the earliest speaking flag flips to false; Infinity if quiet. */
  nextExpiry(at = Date.now()) {
    let soonest = Infinity;
    for (const lane of LANES) {
      const remaining = this.#last[lane] + this.#quietMs - at;
      if (remaining > 0 && remaining < soonest) soonest = remaining;
    }
    return soonest;
  }
}

/**
 * VAD gate stats -> meter view model. `openRatio` is the share of frames the
 * gate forwarded: it answers "is my voice reaching the server at all", which is
 * the failure mode users notice (a stuck-closed gate looks like a dead server).
 */
export function summariseVadStats(stats = {}) {
  const forwarded = Number(stats.forwardedFrames) || 0;
  const gated = Number(stats.gatedFrames) || 0;
  const dropped = Number(stats.droppedFrames) || 0;
  const total = forwarded + gated;
  return {
    speaking: Boolean(stats.speaking),
    failedOpen: Boolean(stats.failedOpen),
    forwarded,
    gated,
    dropped,
    openRatio: total > 0 ? forwarded / total : 0,
    source: typeof stats.source === "string" ? stats.source : null,
  };
}

/* ------------------------------------------------------------ screen results */

/** `solve` doubles as the protocol's enum; these values are not answer text. */
export const SOLVE_SENTINELS = Object.freeze([
  "not_requested",
  "solving",
  "busy",
  "duplicate",
  "unsolvable",
]);

/** Closed sets from the wire contract; unknown values normalize away. */
export const SCREEN_STATUSES = Object.freeze(["ok", "empty", "failed"]);
export const SCREEN_KINDS = Object.freeze(["question", "code", "other"]);

/** Honest note for the analysis path with no vision model configured. */
export const SCREEN_STUB_NOTE =
  "stub analysis - no vision LLM configured (set DEEPSEEK_API_KEY for real analysis)";

/** A card names its capture in at most this many words, next to "Screen #n". */
export const SCREEN_LABEL_WORDS = 6;

/**
 * `solve` is the protocol's ENUM (`not_requested` etc.). A loose or
 * legacy server may put text there instead; sentinels are never rendered.
 */
export function screenSolveText(solve) {
  if (typeof solve !== "string") return null;
  const text = solve.trim();
  if (!text || SOLVE_SENTINELS.includes(text.toLowerCase())) return null;
  return text;
}

function textField(value) {
  return typeof value === "string" ? value : "";
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/**
 * One screen analysis in renderer terms. The command reply (camelCase
 * `commandId`) and the pushed `screen.result` frame (snake_case `command_id`)
 * both normalize through here, so either arrival renders identically.
 */
export function normalizeScreenResult(result = {}) {
  const source = result && typeof result === "object" ? result : {};
  const status = textField(source.status).trim().toLowerCase();
  const kind = textField(source.kind).trim().toLowerCase();
  return {
    commandId: firstText(source.commandId, source.command_id),
    analysisId: firstText(source.analysisId, source.analysis_id),
    status: SCREEN_STATUSES.includes(status) ? status : "failed",
    kind: SCREEN_KINDS.includes(kind) ? kind : "",
    title: textField(source.title),
    summary: textField(source.summary),
    solve: screenSolveText(source.solve),
    stub: source.stub === true,
    dedup: source.dedup === true,
    failure: textField(source.failure),
    error: textField(source.error),
    width: Number.isFinite(source.width) ? source.width : null,
    height: Number.isFinite(source.height) ? source.height : null,
  };
}

/**
 * The card's short label: the vision model's title, else the start of its
 * reading, else the kind, cut to SCREEN_LABEL_WORDS words. The full reading
 * goes to the answer context only; the answer streams in the main field.
 */
export function screenLabel(card = {}) {
  let text = "";
  if (card.status === "failed") text = "analysis failed";
  else if (card.status === "empty") text = "nothing on screen";
  else text = (card.title || card.summary || card.kind || "").trim();
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > SCREEN_LABEL_WORDS ? `${words.slice(0, SCREEN_LABEL_WORDS).join(" ")}…` : words.join(" ");
}

/**
 * Status lines under a card: the stub's honest note, then a typed failure
 * tag, or where the answer went for a successful capture.
 */
export function screenCardNotes(card = {}) {
  const notes = [];
  if (card.stub === true) notes.push(SCREEN_STUB_NOTE);
  if (card.status === "failed") {
    if (card.error) notes.push(card.error);
    if (card.failure) notes.push(`failure: ${card.failure}`);
  }
  return notes;
}

/**
 * Ordered analysis cards for one renderer session.
 *
 * The `screen:analyse` command reply mirrors the pushed `screen.result` frame,
 * so results are keyed by command_id/analysis_id and ingested exactly once.
 * The server's `dedup` verdict is NOT a render suppression: re-analysing the
 * same unchanged screen is a new, numbered card carrying "seen before" —
 * exactly like the `screen.result #1/#2` log in scripts/demo.mjs.
 */
export class ScreenCards {
  #cards = [];
  #byCommand = new Map();
  #byAnalysis = new Map();
  #serial = 0;
  #maxCards;

  constructor({ maxCards = 100 } = {}) {
    this.#maxCards = Number.isFinite(maxCards) && maxCards >= 1 ? maxCards : 100;
  }

  get cards() {
    return [...this.#cards];
  }

  get count() {
    return this.#cards.length;
  }

  /**
   * @param {object} result command reply or pushed `screen.result` data
   * @param {number} [at]
   * @returns {{card: object|null, created: boolean, duplicate: boolean}}
   */
  ingest(result = {}, at = 0) {
    const normalized = normalizeScreenResult(result);
    const seen = this.#lookup(normalized);
    if (seen) return { card: seen, created: false, duplicate: true };
    this.#serial += 1;
    const card = {
      number: this.#serial,
      id: normalized.analysisId || normalized.commandId || `screen-${this.#serial}`,
      ...normalized,
      at,
    };
    this.#cards.push(card);
    if (normalized.commandId) this.#byCommand.set(normalized.commandId, card);
    if (normalized.analysisId) this.#byAnalysis.set(normalized.analysisId, card);
    while (this.#cards.length > this.#maxCards) this.#forget(this.#cards.shift());
    return { card, created: true, duplicate: false };
  }

  reset() {
    this.#cards = [];
    this.#byCommand.clear();
    this.#byAnalysis.clear();
    this.#serial = 0;
  }

  /**
   * A command id is the join key between the reply and the frame; when both
   * carry one only the command id may suppress. Two different commands on the
   * same analysis_id are two cards (the second is the server's dedup verdict).
   * Without a command id (HTTP fallback reply) the analysis id is the only
   * join key there is — but a command-less stored card is also adopted by a
   * later frame carrying its analysis id, so one analysis never double-renders.
   */
  #lookup(normalized) {
    if (normalized.commandId) {
      const byCommand = this.#byCommand.get(normalized.commandId);
      if (byCommand) return byCommand;
      if (normalized.analysisId) {
        const byAnalysis = this.#byAnalysis.get(normalized.analysisId);
        if (byAnalysis && !byAnalysis.commandId) return byAnalysis;
      }
      return null;
    }
    if (normalized.analysisId) return this.#byAnalysis.get(normalized.analysisId) ?? null;
    return null;
  }

  #forget(card) {
    if (!card) return;
    for (const [key, value] of this.#byCommand) {
      if (value === card) this.#byCommand.delete(key);
    }
    for (const [key, value] of this.#byAnalysis) {
      if (value === card) this.#byAnalysis.delete(key);
    }
  }
}
