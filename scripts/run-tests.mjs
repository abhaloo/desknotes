/**
 * Run every test file in its own Bun process and print one summary.
 *
 *   bun scripts/run-tests.mjs                     # every test/*.test.js
 *   bun scripts/run-tests.mjs test/a.test.js ...  # only these files
 *   bun scripts/run-tests.mjs --jobs 4            # four files at a time
 *
 * WHY one process per file: the suite uses `node:test`, and Bun's node:test
 * layer fails a file whose tests register while another file's test is still
 * running (ERR_NOT_IMPLEMENTED). `bun test test/` therefore reports failures
 * that no file has on its own.
 *
 * `--jobs N` (or TEST_JOBS) runs N files at once. The default is one: some
 * tests bound real-timer latencies in tens of milliseconds, and parallel
 * files on a busy machine can push them past those bounds.
 *
 * Tests never see provider keys: an engine that falls back to a key in the
 * environment (vision reads DEEPSEEK_API_KEY) would otherwise leave its mock,
 * fail on a machine that has keys, and could call a paid API.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE_TIMEOUT_MS = 180_000;
const PROVIDER_KEYS = [
  "DEEPSEEK_API_KEY",
  "CEREBRAS_API_KEY",
  "GROQ_API_KEY",
  "TYPESAFE_API_KEY",
  "OPENAI_API_KEY",
  "LLM_API_KEY",
  "LLM_TECHNICAL_API_KEY",
  "ASR_API_KEY",
  "VISION_API_KEY",
];

function testEnv() {
  const env = { ...process.env };
  for (const key of PROVIDER_KEYS) delete env[key];
  return env;
}

function parseArgs(argv) {
  const files = [];
  let jobs = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--jobs") jobs = argv[++i];
    else if (arg.startsWith("--jobs=")) jobs = arg.slice("--jobs=".length);
    else files.push(arg);
  }
  return { files, jobs };
}

function testFiles(args) {
  if (args.length > 0) return args.map((file) => resolve(file));
  const dir = join(root, "test");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join(dir, name));
}

function jobCount(flag) {
  const requested = Number.parseInt(flag ?? process.env.TEST_JOBS ?? "", 10);
  if (Number.isFinite(requested) && requested > 0) return Math.min(requested, availableParallelism());
  return 1;
}

/** Last "<n> pass" / "<n> fail" counts that `bun test` prints for one file. */
function counts(output) {
  const last = (word) => {
    const matches = [...output.matchAll(new RegExp(`^\\s*(\\d+) ${word}\\b`, "gm"))];
    return matches.length > 0 ? Number(matches[matches.length - 1][1]) : 0;
  };
  return { pass: last("pass"), fail: last("fail") };
}

function runFile(file) {
  return new Promise((done) => {
    const child = spawn("bun", ["test", file], { cwd: root, env: testEnv(), windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      output += `\n[run-tests] timed out after ${FILE_TIMEOUT_MS / 1000}s\n`;
      child.kill();
    }, FILE_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ file, code: 1, output: `${output}\n[run-tests] ${error.message}\n`, ...counts(output) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ file, code: code ?? 1, output, ...counts(output) });
    });
  });
}

const args = parseArgs(process.argv.slice(2));
const files = testFiles(args.files);
const queue = [...files];
const results = [];
const started = Date.now();

async function worker() {
  while (queue.length > 0) {
    const result = await runFile(queue.shift());
    results.push(result);
    const name = relative(root, result.file);
    const ok = result.code === 0 && result.fail === 0;
    process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name} (${result.pass} pass, ${result.fail} fail)\n`);
  }
}

await Promise.all(Array.from({ length: Math.min(jobCount(args.jobs), files.length) }, worker));

const failed = results.filter((result) => result.code !== 0 || result.fail > 0);
for (const result of failed) {
  process.stdout.write(`\n===== ${relative(root, result.file)} =====\n${result.output.trim()}\n`);
}
const pass = results.reduce((sum, result) => sum + result.pass, 0);
const fail = results.reduce((sum, result) => sum + result.fail, 0);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
process.stdout.write(`\n${files.length} files, ${pass} pass, ${fail} fail, ${failed.length} files failed (${seconds}s)\n`);
process.exitCode = failed.length > 0 ? 1 : 0;
