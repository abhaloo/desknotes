/** Hides the app's own windows while the screen is captured, so they do not appear in the screenshot. */

const live = (win) => Boolean(win) && !win.isDestroyed();

/**
 * Runs `run` with the visible windows in `windows` hidden, then shows those same
 * windows again with `showInactive()` so they never take focus. Missing or
 * destroyed windows are skipped, and a window that was hidden already stays
 * hidden. When nothing was hidden the wait is skipped. The windows are restored
 * even when `run` throws, and a window destroyed during `run` is not shown again.
 *
 * @template T
 * @param {Array<object | null | undefined>} windows Electron BrowserWindows, or missing entries.
 * @param {() => T | Promise<T>} run The capture to take while the windows are hidden.
 * @param {{
 *   settleMs?: number,
 *   wait?: (ms: number) => Promise<void>,
 * }} [options] `settleMs` is how long to wait after hiding, so the compositor
 *   drops the windows from the frame. `wait` is injectable for tests.
 * @returns {Promise<T>} The value `run` returns.
 */
export async function withAppWindowsHidden(
  windows,
  run,
  { settleMs = 120, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  const hidden = windows.filter((win) => live(win) && win.isVisible());
  try {
    for (const win of hidden) win.hide();
    if (hidden.length > 0) await wait(settleMs);
    return await run();
  } finally {
    for (const win of hidden) {
      if (live(win)) win.showInactive();
    }
  }
}
