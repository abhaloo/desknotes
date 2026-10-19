/**
 * Practice session: final transcript utterances in, one streamed answer per
 * detected question out (design: 2026-10-15-practice-mode-design.md).
 *
 * This is a rehearsal tool, not live assistance: the session exists only
 * between explicit start/end calls (main enforces that), and it answers each
 * question ONCE, after the question was actually asked — there is no
 * prefetch and no speculation. Answers are study material for the debrief.
 *
 * Everything is injected (segmenter, streamAnswer, clock, events) so the
 * whole lifecycle tests without a network, a judge or Electron.
 */
export function buildPracticeContext({ problemStatement, docsName, docsText } = {}) {
  return [
    problemStatement && `PRACTICE PROBLEM STATEMENT:\n${problemStatement}`,
    docsText && `DOCUMENTS:\n${docsName ? `File: ${docsName}\n\n` : ""}${docsText}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {{ material: {problemStatement: string, docsName?: string|null, docsText?: string},
 *   segmenter: {consider: Function}, streamAnswer: (args: object) => AsyncIterable<string>,
 *   onEvent?: (event: object) => void, now?: () => number}} options
 */
export function createPracticeSession({
  material = {},
  segmenter,
  streamAnswer,
  onEvent = () => {},
  now = Date.now,
} = {}) {
  let active = false;
  let record = null;
  let lastText = "";
  let seq = 0;
  const inflight = new Map(); // question id -> AbortController

  function emit(event) {
    try {
      onEvent(event);
    } catch {
      /* a broken listener must not kill the session */
    }
  }

  function start() {
    if (active) return false;
    active = true;
    lastText = "";
    record = {
      startedAt: iso(now()),
      endedAt: null,
      material: {
        problemStatement: String(material.problemStatement ?? ""),
        docsName: material.docsName ?? null,
      },
      questions: [],
      skipped: [],
    };
    return true;
  }

  async function onUtterance(utterance = {}) {
    if (!active) return null;
    const text = String(utterance.text ?? "").trim();
    // Only committed text is segmented (the debrief quotes it), never our own
    // coach-lane re-renders, never an ASR re-delivery of the previous final.
    if (!text || !utterance.final || utterance.source === "agent" || text === lastText) return null;
    lastText = text;
    const at = iso(now());
    const evidence = await segmenter.consider({ text, at });
    if (!active) return null; // the session ended while the judge was deciding
    if (evidence.band !== "question") {
      const skipped = { text, evidence, at };
      record.skipped.push(skipped);
      emit({ type: "skipped", ...skipped });
      return null;
    }
    const id = `q_${++seq}`;
    const entry = {
      id,
      question: text,
      evidence,
      utterance: { text, at },
      answer: "",
      status: "streaming",
      startedAt: iso(now()),
      endedAt: null,
    };
    record.questions.push(entry);
    emit({ type: "question", id, question: text, evidence, at });
    void generate(entry); // answers stream concurrently; end() cuts them
    return entry;
  }

  async function generate(entry) {
    const controller = new AbortController();
    inflight.set(entry.id, controller);
    emit({ type: "answer-start", id: entry.id });
    try {
      const stream = streamAnswer({
        question: entry.question,
        context: buildPracticeContext({
          problemStatement: record.material.problemStatement,
          docsName: material.docsName ?? null,
          docsText: material.docsText ?? "",
        }),
        intent: "practice",
        // The technical prompt mode (answerer.js); main adds cards: true (the technical card prompt) and highlights: true when those settings are on.
        mode: "technical",
        signal: controller.signal,
      });
      for await (const delta of stream) {
        // end() aborts; stop consuming even if the producer ignores the signal.
        if (controller.signal.aborted) break;
        if (typeof delta !== "string" || delta.length === 0) continue;
        entry.answer += delta;
        emit({ type: "answer-delta", id: entry.id, delta });
      }
      entry.status = controller.signal.aborted ? "cut" : "done";
    } catch (error) {
      // An abort-triggered throw is a cut, not a failure: end() already
      // decided this entry's fate and the returned record must stay honest.
      if (controller.signal.aborted) {
        entry.status = "cut";
      } else {
        entry.status = "failed";
        emit({ type: "answer-failed", id: entry.id, message: String(error?.message ?? error) });
      }
    } finally {
      inflight.delete(entry.id);
      entry.endedAt = iso(now());
      // No events after end(): a cut stream settles silently — the partial
      // answer lives on the record entry the debrief reads, not on a late event.
      if (!controller.signal.aborted && entry.status !== "failed") {
        emit({ type: "answer-done", id: entry.id, text: entry.answer });
      }
    }
  }

  function end() {
    if (!active) return null;
    active = false;
    for (const controller of inflight.values()) controller.abort();
    for (const entry of record.questions) {
      if (entry.status === "streaming") entry.status = "cut";
    }
    record.endedAt = iso(now());
    return record;
  }

  return {
    start,
    onUtterance,
    end,
    isActive: () => active,
    record: () => record,
  };
}

/** @typedef {{ id, question, evidence: SegmentDecision, utterance: {text, at},
 *   answer: string, status: "streaming"|"done"|"failed"|"cut",
 *   startedAt: string, endedAt: string|null }} PracticeQuestionEntry */
/** @typedef {{ startedAt: string, endedAt: string|null,
 *   material: { problemStatement: string, docsName: string|null },
 *   questions: PracticeQuestionEntry[],
 *   skipped: Array<{ text, evidence: SegmentDecision, at: string }> }} PracticeSessionRecord */
/** PracticeEvent = { type: "question", id, question, evidence, at }
 *   | { type: "answer-start", id } | { type: "answer-delta", id, delta }
 *   | { type: "answer-done", id, text } | { type: "answer-failed", id, message }
 *   | { type: "skipped", text, evidence, at } */
