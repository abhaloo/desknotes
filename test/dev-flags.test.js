import test from "node:test";
import assert from "node:assert/strict";
import { resolveDevFlags } from "../src/desktop/dev-flags.js";

test("resolveDevFlags: the accessibility flag is on only for an unpackaged run that sets it", () => {
  const flags = resolveDevFlags({ env: { COPILOT_TEST_A11Y: "1" }, isPackaged: false });
  assert.equal(flags.allowAccessibility, true);
  assert.deepEqual(flags.warnings, []);
});

test("resolveDevFlags: a packaged build ignores the accessibility flag and says so", () => {
  const flags = resolveDevFlags({ env: { COPILOT_TEST_A11Y: "1" }, isPackaged: true });
  assert.equal(flags.allowAccessibility, false);
  assert.deepEqual(flags.warnings, ["COPILOT_TEST_A11Y ignored in packaged builds"]);
});

test("resolveDevFlags: no flag set means accessibility stays off with no warnings", () => {
  assert.deepEqual(resolveDevFlags({ env: {}, isPackaged: false }), { allowAccessibility: false, warnings: [] });
  assert.deepEqual(resolveDevFlags({ env: {}, isPackaged: true }), { allowAccessibility: false, warnings: [] });
  assert.deepEqual(resolveDevFlags(), { allowAccessibility: false, warnings: [] });
});
