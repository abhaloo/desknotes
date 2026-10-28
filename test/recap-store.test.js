import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, unlink, writeFile, mkdir, rename, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Session recap, phase 3: the store (src/desktop/recap/store.js). Same
 * discipline as practice-debrief.js / grounding-document.js: absolute
 * main-owned userDataDir, injected fs, atomicReplace, size cap before write,
 * corrupt file -> readError (never a throw from list()).
 *
 * Layout: <userData>/sessions/<startedAt with ":" -> "-">-<id>.json, one file per
 * session and nothing else: list() reads the folder, so the files are the only
 * source of truth and a file dropped in or removed by hand is simply seen.
 *
 *   createRecapStore({ userDataDir, fs?, now?, maxBytes? })
 *     -> { save(recap) -> summary, get(id) -> { recap|null, readError },
 *          list() -> { sessions: summary[], readError }, remove(id) -> { removed },
 *          clear() -> { removed: n } }
 *   summary = { id, startedAt, endedAt, durationMs, endReason, stats, savedAt }
 */
const load = () => import("../src/desktop/recap/store.js");

const T0 = Date.parse("2026-10-28T14:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "recap-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function recap(n, fields = {}) {
  const startedAt = iso(T0 + n * 3_600_000);
  return {
    version: 1,
    id: `session-${n}`,
    startedAt,
    endedAt: iso(T0 + n * 3_600_000 + 60_000),
    durationMs: 60_000,
    endReason: "user",
    truncated: false,
    dropped: { lines: 0 },
    failed: false,
    lines: [{ type: "transcript", role: "prospect", source: "system", text: `Question ${n}?`, segmentId: "s1", at: startedAt, offsetMs: 0, heardAt: startedAt, heardOffsetMs: 0 }],
    turns: [],
    questions: [],
    gaps: [],
    terms: [],
    stats: { lines: 1, prospectLines: 1, repLines: 0, turns: 0, questions: 0, answered: 0, gaps: 0, terms: 0 },
    ...fields,
  };
}

const sessionsDir = (dir) => path.join(dir, "sessions");

test("store: constants and the file-name rule", async () => {
  const mod = await load();
  assert.equal(mod.RECAP_DIRNAME, "sessions");
  assert.equal(mod.RECAP_FILE_VERSION, 1);
  assert.equal(mod.MAX_RECAP_BYTES, 8 * 1024 * 1024);
  assert.equal(mod.recapFileName(recap(0)), "2026-10-28T14-00-00.000Z-session-0.json");
});

test("store: userDataDir must be absolute", async () => {
  const { createRecapStore } = await load();
  assert.throws(() => createRecapStore({ userDataDir: "relative/dir" }), (error) => error.code === "E_RECAP_USER_DATA");
});

test("store: save writes one file per session with the readable text, and returns the summary", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    const { formatRecap } = await import("../src/desktop/recap/build.js");
    const store = createRecapStore({ userDataDir: dir, now: () => new Date(T0 + 99_000) });
    const summary = await store.save(recap(0));
    assert.deepEqual(summary, {
      id: "session-0",
      startedAt: iso(T0),
      endedAt: iso(T0 + 60_000),
      durationMs: 60_000,
      endReason: "user",
      stats: recap(0).stats,
      savedAt: iso(T0 + 99_000),
    });
    const file = path.join(sessionsDir(dir), "2026-10-28T14-00-00.000Z-session-0.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.version, 1);
    assert.equal(stored.id, "session-0");
    assert.equal(stored.savedAt, iso(T0 + 99_000));
    assert.equal(stored.text, formatRecap(recap(0)), "the document is saved next to the record");
    const names = await readdir(sessionsDir(dir));
    assert.ok(!names.some((name) => name.endsWith(".tmp")), "atomic replace leaves no temp file");
  }));

test("store: get round-trips the saved recap, text included", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    const store = createRecapStore({ userDataDir: dir });
    await store.save(recap(0));
    const { recap: read, readError } = await store.get("session-0");
    assert.equal(readError, null);
    assert.equal(read.id, "session-0");
    assert.deepEqual(read.lines, recap(0).lines);
    const onDisk = JSON.parse(await readFile(path.join(sessionsDir(dir), "2026-10-28T14-00-00.000Z-session-0.json"), "utf8"));
    assert.equal(read.text, onDisk.text);
  }));

test("store: get of an unknown id is null; an unsafe id is refused", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    const store = createRecapStore({ userDataDir: dir });
    assert.deepEqual(await store.get("session-404"), { recap: null, readError: null });
    for (const bad of ["../app-preferences", "a/b", "a\\b", "", "x".repeat(200), 42, null]) {
      await assert.rejects(store.get(bad), (error) => error.code === "E_RECAP_INVALID_ID", String(bad));
      await assert.rejects(store.remove(bad), (error) => error.code === "E_RECAP_INVALID_ID", String(bad));
    }
  }));

test("store: a corrupt session file reads as a readError, not a throw", async () =>
  withDir(async (dir) => {
    const { createRecapStore, STORED_RECAP_UNREADABLE } = await load();
    const store = createRecapStore({ userDataDir: dir });
    await store.save(recap(0));
    await writeFile(path.join(sessionsDir(dir), "2026-10-28T14-00-00.000Z-session-0.json"), "{ not json");
    assert.deepEqual(await store.get("session-0"), { recap: null, readError: STORED_RECAP_UNREADABLE });
  }));

test("store: list is newest first and carries summaries only", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    const store = createRecapStore({ userDataDir: dir });
    await store.save(recap(1));
    await store.save(recap(3));
    await store.save(recap(2));
    const { sessions, readError } = await store.list();
    assert.equal(readError, null);
    assert.deepEqual(sessions.map((s) => s.id), ["session-3", "session-2", "session-1"]);
    assert.equal(sessions[0].lines, undefined, "no transcript in the list");
    assert.deepEqual(Object.keys(sessions[0]).sort(), ["durationMs", "endReason", "endedAt", "id", "savedAt", "startedAt", "stats"]);
  }));

test("store: an empty or missing folder lists nothing", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    assert.deepEqual(await createRecapStore({ userDataDir: dir }).list(), { sessions: [], readError: null });
  }));

test("store: the folder is the only source of truth (files removed or added outside the app are seen)", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    const store = createRecapStore({ userDataDir: dir });
    await store.save(recap(1));
    await store.save(recap(2));
    const folder = sessionsDir(dir);
    await unlink(path.join(folder, "2026-10-28T15-00-00.000Z-session-1.json"));
    // A recap written by another copy of the app, dropped into this folder.
    const otherDir = await mkdtemp(path.join(tmpdir(), "recap-other-"));
    await createRecapStore({ userDataDir: otherDir }).save(recap(5));
    await copyFile(path.join(otherDir, "sessions", "2026-10-28T19-00-00.000Z-session-5.json"), path.join(folder, "2026-10-28T19-00-00.000Z-session-5.json"));
    await rm(otherDir, { recursive: true, force: true });
    assert.deepEqual((await store.list()).sessions.map((s) => s.id), ["session-5", "session-2"]);
  }));

test("store: a damaged session file is still listed (so it can be deleted), marked unreadable", async () =>
  withDir(async (dir) => {
    const { createRecapStore, STORED_RECAP_UNREADABLE } = await load();
    const store = createRecapStore({ userDataDir: dir });
    await store.save(recap(1));
    await mkdir(sessionsDir(dir), { recursive: true });
    await writeFile(path.join(sessionsDir(dir), "2026-10-28T16-00-00.000Z-session-2.json"), "{ broken");
    const { sessions } = await store.list();
    assert.deepEqual(sessions.map((s) => s.id), ["session-2", "session-1"]);
    assert.deepEqual(sessions[0], { id: "session-2", startedAt: "2026-10-28T16:00:00.000Z", readError: STORED_RECAP_UNREADABLE });
    assert.deepEqual(await store.remove("session-2"), { removed: true });
  }));

test("store: files that are not recaps are ignored by list and never removed by clear", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    const store = createRecapStore({ userDataDir: dir });
    await store.save(recap(1));
    await writeFile(path.join(sessionsDir(dir), "notes.txt"), "mine");
    assert.deepEqual((await store.list()).sessions.map((s) => s.id), ["session-1"]);
    assert.deepEqual(await store.clear(), { removed: 1 });
    assert.deepEqual(await readdir(sessionsDir(dir)), ["notes.txt"]);
  }));

test("store: remove deletes one session and updates the list", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    const store = createRecapStore({ userDataDir: dir });
    await store.save(recap(1));
    await store.save(recap(2));
    assert.deepEqual(await store.remove("session-1"), { removed: true });
    assert.deepEqual(await store.remove("session-1"), { removed: false });
    assert.deepEqual((await store.list()).sessions.map((s) => s.id), ["session-2"]);
    assert.deepEqual(await store.get("session-1"), { recap: null, readError: null });
  }));

test("store: clear removes every session recap", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    const store = createRecapStore({ userDataDir: dir });
    for (const n of [1, 2, 3]) await store.save(recap(n));
    assert.deepEqual(await store.clear(), { removed: 3 });
    assert.deepEqual(await store.list(), { sessions: [], readError: null });
    assert.deepEqual(await readdir(sessionsDir(dir)), []);
    assert.deepEqual(await createRecapStore({ userDataDir: await mkdtemp(path.join(tmpdir(), "recap-none-")) }).clear(), { removed: 0 });
  }));

test("store: saving the same session again replaces it (one entry, one file)", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    const store = createRecapStore({ userDataDir: dir });
    await store.save(recap(1));
    await store.save(recap(1, { endReason: "quit" }));
    const { sessions } = await store.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].endReason, "quit");
    assert.equal((await readdir(sessionsDir(dir))).length, 1);
  }));

test("store: a file over the size cap on disk reads as unreadable, in get and in list", async () =>
  withDir(async (dir) => {
    const { createRecapStore, STORED_RECAP_UNREADABLE } = await load();
    const small = createRecapStore({ userDataDir: dir, maxBytes: 4 * 1024 });
    await small.save(recap(1));
    // Grown past the cap after it was written (or written by a build with a larger cap).
    const file = path.join(sessionsDir(dir), "2026-10-28T15-00-00.000Z-session-1.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...stored, text: `${stored.text}\n${"x".repeat(8 * 1024)}` }));
    assert.deepEqual(await small.get("session-1"), { recap: null, readError: STORED_RECAP_UNREADABLE });
    assert.deepEqual((await small.list()).sessions, [{ id: "session-1", startedAt: "2026-10-28T15:00:00.000Z", readError: STORED_RECAP_UNREADABLE }]);
    const roomy = createRecapStore({ userDataDir: dir });
    assert.equal((await roomy.get("session-1")).readError, null, "the default cap is far larger");
  }));

test("store: saving a session again under a different start time replaces its old file", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    const store = createRecapStore({ userDataDir: dir });
    await store.save(recap(1));
    await store.save(recap(1, { startedAt: iso(T0 + 3_600_000 + 5_000), endReason: "remote" }));
    const names = await readdir(sessionsDir(dir));
    assert.deepEqual(names, ["2026-10-28T15-00-05.000Z-session-1.json"], "one file, under the new name");
    const { sessions } = await store.list();
    assert.deepEqual(sessions.map((s) => [s.id, s.startedAt, s.endReason]), [["session-1", iso(T0 + 3_600_000 + 5_000), "remote"]]);
    assert.equal((await store.get("session-1")).recap.endReason, "remote");
  }));

test("store: a recap over the size cap is refused before anything is written", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    const store = createRecapStore({ userDataDir: dir, maxBytes: 4 * 1024 });
    const big = recap(1, { lines: [{ ...recap(1).lines[0], text: "x".repeat(10 * 1024) }] });
    await assert.rejects(store.save(big), (error) => error.code === "E_RECAP_TOO_LARGE");
    assert.deepEqual((await store.list()).sessions, []);
  }));

test("store: an fs failure on save is E_RECAP_SAVE and the old state is kept", async () =>
  withDir(async (dir) => {
    const { createRecapStore } = await load();
    const real = createRecapStore({ userDataDir: dir });
    await real.save(recap(1));
    const failing = {
      mkdir,
      stat,
      readFile,
      readdir,
      rename,
      unlink,
      writeFile: async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    };
    const store = createRecapStore({ userDataDir: dir, fs: failing });
    await assert.rejects(store.save(recap(2)), (error) => error.code === "E_RECAP_SAVE" && !/ENOSPC|disk full/.test(error.message));
    assert.deepEqual((await real.list()).sessions.map((s) => s.id), ["session-1"]);
  }));
