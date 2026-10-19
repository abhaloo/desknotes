import test from "node:test";
import assert from "node:assert/strict";
import {
  WRAP,
  VIEW_LINES,
  SKIM_GATE_LIMITS,
  SKIM_GATE_NAMES,
  scoreSkim,
  summarizeSkim,
  passesSkim,
  docsFromFile,
} from "../bench/answer-quality-checks.mjs";

test("a 4-line card scores lines 4, fits true, tradeoff true, lowLevel 0, bareNumbers 0", () => {
  const card = [
    "• VERDICT: Send uploads straight to object storage, not through our API.",
    "• HOW: The app gets a signed URL; a worker makes thumbnails later.",
    "• EXAMPLE: S3 presigned URLs, with an SQS queue feeding the worker.",
    "• TRADE-OFF: The client does one extra step, but our API stays light.",
  ].join("\n");

  const score = scoreSkim({
    delivered: card,
    question: "How would you handle photo uploads in a mobile app?",
  });

  assert.equal(score.lines, 4);
  assert.equal(score.fits, true);
  assert.equal(score.tradeoff, true);
  assert.equal(score.lowLevel, 0);
  assert.equal(score.bareNumbers, 0);
  assert.equal(score.detail, false);
  assert.ok(score.words > 0 && score.words < 90);
});

test("the live turn-10 style answer (build 75 \"Label: x\" lines) scores fits false", () => {
  const lines = Array.from({ length: 75 }, (_, i) => `Label ${i}: value ${i}`);
  const turn10Answer = lines.join("\n");

  const score = scoreSkim({ delivered: turn10Answer });

  assert.equal(score.lines, 75);
  assert.ok(score.visualLines >= 75);
  assert.equal(score.fits, false);
});

test("\"assume 5,000 QPS\" is not bare", () => {
  const delivered = "• HOW: assume 5,000 QPS and write to an append-only log.";
  const score = scoreSkim({ delivered });
  assert.equal(score.bareNumbers, 0);
});

test("\"p99 under 85 ms at 5,000 QPS\" with no source has 2 bare numbers", () => {
  const delivered = "• METRICS: p99 under 85 ms at 5,000 QPS across all nodes.";
  const score = scoreSkim({ delivered });
  assert.equal(score.bareNumbers, 2);
});

test("\"6M records\" with grounding \"6M records\" has 0", () => {
  const delivered = "• SCALE: 6M records ingested per day.";
  const score = scoreSkim({
    delivered,
    grounding: "The customer database holds 6M records.",
  });
  assert.equal(score.bareNumbers, 0);
});

test("detail question scores detail true, general question scores detail false", () => {
  const generalScore = scoreSkim({
    delivered: "• VERDICT: Use a cache.",
    question: "How would you speed up profile reads?",
  });
  assert.equal(generalScore.detail, false);

  const detailScore = scoreSkim({
    delivered: "• VERDICT: Step-by-step schema details.",
    question: "Walk me through the schema step-by-step in detail.",
  });
  assert.equal(detailScore.detail, true);
});

test("summarizeSkim separates general and detail scores, computing aggregates", () => {
  const scores = [
    { words: 50, lines: 4, visualLines: 4, fits: true, tradeoff: true, lowLevel: 0, bareNumbers: 0, detail: false },
    { words: 70, lines: 5, visualLines: 6, fits: true, tradeoff: true, lowLevel: 1, bareNumbers: 0, detail: false },
    { words: 120, lines: 7, visualLines: 8, fits: true, tradeoff: true, lowLevel: 0, bareNumbers: 0, detail: true },
  ];

  const summary = summarizeSkim(scores);
  assert.equal(summary.general.answers, 2);
  assert.equal(summary.general.maxLines, 5);
  assert.equal(summary.general.wordsP90, 70);
  assert.equal(summary.general.fitsShare, 1.0);
  assert.equal(summary.general.tradeoffShare, 1.0);
  assert.equal(summary.general.lowLevelMean, 0.5);
  assert.equal(summary.general.bareNumbersMean, 0);

  assert.equal(summary.detail.answers, 1);
  assert.equal(summary.detail.maxLines, 7);
  assert.equal(summary.detail.wordsP90, 120);
});

test("passesSkim reports exactly the failed gates by name", () => {
  // Clean summary passes all gates
  const passingSummary = {
    general: {
      answers: 10,
      wordsP90: 140,
      maxLines: 7,
      arrowsMean: 0,
      tradeoffShare: 1.0,
      lowLevelMean: 0.8,
      bareNumbersMean: 0.3,
    },
    detail: {
      answers: 5,
      maxLines: 8,
      wordsP90: 180,
      arrowsMean: 0,
      tradeoffShare: 1.0,
    },
  };
  const passing = passesSkim(passingSummary);
  assert.equal(passing.pass, true);
  assert.deepEqual(passing.failures, []);

  // Summary failing all 6 general gates and 1 detail gate
  const failingSummary = {
    general: {
      answers: 10,
      wordsP90: 180,        // limit <= 160
      maxLines: 10,         // limit <= CARD_LIMITS.lines
      arrowsMean: 0.5,      // limit 0
      tradeoffShare: 0.6,   // limit >= 0.9
      lowLevelMean: 1.5,    // limit <= 1.0
      bareNumbersMean: 0.8, // limit <= 0.5
    },
    detail: {
      answers: 5,
      maxLines: 10,         // limit <= CARD_LIMITS.detailLines
      wordsP90: 260,        // limit <= 220
      arrowsMean: 1,        // limit 0
      tradeoffShare: 0.5,   // limit >= 0.9
    },
  };

  const failing = passesSkim(failingSummary);
  assert.equal(failing.pass, false);
  assert.deepEqual(failing.failures, [
    "words p90",
    "max lines",
    "arrows mean",
    "tradeoff share",
    "lowLevel mean",
    "bareNumbers mean",
    "detail max lines",
    "detail words p90",
    "detail arrows mean",
    "detail tradeoff share",
  ]);
});

test("scoreSkim counts arrows in prose, not in code", () => {
  const prose = "• VERDICT: Gateway → Kafka -> workers.\n• HOW: plain words.";
  assert.equal(scoreSkim({ delivered: prose, question: "Q?" }).arrows, 2);
  const code = "• VERDICT: use a map.\n```js\nconst f = (a) => a;\n```\n• TRADE-OFF: memory, see `x => y`.";
  assert.equal(scoreSkim({ delivered: code, question: "Q?" }).arrows, 0);
});

test("a vague detail answer with no trade-off fails the detail gates", () => {
  const vague = `• VERDICT: ${"vague ".repeat(250).trim()}\n• MORE: vague.`;
  const skim = scoreSkim({ delivered: vague, question: "Walk me through exactly how it works, step by step." });
  assert.equal(skim.detail, true);
  const result = passesSkim(summarizeSkim([skim]));
  assert.equal(result.pass, false);
  assert.ok(result.failures.includes("detail words p90"), JSON.stringify(result));
  assert.ok(result.failures.includes("detail tradeoff share"), JSON.stringify(result));
});

test("docsFromFile reads the app's grounding store as its text, and a text file as it is", () => {
  const store = JSON.stringify({ version: 1, name: "KB.md", text: "# KB\nline one", loadedAt: "x" });
  assert.equal(docsFromFile("C:/x/grounding-document.json", store), "File: KB.md\n\n# KB\nline one");
  assert.equal(docsFromFile("C:/x/notes.md", "\uFEFF# Notes\r\nline"), "File: notes.md\n\n# Notes\nline");
});
