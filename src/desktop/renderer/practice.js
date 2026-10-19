/**
 * Practice window renderer. Answers are READ here, not spoken: each detected
 * question renders as one block — bold "Question: …" header, detection line
 * (why this got an answer), then the answer prose. Model text is only ever
 * assigned via textContent; the block structure is built by us, never parsed
 * out of the answer (no markdown, no innerHTML, nothing to sanitize).
 */
import { IPC } from "../ipc-gateway.js";
import { AnswerPainter, createFrameScheduler } from "./stream-paint.js";
import { answerBlockView, materialStatusView, sessionSummaryView } from "./practice-view.js";

const bridge = window.copilot ?? null;
const CH = bridge?.channels ?? IPC;
const el = (id) => document.getElementById(id);
const els = {
  materialStatus: el("material-status"),
  materialText: el("material-text"),
  materialSave: el("material-save"),
  practiceStart: el("practice-start"),
  practiceEnd: el("practice-end"),
  sessionSummary: el("session-summary"),
  answerBlocks: el("answer-blocks"),
  debriefStatus: el("debrief-status"),
  debriefText: el("debrief-text"),
  toast: el("toast"),
};

const frames = createFrameScheduler();
const blocks = new Map(); // question id -> { root, metaNode, proseNode, painter, text, final }
const entries = new Map(); // question id -> entry (for repaints)
let active = false;

function showToast(message, kind = "error", ttlMs = 4000) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.dataset.kind = kind;
  els.toast.hidden = false;
  setTimeout(() => {
    els.toast.hidden = true;
  }, ttlMs);
}

function createBlock(entry) {
  const view = answerBlockView(entry);
  const root = document.createElement("article");
  root.className = "practice-answer";
  const header = document.createElement("strong");
  header.className = "practice-question";
  header.textContent = view.header; // textContent only, always
  const meta = document.createElement("p");
  meta.className = "practice-meta";
  meta.textContent = view.meta;
  const prose = document.createElement("div");
  prose.className = "practice-prose";
  root.append(header, meta, prose);
  els.answerBlocks?.append(root);
  const block = {
    root,
    metaNode: meta,
    proseNode: prose,
    painter: new AnswerPainter(prose, { placeholder: "…" }),
    text: "",
    final: false,
  };
  schedulePaint(entry.id, block);
  return block;
}

/**
 * Streaming paint, coalesced per frame. A paint still queued when the answer
 * finalizes must not run: it would append the last delta again after the
 * paragraphs replaced the streamed text.
 */
function schedulePaint(id, block) {
  frames.request(`block:${id}`, () => {
    if (!block.final) block.painter.paint({ id, text: block.text });
  });
}

/** One bounded reflow when the answer ends: prose becomes real paragraphs. */
function finalizeProse(block, status) {
  if (block.final) return;
  block.final = true;
  const paragraphs = String(block.text || "(no answer)").split(/\n{2,}/);
  block.proseNode.replaceChildren(
    ...paragraphs.map((text) => {
      const node = document.createElement("p");
      node.textContent = text;
      return node;
    }),
  );
  block.metaNode.textContent = block.metaNode.textContent.replace(/·\s\w+$/, `· ${status}`);
}

function onPracticeEvent(event = {}) {
  switch (event.type) {
    case "question": {
      const entry = { id: event.id, question: event.question, evidence: event.evidence, answer: "", status: "streaming" };
      entries.set(entry.id, entry);
      blocks.set(entry.id, createBlock(entry));
      break;
    }
    case "answer-delta": {
      const block = blocks.get(event.id);
      const entry = entries.get(event.id);
      if (!block || !entry) return;
      if (block.final) return;
      entry.answer += event.delta;
      block.text = entry.answer;
      schedulePaint(event.id, block);
      break;
    }
    case "answer-done": {
      const block = blocks.get(event.id);
      if (!block) return;
      // The done event carries the whole answer: it is the authority.
      if (typeof event.text === "string") block.text = event.text;
      finalizeProse(block, "done");
      break;
    }
    case "answer-failed": {
      const block = blocks.get(event.id);
      if (block) finalizeProse(block, "failed");
      showToast(event.message ?? "answer failed", "error");
      break;
    }
    case "skipped":
      return; // small talk: nothing renders (it is in the debrief's detection log)
    case "ended": {
      active = false;
      renderControls();
      // End cuts in-flight answers and the session sends no further event for
      // them: settle every block still streaming here, from what arrived.
      for (const block of blocks.values()) finalizeProse(block, "cut");
      if (els.debriefText && event.debrief?.text) {
        els.debriefText.textContent = event.debrief.text; // exactly the saved document
        els.debriefText.hidden = false;
      }
      if (els.debriefStatus) {
        els.debriefStatus.textContent = event.saveError
          ? `Debrief shown but not saved: ${event.saveError}`
          : `Debrief saved at ${event.debrief?.savedAt ?? "unknown"}.`;
      }
      break;
    }
    default:
      return;
  }
}

function renderControls() {
  if (els.practiceStart) els.practiceStart.disabled = active;
  if (els.practiceEnd) els.practiceEnd.disabled = !active;
}

async function call(command, payload = null) {
  if (!bridge) {
    showToast("Desktop bridge unavailable (open inside the shell)");
    return null;
  }
  try {
    return await bridge.command(command, payload);
  } catch (error) {
    showToast(error?.message ?? String(error));
    return null;
  }
}

async function hydrate() {
  if (!bridge) return;
  try {
    const state = await bridge.request(CH.PRACTICE_GET);
    if (els.materialText && state?.material?.problemStatement) {
      els.materialText.value = state.material.problemStatement;
    }
    if (els.materialStatus) els.materialStatus.textContent = materialStatusView(state?.material, state?.materialReadError);
    if (els.sessionSummary) els.sessionSummary.textContent = sessionSummaryView(state?.session);
    active = Boolean(state?.session?.active);
    renderControls();
    if (state?.debrief?.text && els.debriefText) {
      els.debriefText.textContent = state.debrief.text;
      els.debriefText.hidden = false;
      if (els.debriefStatus) els.debriefStatus.textContent = `Debrief saved at ${state.debrief.savedAt}.`;
    }
    if (state?.debriefReadError && els.debriefStatus) els.debriefStatus.textContent = state.debriefReadError;
  } catch (error) {
    showToast(error?.message ?? String(error));
  }
}

els.materialSave?.addEventListener("click", async () => {
  const result = await call(CH.PRACTICE_SET_MATERIAL, { problemStatement: els.materialText?.value ?? "" });
  if (!result) return;
  if (els.materialStatus) els.materialStatus.textContent = materialStatusView(result.material, null);
});

els.practiceStart?.addEventListener("click", async () => {
  const result = await call(CH.PRACTICE_START);
  if (!result) return;
  active = true;
  renderControls();
  // A new session starts on a clean page: question ids restart per session.
  blocks.clear();
  entries.clear();
  els.answerBlocks?.replaceChildren();
  if (els.sessionSummary) els.sessionSummary.textContent = sessionSummaryView({ active: true, startedAt: result.startedAt, questions: 0, skipped: 0 });
  if (els.debriefText) els.debriefText.hidden = true;
  if (els.debriefStatus) els.debriefStatus.textContent = "The debrief is written when you end the practice session.";
});

els.practiceEnd?.addEventListener("click", async () => {
  const result = await call(CH.PRACTICE_END);
  if (!result) return; // the "ended" event paints the debrief
});

bridge?.on(CH.PRACTICE_EVENT, onPracticeEvent);
hydrate();
