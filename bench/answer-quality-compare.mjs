/**
 * Side-by-side verdict of two bench/answer-quality.mjs result files.
 *
 *   bun bench/answer-quality-compare.mjs before.json after.json
 *       [--rubric scores.json] [--mode technical]
 *
 * scores.json: { "<question-id>": { "<label>": { correctness, judgment,
 * constraints, honesty } } } (0-2 each), filled in from the worksheets.
 */
import { readFileSync } from "node:fs";
import { compareReports } from "./answer-quality-report.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const paths = argv.filter((value, i) => !value.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (paths.length !== 2) {
  console.error("usage: bun bench/answer-quality-compare.mjs <before.json> <after.json> [--rubric scores.json] [--mode spoken|technical]");
  process.exit(2);
}
const [before, after] = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const rubricPath = flag("rubric");
const rubric = rubricPath ? JSON.parse(readFileSync(rubricPath, "utf8")) : null;
const mode = flag("mode") ?? after.mode ?? "technical";

const { rows, verdict } = compareReports(before, after, rubric, { mode });
const labels = [before.label, after.label];
console.log(`| metric | ${labels[0]} | ${labels[1]} |`);
console.log("|---|---:|---:|");
for (const row of rows) {
  const show = (value) => (value == null ? "-" : typeof value === "number" ? String(Math.round(value * 1000) / 1000) : String(value));
  console.log(`| ${row.metric} | ${show(row[labels[0]])} | ${show(row[labels[1]])} |`);
}
console.log(`\nWinner: ${verdict.winner}`);
for (const reason of verdict.reasons) console.log(`- ${reason}`);
