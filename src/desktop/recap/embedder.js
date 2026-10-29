/**
 * The local sentence embedder for session search: a small BERT-family model
 * (all-MiniLM-L6-v2 by default) through onnxruntime-node, the runtime the
 * VAD already uses (src/vad/index.js). Mean pooling over the attention mask,
 * then L2-normalised, so the index's dot product is a cosine.
 *
 * The shape { id, dims, embed(texts), embedQuery(text), dispose() } is what
 * search.js depends on; test/fixtures/fake-embedder.js has the same shape.
 * createOnnxEmbedder() returns a factory whose create() does the work:
 * nothing is imported or read until then, and the failure modes (no
 * onnxruntime-node, no model folder: the model is fetched by
 * scripts/fetch-embedder.mjs and is not in the repo) are one coded error,
 * E_EMBEDDER_UNAVAILABLE, on which search falls back to words.
 *
 * Single-threaded ORT session, like the VAD: the embedder shares the main
 * process with capture and IPC, and indexing runs only between sessions.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWordPiece, parseVocab } from "./wordpiece.js";

export const EMBEDDER_FILES = Object.freeze({ model: "model.onnx", vocab: "vocab.txt" });
export const DEFAULT_EMBEDDER_MODEL = Object.freeze({ id: "all-MiniLM-L6-v2", dims: 384, pooling: "mean", maxTokens: 256, queryPrefix: "" });
export const DEFAULT_EMBEDDER_DIR = fileURLToPath(new URL("../../../third_party/all-MiniLM-L6-v2", import.meta.url));
export const EMBED_BATCH_SIZE = 8;

const defaultFs = Object.freeze({ existsSync, readFileSync });

export class EmbedderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EmbedderError";
    this.code = code;
  }
}

/**
 * Packaged apps keep native-loadable assets in app.asar.unpacked: Electron's
 * fs answers for the asar path, but ORT's C++ reads the file directly.
 */
function realAssetPath(file) {
  return file.includes("app.asar") && !file.includes("app.asar.unpacked") ? file.replace("app.asar", "app.asar.unpacked") : file;
}

function pool(hidden, mask, batch, tokens, dims, pooling) {
  const vectors = [];
  for (let b = 0; b < batch; b++) {
    const vector = new Float32Array(dims);
    if (pooling === "cls") {
      vector.set(hidden.subarray(b * tokens * dims, b * tokens * dims + dims));
    } else {
      let count = 0;
      for (let t = 0; t < tokens; t++) {
        if (!mask[b * tokens + t]) continue;
        count += 1;
        const at = (b * tokens + t) * dims;
        for (let j = 0; j < dims; j++) vector[j] += hidden[at + j];
      }
      if (count > 0) for (let j = 0; j < dims; j++) vector[j] /= count;
    }
    let norm = 0;
    for (let j = 0; j < dims; j++) norm += vector[j] * vector[j];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let j = 0; j < dims; j++) vector[j] /= norm;
    vectors.push(vector);
  }
  return vectors;
}

/**
 * @param {{ dir?: string, model?: object, fs?: object, loadRuntime?: () => Promise<object>, batchSize?: number }} [options]
 * @returns {{ create: () => Promise<{ id: string, dims: number, embed: Function, embedQuery: Function, dispose: Function }> }}
 */
export function createOnnxEmbedder({ dir = DEFAULT_EMBEDDER_DIR, model = DEFAULT_EMBEDDER_MODEL, fs = defaultFs, loadRuntime = () => import("onnxruntime-node"), batchSize = EMBED_BATCH_SIZE } = {}) {
  const io = fs ?? defaultFs;
  const batchMax = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : EMBED_BATCH_SIZE;

  async function create() {
    const modelPath = realAssetPath(path.join(String(dir), EMBEDDER_FILES.model));
    const vocabPath = realAssetPath(path.join(String(dir), EMBEDDER_FILES.vocab));
    let ort;
    try {
      ort = await loadRuntime();
    } catch (error) {
      throw new EmbedderError("E_EMBEDDER_UNAVAILABLE", `onnxruntime-node is unavailable: ${error?.message ?? error}`);
    }
    if (!io.existsSync(modelPath)) throw new EmbedderError("E_EMBEDDER_UNAVAILABLE", `The search model is not installed (${modelPath}). Run scripts/fetch-embedder.mjs.`);
    if (!io.existsSync(vocabPath)) throw new EmbedderError("E_EMBEDDER_UNAVAILABLE", `The search model's vocab is missing (${vocabPath}).`);
    let tokenizer;
    try {
      tokenizer = createWordPiece({ vocab: parseVocab(String(io.readFileSync(vocabPath, "utf8"))), maxTokens: model.maxTokens });
    } catch (error) {
      throw new EmbedderError("E_EMBEDDER_UNAVAILABLE", `The search model's vocab is unusable: ${error?.message ?? error}`);
    }
    let session;
    try {
      session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 1, interOpNumThreads: 1 });
    } catch (error) {
      throw new EmbedderError("E_EMBEDDER_UNAVAILABLE", `The search model could not be loaded: ${error?.message ?? error}`);
    }
    const inputs = new Set(Array.isArray(session.inputNames) ? session.inputNames : []);
    const output = Array.isArray(session.outputNames) && session.outputNames.length > 0 ? session.outputNames[0] : "last_hidden_state";
    let disposed = false;

    async function runBatch(texts) {
      const encoded = texts.map((text) => tokenizer.encode(text));
      const tokens = Math.max(...encoded.map((row) => row.ids.length));
      const batch = encoded.length;
      const ids = new BigInt64Array(batch * tokens).fill(BigInt(tokenizer.padId));
      const mask = new BigInt64Array(batch * tokens);
      const plainMask = new Uint8Array(batch * tokens);
      encoded.forEach((row, b) => {
        row.ids.forEach((id, t) => {
          ids[b * tokens + t] = BigInt(id);
          mask[b * tokens + t] = 1n;
          plainMask[b * tokens + t] = 1;
        });
      });
      const feeds = {
        input_ids: new ort.Tensor("int64", ids, [batch, tokens]),
        attention_mask: new ort.Tensor("int64", mask, [batch, tokens]),
      };
      if (inputs.has("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(batch * tokens), [batch, tokens]);
      let out;
      try {
        out = await session.run(feeds);
      } catch (error) {
        throw new EmbedderError("E_EMBEDDER_FAILED", `The search model failed: ${error?.message ?? error}`);
      }
      const tensor = out?.[output];
      const dims = Array.isArray(tensor?.dims) ? tensor.dims : null;
      if (!tensor || !dims || dims.length !== 3 || dims[0] !== batch || dims[1] !== tokens || dims[2] !== model.dims) {
        throw new EmbedderError("E_EMBEDDER_FAILED", `The search model returned an unexpected output (${output} ${JSON.stringify(dims)}).`);
      }
      return pool(tensor.data, plainMask, batch, tokens, model.dims, model.pooling);
    }

    async function embed(texts) {
      if (disposed) throw new EmbedderError("E_EMBEDDER_FAILED", "The search model was disposed.");
      if (!Array.isArray(texts)) throw new TypeError("embed takes an array of strings");
      if (!texts.every((text) => typeof text === "string")) throw new TypeError("embed takes an array of strings");
      const vectors = [];
      for (let start = 0; start < texts.length; start += batchMax) {
        vectors.push(...(await runBatch(texts.slice(start, start + batchMax))));
      }
      return vectors;
    }

    return {
      id: model.id,
      dims: model.dims,
      embed,
      async embedQuery(text) {
        const [vector] = await embed([`${model.queryPrefix ?? ""}${typeof text === "string" ? text : ""}`]);
        return vector;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        if (typeof session.release === "function") await session.release();
      },
    };
  }

  return { create };
}
