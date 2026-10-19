import test from "node:test";
import assert from "node:assert/strict";
import { compareReports, renderWorksheet } from "../bench/answer-quality-report.mjs";

const row = (id, coverage, firstTokenMs) => ({
  id,
  category: "system-design",
  question: `Question ${id}?`,
  firstTokenMs,
  totalMs: firstTokenMs + 100,
  error: null,
  raw: `Answer ${id}`,
  delivered: `Answer ${id}`,
  score: { style: {}, mustHit: ["a"], mustMissing: coverage === 1 ? [] : ["b"], coverage },
});

function report(label, rows, firstTokenMs) {
  return {
    label,
    mode: "technical",
    models: { base: "m", technical: null },
    ts: "2026-10-15",
    summary: {
      answers: rows.length, errors: 0,
      mustHit: rows.length, mustTotal: rows.length * 2,
      coverage: rows.length ? 0.5 : null,
      byCategory: { "system-design": { answers: rows.length, mustHit: rows.length, mustTotal: rows.length * 2, coverage: 0.5 } },
      p50FirstTokenMs: firstTokenMs, p95FirstTokenMs: firstTokenMs, p50TotalMs: firstTokenMs + 100,
      style: { answers: rows.length, hardTotal: 0 }, pass: true,
    },
    rows,
  };
}

test("renderWorksheet prints each question with its anchors and a rubric table", () => {
  const text = renderWorksheet(report("a", [row("q1", 1, 500)], 500));
  assert.ok(text.includes("Question q1?"));
  assert.ok(text.includes("Answer q1"));
  assert.ok(text.includes("correctness"));
  assert.ok(text.includes("honesty"));
});

test("compareReports: inside the quality margin, lower latency wins", () => {
  const { verdict } = compareReports(report("a", [row("q1", 0.5, 500)], 500), report("b", [row("q1", 0.5, 900)], 900), null, { mode: "technical" });
  assert.equal(verdict.winner, "a");
});

test("compareReports: a coverage margin beats latency", () => {
  const slow = report("a", [row("q1", 0.25, 500)], 500);
  slow.summary.coverage = 0.5;
  const fast = report("b", [row("q1", 1, 2500)], 2500);
  fast.summary.coverage = 0.62;
  const { verdict } = compareReports(slow, fast, null, { mode: "technical" });
  assert.equal(verdict.winner, "b");
});

test("compareReports: failing the latency gate disqualifies regardless of quality", () => {
  const good = report("a", [row("q1", 1, 9000)], 9000);
  good.summary.coverage = 0.9;
  const poor = report("b", [row("q1", 0.5, 500)], 500);
  poor.summary.coverage = 0.5;
  const { verdict } = compareReports(good, poor, null, { mode: "technical" });
  assert.equal(verdict.winner, "b");
});

test("compareReports: rubric margin 0.5 displaces the incumbent, correctness must not regress", () => {
  const a = report("a", [row("q1", 0.5, 500)], 500);
  const b = report("b", [row("q1", 0.5, 500)], 500);
  const rubricBetter = { q1: { a: { correctness: 2, judgment: 1, constraints: 1, honesty: 2 }, b: { correctness: 2, judgment: 2, constraints: 2, honesty: 2 } } };
  assert.equal(compareReports(a, b, rubricBetter, { mode: "technical" }).verdict.winner, "b");
  const rubricRegression = { q1: { a: { correctness: 2, judgment: 2, constraints: 2, honesty: 2 }, b: { correctness: 1, judgment: 2, constraints: 2, honesty: 2 } } };
  assert.equal(compareReports(a, b, rubricRegression, { mode: "technical" }).verdict.winner, "a");
});

test("compareReports: errors disqualify", () => {
  const a = report("a", [row("q1", 1, 500)], 500);
  const b = report("b", [], 500);
  b.summary.errors = 2;
  b.summary.coverage = 1;
  assert.equal(compareReports(a, b, null, { mode: "technical" }).verdict.winner, "a");
});
