#!/usr/bin/env bun
/**
 * Live answer-style bench. Runs a question set through the real answerer
 * (provider from the env, vendor presets applied) with the legacy and/or the
 * new prompt, and reports the humanizer tells per variant plus time to first
 * token. Answers can contain document facts: they go to stdout or to --out,
 * never into the repo.
 *
 *   bun bench/answer-style.mjs [--questions file.json] [--doc file.md]
 *       [--prompt new|legacy|both] [--out results.json] [--quiet]
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEngineConfig } from "../src/server/engines/config.js";
import { createAnswerer, DEFAULT_SYSTEM_PROMPT } from "../src/server/engines/answerer.js";
import { createSpokenTextFilter } from "../src/server/engines/spoken-text-filter.js";
import { passes, scoreAnswer, summarize } from "./answer-style-checks.mjs";

/** The prompt before the humanizer change, kept for the before/after comparison. */
export const LEGACY_SYSTEM_PROMPT =
  "You are a quiet call coach. Answer the prospect's question in the " +
  "rep's voice, first person, concrete and brief. Lead with the " +
  "takeaway, then one structured explanation, one short example, and a " +
  "closing bridge back to the role. Never invent credentials.";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { questions: join(here, "fixtures", "answer-style-questions.json"), doc: null, prompt: "both", out: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--quiet") args.quiet = true;
    else if (["--questions", "--doc", "--prompt", "--out"].includes(key)) args[key.slice(2)] = argv[++i];
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!["new", "legacy", "both"].includes(args.prompt)) throw new Error("--prompt must be new, legacy or both");
  return args;
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};

const args = parseArgs(process.argv.slice(2));
const questions = JSON.parse(await readFile(args.questions, "utf8"));
let context = "";
if (args.doc) {
  const text = (await readFile(args.doc, "utf8")).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  context = `DOCUMENTS:\nFile: ${basename(args.doc)}\n\n${text}`;
}
const config = buildEngineConfig(process.env, { mode: "live" });
if (config.answerProvider !== "openai-compatible") {
  console.error("No answer provider configured: set CEREBRAS_API_KEY (or ANSWER_PROVIDER/LLM_*) first.");
  process.exit(2);
}

const variants = args.prompt === "both" ? ["legacy", "new"] : [args.prompt];
const report = { model: config.answererOptions.model, doc: args.doc ? basename(args.doc) : null, variants: {} };
for (const variant of variants) {
  const answerer = createAnswerer({
    provider: config.answerProvider,
    ...config.answererOptions,
    systemPrompt: variant === "legacy" ? LEGACY_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT,
    spokenFilter: false,
  });
  const rows = [];
  for (const item of questions) {
    const started = performance.now();
    let firstTokenMs = null;
    let raw = "";
    let error = null;
    try {
      for await (const delta of answerer.streamAnswer({ question: item.question, context, intent: "answer" })) {
        if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - started);
        raw += delta;
      }
    } catch (failure) {
      error = String(failure?.message ?? failure);
    }
    const filter = createSpokenTextFilter();
    const delivered = filter.push(raw) + filter.flush();
    const score = scoreAnswer({ raw, delivered, expect: item.expect ?? [], uncovered: Boolean(item.uncovered) });
    rows.push({ id: item.id, question: item.question, firstTokenMs, totalMs: Math.round(performance.now() - started), error, raw, delivered, score });
    if (!args.quiet) console.log(`\n[${variant}] ${item.id} (${firstTokenMs ?? "-"} ms)\n${error ? `ERROR ${error}` : delivered}`);
  }
  const summary = summarize(rows.map((row) => row.score));
  summary.errors = rows.filter((row) => row.error).length;
  summary.p50FirstTokenMs = median(rows.map((row) => row.firstTokenMs));
  summary.pass = passes(summary) && summary.errors === 0;
  report.variants[variant] = { summary, rows };
}

console.log("\nSummary");
console.table(Object.fromEntries(Object.entries(report.variants).map(([name, value]) => [name, value.summary])));
if (args.out) {
  await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${args.out}`);
}
