/**
 * The context budget: the numbers the desktop stores and the server pipeline
 * must agree on, in one place.
 *
 * The answerer caps provider input at CONTEXT_CHARS. Of that, the pipeline
 * (engines/pipeline.js buildContext) reserves fixed shares for the sections
 * that change during a call: recent exchange, screen reading, prospect speech
 * and rep conversation, about 5,000 characters with their headings. The rest,
 * DOCUMENTS_CHARS, is for what the rep loaded: the grounding document and the
 * selected customer profile. Both are loaded whole, so together they must fit
 * that share; a profile document that would not fit is refused at import
 * (customer-profiles.js), never trimmed per question.
 */
export const CONTEXT_CHARS = 32_000;
/** Grounding document plus customer profile, together. */
export const DOCUMENTS_CHARS = 26_000;
/** One grounding document (grounding-document.js MAX_DOCUMENT_CHARS). With PROFILE_CHARS it fills DOCUMENTS_CHARS exactly. */
export const GROUNDING_CHARS = 12_000;
/** All of a customer profile's documents together. */
export const PROFILE_CHARS = 14_000;
export const PROFILE_MAX_DOCUMENTS = 3;
/**
 * The profile as sent (`session_context.customer.docs`): the texts plus a
 * `File: <name>` label per document. The server refuses more and the pipeline
 * keeps at most this much, so anything accepted on the wire is never trimmed.
 */
export const CUSTOMER_CHARS = 15_000;
/** The longest file name a document label can carry (Windows). */
const MAX_FILE_NAME_CHARS = 255;
/** What a profile at its cap can measure on the wire, with the longest possible labels. */
export const MAX_CUSTOMER_TEXT_CHARS =
  PROFILE_CHARS + PROFILE_MAX_DOCUMENTS * ("File: \n\n".length + MAX_FILE_NAME_CHARS) + (PROFILE_MAX_DOCUMENTS - 1) * "\n\n".length;

/** A character count, or 0 for anything that is not a positive finite number. */
function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * How many more characters the profile may take: its own cap or the shared
 * budget (after the grounding document), whichever leaves less. Never negative.
 */
export function profileRoom({ groundingChars, profileChars } = {}) {
  const grounding = count(groundingChars);
  const profile = count(profileChars);
  return Math.max(0, Math.min(PROFILE_CHARS - profile, DOCUMENTS_CHARS - grounding - profile));
}

/**
 * The limit a document of `addChars` would break, or null when it fits. The
 * profile's own cap is reported first: it is the one the rep can act on
 * without touching the grounding document.
 * @returns {{limit: "profile"|"documents", max: number, total: number}|null}
 */
export function profileOverflow({ groundingChars, profileChars, addChars } = {}) {
  const grounding = count(groundingChars);
  const profile = count(profileChars);
  const add = count(addChars);
  if (profile + add > PROFILE_CHARS) return { limit: "profile", max: PROFILE_CHARS, total: profile + add };
  if (grounding + profile + add > DOCUMENTS_CHARS) {
    return { limit: "documents", max: DOCUMENTS_CHARS, total: grounding + profile + add };
  }
  return null;
}
