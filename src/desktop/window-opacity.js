/**
 * The user's window opacity (title-row slider): one value for every window
 * (control, overlay, multi-answer panels). Pure, so the preferences file and
 * the renderer share one range.
 *
 * Opacity 0 is never allowed: a fully transparent window is invisible and
 * unreachable.
 */
export const WINDOW_OPACITY = Object.freeze({ min: 0.3, max: 1, default: 1 });

/** A finite number clamped to the range; anything else is the default (fully opaque). */
export function clampWindowOpacity(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return WINDOW_OPACITY.default;
  const clamped = Math.min(WINDOW_OPACITY.max, Math.max(WINDOW_OPACITY.min, value));
  return Math.round(clamped * 100) / 100;
}
