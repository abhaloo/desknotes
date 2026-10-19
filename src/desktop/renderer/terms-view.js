/**
 * Terms block under the answer.
 *
 * The server explains up to three terms of a finished card in a `terms`
 * frame (src/server/engines/glossary.js). The block shows them for the turn
 * on screen only: it empties when the next turn starts or on Clear, and a
 * late frame for an older turn is ignored. It is painted only from a `terms`
 * frame, through the frame scheduler (app.js), so token painting never
 * touches it.
 *
 * Pure, like answer-buffer.js and stream-paint.js: DOM access goes through an
 * injected factory so it tests under bun without a DOM. Model text is only
 * ever appended as text nodes, never parsed as HTML. No tooltips: they can
 * show on a shared screen.
 */

/** Entries under one card; keep in step with glossary.js GLOSSARY_LIMITS.terms (a test compares them). */
export const TERMS_MAX = 3;

/** styles.css `.answer-terms` parts. */
export const TERM_CLASS = "term";
export const TERM_NAME_CLASS = "term-name";
export const TERM_FULL_CLASS = "term-full";
export const TERM_WHAT_CLASS = "term-what";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A frame's `terms` as the block shows them: `{term, fullName, what}` with
 * strings only, an entry without a term or an explanation dropped, at most
 * TERMS_MAX.
 */
export function normalizeTerms(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (out.length >= TERMS_MAX) break;
    if (!item || typeof item !== "object") continue;
    const term = text(item.term);
    const what = text(item.what);
    if (!term || !what) continue;
    out.push({ term, fullName: text(item.full_name), what });
  }
  return out;
}

const sameEntries = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Which turn the block belongs to, and its entries. */
export class TermsState {
  #turnId = null;
  #entries = [];

  get entries() {
    return this.#entries;
  }

  get turnId() {
    return this.#turnId;
  }

  /** `turn.started`: a new card's block is empty until its terms arrive. True when the block changed. */
  start(turnId) {
    const id = typeof turnId === "string" && turnId ? turnId : null;
    if (id !== null && id === this.#turnId) return false;
    const changed = this.#entries.length > 0;
    this.#turnId = id;
    this.#entries = [];
    return changed;
  }

  /**
   * A `terms` frame, kept only for the turn on screen (the one this block
   * started for, or `activeId`, the answer showing now). True when the block
   * changed.
   */
  apply(data = {}, activeId = null) {
    const id = typeof data?.turn_id === "string" && data.turn_id ? data.turn_id : null;
    if (!id || (id !== this.#turnId && id !== activeId)) return false;
    this.#turnId = id;
    const entries = normalizeTerms(data.terms);
    if (sameEntries(entries, this.#entries)) return false;
    this.#entries = entries;
    return true;
  }

  /** Clear: the block empties with the card. True when the block changed. */
  clear() {
    const changed = this.#entries.length > 0;
    this.#turnId = null;
    this.#entries = [];
    return changed;
  }
}

function defaultPart(node, className) {
  const doc = node?.ownerDocument ?? globalThis.document;
  const part = doc.createElement(className === TERM_CLASS ? "div" : "span");
  part.className = className;
  return part;
}

/**
 * One line per entry: "TERM (Full Name): what it is and does". The node is
 * hidden while there are no entries, so the block takes no space.
 */
export class TermsPainter {
  constructor(node, { createPart } = {}) {
    this.node = node;
    this.createPart = typeof createPart === "function" ? createPart : (className) => defaultPart(node, className);
    this.key = null;
  }

  paint(entries = []) {
    const node = this.node;
    if (!node) return;
    const key = JSON.stringify(entries);
    if (key === this.key) return;
    this.key = key;
    node.replaceChildren(...entries.map((entry) => this.#line(entry)));
    node.hidden = entries.length === 0;
  }

  #line(entry) {
    const line = this.createPart(TERM_CLASS);
    const name = this.createPart(TERM_NAME_CLASS);
    name.append(entry.term);
    line.append(name);
    if (entry.fullName) {
      const full = this.createPart(TERM_FULL_CLASS);
      full.append(` (${entry.fullName})`);
      line.append(full);
    }
    const what = this.createPart(TERM_WHAT_CLASS);
    what.append(`: ${entry.what}`);
    line.append(what);
    return line;
  }
}
