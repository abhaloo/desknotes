/**
 * Session search: the in-memory index (pure, no node: imports).
 *
 * One entry per session: its chunk refs (search-text.js), the unit-length
 * vector of each chunk, and the session's words for the keyword boost. A
 * query is a flat scan: every chunk's dot product with the query vector
 * (unit vectors, so cosine), the session scores its best chunk, plus
 * `lexicalBoost` times the share of query words found in the session.
 * Without a query vector (no local model) the word share is the whole score.
 *
 * WHY a flat scan: measured at ~4 ms for 5k chunks and ~55 ms for 50k chunks
 * of 384 dims in plain JS. A rep's year of calls is 25k-50k chunks. An ANN
 * library (usearch) would add a native module to package for nothing
 * measurable at that size; this interface (add / remove / query) is the seam
 * where it would go if an index ever passes ~100k chunks.
 *
 * The sidecar is the per-session file the index is rebuilt from: refs,
 * words, vectors and the model they came from. Never text.
 */
export const SEARCH_INDEX_VERSION = 1;
/**
 * Measured with all-MiniLM-L6-v2 on real recaps (meaning / word boost split):
 * "farming" -> the farming session 0.29 / 0; "single sign-on" -> the SSO
 * session 0.55 / 0, a pricing session 0.14 / 0.10 (the word "sign" alone).
 * Good matches score 0.31-0.55 on meaning, a one-word query at the low end,
 * unrelated text 0.0-0.15: no absolute floor separates a lone weak true hit
 * from a phrase's false hit. So:
 *   - threshold 0.2 on the total keeps the short queries, and lets an exact
 *     word alone (meaning ~0, boost 0.2) through;
 *   - the word boost is lexicalBoost * lexical^2: every query word found is
 *     +0.2, half of them +0.05, so a stray shared word cannot lift noise;
 *   - ratio: a hit must also reach 0.65 of the best MEANING score of the
 *     query (0.55 -> 0.36 cuts the 0.14 pricing hit; 0.29 alone stays),
 *     unless every query word is in it. The reference is meaning, never the
 *     total, so a word boost on the top hit cannot push a hit on meaning out.
 */
export const SEARCH_DEFAULTS = Object.freeze({ threshold: 0.2, lexicalBoost: 0.2, ratio: 0.65, limit: 50 });

const ID_RULE = /^[A-Za-z0-9_-]{1,120}$/;
const KINDS = new Set(["transcript", "qa", "terms", "screen"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isRef = (ref) => isObject(ref) && Object.values(ref).every((v) => typeof v === "string" || Number.isInteger(v));
const isChunk = (chunk) => isObject(chunk) && KINDS.has(chunk.kind) && isRef(chunk.ref);
const isWords = (words) => Array.isArray(words) && words.every((word) => typeof word === "string");

function compare(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.savedAt !== b.savedAt) return a.savedAt < b.savedAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * @param {{ dims: number }} options
 */
export function createSearchIndex({ dims } = {}) {
  if (!Number.isInteger(dims) || dims <= 0) throw new RangeError("createSearchIndex needs integer dims > 0");
  /** id -> { savedAt, model, chunks, vectors, words: Set } */
  const entries = new Map();

  function add(id, entry = {}) {
    if (typeof id !== "string" || !ID_RULE.test(id)) throw new TypeError("add needs a session id");
    const chunks = Array.isArray(entry.chunks) && entry.chunks.every(isChunk) ? entry.chunks.map((c) => ({ kind: c.kind, ref: { ...c.ref } })) : null;
    if (!chunks) throw new TypeError("add needs chunks: [{ kind, ref }]");
    const vectors = entry.vectors ?? null;
    if (vectors !== null && !(vectors instanceof Float32Array && vectors.length === chunks.length * dims)) {
      throw new RangeError(`vectors must be a Float32Array of chunks * dims (${chunks.length} * ${dims})`);
    }
    if (!isWords(entry.words)) throw new TypeError("add needs words: string[]");
    entries.set(id, {
      savedAt: typeof entry.savedAt === "string" ? entry.savedAt : "",
      model: typeof entry.model === "string" ? entry.model : null,
      chunks,
      vectors,
      words: new Set(entry.words),
    });
  }

  function remove(id) {
    return entries.delete(id);
  }

  function clear() {
    entries.clear();
  }

  function entry(id) {
    const found = entries.get(id);
    if (!found) return null;
    return { savedAt: found.savedAt, model: found.model, indexed: found.vectors !== null, chunkCount: found.chunks.length };
  }

  /**
   * @param {{ vector?: Float32Array|null, words?: string[], threshold?: number, lexicalBoost?: number, ratio?: number, limit?: number }} query
   * @returns {{ id: string, score: number, semantic: number, lexical: number, chunk: object|null }[]}
   */
  function query({ vector = null, words = [], threshold = SEARCH_DEFAULTS.threshold, lexicalBoost = SEARCH_DEFAULTS.lexicalBoost, ratio = SEARCH_DEFAULTS.ratio, limit = SEARCH_DEFAULTS.limit } = {}) {
    if (vector !== null && !(vector instanceof Float32Array)) throw new TypeError("query vector must be a Float32Array or null");
    if (vector !== null && vector.length !== dims) throw new RangeError(`query vector has ${vector.length} dims, the index ${dims}`);
    if (!(Number.isFinite(ratio) && ratio >= 0 && ratio <= 1)) throw new RangeError("query ratio must be a number from 0 (no relative cut) to 1");
    const terms = Array.isArray(words) ? [...new Set(words.filter((w) => typeof w === "string" && w))] : [];
    if (vector === null && terms.length === 0) return [];
    const hits = [];
    for (const [id, item] of entries) {
      let semantic = 0;
      let best = -1;
      if (vector !== null && item.vectors !== null) {
        const data = item.vectors;
        const count = item.chunks.length;
        for (let c = 0; c < count; c++) {
          const offset = c * dims;
          let dot = 0;
          for (let j = 0; j < dims; j++) dot += data[offset + j] * vector[j];
          if (dot > semantic || best < 0) {
            semantic = dot;
            best = c;
          }
        }
        if (semantic < 0) semantic = 0; // an opposite vector is "no match", not a negative one
      }
      let found = 0;
      for (const term of terms) if (item.words.has(term)) found += 1;
      const lexical = terms.length > 0 ? found / terms.length : 0;
      let score;
      if (vector === null) {
        if (lexical <= 0) continue;
        score = lexical;
      } else {
        score = semantic + lexicalBoost * lexical * lexical;
        if (score < threshold) continue;
      }
      hits.push({ id, score, semantic, lexical, chunk: best >= 0 ? { kind: item.chunks[best].kind, ref: { ...item.chunks[best].ref } } : null, savedAt: item.savedAt });
    }
    if (vector !== null && ratio > 0 && hits.length > 1) {
      // The relative cut, against the best MEANING of the query (not the best total).
      const reference = Math.max(...hits.map((hit) => hit.semantic));
      const cut = ratio * reference;
      for (let i = hits.length - 1; i >= 0; i--) {
        if (hits[i].semantic < cut && hits[i].lexical < 1) hits.splice(i, 1);
      }
    }
    hits.sort(compare);
    const max = Number.isInteger(limit) && limit > 0 ? limit : SEARCH_DEFAULTS.limit;
    return hits.slice(0, max).map(({ savedAt, ...hit }) => hit);
  }

  return { add, remove, clear, has: (id) => entries.has(id), size: () => entries.size, ids: () => [...entries.keys()], entry, query };
}

/* ------------------------------------------------------------------ sidecar */

function toBase64(vectors) {
  return Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength).toString("base64");
}

function fromBase64(text) {
  const bytes = Buffer.from(text, "base64");
  if (bytes.length % 4 !== 0) return null;
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

/** @returns {string} one JSON line: refs, words, vectors (base64 float32) and the model. */
export function encodeSidecar({ id, savedAt, model, dims, chunks, vectors, words }) {
  return `${JSON.stringify({
    version: SEARCH_INDEX_VERSION,
    id,
    savedAt: savedAt ?? "",
    model: vectors ? (model ?? null) : null,
    dims: vectors ? (dims ?? null) : null,
    chunks: chunks.map((chunk) => ({ kind: chunk.kind, ref: chunk.ref })),
    words: [...words],
    vectors: vectors ? toBase64(vectors) : null,
  })}\n`;
}

/** @returns {{ id, savedAt, model, dims, chunks, vectors: Float32Array|null, words } | null} null for anything damaged. */
export function decodeSidecar(text) {
  if (typeof text !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed.version !== SEARCH_INDEX_VERSION) return null;
  if (typeof parsed.id !== "string" || !ID_RULE.test(parsed.id)) return null;
  if (typeof parsed.savedAt !== "string") return null;
  if (!Array.isArray(parsed.chunks) || !parsed.chunks.every(isChunk)) return null;
  if (!isWords(parsed.words)) return null;
  const hasVectors = parsed.vectors !== null && parsed.vectors !== undefined;
  if (hasVectors && (typeof parsed.vectors !== "string" || typeof parsed.model !== "string" || !Number.isInteger(parsed.dims) || parsed.dims <= 0)) return null;
  if (!hasVectors && parsed.model !== null && parsed.model !== undefined) return null;
  let vectors = null;
  if (hasVectors) {
    vectors = fromBase64(parsed.vectors);
    if (!vectors || vectors.length !== parsed.chunks.length * parsed.dims) return null;
  }
  return {
    id: parsed.id,
    savedAt: parsed.savedAt,
    model: hasVectors ? parsed.model : null,
    dims: hasVectors ? parsed.dims : null,
    chunks: parsed.chunks.map((chunk) => ({ kind: chunk.kind, ref: { ...chunk.ref } })),
    vectors,
    words: [...parsed.words],
  };
}
