import test from "node:test";
import assert from "node:assert/strict";

/**
 * Session recap, phase 5a: the pure view model (src/desktop/renderer/recap-view.js)
 * for the recap window and the Settings > Session history list. DOM-free so
 * it tests without a window. Row wording comes from build.js describeLine(),
 * the same function formatRecap() uses, so the window and the saved document
 * can never drift.
 *
 *   formatDuration(ms)
 *   recapHeaderView(recap, { formatTime? }) -> { title, meta, notes[] }
 *   timelineRows(recap) -> [{ offset, type, role, label, text }]
 *   questionRows(recap) / gapRows(recap) / termRows(recap) -> [{ offset, text }]
 *   historyRowView(summary, { formatTime? }) -> { id, title, meta, unreadable }
 *   recapButtonView({ latest, lifecycle }) -> { visible, id }
 */
const load = () => import("../src/desktop/renderer/recap-view.js");
const T0 = Date.parse("2026-10-28T14:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const formatTime = (value) => `T(${value})`;

function recap() {
  const line = (type, offsetMs, fields) => ({ type, at: iso(T0 + offsetMs), offsetMs, ...fields });
  return {
    version: 1,
    id: "session-abc",
    startedAt: iso(T0),
    endedAt: iso(T0 + 323_000),
    durationMs: 323_000,
    endReason: "quit",
    truncated: false,
    dropped: { lines: 0 },
    failed: false,
    lines: [
      line("transcript", 3_000, { role: "prospect", source: "system", text: "How does SSO work?", segmentId: "s1", heardAt: iso(T0 + 2_000), heardOffsetMs: 2_000 }),
      line("turn.started", 3_100, { turnId: "t1", question: "How does SSO work?", displayQuestion: null, intent: "final", gateSeq: 1 }),
      line("turn.done", 4_500, { turnId: "t1", text: "VERDICT: <b>SAML</b> or OIDC.", cut: null, fallback: null }),
      line("transcript", 9_000, { role: "rep", source: "mic", text: "We support both.", segmentId: "r1", heardAt: iso(T0 + 8_000), heardOffsetMs: 8_000 }),
    ],
    turns: [],
    questions: [{ turnId: "t1", at: iso(T0 + 3_100), offsetMs: 3_100, question: "How does SSO work?", intent: "final", status: "done", answer: "VERDICT: <b>SAML</b> or OIDC.", cut: null, terms: ["OIDC"] }],
    gaps: [{ kind: "failed", turnId: "t4", at: iso(T0 + 120_000), offsetMs: 120_000, question: "What is your uptime SLA?", reason: "answerer: 402 out of credit" }],
    terms: [{ turnId: "t1", at: iso(T0 + 4_900), offsetMs: 4_900, term: "OIDC", full_name: "OpenID Connect", what: "A sign-on layer on OAuth 2.0.", question: "How does SSO work?" }],
    stats: { lines: 4, prospectLines: 1, repLines: 1, turns: 1, questions: 1, answered: 1, gaps: 1, terms: 1 },
  };
}

test("view: durations read like a person would say them", async () => {
  const { formatDuration } = await load();
  assert.equal(formatDuration(0), "0 s");
  assert.equal(formatDuration(42_400), "42 s");
  assert.equal(formatDuration(323_000), "5 min 23 s");
  assert.equal(formatDuration(3_720_000), "1 h 2 min");
});

test("view: the header names the session, its length, how it ended and the counts", async () => {
  const { recapHeaderView } = await load();
  const view = recapHeaderView(recap(), { formatTime });
  assert.equal(view.title, `Session recap — T(${iso(T0)})`);
  assert.equal(view.meta, "5 min 23 s · Ended when DeskNotes quit · 1 question · 1 gap · 1 term");
  assert.deepEqual(view.notes, []);
  const partial = recapHeaderView({ ...recap(), truncated: true, dropped: { lines: 3 }, failed: true }, { formatTime });
  assert.deepEqual(partial.notes, ["3 lines were not recorded (the recap reached its size limit).", "Recording stopped early after an internal error."]);
});

test("view: one timeline row per line, with the build.js wording and offsets", async () => {
  const { timelineRows } = await load();
  const { describeLine } = await import("../src/desktop/recap/build.js");
  const data = recap();
  const rows = timelineRows(data);
  assert.equal(rows.length, data.lines.length);
  assert.deepEqual(rows.map((row) => row.offset), ["00:00:03", "00:00:03", "00:00:04", "00:00:09"]);
  assert.deepEqual(rows.map((row) => row.type), ["transcript", "turn.started", "turn.done", "transcript"]);
  assert.deepEqual(rows.map((row) => row.role), ["prospect", "model", "model", "rep"]);
  assert.equal(rows[0].label, "Prospect");
  assert.equal(rows[0].text, "How does SSO work?");
  assert.equal(rows[3].label, "You");
  assert.equal(rows[2].text.includes("VERDICT: <b>SAML</b> or OIDC."), true, "model text verbatim, never parsed");
  for (const [index, line] of data.lines.entries()) {
    const described = describeLine(line);
    assert.equal(rows[index].label, described.label);
    assert.equal(rows[index].text, described.text);
  }
});

test("view: questions, gaps and terms rows", async () => {
  const { questionRows, gapRows, termRows } = await load();
  assert.deepEqual(questionRows(recap()), [{ offset: "00:00:03", text: "How does SSO work? — done" }]);
  assert.deepEqual(gapRows(recap()), [{ offset: "00:02:00", text: "Answer failed: What is your uptime SLA? (answerer: 402 out of credit)" }]);
  assert.deepEqual(termRows(recap()), [{ offset: "00:00:04", text: "OIDC (OpenID Connect): A sign-on layer on OAuth 2.0." }]);
});

test("view: a history row shows when, how long and what happened; an unreadable one says so", async () => {
  const { historyRowView } = await load();
  const summary = { id: "session-abc", startedAt: iso(T0), endedAt: iso(T0 + 323_000), durationMs: 323_000, endReason: "user", stats: recap().stats, savedAt: iso(T0 + 324_000) };
  assert.deepEqual(historyRowView(summary, { formatTime }), {
    id: "session-abc",
    title: `T(${iso(T0)})`,
    meta: "5 min 23 s · 1 question · 1 gap",
    unreadable: false,
  });
  const plural = historyRowView({ ...summary, stats: { ...summary.stats, questions: 3, gaps: 0 } }, { formatTime });
  assert.equal(plural.meta, "5 min 23 s · 3 questions · 0 gaps");
  assert.deepEqual(historyRowView({ id: "session-x", startedAt: iso(T0), readError: "This session recap couldn't be read." }, { formatTime }), {
    id: "session-x",
    title: `T(${iso(T0)})`,
    meta: "This session recap couldn't be read.",
    unreadable: true,
  });
});

test("view: the Session recap button shows the latest recap while no session is starting or live", async () => {
  const { recapButtonView } = await load();
  const latest = { id: "session-abc" };
  assert.deepEqual(recapButtonView({ latest: null, lifecycle: "ended" }), { visible: false, id: null });
  for (const lifecycle of ["idle", "ended", "failed"]) {
    assert.deepEqual(recapButtonView({ latest, lifecycle }), { visible: true, id: "session-abc" }, lifecycle);
  }
  for (const lifecycle of ["launching", "active", "ending"]) {
    assert.deepEqual(recapButtonView({ latest, lifecycle }), { visible: false, id: "session-abc" }, lifecycle);
  }
});
