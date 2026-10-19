/**
 * ASR output that is never a question: Whisper writes these on silence or
 * music. A final or a pause hint that is noise starts no answer and does not
 * replace the card on screen.
 */
export const NOISE_UTTERANCES = Object.freeze(
  new Set(["you", "thank you", "thanks", "thank you for watching", "thanks for watching", "music", "bye"]),
);

/** True for text with no letter or digit, a known noise phrase, or one word without a "?". */
export function isNoiseUtterance(text) {
  const raw = String(text ?? "").trim();
  if (!/[\p{L}\p{N}]/u.test(raw)) return true;
  const words = raw.toLowerCase().replace(/[[\]().,!?"'…]/g, " ").split(/\s+/).filter(Boolean);
  if (NOISE_UTTERANCES.has(words.join(" "))) return true;
  return words.length < 2 && !raw.includes("?");
}
