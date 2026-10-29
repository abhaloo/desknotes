/**
 * Download the session-search model into third_party/all-MiniLM-L6-v2/.
 *
 *   node scripts/fetch-embedder.mjs            # int8 model (~23 MB) + vocab
 *   node scripts/fetch-embedder.mjs --fp32     # the full-precision model (~90 MB) instead
 *   node scripts/fetch-embedder.mjs --dir D:\models\minilm
 *
 * The model is not in the repository and the tests never fetch it: without
 * it, Session history search matches words only. all-MiniLM-L6-v2 is
 * Apache-2.0 (sentence-transformers; the int8 export is from Xenova). The
 * files are downloaded over HTTPS from huggingface.co, written to a temp
 * name and renamed when complete, so a broken download never leaves a
 * half-written model.onnx behind.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES = Object.freeze({
  int8: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx",
  fp32: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
  vocab: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/vocab.txt",
});

const NOTICE = `all-MiniLM-L6-v2 — sentence embedding model for Session history search.

- Source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 (Apache License 2.0)
- int8 ONNX export: https://huggingface.co/Xenova/all-MiniLM-L6-v2 (Apache License 2.0)
- Used unchanged by src/desktop/recap/embedder.js via onnxruntime-node.
- Fetched by scripts/fetch-embedder.mjs; not part of the repository.
`;

function parseArgs(argv) {
  const args = { fp32: false, dir: join(root, "third_party", "all-MiniLM-L6-v2") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fp32") args.fp32 = true;
    else if (argv[i] === "--dir") args.dir = resolve(argv[++i] ?? "");
    else if (argv[i].startsWith("--dir=")) args.dir = resolve(argv[i].slice("--dir=".length));
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

async function download(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const temp = `${target}.download`;
  await rm(temp, { force: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  await rename(temp, target);
  const { size } = await stat(target);
  return size;
}

const args = parseArgs(process.argv.slice(2));
await mkdir(args.dir, { recursive: true });
const files = [
  [args.fp32 ? SOURCES.fp32 : SOURCES.int8, join(args.dir, "model.onnx")],
  [SOURCES.vocab, join(args.dir, "vocab.txt")],
];
for (const [url, target] of files) {
  process.stdout.write(`${url}\n  -> ${target} … `);
  const size = await download(url, target);
  process.stdout.write(`${(size / 1e6).toFixed(1)} MB\n`);
}
await pipeline(Readable.from([NOTICE]), createWriteStream(join(args.dir, "NOTICE.txt")));
process.stdout.write(`\nDone. Session history search will use the model at its next launch.\nCheck it with: node test/live/recap-search-embedder.mjs\n`);
