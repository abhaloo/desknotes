/**
 * Dual-runtime timer helper.
 *
 * `unref()` exists in both runtimes but is NOT semantically safe to use the
 * same way: on Node/Electron it is the right defensive move (an in-flight
 * timer must not keep Electron's main process or a server alive), while on Bun
 * (1.3.x) an unref'd timer stops firing entirely while a Promise awaits it —
 * the process hangs instead of resolving. Guard by runtime so the same code
 * runs correctly under both.
 */

const IS_BUN = Boolean(process.versions?.bun);
const IS_NODE = Boolean(process.versions?.node);

/**
 * Unref a timeout handle when the runtime honors it (Node / Electron).
 * No-op on Bun. Returns the handle for chaining.
 * @template {object|number} T
 * @param {T} timer
 * @returns {T}
 */
export function unrefTimer(timer) {
  if (IS_NODE && !IS_BUN) timer?.unref?.();
  return timer;
}

export const runtime = { isBun: IS_BUN, isNode: IS_NODE };
