/**
 * Session recap builder and formatter (pure, no model call).
 *
 * buildRecap turns a timeline record (timeline.js) into the recap the window
 * shows and the store saves: the questions the gate answered, the gaps, the
 * terms and the counts. Everything is derived mechanically, and turns are
 * joined by turn_id only (turn.started.question is the question). Gaps are
 * answers that did not land: failed, cut, superseded with nothing later
 * finished, unfinished when the session ended. No silence gaps, no heuristic
 * "unanswered" gaps: those would need text matching.
 *
 * formatRecap writes the readable document. describeLine is the one wording
 * for a timeline row, shared with the recap window (renderer/recap-view.js),
 * so the window and the saved text cannot drift.
 *
 * No node: imports: the renderer loads this file too.
 */

const pad = (value) => String(value).padStart(2, "0");

/** "hh:mm:ss" from the session start; never negative. */
export function formatOffset(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** "42 s", "5 min 23 s", "1 h 2 min". */
export function formatDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min ${seconds} s`;
  return `${seconds} s`;
}

export function endReasonText(reason) {
  switch (reason) {
    case "user":
      return "Ended by you";
    case "remote":
      return "Ended by the server";
    case "quit":
      return "Ended when DeskNotes quit";
    case "failed":
      return "Ended by a connection failure";
    default:
      return "Ended";
  }
}

/** Notes about the recording itself (size cap, internal fault). */
export function recapNotes(recap = {}) {
  const notes = [];
  const dropped = Number(recap.dropped?.lines) || 0;
  if (recap.truncated) notes.push(`${dropped} lines were not recorded (the recap reached its size limit).`);
  if (recap.failed) notes.push("Recording stopped early after an internal error.");
  return notes;
}

const turnRef = (line) => (line.turnId ? ` ${line.turnId}` : "");

/** "OIDC (OpenID Connect): what it is", or "SKU: what it is" without a full name. */
export function termText(term = {}) {
  const name = term.full_name ? `${term.term} (${term.full_name})` : String(term.term ?? "");
  return `${name}: ${term.what ?? ""}`;
}

export function questionText(question = {}) {
  return `${question.question ?? ""} — ${question.status ?? "unknown"}`;
}

export function gapText(gap = {}) {
  const question = gap.question ?? "";
  switch (gap.kind) {
    case "failed":
      return `Answer failed: ${question} (${gap.reason ?? "unknown error"})`;
    case "cut":
      return `Answer cut short: ${question} (${gap.reason ?? "budget"})`;
    case "unfinished":
      return `Answer unfinished: ${question} (${gap.reason ?? "the session ended first"})`;
    case "superseded":
      return `Answer replaced and never finished: ${question}`;
    default:
      return `${gap.kind ?? "gap"}: ${question}`;
  }
}

/**
 * The one wording for a timeline row: who or what, and the words. Model text
 * is passed through verbatim (it is never parsed).
 * @returns {{ label: string, text: string, role: "prospect"|"rep"|"model" }}
 */
export function describeLine(line = {}) {
  switch (line.type) {
    case "transcript":
      return { label: line.role === "prospect" ? "Prospect" : "You", text: line.text ?? "", role: line.role === "prospect" ? "prospect" : "rep" };
    case "gate.verdict":
      return { label: `Gate${turnRef(line)}`, text: line.verdict ?? "", role: "model" };
    case "turn.started": {
      const question = line.displayQuestion ?? line.question ?? "";
      return { label: `Answer started${turnRef(line)}`, text: [line.intent, question].filter(Boolean).join(" · "), role: "model" };
    }
    case "turn.token":
      return { label: `First token${turnRef(line)}`, text: "", role: "model" };
    case "turn.done": {
      const notes = [];
      if (line.cut) notes.push(`cut: ${line.cut}`);
      if (line.fallback?.to) notes.push(`answered by ${line.fallback.to}${line.fallback.reason ? ` (${line.fallback.reason})` : ""}`);
      return { label: `Answer${turnRef(line)}`, text: [line.text ?? "", ...notes].filter((part) => part !== "").join(" · "), role: "model" };
    }
    case "turn.superseded":
      return { label: `Answer superseded${turnRef(line)}`, text: "", role: "model" };
    case "terms":
      return { label: `Terms${turnRef(line)}`, text: (line.terms ?? []).map(termText).join(" · "), role: "model" };
    case "error":
      return { label: `Answer failed${turnRef(line)}`, text: [line.code, line.message].filter(Boolean).join(": "), role: "model" };
    case "error.retry":
      return { label: `Retrying answer${turnRef(line)}`, text: line.attempt != null ? `attempt ${line.attempt}` : "", role: "model" };
    case "screen.result":
      return { label: "Screen", text: [line.status, line.title, line.summary].filter(Boolean).join(" · "), role: "model" };
    case "say":
      return { label: "Coach", text: line.text ?? "", role: "prospect" };
    default:
      return { label: String(line.type ?? "event"), text: "", role: "model" };
  }
}

const offsetOf = (at, startedAt) => Math.max(0, Date.parse(at) - Date.parse(startedAt));
const questionOf = (turn) => turn.displayQuestion ?? turn.question ?? "";

/**
 * @param {object} record a timeline record (timeline.js finish())
 * @returns {object} the record plus questions, gaps, terms and stats
 */
export function buildRecap(record = {}) {
  const lines = Array.isArray(record.lines) ? record.lines : [];
  const startedAt = record.startedAt ?? new Date(0).toISOString();
  // Turns in start order (ties keep the wire order).
  const turns = (Array.isArray(record.turns) ? record.turns : [])
    .map((turn, index) => ({ turn, index, ms: Date.parse(turn.startedAt) || 0 }))
    .sort((a, b) => a.ms - b.ms || a.index - b.index)
    .map((entry) => entry.turn);
  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));

  const questions = turns
    .filter((turn) => turn.intent !== "screen" && turn.status !== "superseded" && typeof turn.question === "string" && turn.question)
    .map((turn) => ({
      turnId: turn.turnId,
      at: turn.startedAt,
      offsetMs: offsetOf(turn.startedAt, startedAt),
      question: turn.question,
      intent: turn.intent,
      status: turn.status,
      answer: turn.text ?? "",
      cut: turn.cut ?? null,
      terms: (turn.terms ?? []).map((term) => term.term),
    }));

  const gaps = [];
  turns.forEach((turn, position) => {
    const base = { turnId: turn.turnId, at: turn.startedAt, offsetMs: offsetOf(turn.startedAt, startedAt), question: questionOf(turn) };
    if (turn.status === "failed") gaps.push({ kind: "failed", ...base, reason: turn.error ?? "unknown error" });
    else if (turn.status === "done" && turn.cut) gaps.push({ kind: "cut", ...base, reason: turn.cut });
    else if (turn.status === "unfinished") gaps.push({ kind: "unfinished", ...base, reason: "the session ended before the answer finished" });
    else if (turn.status === "superseded") {
      // A retired prefetch is no gap when a later turn answered; one that
      // nothing later finished left the question without an answer.
      const laterFinished = turns.slice(position + 1).some((later) => later.status === "done");
      if (!laterFinished) gaps.push({ kind: "superseded", ...base, reason: "replaced by a newer answer that never finished" });
    }
  });
  gaps.sort((a, b) => a.offsetMs - b.offsetMs);

  const terms = [];
  for (const line of lines) {
    if (line.type !== "terms") continue;
    const turn = line.turnId ? turnsById.get(line.turnId) : null;
    for (const term of line.terms ?? []) {
      terms.push({
        turnId: line.turnId ?? null,
        at: line.at,
        offsetMs: line.offsetMs,
        term: term.term,
        full_name: term.full_name ?? null,
        what: term.what ?? "",
        question: turn ? questionOf(turn) || null : null,
      });
    }
  }

  const stats = {
    lines: lines.length,
    prospectLines: lines.filter((line) => line.type === "transcript" && line.role === "prospect").length,
    repLines: lines.filter((line) => line.type === "transcript" && line.role === "rep").length,
    turns: turns.length,
    questions: questions.length,
    answered: questions.filter((question) => question.status === "done").length,
    gaps: gaps.length,
    terms: terms.length,
  };

  return { ...record, questions, gaps, terms, stats };
}

function section(title, rows, empty) {
  return [title, "-".repeat(title.length), ...(rows.length > 0 ? rows : [empty]), ""];
}

/** The readable document. This exact text is what the store saves and the window can export. */
export function formatRecap(recap = {}) {
  const lines = [
    `Session recap — ${recap.startedAt ?? ""}`,
    `Started ${recap.startedAt ?? ""} · Ended ${recap.endedAt ?? ""} · ${formatDuration(recap.durationMs)} · ${endReasonText(recap.endReason)}`,
    ...recapNotes(recap),
    "",
  ];
  const timeline = (recap.lines ?? []).map((line) => {
    const { label, text } = describeLine(line);
    return `[${formatOffset(line.offsetMs)}] ${text ? `${label}: ${text}` : label}`;
  });
  lines.push(...section("Transcript", timeline, "(nothing was said)"));
  lines.push(...section("Questions detected", (recap.questions ?? []).map((q) => `[${formatOffset(q.offsetMs)}] ${questionText(q)}`), "(none)"));
  lines.push(...section("Gaps", (recap.gaps ?? []).map((gap) => `[${formatOffset(gap.offsetMs)}] ${gapText(gap)}`), "(none)"));
  lines.push(...section("Terms", (recap.terms ?? []).map((term) => `[${formatOffset(term.offsetMs)}] ${termText(term)}`), "(none)"));
  return lines.join("\n");
}
