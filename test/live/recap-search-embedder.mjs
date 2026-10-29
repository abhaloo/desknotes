/**
 * Opt-in check of the REAL session-search embedder (onnxruntime-node plus the
 * model scripts/fetch-embedder.mjs installed). Not part of `npm test`.
 *
 *   node test/live/recap-search-embedder.mjs
 *
 * Prints the load time, the per-query latency, a similarity matrix over a
 * few sentences, and checks that topic neighbours (cost / pricing) sit above
 * strangers (pricing / kubernetes). If third_party/all-MiniLM-L6-v2/
 * tokenizer-reference.json exists ({ "<text>": [ids...] }), the in-house
 * WordPiece is compared with it. Make that file once with Python:
 *
 *   from transformers import AutoTokenizer; import json
 *   t = AutoTokenizer.from_pretrained("sentence-transformers/all-MiniLM-L6-v2")
 *   texts = ["How does your SSO work with Okta?", "Pricíng for 200 seats, the annual quote.", "unaffable café naïve — résumé", "东京 tower", "a,.b"]
 *   json.dump({x: t(x)["input_ids"] for x in texts}, open("third_party/all-MiniLM-L6-v2/tokenizer-reference.json", "w"))
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createOnnxEmbedder, DEFAULT_EMBEDDER_DIR, DEFAULT_EMBEDDER_MODEL } from "../../src/desktop/recap/embedder.js";
import { createWordPiece, parseVocab } from "../../src/desktop/recap/wordpiece.js";

const SENTENCES = [
  "How much does it cost for 200 seats?",
  "Prospect: the pricing page says enterprise is custom; can we get a discount?",
  "Does your SSO integration work with Okta and SAML?",
  "We deploy on Kubernetes with Docker images.",
  "What is your SOC 2 and GDPR posture?",
];

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

let failures = 0;
const check = (ok, message) => {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${message}\n`);
  if (!ok) failures += 1;
};

const reference = join(DEFAULT_EMBEDDER_DIR, "tokenizer-reference.json");
if (existsSync(reference)) {
  const tokenizer = createWordPiece({ vocab: parseVocab(readFileSync(join(DEFAULT_EMBEDDER_DIR, "vocab.txt"), "utf8")), maxTokens: DEFAULT_EMBEDDER_MODEL.maxTokens });
  for (const [text, ids] of Object.entries(JSON.parse(readFileSync(reference, "utf8")))) {
    const ours = tokenizer.encode(text).ids;
    check(JSON.stringify(ours) === JSON.stringify(ids), `tokenizer matches the reference for "${text}"${JSON.stringify(ours) === JSON.stringify(ids) ? "" : `\n     ours ${JSON.stringify(ours)}\n     ref  ${JSON.stringify(ids)}`}`);
  }
} else {
  process.stdout.write(`(no ${reference}: tokenizer reference check skipped)\n`);
}

const t0 = performance.now();
let embedder;
try {
  embedder = await createOnnxEmbedder().create();
} catch (error) {
  process.stdout.write(`FAIL ${error.code ?? ""} ${error.message}\n`);
  process.exit(1);
}
process.stdout.write(`loaded ${embedder.id} (${embedder.dims} dims) in ${(performance.now() - t0).toFixed(0)} ms\n`);

const vectors = await embedder.embed(SENTENCES);
for (let i = 0; i < SENTENCES.length; i++) {
  process.stdout.write(`${SENTENCES.map((_, j) => dot(vectors[i], vectors[j]).toFixed(2)).join("  ")}   ${SENTENCES[i]}\n`);
}
check(Math.abs(dot(vectors[0], vectors[0]) - 1) < 1e-4, "vectors are unit length");
check(dot(vectors[0], vectors[1]) > dot(vectors[0], vectors[3]), "cost question is nearer the pricing line than the kubernetes line");
check(dot(vectors[2], vectors[2]) > dot(vectors[2], vectors[4]), "SSO line is nearer itself than compliance");

const queries = ["the call where they pushed back on pricing", "single sign-on", "compliance questions"];
for (const query of queries) {
  const started = performance.now();
  const vector = await embedder.embedQuery(query);
  const ms = performance.now() - started;
  const best = SENTENCES.map((s, i) => [dot(vector, vectors[i]), s]).sort((a, b) => b[0] - a[0])[0];
  process.stdout.write(`query "${query}": ${ms.toFixed(1)} ms -> ${best[0].toFixed(2)} ${best[1]}\n`);
  check(ms < 100, `query embedding under 100 ms (${ms.toFixed(1)} ms)`);
}
await embedder.dispose();
process.exit(failures > 0 ? 1 : 0);
