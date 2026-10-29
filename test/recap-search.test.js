import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeEmbedder, createUnavailableEmbedder, FAKE_EMBEDDER_ID } from "./fixtures/fake-embedder.js";

/**
 * Session search, phase 3a: the orchestrator (src/desktop/recap/search.js),
 * main-side, beside the recap store.
 *
 *   createRecapSearch({ userDataDir, store, embedder: { create }, isBusy, fs?, log?, onStatus?, options? })
 *     -> { start(), reconcile(sessions?), enqueue(id), remove(id), clear(),
 *          search(query) -> { query, hits: [{ id, score, snippet }], status },
 *          status() -> { mode: "starting"|"semantic"|"keyword", reason, indexed, pending, total },
 *          resume(), settled(), dispose() }
 *
 * The sessions folder stays the only truth: the index is rebuilt from
 * per-session sidecars in <userData>/sessions-index/<id>.json (refs, words,
 * vectors: never text) and reconciled against store.list(). A session is
 * searchable by its words as soon as its file is read, and by topic once
 * its chunks are embedded; embedding waits while a call is live (isBusy).
 * Without the local model (create() rejects) search is keyword mode for the
 * run. Snippets are read from the recap file when a result is shown.
 */
const load = () => import("../src/desktop/recap/search.js");
const loadStore = () => import("../src/desktop/recap/store.js");

const T0 = Date.parse("2026-10-28T14:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "recap-search-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const TOPICS = {
  pricing: ["How much does it cost for 200 seats?", "The annual quote has a discount; Acme wants the price in writing."],
  sso: ["Does login work with Okta and SAML?", "SSO and SCIM provisioning are both supported."],
  infra: ["Can we deploy on kubernetes?", "Docker images are published for every release."],
};

function recap(n, topic, fields = {}) {
  const startedAt = iso(T0 + n * 3_600_000);
  const lines = TOPICS[topic].map((text, i) => ({ type: "transcript", role: i % 2 ? "rep" : "prospect", source: "mic", text, segmentId: `s${i}`, at: iso(T0 + n * 3_600_000 + i * 1000), offsetMs: i * 1000 }));
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
    lines,
    turns: [],
    questions: [{ turnId: `t${n}`, at: lines[0].at, offsetMs: 0, question: TOPICS[topic][0], intent: "final", status: "done", answer: "VERDICT: <b>Yes</b>.", cut: null, terms: [] }],
    gaps: [],
    terms: [],
    stats: { lines: 2, prospectLines: 1, repLines: 1, turns: 1, questions: 1, answered: 1, gaps: 0, terms: 0 },
    ...fields,
  };
}

async function setup(dir, { embedder = createFakeEmbedder(), isBusy = () => false, options = {}, onStatus = null, log = null } = {}) {
  const { createRecapStore } = await loadStore();
  const { createRecapSearch } = await load();
  const store = createRecapStore({ userDataDir: dir, now: () => new Date(T0) });
  const logs = [];
  const statuses = [];
  const search = createRecapSearch({
    userDataDir: dir,
    store,
    embedder: typeof embedder.create === "function" ? embedder : { create: async () => embedder },
    isBusy,
    log: log ?? ((entry) => logs.push(entry)),
    onStatus: onStatus ?? ((status) => statuses.push(status)),
    options: { threshold: 0.1, lexicalBoost: 0.2, ...options },
  });
  return { store, search, embedder, logs, statuses };
}

const indexDir = (dir) => path.join(dir, "sessions-index");
const sidecars = async (dir) => (await readdir(indexDir(dir)).catch(() => [])).sort();

test("start(): the embedder is created once; without it the mode is keyword with a reason", async () => {
  await withDir(async (dir) => {
    let creates = 0;
    const fake = createFakeEmbedder();
    const { search } = await setup(dir, { embedder: { create: async () => (creates += 1, fake) } });
    assert.equal(search.status().mode, "starting");
    await search.start();
    await search.start();
    assert.equal(creates, 1);
    assert.deepEqual(search.status(), { mode: "semantic", reason: null, indexed: 0, pending: 0, total: 0 });

    const { search: noModel } = await setup(dir, { embedder: createUnavailableEmbedder("no onnxruntime-node here") });
    await noModel.start();
    assert.equal(noModel.status().mode, "keyword");
    assert.match(noModel.status().reason, /no onnxruntime-node here/);
  });
});

test("enqueue(id): words first, then vectors; the sidecar holds refs and words, never the transcript", async () => {
  await withDir(async (dir) => {
    const { store, search, embedder, statuses } = await setup(dir);
    await store.save(recap(1, "pricing"));
    await search.start();
    search.enqueue("session-1");
    await search.settled();
    assert.deepEqual(search.status(), { mode: "semantic", reason: null, indexed: 1, pending: 0, total: 1 });
    assert.ok(statuses.some((s) => s.pending === 1), "status was announced while pending");
    assert.ok(embedder.calls.flat().some((text) => text.includes("200 seats")), "the chunks were embedded");

    assert.deepEqual(await sidecars(dir), ["session-1.json"]);
    const raw = await readFile(path.join(indexDir(dir), "session-1.json"), "utf8");
    assert.ok(!raw.includes("200 seats") && !raw.includes("Acme"), "no transcript text on disk beside the recap");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.id, "session-1");
    assert.equal(parsed.model, FAKE_EMBEDDER_ID);
    assert.ok(parsed.chunks.length >= 2 && parsed.words.includes("acme"));
  });
});

test("search(query): hits by topic with a snippet read from the recap; empty queries never embed", async () => {
  await withDir(async (dir) => {
    const { store, search, embedder } = await setup(dir);
    for (const [n, topic] of [[1, "pricing"], [2, "sso"], [3, "infra"]]) await store.save(recap(n, topic));
    await search.start();
    await search.reconcile();
    await search.settled();
    assert.equal(search.status().indexed, 3);

    const before = embedder.calls.length;
    const result = await search.search("what did they say about the cost");
    assert.equal(embedder.calls.length, before + 1, "one embed call for the query");
    assert.equal(result.query, "what did they say about the cost");
    assert.equal(result.hits[0].id, "session-1");
    assert.ok(!result.hits.some((hit) => hit.id === "session-3"), "the kubernetes call is not a hit");
    assert.ok(typeof result.hits[0].score === "number" && result.hits[0].score > 0);
    assert.ok(result.hits[0].snippet.includes("cost") || result.hits[0].snippet.includes("discount"), result.hits[0].snippet);
    assert.equal(result.status.mode, "semantic");

    for (const empty of ["", "   ", null, undefined, 42]) {
      const none = await search.search(empty);
      assert.deepEqual(none.hits, []);
      assert.equal(none.query, "");
    }
    assert.equal(embedder.calls.length, before + 1, "no embedding for an empty query");
  });
});

test("search(): an exact word the embedding misses is still found (hybrid), and keyword mode finds it alone", async () => {
  await withDir(async (dir) => {
    const { store, search } = await setup(dir);
    for (const [n, topic] of [[1, "pricing"], [2, "sso"]]) await store.save(recap(n, topic));
    await search.start();
    await search.reconcile();
    await search.settled();
    const hybrid = await search.search("acme");
    assert.deepEqual(hybrid.hits.map((hit) => hit.id), ["session-1"]);
    assert.ok(hybrid.hits[0].snippet.includes("Acme"), "the snippet is the chunk that holds the word");

    const { search: keyword } = await setup(dir, { embedder: createUnavailableEmbedder() });
    await keyword.start();
    await keyword.reconcile();
    await keyword.settled();
    const result = await keyword.search("okta provisioning");
    assert.equal(result.status.mode, "keyword");
    assert.deepEqual(result.hits.map((hit) => hit.id), ["session-2"]);
    assert.ok(result.hits[0].snippet.includes("Okta"));
    assert.deepEqual((await keyword.search("kubernetes")).hits, []);
  });
});

test("start() rebuilds the index from the sidecars without embedding again", async () => {
  await withDir(async (dir) => {
    const first = await setup(dir);
    for (const [n, topic] of [[1, "pricing"], [2, "sso"]]) await first.store.save(recap(n, topic));
    await first.search.start();
    await first.search.reconcile();
    await first.search.settled();
    await first.search.dispose();

    const second = await setup(dir);
    await second.search.start();
    await second.search.reconcile();
    await second.search.settled();
    assert.deepEqual(second.embedder.calls, [], "nothing was embedded again");
    assert.equal(second.search.status().indexed, 2);
    assert.equal((await second.search.search("single sign-on login")).hits[0].id, "session-2");
  });
});

test("sidecars from another model, damaged sidecars and orphans are re-embedded, rebuilt or dropped", async () => {
  await withDir(async (dir) => {
    const { store, search, embedder } = await setup(dir);
    for (const [n, topic] of [[1, "pricing"], [2, "sso"], [3, "infra"]]) await store.save(recap(n, topic));
    await mkdir(indexDir(dir), { recursive: true });
    // session-1: vectors from a different model; session-2: not JSON; session-9: no such recap.
    await writeFile(path.join(indexDir(dir), "session-1.json"), `${JSON.stringify({ version: 1, id: "session-1", savedAt: iso(T0), model: "other-model", dims: 4, chunks: [{ kind: "qa", ref: { turnId: "t1" } }], words: ["forgotten"], vectors: Buffer.alloc(16).toString("base64") })}\n`);
    await writeFile(path.join(indexDir(dir), "session-2.json"), "{ not json");
    await writeFile(path.join(indexDir(dir), "session-9.json"), `${JSON.stringify({ version: 1, id: "session-9", savedAt: iso(T0), model: null, dims: null, chunks: [], words: ["orphan"], vectors: null })}\n`);
    await writeFile(path.join(indexDir(dir), "notes.txt"), "left alone");
    await search.start();
    await search.reconcile();
    await search.settled();
    assert.equal(search.status().indexed, 3);
    const embedded = embedder.calls.flat().join("\n");
    assert.ok(embedded.includes("200 seats") && embedded.includes("Okta") && embedded.includes("kubernetes"));
    assert.deepEqual(await sidecars(dir), ["notes.txt", "session-1.json", "session-2.json", "session-3.json"]);
    assert.deepEqual((await search.search("orphan forgotten")).hits, [], "the stale words were replaced, the orphan dropped");
  });
});

test("reconcile(sessions): a re-saved recap is embedded again; a deleted or unreadable one leaves the index", async () => {
  await withDir(async (dir) => {
    const { store, search, embedder } = await setup(dir);
    await store.save(recap(1, "pricing"));
    await store.save(recap(2, "sso"));
    await search.start();
    await search.reconcile((await store.list()).sessions);
    await search.settled();
    assert.equal(search.status().indexed, 2);
    assert.equal((await search.search("kubernetes")).hits.length, 0);

    // Re-saved under the same id with other content, later.
    const { createRecapStore } = await loadStore();
    const later = createRecapStore({ userDataDir: dir, now: () => new Date(T0 + 10_000) });
    await later.save(recap(1, "infra"));
    await store.remove("session-2");
    await writeFile(path.join(dir, "sessions", `${iso(T0 + 3 * 3_600_000).replaceAll(":", "-")}-session-3.json`), "corrupt");
    const calls = embedder.calls.length;
    await search.reconcile((await store.list()).sessions);
    await search.settled();
    assert.ok(embedder.calls.length > calls, "session-1 was embedded again");
    assert.deepEqual(search.status(), { mode: "semantic", reason: null, indexed: 1, pending: 0, total: 1 });
    assert.deepEqual((await search.search("kubernetes deploy")).hits.map((hit) => hit.id), ["session-1"]);
    assert.deepEqual((await search.search("okta")).hits, []);
    assert.deepEqual(await sidecars(dir), ["session-1.json"]);
  });
});

test("remove(id) and clear() drop entries and sidecars; a later search does not see them", async () => {
  await withDir(async (dir) => {
    const { store, search } = await setup(dir);
    for (const [n, topic] of [[1, "pricing"], [2, "sso"], [3, "infra"]]) await store.save(recap(n, topic));
    await search.start();
    await search.reconcile();
    await search.settled();
    await search.remove("session-1");
    assert.deepEqual(await sidecars(dir), ["session-2.json", "session-3.json"]);
    assert.deepEqual((await search.search("price discount")).hits, []);
    await search.remove("session-1");
    await search.remove("../evil");
    await search.clear();
    assert.deepEqual(await sidecars(dir), []);
    assert.deepEqual(search.status(), { mode: "semantic", reason: null, indexed: 0, pending: 0, total: 0 });
    assert.deepEqual((await search.search("okta")).hits, []);
  });
});

/** Waits until the fake has been asked to embed a text that holds `marker` (the session is mid-embedding). */
async function untilEmbedding(embedder, marker) {
  for (let i = 0; i < 200; i++) {
    if (embedder.calls.flat().some((text) => text.includes(marker))) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`embedding of "${marker}" never started`);
}

test("a session deleted while it is being embedded does not come back: no entry, no sidecar, no hit", async () => {
  await withDir(async (dir) => {
    const embedder = createFakeEmbedder({ delayMs: 15 });
    const { store, search } = await setup(dir, { embedder });
    for (const [n, topic] of [[1, "pricing"], [2, "sso"], [3, "infra"]]) await store.save(recap(n, topic));
    await search.start();
    await search.reconcile();
    await untilEmbedding(embedder, "Okta");
    await store.remove("session-2");
    await search.remove("session-2"); // what recap:delete { id } does, while the embed is in flight
    await search.settled();
    assert.deepEqual(await sidecars(dir), ["session-1.json", "session-3.json"]);
    assert.deepEqual(search.status(), { mode: "semantic", reason: null, indexed: 2, pending: 0, total: 2 });
    assert.deepEqual((await search.search("okta login")).hits, []);
  });
});

test("Delete all while sessions are being embedded leaves nothing behind", async () => {
  await withDir(async (dir) => {
    const embedder = createFakeEmbedder({ delayMs: 15 });
    const { store, search } = await setup(dir, { embedder });
    for (const [n, topic] of [[1, "pricing"], [2, "sso"], [3, "infra"]]) await store.save(recap(n, topic));
    await search.start();
    await search.reconcile();
    await untilEmbedding(embedder, "200 seats");
    await store.clear();
    await search.clear(); // what recap:delete { all: true } does
    await search.settled();
    assert.deepEqual(await sidecars(dir), []);
    assert.deepEqual(search.status(), { mode: "semantic", reason: null, indexed: 0, pending: 0, total: 0 });
    for (const query of ["pricing", "okta", "kubernetes"]) assert.deepEqual((await search.search(query)).hits, [], query);
  });
});

test("a session deleted while its file is being read for the index does not come back either", async () => {
  await withDir(async (dir) => {
    const { createRecapStore } = await loadStore();
    const { createRecapSearch } = await load();
    const real = createRecapStore({ userDataDir: dir, now: () => new Date(T0) });
    await real.save(recap(1, "pricing"));
    let release = null;
    const gate = new Promise((resolve) => (release = resolve));
    const store = { ...real, get: async (id) => { await gate; return real.get(id); } };
    const search = createRecapSearch({ userDataDir: dir, store, embedder: { create: async () => createFakeEmbedder() }, isBusy: () => false, options: { threshold: 0.1 } });
    await search.start();
    search.enqueue("session-1");
    await new Promise((resolve) => setTimeout(resolve, 5)); // the read is waiting on the gate
    const removing = search.remove("session-1");
    release();
    await removing;
    await search.settled();
    assert.deepEqual(await sidecars(dir), []);
    assert.equal(search.status().total, 0);
  });
});

test("while a call is live, words are indexed but embedding waits; resume() continues it", async () => {
  await withDir(async (dir) => {
    let busy = true;
    const { store, search, embedder } = await setup(dir, { isBusy: () => busy });
    await store.save(recap(1, "pricing"));
    await search.start();
    search.enqueue("session-1");
    await search.settled();
    assert.deepEqual(embedder.calls, [], "no embedding during a call");
    assert.deepEqual(search.status(), { mode: "semantic", reason: null, indexed: 0, pending: 1, total: 1 });
    const words = await search.search("acme");
    assert.deepEqual(words.hits.map((hit) => hit.id), ["session-1"], "the words are already searchable");
    assert.equal(words.status.pending, 1);

    busy = false;
    search.resume();
    await search.settled();
    assert.ok(embedder.calls.length > 0);
    assert.deepEqual(search.status(), { mode: "semantic", reason: null, indexed: 1, pending: 0, total: 1 });
  });
});

test("an embedding failure leaves that session on words, is logged, and does not stop the others", async () => {
  await withDir(async (dir) => {
    const embedder = createFakeEmbedder({ failOn: (text) => text.includes("Okta") });
    const { store, search, logs } = await setup(dir, { embedder });
    for (const [n, topic] of [[1, "pricing"], [2, "sso"], [3, "infra"]]) await store.save(recap(n, topic));
    await search.start();
    await search.reconcile();
    await search.settled();
    assert.deepEqual(search.status(), { mode: "semantic", reason: null, indexed: 2, pending: 0, total: 3 });
    assert.ok(logs.some((entry) => entry.type === "search.embed_failed" && entry.id === "session-2"));
    assert.deepEqual((await search.search("okta")).hits.map((hit) => hit.id), ["session-2"], "still found by its words");
    assert.equal((await search.search("kubernetes")).hits[0].id, "session-3");
  });
});

test("after maxFailures consecutive embedding failures the run falls back to keyword mode", async () => {
  await withDir(async (dir) => {
    const embedder = createFakeEmbedder({ failOn: () => true });
    const { store, search } = await setup(dir, { embedder, options: { maxFailures: 2 } });
    for (const [n, topic] of [[1, "pricing"], [2, "sso"], [3, "infra"]]) await store.save(recap(n, topic));
    await search.start();
    await search.reconcile();
    await search.settled();
    assert.equal(search.status().mode, "keyword");
    assert.match(search.status().reason, /fake embedder failed/);
    assert.equal(search.status().total, 3);
    const calls = embedder.calls.length;
    const result = await search.search("okta");
    assert.equal(embedder.calls.length, calls, "keyword mode embeds nothing");
    assert.deepEqual(result.hits.map((hit) => hit.id), ["session-2"]);
  });
});

test("a recap that vanishes or cannot be read while queued is skipped without a throw", async () => {
  await withDir(async (dir) => {
    const { store, search, logs } = await setup(dir);
    await store.save(recap(1, "pricing"));
    await search.start();
    search.enqueue("session-1");
    search.enqueue("session-404");
    search.enqueue("not a valid id!");
    await search.settled();
    assert.deepEqual(search.status(), { mode: "semantic", reason: null, indexed: 1, pending: 0, total: 1 });
    assert.ok(!logs.some((entry) => entry.type === "search.error"), JSON.stringify(logs));
  });
});

test("search(): limit and threshold options apply; a file deleted by hand gives no snippet once its cache entry is gone, and no hit after reconcile", async () => {
  await withDir(async (dir) => {
    const { store, search } = await setup(dir, { options: { limit: 1, threshold: 0, cacheSize: 1 } });
    for (const n of [1, 2, 3]) await store.save(recap(n, "pricing"));
    await search.start();
    await search.reconcile();
    await search.settled();
    const result = await search.search("pricing");
    assert.equal(result.hits.length, 1);
    const top = result.hits[0].id;
    await rm(path.join(dir, "sessions"), { recursive: true, force: true });
    await search.search("okta"); // a miss for "okta"'s snippet pushes the cached recap out (cacheSize 1)
    await store.save(recap(7, "sso"));
    search.enqueue("session-7");
    await search.settled();
    const gone = await search.search("pricing");
    assert.equal(gone.hits.length, 1, "the index answers until the next reconcile");
    assert.equal(gone.hits[0].id, top);
    assert.equal(gone.hits[0].snippet, "", "the recap file is the only source of snippet text");
    await search.reconcile();
    await search.settled();
    assert.ok(!(await search.search("pricing")).hits.some((hit) => hit.id === top), "reconcile dropped the deleted session");
    assert.equal(search.status().total, 1);
  });
});

test("dispose(): stops the queue and the embedder; search answers empty afterwards", async () => {
  await withDir(async (dir) => {
    const embedder = createFakeEmbedder({ delayMs: 20 });
    const { store, search } = await setup(dir, { embedder });
    for (const n of [1, 2, 3, 4]) await store.save(recap(n, "pricing"));
    await search.start();
    await search.reconcile();
    await search.dispose();
    await search.settled();
    assert.ok(embedder.disposed);
    assert.ok(search.status().indexed < 4);
    assert.deepEqual((await search.search("pricing")).hits, []);
  });
});

test("a search folder that cannot be created is logged; search still works from memory", async () => {
  await withDir(async (dir) => {
    const { createRecapStore } = await loadStore();
    const { createRecapSearch } = await load();
    const store = createRecapStore({ userDataDir: dir });
    await store.save(recap(1, "pricing"));
    const logs = [];
    const search = createRecapSearch({
      userDataDir: dir,
      store,
      embedder: { create: async () => createFakeEmbedder() },
      isBusy: () => false,
      log: (entry) => logs.push(entry),
      fs: { mkdir: async () => { throw new Error("EACCES"); }, readdir: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, readFile: async () => "", writeFile: async () => { throw new Error("EACCES"); }, rename: async () => { throw new Error("EACCES"); }, unlink: async () => {}, stat: async () => { throw new Error("EACCES"); } },
      options: { threshold: 0.1 },
    });
    await search.start();
    await search.reconcile();
    await search.settled();
    assert.equal(search.status().indexed, 1);
    assert.ok(logs.some((entry) => entry.type === "search.sidecar_failed"));
    assert.equal((await search.search("discount")).hits[0].id, "session-1");
  });
});
