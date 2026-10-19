/**
 * Side-by-side medians of two `bench/latency.mjs --out` result files.
 *
 *   bun bench/compare.mjs bench/results/baseline-c2240db.json bench/results/<after>.json
 */
import { readFileSync } from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: bun bench/compare.mjs <before.json> <after.json>");
  process.exit(2);
}
const before = JSON.parse(readFileSync(beforePath, "utf8"));
const after = JSON.parse(readFileSync(afterPath, "utf8"));

const METRICS = ["hint", "finalize", "final", "firstTok", "answerDone", "partialGapMax"];
const median = (values) => {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const fmt = (x) => (x == null ? "-" : `${Math.round(x)}`);

/** Per-question medians across reps; multi-question scenarios report first/second half. */
function summarize(scenario) {
  const runs = scenario?.runs ?? [];
  if (!runs.length) return null;
  const nq = runs[0].questions.length;
  const rows = {};
  const pick = (qs, m) => median(qs.map((q) => q[m]));
  if (nq === 1) {
    const qs = runs.map((r) => r.questions[0]);
    for (const m of METRICS) rows[m] = pick(qs, m);
  } else {
    const half = nq >> 1;
    const all = runs.flatMap((r) => r.questions.map((q, i) => ({ ...q, i })));
    // Even-indexed questions are the short ones (first token is speech-end bound).
    const shortOnly = (q) => q.i % 2 === 0;
    rows[`final (q1-${half})`] = pick(all.filter((q) => q.i < half), "final");
    rows[`final (q${half + 1}-${nq})`] = pick(all.filter((q) => q.i >= half), "final");
    rows[`firstTok short q (q1-${half})`] = pick(all.filter((q) => q.i < half && shortOnly(q)), "firstTok");
    rows[`firstTok short q (q${half + 1}-${nq})`] = pick(all.filter((q) => q.i >= half && shortOnly(q)), "firstTok");
  }
  const vad = runs[0].vad;
  rows["vad forwarded ratio"] = vad?.forwardedRatio;
  rows["vad failedOpen"] = vad?.failedOpen;
  return rows;
}

console.log(`| scenario | metric (ms after speech end) | ${before.label} | ${after.label} |`);
console.log("|---|---|---:|---:|");
for (const name of Object.keys({ ...before.scenarios, ...after.scenarios })) {
  const b = summarize(before.scenarios[name]) ?? {};
  const a = summarize(after.scenarios[name]) ?? {};
  for (const key of Object.keys({ ...b, ...a })) {
    const show = (v) => (typeof v === "number" && !key.includes("ratio") ? fmt(v) : String(v ?? "-"));
    console.log(`| ${name} | ${key} | ${show(b[key])} | ${show(a[key])} |`);
  }
}
