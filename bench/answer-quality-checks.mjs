/**
 * Answer-quality scoring, pure functions (tested in
 * test/p3-answer-quality-checks.test.js). bench/answer-quality.mjs runs live
 * answers through them. `must` fragments are case-insensitive substrings
 * ("idempot" matches idempotent and idempotency): they anchor the automated
 * coverage check and the human rubric, not a complete definition of
 * correctness. Style hygiene reuses the humanizer counters unchanged, on the
 * prose a rep reads (bullets, highlight markers and code removed).
 */
import { basename } from "node:path";
import { scoreAnswer, summarize, passes } from "./answer-style-checks.mjs";
import { CARD_LIMITS, wantsDetail } from "../src/shared/answer-cards.js";

const hits = (delivered, fragments) => {
  const lower = String(delivered).toLowerCase();
  return fragments.filter((fragment) => lower.includes(String(fragment).toLowerCase()));
};

/**
 * The prose a rep reads: the filter's own "• " line bullets and the `**`
 * pairs the overlay paints as highlights are markup, not text, and fenced
 * code is code. Humanizer tells are counted on what is left.
 */
const paintedProse = (delivered) =>
  String(delivered)
    .replace(/^```[^\n]*\n[\s\S]*?(?:^```[^\n]*$|(?![\s\S]))/gm, "")
    .replace(/^• /gm, "")
    .replaceAll("**", "");

/**
 * @param {{raw?: string, delivered?: string, item?: object}} args
 * @returns {{style: object, mustHit: string[], mustMissing: string[], coverage: number|null}}
 */
export function scoreQuality({ raw = "", delivered = "", item = {} } = {}) {
  const must = Array.isArray(item.must) ? item.must.map(String) : [];
  const mustHit = hits(delivered, must);
  return {
    style: scoreAnswer({ raw, delivered: paintedProse(delivered), expect: item.expect ?? [], uncovered: Boolean(item.uncovered) }),
    mustHit,
    mustMissing: must.filter((fragment) => !mustHit.includes(fragment)),
    coverage: must.length ? mustHit.length / must.length : null,
  };
}

/**
 * @param {Array<{id, category, firstTokenMs, totalMs, error, score}>} rows
 */
export function summarizeQuality(rows) {
  const answered = rows.filter((row) => !row.error && row.score);
  const totals = (list) => list.reduce((sum, row) => sum + row.score.mustHit.length + row.score.mustMissing.length, 0);
  const byCategory = {};
  for (const row of answered) {
    const name = row.category ?? "other";
    const bucket = byCategory[name] ?? (byCategory[name] = { answers: 0, mustHit: 0, mustTotal: 0, coverage: null });
    bucket.answers += 1;
    bucket.mustHit += row.score.mustHit.length;
    bucket.mustTotal += row.score.mustHit.length + row.score.mustMissing.length;
  }
  for (const bucket of Object.values(byCategory)) {
    bucket.coverage = bucket.mustTotal ? bucket.mustHit / bucket.mustTotal : null;
  }
  const sorted = (values) => values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  // Nearest-rank percentile: 1-based rank = ceil(p/100 * n), clamped into
  // [1, n]. p50 of [100, 200, 300] is the true median (200), p95 of three
  // samples is the slowest one (300), and p95 of 100 samples is the textbook
  // 95th. A floor rank pulls p95 below the tail, so a slow outlier would pass
  // the latency gate these numbers feed; the ceiling form is deliberate.
  const pct = (values, p) => {
    if (!values.length) return null;
    const rank = Math.min(values.length, Math.max(1, Math.ceil((p / 100) * values.length)));
    return values[rank - 1];
  };
  const mustHit = answered.reduce((sum, row) => sum + row.score.mustHit.length, 0);
  const mustTotal = totals(answered);
  return {
    answers: rows.length,
    errors: rows.filter((row) => row.error).length,
    mustHit,
    mustTotal,
    coverage: mustTotal ? mustHit / mustTotal : null,
    byCategory,
    p50FirstTokenMs: pct(sorted(rows.map((row) => row.firstTokenMs)), 50),
    p95FirstTokenMs: pct(sorted(rows.map((row) => row.firstTokenMs)), 95),
    p50TotalMs: pct(sorted(rows.map((row) => row.totalMs)), 50),
    style: summarize(answered.map((row) => row.score.style)),
  };
}

/**
 * Evidence gate for one run: no errors, no humanizer hard-rule violations,
 * and `must` coverage at or above `minCoverage`. The model-comparison decision
 * rule (spec §1.5) compares two summaries; this gate decides whether one run
 * is even admissible.
 */
export function passesQuality(summary, { minCoverage = 0.6 } = {}) {
  return summary.errors === 0 && passes(summary.style) && (summary.coverage ?? 0) >= minCoverage;
}

export const WRAP = 72;
export const VIEW_LINES = 9;

/** A card's closing: a trade-off (technical cards) or a next step (sales cards). */
export const TRADEOFF_RE = /trade-?off|next step|\bvs\.?\b|versus|downside|at the cost|costs? (?:more|extra)|but (?:it|this|that) (?:adds|costs|needs)/i;

export const LOW_LEVEL_PATTERNS = Object.freeze([
  /\b[a-z]+_[a-z0-9_]+\b/g,
  /\b[a-z]+[A-Z][A-Za-z]+\b/g,
  /(?:GET|POST|PUT|DELETE|PATCH)\s+\/|\/[a-z]+\/\{/g,
  /\bO\([^)]*\)/g,
  /`[^`]+`/g,
]);

/**
 * Gates for connected cards: a card covers each part the question names in
 * full sentences, so it is longer than a glance-sized screen; the top line is
 * always in view (the answer box keeps the top), so screen fit is reported
 * but not gated. Arrows in prose are never allowed.
 */
export const SKIM_GATE_LIMITS = Object.freeze({
  wordsP90: 160,
  maxLines: CARD_LIMITS.lines,
  arrowsMean: 0,
  tradeoffShare: 0.9,
  lowLevelMean: 1.0,
  bareNumbersMean: 0.5,
  detailMaxLines: CARD_LIMITS.detailLines,
  detailWordsP90: 220,
  detailArrowsMean: 0,
  detailTradeoffShare: 0.9,
});

/** Arrows used as prose ("A → B -> C"); code blocks and inline code are skipped. */
const ARROW_RE = /→|⟶|->|=>/g;

export const SKIM_GATE_NAMES = Object.freeze({
  wordsP90: "words p90",
  maxLines: "max lines",
  arrowsMean: "arrows mean",
  tradeoffShare: "tradeoff share",
  lowLevelMean: "lowLevel mean",
  bareNumbersMean: "bareNumbers mean",
  detailMaxLines: "detail max lines",
  detailWordsP90: "detail words p90",
  detailArrowsMean: "detail arrows mean",
  detailTradeoffShare: "detail tradeoff share",
});

/**
 * One --doc file as the DOCUMENTS block the desktop sends: the app's grounding
 * store (grounding-document.json) contributes its `text` under its `name`;
 * any other file is read as text.
 */
export function docsFromFile(path, raw) {
  const clean = (text) => String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  if (/\.json$/i.test(path)) {
    const store = JSON.parse(raw);
    if (store && typeof store.text === "string") return `File: ${store.name || basename(path)}\n\n${clean(store.text)}`;
  }
  return `File: ${basename(path)}\n\n${clean(raw)}`;
}

const NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?/g;

function extractNumberValues(text) {
  const matches = String(text ?? "").match(NUMBER_RE) ?? [];
  const numbers = [];
  for (const raw of matches) {
    const clean = raw.replace(/,+$/, "").replaceAll(",", "");
    const val = Number(clean);
    if (!Number.isNaN(val)) numbers.push(val);
  }
  return numbers;
}

/**
 * Score one answer for skimmability.
 *
 * @param {{delivered?: string, question?: string, grounding?: string}} args
 * @returns {{words: number, lines: number, visualLines: number, fits: boolean, tradeoff: boolean, lowLevel: number, bareNumbers: number, detail: boolean}}
 */
export function scoreSkim({ delivered = "", question = "", grounding = "" } = {}) {
  const rawDelivered = String(delivered ?? "");
  const trimmed = rawDelivered.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;

  const lineList = rawDelivered
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  const lines = lineList.length;
  const visualLines = lineList.reduce((sum, line) => sum + Math.ceil((line.length + 2) / WRAP), 0);
  const fits = visualLines <= VIEW_LINES;

  const tradeoff = TRADEOFF_RE.test(rawDelivered);

  let lowLevel = 0;
  for (const pattern of LOW_LEVEL_PATTERNS) {
    const matches = rawDelivered.match(pattern);
    if (matches) lowLevel += matches.length;
  }

  const sourceNumbers = new Set(extractNumberValues(`${question ?? ""} ${grounding ?? ""}`));
  let bareNumbers = 0;
  const allLines = rawDelivered.split(/\r?\n/);
  for (const line of allLines) {
    if (/\bassum/i.test(line)) continue;
    const numbers = extractNumberValues(line);
    for (const val of numbers) {
      if ((val > 10 || !Number.isInteger(val)) && !sourceNumbers.has(val)) {
        bareNumbers += 1;
      }
    }
  }

  let arrows = 0;
  let inCode = false;
  for (const line of allLines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    arrows += (line.replace(/`[^`]*`/g, "").match(ARROW_RE) ?? []).length;
  }

  const detail = wantsDetail(question);

  return {
    words,
    lines,
    visualLines,
    fits,
    tradeoff,
    lowLevel,
    bareNumbers,
    arrows,
    detail,
  };
}

function summarizeBucket(list) {
  const n = list.length;
  const sorted = (values) => values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  const pct = (values, p) => {
    if (!values.length) return null;
    const rank = Math.min(values.length, Math.max(1, Math.ceil((p / 100) * values.length)));
    return values[rank - 1];
  };

  const words = list.map((s) => s.words);
  const lines = list.map((s) => s.lines);

  return {
    answers: n,
    wordsP90: pct(sorted(words), 90),
    wordsMean: n ? list.reduce((sum, s) => sum + s.words, 0) / n : null,
    maxLines: lines.length ? Math.max(...lines) : 0,
    avgLines: n ? list.reduce((sum, s) => sum + s.lines, 0) / n : null,
    avgVisualLines: n ? list.reduce((sum, s) => sum + s.visualLines, 0) / n : null,
    fitsShare: n ? list.filter((s) => s.fits).length / n : null,
    tradeoffShare: n ? list.filter((s) => s.tradeoff).length / n : null,
    lowLevelMean: n ? list.reduce((sum, s) => sum + s.lowLevel, 0) / n : null,
    bareNumbersMean: n ? list.reduce((sum, s) => sum + s.bareNumbers, 0) / n : null,
    arrowsMean: n ? list.reduce((sum, s) => sum + (s.arrows ?? 0), 0) / n : null,
  };
}

/**
 * Summarize skim scores grouped by general vs detail questions.
 *
 * @param {Array<object>} scores
 * @returns {{general: object, detail: object}}
 */
export function summarizeSkim(scores) {
  const list = Array.isArray(scores) ? scores : [];
  return {
    general: summarizeBucket(list.filter((s) => !s.detail)),
    detail: summarizeBucket(list.filter((s) => s.detail)),
  };
}

/**
 * Gate check for skimmability summary.
 *
 * @param {{general?: object, detail?: object}} summary
 * @returns {{pass: boolean, failures: string[]}}
 */
export function passesSkim(summary) {
  const failures = [];
  const g = summary?.general;
  const d = summary?.detail;

  if (g && (g.answers === undefined || g.answers > 0)) {
    if (g.wordsP90 != null && g.wordsP90 > SKIM_GATE_LIMITS.wordsP90) {
      failures.push(SKIM_GATE_NAMES.wordsP90);
    }
    if (g.maxLines != null && g.maxLines > SKIM_GATE_LIMITS.maxLines) {
      failures.push(SKIM_GATE_NAMES.maxLines);
    }
    if (g.arrowsMean != null && g.arrowsMean > SKIM_GATE_LIMITS.arrowsMean) {
      failures.push(SKIM_GATE_NAMES.arrowsMean);
    }
    if (g.tradeoffShare != null && g.tradeoffShare < SKIM_GATE_LIMITS.tradeoffShare) {
      failures.push(SKIM_GATE_NAMES.tradeoffShare);
    }
    if (g.lowLevelMean != null && g.lowLevelMean > SKIM_GATE_LIMITS.lowLevelMean) {
      failures.push(SKIM_GATE_NAMES.lowLevelMean);
    }
    if (g.bareNumbersMean != null && g.bareNumbersMean > SKIM_GATE_LIMITS.bareNumbersMean) {
      failures.push(SKIM_GATE_NAMES.bareNumbersMean);
    }
  }

  if (d && (d.answers === undefined || d.answers > 0)) {
    if (d.maxLines != null && d.maxLines > SKIM_GATE_LIMITS.detailMaxLines) {
      failures.push(SKIM_GATE_NAMES.detailMaxLines);
    }
    if (d.wordsP90 != null && d.wordsP90 > SKIM_GATE_LIMITS.detailWordsP90) {
      failures.push(SKIM_GATE_NAMES.detailWordsP90);
    }
    if (d.arrowsMean != null && d.arrowsMean > SKIM_GATE_LIMITS.detailArrowsMean) {
      failures.push(SKIM_GATE_NAMES.detailArrowsMean);
    }
    if (d.tradeoffShare != null && d.tradeoffShare < SKIM_GATE_LIMITS.detailTradeoffShare) {
      failures.push(SKIM_GATE_NAMES.detailTradeoffShare);
    }
  }

  return {
    pass: failures.length === 0,
    failures,
  };
}
