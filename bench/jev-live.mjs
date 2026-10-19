/**
 * Live TypeSafe Jev probe: round-trip latency from this machine with
 * transcript-sized state, plus a small labelled check of the two judgments the
 * pipeline uses. Needs TYPESAFE_API_KEY (optional TYPESAFE_BASE_URL, TYPESAFE_MODEL).
 *
 *   bun bench/jev-live.mjs [--passes 2] [--out bench/results/jev-live.json]
 *
 * Requests run one at a time (the pipeline sends at most one per turn), with
 * the cache off so every request reaches the API.
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const HERE = dirname(fileURLToPath(import.meta.url));
const PASSES = Math.max(1, Number(arg("passes", 2)) | 0);
const OUT = arg("out", null);

if (!process.env.TYPESAFE_API_KEY) {
  console.error("jev-live: set TYPESAFE_API_KEY (and optionally TYPESAFE_BASE_URL / TYPESAFE_MODEL)");
  process.exit(2);
}
const { createJudge, judgeOptionsFromEnv } = await import(pathToFileURL(join(HERE, "..", "src/server/engines/judge.js")).href);
const options = judgeOptionsFromEnv({ ...process.env, JEV_JUDGMENTS: "gate,rescue", JEV_TIMEOUT_MS: "5000" });
const judge = createJudge({ ...options, cacheSize: 0 });

const GATE_CASES = [
  ["how much does the enterprise tier cost per seat", true],
  ["can you walk me through how onboarding works for a team our size", true],
  ["what happens to our data if we cancel", true],
  ["I'm worried about the migration timeline, is that realistic", true],
  ["do you integrate with Salesforce", true],
  ["why is this more expensive than the other vendor we looked at", true],
  ["yeah that makes sense", false],
  ["okay great thanks for walking me through that", false],
  ["let me check with my team and get back to you", false],
  ["sounds good", false],
  ["right right I see", false],
  ["we had a similar setup at my last company", false],
];
const RESCUE_CASES = [
  ["how much is the pro tier per seat for a team of forty", "how much is the pro plan per seat for a team of forty", true],
  ["what does it cost per seat", "how much is it per seat", true],
  ["do you support single sign on", "do you support SSO", true],
  ["can you walk me through the onboarding", "could you walk me through onboarding", true],
  ["do you integrate with Salesforce", "do you integrate with Salesforce and HubSpot", false],
  ["how much is the pro plan per seat", "how much is the enterprise plan per seat", false],
  ["what is your uptime", "what is your uptime SLA and what credits do we get if you miss it", false],
  ["can we pay monthly", "can we pay annually", false],
];
const GATE_CANCEL_BELOW = 0.15;
const RESCUE_AT_LEAST = 0.8;

const latencies = [];
const errors = [];
const gate = [];
const rescue = [];
for (let pass = 0; pass < PASSES; pass += 1) {
  for (const [utterance, isQuestion] of GATE_CASES) {
    const v = await judge.evaluate({ utterance });
    latencies.push(v.latencyMs);
    if (v.error) errors.push(v.error);
    gate.push({ utterance, expected: isQuestion, p: v.isQuestion, cancelled: v.isQuestion != null && v.isQuestion < GATE_CANCEL_BELOW });
  }
  for (const [answeredFor, utterance, same] of RESCUE_CASES) {
    const v = await judge.evaluate({ utterance, answeredFor });
    latencies.push(v.latencyMs);
    if (v.error) errors.push(v.error);
    rescue.push({ answeredFor, utterance, expected: same, p: v.answersSame, rescued: v.answersSame != null && v.answersSame >= RESCUE_AT_LEAST });
  }
}
judge.close();

const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const summary = {
  model: options.model,
  requests: latencies.length,
  errors: errors.length,
  latencyMs: { p50: pct(50), p95: pct(95), max: sorted[sorted.length - 1] },
  gate: {
    realQuestionsCancelled: gate.filter((g) => g.expected && g.cancelled).length,
    smallTalkCancelled: gate.filter((g) => !g.expected && g.cancelled).length,
    smallTalkTotal: gate.filter((g) => !g.expected).length,
  },
  rescue: {
    sameRescued: rescue.filter((r) => r.expected && r.rescued).length,
    sameTotal: rescue.filter((r) => r.expected).length,
    differentRescued: rescue.filter((r) => !r.expected && r.rescued).length,
  },
};
console.log(JSON.stringify(summary, null, 1));
for (const g of gate) console.log(`gate   ${g.expected ? "Q " : "ST"} p=${g.p?.toFixed(3) ?? "null"} ${g.cancelled ? "CANCEL" : "keep  "} ${g.utterance}`);
for (const r of rescue) console.log(`rescue ${r.expected ? "same" : "diff"} p=${r.p?.toFixed(3) ?? "null"} ${r.rescued ? "RESCUE" : "regen "} ${r.answeredFor} -> ${r.utterance}`);
if (OUT) writeFileSync(resolve(OUT), JSON.stringify({ at: new Date().toISOString(), summary, gate, rescue }, null, 1));
