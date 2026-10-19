/**
 * Key-phrase highlights in answer text (docs/plans/answer-highlights.md).
 *
 * On the wire an answer may wrap at most one phrase per bullet, and at most
 * three per answer, in `**`: "• Use **Go Live** to start." The spoken-text
 * filter guarantees the shape (balanced pairs, the caps, five words at most);
 * the renderer paints a pair as an orange span. Anything that reuses answer
 * text as plain words (history sent back to the model, the rep-context card
 * comparison, logs) strips the markers with `stripHighlights`.
 *
 * Off (Settings "Highlight key phrases", HIGHLIGHTS=0) the filter strips every
 * `**` exactly as it did before the feature, so no marker reaches the wire.
 */

/** Opens and closes a highlighted phrase. */
export const HIGHLIGHT_MARK = "**";

/** The shape the filter enforces. */
export const HIGHLIGHT_LIMITS = Object.freeze({ perBullet: 1, perAnswer: 3, words: 5 });

/** app-preferences.json field and settings:get/set key. */
export const HIGHLIGHTS_SETTING = "highlights";

/** Env spelling of the setting for a standalone server: 0/false/off turns it off. */
export const HIGHLIGHTS_ENV = "HIGHLIGHTS";

/** The answer text without its markers: what the rep reads, as plain words. */
export function stripHighlights(text) {
  return String(text ?? "").replaceAll(HIGHLIGHT_MARK, "");
}

/**
 * The HIGHLIGHTS switch: 0/false/off -> false, 1/true/on or unset -> true,
 * anything else -> null (the caller keeps the default and says so).
 */
export function parseHighlightsSwitch(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "" || value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  return null;
}
