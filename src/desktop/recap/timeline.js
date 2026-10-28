/**
 * Session recap timeline (pure): wire frames in, one timestamped record out.
 *
 * WHY pure: it runs in the main process beside the live call, so it must
 * never touch the disk, the clock or Electron. Every frame arrives with the
 * time main received it (`at`, ms); the record stamps each line with that
 * time and its offset from the session start, which is the "timestamp every
 * line" the wire does not carry.
 *
 * Lines mirror the wire frame types (docs/protocol.md): a transcript line per
 * FINAL utterance (interims only contribute `heardAt`), and one line per
 * gate.verdict, turn.started, turn.done, turn.superseded, terms, error,
 * error.retry, screen.result and say. turn.token is one line per turn (its
 * first token), never one per token. Turns are joined by turn_id only:
 * turn.started.question is the question, nothing is matched by text.
 *
 * Contained like the telemetry recorder: observe() never throws, an internal
 * fault latches `failed` and logs once, and caps bound the record's size.
 */
import { laneForTranscript } from "../renderer/answer-buffer.js";

export const RECAP_RECORD_VERSION = 1;
export const RECAP_LIMITS = Object.freeze({ maxLines: 5000, maxLineChars: 8000 });

const iso = (ms) => new Date(ms).toISOString();
const str = (value) => (typeof value === "string" ? value : null);
const text = (value) => (typeof value === "string" ? value : "");
const plain = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

/**
 * @param {{ id: string, startedAt: number, limits?: {maxLines?: number, maxLineChars?: number}, log?: Function }} options
 * @returns {{ observe: (frame: object, at: number) => void, finish: (end: {endedAt: number, reason: string}) => object, failed: () => boolean }}
 */
export function createRecapTimeline({ id, startedAt, limits = {}, log } = {}) {
  const logger = typeof log === "function" ? log : () => {};
  const start = Number.isFinite(startedAt) ? startedAt : 0;
  const maxLines = Number.isFinite(limits.maxLines) && limits.maxLines > 0 ? limits.maxLines : RECAP_LIMITS.maxLines;
  const maxLineChars = Number.isFinite(limits.maxLineChars) && limits.maxLineChars > 0 ? limits.maxLineChars : RECAP_LIMITS.maxLineChars;

  const lines = [];
  /** turn_id -> Turn, in first-seen order. */
  const turns = new Map();
  /** segment_id (or "lane:<role>") -> ms the first interim of that utterance arrived. */
  const interims = new Map();
  const says = new Set();
  let maxSeq = 0;
  let dropped = 0;
  let truncated = false;
  let failed = false;
  let record = null;

  function fail(error) {
    if (failed) return;
    failed = true;
    try {
      logger({ type: "recap.error", message: String(error?.message ?? error) });
    } catch {
      /* the log hook must not turn a contained failure into a throw */
    }
  }

  function stamp(at) {
    const ms = Number.isFinite(at) ? at : start;
    return { at: iso(ms), offsetMs: Math.max(0, ms - start) };
  }

  /** Caps the text of a line; the head carries the topic sentence. */
  function cap(value) {
    if (value.length <= maxLineChars) return { value, cut: false };
    truncated = true;
    return { value: value.slice(0, maxLineChars), cut: true };
  }

  function push(line) {
    if (lines.length >= maxLines) {
      dropped += 1;
      truncated = true;
      return false;
    }
    lines.push(line);
    return true;
  }

  function ensureTurn(turnId, at) {
    if (!turnId) return null;
    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        question: null,
        displayQuestion: null,
        intent: null,
        gateSeq: null,
        startedAt: stamp(at).at,
        firstTokenAt: null,
        doneAt: null,
        text: "",
        status: "streaming",
        cut: null,
        fallback: null,
        error: null,
        terms: [],
      };
      turns.set(turnId, turn);
    }
    return turn;
  }

  function normalizeTerms(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const entry of value) {
      const item = plain(entry);
      const term = str(item?.term);
      if (!term) continue;
      out.push({ term, full_name: str(item.full_name), what: text(item.what) });
    }
    return out;
  }

  function onTranscript(data, at) {
    const role = laneForTranscript(data);
    const segmentId = str(data.segment_id);
    const key = segmentId ?? `lane:${role}`;
    const ms = Number.isFinite(at) ? at : start;
    if (!data.final) {
      if (!interims.has(key)) interims.set(key, ms);
      return;
    }
    const heard = interims.get(key) ?? ms;
    interims.delete(key);
    const words = text(data.text);
    if (!words.trim()) return;
    const { value, cut } = cap(words);
    push({
      type: "transcript",
      role,
      source: str(data.source),
      text: value,
      segmentId,
      ...stamp(at),
      heardAt: iso(heard),
      heardOffsetMs: Math.max(0, heard - start),
      ...(cut ? { truncated: true } : {}),
    });
  }

  function observe(frame, at) {
    if (failed || record) return;
    try {
      if (!plain(frame) || typeof frame.type !== "string") return;
      // A reconnect replays every frame above last_seen_seq verbatim and the
      // client does not dedupe them; seq 0 (pre-hello) and no seq never count.
      const seq = frame.seq;
      if (Number.isFinite(seq) && seq > 0) {
        if (seq <= maxSeq) return;
        maxSeq = seq;
      }
      const data = plain(frame.data) ?? {};
      const turnId = str(data.turn_id);
      switch (frame.type) {
        case "transcript":
          onTranscript(data, at);
          return;
        case "gate.verdict":
          push({ type: "gate.verdict", ...stamp(at), turnId, gateSeq: data.gate_seq ?? null, verdict: str(data.verdict) });
          return;
        case "turn.started": {
          const turn = ensureTurn(turnId, at);
          const question = str(data.question);
          const displayQuestion = str(data.display_question);
          const intent = str(data.intent);
          const gateSeq = data.gate_seq ?? null;
          if (turn) {
            turn.question = question;
            turn.displayQuestion = displayQuestion;
            turn.intent = intent;
            turn.gateSeq = gateSeq;
            turn.startedAt = stamp(at).at;
          }
          push({ type: "turn.started", ...stamp(at), turnId, question, displayQuestion, intent, gateSeq });
          return;
        }
        case "turn.token": {
          const turn = ensureTurn(turnId, at);
          if (!turn || turn.firstTokenAt) return;
          turn.firstTokenAt = stamp(at).at;
          push({ type: "turn.token", ...stamp(at), turnId });
          return;
        }
        case "turn.done": {
          const turn = ensureTurn(turnId, at);
          const { value } = cap(text(data.text));
          const cut = str(data.cut) || null;
          const fallback = plain(data.fallback) && str(data.fallback.to) ? { ...data.fallback } : null;
          if (turn) {
            turn.text = value;
            turn.doneAt = stamp(at).at;
            turn.cut = cut;
            turn.fallback = fallback;
            // A failed or retired turn's closing turn.done does not make it an answer.
            if (turn.status === "streaming") turn.status = "done";
          }
          push({ type: "turn.done", ...stamp(at), turnId, text: value, cut, fallback });
          return;
        }
        case "turn.superseded": {
          const turn = ensureTurn(turnId, at);
          if (turn && turn.status === "streaming") turn.status = "superseded";
          push({ type: "turn.superseded", ...stamp(at), turnId });
          return;
        }
        case "terms": {
          const terms = normalizeTerms(data.terms);
          if (terms.length === 0) return;
          const turn = ensureTurn(turnId, at);
          if (turn) turn.terms.push(...terms);
          push({ type: "terms", ...stamp(at), turnId, terms });
          return;
        }
        case "error": {
          const message = str(data.message);
          const turn = ensureTurn(turnId, at);
          if (turn) {
            turn.status = "failed";
            turn.error = message;
          }
          push({ type: "error", ...stamp(at), turnId, code: str(data.code), message });
          return;
        }
        case "error.retry":
          push({ type: "error.retry", ...stamp(at), turnId, attempt: Number.isFinite(data.attempt) ? data.attempt : null });
          return;
        case "screen.result":
          push({ type: "screen.result", ...stamp(at), status: str(data.status), kind: str(data.kind), title: str(data.title), summary: str(data.summary) });
          return;
        case "say": {
          const sayId = str(data.say_id);
          if (sayId && says.has(sayId)) return; // re-sent at a join boundary: one line
          const words = text(data.text);
          if (!words) return;
          if (sayId) says.add(sayId);
          push({ type: "say", ...stamp(at), sayId, text: cap(words).value });
          return;
        }
        default:
          return; // session.state, transcription.state, pong, session.ended: not part of the call
      }
    } catch (error) {
      fail(error);
    }
  }

  /** Idempotent: the first call seals the record; later calls return it unchanged. */
  function finish({ endedAt, reason } = {}) {
    if (record) return record;
    const end = Number.isFinite(endedAt) ? endedAt : start;
    for (const turn of turns.values()) {
      if (turn.status === "streaming") turn.status = "unfinished";
    }
    record = {
      version: RECAP_RECORD_VERSION,
      id: String(id ?? ""),
      startedAt: iso(start),
      endedAt: iso(end),
      durationMs: Math.max(0, end - start),
      endReason: typeof reason === "string" ? reason : "user",
      truncated,
      dropped: { lines: dropped },
      failed,
      lines,
      turns: [...turns.values()],
    };
    return record;
  }

  return { observe, finish, failed: () => failed };
}

/** @typedef {{ type: string, at: string, offsetMs: number }} RecapLineBase */
/** @typedef {{ turnId: string, question: string|null, displayQuestion: string|null,
 *   intent: string|null, gateSeq: number|null, startedAt: string, firstTokenAt: string|null,
 *   doneAt: string|null, text: string, status: "streaming"|"done"|"superseded"|"failed"|"unfinished",
 *   cut: string|null, fallback: object|null, error: string|null,
 *   terms: Array<{term: string, full_name: string|null, what: string}> }} RecapTurn */
