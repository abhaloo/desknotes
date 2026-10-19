/**
 * Practice view-model strings (pure, DOM-free so bun can test them).
 * The block layout is decided by us, not by the model: a bold question
 * header, one detection line (explainability), and prose underneath.
 */
export function answerBlockView(entry = {}) {
  const status = entry.status ?? "streaming";
  return {
    header: `Question: ${entry.question ?? ""}`,
    meta: `Detected: ${entry.evidence?.reason ?? "unknown"} · ${status}`,
    body: entry.answer ?? "",
  };
}

export function materialStatusView(material, readError) {
  if (readError) return readError;
  if (!material?.problemStatement) return "No problem statement yet. Paste one before you start.";
  return `${material.problemStatement.length.toLocaleString("en-US")} characters saved.`;
}

export function sessionSummaryView(snapshot) {
  if (!snapshot) return "No practice session yet.";
  const state = snapshot.active ? "Practice running" : "Practice ended";
  return `${state} since ${snapshot.startedAt} · ${snapshot.questions} questions · ${snapshot.skipped} skipped`;
}
