/**
 * Pure report rendering and the model-comparison decision rule (spec §1.5):
 * answer quality first (rubric mean, margin 0.5 on 0-8; `must` coverage with
 * a 0.05 margin when no rubric was scored), latency second (lower p50 first
 * token inside the margin), latency gate and errors as hard disqualifiers.
 */
export const LATENCY_GATES = Object.freeze({
  spoken: { p50: 300, p95: 1_000 },
  technical: { p50: 3_000, p95: 8_000 },
});

const RUBRIC_DIMENSIONS = ["correctness", "judgment", "constraints", "honesty"];

function rubricMean(scores) {
  const values = Object.values(scores ?? {}).map((entry) => RUBRIC_DIMENSIONS.reduce((sum, key) => sum + (Number(entry?.[key]) || 0), 0));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function rubricCorrectness(scores) {
  const values = Object.values(scores ?? {}).map((entry) => Number(entry?.correctness) || 0);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function renderWorksheet(report) {
  const lines = [`# Answer worksheet — ${report.label} (${report.mode})`, ""];
  if (report.skimSummary) {
    const { general, detail } = report.skimSummary;
    lines.push("## Skim Summary", "");
    if (general?.answers) {
      lines.push(`- General (${general.answers}): words p90 ${general.wordsP90 ?? "-"}, max lines ${general.maxLines}, fits ${general.fitsShare != null ? `${Math.round(general.fitsShare * 100)}%` : "-"}, trade-off ${general.tradeoffShare != null ? `${Math.round(general.tradeoffShare * 100)}%` : "-"}, low-level mean ${general.lowLevelMean != null ? general.lowLevelMean.toFixed(2) : "-"}, bare numbers mean ${general.bareNumbersMean != null ? general.bareNumbersMean.toFixed(2) : "-"}`);
    }
    if (detail?.answers) {
      lines.push(`- Detail (${detail.answers}): words p90 ${detail.wordsP90 ?? "-"}, max lines ${detail.maxLines}`);
    }
    lines.push("");
  }
  for (const row of report.rows ?? []) {
    lines.push(`## ${row.id} [${row.category}]`, "", row.question, "");
    if (row.error) lines.push(`ERROR: ${row.error}`, "");
    lines.push("**Answer**", "", row.delivered ?? "", "");
    const skim = row.skim ?? row.score?.skim;
    if (skim) {
      lines.push(`Skim: ${skim.words} words, ${skim.lines} lines (${skim.visualLines} visual lines, fits: ${skim.fits ? "yes" : "no"}), trade-off: ${skim.tradeoff ? "yes" : "no"}, low-level: ${skim.lowLevel}, bare numbers: ${skim.bareNumbers}`, "");
    }
    const score = row.score ?? {};
    if (score.mustHit?.length || score.mustMissing?.length) {
      lines.push(`Reference points — covered: ${(score.mustHit ?? []).join(", ") || "none"}; missing: ${(score.mustMissing ?? []).join(", ") || "none"}`, "");
    }
    lines.push("| dimension | 0 | 1 | 2 | score |", "|---|---|---|---|---|");
    for (const dimension of RUBRIC_DIMENSIONS) lines.push(`| ${dimension} | | | | |`);
    lines.push("");
  }
  return lines.join("\n");
}

export function compareReports(a, b, rubric = null, { mode = "technical" } = {}) {
  const gate = LATENCY_GATES[mode] ?? LATENCY_GATES.technical;
  // The rubric arrives keyed questionId -> label -> scores; pick one label's
  // scores for a report. An absent rubric means the automated-only comparison.
  const scoresFor = (report) => {
    if (!rubric) return null;
    const out = {};
    for (const [id, byLabel] of Object.entries(rubric)) if (byLabel?.[report.label]) out[id] = byLabel[report.label];
    return Object.keys(out).length ? out : null;
  };
  const entry = (report) => {
    const scores = scoresFor(report);
    return {
      label: report.label,
      coverage: report.summary?.coverage ?? null,
      rubric: rubricMean(scores),
      correctness: rubricCorrectness(scores),
      p50: report.summary?.p50FirstTokenMs ?? null,
      p95: report.summary?.p95FirstTokenMs ?? null,
      errors: report.summary?.errors ?? 0,
      wordsP90: report.skimSummary?.general?.wordsP90 ?? null,
      fitsShare: report.skimSummary?.general?.fitsShare ?? null,
      tradeoffShare: report.skimSummary?.general?.tradeoffShare ?? null,
    };
  };
  const [A, B] = [entry(a), entry(b)];
  const disqualified = (x) => x.errors > 0 || (x.p50 != null && x.p50 > gate.p50) || (x.p95 != null && x.p95 > gate.p95);
  const reasons = [];
  const dead = { [A.label]: disqualified(A), [B.label]: disqualified(B) };
  for (const x of [A, B]) {
    if (x.errors > 0) reasons.push(`${x.label}: ${x.errors} errors — disqualified`);
    else if (dead[x.label]) reasons.push(`${x.label}: latency gate ${gate.p50}/${gate.p95} ms exceeded (p50 ${x.p50}, p95 ${x.p95}) — disqualified`);
  }
  let winner = "tie";
  if (dead[A.label] !== dead[B.label]) {
    winner = dead[A.label] ? B.label : A.label;
    reasons.push(`${winner}: wins by disqualification`);
  } else if (!dead[A.label]) {
    const quality = (x, y) => {
      if (x.rubric != null && y.rubric != null) return x.rubric - y.rubric >= 0.5 && x.correctness >= y.correctness ? 1 : y.rubric - x.rubric >= 0.5 && y.correctness >= x.correctness ? -1 : 0;
      const dx = (x.coverage ?? 0) - (y.coverage ?? 0);
      return dx >= 0.05 ? 1 : dx <= -0.05 ? -1 : 0;
    };
    const q = quality(A, B);
    if (q !== 0) {
      winner = q > 0 ? A.label : B.label;
      reasons.push(`${winner}: wins on quality (rubric ${A.rubric ?? "-"} vs ${B.rubric ?? "-"}, coverage ${A.coverage ?? "-"} vs ${B.coverage ?? "-"})`);
    } else if (A.p50 != null && B.p50 != null && A.p50 !== B.p50) {
      winner = A.p50 < B.p50 ? A.label : B.label;
      reasons.push(`${winner}: quality within margin; wins on latency (p50 ${A.p50} vs ${B.p50})`);
    } else {
      reasons.push("quality within margin and latency indistinguishable");
    }
  }
  const metrics = ["coverage", "rubric", "correctness", "p50", "p95", "errors"];
  if (A.wordsP90 != null || B.wordsP90 != null) metrics.push("wordsP90");
  if (A.fitsShare != null || B.fitsShare != null) metrics.push("fitsShare");
  if (A.tradeoffShare != null || B.tradeoffShare != null) metrics.push("tradeoffShare");
  const rows = metrics.map((metric) => ({ metric, [A.label]: A[metric], [B.label]: B[metric] }));
  return { rows, verdict: { winner, reasons } };
}
