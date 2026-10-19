/** Shows, hides and fades the app's windows. */

/**
 * Creates the presenter the main process uses for every app window. Missing or
 * closed windows are skipped: a timer or IPC handler can still hold a window
 * that was closed a moment ago.
 *
 * @param {{ getOpacity?: () => number }} [options] `getOpacity` is read on every
 *   call, so a slider change reaches windows that are already open.
 * @returns {{
 *   show: (win: object | null | undefined, options?: { inactive?: boolean }) => void,
 *   hide: (win: object | null | undefined) => void,
 *   applyOpacity: (win: object | null | undefined) => void,
 * }}
 */
export function createWindowPresenter({ getOpacity = () => 1 } = {}) {
  const live = (win) => Boolean(win) && !win.isDestroyed();
  return {
    /**
     * Shows a window without focusing it unless `inactive` is false. Opacity is
     * set first so the window never appears at full strength before it fades.
     */
    show(win, { inactive = true } = {}) {
      if (!live(win)) return;
      win.setOpacity(getOpacity());
      if (inactive) win.showInactive();
      else win.show();
    },
    /** @param {object | null | undefined} win */
    hide(win) {
      if (live(win)) win.hide();
    },
    /** Re-applies the current opacity to a window that is already showing. */
    applyOpacity(win) {
      if (live(win)) win.setOpacity(getOpacity());
    },
  };
}
