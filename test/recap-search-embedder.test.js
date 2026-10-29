import test from "node:test";
import assert from "node:assert/strict";

/**
 * Session search, phase 2: the local sentence embedder.
 *
 *   recap/wordpiece.js  — BERT uncased tokenization (the one all-MiniLM-L6-v2 uses), pure:
 *     createWordPiece({ vocab, maxTokens }) -> { encode(text) -> { ids, mask }, vocabSize }
 *     Lowercase, accents stripped, punctuation split off, greedy longest-match
 *     pieces with "##", [CLS] ... [SEP], [UNK] for a word no pieces cover,
 *     truncated to maxTokens with [SEP] kept last.
 *
 *   recap/embedder.js — onnxruntime-node behind the { id, dims, embed(texts), dispose() } shape
 *     the fake (test/fixtures/fake-embedder.js) shares. create() loads the
 *     runtime lazily and fails with E_EMBEDDER_UNAVAILABLE when the runtime
 *     or the model files are missing, so search falls back to words. Mean
 *     pooling over the attention mask, then L2-normalised, so the index's
 *     dot product is a cosine. A stub runtime stands in for ORT here; the
 *     real model runs only in test/live/recap-search-embedder.mjs, by hand.
 */
const loadWordPiece = () => import("../src/desktop/recap/wordpiece.js");
const loadEmbedder = () => import("../src/desktop/recap/embedder.js");

const VOCAB = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", "how", "does", "your", "sso", "work", "with", "ok", "##ta", "?", ",", ".", "pricing", "un", "##aff", "##able", "the", "a", "b", "c", "-", "ing", "##ing", "price", "##s", "200", "seat"];
const id = (piece) => VOCAB.indexOf(piece);

test("wordpiece: lowercase, split punctuation, greedy pieces, [CLS]/[SEP]", async () => {
  const { createWordPiece } = await loadWordPiece();
  const tokenizer = createWordPiece({ vocab: VOCAB, maxTokens: 32 });
  const { ids, mask } = tokenizer.encode("How does your SSO work with Okta?");
  assert.deepEqual(ids, [id("[CLS]"), id("how"), id("does"), id("your"), id("sso"), id("work"), id("with"), id("ok"), id("##ta"), id("?"), id("[SEP]")]);
  assert.deepEqual(mask, ids.map(() => 1));
  assert.equal(tokenizer.vocabSize, VOCAB.length);
});

test("wordpiece: accents are stripped, a word no pieces cover is [UNK], punctuation runs split char by char", async () => {
  const { createWordPiece } = await loadWordPiece();
  const tokenizer = createWordPiece({ vocab: VOCAB, maxTokens: 32 });
  assert.deepEqual(tokenizer.encode("Pricíng").ids, [id("[CLS]"), id("pricing"), id("[SEP]")]);
  assert.deepEqual(tokenizer.encode("unaffable").ids, [id("[CLS]"), id("un"), id("##aff"), id("##able"), id("[SEP]")]);
  assert.deepEqual(tokenizer.encode("zzzz").ids, [id("[CLS]"), id("[UNK]"), id("[SEP]")]);
  assert.deepEqual(tokenizer.encode("a,.b").ids, [id("[CLS]"), id("a"), id(","), id("."), id("b"), id("[SEP]")]);
  assert.deepEqual(tokenizer.encode("prices seats").ids, [id("[CLS]"), id("price"), id("##s"), id("seat"), id("##s"), id("[SEP]")]);
  assert.deepEqual(tokenizer.encode("").ids, [id("[CLS]"), id("[SEP]")]);
  assert.deepEqual(tokenizer.encode("   \n\t ").ids, [id("[CLS]"), id("[SEP]")]);
  assert.deepEqual(tokenizer.encode(null).ids, [id("[CLS]"), id("[SEP]")]);
});

test("wordpiece: a word longer than 100 characters is [UNK] and a hyphen is its own token", async () => {
  const { createWordPiece } = await loadWordPiece();
  const tokenizer = createWordPiece({ vocab: VOCAB, maxTokens: 32 });
  assert.deepEqual(tokenizer.encode("a".repeat(101)).ids, [id("[CLS]"), id("[UNK]"), id("[SEP]")]);
  assert.deepEqual(tokenizer.encode("a-b").ids, [id("[CLS]"), id("a"), id("-"), id("b"), id("[SEP]")]);
});

test("wordpiece: truncation keeps [CLS] first and [SEP] last", async () => {
  const { createWordPiece } = await loadWordPiece();
  const tokenizer = createWordPiece({ vocab: VOCAB, maxTokens: 5 });
  const { ids, mask } = tokenizer.encode("how does your sso work with okta");
  assert.deepEqual(ids, [id("[CLS]"), id("how"), id("does"), id("your"), id("[SEP]")]);
  assert.equal(mask.length, 5);
});

test("wordpiece: the vocab can be the text of vocab.txt (one piece per line)", async () => {
  const { createWordPiece, parseVocab } = await loadWordPiece();
  const text = `${VOCAB.join("\n")}\n`;
  assert.deepEqual(parseVocab(text), VOCAB);
  assert.deepEqual(parseVocab(`${VOCAB.join("\r\n")}\r\n`), VOCAB, "Windows line endings");
  const tokenizer = createWordPiece({ vocab: parseVocab(text), maxTokens: 16 });
  assert.deepEqual(tokenizer.encode("pricing").ids, [id("[CLS]"), id("pricing"), id("[SEP]")]);
  assert.throws(() => createWordPiece({ vocab: ["a", "b"], maxTokens: 16 }), /\[CLS\]|\[SEP\]|\[UNK\]|\[PAD\]/);
  assert.throws(() => createWordPiece({ vocab: VOCAB, maxTokens: 2 }), /maxTokens/);
});

/* ----------------------------------------------------------------- embedder */

const HIDDEN = 4;

/**
 * A stand-in for onnxruntime-node: records the session options and every
 * feed, answers last_hidden_state [batch, tokens, HIDDEN] where token t of
 * row b is [(b+1), t, mask, 0], so pooling can be checked by hand.
 */
function stubRuntime({ inputNames = ["input_ids", "attention_mask", "token_type_ids"], outputNames = ["last_hidden_state"], fail = null } = {}) {
  const created = [];
  const feeds = [];
  let released = 0;
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const runtime = {
    Tensor,
    InferenceSession: {
      async create(path, options) {
        created.push({ path, options });
        if (fail === "create") throw new Error("bad model");
        return {
          inputNames,
          outputNames,
          async run(feed) {
            feeds.push(feed);
            if (fail === "run") throw new Error("run failed");
            const [batch, tokens] = feed.input_ids.dims;
            const data = new Float32Array(batch * tokens * HIDDEN);
            for (let b = 0; b < batch; b++) {
              for (let t = 0; t < tokens; t++) {
                const mask = Number(feed.attention_mask.data[b * tokens + t]);
                const at = (b * tokens + t) * HIDDEN;
                data[at] = b + 1;
                data[at + 1] = t;
                data[at + 2] = mask;
                data[at + 3] = 0;
              }
            }
            return { [outputNames[0]]: new Tensor("float32", data, [batch, tokens, HIDDEN]) };
          },
          async release() {
            released += 1;
          },
        };
      },
    },
  };
  return { runtime, created, feeds, released: () => released };
}

function files(present = { "model.onnx": true, "vocab.txt": `${VOCAB.join("\n")}\n` }) {
  return {
    existsSync: (path) => Object.keys(present).some((name) => String(path).endsWith(name) && present[name] !== false),
    readFileSync: (path) => {
      const name = Object.keys(present).find((candidate) => String(path).endsWith(candidate));
      if (!name || present[name] === false) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return present[name];
    },
  };
}

const MODEL = { id: "stub-minilm", dims: HIDDEN, pooling: "mean", maxTokens: 8, queryPrefix: "" };

test("embedder: create() loads the runtime lazily, single-threaded, from the model folder's real path", async () => {
  const { createOnnxEmbedder } = await loadEmbedder();
  const stub = stubRuntime();
  let loads = 0;
  const factory = createOnnxEmbedder({
    dir: "C:\\app\\resources\\app.asar\\third_party\\all-MiniLM-L6-v2",
    model: MODEL,
    fs: files(),
    loadRuntime: async () => {
      loads += 1;
      return stub.runtime;
    },
  });
  assert.equal(loads, 0, "nothing is loaded until create()");
  const embedder = await factory.create();
  assert.equal(loads, 1);
  assert.equal(embedder.id, "stub-minilm");
  assert.equal(embedder.dims, HIDDEN);
  assert.equal(stub.created.length, 1);
  assert.ok(stub.created[0].path.includes("app.asar.unpacked"), "ORT reads the file itself: never through the asar");
  assert.ok(stub.created[0].path.endsWith("model.onnx"));
  assert.deepEqual(stub.created[0].options, { intraOpNumThreads: 1, interOpNumThreads: 1 });
});

test("embedder: embed() batches, pads to the longest row, mean-pools over the mask and normalises", async () => {
  const { createOnnxEmbedder } = await loadEmbedder();
  const stub = stubRuntime();
  const embedder = await createOnnxEmbedder({ dir: "/models/m", model: MODEL, fs: files(), loadRuntime: async () => stub.runtime }).create();
  const vectors = await embedder.embed(["how does", "pricing"]);
  assert.equal(stub.feeds.length, 1, "one run for the batch");
  const feed = stub.feeds[0];
  assert.deepEqual(feed.input_ids.dims, [2, 4], "[CLS] how does [SEP] is the longest row");
  assert.equal(feed.input_ids.type, "int64");
  assert.deepEqual([...feed.input_ids.data].map(Number), [id("[CLS]"), id("how"), id("does"), id("[SEP]"), id("[CLS]"), id("pricing"), id("[SEP]"), id("[PAD]")]);
  assert.deepEqual([...feed.attention_mask.data].map(Number), [1, 1, 1, 1, 1, 1, 1, 0]);
  assert.deepEqual([...feed.token_type_ids.data].map(Number), [0, 0, 0, 0, 0, 0, 0, 0]);

  assert.equal(vectors.length, 2);
  assert.ok(vectors.every((v) => v instanceof Float32Array && v.length === HIDDEN));
  // Row 0: tokens 0..3 all masked in -> mean [1, 1.5, 1, 0] -> normalised.
  const n0 = Math.hypot(1, 1.5, 1, 0);
  assert.deepEqual([...vectors[0]].map((x) => Number(x.toFixed(5))), [1 / n0, 1.5 / n0, 1 / n0, 0].map((x) => Number(x.toFixed(5))));
  // Row 1: only tokens 0..2 count -> mean [2, 1, 1, 0]; the padded token (t=3) is left out.
  const n1 = Math.hypot(2, 1, 1, 0);
  assert.deepEqual([...vectors[1]].map((x) => Number(x.toFixed(5))), [2 / n1, 1 / n1, 1 / n1, 0].map((x) => Number(x.toFixed(5))));
});

test("embedder: the batch size bounds one run; an empty list runs nothing; non-strings are rejected", async () => {
  const { createOnnxEmbedder } = await loadEmbedder();
  const stub = stubRuntime();
  const embedder = await createOnnxEmbedder({ dir: "/models/m", model: MODEL, fs: files(), loadRuntime: async () => stub.runtime, batchSize: 2 }).create();
  const vectors = await embedder.embed(["a", "b", "c", "how does your"]);
  assert.equal(vectors.length, 4);
  assert.equal(stub.feeds.length, 2);
  assert.deepEqual(stub.feeds[0].input_ids.dims, [2, 3]);
  assert.deepEqual(stub.feeds[1].input_ids.dims, [2, 5]);
  assert.deepEqual(await embedder.embed([]), []);
  assert.equal(stub.feeds.length, 2);
  await assert.rejects(() => embedder.embed("a"), /array/);
  await assert.rejects(() => embedder.embed([1]), /string/);
});

test("embedder: a query prefix is applied by embedQuery only; text is truncated to maxTokens", async () => {
  const { createOnnxEmbedder } = await loadEmbedder();
  const stub = stubRuntime();
  const embedder = await createOnnxEmbedder({ dir: "/models/m", model: { ...MODEL, queryPrefix: "pricing " }, fs: files(), loadRuntime: async () => stub.runtime }).create();
  await embedder.embedQuery("how");
  assert.deepEqual([...stub.feeds[0].input_ids.data].map(Number), [id("[CLS]"), id("pricing"), id("how"), id("[SEP]")]);
  await embedder.embed(["how does your sso work with okta ? , ."]);
  assert.deepEqual(stub.feeds[1].input_ids.dims, [1, MODEL.maxTokens]);
  assert.equal(Number(stub.feeds[1].input_ids.data[MODEL.maxTokens - 1]), id("[SEP]"));
});

test("embedder: token_type_ids is only fed when the model asks for it; the first output is the hidden state", async () => {
  const { createOnnxEmbedder } = await loadEmbedder();
  const stub = stubRuntime({ inputNames: ["input_ids", "attention_mask"], outputNames: ["token_embeddings"] });
  const embedder = await createOnnxEmbedder({ dir: "/models/m", model: MODEL, fs: files(), loadRuntime: async () => stub.runtime }).create();
  const [vector] = await embedder.embed(["pricing"]);
  assert.ok(!("token_type_ids" in stub.feeds[0]));
  assert.ok(vector.length === HIDDEN && Math.abs(Math.hypot(...vector) - 1) < 1e-5);
});

test("embedder: unavailable runtime, missing model or vocab, and a failed load all reject with E_EMBEDDER_UNAVAILABLE", async () => {
  const { createOnnxEmbedder } = await loadEmbedder();
  const cases = [
    ["no runtime", { fs: files(), loadRuntime: async () => { throw new Error("Cannot find module 'onnxruntime-node'"); } }],
    ["no model", { fs: files({ "model.onnx": false, "vocab.txt": VOCAB.join("\n") }), loadRuntime: async () => stubRuntime().runtime }],
    ["no vocab", { fs: files({ "model.onnx": true, "vocab.txt": false }), loadRuntime: async () => stubRuntime().runtime }],
    ["bad vocab", { fs: files({ "model.onnx": true, "vocab.txt": "a\nb\n" }), loadRuntime: async () => stubRuntime().runtime }],
    ["load fails", { fs: files(), loadRuntime: async () => stubRuntime({ fail: "create" }).runtime }],
  ];
  for (const [name, options] of cases) {
    await assert.rejects(
      () => createOnnxEmbedder({ dir: "/models/m", model: MODEL, ...options }).create(),
      (error) => error.code === "E_EMBEDDER_UNAVAILABLE" && typeof error.message === "string" && error.message.length > 0,
      name,
    );
  }
});

test("embedder: a run that fails rejects with E_EMBEDDER_FAILED; dispose releases the session and ends embedding", async () => {
  const { createOnnxEmbedder } = await loadEmbedder();
  const failing = stubRuntime({ fail: "run" });
  const broken = await createOnnxEmbedder({ dir: "/models/m", model: MODEL, fs: files(), loadRuntime: async () => failing.runtime }).create();
  await assert.rejects(() => broken.embed(["x"]), (error) => error.code === "E_EMBEDDER_FAILED");

  const stub = stubRuntime();
  const embedder = await createOnnxEmbedder({ dir: "/models/m", model: MODEL, fs: files(), loadRuntime: async () => stub.runtime }).create();
  await embedder.dispose();
  await embedder.dispose();
  assert.equal(stub.released(), 1);
  await assert.rejects(() => embedder.embed(["x"]), /disposed/);
});

test("embedder: the default model is all-MiniLM-L6-v2 in third_party, 384 dims, mean pooling, no query prefix", async () => {
  const { DEFAULT_EMBEDDER_MODEL, DEFAULT_EMBEDDER_DIR, EMBEDDER_FILES } = await loadEmbedder();
  assert.equal(DEFAULT_EMBEDDER_MODEL.id, "all-MiniLM-L6-v2");
  assert.equal(DEFAULT_EMBEDDER_MODEL.dims, 384);
  assert.equal(DEFAULT_EMBEDDER_MODEL.pooling, "mean");
  assert.equal(DEFAULT_EMBEDDER_MODEL.maxTokens, 256);
  assert.equal(DEFAULT_EMBEDDER_MODEL.queryPrefix, "");
  assert.ok(String(DEFAULT_EMBEDDER_DIR).replaceAll("\\", "/").endsWith("third_party/all-MiniLM-L6-v2"));
  assert.deepEqual(EMBEDDER_FILES, { model: "model.onnx", vocab: "vocab.txt" });
});
