import test from "node:test";
import assert from "node:assert/strict";
import {
  LANE,
  laneForTranscript,
  AnswerBuffer,
  TranscriptLanes,
  SpeakingIndicators,
  summariseVadStats,
  screenSolveText,
  normalizeScreenResult,
} from "../src/desktop/renderer/answer-buffer.js";

test("lane assignment prefers role, then source, then stream index", () => {
  assert.equal(laneForTranscript({ role: "prospect" }), LANE.PROSPECT);
  assert.equal(laneForTranscript({ role: "rep" }), LANE.REP);
  assert.equal(laneForTranscript({ source: "system" }), LANE.PROSPECT);
  assert.equal(laneForTranscript({ source: "mic" }), LANE.REP);
  assert.equal(laneForTranscript({ source: "microphone" }), LANE.REP);
  assert.equal(laneForTranscript({ stream: 1 }), LANE.PROSPECT);
  assert.equal(laneForTranscript({ streamIdx: 1 }), LANE.PROSPECT);
  // Unknown frames still land somewhere visible (rep lane).
  assert.equal(laneForTranscript({}), LANE.REP);
  assert.equal(laneForTranscript({ role: "unknown", source: "agent", stream: 0 }), LANE.REP);
});

test("answer deltas append immediately and `done` replaces with final text", () => {
  const buffer = new AnswerBuffer();
  const a = buffer.append({ turn_id: "a1", delta: "Because " }, 10);
  assert.equal(a.text, "Because ");
  buffer.append({ turn_id: "a1", delta: "caching " }, 20);
  buffer.append({ turn_id: "a1", delta: "is local." }, 30);
  assert.equal(buffer.active.text, "Because caching is local.");
  assert.equal(buffer.active.done, false);
  assert.equal(buffer.isStreaming, true);
  assert.equal(buffer.active.startedAt, 10);
  assert.equal(buffer.active.updatedAt, 30);

  const done = buffer.done({ turn_id: "a1", text: "Because caching is local.", gate_seq: 7 }, 40);
  assert.equal(done.done, true);
  assert.equal(done.gateSeq, 7);
  assert.equal(buffer.isStreaming, false);
});

test("a second answer id starts a new card, missing ids adopt the active one", () => {
  const buffer = new AnswerBuffer();
  buffer.append({ turn_id: "a1", delta: "first" }, 1);
  buffer.append({ delta: " + extension" }, 2); // no id: continues the active answer
  assert.equal(buffer.active.id, "a1");
  assert.equal(buffer.active.text, "first + extension");
  buffer.done({ turn_id: "a1", text: "first + extension" }, 3);

  buffer.append({ turn_id: "a2", delta: "second" }, 4);
  assert.equal(buffer.active.id, "a2");
  assert.equal(buffer.active.text, "second");
  assert.equal(buffer.active.done, false);

  buffer.reset();
  assert.equal(buffer.active, null);
});

test("done without a prior delta still renders the full answer", () => {
  const buffer = new AnswerBuffer();
  const entry = buffer.done({ turn_id: "late", text: "Complete answer." }, 5);
  assert.equal(entry.text, "Complete answer.");
  assert.equal(buffer.active.text, "Complete answer.");
});

test("buffer truncates pathological streams but keeps the head", () => {
  const buffer = new AnswerBuffer({ maxChars: 10 });
  buffer.append({ turn_id: "a", delta: "0123456789abcdef" }, 1);
  assert.equal(buffer.active.text, "0123456789");
  assert.equal(buffer.active.truncated, true);
  // `done` is authoritative and clears the truncation hint.
  buffer.done({ turn_id: "a", text: "final" }, 2);
  assert.equal(buffer.active.truncated, false);
  assert.equal(buffer.active.text, "final");
});

test("interim transcript mutates one trailing line, finals commit it", () => {
  const lanes = new TranscriptLanes();
  lanes.ingest({ role: "prospect", text: "Tell me about", final: false, seq: 1 }, 100);
  const second = lanes.ingest({ role: "prospect", text: "Tell me about caching", final: false, seq: 2 }, 200);
  assert.equal(second.lane, LANE.PROSPECT);
  assert.equal(lanes.current(LANE.PROSPECT).text, "Tell me about caching");
  assert.equal(lanes.lines(LANE.PROSPECT).length, 0);

  lanes.ingest({ role: "prospect", text: "Tell me about caching.", final: true, seq: 3 }, 300);
  assert.equal(lanes.current(LANE.PROSPECT), null);
  assert.deepEqual(
    lanes.lines(LANE.PROSPECT).map((entry) => entry.text),
    ["Tell me about caching."],
  );
});

test("lanes are independent and capped", () => {
  const lanes = new TranscriptLanes({ maxLines: 2 });
  lanes.ingest({ source: "mic", text: "me", final: true }, 1);
  lanes.ingest({ source: "system", text: "them", final: true }, 2);
  lanes.ingest({ source: "mic", text: "me2", final: true }, 3);
  lanes.ingest({ source: "mic", text: "me3", final: true }, 4);
  assert.deepEqual(
    lanes.lines(LANE.REP).map((entry) => entry.text),
    ["me2", "me3"],
  );
  assert.deepEqual(
    lanes.lines(LANE.PROSPECT).map((entry) => entry.text),
    ["them"],
  );
  lanes.reset(LANE.REP);
  assert.equal(lanes.lines(LANE.REP).length, 0);
  assert.equal(lanes.lines(LANE.PROSPECT).length, 1);
});

test("speaking indicator debounces on a 1.5 s quiet window", () => {
  const indicators = new SpeakingIndicators({ quietMs: 1500 });
  assert.equal(indicators.quietMs, 1500);
  indicators.note(LANE.PROSPECT, 0);
  assert.equal(indicators.speaking(LANE.PROSPECT, 0), true);
  assert.equal(indicators.speaking(LANE.PROSPECT, 1499), true);
  assert.equal(indicators.speaking(LANE.PROSPECT, 1501), false);
  assert.equal(indicators.speaking(LANE.REP, 0), false);
});

test("interim frames keep extending the quiet window", () => {
  const indicators = new SpeakingIndicators({ quietMs: 1500 });
  indicators.note(LANE.REP, 1000);
  indicators.note(LANE.REP, 2000);
  assert.equal(indicators.speaking(LANE.REP, 3000), true);
  // Out-of-order older frames must not shorten an open window.
  indicators.note(LANE.REP, 500);
  assert.equal(indicators.speaking(LANE.REP, 3000), true);
  assert.equal(indicators.speaking(LANE.REP, 3501), false);
});

test("nextExpiry tells the renderer when to repaint dots", () => {
  const indicators = new SpeakingIndicators({ quietMs: 1500 });
  indicators.note(LANE.PROSPECT, 1000);
  indicators.note(LANE.REP, 500);
  assert.equal(indicators.nextExpiry(1000), 1000, "rep quietest-since expiry is soonest");
  assert.deepEqual(indicators.snapshot(1200), {
    prospect: true,
    rep: true,
  });
  assert.equal(indicators.nextExpiry(3000), Infinity);
  assert.deepEqual(indicators.snapshot(3000), {
    prospect: false,
    rep: false,
  });
});

test("screen solve text: enum sentinels are never rendered as answer text", () => {
  assert.equal(screenSolveText(null), null);
  assert.equal(screenSolveText(undefined), null);
  assert.equal(screenSolveText(42), null);
  assert.equal(screenSolveText("   "), null);
  for (const sentinel of ["not_requested", "solving", "busy", "duplicate", "unsolvable"]) {
    assert.equal(screenSolveText(sentinel), null, sentinel);
  }
  assert.equal(screenSolveText("SOLVING"), null, "sentinels match case-insensitively");
  assert.equal(screenSolveText("  Because caching is local.  "), "Because caching is local.");
});

test("normalizeScreenResult joins the camelCase reply and snake_case frame ids", () => {
  const reply = normalizeScreenResult({ commandId: "cmd_1", analysisId: "an_1", status: "ok", kind: "question", solve: "draft" });
  const frame = normalizeScreenResult({ command_id: "cmd_1", analysis_id: "an_1", status: "ok", kind: "question", solve: "draft" });
  assert.equal(reply.commandId, "cmd_1");
  assert.equal(frame.commandId, "cmd_1");
  assert.equal(frame.analysisId, "an_1");
  assert.equal(frame.solve, "draft");
  assert.equal(frame.stub, false);
  assert.equal(frame.dedup, false);
  // Unknown status/kind are normalized to honest defaults, not passed through.
  const malformed = normalizeScreenResult({ status: "maybe", kind: "nope" });
  assert.equal(malformed.status, "failed");
  assert.equal(malformed.kind, "");
});

test("VAD stats summarise into meter-friendly numbers", () => {
  const summary = summariseVadStats({
    speaking: true,
    failedOpen: false,
    forwardedFrames: 75,
    gatedFrames: 25,
    droppedFrames: 3,
    source: "microphone",
  });
  assert.equal(summary.openRatio, 0.75);
  assert.equal(summary.speaking, true);
  assert.equal(summary.source, "microphone");
  assert.equal(summary.dropped, 3);

  const empty = summariseVadStats({});
  assert.equal(empty.openRatio, 0);
  assert.equal(empty.failedOpen, false);
  assert.equal(summariseVadStats({ failedOpen: true }).failedOpen, true);
});
