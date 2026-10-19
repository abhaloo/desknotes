/**
 * Per-line word cap for answer cards (src/shared/answer-cards.js
 * CARD_LIMITS.lineWords and lineSegments), applied to the spoken-text
 * filter's clean output.
 *
 * A line streams as it arrives until it nears the cap; its last `holdWords`
 * words before the cap are held. A line that ends in time goes out whole. A
 * line that reaches the cap breaks at its last clause break (",", ";" or
 * ":") inside the held words, or at the cap when there is none. Up to
 * `maxSegments` segments, the rest of the line continues on a CONTINUATION
 * line, so a condition at the end of a long line is kept. The last allowed
 * segment is cut instead: it ends with "…" so the rep can see it was cut, and
 * the rest of that line is dropped. The bullet and the label count as words.
 * Lines inside a fenced code block are never cut. A key phrase open at a
 * break is closed there, and opened again on the continuation line.
 */

const CLAUSE_BREAKS = [",", ";", ":"];

/** The start of a line that continues the one before it: no bullet, so it reads as the same point. */
export const CONTINUATION = "  ";

/**
 * @param {{maxWords?: number, holdWords?: number, maxSegments?: number}} [options]
 *   maxWords: words a line segment may have (default: no cap); holdWords: how
 *   many words before the cap are held back so a break can land on a clause
 *   break; maxSegments: segments one line may use before it is cut (default 1:
 *   a long line is cut at the cap).
 */
export function createLineCap({ maxWords = Infinity, holdWords = 8, maxSegments = 1 } = {}) {
  const holdFrom = Math.max(0, maxWords - holdWords); // words after this many are held
  let line = ""; // raw text of the current line so far
  let shown = ""; // the part of the current segment already sent
  let held = ""; // the part of it held back
  let words = 0; // words in the current segment
  let segments = 1;
  let inWord = false;
  let cut = false; // the current line was cut: drop the rest of it
  let code = false; // inside a fenced block
  let cuts = 0;
  let wraps = 0;
  let out = "";

  /** An odd number of `**` markers: a key phrase is open. */
  const phraseOpen = (text) => ((text.match(/\*\*/g) ?? []).length % 2 === 1);

  /** Where the segment breaks: just after the last clause break in the held words, else at the cap. */
  function breakPoint() {
    const at = Math.max(...CLAUSE_BREAKS.map((mark) => held.lastIndexOf(mark)));
    return at >= 0 ? { kept: held.slice(0, at + 1), rest: held.slice(at + 1).trimStart(), at } : { kept: held, rest: "", at };
  }

  function endLine() {
    if (!cut) out += held;
    out += "\n";
    if (line.startsWith("```")) code = !code;
    line = "";
    shown = "";
    held = "";
    words = 0;
    segments = 1;
    inWord = false;
    cut = false;
  }

  function cutLine() {
    const { kept: withBreak, at } = breakPoint();
    const kept = (at >= 0 ? withBreak.slice(0, -1) : withBreak).trimEnd();
    out += `${kept}${phraseOpen(shown + kept) ? "**" : ""}…`;
    held = "";
    cut = true;
    cuts += 1;
  }

  /** End this segment at its break; the rest of the held words start the continuation line. */
  function wrapLine() {
    const { kept: withBreak, rest } = breakPoint();
    const kept = withBreak.trimEnd();
    const open = phraseOpen(shown + kept) ? "**" : "";
    out += `${kept}${open}\n${CONTINUATION}${open}`;
    shown = open;
    held = "";
    words = 0;
    inWord = false;
    segments += 1;
    wraps += 1;
    for (const ch of rest) step(ch);
  }

  function step(ch) {
    if (ch === "\n") {
      endLine();
      return;
    }
    if (cut) return;
    line += ch;
    if (code) {
      out += ch;
      return;
    }
    const space = /\s/.test(ch);
    if (!space && !inWord) {
      words += 1;
      if (words > maxWords) {
        if (segments < maxSegments) {
          wrapLine();
          step(ch);
        } else {
          cutLine();
        }
        return;
      }
    }
    inWord = !space;
    if (words > holdFrom) {
      held += ch;
    } else {
      out += ch;
      shown += ch;
    }
  }

  return {
    push(text) {
      out = "";
      for (const ch of String(text ?? "")) step(ch);
      return out;
    },
    flush() {
      const rest = cut ? "" : held;
      held = "";
      return rest;
    },
    /** Lines cut so far. */
    get cuts() {
      return cuts;
    },
    /** Continuation lines started so far. */
    get wraps() {
      return wraps;
    },
  };
}
