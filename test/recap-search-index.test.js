import test from "node:test";
import assert from "node:assert/strict";
import { createFakeEmbedder, fakeVector, FAKE_EMBEDDER_DIMS, FAKE_EMBEDDER_ID } from "./fixtures/fake-embedder.js";

/**
 * Session search, phase 1b: the in-memory index (src/desktop/recap/search-index.js, pure).
 *
 *   createSearchIndex({ dims })
 *     -> { add(id, entry), remove(id), clear(), has(id), size(), ids(), entry(id),
 *          query({ vector, words, threshold, lexicalBoost, limit }) -> hit[] }
 *   entry = { savedAt, model, chunks: [{ kind, ref }], vectors: Float32Array | null, words: string[] }
 *   hit   = { id, score, semantic, lexical, chunk: { kind, ref } | null }
 *
 * Scoring is a flat cosine scan (vectors are unit length, so a dot product):
 * a session scores its best chunk, plus a small boost for the share of query
 * words found in it (the hybrid). Without a query vector (no local model)
 * the word share is the whole score. Deferred on purpose: an ANN library
 * (usearch) buys nothing measurable under ~100k chunks and costs a native
 * module; the interface here is the seam where it would go.
 *
 *   encodeSidecar(entry) / decodeSidecar(text): the per-session file the
 *   index is rebuilt from. It carries refs, words and vectors: never text.
 */
const load = () => import("../src/desktop/recap/search-index.js");

const embedder = createFakeEmbedder();
const D = FAKE_EMBEDDER_DIMS;

async function entryFor(texts, { words = [], savedAt = "2026-10-28T14:00:00.000Z", model = FAKE_EMBEDDER_ID } = {}) {
  const vectors = new Float32Array(texts.length * D);
  (await embedder.embed(texts)).forEach((vector, i) => vectors.set(vector, i * D));
  return { savedAt, model, chunks: texts.map((_, i) => ({ kind: "transcript", ref: { lineStart: i, lineEnd: i } })), vectors, words };
}

async function topicIndex() {
  const { createSearchIndex } = await load();
  const index = createSearchIndex({ dims: D });
  index.add("session-pricing", await entryFor(["Prospect: what is the price for 200 seats?", "You: discount on the annual quote"], { words: ["price", "seats", "discount", "annual", "quote", "acme"], savedAt: "2026-10-28T10:00:00.000Z" }));
  index.add("session-sso", await entryFor(["Prospect: does login work with Okta SAML?", "You: SSO and SCIM are supported"], { words: ["login", "okta", "saml", "sso", "scim", "supported"], savedAt: "2026-10-28T11:00:00.000Z" }));
  index.add("session-infra", await entryFor(["Prospect: can we deploy on kubernetes?", "You: docker images are published"], { words: ["deploy", "kubernetes", "docker", "images", "published"], savedAt: "2026-10-28T12:00:00.000Z" }));
  return { index, ...(await load()) };
}

test("add / has / size / ids / entry / remove / clear", async () => {
  const { createSearchIndex } = await load();
  const index = createSearchIndex({ dims: D });
  assert.equal(index.size(), 0);
  index.add("s1", await entryFor(["pricing"], { savedAt: "2026-01-01T00:00:00.000Z" }));
  index.add("s2", { savedAt: "2026-01-02T00:00:00.000Z", model: null, chunks: [], vectors: null, words: ["kubernetes"] });
  assert.equal(index.size(), 2);
  assert.ok(index.has("s1") && index.has("s2") && !index.has("s3"));
  assert.deepEqual(index.ids().sort(), ["s1", "s2"]);
  assert.deepEqual(index.entry("s1"), { savedAt: "2026-01-01T00:00:00.000Z", model: FAKE_EMBEDDER_ID, indexed: true, chunkCount: 1 });
  assert.deepEqual(index.entry("s2"), { savedAt: "2026-01-02T00:00:00.000Z", model: null, indexed: false, chunkCount: 0 });
  assert.equal(index.entry("s3"), null);
  assert.equal(index.remove("s1"), true);
  assert.equal(index.remove("s1"), false);
  assert.equal(index.size(), 1);
  index.clear();
  assert.equal(index.size(), 0);
});

test("add replaces an earlier entry of the same id", async () => {
  const { createSearchIndex } = await load();
  const index = createSearchIndex({ dims: D });
  index.add("s1", await entryFor(["pricing"], { savedAt: "2026-01-01T00:00:00.000Z" }));
  index.add("s1", await entryFor(["kubernetes", "docker"], { savedAt: "2026-01-03T00:00:00.000Z" }));
  assert.equal(index.size(), 1);
  assert.equal(index.entry("s1").chunkCount, 2);
  assert.equal(index.entry("s1").savedAt, "2026-01-03T00:00:00.000Z");
});

test("add rejects vectors that do not match the chunk count and dims", async () => {
  const { createSearchIndex } = await load();
  const index = createSearchIndex({ dims: D });
  assert.throws(() => index.add("s1", { savedAt: "x", model: "m", chunks: [{ kind: "qa", ref: { turnId: "t" } }], vectors: new Float32Array(D + 1), words: [] }), /vectors/);
  assert.throws(() => index.add("s1", { savedAt: "x", model: "m", chunks: [{ kind: "qa", ref: { turnId: "t" } }], vectors: [1, 2, 3], words: [] }), /vectors/);
  assert.throws(() => index.add("", { savedAt: "x", model: null, chunks: [], vectors: null, words: [] }), /id/);
  assert.equal(index.size(), 0);
});

test("query ranks sessions by topic, not by the words typed", async () => {
  const { index } = await topicIndex();
  const [vector] = await embedder.embed(["how much does it cost"]); // "cost" -> pricing in the fake's synonyms
  const hits = index.query({ vector, words: ["how", "much", "does", "cost"], threshold: 0.1 });
  assert.equal(hits[0].id, "session-pricing");
  assert.ok(!hits.some((hit) => hit.id === "session-infra"), "an unrelated session is below the threshold");
  assert.deepEqual(hits[0].chunk, { kind: "transcript", ref: { lineStart: 1, lineEnd: 1 } }, "the best chunk is the one most about pricing (discount + quote)");
  assert.ok(hits[0].semantic > 0 && hits[0].score >= hits[0].semantic);
});

test("query: the word boost lifts a session that holds an exact word the embedding misses", async () => {
  const { index } = await topicIndex();
  const [vector] = await embedder.embed(["acme"]);
  const without = index.query({ vector, words: ["acme"], threshold: 0, lexicalBoost: 0 });
  const withBoost = index.query({ vector, words: ["acme"], threshold: 0, lexicalBoost: 0.2 });
  const pricing = withBoost.find((hit) => hit.id === "session-pricing");
  assert.equal(pricing.lexical, 1, "every query word was found");
  assert.equal(withBoost[0].id, "session-pricing");
  assert.ok(pricing.score > without.find((hit) => hit.id === "session-pricing").score);
  assert.equal(withBoost.find((hit) => hit.id === "session-sso").lexical, 0);
});

test("query: lexical is the share of query words found, and the score adds lexicalBoost * lexical squared", async () => {
  const { index } = await topicIndex();
  const [vector] = await embedder.embed(["annual seats kubernetes"]);
  const hits = index.query({ vector, words: ["annual", "seats", "kubernetes"], threshold: 0, lexicalBoost: 0.3, ratio: 0 }); // the arithmetic only; no relative cut
  const pricing = hits.find((hit) => hit.id === "session-pricing");
  assert.ok(Math.abs(pricing.lexical - 2 / 3) < 1e-9);
  assert.ok(Math.abs(pricing.score - (pricing.semantic + 0.3 * (2 / 3) ** 2)) < 1e-9, "the boost is lexicalBoost * lexical^2: a partial word match counts little");
});

test("query without a vector is keyword mode: word share is the score, sessions with no match are out", async () => {
  const { index } = await topicIndex();
  const hits = index.query({ vector: null, words: ["okta", "scim", "nothing"] });
  assert.deepEqual(
    hits.map((hit) => [hit.id, hit.semantic, Number(hit.lexical.toFixed(3)), hit.chunk]),
    [["session-sso", 0, 0.667, null]],
  );
  assert.ok(Math.abs(hits[0].score - 2 / 3) < 1e-9);
});

test("query: an entry with words but no vectors still answers in keyword mode and in hybrid mode", async () => {
  const { createSearchIndex } = await load();
  const index = createSearchIndex({ dims: D });
  index.add("pending", { savedAt: "2026-01-01T00:00:00.000Z", model: null, chunks: [], vectors: null, words: ["pricing", "seats"] });
  const [vector] = await embedder.embed(["pricing"]);
  const hybrid = index.query({ vector, words: ["pricing"], threshold: 0.1, lexicalBoost: 0.2 });
  assert.deepEqual(hybrid.map((hit) => [hit.id, hit.semantic, hit.lexical, hit.chunk]), [["pending", 0, 1, null]]);
  assert.ok(Math.abs(hybrid[0].score - 0.2) < 1e-9);
  assert.equal(index.query({ vector: null, words: ["seats"] }).length, 1);
  assert.equal(index.query({ vector: null, words: ["okta"] }).length, 0);
});

test("query: threshold, limit and ordering (score desc, then newer first, then id)", async () => {
  const { createSearchIndex } = await load();
  const index = createSearchIndex({ dims: D });
  for (const [id, savedAt] of [["b", "2026-01-02T00:00:00.000Z"], ["a", "2026-01-02T00:00:00.000Z"], ["c", "2026-01-01T00:00:00.000Z"]]) {
    index.add(id, await entryFor(["pricing pricing"], { savedAt }));
  }
  index.add("far", await entryFor(["kubernetes"], { savedAt: "2026-01-03T00:00:00.000Z" }));
  const [vector] = await embedder.embed(["pricing"]);
  const all = index.query({ vector, words: [], threshold: 0.5, ratio: 0 }); // ratio 0: the threshold alone decides here
  assert.deepEqual(
    all.map((hit) => hit.id),
    ["a", "b", "c"],
    "equal scores: newer first, then id",
  );
  assert.deepEqual(index.query({ vector, words: [], threshold: 0.5, limit: 2, ratio: 0 }).map((hit) => hit.id), ["a", "b"]);
  assert.deepEqual(index.query({ vector, words: [], threshold: 1.01, ratio: 0 }), []);
  assert.deepEqual(index.query({ vector, words: [], threshold: 0, ratio: 0 }).map((hit) => hit.id), ["a", "b", "c", "far"], "threshold 0 keeps every non-negative score");
});

test("defaults: threshold 0.2 keeps short real queries (0.31-0.55 measured) and an exact word alone; boost 0.2; ratio 0.65; limit 50", async () => {
  const { SEARCH_DEFAULTS } = await load();
  assert.deepEqual(SEARCH_DEFAULTS, { threshold: 0.2, lexicalBoost: 0.2, ratio: 0.65, limit: 50 });
  assert.ok(0.31 - SEARCH_DEFAULTS.threshold >= 0.1, "a margin under the weakest good match");
  assert.ok(SEARCH_DEFAULTS.lexicalBoost >= SEARCH_DEFAULTS.threshold, "every query word found is a hit on its own");
});

/* ------------------------------------------------------------- relative cut
 * Measured with the real model (meaning / word boost split): "farming" ->
 * avocado session 0.29 / 0; "single sign-on" -> SSO 0.55 / 0, pricing 0.14 /
 * 0.10 (the word "sign" alone). An absolute floor cannot separate a lone weak
 * true hit from a phrase's false hit, so a hit must also reach `ratio` of the
 * best MEANING score, unless every query word is in it. The reference is the
 * best meaning, never the best total: a word boost on the top hit must not
 * push a hit on meaning out. Vectors here are built to exact cosines.
 */
const DIMS = 8;
/** A unit vector whose cosine with e0 (the query) is `cosine`; `axis` keeps sessions apart. */
function withCosine(cosine, axis = 1) {
  const v = new Float32Array(DIMS);
  v[0] = cosine;
  v[axis] = Math.sqrt(1 - cosine * cosine);
  return v;
}
async function cutIndex(sessions) {
  const { createSearchIndex } = await load();
  const index = createSearchIndex({ dims: DIMS });
  sessions.forEach(([id, cosine, words = []], i) => {
    index.add(id, { savedAt: "2026-01-01T00:00:00.000Z", model: "m", chunks: [{ kind: "qa", ref: { turnId: "t" } }], vectors: withCosine(cosine, 1 + (i % (DIMS - 1))), words });
  });
  const query = new Float32Array(DIMS);
  query[0] = 1;
  return { index, query };
}
const ids = (hits) => hits.map((hit) => hit.id);

test("relative cut: one strong hit plus one false hit above the floor keeps the strong one only", async () => {
  const { index, query } = await cutIndex([["sso", 0.55], ["pricing", 0.24]]);
  assert.deepEqual(ids(index.query({ vector: query, words: ["single", "sign"] })), ["sso"], "0.24 < 0.65 * 0.55");
});

test("relative cut: the measured 'single sign-on' case: meaning 0.14 plus a half word match is out", async () => {
  const { index, query } = await cutIndex([["sso", 0.55], ["pricing", 0.14, ["sign", "quote"]]]);
  const hits = index.query({ vector: query, words: ["single", "sign"] });
  assert.deepEqual(ids(hits), ["sso"]);
  // Without the SSO session the pricing one is under the floor on its own: 0.14 + 0.2 * 0.5^2 = 0.19.
  const { index: alone, query: q2 } = await cutIndex([["pricing", 0.14, ["sign", "quote"]]]);
  assert.deepEqual(alone.query({ vector: q2, words: ["single", "sign"] }), []);
});

test("relative cut: one correct weak hit on its own is kept (the measured 'farming' case)", async () => {
  const { index, query } = await cutIndex([["avocado", 0.29]]);
  const hits = index.query({ vector: query, words: ["farming"] });
  assert.deepEqual(ids(hits), ["avocado"]);
  assert.ok(Math.abs(hits[0].score - 0.29) < 1e-6);
});

test("relative cut: two true hits of different strength both stay; a third far below goes", async () => {
  const { index, query } = await cutIndex([["strong", 0.55], ["weaker", 0.4], ["noise", 0.22]]);
  assert.deepEqual(ids(index.query({ vector: query, words: [] })), ["strong", "weaker"], "0.4 >= 0.3575, 0.22 < 0.3575");
});

test("relative cut: the reference is the best MEANING, so a word boost on the top hit never pushes a hit on meaning out", async () => {
  // Top hit: meaning 0.30 + every word found (+0.2) = 0.50 total. Other: meaning 0.28, no words.
  const { index, query } = await cutIndex([["boosted", 0.3, ["acme", "renewal"]], ["meaning", 0.28]]);
  const hits = index.query({ vector: query, words: ["acme", "renewal"] });
  assert.deepEqual(ids(hits), ["boosted", "meaning"], "0.28 >= 0.65 * 0.30; against the total 0.50 it would have been cut");
  assert.ok(Math.abs(hits[0].score - 0.5) < 1e-6 && Math.abs(hits[1].score - 0.28) < 1e-6);
});

test("relative cut: a hit holding every query word survives the cut; a partial word match does not", async () => {
  const { index, query } = await cutIndex([["strong", 0.55], ["exact", 0.05, ["acme"]], ["partial", 0.22, ["acme"]]]);
  const every = index.query({ vector: query, words: ["acme"] });
  assert.deepEqual(ids(every), ["strong", "partial", "exact"], "one query word: both hold all of it (0.27 and 0.25)");
  const two = index.query({ vector: query, words: ["acme", "renewal"] });
  assert.deepEqual(ids(two), ["strong"], "exact: 0.05 + 0.05 under the floor; partial: 0.22 + 0.05 = 0.27 over the floor but under the cut, and not a full word match");
});

test("relative cut: ratio is an option (0 turns it off); keyword mode has no meaning to cut against", async () => {
  const { index, query } = await cutIndex([["strong", 0.55, ["okta"]], ["weak", 0.24, ["okta"]]]);
  assert.deepEqual(ids(index.query({ vector: query, words: [], ratio: 0 })), ["strong", "weak"]);
  assert.deepEqual(ids(index.query({ vector: query, words: [], ratio: 0.9 })), ["strong"]);
  assert.deepEqual(ids(index.query({ vector: null, words: ["okta"] })), ["strong", "weak"]);
  assert.throws(() => index.query({ vector: query, words: [], ratio: 1.5 }), /ratio/);
});

test("query: a zero vector (a query with no words the model knows) matches nothing semantically", async () => {
  const { index } = await topicIndex();
  const hits = index.query({ vector: new Float32Array(D), words: [], threshold: 0.1 });
  assert.deepEqual(hits, []);
});

test("query validates its inputs", async () => {
  const { index } = await topicIndex();
  assert.throws(() => index.query({ vector: new Float32Array(D - 1), words: [] }), /dims/);
  assert.throws(() => index.query({ vector: "x", words: [] }), /vector/);
  assert.deepEqual(index.query({ vector: null, words: [] }), []);
  assert.deepEqual(index.query({ vector: null }), []);
});

test("sidecar: encode / decode round-trips refs, words, vectors and metadata; never text", async () => {
  const { encodeSidecar, decodeSidecar, SEARCH_INDEX_VERSION } = await load();
  const entry = await entryFor(["the secret transcript line", "another"], { words: ["secret", "transcript", "line", "another"] });
  entry.chunks[1] = { kind: "qa", ref: { turnId: "t1" } };
  const text = encodeSidecar({ id: "session-1", dims: D, ...entry });
  assert.ok(text.endsWith("\n"));
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, SEARCH_INDEX_VERSION);
  assert.equal(parsed.id, "session-1");
  assert.equal(parsed.model, FAKE_EMBEDDER_ID);
  assert.equal(parsed.dims, D);
  assert.ok(!text.includes("the secret transcript line"), "chunk text is never written");
  const decoded = decodeSidecar(text);
  assert.equal(decoded.id, "session-1");
  assert.equal(decoded.savedAt, entry.savedAt);
  assert.equal(decoded.model, FAKE_EMBEDDER_ID);
  assert.equal(decoded.dims, D);
  assert.deepEqual(decoded.chunks, entry.chunks);
  assert.deepEqual(decoded.words, entry.words);
  assert.ok(decoded.vectors instanceof Float32Array);
  assert.deepEqual([...decoded.vectors], [...entry.vectors]);
});

test("sidecar: an entry without vectors (keyword only) round-trips with vectors null", async () => {
  const { encodeSidecar, decodeSidecar } = await load();
  const text = encodeSidecar({ id: "session-2", savedAt: "2026-01-01T00:00:00.000Z", model: null, dims: null, chunks: [], vectors: null, words: ["pricing"] });
  const decoded = decodeSidecar(text);
  assert.equal(decoded.vectors, null);
  assert.equal(decoded.model, null);
  assert.deepEqual(decoded.words, ["pricing"]);
});

test("sidecar: anything damaged decodes to null, never a throw", async () => {
  const { encodeSidecar, decodeSidecar, SEARCH_INDEX_VERSION } = await load();
  const good = JSON.parse(encodeSidecar({ id: "s", dims: D, ...(await entryFor(["x"])) }));
  const variants = [
    "",
    "{",
    "[]",
    "null",
    JSON.stringify({ ...good, version: SEARCH_INDEX_VERSION + 1 }),
    JSON.stringify({ ...good, id: "../etc" }),
    JSON.stringify({ ...good, chunks: "nope" }),
    JSON.stringify({ ...good, chunks: [{ kind: 3 }] }),
    JSON.stringify({ ...good, vectors: "AAAA" }), // 3 bytes: not a whole float, not chunks*dims
    JSON.stringify({ ...good, vectors: Buffer.alloc((good.chunks.length + 1) * D * 4).toString("base64") }),
    JSON.stringify({ ...good, words: [1, 2] }),
    JSON.stringify({ ...good, dims: "x" }),
    JSON.stringify({ ...good, savedAt: 5 }),
  ];
  for (const text of variants) assert.equal(decodeSidecar(text), null, text.slice(0, 60));
  assert.equal(decodeSidecar(undefined), null);
});

test("latency: a flat scan over 2,000 sessions x 25 chunks of 384 dims answers well inside the budget", async () => {
  const { createSearchIndex } = await load();
  const dims = 384;
  const index = createSearchIndex({ dims });
  const unit = (n) => {
    const v = new Float32Array(n * dims);
    for (let i = 0; i < v.length; i++) v[i] = Math.random() - 0.5;
    for (let c = 0; c < n; c++) {
      let norm = 0;
      for (let j = 0; j < dims; j++) norm += v[c * dims + j] ** 2;
      norm = Math.sqrt(norm);
      for (let j = 0; j < dims; j++) v[c * dims + j] /= norm;
    }
    return v;
  };
  for (let s = 0; s < 2000; s++) {
    index.add(`session-${s}`, { savedAt: `2026-01-01T00:00:${String(s % 60).padStart(2, "0")}.000Z`, model: "m", chunks: Array.from({ length: 25 }, (_, i) => ({ kind: "transcript", ref: { lineStart: i, lineEnd: i } })), vectors: unit(25), words: ["w" + (s % 100)] });
  }
  const vector = unit(1);
  index.query({ vector, words: ["w1"], threshold: 0 }); // warm
  const started = performance.now();
  const hits = index.query({ vector, words: ["w1"], threshold: -1, limit: 50 });
  const ms = performance.now() - started;
  assert.equal(hits.length, 50);
  // ~55 ms measured for 50k x 384 in plain JS; the bound leaves room for a busy machine.
  console.log(`[search-index] 50k x 384 query: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 200, `query took ${ms.toFixed(1)} ms`);
});
