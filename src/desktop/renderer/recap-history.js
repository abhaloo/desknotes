/**
 * Settings > Session history: the saved session recaps (recap:list), one row
 * each with Open and Delete, and Delete all. The folder on disk is the only
 * truth, so the list is simply read again after anything that can change it:
 * a delete, a new recap, Settings opening, the window regaining focus, and an
 * Open that finds the file gone (deleted outside the app).
 *
 * Everything is built from text nodes; the bridge is injected so app.js owns
 * the toast, the confirm and the button state, and this file owns the rows.
 */
import { historyRowView } from "./recap-view.js";

export const HISTORY_UNLISTABLE = "The saved session recaps couldn't be listed.";

/**
 * @param {{ document: Document, channels: object, bridge: object|null,
 *   confirm: (message: string) => boolean, showToast: Function,
 *   els: { list: Element|null, empty: Element|null, deleteAll: Element|null },
 *   onRemoved?: (event: { id?: string, all?: boolean }) => void }} options
 * @returns {{ load: () => Promise<void>, render: (list: object) => void }}
 */
export function createRecapHistory({ document, channels, bridge, confirm, showToast, els, onRemoved } = {}) {
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

  function createRow(summary) {
    const row = historyRowView(summary);
    const li = document.createElement("li");
    li.className = "recap-history-row";
    li.dataset.recapId = row.id;
    if (row.unreadable) li.dataset.unreadable = "";
    const openButton = button("Open", "open", row.id, () => open(row));
    openButton.disabled = row.unreadable; // nothing to show; Delete still works
    li.append(text("recap-history-title", row.title), text("recap-history-meta", row.meta), openButton, button("Delete", "delete", row.id, () => remove(row)));
    return li;
  }

  /** Newest first, as recap:list returns them. */
  function render({ sessions = [], readError = null } = {}) {
    const rows = Array.isArray(sessions) ? sessions : [];
    els.list?.replaceChildren(...rows.map(createRow));
    if (els.empty) {
      els.empty.textContent = readError ?? "No saved sessions yet.";
      els.empty.hidden = rows.length > 0 && !readError;
    }
    if (els.deleteAll) els.deleteAll.disabled = rows.length === 0;
  }

  async function load() {
    if (!bridge) return;
    try {
      render((await bridge.request(channels.RECAP_LIST)) ?? {});
    } catch (error) {
      render({ sessions: [], readError: error?.message ?? HISTORY_UNLISTABLE });
    }
  }

  els.deleteAll?.addEventListener("click", () => void removeAll());

  return { load, render };
}
