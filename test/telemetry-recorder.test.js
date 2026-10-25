import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join, sep } from "node:path";
import { createSessionRecorder, recorderOptionsFromEnv } from "../src/server/telemetry/session-recorder.js";
import { buildEngineConfig } from "../src/server/engines/config.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CAP_BYTES = 32 * 1024 * 1024;
const START = Date.parse("2026-01-02T03:04:05.000Z");
const STAMP = "2026-01-02T03-04-05.000Z";
const DIR = join(process.cwd(), "telemetry-test-dir");

/** Injectable ms clock: construction and every record() read it. */
function msClock(start = START) {
  let value = start;
  const now = () => value;
  now.advance = (ms) => {
    value += ms;
    return value;
  };
  return now;
}

/**
 * In-memory fs double. `files` maps absolute path -> { content, mtimeMs };
 * `calls` records every operation so a test can prove what was touched.
 */
function fakeFs({ files = new Map(), mode = "async" } = {}) {
  const calls = [];
  const append = (path, data) => {
    const entry = files.get(path) ?? { content: "", mtimeMs: 0 };
    entry.content += String(data);
    files.set(path, entry);
  };
  return {
    calls,
    files,
    mkdirSync(dir, options) {
      calls.push({ op: "mkdirSync", dir, options });
    },
    readdirSync(dir) {
      calls.push({ op: "readdirSync", dir });
      return [...files.keys()]
        .filter((path) => path.startsWith(dir + sep) || path.startsWith(dir + "/"))
        .map((path) => path.slice(dir.length + 1))
        .filter((name) => name.length > 0 && !name.includes(sep) && !name.includes("/"));
    },
    statSync(path) {
      calls.push({ op: "statSync", path });
      const entry = files.get(path);
      if (!entry) throw new Error(`ENOENT: ${path}`);
      return { mtimeMs: entry.mtimeMs };
    },
    unlinkSync(path) {
      calls.push({ op: "unlinkSync", path });
      files.delete(path);
    },
    appendFile(path, data) {
      calls.push({ op: "appendFile", path, bytes: Buffer.byteLength(String(data)) });
      if (mode === "sync") {
        append(path, data);
        return undefined;
      }
      return Promise.resolve().then(() => append(path, data));
    },
  };
}

function filePathFor(sessionId) {
  return join(DIR, `${STAMP}-${sessionId ?? "nosession"}.jsonl`);
}

function linesOf(fs, path) {
  return fs.files
    .get(path)
    .content.trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("recorderOptionsFromEnv: off by default, on only when SESSION_TELEMETRY is 1, true, or on", () => {
  assert.deepEqual(recorderOptionsFromEnv({}), {
    enabled: false,
    dir: join(process.cwd(), "logs", "telemetry"),
    keepDays: 7,
  });
  for (const value of [undefined, "", "0", "false", "off", "yes", "01", "nope"]) {
    assert.equal(recorderOptionsFromEnv({ SESSION_TELEMETRY: value }).enabled, false, `expected disabled for ${value}`);
  }
  for (const value of ["1", "true", "on", " 1 ", "TRUE", "On"]) {
    assert.equal(recorderOptionsFromEnv({ SESSION_TELEMETRY: value }).enabled, true, `expected enabled for ${value}`);
  }

  assert.equal(recorderOptionsFromEnv({ SESSION_TELEMETRY_DIR: "C:\\logs" }).dir, "C:\\logs");
  assert.equal(recorderOptionsFromEnv({ SESSION_TELEMETRY_DIR: "" }).dir, join(process.cwd(), "logs", "telemetry"));
  assert.equal(recorderOptionsFromEnv({}, { dir: "C:\\default\\logs" }).dir, "C:\\default\\logs");
  assert.equal(recorderOptionsFromEnv({ SESSION_TELEMETRY_DIR: "C:\\override" }, { dir: "C:\\default\\logs" }).dir, "C:\\override");
  for (const value of ["7", "3.9"]) {
    assert.equal(recorderOptionsFromEnv({ SESSION_TELEMETRY_KEEP_DAYS: value }).keepDays, Number.parseInt(value, 10));
  }
  for (const value of [undefined, "", "0", "-1", "nope"]) {
    assert.equal(recorderOptionsFromEnv({ SESSION_TELEMETRY_KEEP_DAYS: value }).keepDays, 7);
  }
});

test("createSessionRecorder: off by default, writes no files without opt-in", async () => {
  const fs = fakeFs();
  const rec = createSessionRecorder({ dir: DIR, fs, now: msClock() });
  rec.record({ type: "turn.start", sessionId: "s" });
  await rec.flush();
  await rec.close();
  assert.deepEqual(fs.calls, [], "expected no filesystem calls without opt-in");
});

test("buildEngineConfig wires telemetryOptions with logging off by default", () => {
  const config = buildEngineConfig({}, { mode: "demo" });
  assert.equal(config.telemetryOptions.enabled, false);
  assert.equal(config.telemetryOptions.keepDays, 7);
  assert.equal(config.telemetryOptions.dir, join(process.cwd(), "logs", "telemetry"));

  const customDir = buildEngineConfig({}, { mode: "demo", telemetryDir: "C:\\custom\\telemetry" });
  assert.equal(customDir.telemetryOptions.dir, "C:\\custom\\telemetry");
  assert.equal(customDir.telemetryOptions.enabled, false);

  const optedIn = buildEngineConfig({ SESSION_TELEMETRY: "1" }, { mode: "demo" });
  assert.equal(optedIn.telemetryOptions.enabled, true);
});

test("disabled: record/flush/close touch no filesystem", async () => {
  const fs = new Proxy(
    {},
    {
      get() {
        throw new Error("filesystem touched while disabled");
      },
    },
  );
  const rec = createSessionRecorder({ enabled: false, dir: DIR, fs, now: msClock() });
  assert.doesNotThrow(() => rec.record({ type: "turn.start", sessionId: "s" }));
  await rec.flush();
  await rec.close();
  await rec.close();
});

test("enabled: meta first, one stamped JSON line per record, sessionId preserved", async () => {
  const fs = fakeFs();
  const now = msClock();
  const rec = createSessionRecorder({ enabled: true, dir: DIR, fs, now, keepDays: 2 });

  now.advance(5);
  rec.record({ type: "turn.start", sessionId: "sess-1", turn_id: 1 });
  now.advance(5);
  rec.record({ type: "turn.end", sessionId: "sess-1", turn_id: 1 });
  await rec.flush();

  const path = filePathFor("sess-1");
  const lines = linesOf(fs, path);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], {
    type: "telemetry.meta",
    version: 1,
    sessionId: "sess-1",
    startedAt: new Date(START).toISOString(),
    keepDays: 2,
  });
  assert.equal(lines[1].type, "turn.start");
  assert.equal(lines[1].sessionId, "sess-1");
  assert.equal(lines[1].ts, new Date(START + 5).toISOString());
  assert.equal(lines[1].monoMs, 5);
  assert.equal(lines[2].monoMs, 10);

  // Caller-supplied stamps are overwritten by the recorder's own.
  now.advance(1);
  rec.record({ type: "turn.hint", sessionId: "sess-1", ts: "bogus", monoMs: 9999 });
  await rec.flush();
  const last = linesOf(fs, path).at(-1);
  assert.equal(last.ts, new Date(START + 11).toISOString());
  assert.equal(last.monoMs, 11);

  await rec.close();
});

test("the file is named lazily at the first record and falls back to nosession", async () => {
  const fs = fakeFs();
  const rec = createSessionRecorder({ enabled: true, dir: DIR, fs, now: msClock() });
  assert.equal(fs.calls.filter((call) => call.op === "appendFile").length, 0, "construction wrote no file");
  assert.equal(fs.files.size, 0);

  rec.record({ type: "turn.start", sessionId: null });
  await rec.flush();
  const path = filePathFor(null);
  const lines = linesOf(fs, path);
  assert.equal(lines[0].type, "telemetry.meta");
  assert.equal(lines[0].sessionId, null);
  assert.equal(lines[1].sessionId, null);
  await rec.close();
});

test("a session id from the wire cannot leave the telemetry folder", async () => {
  const fs = fakeFs();
  const rec = createSessionRecorder({ enabled: true, dir: DIR, fs, now: msClock() });
  rec.record({ type: "turn.start", sessionId: "..\\..\\escape/../x" });
  await rec.flush();
  const written = [...fs.files.keys()];
  assert.deepEqual(written, [join(DIR, `${STAMP}-______escape____x.jsonl`)]);
  assert.equal(linesOf(fs, written[0])[1].sessionId, "..\\..\\escape/../x", "the record keeps the real id");
  await rec.close();
});

test("real fs: a session writes a readable JSONL file, close is idempotent", async () => {
  const dir = join(os.tmpdir(), `mscp-telemetry-test-${process.pid}-${Date.now()}`);
  const rec = createSessionRecorder({ enabled: true, dir, keepDays: 7, now: msClock() });
  try {
    rec.record({ type: "turn.start", sessionId: "sess-real" });
    await rec.flush();
    await rec.flush();
    const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
    assert.ok(file);
    const lines = readFileSync(join(dir, file), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].type, "telemetry.meta");
    assert.equal(lines[1].type, "turn.start");
    assert.equal(lines[1].sessionId, "sess-real");
  } finally {
    await rec.close();
    await rec.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("purge: old .jsonl files are deleted at construction, fresh and non-jsonl kept", async () => {
  const now = msClock();
  const files = new Map([
    [join(DIR, "old.jsonl"), { content: "", mtimeMs: START - 8 * DAY_MS }],
    [join(DIR, "fresh.jsonl"), { content: "", mtimeMs: START - 1 * DAY_MS }],
    [join(DIR, "old.txt"), { content: "", mtimeMs: START - 30 * DAY_MS }],
  ]);
  const fs = fakeFs({ files });
  const rec = createSessionRecorder({ enabled: true, dir: DIR, fs, now, keepDays: 7 });
  assert.equal(fs.files.has(join(DIR, "old.jsonl")), false);
  assert.equal(fs.files.has(join(DIR, "fresh.jsonl")), true);
  assert.equal(fs.files.has(join(DIR, "old.txt")), true);
  assert.ok(fs.calls.some((call) => call.op === "mkdirSync" && call.options?.recursive === true));
  await rec.close();
});

test("cap: the file stops at 32 MiB with a telemetry.truncated tail", async () => {
  const fs = fakeFs();
  const rec = createSessionRecorder({ enabled: true, dir: DIR, fs, now: msClock() });
  const filler = "x".repeat(8 * 1024 * 1024);
  for (let i = 0; i < 5; i += 1) {
    rec.record({ type: "bulk", sessionId: "sess-cap", payload: filler });
    await rec.flush();
  }
  const path = filePathFor("sess-cap");
  const content = fs.files.get(path).content;
  const lines = linesOf(fs, path);
  assert.equal(lines[0].type, "telemetry.meta");
  assert.equal(lines.at(-1).type, "telemetry.truncated");
  assert.equal(typeof lines.at(-1).ts, "string");
  assert.ok(Buffer.byteLength(content) <= CAP_BYTES + 200, "file stays at the cap");

  const frozen = content.length;
  rec.record({ type: "bulk", sessionId: "sess-cap", payload: filler });
  await rec.flush();
  await rec.close();
  assert.equal(fs.files.get(path).content.length, frozen, "no writes after truncation");
});

test("never throws: one rejected appendFile logs one telemetry.error, then silent", async () => {
  const fs = fakeFs();
  let attempts = 0;
  const appendFile = fs.appendFile;
  fs.appendFile = (path, data) => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error("disk full"));
    return appendFile(path, data);
  };
  const logs = [];
  const rec = createSessionRecorder({
    enabled: true,
    dir: DIR,
    fs,
    now: msClock(),
    log: (entry) => logs.push(entry),
  });

  assert.doesNotThrow(() => rec.record({ type: "turn.start", sessionId: "s" }));
  await rec.flush();
  assert.deepEqual(logs, [{ type: "telemetry.error", message: "disk full" }]);

  rec.record({ type: "turn.end", sessionId: "s" });
  await rec.flush();
  await rec.close();
  await rec.close();
  assert.equal(logs.length, 1, "one error, then no-op");
  assert.equal(attempts, 1, "no further disk attempts");
});

test("a serialization failure logs once and no-ops", async () => {
  const fs = fakeFs();
  const logs = [];
  const rec = createSessionRecorder({
    enabled: true,
    dir: DIR,
    fs,
    now: msClock(),
    log: (entry) => logs.push(entry),
  });
  assert.doesNotThrow(() => rec.record({ type: "bad", sessionId: "s", count: 1n }));
  await rec.flush();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].type, "telemetry.error");
  rec.record({ type: "after", sessionId: "s" });
  await rec.close();
  assert.equal(logs.length, 1);
  assert.equal(fs.calls.filter((call) => call.op === "appendFile").length, 0);
});

test("redaction: credential-shaped fields are replaced, the caller's event untouched", async () => {
  const fs = fakeFs();
  const rec = createSessionRecorder({ enabled: true, dir: DIR, fs, now: msClock() });
  const event = {
    type: "pipeline.event",
    sessionId: "sess-redact",
    apiKey: "sk-live",
    token: "t0k",
    secret: "s",
    password: "p",
    authorization: "Bearer z",
    nested: { clientSecret: "cs", note: "keep" },
    ok: true,
  };
  rec.record(event);
  await rec.flush();

  const line = linesOf(fs, filePathFor("sess-redact")).at(-1);
  for (const field of ["apiKey", "token", "secret", "password", "authorization"]) {
    assert.equal(line[field], "[redacted]", field);
  }
  assert.equal(line.nested.clientSecret, "[redacted]");
  assert.equal(line.nested.note, "keep");
  assert.equal(line.ok, true);
  assert.equal(event.apiKey, "sk-live");
  assert.equal(event.nested.clientSecret, "cs");
  await rec.close();
});

test("overflow: more than 20,000 buffered events drop the oldest and emit a dropped line", async () => {
  const fs = fakeFs();
  const rec = createSessionRecorder({ enabled: true, dir: DIR, fs, now: msClock() });
  for (let i = 0; i < 20_005; i += 1) {
    rec.record({ type: "flood", sessionId: "sess-flood", seq: i });
  }
  await rec.flush();

  const lines = linesOf(fs, filePathFor("sess-flood"));
  assert.equal(lines[0].type, "telemetry.meta");
  assert.deepEqual(lines[1], { type: "telemetry.dropped", count: 5 });
  assert.equal(lines.length, 20_002);
  assert.equal(lines[2].seq, 5, "oldest events were dropped first");
  assert.equal(lines.at(-1).seq, 20_004);
  await rec.close();
});
