#!/usr/bin/env bun
/**
 * Answer-quality bench: the labelled technical eval set through the real
 * answerer. One run is ONE model configuration (the env of the run) and one
 * prompt mode; compare two runs with bench/answer-quality-compare.mjs.
 * Answers can contain grounding facts: stdout or --out/--worksheet paths,
 * never into the repo.
 *
 * Delivery "production" (the default) scores what the overlay shows: the
 * spoken prompt with the instructions file, highlights on, and the answerer's
 * own card path (filter, line and code budgets, line cap, VERDICT check).
 * "raw" scores the provider text through a plain filter, as earlier runs did.
 * A failed coverage or skim gate sets a failing exit code.
 *
 *   bun bench/answer-quality.mjs [--questions f.json] [--doc a.md,grounding-document.json]
 *       [--mode spoken|technical] [--cards on|off] [--delivery production|raw]
 *       [--instructions answer-instructions.txt] [--label name] [--reps 1]
 *       [--out results.json] [--worksheet answers.md]
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEngineConfig } from "../src/server/engines/config.js";
import { createAnswerer } from "../src/server/engines/answerer.js";
import { buildContext } from "../src/server/engines/pipeline.js";
import { createSpokenTextFilter } from "../src/server/engines/spoken-text-filter.js";
import {
  scoreQuality,
  summarizeQuality,
  passesQuality,
  scoreSkim,
  summarizeSkim,
  passesSkim,
  docsFromFile,
} from "./answer-quality-checks.mjs";
import { renderWorksheet } from "./answer-quality-report.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    questions: join(here, "fixtures", "answer-quality-questions.json"),
    doc: null, mode: "spoken", label: "run", reps: 1, out: null, worksheet: null, quiet: false,
    cards: "on", delivery: "production", instructions: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--quiet") args.quiet = true;
    else if (["--questions", "--doc", "--mode", "--label", "--reps", "--out", "--worksheet", "--cards", "--delivery", "--instructions"].includes(key)) args[key.slice(2)] = argv[++i];
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!["spoken", "technical"].includes(args.mode)) throw new Error("--mode must be spoken or technical");
  if (!["on", "off"].includes(args.cards)) throw new Error("--cards must be on or off");
  if (!["production", "raw"].includes(args.delivery)) throw new Error("--delivery must be production or raw");
  args.reps = Math.max(1, Number(args.reps) | 0);
  return args;
}

const args = parseArgs(process.argv.slice(2));
const questions = JSON.parse(await readFile(args.questions, "utf8"));
let docs = "";
if (args.doc) {
  // Comma-separated files become File: blocks, exactly like the desktop's
  // concatenated session_context: multiple docs share the 32k budget.
  const paths = args.doc.split(",");
  docs = (await Promise.all(paths.map((path) => readFile(path, "utf8"))))
    .map((raw, i) => docsFromFile(paths[i], raw))
    .join("\n\n");
}

// Production reads the user's instructions file like the desktop does; raw
// keeps the bare prompt unless a file is named.
const userInstructions = process.env.APPDATA ? join(process.env.APPDATA, "DeskNotes", "answer-instructions.txt") : null;
const instructions = args.instructions
  ?? process.env.ANSWER_INSTRUCTIONS_PATH
  ?? (args.delivery === "production" && userInstructions && existsSync(userInstructions) ? userInstructions : null);
console.log(`[${args.label}] delivery ${args.delivery}, mode ${args.mode}, instructions ${instructions ?? "none"}`);

const config = buildEngineConfig(process.env, { mode: "live", answerInstructionsPath: instructions ?? undefined });
if (config.answerProvider !== "openai-compatible") {
  console.error("No answer provider configured: set CEREBRAS_API_KEY (or ANSWER_PROVIDER/LLM_*) first.");
  process.exit(2);
}

const production = args.delivery === "production";
const answerer = createAnswerer({
  provider: config.answerProvider,
  ...config.answererOptions,
  ...(production ? {} : { spokenFilter: false }),
});
const rows = [];
for (const item of questions) {
  // The pipeline composes context like this; the bench must not diverge.
  const context = buildContext({ docs, history: item.history });
  for (let rep = 0; rep < args.reps; rep += 1) {
    const started = performance.now();
    let firstTokenMs = null;
    let raw = "";
    let error = null;
    try {
      const streamArgs = {
        question: item.question,
        context,
        intent: "answer",
        mode: args.mode,
        ...(args.cards === "on" ? { cards: true } : {}),
        ...(production ? { highlights: true } : {}),
      };
      for await (const delta of answerer.streamAnswer(streamArgs)) {
        if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - started);
        raw += delta;
      }
    } catch (failure) {
      error = String(failure?.message ?? failure);
    }
    // Production text is already what the overlay paints; raw text gets the
    // plain filter the earlier runs used.
    let delivered = raw;
    if (!production) {
      const filter = createSpokenTextFilter();
      delivered = filter.push(raw) + filter.flush();
    }
    const qualityScore = scoreQuality({ raw, delivered, item });
    const skimScore = scoreSkim({ delivered, question: item.question, grounding: docs });
    rows.push({
      id: item.id, category: item.category, question: item.question,
      firstTokenMs, totalMs: Math.round(performance.now() - started), error, raw, delivered,
      score: qualityScore,
      skim: skimScore,
    });
    if (!args.quiet) console.log(`\n[${args.label}] ${item.id} (${firstTokenMs ?? "-"} ms)\n${error ? `ERROR ${error}` : delivered}`);
  }
}

const summary = summarizeQuality(rows);
summary.pass = passesQuality(summary);
const skimSummary = summarizeSkim(rows.filter((row) => !row.error).map((row) => row.skim));
const skimPass = passesSkim(skimSummary);
const report = {
  label: args.label,
  mode: args.mode,
  cards: args.cards === "on",
  delivery: args.delivery,
  instructions,
  models: {
    base: config.answererOptions.model,
    technical: config.answererOptions.routes?.technical?.model ?? null,
  },
  ts: new Date().toISOString(),
  summary,
  skimSummary,
  skimPass,
  rows,
};

console.log("\nSkim Summary");
console.table(skimSummary);
if (!skimPass.pass) {
  console.log(`\nFailed skim gates (${skimPass.failures.length}):`);
  for (const failure of skimPass.failures) {
    console.log(`  - ${failure}`);
  }
} else {
  console.log("\nAll skim gates passed.");
}

console.log("\nCoverage Summary");
console.table({ [args.label]: summary });
if (args.out) {
  await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${args.out}`);
}
if (args.worksheet) {
  await writeFile(args.worksheet, renderWorksheet(report));
  console.log(`Wrote ${args.worksheet}`);
}
if (!summary.pass || !skimPass.pass) process.exitCode = 1;
