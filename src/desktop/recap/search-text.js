/**
 * Session search: what of a recap is searchable (pure, no node: imports).
 *
 * searchChunks() cuts a recap into the pieces the embedder sees: transcript
 * windows of about SEARCH_CHUNK_WORDS words (overlapping by one line so a
 * thought split across two windows is whole in one of them), one piece per
 * detected question with its answer, the terms explained, and each screen
 * analysis. Model chatter (gate verdicts, first-token markers, retries,
 * superseded markers, error codes) carries no topic and is left out.
 *
 * Every chunk is identified by a `ref` into the recap (line range, turn id,
 * term range). The index keeps refs and vectors, never text: chunkText() and
 * snippetFor() rebuild the words from the recap file when a result is shown,
 * so no transcript is ever written beside the recap.
 *
 * lexicalWords() / queryWords() are the one tokenizer of the keyword boost.
 */
import { termText } from "./build.js";

export const SEARCH_CHUNK_WORDS = 180;
export const SEARCH_MAX_CHUNKS = 1000;
export const SNIPPET_CHARS = 160;
export const LEXICAL_MAX_WORDS = 2000;
export const QUERY_MAX_CHARS = 500;

const STOPWORDS = new Set(
  "a an the and or of to in on at for is are was were be been it its we our you your they their them this that these those with from by as do does did have has had not but if so than then there here what which who how can could would should will just also any all some more very into out up about like".split(" "),
);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value) => (typeof value === "string" ? value : "");
const splitWords = (text) => text.split(/\s+/).filter(Boolean);
/** Answers are model text with light markup (<b>…</b>); the tags are not words. */
const stripTags = (text) => text.replace(/<[^>]*>/g, "");

function speaker(line) {
  return line.role === "prospect" ? "Prospect" : "You";
}

function transcriptLineText(line, wordStart, wordEnd) {
  const text = str(line?.text).trim();
  if (!text) return "";
  const body = wordStart != null ? splitWords(text).slice(wordStart, wordEnd).join(" ") : text;
  return body ? `${speaker(line)}: ${body}` : "";
}

function screenText(line) {
  return [str(line?.title).trim(), str(line?.summary).trim()].filter(Boolean).join(": ");
}

function qaText(question) {
  const q = str(question?.question).trim();
  if (!q) return "";
  const answer = stripTags(str(question?.answer)).trim();
  return answer ? `${q}\n${answer}` : q;
}

function termsText(terms, start, end) {
  return terms
    .slice(start, end)
    .map((term) => termText(term))
    .join("\n");
}

/**
 * The text of one chunk, from the recap alone. "" when the ref does not fit
 * the recap any more (the file changed under the index).
 */
export function chunkText(recap, ref) {
  if (!isObject(recap) || !isObject(ref)) return "";
  if (typeof ref.turnId === "string") {
    const question = (Array.isArray(recap.questions) ? recap.questions : []).find((q) => q?.turnId === ref.turnId);
    return question ? qaText(question) : "";
  }
  if (Number.isInteger(ref.termStart) && Number.isInteger(ref.termEnd)) {
    const terms = Array.isArray(recap.terms) ? recap.terms : [];
    if (ref.termStart < 0 || ref.termEnd > terms.length || ref.termStart >= ref.termEnd) return "";
    return termsText(terms, ref.termStart, ref.termEnd);
  }
  if (Number.isInteger(ref.lineStart) && Number.isInteger(ref.lineEnd)) {
    const lines = Array.isArray(recap.lines) ? recap.lines : [];
    if (ref.lineStart < 0 || ref.lineEnd >= lines.length || ref.lineStart > ref.lineEnd) return "";
    const first = lines[ref.lineStart];
    if (ref.lineStart === ref.lineEnd && first?.type === "screen.result") return screenText(first);
    if (Number.isInteger(ref.wordStart)) {
      return first?.type === "transcript" ? transcriptLineText(first, ref.wordStart, ref.wordEnd) : "";
    }
    const parts = [];
    for (let i = ref.lineStart; i <= ref.lineEnd; i++) {
      const line = lines[i];
      if (line?.type !== "transcript") continue;
      const text = transcriptLineText(line);
      if (text) parts.push(text);
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * @param {object} recap a stored recap (store.js get())
 * @param {{ chunkWords?: number, maxChunks?: number }} [options]
 * @returns {{ kind: "transcript"|"qa"|"terms"|"screen", text: string, ref: object }[]}
 */
export function searchChunks(recap, { chunkWords = SEARCH_CHUNK_WORDS, maxChunks = SEARCH_MAX_CHUNKS } = {}) {
  if (!isObject(recap)) return [];
  const window = Number.isInteger(chunkWords) && chunkWords > 0 ? chunkWords : SEARCH_CHUNK_WORDS;
  const cap = Number.isInteger(maxChunks) && maxChunks > 0 ? maxChunks : SEARCH_MAX_CHUNKS;
  const chunks = [];
  const push = (kind, text, ref) => {
    if (text && chunks.length < cap) chunks.push({ kind, text, ref });
  };

  // Questions and answers first: the highest-signal pieces survive any cap.
  for (const question of Array.isArray(recap.questions) ? recap.questions : []) {
    if (typeof question?.turnId === "string") push("qa", qaText(question), { turnId: question.turnId });
  }

  const terms = Array.isArray(recap.terms) ? recap.terms : [];
  for (let start = 0; start < terms.length; ) {
    let end = start;
    let count = 0;
    while (end < terms.length && (count === 0 || count + splitWords(termText(terms[end])).length <= window)) {
      count += splitWords(termText(terms[end])).length;
      end += 1;
    }
    push("terms", termsText(terms, start, end), { termStart: start, termEnd: end });
    start = end;
  }

  const lines = Array.isArray(recap.lines) ? recap.lines : [];
  /** The open transcript window: line indexes and their word count. */
  let open = [];
  let openWords = 0;
  const closeWindow = () => {
    if (open.length === 0) return;
    const ref = { lineStart: open[0], lineEnd: open[open.length - 1] };
    push("transcript", chunkText(recap, ref), ref);
    // Overlap: the last line opens the next window, unless it was the only one.
    const last = open[open.length - 1];
    open = open.length > 1 ? [last] : [];
    openWords = open.length > 0 ? splitWords(str(lines[last].text).trim()).length : 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isObject(line)) continue;
    if (line.type === "screen.result") {
      push("screen", screenText(line), { lineStart: i, lineEnd: i });
      continue;
    }
    if (line.type !== "transcript") continue;
    const count = splitWords(str(line.text).trim()).length;
    if (count === 0) continue;
    if (count >= window) {
      // A single line wider than the window: flush what is open, then cut it into word ranges of its own.
      if (open.length > 0) {
        const ref = { lineStart: open[0], lineEnd: open[open.length - 1] };
        push("transcript", chunkText(recap, ref), ref);
        open = [];
        openWords = 0;
      }
      for (let start = 0; start < count; start += window) {
        const ref = { lineStart: i, lineEnd: i, wordStart: start, wordEnd: Math.min(count, start + window) };
        push("transcript", chunkText(recap, ref), ref);
      }
      continue;
    }
    open.push(i);
    openWords += count;
    if (openWords >= window) closeWindow();
  }
  if (open.length > 0) {
    // The tail. An overlap line alone is already covered by the window it closed.
    const onlyOverlap = open.length === 1 && chunks.some((chunk) => chunk.kind === "transcript" && chunk.ref.lineEnd === open[0] && chunk.ref.wordStart === undefined);
    if (!onlyOverlap) {
      const ref = { lineStart: open[0], lineEnd: open[open.length - 1] };
      push("transcript", chunkText(recap, ref), ref);
    }
  }
  return chunks;
}

/** The head of a chunk's text for a result row: one line, whole words, at most SNIPPET_CHARS plus an ellipsis. */
export function snippetFor(recap, ref) {
  const text = chunkText(recap, ref).replace(/\s+/g, " ").trim();
  if (text.length <= SNIPPET_CHARS) return text;
  const head = text.slice(0, SNIPPET_CHARS);
  const cut = head.lastIndexOf(" ");
  return `${(cut > SNIPPET_CHARS / 2 ? head.slice(0, cut) : head).trimEnd()}…`;
}

function tokens(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/** Unique words of these texts, for the keyword boost; bounded so a huge recap cannot bloat its index entry. */
export function lexicalWords(texts) {
  const seen = new Set();
  for (const text of Array.isArray(texts) ? texts : []) {
    if (typeof text !== "string") continue;
    for (const word of tokens(text)) {
      if (seen.size >= LEXICAL_MAX_WORDS) return [...seen];
      seen.add(word);
    }
  }
  return [...seen];
}

export function normalizeQuery(query) {
  if (typeof query !== "string") return "";
  return query.replace(/\s+/g, " ").trim().slice(0, QUERY_MAX_CHARS);
}

/** The query's words, unique, cut the same way lexicalWords cuts a recap. */
export function queryWords(query) {
  return [...new Set(tokens(normalizeQuery(query)))];
}
