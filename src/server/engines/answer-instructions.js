/**
 * User-editable answer instructions: one plain-text file with four numbered
 * sections, in this order.
 *
 *   1. Tone and writing style
 *   2. Role
 *   3. Answers to produce for detected questions
 *   4. Answers to produce for screenshots
 *
 * The answer prompt is Role + Tone + section 3. An answer that follows Analyse
 * screen (a screen turn) gets section 4 appended to that prompt. The file is
 * read again for every request, so a saved edit applies to the next answer
 * without a restart. An unreadable file falls back to the built-in prompt, and
 * an empty or missing section falls back to that section's default (a
 * half-edited file never sends an empty prompt).
 *
 * The seeded text is the built-in answer prompt (answerer.js
 * DEFAULT_SYSTEM_PROMPT), sentence for sentence, so a fresh file answers the
 * way the app did before it existed. Machine-facing parts stay in code: the
 * screen-interpretation prompt (vision.js), the screen rules and the
 * grounding-document rule are fixed, whatever the file says.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const ANSWER_INSTRUCTIONS_FILENAME = "answer-instructions.txt";

/** The four section headers, in file order. */
export const ANSWER_SECTIONS = Object.freeze([
  "Tone and writing style",
  "Role",
  "Answers to produce for detected questions",
  "Answers to produce for screenshots",
]);
const [TONE, ROLE, QUESTIONS, SCREENSHOTS] = ANSWER_SECTIONS;

/** Which request path a prompt is for. */
export const INSTRUCTION_KINDS = Object.freeze({ QUESTION: "question", SCREENSHOT: "screenshot" });

/** A spoken-answer prompt never needs more than this; a runaway file is cut here. */
export const MAX_INSTRUCTION_CHARS = 16_000;

/** Section 1 as seeded before answers became bullet lists (LEGACY_ANSWER_INSTRUCTIONS). */
const PROSE_TONE = [
  "Write the words the rep will say next, in the rep's voice: first person, spoken, short (two to four " +
    "sentences). Start with the direct answer. Add one concrete detail or example only if it helps, then stop.",
  "Talk like a person, not a chatbot. Use plain words and simple verbs (is, are, has, can) and contractions. " +
    'Mix short and longer sentences. Don\'t open with praise or filler like "Great question" or "Certainly", ' +
    "and don't end with a summary, a slogan or an offer to say more. Don't list things in threes by habit, " +
    'and don\'t use "not only... but", "not just X" or "it\'s not X, it\'s Y". Avoid these words: actually, ' +
    "delve, crucial, pivotal, robust, seamless, leverage, showcase, testament, landscape, vibrant, " +
    "additionally, furthermore, underscore, foster. Write plain sentences only: no em dashes, lists, bold, " +
    "headings or emojis.",
].join("\n\n");

const DEFAULT_BODIES = Object.freeze({
  [TONE]: [
    "Write the words the rep will say next, in the rep's voice: first person, spoken, short (two to four " +
      "bullets). Put the direct answer in the first bullet. Add one concrete detail or example only if it " +
      "helps, then stop.",
    "Talk like a person, not a chatbot. Use plain words and simple verbs (is, are, has, can) and contractions. " +
      'Don\'t open with praise or filler like "Great question", "Certainly" or "Let\'s dive in", and don\'t end ' +
      "with a summary, a slogan or an offer to say more. Don't list things in threes by habit, and don't use " +
      '"not only... but", "not just X" or "it\'s not X, it\'s Y". Write every answer as a bulleted list, never ' +
      'as paragraphs. Start every line with a dash and a space ("- "), and write one or two short sentences ' +
      "per bullet. Use Simplified Technical English: short sentences, plain verbs and simple words. Avoid " +
      "these words: actually, delve, crucial, pivotal, robust, seamless, leverage, showcase, testament, " +
      "landscape, vibrant, additionally, furthermore, underscore, foster. No em dashes: use commas, periods " +
      "or colons. No bold, headings, numbered lists or emojis.",
  ].join("\n\n"),
  [ROLE]: "You are a quiet call coach.",
  [QUESTIONS]:
    "Never invent credentials: degrees, certifications, licences, employers or job titles. When you don't " +
    "know a detail such as a price, answer as the rep would: say what it depends on and offer to send the " +
    "exact figure.",
  [SCREENSHOTS]:
    "When the answer follows a screen capture, answer what was asked in the conversation using what the " +
    "screen shows. If nothing was asked about it, answer the question or task on the screen.",
});

export const ANSWER_INSTRUCTION_DEFAULTS = DEFAULT_BODIES;

const PREAMBLE = [
  "# Answer instructions for DeskNotes.",
  "# Edit the text under the four numbered headings and save. The next answer",
  "# uses your changes; you don't need to restart the app.",
  "# Sections 1, 2 and 3 apply to every answer. Section 4 is added to the",
  "# answer that follows Analyse screen.",
  "# Keep the four heading lines. A section left empty uses the built-in text.",
  "# Lines that start with # are notes and are never sent.",
].join("\n");

function renderFile(preamble, bodies) {
  return `${preamble}\n\n${ANSWER_SECTIONS.map((name, index) => `${index + 1}. ${name}\n${bodies[name]}`).join("\n\n")}\n`;
}

export const DEFAULT_ANSWER_INSTRUCTIONS = renderFile(PREAMBLE, DEFAULT_BODIES);

/**
 * Seeds an earlier version wrote. A file that is still byte-identical to one
 * of these was never edited, so it is safe to replace with the current seed;
 * any other file is the user's and is never touched.
 */
export const LEGACY_ANSWER_INSTRUCTIONS = Object.freeze([
  // Until answers became bullet lists: section 1 asked for plain sentences.
  renderFile(PREAMBLE, { ...DEFAULT_BODIES, [TONE]: PROSE_TONE }),
  // Until the screen turn: section 4 was the vision model's own prompt.
  renderFile(
    [
      "# Answer instructions for DeskNotes.",
      "# Edit the text under the four numbered headings and save. The next answer",
      "# uses your changes; you don't need to restart the app.",
      "# Sections 1 and 2 apply to every answer. Section 3 is for questions the app",
      "# hears; section 4 is for Analyse screen.",
      "# Keep the four heading lines. A section left empty uses the built-in text.",
      "# Lines that start with # are notes and are never sent.",
    ].join("\n"),
    { ...DEFAULT_BODIES, [TONE]: PROSE_TONE, [SCREENSHOTS]: "Draft a short helpful answer to what the screenshot shows." },
  ),
]);

/** "3. Answers to produce for detected questions:" -> the canonical name, else null. */
function headerName(line) {
  const bare = line
    .trim()
    .replace(/^\d+\s*[.)]\s*/, "")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();
  return ANSWER_SECTIONS.find((name) => name.toLowerCase() === bare) ?? null;
}

/** Section name -> body text ("" when absent). Text before the first header is ignored. */
export function parseAnswerInstructions(text) {
  const collected = Object.create(null);
  let current = null;
  for (const line of String(text ?? "").slice(0, MAX_INSTRUCTION_CHARS).split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const header = headerName(line);
    if (header) {
      current = header;
      collected[header] ??= [];
      continue;
    }
    if (current) collected[current].push(line);
  }
  const out = {};
  for (const name of ANSWER_SECTIONS) out[name] = (collected[name] ?? []).join("\n").trim();
  return out;
}

/**
 * Role + Tone + the section for this path; a section left empty uses its
 * default. QUESTION is the answer prompt; SCREENSHOT composes Role + Tone +
 * section 4.
 */
export function composeAnswerInstructions(sections, kind = INSTRUCTION_KINDS.QUESTION) {
  const source = sections && typeof sections === "object" ? sections : {};
  const answers = kind === INSTRUCTION_KINDS.SCREENSHOT ? SCREENSHOTS : QUESTIONS;
  return [ROLE, TONE, answers]
    .map((name) => String(source[name] ?? "").trim() || DEFAULT_BODIES[name])
    .join("\n\n");
}

/** Section 4 on its own (what a screen turn appends); empty uses the default. */
export function screenAnswerSection(sections) {
  const source = sections && typeof sections === "object" ? sections : {};
  return String(source[SCREENSHOTS] ?? "").trim() || DEFAULT_BODIES[SCREENSHOTS];
}

/**
 * Read the file now and compose the prompt for one path. `screen` is section
 * 4 alone, from the same read, for the answer to a screen turn.
 * @returns {Promise<{prompt: string, screen: string, source: "file"|"default", error: string|null}>}
 */
export async function loadAnswerInstructions(filePath, kind = INSTRUCTION_KINDS.QUESTION, { readFileImpl = readFile } = {}) {
  try {
    const sections = parseAnswerInstructions(await readFileImpl(filePath, "utf8"));
    return { prompt: composeAnswerInstructions(sections, kind), screen: screenAnswerSection(sections), source: "file", error: null };
  } catch (error) {
    return {
      prompt: composeAnswerInstructions(null, kind),
      screen: screenAnswerSection(null),
      source: "default",
      error: String(error?.code ?? error?.message ?? error),
    };
  }
}

/**
 * Write the default file once. An existing file is never touched, with one
 * exception: a file byte-identical to an earlier seed (LEGACY_ANSWER_INSTRUCTIONS)
 * was never edited, so it is replaced by the current seed (`updated: true`).
 */
export async function ensureAnswerInstructionsFile(
  filePath,
  { writeFileImpl = writeFile, mkdirImpl = mkdir, readFileImpl = readFile, renameImpl = rename } = {},
) {
  try {
    await mkdirImpl(dirname(filePath), { recursive: true });
    await writeFileImpl(filePath, DEFAULT_ANSWER_INSTRUCTIONS, { flag: "wx" });
    return { created: true, updated: false, error: null };
  } catch (error) {
    if (error?.code !== "EEXIST") return { created: false, updated: false, error: String(error?.code ?? error?.message ?? error) };
  }
  try {
    const current = await readFileImpl(filePath, "utf8");
    if (!LEGACY_ANSWER_INSTRUCTIONS.includes(current)) return { created: false, updated: false, error: null };
    // Write beside it, then swap: a crash mid-write never leaves half a file.
    const next = `${filePath}.${process.pid}.tmp`;
    await writeFileImpl(next, DEFAULT_ANSWER_INSTRUCTIONS);
    await renameImpl(next, filePath);
    return { created: false, updated: true, error: null };
  } catch (error) {
    return { created: false, updated: false, error: String(error?.code ?? error?.message ?? error) };
  }
}
