/**
 * The importer shared by the grounding document and customer profiles: a
 * path from main's own file picker in, normalized text out.
 *
 * Main owns the path (the renderer never supplies one). A Markdown or text
 * file is the text itself; a CSV is rendered to Markdown (csv-document.js)
 * and every cap is applied to that rendering, because that is what the
 * answer model sees. Text is UTF-8 only (BOM stripped), NUL-free, LF-normalized
 * and trimmed.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { GROUNDING_CHARS } from "../shared/context-budget.js";
import { parseCsv, renderCsvDocument } from "./csv-document.js";
import { DocumentImportError } from "./document-error.js";

export { DocumentImportError };

export const DOCUMENT_EXTENSIONS = Object.freeze([".md", ".markdown", ".txt", ".csv"]);
export const MAX_DOCUMENT_BYTES = 128 * 1024;
const KINDS = Object.freeze({ ".md": "markdown", ".markdown": "markdown", ".txt": "text", ".csv": "csv" });

const defaultFs = Object.freeze({ stat, readFile });
const formatCount = (value) => value.toLocaleString("en-US");

/** "markdown" | "text" | "csv" by extension (case-insensitive), or null. */
export function documentKind(name) {
  return KINDS[path.extname(String(name ?? "")).toLowerCase()] ?? null;
}

/**
 * UTF-8 only (BOM stripped), no NUL, CRLF normalized, trimmed, at most
 * `maxChars`. `extensions` only shapes the "save it as" advice.
 */
export function decodeDocument(bytes, { maxChars = GROUNDING_CHARS, extensions = DOCUMENT_EXTENSIONS } = {}) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw notText(extensions);
  }
  if (text.includes("\u0000")) throw notText(extensions);
  text = text.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new DocumentImportError("E_DOC_EMPTY", "This file is empty.");
  if (text.length > maxChars) throw tooLong(text.length, maxChars);
  return text;
}

/**
 * @param {string} sourcePath an absolute path from the file picker
 * @param {{fs?: object, now?: () => Date, maxChars?: number, maxBytes?: number, extensions?: readonly string[]}} [options]
 * @returns {Promise<{name: string, kind: "markdown"|"text"|"csv", text: string, loadedAt: string, rows?: number, columns?: number}>}
 */
export async function importDocument(
  sourcePath,
  { fs, now = () => new Date(), maxChars = GROUNDING_CHARS, maxBytes = MAX_DOCUMENT_BYTES, extensions = DOCUMENT_EXTENSIONS } = {},
) {
  const io = fs ?? defaultFs;
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw new DocumentImportError("E_DOC_UNREADABLE", "Couldn't read this file.");
  }
  const name = path.basename(sourcePath);
  const extension = path.extname(name).toLowerCase();
  const kind = documentKind(name);
  if (!kind || !extensions.includes(extension)) {
    throw new DocumentImportError(
      "E_DOC_TYPE",
      `Only ${listExtensions(extensions, "and")} files can be loaded. Save it as one of those and load it again.`,
    );
  }
  let info;
  try {
    info = await io.stat(sourcePath);
  } catch (error) {
    throw unreadable(error);
  }
  if (typeof info?.size === "number" && info.size > maxBytes) {
    throw new DocumentImportError(
      "E_DOC_TOO_LARGE",
      `This file is ${formatCount(Math.ceil(info.size / 1024))} KB. The limit is ${formatCount(maxChars)} characters. Trim it and load it again.`,
    );
  }
  let bytes;
  try {
    bytes = await io.readFile(sourcePath);
  } catch (error) {
    throw unreadable(error);
  }
  const loadedAt = now().toISOString();
  if (kind !== "csv") {
    return { name, kind, text: decodeDocument(bytes, { maxChars, extensions }), loadedAt };
  }
  // The cap applies to the rendering, so the raw text is decoded without one
  // (maxBytes has already bounded it).
  const parsed = parseCsv(decodeDocument(bytes, { maxChars: Infinity, extensions }));
  const text = renderCsvDocument(parsed);
  if (text.length > maxChars) throw tooLong(text.length, maxChars);
  return { name, kind, text, rows: parsed.rows.length, columns: parsed.columns.length, loadedAt };
}

/** ".md, .txt and .csv" (".markdown" is implied by ".md"). */
function listExtensions(extensions, conjunction) {
  const shown = [...new Set(extensions.filter((extension) => extension !== ".markdown"))];
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} ${conjunction} ${shown[shown.length - 1]}`;
}

function tooLong(chars, maxChars) {
  return new DocumentImportError(
    "E_DOC_TOO_LARGE",
    `This file has ${formatCount(chars)} characters. The limit is ${formatCount(maxChars)}. Trim it and load it again.`,
  );
}

function notText(extensions) {
  return new DocumentImportError(
    "E_DOC_NOT_TEXT",
    `This file isn't plain text. Save it as ${listExtensions(extensions, "or")} and load it again.`,
  );
}

function unreadable(error) {
  const reason = error?.code ? ` (${error.code})` : "";
  return new DocumentImportError("E_DOC_UNREADABLE", `Couldn't read this file${reason}.`);
}
