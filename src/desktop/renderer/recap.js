/**
 * Recap window renderer. The window shows ONE session: its id comes from the
 * query string (recap.html?id=...), the recap from recap:get, the only
 * channel this page may call. Everything is painted with text nodes: model
 * text and transcript text are assigned through textContent only and never
 * parsed as markup (no markdown, nothing to sanitize).
 */
import { IPC } from "../ipc-gateway.js";
import { gapRows, questionRows, recapHeaderView, termRows, timelineRows } from "./recap-view.js";

const bridge = window.copilot ?? null;
const CH = bridge?.channels ?? IPC;
const el = (id) => document.getElementById(id);
const els = {
  title: el("recap-title"),
  meta: el("recap-meta"),
  notes: el("recap-notes"),
  status: el("recap-status"),
  body: el("recap-body"),
  timeline: el("recap-timeline"),
  questions: el("recap-questions"),
  gaps: el("recap-gaps"),
  terms: el("recap-terms"),
};

const EMPTY = Object.freeze({
  questions: "No questions were detected.",
  gaps: "No gaps.",
  terms: "No terms were explained.",
});

/** An error stands alone: the sections show only once a recap painted. */
function setStatus(message) {
  if (els.status) {
    els.status.textContent = message ?? "";
    els.status.hidden = !message;
  }
  if (els.body) els.body.hidden = Boolean(message);
}

function span(className, text) {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

/** One timeline row: [offset] label: text, tagged with its type and role for styling. */
function createRow(row) {
  const node = document.createElement("div");
  node.className = "recap-row";
  node.dataset.type = row.type;
  node.dataset.role = row.role;
  node.append(span("recap-offset", row.offset), span("recap-label", row.label), span("recap-text", row.text));
  return node;
}

function createItem(row) {
  const node = document.createElement("div");
  node.className = "recap-item";
  node.append(span("recap-offset", row.offset), span("recap-text", row.text));
  return node;
}

function paintList(container, rows, empty) {
  if (!container) return;
  if (rows.length === 0) {
    container.textContent = empty;
    return;
  }
  container.replaceChildren(...rows.map(createItem));
}

function paint(recap) {
  const header = recapHeaderView(recap);
  if (els.title) els.title.textContent = header.title;
  if (els.meta) els.meta.textContent = header.meta;
  if (els.notes) {
    els.notes.replaceChildren(
      ...header.notes.map((note) => {
        const node = document.createElement("p");
        node.className = "recap-note";
        node.textContent = note;
        return node;
      }),
    );
    els.notes.hidden = header.notes.length === 0;
  }
  const rows = timelineRows(recap);
  if (els.timeline) {
    if (rows.length === 0) els.timeline.textContent = "Nothing was said.";
    else els.timeline.replaceChildren(...rows.map(createRow));
  }
  paintList(els.questions, questionRows(recap), EMPTY.questions);
  paintList(els.gaps, gapRows(recap), EMPTY.gaps);
  paintList(els.terms, termRows(recap), EMPTY.terms);
  setStatus("");
}

function errorMessage(error) {
  if (error?.code === "E_RECAP_NOT_FOUND") return "This session recap no longer exists.";
  return error?.message ?? String(error ?? "Couldn't load the session recap.");
}

async function hydrate() {
  const id = new URLSearchParams(window.location.search).get("id");
  if (!id) {
    setStatus("No session selected.");
    return;
  }
  if (!bridge) {
    setStatus("Desktop bridge unavailable (open inside the shell)");
    return;
  }
  try {
    const result = await bridge.request(CH.RECAP_GET, { id });
    if (!result?.recap) {
      setStatus("This session recap no longer exists.");
      return;
    }
    paint(result.recap);
  } catch (error) {
    setStatus(errorMessage(error));
  }
}

hydrate();
