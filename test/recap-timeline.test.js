import test from "node:test";
import assert from "node:assert/strict";

/**
 * Session recap, phase 1: the pure timeline (src/desktop/recap/timeline.js).
 * Wire frames in, one timestamped record out. No fs, no Electron, no clock:
 * every frame carries the time main received it (`at`, ms), and the record
 * stamps each line with that time and its offset from the session start.
 *
 * Contract pinned here:
 *   createRecapTimeline({ id, startedAt, limits?, log? })
 *     -> { observe(frame, at), finish({ endedAt, reason }) -> record, failed() }
 *   record = { version: 1, id, startedAt, endedAt, durationMs, endReason,
 *              lines: Line[], turns: Turn[], truncated, dropped: { lines }, failed }
 *   Line  = { type, at: ISO, offsetMs, ...fields of that frame type }
 *   Turn  = { turnId, question, displayQuestion, intent, gateSeq, startedAt,
 *             firstTokenAt, doneAt, text, status, cut, fallback, error, terms }
 * Every turn frame type gets its own timestamped line; turn.token is one line
 * per turn (its first token), never one per token. Turns are joined by
 * turn_id only: turn.started.question is the question, no text matching.
 */
const load = () => import("../src/desktop/recap/timeline.js");

const T0 = Date.parse("2026-10-28T14:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
const frame = (type, data, extra = {}) => ({ v: 1, type, seq: ++seq, data, ...extra });
const prospect = (text, final, segment = "s1") => frame("transcript", { text, final, role: "prospect", source: "system", stream: 1, segment_id: segment });
const rep = (text, final, segment = "r1") => frame("transcript", { text, final, role: "rep", source: "mic", stream: 0, segment_id: segment });

async function timeline(options = {}) {
  const { createRecapTimeline } = await load();
  return createRecapTimeline({ id: "session-abc", startedAt: T0, ...options });
}

test("timeline: exports the record version and the default limits", async () => {
  const mod = await load();
  assert.equal(mod.RECAP_RECORD_VERSION, 1);
  assert.equal(typeof mod.createRecapTimeline, "function");
  assert.ok(mod.RECAP_LIMITS.maxLines >= 1000);
  assert.ok(mod.RECAP_LIMITS.maxLineChars >= 2000);
});

test("timeline: session start, end, duration and end reason are recorded", async () => {
  const t = await timeline();
  const record = t.finish({ endedAt: T0 + 5 * 60_000, reason: "user" });
  assert.equal(record.version, 1);
  assert.equal(record.id, "session-abc");
  assert.equal(record.startedAt, "2026-10-28T14:00:00.000Z");
  assert.equal(record.endedAt, "2026-10-28T14:05:00.000Z");
  assert.equal(record.durationMs, 300_000);
  assert.equal(record.endReason, "user");
  assert.deepEqual(record.lines, []);
  assert.deepEqual(record.turns, []);
});

test("timeline: a transcript line is stamped when its final arrives, and heardAt is its first interim", async () => {
  const t = await timeline();
  t.observe(prospect("How does", false), T0 + 3_000);
  t.observe(prospect("How does SSO", false), T0 + 3_400);
  t.observe(prospect("How does SSO work?", true), T0 + 4_100);
  const { lines } = t.finish({ endedAt: T0 + 10_000, reason: "user" });
  assert.equal(lines.length, 1, "interims never become lines");
  assert.deepEqual(lines[0], {
    type: "transcript",
    role: "prospect",
    source: "system",
    text: "How does SSO work?",
    segmentId: "s1",
    at: iso(T0 + 4_100),
    offsetMs: 4_100,
    heardAt: iso(T0 + 3_000),
    heardOffsetMs: 3_000,
  });
});

test("timeline: a final with no interim is heard when it arrives; empty finals are not lines", async () => {
  const t = await timeline();
  t.observe(rep("Sure, let me check.", true), T0 + 1_000);
  t.observe(prospect("   ", true, "s9"), T0 + 2_000);
  const { lines } = t.finish({ endedAt: T0 + 3_000, reason: "user" });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].role, "rep");
  assert.equal(lines[0].heardAt, lines[0].at);
  assert.equal(lines[0].heardOffsetMs, 1_000);
});

test("timeline: the lane follows role, then source, then stream (the renderer's rule)", async () => {
  const t = await timeline();
  t.observe(frame("transcript", { text: "by role", final: true, role: "prospect", source: "mic", segment_id: "a" }), T0 + 1);
  t.observe(frame("transcript", { text: "by source", final: true, role: "unknown", source: "system", segment_id: "b" }), T0 + 2);
  t.observe(frame("transcript", { text: "by stream", final: true, stream: 1, segment_id: "c" }), T0 + 3);
  t.observe(frame("transcript", { text: "default", final: true, segment_id: "d" }), T0 + 4);
  const roles = t.finish({ endedAt: T0 + 5, reason: "user" }).lines.map((line) => line.role);
  assert.deepEqual(roles, ["prospect", "prospect", "prospect", "rep"]);
});

test("timeline: interims of two segments in the same lane keep their own heardAt", async () => {
  const t = await timeline();
  t.observe(prospect("First", false, "s1"), T0 + 1_000);
  t.observe(prospect("Second", false, "s2"), T0 + 2_000);
  t.observe(prospect("First question?", true, "s1"), T0 + 3_000);
  t.observe(prospect("Second question?", true, "s2"), T0 + 4_000);
  const { lines } = t.finish({ endedAt: T0 + 5_000, reason: "user" });
  assert.deepEqual(lines.map((line) => [line.text, line.heardOffsetMs]), [
    ["First question?", 1_000],
    ["Second question?", 2_000],
  ]);
});

test("timeline: without segment_id, the lane's trailing interim opens the next final", async () => {
  const t = await timeline();
  t.observe(frame("transcript", { text: "Is there", final: false, role: "prospect" }), T0 + 500);
  t.observe(frame("transcript", { text: "Is there an API?", final: true, role: "prospect" }), T0 + 1_500);
  t.observe(frame("transcript", { text: "Yes.", final: true, role: "rep" }), T0 + 2_000);
  const { lines } = t.finish({ endedAt: T0 + 3_000, reason: "user" });
  assert.equal(lines[0].heardOffsetMs, 500);
  assert.equal(lines[1].heardOffsetMs, 2_000, "the rep lane had no interim of its own");
});

test("timeline: every turn frame type is its own timestamped line; turn.token is one line per turn", async () => {
  const t = await timeline();
  t.observe(frame("gate.verdict", { gate_seq: 4, verdict: "answer", turn_id: "t1" }), T0 + 5_000);
  t.observe(frame("turn.started", { turn_id: "t1", question: "How does SSO work?", intent: "final", gate_seq: 4 }), T0 + 5_010);
  t.observe(frame("turn.token", { turn_id: "t1", delta: "VERDICT: " }), T0 + 5_600);
  t.observe(frame("turn.token", { turn_id: "t1", delta: "SAML and OIDC." }), T0 + 5_700);
  t.observe(frame("turn.done", { turn_id: "t1", text: "VERDICT: SAML and OIDC.", gate_seq: 4 }), T0 + 6_000);
  t.observe(frame("terms", { turn_id: "t1", terms: [{ term: "SAML", full_name: "Security Assertion Markup Language", what: "An XML sign-on standard." }] }), T0 + 6_500);
  const { lines } = t.finish({ endedAt: T0 + 10_000, reason: "user" });
  assert.deepEqual(
    lines.map((line) => [line.type, line.offsetMs]),
    [
      ["gate.verdict", 5_000],
      ["turn.started", 5_010],
      ["turn.token", 5_600],
      ["turn.done", 6_000],
      ["terms", 6_500],
    ],
  );
  assert.deepEqual(lines[0], { type: "gate.verdict", at: iso(T0 + 5_000), offsetMs: 5_000, turnId: "t1", gateSeq: 4, verdict: "answer" });
  assert.deepEqual(lines[1], {
    type: "turn.started",
    at: iso(T0 + 5_010),
    offsetMs: 5_010,
    turnId: "t1",
    question: "How does SSO work?",
    displayQuestion: null,
    intent: "final",
    gateSeq: 4,
  });
  assert.deepEqual(lines[2], { type: "turn.token", at: iso(T0 + 5_600), offsetMs: 5_600, turnId: "t1" });
  assert.deepEqual(lines[3], { type: "turn.done", at: iso(T0 + 6_000), offsetMs: 6_000, turnId: "t1", text: "VERDICT: SAML and OIDC.", cut: null, fallback: null });
  assert.deepEqual(lines[4].terms, [{ term: "SAML", full_name: "Security Assertion Markup Language", what: "An XML sign-on standard." }]);
});

test("timeline: the turn joins its frames by turn_id; the question is turn.started.question", async () => {
  const t = await timeline();
  t.observe(prospect("so what about pricing for the enterprise tier", true), T0 + 1_000);
  t.observe(frame("turn.started", { turn_id: "t7", question: "What does enterprise cost?", intent: "final", gate_seq: 2 }), T0 + 1_100);
  t.observe(frame("turn.token", { turn_id: "t7", delta: "From " }), T0 + 1_900);
  t.observe(frame("turn.done", { turn_id: "t7", text: "From $40 per seat.", cut: "lines", fallback: { to: "deepseek-flash", reason: "no_key" } }), T0 + 2_500);
  t.observe(frame("terms", { turn_id: "t7", terms: [{ term: "SKU", what: "A priced item." }] }), T0 + 2_700);
  const { turns } = t.finish({ endedAt: T0 + 3_000, reason: "user" });
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0], {
    turnId: "t7",
    question: "What does enterprise cost?",
    displayQuestion: null,
    intent: "final",
    gateSeq: 2,
    startedAt: iso(T0 + 1_100),
    firstTokenAt: iso(T0 + 1_900),
    doneAt: iso(T0 + 2_500),
    text: "From $40 per seat.",
    status: "done",
    cut: "lines",
    fallback: { to: "deepseek-flash", reason: "no_key" },
    error: null,
    terms: [{ term: "SKU", full_name: null, what: "A priced item." }],
  });
});

test("timeline: turn.done text is authoritative over the streamed tokens", async () => {
  const t = await timeline();
  t.observe(frame("turn.started", { turn_id: "t1", question: "Q?", intent: "final" }), T0 + 1);
  t.observe(frame("turn.token", { turn_id: "t1", delta: "partial" }), T0 + 2);
  t.observe(frame("turn.done", { turn_id: "t1", text: "The whole answer." }), T0 + 3);
  assert.equal(t.finish({ endedAt: T0 + 4, reason: "user" }).turns[0].text, "The whole answer.");
});

test("timeline: superseded, failed (error then turn.done) and unfinished turns keep their status", async () => {
  const t = await timeline();
  t.observe(frame("turn.started", { turn_id: "a", question: "How much", intent: "partial" }), T0 + 1_000);
  t.observe(frame("turn.superseded", { turn_id: "a" }), T0 + 1_500);
  t.observe(frame("turn.started", { turn_id: "b", question: "How much per seat?", intent: "final" }), T0 + 1_600);
  t.observe(frame("error.retry", { turn_id: "b", attempt: 2 }), T0 + 2_000);
  t.observe(frame("error", { code: "generation_failed", turn_id: "b", message: "answerer: 402 out of credit" }), T0 + 3_000);
  t.observe(frame("turn.done", { turn_id: "b", text: "" }), T0 + 3_001);
  t.observe(frame("turn.started", { turn_id: "c", question: "Any discounts?", intent: "final" }), T0 + 4_000);
  t.observe(frame("turn.token", { turn_id: "c", delta: "Yes" }), T0 + 4_200);
  const record = t.finish({ endedAt: T0 + 4_500, reason: "user" });
  const status = Object.fromEntries(record.turns.map((turn) => [turn.turnId, turn.status]));
  assert.deepEqual(status, { a: "superseded", b: "failed", c: "unfinished" });
  assert.equal(record.turns.find((turn) => turn.turnId === "b").error, "answerer: 402 out of credit");
  const types = record.lines.map((line) => line.type);
  assert.deepEqual(types, ["turn.started", "turn.superseded", "turn.started", "error.retry", "error", "turn.done", "turn.started", "turn.token"]);
  assert.deepEqual(record.lines[3], { type: "error.retry", at: iso(T0 + 2_000), offsetMs: 2_000, turnId: "b", attempt: 2 });
  assert.deepEqual(record.lines[4], { type: "error", at: iso(T0 + 3_000), offsetMs: 3_000, turnId: "b", code: "generation_failed", message: "answerer: 402 out of credit" });
});

test("timeline: a screen turn keeps display_question; screen.result and say are lines too", async () => {
  const t = await timeline();
  t.observe(frame("screen.result", { command_id: "c1", analysis_id: "a1", status: "ok", kind: "code", title: "Pricing page", summary: "Three tiers.", dedup: false, solve: "not_requested" }), T0 + 1_000);
  t.observe(frame("turn.started", { turn_id: "s1", question: "<prompt text>", display_question: "Pricing page", intent: "screen" }), T0 + 1_100);
  t.observe(frame("say", { say_id: "say_1", text: "Tell me about uptime." }), T0 + 2_000);
  t.observe(frame("say", { say_id: "say_1", text: "Tell me about uptime." }), T0 + 2_100);
  const record = t.finish({ endedAt: T0 + 3_000, reason: "user" });
  assert.deepEqual(record.lines[0], { type: "screen.result", at: iso(T0 + 1_000), offsetMs: 1_000, status: "ok", kind: "code", title: "Pricing page", summary: "Three tiers." });
  assert.equal(record.turns[0].displayQuestion, "Pricing page");
  assert.equal(record.turns[0].intent, "screen");
  const says = record.lines.filter((line) => line.type === "say");
  assert.deepEqual(says, [{ type: "say", at: iso(T0 + 2_000), offsetMs: 2_000, sayId: "say_1", text: "Tell me about uptime." }], "a re-sent say_id is one line");
});

test("timeline: frames for a turn that started before recording still make a turn", async () => {
  const t = await timeline();
  t.observe(frame("turn.done", { turn_id: "early", text: "Answer." }), T0 + 1_000);
  const { turns } = t.finish({ endedAt: T0 + 2_000, reason: "user" });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].question, null);
  assert.equal(turns[0].status, "done");
});

test("timeline: replayed frames (a downlink seq already seen) are ignored", async () => {
  const t = await timeline();
  const final = frame("transcript", { text: "Do you support SCIM?", final: true, role: "prospect", segment_id: "x" });
  const done = frame("turn.done", { turn_id: "t1", text: "Yes." });
  t.observe(final, T0 + 1_000);
  t.observe(done, T0 + 2_000);
  // Reconnect: the server replays everything above last_seen_seq, verbatim.
  t.observe(final, T0 + 9_000);
  t.observe(done, T0 + 9_001);
  // seq 0 (the capability frame) and frames without seq are never treated as replays.
  t.observe({ v: 1, type: "transcript", data: { text: "No seq here.", final: true, role: "rep" } }, T0 + 9_500);
  const { lines } = t.finish({ endedAt: T0 + 10_000, reason: "user" });
  assert.deepEqual(lines.map((line) => line.type), ["transcript", "turn.done", "transcript"]);
});

test("timeline: frames that are not part of the call are ignored", async () => {
  const t = await timeline();
  for (const type of ["session.state", "transcription.state", "pong", "session.ended"]) t.observe(frame(type, {}), T0 + 1);
  const { lines, turns } = t.finish({ endedAt: T0 + 2, reason: "user" });
  assert.deepEqual(lines, []);
  assert.deepEqual(turns, []);
});

test("timeline: garbage input never throws", async () => {
  const t = await timeline();
  for (const bad of [null, undefined, "raw", 42, [], {}, { type: 5 }, { type: "transcript" }, { type: "turn.done", data: "x" }, { type: "terms", data: { terms: "nope" } }]) {
    assert.doesNotThrow(() => t.observe(bad, T0 + 1), JSON.stringify(bad));
  }
  assert.doesNotThrow(() => t.observe(prospect("ok", true), Number.NaN));
  assert.equal(t.failed(), false);
});

test("timeline: a time before the session start clamps to offset 0", async () => {
  const t = await timeline();
  t.observe(prospect("Early?", true), T0 - 500);
  assert.equal(t.finish({ endedAt: T0 + 1, reason: "user" }).lines[0].offsetMs, 0);
});

test("timeline: caps lines and line length, and says what it dropped", async () => {
  const t = await timeline({ limits: { maxLines: 3, maxLineChars: 10 } });
  t.observe(prospect("0123456789ABCDEF", true, "a"), T0 + 1);
  for (let i = 0; i < 4; i += 1) t.observe(rep(`line ${i}`, true, `r${i}`), T0 + 2 + i);
  const record = t.finish({ endedAt: T0 + 100, reason: "user" });
  assert.equal(record.lines.length, 3);
  assert.equal(record.lines[0].text, "0123456789");
  assert.equal(record.lines[0].truncated, true);
  assert.equal(record.truncated, true);
  assert.equal(record.dropped.lines, 2);
});

test("timeline: an internal fault latches failed, logs once, and finish still returns the record", async () => {
  const logs = [];
  const t = await timeline({ log: (entry) => logs.push(entry) });
  t.observe(prospect("Before the fault.", true), T0 + 1);
  const poisoned = {
    v: 1,
    type: "transcript",
    seq: 999,
    get data() {
      throw new Error("boom");
    },
  };
  assert.doesNotThrow(() => t.observe(poisoned, T0 + 2));
  assert.equal(t.failed(), true);
  t.observe(prospect("After the fault.", true, "s2"), T0 + 3);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].type, "recap.error");
  const record = t.finish({ endedAt: T0 + 4, reason: "user" });
  assert.equal(record.failed, true);
  assert.deepEqual(record.lines.map((line) => line.text), ["Before the fault."]);
});

test("timeline: finish is idempotent and nothing is observed after it", async () => {
  const t = await timeline();
  t.observe(prospect("One.", true), T0 + 1);
  const first = t.finish({ endedAt: T0 + 10, reason: "user" });
  t.observe(prospect("Two.", true, "s2"), T0 + 11);
  const second = t.finish({ endedAt: T0 + 99, reason: "remote" });
  assert.equal(second, first);
  assert.equal(second.lines.length, 1);
  assert.equal(second.endReason, "user");
});
