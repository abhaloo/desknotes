/**
 * Session recap view model (pure, DOM-free): what the recap window and the
 * Settings > Session history list show. Row wording comes from
 * recap/build.js describeLine(), the same function formatRecap() uses, so the
 * window and the saved document can never drift. Times are formatted by an
 * injectable `formatTime` (local date and time by default; tests inject a
 * fixed one).
 */
import { describeLine, endReasonText, formatDuration, formatOffset, gapText, questionText, recapNotes, termText } from "../recap/build.js";

export { formatDuration, formatOffset };

/** While a session is starting or live, the last recap's button stays out of the way. */
const BUSY_STATES = new Set(["launching", "active", "ending"]);

function localTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? "") : date.toLocaleString();
}

const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** @returns {{ title: string, meta: string, notes: string[] }} */
export function recapHeaderView(recap = {}, { formatTime = localTime } = {}) {
  const stats = recap.stats ?? {};
  return {
    title: `Session recap — ${formatTime(recap.startedAt)}`,
    meta: [
      formatDuration(recap.durationMs),
      endReasonText(recap.endReason),
      count(stats.questions ?? 0, "question"),
      count(stats.gaps ?? 0, "gap"),
      count(stats.terms ?? 0, "term"),
    ].join(" · "),
    notes: recapNotes(recap),
  };
}

/** One row per timeline line: offset, type, role, and the build.js wording. */
export function timelineRows(recap = {}) {
  return (recap.lines ?? []).map((line) => {
    const { label, text, role } = describeLine(line);
    return { offset: formatOffset(line.offsetMs), type: line.type, role, label, text };
  });
}

export function questionRows(recap = {}) {
  return (recap.questions ?? []).map((question) => ({ offset: formatOffset(question.offsetMs), text: questionText(question) }));
}

export function gapRows(recap = {}) {
  return (recap.gaps ?? []).map((gap) => ({ offset: formatOffset(gap.offsetMs), text: gapText(gap) }));
}

export function termRows(recap = {}) {
  return (recap.terms ?? []).map((term) => ({ offset: formatOffset(term.offsetMs), text: termText(term) }));
}

/**
 * A Session history row. An unreadable file (recap:list carries `readError`)
 * still gets a row, so it can be deleted.
 * @returns {{ id: string, title: string, meta: string, unreadable: boolean }}
 */
export function historyRowView(summary = {}, { formatTime = localTime } = {}) {
  const title = formatTime(summary.startedAt);
  if (summary.readError) return { id: summary.id, title, meta: summary.readError, unreadable: true };
  const stats = summary.stats ?? {};
  return {
    id: summary.id,
    title,
    meta: [formatDuration(summary.durationMs), count(stats.questions ?? 0, "question"), count(stats.gaps ?? 0, "gap")].join(" · "),
    unreadable: false,
  };
}

/**
 * The line under the Session history search box. Nothing while idle; while a
 * query is active, how many match, then what the index cannot do yet: words
 * only (no local model), or how far the background indexing is.
 * @param {{ searching: boolean, matches: number, total: number, status: object|null }} view
 */
export function searchStatusText({ searching = false, matches = 0, total = 0, status = null } = {}) {
  const parts = [];
  if (searching) parts.push(`${matches} of ${count(total, "session")} match.`);
  if (!searching) return "";
  if (status?.mode === "keyword") parts.push("Matching words only: the local search model isn't installed.");
  else if (status && status.pending > 0) parts.push(`Indexing ${status.indexed} of ${count(status.total, "session")}…`);
  return parts.join(" ");
}

/** The "Session recap" button: the latest recap, shown while no session is starting or live. */
export function recapButtonView({ latest = null, lifecycle = "idle" } = {}) {
  const id = typeof latest?.id === "string" ? latest.id : null;
  return { visible: id !== null && !BUSY_STATES.has(lifecycle), id };
}
