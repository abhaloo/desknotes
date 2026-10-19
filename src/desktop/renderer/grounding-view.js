/** Text for the control window's grounding panel. Pure, so it is tested without a DOM. */
export const NO_DOCUMENT = "No document. Answers use general knowledge.";

export function groundingStatusText({ document = null, readError = null } = {}) {
  if (document) {
    const words = Number(document.words ?? 0);
    return `${document.name} · ${words.toLocaleString("en-US")} ${words === 1 ? "word" : "words"}`;
  }
  return readError || NO_DOCUMENT;
}

export function groundingErrorText(error) {
  return typeof error?.message === "string" && error.message ? error.message : "Couldn't load the document.";
}
