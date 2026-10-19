/**
 * Debrief builder (pure). The debrief reports what happened — which
 * utterances asked what, which answers landed, what was covered and what is
 * missing. It never grades the user and never invents topics: "covered"
 * quotes each answer's own opening sentence, "gaps" lists the mechanical
 * holes (maybe-questions unanswered, failed or cut answers, no questions).
 */
export function firstSentence(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const match = clean.match(/^(.+?[.!?])(\s|$)/);
  return match ? match[1] : clean;
}

/** @param {import("./session.js").PracticeSessionRecord} record */
export function buildDebrief(record = {}, { now = () => new Date() } = {}) {
  const questions = (record.questions ?? []).map((entry) => ({
    question: entry.question,
    evidence: entry.evidence,
    answer: entry.answer,
    status: entry.status,
    gist: firstSentence(entry.answer) || "no answer recorded",
  }));
  const covered = questions
    .filter((q) => q.status === "done" && q.answer)
    .map((q) => `${q.question} — ${q.gist}`);
  const gaps = [];
  for (const entry of record.skipped ?? []) {
    if (entry.evidence?.band === "maybe") {
      gaps.push(`Maybe a question (${entry.evidence.reason}): "${entry.text}" — not answered.`);
    }
  }
  for (const q of questions) {
    if (q.status === "failed") gaps.push(`Answer failed for "${q.question}".`);
    else if (q.status === "cut") gaps.push(`Answer cut off when the session ended: "${q.question}".`);
  }
  if (questions.length === 0) gaps.push("No questions were detected in this session — nothing was answered.");
  // The detection log: every segmented utterance in time order, so the
  // debrief can answer "which utterance triggered which answer" exactly.
  const detectionLog = [
    ...(record.questions ?? []).map((entry) => ({
      at: entry.utterance?.at ?? entry.startedAt,
      text: entry.utterance?.text ?? entry.question,
      band: entry.evidence?.band ?? "question",
      reason: entry.evidence?.reason ?? "unknown",
    })),
    ...(record.skipped ?? []).map((entry) => ({
      at: entry.at,
      text: entry.text,
      band: entry.evidence?.band ?? "small-talk",
      reason: entry.evidence?.reason ?? "unknown",
    })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    title: `Practice session — ${record.startedAt ?? ""}`,
    savedAt: now().toISOString(),
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    problemStatement: record.material?.problemStatement ?? "",
    questions,
    covered,
    gaps,
    detectionLog,
    stats: {
      questions: questions.length,
      answered: questions.filter((q) => q.status === "done").length,
      skipped: (record.skipped ?? []).length,
      maybe: (record.skipped ?? []).filter((e) => e.evidence?.band === "maybe").length,
    },
  };
}

/** The readable document. This exact text is what the store saves. */
export function formatDebrief(debrief) {
  const lines = [debrief.title, ""];
  lines.push("Practice rehearsal only. These answers are study material, not live assistance.", "");
  lines.push("Problem statement", "-----------------");
  lines.push(debrief.problemStatement || "(none supplied)", "");
  lines.push("Questions and answers", "---------------------");
  debrief.questions.forEach((q, index) => {
    lines.push(`${index + 1}. Question: ${q.question}`);
    lines.push(`   Detected: ${q.evidence?.reason ?? "unknown"} [${q.evidence?.source ?? "unknown"}]`);
    lines.push("");
    for (const paragraph of String(q.answer || "(no answer)").split(/\n{2,}/)) lines.push(paragraph, "");
    lines.push(`   Status: ${q.status}`, "");
  });
  lines.push("What was covered", "----------------");
  for (const line of debrief.covered.length ? debrief.covered : ["(nothing)"]) lines.push(`- ${line}`);
  lines.push("", "Gaps", "----");
  for (const line of debrief.gaps.length ? debrief.gaps : ["(none)"]) lines.push(`- ${line}`);
  lines.push("", "Detection log", "-------------");
  for (const entry of debrief.detectionLog ?? []) {
    lines.push(`${String(entry.band).padEnd(6)} ${String(entry.reason).padEnd(28)} "${entry.text}"`);
  }
  return lines.join("\n");
}
