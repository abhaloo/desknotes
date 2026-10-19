import test from "node:test";
import assert from "node:assert/strict";
import {
  HIGHLIGHTS_ENV,
  HIGHLIGHTS_SETTING,
  HIGHLIGHT_LIMITS,
  HIGHLIGHT_MARK,
  parseHighlightsSwitch,
  stripHighlights,
} from "../src/shared/highlights.js";

test("the shared names: the marker, the limits, the setting and its env spelling", () => {
  assert.equal(HIGHLIGHT_MARK, "**");
  assert.deepEqual(HIGHLIGHT_LIMITS, { perBullet: 1, perAnswer: 3, words: 5 });
  assert.ok(Object.isFrozen(HIGHLIGHT_LIMITS));
  assert.equal(HIGHLIGHTS_SETTING, "highlights");
  assert.equal(HIGHLIGHTS_ENV, "HIGHLIGHTS");
});

test("stripHighlights leaves the plain words and nothing else changes", () => {
  assert.equal(stripHighlights("• Use **Go Live** to start.\n• Only **one session at a time**."), "• Use Go Live to start.\n• Only one session at a time.");
  assert.equal(stripHighlights("• No phrase here. 5 * 3"), "• No phrase here. 5 * 3");
  assert.equal(stripHighlights(""), "");
  assert.equal(stripHighlights(null), "");
  assert.equal(stripHighlights(undefined), "");
});

test("parseHighlightsSwitch: unset/1/true/on on, 0/false/off off, anything else null", () => {
  for (const value of [undefined, "", "1", "true", "on", " ON "]) assert.equal(parseHighlightsSwitch(value), true, String(value));
  for (const value of ["0", "false", "off", " Off "]) assert.equal(parseHighlightsSwitch(value), false, value);
  for (const value of ["maybe", "2", "yes"]) assert.equal(parseHighlightsSwitch(value), null, value);
});
