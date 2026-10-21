/**
 * The quiet line under a card that another model answered.
 *
 * turn.done carries `fallback` = `{to, from?, reason?}` when the chosen answer
 * model could not answer (no key, out of credit, a rejected key, a rate
 * limit) and another one did (src/server/engines/index.js). The rep only
 * needs two facts at a glance: which model wrote this card, and why the
 * chosen one did not. So the line is "Fallback: <model> · <why>", painted in
 * the muted note style after the last card line, like "Answer cut short.".
 * It never enters the card text, and nothing shows while the answer streams.
 */

/** Each reason as a few words after the chosen model's name. */
const REASONS = Object.freeze({
  out_of_credit: (from) => `${from} out of credit`,
  key_rejected: (from) => `${from} key rejected`,
  refused: (from) => `${from} refused`,
  rate_limited: (from) => `${from} rate-limited`,
  unavailable: (from) => `${from} unavailable`,
  no_key: (from) => `no key for ${from}`,
});

/**
 * The note for a turn.done `fallback`, or "" when there is none.
 * @param {{to?: string, from?: string, reason?: string}|null|undefined} fallback
 */
export function fallbackNoteText(fallback) {
  const to = typeof fallback?.to === "string" ? fallback.to.trim() : "";
  if (!to) return "";
  const from = typeof fallback.from === "string" ? fallback.from.trim() : "";
  const why = from && Object.hasOwn(REASONS, fallback.reason) ? REASONS[fallback.reason](from) : "";
  return why ? `Fallback: ${to} · ${why}` : `Fallback: ${to}`;
}
