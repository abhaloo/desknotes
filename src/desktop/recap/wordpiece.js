/**
 * BERT uncased WordPiece tokenization (pure, no node: imports), the one
 * all-MiniLM-L6-v2 and its relatives use: clean control characters,
 * space out CJK characters, lowercase, strip accents, split punctuation
 * into its own tokens, then cut each word greedily into the longest vocab
 * pieces ("##" marks a continuation); a word no pieces cover is [UNK].
 *
 * WHY in-house: the tokenizer libraries either bring a native module
 * (tokenizers) or an image stack and a Hub downloader (transformers.js);
 * this is ~100 lines against a fixed vocab.txt and stays offline. The live
 * check (test/live/recap-search-embedder.mjs) compares it with a reference
 * encoding when one is present.
 */
export const WORDPIECE_MAX_WORD_CHARS = 100;
export const SPECIAL_TOKENS = Object.freeze({ pad: "[PAD]", unk: "[UNK]", cls: "[CLS]", sep: "[SEP]" });

const CONTROL = /[\p{Cc}\p{Cf}]/u;
const PUNCTUATION = /[!-/:-@[-`{-~]|\p{P}/u;
const CJK = /\p{Script=Han}/u;
const ACCENTS = /\p{Mn}/gu;

/** vocab.txt: one piece per line, the line number is the id. */
export function parseVocab(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function cleanText(text) {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === 0 || code === 0xfffd) continue;
    if (char === "\t" || char === "\n" || char === "\r" || /\s/u.test(char)) {
      out += " ";
      continue;
    }
    if (CONTROL.test(char)) continue;
    out += CJK.test(char) ? ` ${char} ` : char;
  }
  return out;
}

/** Lowercased, accents stripped, punctuation split off: the BERT "basic" tokens. */
function basicTokens(text) {
  const tokens = [];
  for (const word of cleanText(text).split(" ")) {
    if (!word) continue;
    const plain = word.toLowerCase().normalize("NFD").replace(ACCENTS, "");
    let current = "";
    for (const char of plain) {
      if (PUNCTUATION.test(char)) {
        if (current) tokens.push(current);
        tokens.push(char);
        current = "";
      } else {
        current += char;
      }
    }
    if (current) tokens.push(current);
  }
  return tokens;
}

/**
 * @param {{ vocab: string[], maxTokens: number }} options
 * @returns {{ encode: (text: string) => { ids: number[], mask: number[] }, vocabSize: number, padId: number }}
 */
export function createWordPiece({ vocab, maxTokens } = {}) {
  if (!Array.isArray(vocab)) throw new TypeError("createWordPiece needs vocab: string[]");
  const ids = new Map(vocab.map((piece, index) => [piece, index]));
  const special = {};
  for (const [name, token] of Object.entries(SPECIAL_TOKENS)) {
    if (!ids.has(token)) throw new Error(`vocab has no ${token}`);
    special[name] = ids.get(token);
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 3) throw new RangeError("maxTokens must be an integer >= 3 ([CLS], one piece, [SEP])");

  function pieces(word) {
    if (word.length > WORDPIECE_MAX_WORD_CHARS) return [special.unk];
    const out = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found = null;
      while (start < end) {
        const candidate = (start > 0 ? "##" : "") + word.slice(start, end);
        if (ids.has(candidate)) {
          found = ids.get(candidate);
          break;
        }
        end -= 1;
      }
      if (found === null) return [special.unk];
      out.push(found);
      start = end;
    }
    return out;
  }

  function encode(text) {
    const body = [];
    const budget = maxTokens - 2;
    for (const word of basicTokens(typeof text === "string" ? text : "")) {
      for (const piece of pieces(word)) {
        if (body.length >= budget) break;
        body.push(piece);
      }
      if (body.length >= budget) break;
    }
    const out = [special.cls, ...body, special.sep];
    return { ids: out, mask: out.map(() => 1) };
  }

  return { encode, vocabSize: vocab.length, padId: special.pad };
}
