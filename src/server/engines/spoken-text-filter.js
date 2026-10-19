/**
 * Streaming cleanup for answers. The answer prompt asks for a short bulleted
 * list; this filter guarantees the rules a model can still break: every line
 * starts with a "• " bullet (the model's own "- ", "*", numbers and headings
 * become that one marker), a bullet holds at most two sentences (the third starts a new
 * bullet), blank lines collapse, and there are no em/en dashes, markdown
 * emphasis or emojis, and straight quotes only.
 *
 * It holds back only a short raw tail that could still start one of those
 * patterns (whitespace, dashes, `*`, `_`, `#`, bullets, digits, `.`, `)`,
 * backticks), so the stream stays live: every other character goes out on
 * the push that brought it.
 *
 * Code stays code. A fenced block (a line that starts with ```) goes out
 * exactly as written, fence lines, indentation, dashes, quotes and stars
 * included, until a line that starts with ``` closes it; a block still open
 * at the end is closed. Inside `inline code`, nothing is rewritten. Inside
 * brackets, and inside inline code, a "?" or "." never ends a sentence. A
 * spaced hyphen inside brackets or with a digit on either side ("cap - 1",
 * "5 - 3") is a minus sign and stays; an en or em dash between numbers reads "to"; an arrow ("->", "-->", "<--") stays; a lone "*"
 * between spaces ("n * 3") is multiplication and stays.
 *
 * Highlights (`{highlights: true}`; src/shared/highlights.js): a `**` pair
 * the model wraps around a key phrase is kept, at most HIGHLIGHT_LIMITS.perBullet
 * per bullet and perAnswer per answer, each at most HIGHLIGHT_LIMITS.words
 * words. A run of stars counts as one marker. A kept phrase is held back
 * until its closing marker (at most five words), then goes out whole with its
 * pair; a phrase over the word limit goes out unwrapped the moment its sixth
 * word starts, and a phrase past a cap streams unwrapped from its first
 * character. A phrase still open at a line break or at the end of the answer
 * is closed there; an empty one, or one with no letter or digit, is dropped.
 * Any other lone `*` is dropped too: it is markdown residue, and next to a
 * marker it would read as part of one. Off (the default), every `**` is
 * stripped and a lone `*` kept, exactly as before.
 *
 * Answer cards (src/shared/answer-cards.js) set a budget: at most `maxLines`
 * bullet lines (a code block counts as none), `maxCodeLines` lines inside
 * code blocks (the opening fence line is not one), key phrases only in the
 * first `highlightLines` bullets and at most `highlightsPerAnswer` per answer
 * (one per bullet always holds), and `sentencesPerBullet` (Infinity keeps the
 * model's own lines as the card's lines). A block past `maxCodeLines` ends
 * with a "…" line before its closing fence, so cut code never looks
 * complete. When the budget is spent, `cut` says which part ran out ("lines"
 * or "code") and the filter drops what follows, except one line that starts
 * with a `reserveLabel` (a label or a list of labels: the closing line,
 * "TRADE-OFF" or "NEXT STEP"): the filter reads on, at most
 * RESERVE_SCAN_CHARS, for that line and lets it through. Then the filter is
 * `full`: it drops everything after, and the caller can stop the stream. The
 * defaults set no budget.
 */
import { HIGHLIGHT_LIMITS, HIGHLIGHT_MARK } from "../../shared/highlights.js";

const DASH_CHARS = new Set(["—", "–"]);
const QUOTES = new Map([
  ["“", '"'],
  ["”", '"'],
  ["„", '"'],
  ["‘", "'"],
  ["’", "'"],
  ["‚", "'"],
]);
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍]/u;
const LINE_MARKER = /^(?:#{1,6}|[-*•]|\d{1,3}[.)])[ \t]+/;
const HOLD_TAIL = /[\s\-–—*_#•\d.)`]+$/u;
const PAUSE_AFTER = new Set([",", ".", "!", "?", ":", ";"]);
const INLINE_SPACE = /[ \t]/;
const DIGIT = /\d/;
const BULLET = "• ";
const FENCE = "```";
const SENTENCES_PER_BULLET = 2;
const SENTENCE_END = /[.!?]["')\]]*$/;
const SENTENCE_START = /[\p{Lu}\d"'(]/u;
/** A full stop after these is not the end of a sentence. */
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "st", "jr", "sr", "vs", "etc", "e.g", "i.e", "inc", "ltd", "co", "no", "approx"]);
/** A highlighted phrase must say something: one letter or digit at least. */
const HIGHLIGHT_CONTENT = /[\p{L}\p{N}]/u;
/** Raw characters read past a spent budget while looking for the `reserveLabel` line. */
const RESERVE_SCAN_CHARS = 2_000;
/** What may come before a reserved label: whitespace, a list marker, an opening `**`. */
const RESERVE_HEAD = /^\s*(?:(?:[-•–—]|\*(?!\*)|\d{1,3}[.)])\s*)?(?:\*\*)?\s*/u;

/**
 * Does `line` (so far) start with `label` and a colon? "yes", "maybe" (it
 * still could) or "no". Case, spaces and hyphens in the label do not count,
 * and a plural "S" or a closing `**` may follow it ("Trade-offs:", "**TRADE-OFF**:").
 */
function reserveMatch(line, label) {
  const squash = (text) => text.toUpperCase().replace(/[\s-]/g, "");
  const want = squash(label);
  const core = squash(line.slice(RESERVE_HEAD.exec(line)[0].length));
  if (want.startsWith(core)) return "maybe";
  if (!core.startsWith(want)) return "no";
  const after = core.slice(want.length);
  if (/^S?(?:\*\*)?:/.test(after)) return "yes";
  return /^S?\**$/.test(after) ? "maybe" : "no";
}

/** The best reserveMatch over a list of labels: "yes" if one gives "yes", else "maybe" if one does, else "no". */
function reserveMatchAny(line, labels) {
  let best = "no";
  for (const label of labels) {
    const match = reserveMatch(line, label);
    if (match === "yes") return "yes";
    if (match === "maybe") best = "maybe";
  }
  return best;
}

/** `token` (the word before a space) ends a sentence and `next` starts one. */
function endsSentence(token, next) {
  if (!SENTENCE_END.test(token) || !SENTENCE_START.test(next)) return false;
  const word = token.replace(/["')\]]+$/, "").replace(/[.!?]+$/, "").replace(/^["'(]+/, "").toLowerCase();
  return !ABBREVIATIONS.has(word);
}

function wordCount(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * @param {{highlights?: boolean, maxLines?: number, maxCodeLines?: number,
 *   highlightLines?: number, highlightsPerAnswer?: number, sentencesPerBullet?: number,
 *   reserveLabel?: string|string[]|null}} [options]
 *   highlights: keep `**` key-phrase pairs (default off). The rest is the
 *   answer-card budget (default: none). reserveLabel: the closing line kept
 *   past the budget, one label or a list of labels ("TRADE-OFF", "NEXT STEP").
 */
export function createSpokenTextFilter({
  highlights = false,
  maxLines = Infinity,
  maxCodeLines = Infinity,
  highlightLines = Infinity,
  highlightsPerAnswer = HIGHLIGHT_LIMITS.perAnswer,
  sentencesPerBullet = SENTENCES_PER_BULLET,
  reserveLabel = null,
} = {}) {
  let held = ""; // raw tail that may still start a pattern
  let space = ""; // whitespace waiting for the next visible character
  let prev = ""; // last visible character emitted
  let lineStart = true;
  let token = ""; // visible characters since the last space: the word a space follows
  let sentences = 0; // sentences ended in the current bullet
  let bulletOpen = false; // the current output line is a bullet
  let lineOpen = false; // the current output line has content (a bullet, or a closing fence)
  let out = []; // pieces of the current push or flush
  // Highlights only; all stay at their initial values when highlights are off.
  let pendingOpen = false; // a `**` opener waits for the next visible character
  let span = null; // the open phrase: {keep, text}; a kept phrase buffers its text
  let spansInBullet = 0;
  let spansInAnswer = 0;
  // Code and the card budget.
  let code = null; // an open fenced block: {line: the text of its current line}
  let inlineCode = false; // between backticks on this line
  let depth = 0; // open ( and [ on this line
  let lines = 0; // bullet lines started
  let lineBudget = maxLines; // one more once the reserved line is found
  let codeLines = 0; // lines inside fenced blocks
  let full = false; // the budget is spent: nothing more goes out
  let cut = null; // which budget ran out: "lines" | "code"
  const reserveLabels = reserveLabel == null ? [] : [].concat(reserveLabel).filter(Boolean);
  // Past a spent budget: looking for the one `reserveLabel` line.
  let scanning = false;
  let scanLine = ""; // raw text of the line being looked at
  let scanDead = false; // this line can no longer be the reserved one
  let scanned = 0;
  let reserveUsed = false;

  /** Visible output: into the open kept phrase, else straight out. */
  function emit(piece) {
    if (!span?.keep) {
      out.push(piece);
      return;
    }
    span.text += piece;
    if (wordCount(span.text) > HIGHLIGHT_LIMITS.words) {
      // Too long for a key phrase: release it as plain text and drop its closer.
      out.push(span.text);
      span = { keep: false, text: "" };
    }
  }

  /** A closer, a line break or the end of the answer ends the open phrase. */
  function closeSpan() {
    if (span?.keep) {
      const body = span.text.replace(/\s+$/u, "");
      const tail = span.text.slice(body.length);
      if (HIGHLIGHT_CONTENT.test(body)) {
        out.push(HIGHLIGHT_MARK, body, HIGHLIGHT_MARK, tail);
        spansInBullet += 1;
        spansInAnswer += 1;
      } else {
        out.push(span.text);
      }
    }
    span = null;
  }

  /** The opener reaches its first visible character: keep it unless a cap is reached. */
  function openSpan() {
    pendingOpen = false;
    span = {
      keep: spansInBullet < HIGHLIGHT_LIMITS.perBullet && spansInAnswer < highlightsPerAnswer && lines <= highlightLines,
      text: "",
    };
  }

  /** End the current output line; the next content starts a new one. */
  function newline() {
    if (lineOpen) out.push("\n");
    lineOpen = false;
  }

  /** End the current bullet; the next visible character opens a new one. */
  function breakLine() {
    closeSpan();
    newline();
    bulletOpen = false;
    sentences = 0;
    spansInBullet = 0;
  }

  /** True when the budget allows one more bullet line; otherwise the answer is over. */
  function room() {
    if (lines < lineBudget) return true;
    spent("lines");
    return false;
  }

  /** A budget ran out: look for the reserved line, or stop. */
  function spent(reason) {
    closeSpan();
    pendingOpen = false;
    cut ??= reason;
    if (reserveLabels.length > 0 && !reserveUsed) {
      scanning = true;
      scanLine = "";
      scanDead = false;
    } else {
      full = true;
    }
  }

  /** One raw character past the budget: the reserved line goes out, anything else is dropped. */
  function scanStep(text, i) {
    const ch = text[i];
    scanned += 1;
    if (ch === "\n") {
      scanLine = "";
      scanDead = false;
    } else if (!scanDead) {
      scanLine += ch;
      const match = reserveMatchAny(scanLine, reserveLabels);
      if (match === "yes") {
        releaseReserved();
        return i + 1;
      }
      if (match === "no") scanDead = true;
    }
    if (scanned >= RESERVE_SCAN_CHARS) {
      scanning = false;
      full = true;
    }
    return i + 1;
  }

  /** The reserved line was found: it starts one more bullet line, then the budget is spent for good. */
  function releaseReserved() {
    const line = scanLine;
    scanning = false;
    reserveUsed = true;
    scanLine = "";
    lineBudget = lines + 1;
    inlineCode = false;
    depth = 0;
    space = "\n";
    lineStart = true;
    process(line, false);
  }

  /**
   * A visible character (or a kept run such as an arrow), after the
   * whitespace before it: a line break, a sentence break or one space.
   * False when the budget stopped the answer.
   */
  function visible(piece) {
    if (space) {
      if (prev && space.includes("\n")) {
        if (!room()) return false;
        breakLine();
      } else if (prev && !inlineCode && depth === 0 && endsSentence(token, piece[0]) && ++sentences >= sentencesPerBullet) {
        if (!room()) return false;
        breakLine();
      } else if (prev && bulletOpen) {
        emit(" ");
      }
      space = "";
      token = "";
    }
    if (!bulletOpen) {
      if (!room()) return false;
      newline();
      out.push(BULLET);
      bulletOpen = true;
      lineOpen = true;
      lines += 1;
    }
    if (pendingOpen) openSpan();
    emit(piece);
    token += piece;
    prev = piece[piece.length - 1];
    return true;
  }

  /** A line that starts with ``` opens a block: the bullet line before it ends. */
  function openFence() {
    closeSpan();
    pendingOpen = false;
    newline();
    bulletOpen = false;
    sentences = 0;
    spansInBullet = 0;
    space = "";
    token = "";
    out.push(FENCE);
    lineOpen = true;
    code = { line: FENCE, opening: true };
  }

  /** The block is closed: its closing fence is on the current line. */
  function closeCode() {
    code = null;
    lineOpen = true;
    prev = "`";
    token = "";
    space = "";
    lineStart = false;
  }

  /**
   * One character inside a block: out as written; a line that starts with ```
   * closes it. A body line past `maxCodeLines` becomes "…" and closes it.
   */
  function codeStep(text, i) {
    if (code.line.trim() === "") {
      if (text.startsWith(FENCE, i)) {
        out.push(FENCE);
        closeCode();
        return i + FENCE.length;
      }
      if (codeLines >= maxCodeLines && !/\s/.test(text[i])) {
        out.push("…\n", FENCE);
        closeCode();
        spent("code");
        return i; // not consumed: a scan for the reserved line starts here
      }
    }
    const ch = text[i];
    out.push(ch);
    if (ch !== "\n") {
      code.line += ch;
      return i + 1;
    }
    code.line = "";
    if (code.opening) code.opening = false;
    else codeLines += 1;
    return i + 1;
  }

  function process(text, final) {
    let i = 0;
    while (i < text.length && !full) {
      if (scanning) {
        i = scanStep(text, i);
        continue;
      }
      if (code) {
        i = codeStep(text, i);
        continue;
      }
      const ch = String.fromCodePoint(text.codePointAt(i));
      const size = ch.length;
      if (/\s/.test(ch)) {
        space += ch;
        if (ch === "\n") {
          lineStart = true;
          inlineCode = false;
          depth = 0;
        }
        i += size;
        continue;
      }
      if (lineStart) {
        lineStart = false;
        if (text.startsWith(FENCE, i)) {
          openFence();
          i += FENCE.length;
          continue;
        }
        const marker = LINE_MARKER.exec(text.slice(i));
        if (marker) {
          i += marker[0].length;
          continue;
        }
      }
      if (ch === "`" || inlineCode) {
        // Inline code goes out as written.
        if (!visible(ch)) continue; // full, or scanning from here
        if (ch === "`") inlineCode = !inlineCode;
        i += size;
        continue;
      }
      if (EMOJI.test(ch)) {
        i += size;
        continue;
      }
      if (highlights && ch === "*") {
        if (text[i + 1] !== "*") {
          // "n * 3" is multiplication; any other lone star is markdown residue.
          if (space !== "" && INLINE_SPACE.test(text[i + 1] ?? "") && !visible("*")) continue;
          i += 1;
          continue;
        }
        let j = i + 2;
        while (text[j] === "*") j += 1;
        i = j;
        if (span) closeSpan();
        else pendingOpen = !pendingOpen; // a second opener before any text: an empty pair
        continue;
      }
      if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
        i += 2;
        continue;
      }
      if (ch === "-") {
        let end = i;
        while (text[end] === "-") end += 1;
        if (text[end] === ">" || prev === "<") {
          // An arrow ("->", "-->", "<--") is not a dash.
          const run = text.slice(i, text[end] === ">" ? end + 1 : end);
          if (!visible(run)) continue;
          i += run.length;
          continue;
        }
      }
      const doubleHyphen = ch === "-" && text[i + 1] === "-";
      const spacedHyphen = ch === "-" && space !== "" && INLINE_SPACE.test(text[i + 1] ?? "");
      if (DASH_CHARS.has(ch) || doubleHyphen || spacedHyphen) {
        let j = i + (doubleHyphen ? 2 : size);
        while (j < text.length && INLINE_SPACE.test(text[j])) j += 1;
        const next = text[j] ?? "";
        if (spacedHyphen && bulletOpen && !space.includes("\n") && (depth > 0 || DIGIT.test(prev) || DIGIT.test(next))) {
          // A minus sign: inside brackets, or a digit on either side ("cap - 1", "5 - 3").
          space = "";
          token = "";
          emit(" - ");
          prev = " ";
          i = j;
          continue;
        }
        const newLine = prev !== "" && space.includes("\n");
        space = ""; // the dash swallows the whitespace around it
        token = "";
        if (newLine) {
          if (!room()) continue;
          breakLine();
        }
        if (!bulletOpen) {
          // A dash opening a line is a list marker: the bullet replaces it.
        } else if (DIGIT.test(prev) && DIGIT.test(next)) {
          emit(" to ");
          prev = "o";
        } else if (!prev || next === "" || next === "\n") {
          // Nothing to join: a leading or trailing dash just disappears.
        } else if (PAUSE_AFTER.has(prev)) {
          emit(" ");
        } else {
          emit(", ");
          prev = ",";
        }
        i = j;
        continue;
      }
      const mapped = QUOTES.get(ch) ?? ch;
      if (!visible(mapped)) continue;
      if (mapped === "(" || mapped === "[") depth += 1;
      else if ((mapped === ")" || mapped === "]") && depth > 0) depth -= 1;
      i += size;
    }
    if (final) space = ""; // trailing whitespace is dropped
  }

  return {
    push(delta) {
      if (full) return "";
      const text = held + String(delta ?? "");
      const tail = HOLD_TAIL.exec(text);
      const ready = tail ? tail.index : text.length;
      held = text.slice(ready);
      out = [];
      process(text.slice(0, ready), false);
      if (full) held = "";
      return out.join("");
    },
    flush() {
      const text = full ? "" : held;
      held = "";
      out = [];
      if (!full) process(text, true);
      scanning = false; // the answer ended before a reserved line
      if (code) {
        // A block still open at the end is closed.
        out.push(code.line === "" ? FENCE : `\n${FENCE}`);
        code = null;
      }
      closeSpan(); // an open phrase ends with the answer
      pendingOpen = false;
      return out.join("");
    },
    /** The card budget is spent: nothing more goes out, and the caller can stop the stream. */
    get full() {
      return full;
    },
    /** Which budget cut the answer short: "lines", "code", or null when it fit. */
    get cut() {
      return cut;
    },
  };
}
