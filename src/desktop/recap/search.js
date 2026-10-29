/**
 * Session search: the main-side orchestrator beside the recap store.
 *
 * The sessions folder stays the only truth. The index (search-index.js) is a
 * derived cache, rebuilt from one sidecar per session in
 * <userData>/sessions-index/<id>.json (chunk refs, words, vectors and the
 * model they came from: never text) and reconciled against store.list():
 * a session missing from the index or re-saved since (savedAt) is queued,
 * one no longer on disk is dropped with its sidecar.
 *
 * Queued sessions are read once and become searchable in two steps: by
 * their words as soon as the file is read (keyword boost, and the whole
 * search when the local model is absent), by topic once their chunks are
 * embedded. Embedding waits while a call is live (`isBusy`): the embedder
 * shares the main process with capture, and a recap is never urgent.
 *
 * Nothing here throws into the lifecycle, the bus or IPC: a sidecar that
 * cannot be written is logged and the entry stays in memory; an embedder
 * that fails leaves that session on its words, and after `maxFailures` in
 * a row the run falls back to keyword mode. Snippets are read from the
 * recap file (a small cache) when a result is shown, never stored.
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicReplace } from "../atomic-file.js";
import { lexicalWords, normalizeQuery, queryWords, searchChunks, snippetFor } from "./search-text.js";
import { createSearchIndex, decodeSidecar, encodeSidecar, SEARCH_DEFAULTS } from "./search-index.js";
import { isRecapId } from "./store.js";

export const RECAP_INDEX_DIRNAME = "sessions-index";
export const SEARCH_MAX_FAILURES = 3;
export const SEARCH_CACHE_SIZE = 32;
export const SEARCH_EMBED_BATCH = 8;

const defaultFs = Object.freeze({ mkdir, readdir, readFile, rename, stat, unlink, writeFile });
const SIDECAR_RULE = /^([A-Za-z0-9_-]{1,120})\.json$/;

/** recap:search takes { query: string } and nothing else; null for anything else (E_INVALID_PAYLOAD in main). */
export function searchPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "query" || typeof payload.query !== "string") return null;
  return { query: normalizeQuery(payload.query) };
}

/**
 * @param {{ userDataDir: string, store: object, embedder: { create: () => Promise<object> }, isBusy?: () => boolean,
 *   fs?: object, log?: Function, onStatus?: Function, options?: { threshold?: number, lexicalBoost?: number, ratio?: number, limit?: number,
 *   maxFailures?: number, cacheSize?: number } }} options
 */
export function createRecapSearch({ userDataDir, store, embedder, isBusy = () => false, fs, log, onStatus, options = {} } = {}) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) throw new TypeError("createRecapSearch needs an absolute userDataDir");
  if (!store || typeof store.get !== "function" || typeof store.list !== "function") throw new TypeError("createRecapSearch needs the recap store");
  if (!embedder || typeof embedder.create !== "function") throw new TypeError("createRecapSearch needs an embedder factory { create }");
  const io = fs ?? defaultFs;
  const dir = path.join(userDataDir, RECAP_INDEX_DIRNAME);
  const logger = typeof log === "function" ? log : () => {};
  const threshold = Number.isFinite(options.threshold) ? options.threshold : SEARCH_DEFAULTS.threshold;
  const lexicalBoost = Number.isFinite(options.lexicalBoost) ? options.lexicalBoost : SEARCH_DEFAULTS.lexicalBoost;
  const ratio = Number.isFinite(options.ratio) ? options.ratio : SEARCH_DEFAULTS.ratio;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : SEARCH_DEFAULTS.limit;
  const maxFailures = Number.isInteger(options.maxFailures) && options.maxFailures > 0 ? options.maxFailures : SEARCH_MAX_FAILURES;
  const cacheSize = Number.isInteger(options.cacheSize) && options.cacheSize > 0 ? options.cacheSize : SEARCH_CACHE_SIZE;

  /** "starting" until start() settles, then "semantic" or "keyword". */
  let mode = "starting";
  let reason = null;
  let model = null; // the live embedder, or null
  let index = null; // created once the dims are known (or 1 for keyword mode)
  let started = null;
  let ready = false;
  let disposed = false;
  let failures = 0;
  /** Sessions waiting to be read or embedded, in arrival order; `queued` mirrors it for O(1) membership. */
  const queue = [];
  const queued = new Set();
  /** Sessions read and on their words, whose vectors still wait (busy, or no model yet). */
  const unembedded = new Set();
  let working = null;
  /**
   * The one session being read or embedded right now. A delete that lands
   * while its file is being read or its chunks embedded cancels it, so the
   * job's result can never bring the session back after the delete.
   */
  let inflight = null;
  /** id -> stored recap, for snippets; small, insertion-ordered (oldest first). */
  const cache = new Map();
  let lastStatus = null;

  function note(entry) {
    try {
      logger(entry);
    } catch {
      /* the log hook must not turn a contained failure into a throw */
    }
  }

  function status() {
    let indexed = 0;
    if (index) for (const id of index.ids()) if (index.entry(id)?.indexed) indexed += 1;
    return { mode, reason, indexed, pending: queued.size + unembedded.size, total: index ? index.size() : 0 };
  }

  function announce() {
    const current = status();
    const same = lastStatus && Object.keys(current).every((key) => current[key] === lastStatus[key]);
    lastStatus = current;
    if (same || typeof onStatus !== "function") return;
    try {
      onStatus(current);
    } catch (error) {
      note({ type: "search.error", message: String(error?.message ?? error) });
    }
  }

  function busy() {
    try {
      return isBusy() === true;
    } catch {
      return false;
    }
  }

  function cancel(id) {
    if (inflight && (id === null || inflight.id === id)) inflight.cancelled = true;
  }

  function fallback(message) {
    mode = "keyword";
    reason = message;
    const gone = model;
    model = null;
    unembedded.clear();
    if (gone) void gone.dispose?.().catch(() => undefined);
  }

  /* --------------------------------------------------------------- sidecars */

  function sidecarPath(id) {
    return path.join(dir, `${id}.json`);
  }

  async function writeSidecar(id, entry) {
    try {
      await atomicReplace(io, sidecarPath(id), encodeSidecar({ id, dims: model?.dims ?? null, ...entry }));
    } catch (error) {
      note({ type: "search.sidecar_failed", id, message: String(error?.message ?? error) });
    }
  }

  async function dropSidecar(id) {
    await io.unlink(sidecarPath(id)).catch(() => undefined);
  }

  /** Every sidecar into the index; vectors from another model (or none) leave the session on its words, to be embedded. */
  async function loadSidecars() {
    let names = [];
    try {
      names = await io.readdir(dir);
    } catch (error) {
      if (error?.code !== "ENOENT") note({ type: "search.sidecar_failed", message: String(error?.message ?? error) });
      return;
    }
    for (const name of names) {
      const match = SIDECAR_RULE.exec(name);
      if (!match) continue;
      let decoded = null;
      try {
        decoded = decodeSidecar(await io.readFile(path.join(dir, name), "utf8"));
      } catch {
        decoded = null;
      }
      if (!decoded || decoded.id !== match[1]) continue; // damaged: rebuilt by reconcile() from the recap
      const current = model && decoded.vectors && decoded.model === model.id && decoded.dims === model.dims;
      try {
        index.add(decoded.id, { savedAt: decoded.savedAt, model: current ? decoded.model : null, chunks: decoded.chunks, vectors: current ? decoded.vectors : null, words: decoded.words });
      } catch {
        continue;
      }
      if (!current && model) unembedded.add(decoded.id);
    }
  }

  /* ------------------------------------------------------------------ queue */

  function remember(id, recap) {
    cache.delete(id);
    cache.set(id, recap);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
  }

  async function loadRecap(id) {
    if (cache.has(id)) return cache.get(id);
    let loaded;
    try {
      loaded = await store.get(id);
    } catch {
      return null;
    }
    if (!loaded?.recap || loaded.readError) return null;
    remember(id, loaded.recap);
    return loaded.recap;
  }

  /** Step one: the recap's words and chunk refs, searchable at once. */
  async function readSession(id) {
    const job = { id, cancelled: false };
    inflight = job;
    const recap = await loadRecap(id);
    if (job.cancelled) return false;
    if (!recap) {
      if (index.has(id)) {
        index.remove(id);
        await dropSidecar(id);
      }
      return false;
    }
    const chunks = searchChunks(recap);
    const entry = { savedAt: recap.savedAt ?? "", model: null, chunks: chunks.map(({ kind, ref }) => ({ kind, ref })), vectors: null, words: lexicalWords(chunks.map((chunk) => chunk.text)) };
    index.add(id, entry);
    await writeSidecar(id, entry);
    if (model) unembedded.add(id);
    return true;
  }

  /** Step two: the vectors. Returns false when embedding must wait (busy) or is over (no model). */
  async function embedSession(id) {
    if (!model || busy() || disposed) return false;
    const job = { id, cancelled: false };
    inflight = job;
    const recap = await loadRecap(id);
    if (job.cancelled) return true;
    if (!recap) {
      unembedded.delete(id);
      index.remove(id);
      await dropSidecar(id);
      return true;
    }
    const chunks = searchChunks(recap);
    const vectors = new Float32Array(chunks.length * model.dims);
    try {
      for (let start = 0; start < chunks.length; start += SEARCH_EMBED_BATCH) {
        if (busy() || disposed || !model) return false;
        const batch = chunks.slice(start, start + SEARCH_EMBED_BATCH);
        const out = await model.embed(batch.map((chunk) => chunk.text));
        if (job.cancelled) return true; // deleted meanwhile: the vectors are thrown away
        out.forEach((vector, i) => vectors.set(vector, (start + i) * model.dims));
      }
    } catch (error) {
      if (job.cancelled) return true;
      failures += 1;
      const message = String(error?.message ?? error);
      note({ type: "search.embed_failed", id, message });
      unembedded.delete(id);
      if (failures >= maxFailures) {
        note({ type: "search.fallback", message });
        fallback(message);
      }
      return true;
    }
    failures = 0;
    unembedded.delete(id);
    const entry = { savedAt: recap.savedAt ?? "", model: model.id, chunks: chunks.map(({ kind, ref }) => ({ kind, ref })), vectors, words: lexicalWords(chunks.map((chunk) => chunk.text)) };
    index.add(id, entry);
    await writeSidecar(id, entry);
    return true;
  }

  async function work() {
    try {
      while (!disposed) {
        if (queue.length > 0) {
          const id = queue.shift();
          queued.delete(id);
          await readSession(id);
          inflight = null;
          announce();
          continue;
        }
        const next = unembedded.values().next();
        if (next.done) break;
        const done = await embedSession(next.value);
        inflight = null;
        if (!done) break; // busy, or no model: resume() picks it up
        announce();
        await new Promise((resolve) => setImmediate(resolve)); // let IPC breathe between sessions
      }
    } catch (error) {
      note({ type: "search.error", message: String(error?.message ?? error) });
    } finally {
      working = null;
      announce();
    }
  }

  function kick() {
    if (disposed || !index || working) return;
    if (queue.length === 0 && (unembedded.size === 0 || busy() || !model)) return;
    working = work();
  }

  /* ----------------------------------------------------------------- public */

  async function start() {
    if (!started) {
      started = (async () => {
        try {
          model = await embedder.create();
          mode = "semantic";
          reason = null;
        } catch (error) {
          model = null;
          mode = "keyword";
          reason = String(error?.message ?? error);
          note({ type: "search.fallback", message: reason });
        }
        index = createSearchIndex({ dims: model?.dims ?? 1 });
        await loadSidecars();
        ready = true;
        announce();
        kick();
      })();
    }
    await started;
  }

  /** Lines the index up with the folder: `sessions` is a recap:list result, else the store is asked. */
  async function reconcile(sessions) {
    await start();
    if (disposed) return;
    let list = Array.isArray(sessions) ? sessions : null;
    if (!list) {
      try {
        list = (await store.list()).sessions;
      } catch (error) {
        note({ type: "search.error", message: String(error?.message ?? error) });
        return;
      }
    }
    const seen = new Set();
    for (const summary of list) {
      if (!isRecapId(summary?.id)) continue;
      if (summary.readError) {
        if (index.has(summary.id)) {
          index.remove(summary.id);
          await dropSidecar(summary.id);
        }
        continue;
      }
      seen.add(summary.id);
      const entry = index.entry(summary.id);
      if (!entry || entry.savedAt !== (summary.savedAt ?? "")) enqueue(summary.id);
    }
    for (const id of index.ids()) {
      if (seen.has(id) || queued.has(id)) continue;
      cancel(id);
      index.remove(id);
      unembedded.delete(id);
      cache.delete(id);
      await dropSidecar(id);
    }
    announce();
    kick();
  }

  function enqueue(id) {
    if (disposed || !isRecapId(id) || queued.has(id)) return;
    cache.delete(id);
    unembedded.delete(id);
    queue.push(id);
    queued.add(id);
    announce();
    if (ready) kick();
    else void start().then(kick);
  }

  async function remove(id) {
    if (!isRecapId(id)) return;
    await start();
    cancel(id);
    cache.delete(id);
    unembedded.delete(id);
    if (queued.delete(id)) queue.splice(queue.indexOf(id), 1);
    index.remove(id);
    await dropSidecar(id);
    announce();
  }

  async function clear() {
    await start();
    cancel(null);
    cache.clear();
    unembedded.clear();
    queue.length = 0;
    queued.clear();
    index.clear();
    let names = [];
    try {
      names = await io.readdir(dir);
    } catch {
      names = [];
    }
    for (const name of names) if (SIDECAR_RULE.test(name)) await io.unlink(path.join(dir, name)).catch(() => undefined);
    announce();
  }

  /** The snippet for a hit: its best chunk, or in keyword mode the first chunk holding a query word. */
  async function snippet(hit, words) {
    const recap = await loadRecap(hit.id);
    if (!recap) return "";
    if (hit.chunk) return snippetFor(recap, hit.chunk.ref);
    const lower = words.map((word) => word.toLowerCase());
    for (const chunk of searchChunks(recap)) {
      const text = chunk.text.toLowerCase();
      if (lower.some((word) => text.includes(word))) return snippetFor(recap, chunk.ref);
    }
    return "";
  }

  async function search(query) {
    const text = normalizeQuery(query);
    await start();
    if (disposed || !index || text === "") return { query: text, hits: [], status: status() };
    const words = queryWords(text);
    let vector = null;
    if (model) {
      try {
        vector = await model.embedQuery(text);
      } catch (error) {
        failures += 1;
        note({ type: "search.embed_failed", id: null, message: String(error?.message ?? error) });
        if (failures >= maxFailures) fallback(String(error?.message ?? error));
        vector = null;
      }
    }
    const hits = index.query({ vector, words, threshold, lexicalBoost, ratio, limit });
    const out = [];
    for (const hit of hits) out.push({ id: hit.id, score: hit.score, snippet: await snippet(hit, words) });
    return { query: text, hits: out, status: status() };
  }

  function resume() {
    if (disposed) return;
    if (ready) kick();
    else void start().then(kick);
  }

  /** Resolves once nothing is being read or embedded (tests, and the quit path). */
  async function settled() {
    await started;
    kick();
    while (working) await working;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    cancel(null);
    queue.length = 0;
    queued.clear();
    unembedded.clear();
    cache.clear();
    const gone = model;
    model = null;
    await started?.catch(() => undefined);
    await gone?.dispose?.().catch(() => undefined);
  }

  return { start, reconcile, enqueue, remove, clear, search, status, resume, settled, dispose };
}
