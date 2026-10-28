/**
 * Text for the control window's Customer panel (Settings > Customer). Pure,
 * so it is tested without a DOM. Everything here works from profile
 * metadata (customer-profiles.js profileMetadata): names and counts, never
 * document text.
 */
/** Keep in step with src/shared/context-budget.js PROFILE_CHARS and PROFILE_MAX_DOCUMENTS (test/customer-view.test.js compares them). */
export const PROFILE_CHARS = 14_000;
export const PROFILE_MAX_DOCUMENTS = 3;

export const NO_PROFILE = "No profile. Answers use the grounding document and general knowledge.";
export const PROFILE_APPLIED = "Profile applies to the next answer.";

const count = (value, word) => {
  const n = Number(value ?? 0);
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
};

/** "Acme Corp · 2 files · 1,234 words", "Acme Corp · no files yet", the read error, or NO_PROFILE. */
export function profileStatusText({ profile = null, readError = null } = {}) {
  if (profile) {
    const files = Array.isArray(profile.documents) ? profile.documents.length : 0;
    if (files === 0) return `${profile.name} · no files yet`;
    return `${profile.name} · ${count(files, "file")} · ${count(profile.words, "word")}`;
  }
  return readError || NO_PROFILE;
}

/** "7,000 of 14,000 characters · 2 of 3 files", or "" without a profile. */
export function profileRoomText(profile) {
  if (!profile) return "";
  const files = Array.isArray(profile.documents) ? profile.documents.length : 0;
  const chars = Number(profile.chars ?? 0).toLocaleString("en-US");
  return `${chars} of ${PROFILE_CHARS.toLocaleString("en-US")} characters · ${files} of ${PROFILE_MAX_DOCUMENTS} files`;
}

/** "deals.csv · 12 rows · 900 words" for a CSV, "notes.md · 334 words" otherwise. */
export function documentLineText(document) {
  const parts = [document.name];
  if (typeof document.rows === "number") parts.push(count(document.rows, "row"));
  parts.push(count(document.words, "word"));
  return parts.join(" · ");
}

/** The picker's options: None first, then the profiles as listed, the selected one marked. */
export function profileOptions(profiles, selectedId) {
  const listed = Array.isArray(profiles) ? profiles : [];
  const selected = listed.some((profile) => profile.id === selectedId) ? selectedId : null;
  return [
    { value: "", label: "None", selected: selected === null },
    ...listed.map((profile) => ({ value: profile.id, label: profile.name, selected: profile.id === selected })),
  ];
}

export function profileErrorText(error) {
  return typeof error?.message === "string" && error.message ? error.message : "Couldn't update the profile.";
}
