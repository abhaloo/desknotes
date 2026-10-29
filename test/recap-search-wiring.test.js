import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROADCAST_CHANNELS, COMMAND_CHANNELS, IPC, QUERY_CHANNELS } from "../src/desktop/ipc-gateway.js";

/**
 * Session search, phase 3b: the IPC surface and the shape of the wiring in
 * main.mjs, checked without Electron (the recap-wiring.test.js method).
 *
 *   recap:search        query      { query: string } -> { query, hits: [{ id, score, snippet }], status }
 *   recap:search-status broadcast  { mode, reason, indexed, pending, total }
 *
 * Structural rules pinned here:
 *   - the search is created beside the store and started once at boot, after
 *     the routes exist; it never blocks boot;
 *   - a saved recap is queued from onRecapSaved; recap:list reconciles; a
 *     delete (one or all) reaches the index; the lifecycle pauses embedding
 *     while a call is live and resumes after; quitting disposes it without
 *     waiting (a recap is never urgent);
 *   - the payload check is the store's id discipline: a string query, nothing else.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "src", "desktop");
const read = (relative) => readFileSync(join(desktop, relative), "utf8");
const main = () => read("main.mjs");

function body(source, name) {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `main.mjs has function ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n(?:export )?(?:async )?function |\n\/\*\*|\nconst |\nlet /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test("search channels: one query, one broadcast, in the gateway and the preload table", () => {
  assert.equal(IPC.RECAP_SEARCH, "recap:search");
  assert.equal(IPC.RECAP_SEARCH_STATUS, "recap:search-status");
  assert.ok(QUERY_CHANNELS.includes(IPC.RECAP_SEARCH));
  assert.ok(BROADCAST_CHANNELS.includes(IPC.RECAP_SEARCH_STATUS));
  assert.ok(!COMMAND_CHANNELS.includes(IPC.RECAP_SEARCH));
  const preload = read("preload.cjs");
  for (const name of ["RECAP_SEARCH", "RECAP_SEARCH_STATUS"]) assert.match(preload, new RegExp(`${name}: "${IPC[name]}"`), name);
  assert.match(preload, /QUERY_CHANNELS = Object\.freeze\(\[[\s\S]*?IPC\.RECAP_SEARCH,[\s\S]*?\]\)/);
  assert.match(preload, /BROADCAST_CHANNELS = Object\.freeze\(\[[\s\S]*?IPC\.RECAP_SEARCH_STATUS,[\s\S]*?\]\)/);
});

test("the search payload check: a string query, nothing else", async () => {
  const { searchPayload } = await import("../src/desktop/recap/search.js");
  assert.deepEqual(searchPayload({ query: "pricing" }), { query: "pricing" });
  assert.deepEqual(searchPayload({ query: "  pricing   call " }), { query: "pricing call" });
  assert.deepEqual(searchPayload({ query: "" }), { query: "" });
  for (const bad of [undefined, null, "pricing", [], { query: 5 }, { query: null }, {}, { query: "x", extra: 1 }]) {
    assert.equal(searchPayload(bad), null, JSON.stringify(bad));
  }
});

test("main imports the search and the embedder, and routes recap:search as a control-window query", () => {
  const source = main();
  assert.match(source, /import \{[^}]*\bcreateRecapSearch\b[^}]*\} from "\.\/recap\/search\.js";/);
  assert.match(source, /import \{[^}]*\bcreateOnnxEmbedder\b[^}]*\} from "\.\/recap\/embedder\.js";/);
  const routes = body(source, "registerIpcRoutes");
  assert.match(routes, /\[IPC\.RECAP_SEARCH\]: /);
  assert.match(routes, /const recapChannels = new Set\(\[IPC\.RECAP_GET\]\);/, "the recap page still gets recap:get only");
});

test("the search is created beside the store, started once at boot, and never blocks boot", () => {
  const source = main();
  const factory = body(source, "recapSearch");
  assert.match(factory, /state\.recaps\.search = createRecapSearch\(\{/);
  assert.match(factory, /store: recapStore\(\),/);
  assert.match(factory, /embedder: createOnnxEmbedder\(\),/);
  assert.match(factory, /isBusy: /);
  assert.match(factory, /onStatus: \(status\) => broadcast\(IPC\.RECAP_SEARCH_STATUS, status\),/);
  assert.match(factory, /log: /);
  const boot = body(source, "bootstrap");
  assert.match(boot, /void recapSearch\(\)\.start\(\)/, "started without await");
  assert.ok(boot.indexOf("void recapSearch().start()") > boot.indexOf("registerIpcRoutes();"), "after the routes exist");
});

test("saved, listed, deleted, live and quit all reach the index", () => {
  const source = main();
  assert.match(body(source, "onRecapSaved"), /if \(!saveError\) recapSearch\(\)\.enqueue\(id\);/);
  assert.match(body(source, "queryRecapList"), /void recapSearch\(\)\.reconcile\(sessions\)/);
  const del = body(source, "commandDeleteRecap");
  assert.match(del, /await recapSearch\(\)\.clear\(\)/);
  assert.match(del, /await recapSearch\(\)\.remove\(payload\.id\)/);
  const boot = body(source, "bootstrap");
  assert.match(boot, /SESSION_STATES\.ENDED \|\| snapshot\.state === SESSION_STATES\.FAILED\) state\.recaps\.search\?\.resume\(\)/, "embedding resumes when the call is over");
  assert.match(source, /function recapSearchBusy\(\)[\s\S]*?BUSY_SESSION_STATES\.has\(state\.status\.lifecycle\)/, "busy while launching, active or ending");
  assert.match(body(source, "onBeforeQuit"), /void state\.recaps\.search\?\.dispose\(\)/, "disposed without waiting on quit");
});
