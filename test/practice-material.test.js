import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  MAX_PROBLEM_STATEMENT_CHARS,
  PracticeMaterialError,
  createPracticeMaterialStore,
  validateProblemStatement,
} from "../src/desktop/practice/material.js";

/** In-memory fs with the five calls the stores use. */
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    mkdir: async () => {},
    stat: async (p) => {
      const body = files.get(p);
      if (body === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { size: Buffer.byteLength(body) };
    },
    readFile: async (p) => {
      const body = files.get(p);
      if (body === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return body;
    },
    writeFile: async (p, body) => void files.set(p, body),
    rename: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlink: async (p) => void files.delete(p),
  };
}

test("validateProblemStatement trims and normalizes, rejects the rest", () => {
  assert.equal(validateProblemStatement("  Design a\r\nrate limiter.  "), "Design a\nrate limiter.");
  for (const [value, code] of [
    ["   ", "E_PRACTICE_MATERIAL_EMPTY"],
    ["has\u0000nul", "E_PRACTICE_MATERIAL_NOT_TEXT"],
    ["x".repeat(MAX_PROBLEM_STATEMENT_CHARS + 1), "E_PRACTICE_MATERIAL_TOO_LARGE"],
  ]) {
    assert.throws(() => validateProblemStatement(value), (e) => e instanceof PracticeMaterialError && e.code === code);
  }
});

test("material store round trip, clear, and corrupt handling", async () => {
  const dir = path.resolve("/tmp/practice-test");
  const fs = memoryFs();
  const store = createPracticeMaterialStore({ userDataDir: dir, fs, now: () => new Date("2026-10-15T10:00:00Z") });
  const saved = await store.save({ problemStatement: "Design a rate limiter." });
  assert.equal(saved.problemStatement, "Design a rate limiter.");
  assert.equal(saved.savedAt, "2026-10-15T10:00:00.000Z");
  assert.deepEqual((await store.load()).material, saved);
  await store.clear();
  assert.deepEqual(await store.load(), { material: null, readError: null });

  fs.files.set(path.join(dir, "practice-material.json"), "{corrupt");
  assert.equal((await store.load()).material, null);
  assert.equal((await store.load()).readError, "The saved practice material couldn't be read. Paste it again.");
});
