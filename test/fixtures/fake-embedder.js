/**
 * A deterministic stand-in for the ONNX sentence embedder (src/desktop/recap/embedder.js).
 *
 * Same shape as the real one: { id, dims, embed(texts) -> Float32Array[], dispose() }.
 * Vectors are a hashed bag of words with a small synonym table folded in, so
 * "cost" lands near "pricing" and far from "kubernetes": tests can assert
 * TOPIC ranking, not just word matching, without a model or the network.
 *
 * Knobs: `delayMs` (async ordering / stale replies), `failOn(text)` (a throw
 * from the middle of a batch), `calls` (every batch, in order).
 * createUnavailableEmbedder() rejects from create(), the "no onnxruntime-node
 * / no model file" path.
 */
export const FAKE_EMBEDDER_ID = "fake-bow-v1";
export const FAKE_EMBEDDER_DIMS = 128;

export const FAKE_SYNONYMS = Object.freeze({
  cost: "pricing",
  costs: "pricing",
  price: "pricing",
  prices: "pricing",
  pricing: "pricing",
  discount: "pricing",
  quote: "pricing",
  budget: "pricing",
  sso: "authentication",
  saml: "authentication",
  oidc: "authentication",
  login: "authentication",
  "sign-on": "authentication",
  okta: "authentication",
  authentication: "authentication",
  gdpr: "compliance",
  soc2: "compliance",
  hipaa: "compliance",
  compliance: "compliance",
  audit: "compliance",
  kubernetes: "infrastructure",
  k8s: "infrastructure",
  docker: "infrastructure",
  deployment: "infrastructure",
  deploy: "infrastructure",
  infrastructure: "infrastructure",
  migrate: "migration",
  migration: "migration",
  import: "migration",
  onboarding: "migration",
});

/** Filler that every chunk shares (the speaker labels, function words): it would make all chunks alike. */
const FAKE_STOPWORDS = new Set(
  "prospect you the a an and or of to in on at for is are was were be it its we our your this that with from by as do does did have has had not but if so what how much can could would should will there here".split(" "),
);

function hash(word) {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export function fakeTokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length > 1 && !FAKE_STOPWORDS.has(word))
    .map((word) => FAKE_SYNONYMS[word] ?? word);
}

/** The vector for one text: hashed bag of canonical words, L2-normalised (a zero vector for no words). */
export function fakeVector(text, dims = FAKE_EMBEDDER_DIMS) {
  const vector = new Float32Array(dims);
  for (const word of fakeTokens(text)) vector[hash(word) % dims] += 1;
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dims; i++) vector[i] /= norm;
  return vector;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ delayMs?: number, failOn?: (text: string) => boolean, dims?: number }} [options]
 */
export function createFakeEmbedder({ delayMs = 0, failOn = null, dims = FAKE_EMBEDDER_DIMS } = {}) {
  const calls = [];
  let disposed = false;
  return {
    id: FAKE_EMBEDDER_ID,
    dims,
    calls,
    async embed(texts) {
      if (disposed) throw new Error("fake embedder disposed");
      if (!Array.isArray(texts)) throw new TypeError("embed takes an array of strings");
      calls.push([...texts]);
      if (delayMs > 0) await sleep(delayMs);
      return texts.map((text) => {
        if (failOn && failOn(text)) throw new Error(`fake embedder failed on "${text}"`);
        return fakeVector(text, dims);
      });
    },
    /** The real embedder prefixes a query for models that want it; the fake has no prefix. */
    async embedQuery(text) {
      const [vector] = await this.embed([typeof text === "string" ? text : ""]);
      return vector;
    },
    async dispose() {
      disposed = true;
    },
    get disposed() {
      return disposed;
    },
  };
}

/** What createOnnxEmbedder()'s create() does without onnxruntime-node or the model file. */
export function createUnavailableEmbedder(message = "onnxruntime-node is unavailable") {
  return {
    async create() {
      const error = new Error(message);
      error.code = "E_EMBEDDER_UNAVAILABLE";
      throw error;
    },
  };
}
