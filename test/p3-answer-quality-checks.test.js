import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scoreQuality,
  summarizeQuality,
  passesQuality,
  scoreSkim,
  summarizeSkim,
  passesSkim,
} from "../bench/answer-quality-checks.mjs";

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "fixtures", "answer-quality-questions.json"), "utf8"),
);

test("fixture shape: 26 entries, unique ids, lowercase non-empty must fragments", () => {
  assert.equal(fixture.length, 26);
  assert.equal(new Set(fixture.map((item) => item.id)).size, 26);
  for (const item of fixture) {
    assert.equal(typeof item.question, "string");
    assert.ok(item.question.length > 0);
    assert.ok(Array.isArray(item.must) && item.must.length > 0);
    for (const fragment of item.must) {
      assert.equal(fragment, fragment.toLowerCase());
      assert.ok(fragment.length > 0);
    }
  }
});

test("fixture: the greenhouse question is verbatim", () => {
  const item = fixture.find((entry) => entry.id === "greenhouse-realtime");
  assert.ok(item.question.startsWith("Design a service for real-time remote monitoring and analytics for distributed commercial greenhouse facilities."));
  assert.ok(item.question.includes("POST /greenhouses/{greenhouseId}/sensors/data"));
  assert.ok(item.question.includes("robust monitoring and alerting for system health and data anomalies."));
});

test("scoreQuality: case-insensitive substring coverage and expect facts", () => {
  const item = { must: ["idempot", "partition"], expect: ["400 days"] };
  const score = scoreQuality({
    raw: "Use an idempotent consumer, keyed partitions. Kept 400 DAYS.",
    delivered: "Use an idempotent consumer, keyed partitions. Kept 400 days.",
    item,
  });
  assert.deepEqual(score.mustHit, ["idempot", "partition"]);
  assert.deepEqual(score.mustMissing, []);
  assert.equal(score.coverage, 1);
  assert.deepEqual(score.style.factsMissing, []);
});

test("scoreQuality: missing fragments and partial coverage", () => {
  const score = scoreQuality({ raw: "partition the topic", delivered: "partition the topic", item: { must: ["partition", "retention"] } });
  assert.deepEqual(score.mustHit, ["partition"]);
  assert.deepEqual(score.mustMissing, ["retention"]);
  assert.equal(score.coverage, 0.5);
});

test("scoreQuality: the overlay's own bullets, highlights and code are not style faults", () => {
  const delivered = [
    "• VERDICT: Use a **hash map** for lookups.",
    "• COST: Each lookup is constant time on average.",
    "```python",
    "# count each item",
    "seen = {}",
    "```",
    "• TRADE-OFF: It uses more memory than a sorted list.",
  ].join("\n");
  const score = scoreQuality({ raw: delivered, delivered, item: { must: ["hash map", "# count"] } });
  assert.equal(score.style.hardTotal, 0, JSON.stringify(score.style.deliveredHard));
  assert.equal(score.coverage, 1, "coverage still reads the whole answer, code included");
  const stray = scoreQuality({ raw: "", delivered: "• VERDICT: Use __this__ — always.", item: {} });
  assert.equal(stray.style.deliveredHard.markdown, 2, "markdown the overlay does not paint still counts");
  assert.equal(stray.style.deliveredHard.dashes, 1);
});

test("scoreQuality: questions without must anchors score coverage null", () => {
  const score = scoreQuality({ raw: "hello", delivered: "hello", item: {} });
  assert.equal(score.coverage, null);
  assert.deepEqual(score.mustMissing, []);
});

test("summarizeQuality: per-category coverage, latency percentiles, style summary", () => {
  const rows = [
    { id: "a", category: "system-design", firstTokenMs: 100, totalMs: 400, error: null, score: scoreQuality({ raw: "partition idempot", delivered: "partition idempot", item: { must: ["partition", "idempot"] } }) },
    { id: "b", category: "system-design", firstTokenMs: 300, totalMs: 900, error: null, score: scoreQuality({ raw: "retention", delivered: "retention", item: { must: ["partition"] } }) },
    { id: "c", category: "honesty", firstTokenMs: 200, totalMs: 700, error: "boom", score: scoreQuality({ raw: "", delivered: "", item: { must: ["depends"] } }) },
  ];
  const summary = summarizeQuality(rows);
  assert.equal(summary.answers, 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.mustHit, 2);
  assert.equal(summary.mustTotal, 3);
  assert.ok(Math.abs(summary.coverage - 2 / 3) < 1e-9);
  assert.ok(Math.abs(summary.byCategory["system-design"].coverage - 2 / 3) < 1e-9);
  assert.equal(summary.p50FirstTokenMs, 200); // true median of [100, 200, 300]
  assert.equal(summary.p95FirstTokenMs, 300); // nearest-rank p95 covers the tail
  assert.equal(typeof summary.style.answers, "number");
});

test("passesQuality: errors and low coverage fail, clean run passes", () => {
  const good = summarizeQuality([
    { id: "a", category: "c", firstTokenMs: 1, totalMs: 2, error: null, score: scoreQuality({ raw: "partition", delivered: "partition", item: { must: ["partition"] } }) },
  ]);
  assert.equal(passesQuality(good), true);
  const bad = summarizeQuality([
    { id: "a", category: "c", firstTokenMs: 1, totalMs: 2, error: "x", score: scoreQuality({ raw: "", delivered: "", item: { must: ["partition"] } }) },
  ]);
  assert.equal(passesQuality(bad), false);
});

test("scoreSkim and passesSkim: skimmability scoring and gate verification", () => {
  const generalDelivered = [
    "• VERDICT: Send uploads straight to object storage.",
    "• HOW: Client uploads with signed URLs.",
    "• EXAMPLE: S3 presigned URLs with SQS.",
    "• TRADE-OFF: Extra client step, but light API.",
  ].join("\n");
  const skim = scoreSkim({ delivered: generalDelivered, question: "How would you handle photo uploads?" });
  assert.equal(skim.lines, 4);
  assert.equal(skim.fits, true);
  assert.equal(skim.tradeoff, true);
  assert.equal(skim.detail, false);

  const summary = summarizeSkim([skim]);
  assert.equal(summary.general.answers, 1);
  assert.equal(summary.general.maxLines, 4);
  assert.equal(passesSkim(summary).pass, true);
});
