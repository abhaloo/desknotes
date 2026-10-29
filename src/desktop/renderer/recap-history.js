/**
 * Settings > Session history: the saved session recaps (recap:list), one row
 * each with Open and Delete, and Delete all. The folder on disk is the only
 * truth, so the list is simply read again after anything that can change it:
 * a delete, a new recap, Settings opening, the window regaining focus, and an
 * Open that finds the file gone (deleted outside the app).
 *
 * The search box filters that list by topic (recap:search, src/desktop/recap/
 * search.js): a settled burst of keys asks main once, and the reply (ids,
 * best first, each with a snippet main read from the recap) is joined with
 * the last list, so a row is always the usual row. An empty box is the full
 * list at once, with no IPC. A reply older than the latest request never
 * paints. recap:search-status says what the index can do (words only
 * without the local model; how far indexing is) and refreshes the results
 * as more sessions get indexed.
 *
 * Everything is built from text nodes; the bridge is injected so app.js owns
 * the toast, the confirm and the button state, and this file owns the rows.
 */
import { historyRowView, searchStatusText } from "./recap-view.js";

export const HISTORY_UNLISTABLE = "The saved session recaps couldn't be listed.";
/** Keys settle for this long before main is asked: one request per burst, well inside the 300 ms budget. */
export const SEARCH_DEBOUNCE_MS = 100;

/**
 * @param {{ document: Document, channels: object, bridge: object|null,
 *   confirm: (message: string) => boolean, showToast: Function,
 *   els: { list: Element|null, empty: Element|null, deleteAll: Element|null, search?: Element|null, status?: Element|null },
 *   onRemoved?: (event: { id?: string, all?: boolean }) => void, debounceMs?: number }} options
 * @returns {{ load: () => Promise<void>, render: (list: object) => void }}
 */
export function createRecapHistory({ document, channels, bridge, confirm, showToast, els, onRemoved, debounceMs = SEARCH_DEBOUNCE_MS } = {}) {
  /** The last recap:list result: what the rows are built from, searching or not. */
  let list = { sessions: [], readError: null };
  /** The active query ("" when the box is empty), the request counter, and the pending debounce. */
  let query = "";
  let seq = 0;
  let timer = null;
  /** The last reply painted: hits of the active query. */
  let hits = null;
  /** The last recap:search-status (or the status a reply carried). */
  let searchStatus = null;

  function button(label, action, id, onClick) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "btn";
    node.dataset.action = action;
    node.dataset.recapId = id;
    node.textContent = label;
    node.addEventListener("click", () => void onClick());
    return node;
  }

  function text(className, value) {
    const node = document.createElement("span");
    node.className = className;
    node.textContent = value;
    return node;
  }

  async function open(row) {
    if (!bridge) return;
    try {
      await bridge.command(channels.RECAP_OPEN, { id: row.id });
    } catch (error) {
      showToast(error?.code === "E_RECAP_NOT_FOUND" ? "This session recap no longer exists." : error?.message ?? String(error), "error");
      // The file is gone (deleted outside the app): the row goes with it.
      if (error?.code === "E_RECAP_NOT_FOUND") await load();
    }
  }

  async function remove(row) {
    if (!bridge || !confirm(`Delete the session recap from ${row.title}? The file is the only copy.`)) return;
    try {
      await bridge.command(channels.RECAP_DELETE, { id: row.id });
      onRemoved?.({ id: row.id });
    } catch (error) {
      showToast(error?.message ?? String(error), "error");
    }
    await load();
  }

  async function removeAll() {
    if (!bridge || !confirm("Delete every saved session recap? The files are the only copy.")) return;
    try {
      await bridge.command(channels.RECAP_DELETE, { all: true });
      onRemoved?.({ all: true });
    } catch (error) {
      showToast(error?.message ?? String(error), "error");
    }
    await load();
  }

  function createRow(summary, snippet = "") {
    const row = historyRowView(summary);
    const li = document.createElement("li");
    li.className = "recap-history-row";
    li.dataset.recapId = row.id;
    if (row.unreadable) li.dataset.unreadable = "";
    const openButton = button("Open", "open", row.id, () => open(row));
    openButton.disabled = row.unreadable; // nothing to show; Delete still works
    li.append(text("recap-history-title", row.title), text("recap-history-meta", row.meta));
    if (snippet) li.append(text("recap-history-snippet", snippet));
    li.append(openButton, button("Delete", "delete", row.id, () => remove(row)));
    return li;
  }

  /** The rows: the whole list, or the hits joined with it (a hit for a session no longer listed is left out). */
  function paint() {
    const sessions = Array.isArray(list.sessions) ? list.sessions : [];
    const searching = query !== "" && hits !== null;
    let rows;
    if (searching) {
      const byId = new Map(sessions.map((summary) => [summary.id, summary]));
      rows = hits.filter((hit) => byId.has(hit.id)).map((hit) => createRow(byId.get(hit.id), hit.snippet));
    } else {
      rows = sessions.map((summary) => createRow(summary));
    }
    els.list?.replaceChildren(...rows);
    if (els.empty) {
      els.empty.textContent = list.readError ?? (searching ? `No sessions match “${query}”.` : "No saved sessions yet.");
      els.empty.hidden = rows.length > 0 && !list.readError;
    }
    if (els.deleteAll) els.deleteAll.disabled = sessions.length === 0;
    if (els.search) els.search.disabled = Boolean(list.readError);
    if (els.status) els.status.textContent = searchStatusText({ searching, matches: rows.length, total: sessions.length, status: searchStatus });
  }

  /** Asks main for the active query; a reply for an older request is dropped. */
  async function runSearch() {
    if (!bridge || query === "") return;
    const mine = ++seq;
    const asked = query;
    let reply;
    try {
      reply = await bridge.request(channels.RECAP_SEARCH, { query: asked });
    } catch (error) {
      if (mine !== seq) return;
      showToast(error?.message ?? String(error), "error");
      return;
    }
    if (mine !== seq || query !== asked) return;
    hits = Array.isArray(reply?.hits) ? reply.hits : [];
    if (reply?.status) searchStatus = reply.status;
    paint();
  }

  function scheduleSearch() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runSearch();
    }, debounceMs);
  }

  function setQuery(value) {
    const next = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (next === query) return;
    query = next;
    if (query === "") {
      // The full list at once: no request, and any reply in flight is stale.
      seq += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      hits = null;
      paint();
      return;
    }
    scheduleSearch();
  }

  /** Newest first, as recap:list returns them. With a query active, it runs again over the new list. */
  function render(next = {}) {
    list = { sessions: Array.isArray(next?.sessions) ? next.sessions : [], readError: next?.readError ?? null };
    paint();
    if (query !== "") scheduleSearch();
  }

  async function load() {
    if (!bridge) return;
    try {
      render((await bridge.request(channels.RECAP_LIST)) ?? {});
    } catch (error) {
      render({ sessions: [], readError: error?.message ?? HISTORY_UNLISTABLE });
    }
  }

  function onSearchStatus(status) {
    const before = searchStatus;
    searchStatus = status && typeof status === "object" ? status : null;
    if (query === "") return; // nothing on screen depends on it until a query is typed
    // More sessions indexed (or the mode changed): the same query may answer differently now.
    const changed = !before || before.indexed !== searchStatus?.indexed || before.mode !== searchStatus?.mode || before.total !== searchStatus?.total;
    if (changed) scheduleSearch();
    else paint();
  }

  els.deleteAll?.addEventListener("click", () => void removeAll());
  els.search?.addEventListener("input", (event) => setQuery(event?.target?.value ?? els.search.value));
  els.search?.addEventListener("keydown", (event) => {
    if (event?.key !== "Escape" || !els.search.value) return;
    event.preventDefault?.();
    els.search.value = "";
    setQuery("");
  });
  bridge?.on?.(channels.RECAP_SEARCH_STATUS, onSearchStatus);

  return { load, render };
}
