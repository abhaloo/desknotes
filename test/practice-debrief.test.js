import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildDebrief, firstSentence, formatDebrief } from "../src/desktop/practice/debrief.js";
import {
  MAX_DEBRIEF_BYTES,
  PRACTICE_DEBRIEF_FILENAME,
  PracticeDebriefError,
  createPracticeDebriefStore,
} from "../src/desktop/practice-debrief.js";
// Inline a COPY of memoryFs from practice-material.test.js (node --test runs
// test files independently; never import across test files).
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

const record = {
  startedAt: "2026-10-15T10:00:00.000Z",
  endedAt: "2026-10-15T10:12:00.000Z",
  material: { problemStatement: "Design a rate limiter.", docsName: null },
  questions: [
    {
      id: "q_1",
      question: "How would you shard it?",
      evidence: { band: "question", p: 0.93, source: "judge", reason: "judge is_question p=0.93" },
      utterance: { text: "How would you shard it?", at: "2026-10-15T10:01:00.000Z" },
      answer: "Start with a fixed window per key. Then move to a sliding log if accuracy matters.",
      status: "done",
      startedAt: "2026-10-15T10:01:00.000Z",
      endedAt: "2026-10-15T10:01:02.000Z",
    },
    {
      id: "q_2",
      question: "What about failure modes?",
      evidence: { band: "question", p: 0.8, source: "judge", reason: "judge is_question p=0.80" },
      utterance: { text: "What about failure modes?", at: "2026-10-15T10:02:00.000Z" },
      answer: "half an answer",
      status: "cut",
      startedAt: "2026-10-15T10:02:00.000Z",
      endedAt: "2026-10-15T10:02:01.000Z",
    },
  ],
  skipped: [
    {
      text: "so the pricing then",
      evidence: { band: "maybe", p: 0.31, source: "judge", reason: "judge is_question p=0.31" },
      at: "2026-10-15T10:03:00.000Z",
    },
    {
      text: "yeah that makes sense",
      evidence: { band: "small-talk", p: 0.05, source: "judge", reason: "judge is_question p=0.05" },
      at: "2026-10-15T10:04:00.000Z",
    },
  ],
};

test("firstSentence", () => {
  assert.equal(firstSentence("One. Two more! Three?"), "One.");
  assert.equal(firstSentence("no terminator"), "no terminator");
  assert.equal(firstSentence("  "), "");
});

test("buildDebrief derives covered, gaps and stats — no invented topics", () => {
  const debrief = buildDebrief(record, { now: () => new Date("2026-10-15T10:12:05Z") });
  assert.deepEqual(debrief.covered, ["How would you shard it? — Start with a fixed window per key."]);
  assert.equal(debrief.gaps.length, 2); // the maybe-skip and the cut answer
  assert.match(debrief.gaps[0], /Maybe a question \(judge is_question p=0\.31\): "so the pricing then"/);
  assert.match(debrief.gaps[1], /cut off.*What about failure modes\?/);
  assert.deepEqual(debrief.stats, { questions: 2, answered: 1, skipped: 2, maybe: 1 });
  assert.equal(debrief.problemStatement, "Design a rate limiter.");
});

test("formatDebrief renders the readable document with the detection log", () => {
  const text = formatDebrief(buildDebrief(record, { now: () => new Date("2026-10-15T10:12:05Z") }));
  assert.match(text, /Practice rehearsal only\. These answers are study material, not live assistance\./);
  assert.match(text, /1\. Question: How would you shard it\?/);
  assert.match(text, /Detected: judge is_question p=0\.93 \[judge\]/);
  assert.match(text, /What was covered/);
  assert.match(text, /Gaps/);
  assert.match(text, /Detection log/);
  assert.match(text, /maybe\s+judge is_question p=0\.31\s+"so the pricing then"/);
});

test("the detection log lists every utterance with its decision", () => {
  const debrief = buildDebrief(record, { now: () => new Date("2026-10-15T10:12:05Z") });
  assert.deepEqual(
    debrief.detectionLog.map((entry) => entry.text),
    ["How would you shard it?", "What about failure modes?", "so the pricing then", "yeah that makes sense"],
  );
  assert.equal(debrief.detectionLog[2].band, "maybe");
});

test("empty session: no questions is itself a gap", () => {
  const empty = buildDebrief({
    startedAt: "2026-10-15T10:00:00.000Z",
    endedAt: "2026-10-15T10:01:00.000Z",
    material: { problemStatement: "p", docsName: null },
    questions: [],
    skipped: [],
  });
  assert.deepEqual(empty.covered, []);
  assert.match(empty.gaps[0], /No questions were detected/);
});

test("debrief store saves the document text and round trips", async () => {
  const dir = path.resolve("/tmp/practice-debrief-test");
  const fs = memoryFs();
  const store = createPracticeDebriefStore({ userDataDir: dir, fs, now: () => new Date("2026-10-15T10:12:05Z") });
  const debrief = buildDebrief(record, { now: () => new Date("2026-10-15T10:12:05Z") });
  const { savedAt } = await store.save(debrief);
  assert.equal(savedAt, "2026-10-15T10:12:05.000Z");
  const loaded = await store.load();
  assert.equal(loaded.debrief.title, debrief.title);
  assert.equal(loaded.debrief.text, formatDebrief(debrief));
  assert.equal(loaded.readError, null);

  fs.files.set(path.join(dir, PRACTICE_DEBRIEF_FILENAME), "not json");
  assert.equal((await store.load()).debrief, null);
  assert.equal((await store.load()).readError, "The saved debrief couldn't be read.");
});

test("the size cap is enforced before writing, never after", async () => {
  const dir = path.resolve("/tmp/practice-debrief-cap-test");
  const fs = memoryFs();
  const store = createPracticeDebriefStore({ userDataDir: dir, fs, now: () => new Date("2026-10-15T10:12:05Z") });
  const huge = buildDebrief(record, { now: () => new Date("2026-10-15T10:12:05Z") });
  huge.questions[0].answer = "x".repeat(MAX_DEBRIEF_BYTES);
  await assert.rejects(
    () => store.save(huge),
    (error) => error instanceof PracticeDebriefError && error.code === "E_PRACTICE_SAVE",
  );
  assert.equal(fs.files.size, 0, "an oversized debrief is never written");
});
