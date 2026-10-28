/** Text for the control window's grounding panel. Pure, so it is tested without a DOM. */
export const NO_DOCUMENT = "No document. Answers use general knowledge.";

export function groundingStatusText({ document = null, readError = null } = {}) {
  if (document) {
    const words = Number(document.words ?? 0);
    return `${document.name} · ${words.toLocaleString("en-US")} ${words === 1 ? "word" : "words"}`;
  }
  return readError || NO_DOCUMENT;
}

/** The notice for a document that load() cut to the cap (documentMetadata `trimmedFrom`), or "". */
export function groundingNoticeText(document) {
  const from = document?.trimmedFrom;
  if (!document || typeof from !== "number" || !(from > 0)) return "";
  const limit = Number(document.chars ?? 0).toLocaleString("en-US");
  return `${document.name} had ${from.toLocaleString("en-US")} characters, over the ${limit} limit, so it was cut to the first ${limit}. Load a shorter file to choose what stays.`;
}

export function groundingErrorText(error) {
  return typeof error?.message === "string" && error.message ? error.message : "Couldn't load the document.";
}
