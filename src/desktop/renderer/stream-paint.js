/**
 * Incremental painters for the overlay (F11).
 *
 * The answer card used to reassign `textContent` with the WHOLE answer on
 * every token, then read `scrollHeight` (a forced layout) right after the
 * write. The transcript lanes rebuilt up to 60 line nodes on every interim
 * transcript. Both costs grow with the length of the answer or the call, and
 * they compete with token arrival on the renderer thread.
 *
 * Now a token is appended as a text node, a lane only appends new final lines
 * and updates its one interim node, and all painting (plus the single scroll
 * read) is coalesced to one pass per animation frame. A token that arrives
 * mid-frame is painted on that frame, with no added delay.
 *
 * DOM access goes through tiny injected factories so the logic is testable
 * under bun without a DOM. Answer text is only ever appended as text nodes
 * (and `**` key phrases and `inline code` as spans built with createElement):
 * model output is never parsed as HTML.
 */

/**
 * Coalesce paint requests per key into one callback per animation frame.
 * @param {(cb: Function) => any} [schedule] requestAnimationFrame (or a test double)
 */
export function createFrameScheduler(schedule = globalThis.requestAnimationFrame?.bind(globalThis)) {
  const pending = new Map();
  let queued = false;
  const flush = () => {
    queued = false;
    const jobs = [...pending.values()];
    pending.clear();
    for (const job of jobs) {
      try {
        job();
      } catch {
        /* one bad painter must not stop the others */
      }
    }
  };
  return {
    request(key, job) {
      pending.set(key, job);
      if (queued) return;
      queued = true;
      if (typeof schedule === "function") schedule(flush);
      else queueMicrotask(flush);
    },
    flush,
  };
}

/** The key-phrase class (styles.css `.answer-text .hl`). */
export const HIGHLIGHT_CLASS = "hl";
export const LINE_CLASS = "ln";
export const LABEL_CLASS = "lbl";
export const BULLET_CLASS = "blt";
export const HEAD_CLASS = "head";
export const LABELLED_CLASS = "lab";
export const CODE_CLASS = "code";
export const FENCE_CLASS = "fence";
/** `inline code` on a prose line (styles.css `.answer-text .ic`); its backticks are not shown. */
export const INLINE_CODE_CLASS = "ic";
/** Keep in step with src/shared/answer-cards.js CARD_LABEL (test/answer-cards-render.test.js compares them). */
export const CARD_LABEL = /^(\s*(?:•\s*|-\s+)?)([A-Z][A-Z0-9&/'-]+(?: [A-Z0-9&/'-]+)*(?: \([^)\n]{1,40}\))?):\s+([\s\S]*)$/;
/**
 * A label's colon must come within this many characters of the line start.
 * Only the label is bounded: the rest of the line may be any length, and may
 * arrive in one chunk (the card stream sends its first line whole).
 */
const LABEL_WINDOW = 64;
const VERDICT = "VERDICT";

export class AnswerPainter {
  constructor(node, { placeholder = "", createHighlight, createPart } = {}) {
    this.node = node;
    this.placeholder = placeholder;
    this.createPart = typeof createPart === "function" ? createPart : (className) => defaultPart(node, className);
    this.createHighlight = typeof createHighlight === "function" ? createHighlight : () => this.createPart(HIGHLIGHT_CLASS);
    this.id = null;
    this.text = null;
    this.fullPaints = 0;
    this.appends = 0;
    this.#reset();
  }

  #reset() {
    this.line = null; // the current line element
    this.lineRaw = ""; // its text so far
    this.lineIndex = -1;
    this.decided = false; // its label or code treatment is decided
    this.fence = false; // it is a ``` line
    this.inCode = false; // inside a fenced block
    this.target = null; // where text goes now: the line, its open highlight, or open inline code
    this.codeParent = null; // inside inline code: where text goes after the closing backtick
    this.heldStar = false; // the painted text ends in one star not shown yet
  }

  paint(active) {
    const node = this.node;
    if (!node) return;
    const text = active?.text ?? "";
    const id = active?.id ?? null;
    const final = active?.done === true;
    if (id !== null && id === this.id && this.text !== null && this.text !== "" && text.startsWith(this.text)) {
      const delta = text.slice(this.text.length);
      // A held star is shown once the answer is done, even with no new text.
      if ((delta || (final && this.heldStar)) && this.#write(delta, final)) this.appends += 1;
    } else if (id !== this.id || text !== this.text) {
      // A started answer with no words yet stays empty: the loading line shows there.
      this.#reset();
      node.textContent = text || active ? "" : this.placeholder; // (text || active) ? "" : placeholder
      if (text) this.#write(text, final);
      this.fullPaints += 1;
    }
    this.id = id;
    this.text = text;
  }

  /** Paint `chunk` after what is already there; true when something was added. */
  #write(chunk, final) {
    if (!chunk) return this.line && this.heldStar ? this.#tokens("", true, final) : false;
    let wrote = false;
    let source = chunk;
    while (source) {
      if (!this.line) this.#openLine();
      const nl = source.indexOf("\n");
      const body = nl < 0 ? source : source.slice(0, nl);
      source = nl < 0 ? "" : source.slice(nl + 1);
      if (body || this.heldStar) wrote = this.#append(body, nl < 0, final) || wrote;
      if (nl >= 0) {
        this.#closeLine();
        wrote = true;
      }
    }
    return wrote;
  }

  #openLine() {
    this.lineIndex += 1;
    this.line = this.createPart(this.inCode ? `${LINE_CLASS} ${CODE_CLASS}` : LINE_CLASS);
    this.node.append(this.line);
    this.lineRaw = "";
    this.decided = false;
    this.fence = false;
    this.target = this.line;
    this.codeParent = null; // an unclosed backtick ends with its line
  }

  #closeLine() {
    if (this.heldStar) this.#tokens("", false, false);
    this.line.append("\n"); // the break belongs to the line: a hidden fence hides it too
    if (this.fence) this.inCode = !this.inCode;
    this.line = null;
    this.target = null;
  }

  #append(body, atEnd, final) {
    this.lineRaw += body;
    if (!this.decided && this.#decide(atEnd, final)) return true; // rebuilt with the body in it
    // A line that may still become a fence keeps its backticks as text, not inline code.
    if (this.inCode || this.fence || (!this.decided && /^`{1,2}$/.test(this.lineRaw))) {
      if (body) this.line.append(body);
      return Boolean(body);
    }
    return this.#tokens(body, atEnd, final);
  }

  /** Decide the line's treatment; true when it was rebuilt (the body is already painted). */
  #decide(atEnd, final) {
    const raw = this.lineRaw;
    if (raw.startsWith("```")) {
      this.fence = true;
      this.decided = true;
      this.line.className = `${LINE_CLASS} ${FENCE_CLASS}`;
      return false;
    }
    if (/^`{1,2}$/.test(raw)) return false; // maybe a fence: wait for the third backtick
    if (this.inCode) {
      this.decided = true;
      return false;
    }
    const colon = raw.indexOf(":");
    if (colon >= 0 && colon <= LABEL_WINDOW) {
      if (raw.length === colon + 1) return false; // the space after the colon decides it
      this.decided = true;
      const label = CARD_LABEL.exec(raw);
      if (!label) return false;
      this.#relabel(label, atEnd, final);
      return true;
    }
    if (raw.length > LABEL_WINDOW) this.decided = true;
    return false;
  }

  /** Rebuild the line as [bullet] LABEL: rest, keeping its text exactly. */
  #relabel([, bullet, label, rest], atEnd, final) {
    const line = this.line;
    line.textContent = "";
    const head = this.lineIndex === 0 && label.toUpperCase() === VERDICT;
    line.className = `${LINE_CLASS} ${LABELLED_CLASS}${head ? ` ${HEAD_CLASS}` : ""}`;
    if (bullet) {
      const mark = this.createPart(BULLET_CLASS);
      mark.append(bullet);
      line.append(mark);
    }
    // The space after the colon belongs to the tag, so a hidden VERDICT tag
    // leaves no leading space on the headline.
    const gap = this.lineRaw.slice(bullet.length + label.length + 1, this.lineRaw.length - rest.length);
    const tag = this.createPart(LABEL_CLASS);
    tag.append(`${label}:${gap}`);
    line.append(tag);
    this.target = line;
    this.codeParent = null;
    this.heldStar = false;
    if (rest) this.#tokens(rest, atEnd, final);
  }

  /**
   * The `**` and backtick tokenizer, writing into the current line. A `**`
   * opens or closes a key phrase; a backtick opens or closes inline code, in
   * which stars are text.
   */
  #tokens(chunk, atEnd, final) {
    const source = this.heldStar ? `*${chunk}` : chunk;
    this.heldStar = false;
    let wrote = false;
    let plain = "";
    const flush = () => {
      if (!plain) return;
      this.target.append(plain);
      plain = "";
      wrote = true;
    };
    let i = 0;
    while (i < source.length) {
      const tick = source.indexOf("`", i);
      const star = this.codeParent ? -1 : source.indexOf("*", i);
      if (tick >= 0 && (star < 0 || tick < star)) {
        plain += source.slice(i, tick);
        flush();
        if (this.codeParent) {
          this.target = this.codeParent;
          this.codeParent = null;
        } else {
          const span = this.createPart(INLINE_CODE_CLASS);
          this.target.append(span);
          this.codeParent = this.target;
          this.target = span;
        }
        wrote = true;
        i = tick + 1;
        continue;
      }
      if (star < 0) {
        plain += source.slice(i);
        break;
      }
      plain += source.slice(i, star);
      let end = star + 1;
      while (source[end] === "*") end += 1;
      if (end - star === 1) {
        if (end === source.length && atEnd && !final) {
          this.heldStar = true; // maybe half of a marker: wait for the next delta
          break;
        }
        plain += "*";
      } else {
        flush();
        if (this.target === this.line) {
          const span = this.createHighlight();
          this.line.append(span);
          this.target = span;
          wrote = true;
        } else {
          this.target = this.line;
        }
      }
      i = end;
    }
    flush();
    return wrote;
  }
}

function defaultPart(node, className) {
  const doc = node?.ownerDocument ?? globalThis.document;
  const span = doc.createElement("span");
  span.className = className;
  return span;
}

/**
 * Transcript lane: final lines are immutable once rendered, so only new ones
 * are appended (and lines trimmed from the head are removed); the single
 * interim line is updated in place.
 */
export class LanePainter {
  /**
   * @param {object} container DOM element
   * @param {(text: string, interim: boolean) => object} createLine node factory
   */
  constructor(container, createLine) {
    this.container = container;
    this.createLine = createLine;
    this.rendered = []; // final entries, same object refs as TranscriptLanes
    this.lineNodes = [];
    this.interimNode = null;
    this.rebuilds = 0;
    this.initialized = false;
  }

  paint(lines, interim) {
    const container = this.container;
    if (!container) return;
    if (!this.#reuse(lines)) this.#rebuild(lines);
    else {
      for (let i = this.rendered.length; i < lines.length; i += 1) {
        const node = this.createLine(lines[i].text, false);
        if (this.interimNode) container.insertBefore(node, this.interimNode);
        else container.append(node);
        this.lineNodes.push(node);
        this.rendered.push(lines[i]);
      }
    }
    if (interim) {
      if (!this.interimNode) {
        this.interimNode = this.createLine(interim.text, true);
        container.append(this.interimNode);
      } else if (this.interimNode.textContent !== interim.text) {
        this.interimNode.textContent = interim.text;
      }
    } else if (this.interimNode) {
      this.interimNode.remove();
      this.interimNode = null;
    }
  }

  /** True when the rendered lines are a (possibly head-trimmed) prefix of `lines`. */
  #reuse(lines) {
    if (!this.initialized) return false; // first paint owns the container
    if (this.rendered.length === 0) return true;
    let drop = this.rendered.indexOf(lines[0]);
    if (lines.length === 0 || drop < 0) return false;
    const kept = this.rendered.length - drop;
    if (kept > lines.length) return false;
    for (let i = 0; i < kept; i += 1) if (this.rendered[drop + i] !== lines[i]) return false;
    while (drop-- > 0) {
      this.lineNodes.shift().remove();
      this.rendered.shift();
    }
    return true;
  }

  #rebuild(lines) {
    this.initialized = true;
    this.rebuilds += 1;
    this.lineNodes = lines.map((entry) => this.createLine(entry.text, false));
    this.rendered = [...lines];
    this.interimNode = null;
    this.container.replaceChildren(...this.lineNodes);
  }
}
