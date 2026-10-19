/** Reads the environment switches that only a development or test run may use. */

/**
 * A packaged build ignores every test switch and logs that it did, so a stray
 * variable on a user's machine cannot change how the app behaves.
 *
 * @param {{ env?: Record<string, string | undefined>, isPackaged?: boolean }} [options]
 * @returns {{ allowAccessibility: boolean, warnings: string[] }}
 */
export function resolveDevFlags({ env = {}, isPackaged = true } = {}) {
  const warnings = [];
  let allowAccessibility = false;
  if (env.COPILOT_TEST_A11Y === "1") {
    if (isPackaged) warnings.push("COPILOT_TEST_A11Y ignored in packaged builds");
    else allowAccessibility = true;
  }
  return { allowAccessibility, warnings };
}
