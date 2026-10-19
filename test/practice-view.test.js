import test from "node:test";
import assert from "node:assert/strict";
import {
  answerBlockView,
  materialStatusView,
  sessionSummaryView,
} from "../src/desktop/renderer/practice-view.js";

test("answerBlockView formats the decided block", () => {
  const view = answerBlockView({
    question: "How would you shard it?",
    evidence: { band: "question", p: 0.93, source: "judge", reason: "judge is_question p=0.93" },
    answer: "Start with a fixed window per key.",
    status: "done",
  });
  assert.equal(view.header, "Question: How would you shard it?");
  assert.equal(view.meta, "Detected: judge is_question p=0.93 · done");
  assert.equal(view.body, "Start with a fixed window per key.");
});

test("materialStatusView covers loaded, empty and broken states", () => {
  assert.equal(materialStatusView(null, null), "No problem statement yet. Paste one before you start.");
  assert.match(materialStatusView({ problemStatement: "x".repeat(50), savedAt: "2026-10-15" }, null), /50 characters saved/);
  assert.equal(materialStatusView(null, "The saved practice material couldn't be read. Paste it again."),
    "The saved practice material couldn't be read. Paste it again.");
});

test("sessionSummaryView counts questions and skips", () => {
  assert.equal(sessionSummaryView(null), "No practice session yet.");
  assert.equal(
    sessionSummaryView({ active: true, startedAt: "2026-10-15T10:00:00Z", questions: 2, skipped: 1 }),
    "Practice running since 2026-10-15T10:00:00Z · 2 questions · 1 skipped",
  );
});
