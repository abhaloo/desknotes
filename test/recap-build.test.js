import test from "node:test";
import assert from "node:assert/strict";

/**
 * Session recap, phase 2: the pure builder and formatter
 * (src/desktop/recap/build.js). No model call: questions, gaps and terms are
 * derived mechanically from the timeline record, and turns are joined by
 * turn_id only (turn.started.question is the question; no text matching).
 *
 *   buildRecap(record) -> { ...record, questions, gaps, terms, stats }
 *   formatRecap(recap) -> the readable document (what the window shows and the store saves)
 *   formatOffset(ms)   -> "hh:mm:ss"
 *   endReasonText(reason)
 *
 * Gap kinds: "failed" (an error closed the turn), "cut" (turn.done.cut),
 * "superseded" (retired, and no later turn finished), "unfinished" (still
 * streaming when the session ended). No silence gaps; no heuristic
 * "unanswered" gaps.
 */
const load = () => import("../src/desktop/recap/build.js");

const T0 = Date.parse("2026-10-28T14:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function turn(fields) {
  return {
    turnId: "t",
    question: null,
    displayQuestion: null,
    intent: "final",
    gateSeq: null,
    startedAt: iso(T0),
    firstTokenAt: null,
    doneAt: null,
    text: "",
    status: "done",
    cut: null,
    fallback: null,
    error: null,
    terms: [],
    ...fields,
  };
}

function line(type, offsetMs, fields = {}) {
  return { type, at: iso(T0 + offsetMs), offsetMs, ...fields };
}

/** A realistic record, as createRecapTimeline().finish() returns it. */
function sampleRecord() {
  return {
    version: 1,
    id: "session-abc",
    startedAt: iso(T0),
    endedAt: iso(T0 + 323_000),
    durationMs: 323_000,
    endReason: "user",
    truncated: false,
    dropped: { lines: 0 },
    failed: false,
    lines: [
      line("transcript", 3_000, { role: "prospect", source: "system", text: "How does SSO work?", segmentId: "s1", heardAt: iso(T0 + 2_000), heardOffsetMs: 2_000 }),
      line("gate.verdict", 3_100, { turnId: "t1", gateSeq: 1, verdict: "answer" }),
      line("turn.started", 3_110, { turnId: "t1", question: "How does SSO work?", displayQuestion: null, intent: "final", gateSeq: 1 }),
      line("turn.token", 3_800, { turnId: "t1" }),
      line("turn.done", 4_500, { turnId: "t1", text: "VERDICT: SAML or OIDC, per tenant.", cut: null, fallback: null }),
      line("terms", 4_900, { turnId: "t1", terms: [{ term: "OIDC", full_name: "OpenID Connect", what: "A sign-on layer on OAuth 2.0." }] }),
      line("transcript", 9_000, { role: "rep", source: "mic", text: "We support both.", segmentId: "r1", heardAt: iso(T0 + 8_000), heardOffsetMs: 8_000 }),
      line("turn.started", 60_000, { turnId: "t2", question: "How much", displayQuestion: null, intent: "partial", gateSeq: null }),
      line("turn.superseded", 60_400, { turnId: "t2" }),
      line("turn.started", 60_500, { turnId: "t3", question: "How much is the enterprise tier?", displayQuestion: null, intent: "final", gateSeq: 2 }),
      line("turn.done", 62_000, { turnId: "t3", text: "VERDICT: $40 per seat.", cut: "lines", fallback: null }),
      line("turn.started", 120_000, { turnId: "t4", question: "What is your uptime SLA?", displayQuestion: null, intent: "final", gateSeq: 3 }),
      line("error", 121_000, { turnId: "t4", code: "generation_failed", message: "answerer: 402 out of credit" }),
      line("turn.done", 121_001, { turnId: "t4", text: "", cut: null, fallback: null }),
      line("turn.started", 180_000, { turnId: "t5", question: "<screen prompt>", displayQuestion: "Pricing page", intent: "screen", gateSeq: null }),
      line("turn.done", 181_000, { turnId: "t5", text: "The page shows three tiers.", cut: null, fallback: null }),
      line("turn.started", 320_000, { turnId: "t6", question: "Can we pilot it?", displayQuestion: null, intent: "final", gateSeq: 4 }),
      line("turn.started", 321_000, { turnId: "t7", question: "Is there a", displayQuestion: null, intent: "partial", gateSeq: null }),
      line("turn.superseded", 321_500, { turnId: "t7" }),
    ],
    turns: [
      turn({ turnId: "t1", question: "How does SSO work?", gateSeq: 1, startedAt: iso(T0 + 3_110), firstTokenAt: iso(T0 + 3_800), doneAt: iso(T0 + 4_500), text: "VERDICT: SAML or OIDC, per tenant.", terms: [{ term: "OIDC", full_name: "OpenID Connect", what: "A sign-on layer on OAuth 2.0." }] }),
      turn({ turnId: "t2", question: "How much", intent: "partial", startedAt: iso(T0 + 60_000), status: "superseded" }),
      turn({ turnId: "t3", question: "How much is the enterprise tier?", gateSeq: 2, startedAt: iso(T0 + 60_500), doneAt: iso(T0 + 62_000), text: "VERDICT: $40 per seat.", cut: "lines" }),
      turn({ turnId: "t4", question: "What is your uptime SLA?", gateSeq: 3, startedAt: iso(T0 + 120_000), doneAt: iso(T0 + 121_001), status: "failed", error: "answerer: 402 out of credit" }),
      turn({ turnId: "t5", question: "<screen prompt>", displayQuestion: "Pricing page", intent: "screen", startedAt: iso(T0 + 180_000), doneAt: iso(T0 + 181_000), text: "The page shows three tiers." }),
      turn({ turnId: "t6", question: "Can we pilot it?", gateSeq: 4, startedAt: iso(T0 + 320_000), status: "unfinished" }),
      turn({ turnId: "t7", question: "Is there a", intent: "partial", startedAt: iso(T0 + 321_000), status: "superseded" }),
    ],
  };
}

test("build: formatOffset prints hh:mm:ss and never goes negative", async () => {
  const { formatOffset } = await load();
  assert.equal(formatOffset(0), "00:00:00");
  assert.equal(formatOffset(3_999), "00:00:03");
  assert.equal(formatOffset(61_000), "00:01:01");
  assert.equal(formatOffset(3_723_000), "01:02:03");
  assert.equal(formatOffset(-5), "00:00:00");
  assert.equal(formatOffset(Number.NaN), "00:00:00");
});

test("build: the record passes through unchanged under the derived fields", async () => {
  const { buildRecap } = await load();
  const record = sampleRecord();
  const recap = buildRecap(record);
  for (const key of ["version", "id", "startedAt", "endedAt", "durationMs", "endReason", "lines", "turns"]) {
    assert.deepEqual(recap[key], record[key], key);
  }
  assert.deepEqual(record, sampleRecord(), "the input is not mutated");
});

test("build: questions are the non-screen turns the gate answered, joined by turn_id, superseded prefetches left out", async () => {
  const { buildRecap } = await load();
  const { questions } = buildRecap(sampleRecord());
  assert.deepEqual(
    questions.map((q) => [q.turnId, q.question, q.status]),
    [
      ["t1", "How does SSO work?", "done"],
      ["t3", "How much is the enterprise tier?", "done"],
      ["t4", "What is your uptime SLA?", "failed"],
      ["t6", "Can we pilot it?", "unfinished"],
    ],
  );
  assert.deepEqual(questions[0], {
    turnId: "t1",
    at: iso(T0 + 3_110),
    offsetMs: 3_110,
    question: "How does SSO work?",
    intent: "final",
    status: "done",
    answer: "VERDICT: SAML or OIDC, per tenant.",
    cut: null,
    terms: ["OIDC"],
  });
});

test("build: gaps are failed, cut, unanswered-superseded and unfinished turns, in time order", async () => {
  const { buildRecap } = await load();
  const { gaps } = buildRecap(sampleRecord());
  assert.deepEqual(
    gaps.map((gap) => [gap.kind, gap.turnId]),
    [
      ["cut", "t3"],
      ["failed", "t4"],
      ["unfinished", "t6"],
      ["superseded", "t7"],
    ],
    "t2 was superseded but a later turn (t3) finished, so it is not a gap",
  );
  const failed = gaps.find((gap) => gap.kind === "failed");
  assert.deepEqual(failed, {
    kind: "failed",
    turnId: "t4",
    at: iso(T0 + 120_000),
    offsetMs: 120_000,
    question: "What is your uptime SLA?",
    reason: "answerer: 402 out of credit",
  });
  assert.equal(gaps.find((gap) => gap.kind === "cut").reason, "lines");
  assert.ok(!gaps.some((gap) => gap.kind === "silence" || gap.kind === "unanswered"), "no silence or heuristic gaps");
});

test("build: terms are flattened with the turn and question they explain", async () => {
  const { buildRecap } = await load();
  const { terms } = buildRecap(sampleRecord());
  assert.deepEqual(terms, [
    {
      turnId: "t1",
      at: iso(T0 + 4_900),
      offsetMs: 4_900,
      term: "OIDC",
      full_name: "OpenID Connect",
      what: "A sign-on layer on OAuth 2.0.",
      question: "How does SSO work?",
    },
  ]);
});

test("build: stats count lines, lanes, turns, questions, answers, gaps and terms", async () => {
  const { buildRecap } = await load();
  assert.deepEqual(buildRecap(sampleRecord()).stats, {
    lines: 19,
    prospectLines: 1,
    repLines: 1,
    turns: 7,
    questions: 4,
    answered: 2,
    gaps: 4,
    terms: 1,
  });
});

test("build: an empty record builds an empty recap", async () => {
  const { buildRecap } = await load();
  const recap = buildRecap({ ...sampleRecord(), lines: [], turns: [] });
  assert.deepEqual(recap.questions, []);
  assert.deepEqual(recap.gaps, []);
  assert.deepEqual(recap.terms, []);
  assert.deepEqual(recap.stats, { lines: 0, prospectLines: 0, repLines: 0, turns: 0, questions: 0, answered: 0, gaps: 0, terms: 0 });
});

test("build: end reasons read as plain words", async () => {
  const { endReasonText } = await load();
  assert.equal(endReasonText("user"), "Ended by you");
  assert.equal(endReasonText("remote"), "Ended by the server");
  assert.equal(endReasonText("quit"), "Ended when DeskNotes quit");
  assert.equal(endReasonText("failed"), "Ended by a connection failure");
  assert.equal(endReasonText("anything else"), "Ended");
});

test("format: the document has a header, a timestamped transcript and the derived sections", async () => {
  const { buildRecap, formatRecap } = await load();
  const text = formatRecap(buildRecap(sampleRecord()));
  const lines = text.split("\n");
  assert.equal(lines[0], "Session recap — 2026-10-28T14:00:00.000Z");
  assert.equal(lines[1], "Started 2026-10-28T14:00:00.000Z · Ended 2026-10-28T14:05:23.000Z · 5 min 23 s · Ended by you");
  for (const heading of ["Transcript", "Questions detected", "Gaps", "Terms"]) {
    assert.ok(lines.includes(heading), `section "${heading}"`);
  }
  const order = ["Transcript", "Questions detected", "Gaps", "Terms"].map((heading) => lines.indexOf(heading));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sections in this order");
});

test("format: every timeline line is one [hh:mm:ss] row, in order, with the words verbatim", async () => {
  const { buildRecap, formatRecap } = await load();
  const recap = buildRecap(sampleRecord());
  const text = formatRecap(recap);
  const start = text.indexOf("Transcript\n");
  const end = text.indexOf("\nQuestions detected\n");
  const rows = text.slice(start, end).split("\n").filter((row) => /^\[\d\d:\d\d:\d\d\] /.test(row));
  assert.equal(rows.length, recap.lines.length, "one row per line");
  assert.equal(rows[0], "[00:00:03] Prospect: How does SSO work?");
  assert.ok(rows.some((row) => row === "[00:00:09] You: We support both."));
  assert.ok(rows.some((row) => row.startsWith("[00:00:04] ") && row.includes("VERDICT: SAML or OIDC, per tenant.")), "the answer text is verbatim");
  assert.ok(rows.some((row) => row.startsWith("[00:00:04] ") && row.includes("OIDC (OpenID Connect): A sign-on layer on OAuth 2.0.")), "terms as TERM (Full Name): what");
  assert.ok(rows.some((row) => row.startsWith("[00:02:01] ") && row.includes("answerer: 402 out of credit")), "the error line");
  const offsets = rows.map((row) => row.slice(1, 9));
  assert.deepEqual([...offsets].sort(), offsets, "chronological");
});

test("format: an empty section says so instead of disappearing", async () => {
  const { buildRecap, formatRecap } = await load();
  const text = formatRecap(buildRecap({ ...sampleRecord(), lines: [], turns: [] }));
  assert.match(text, /Transcript\n-+\n\(nothing was said\)/);
  assert.match(text, /Questions detected\n-+\n\(none\)/);
  assert.match(text, /Gaps\n-+\n\(none\)/);
  assert.match(text, /Terms\n-+\n\(none\)/);
});

test("format: a truncated or failed recording says so in the header", async () => {
  const { buildRecap, formatRecap } = await load();
  const truncated = formatRecap(buildRecap({ ...sampleRecord(), truncated: true, dropped: { lines: 12 } }));
  assert.match(truncated, /12 lines were not recorded \(the recap reached its size limit\)\./);
  const failed = formatRecap(buildRecap({ ...sampleRecord(), failed: true }));
  assert.match(failed, /Recording stopped early after an internal error\./);
});
