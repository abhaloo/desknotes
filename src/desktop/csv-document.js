/**
 * A CSV (a CRM export) rendered to the Markdown the answer model sees: one
 * `##` section per row, one `- Column: value` line per non-empty cell.
 *
 * Why Markdown sections: the pipeline's fitDocuments() keeps or drops whole
 * heading sections by relevance to the question, so each row becomes a unit
 * it can reason about; and a bullet list with column names reads as facts
 * ("Stage: Closed Won") rather than a table the model has to align.
 *
 * The parser follows RFC 4180: comma-separated (semicolon or tab when the
 * header line says so), double quotes around fields that hold the delimiter,
 * a quote or a line break, `""` for a literal quote. Rows are trimmed; a row
 * with nothing in it is skipped; a short row is padded; a long row adds
 * `Column N` headers. Pure: no I/O.
 */
import { DocumentImportError } from "./document-error.js";

/** Headers that name the row, in the order they are tried against each column (a word prefix, case-insensitive). */
export const CSV_TITLE_HEADERS = Object.freeze(["account", "company", "customer", "name", "deal", "opportunity", "subject", "title"]);
const TITLE_PATTERN = new RegExp(`^(?:${CSV_TITLE_HEADERS.join("|")})\\b`, "i");
const DELIMITERS = [",", ";", "\t"];
const MAX_TITLE_CHARS = 80;

/** The delimiter the header line uses most: comma, semicolon or tab (comma when none appears). */
export function sniffDelimiter(text) {
  const header = String(text ?? "").split(/\r\n|\r|\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const found = header.split(delimiter).length - 1;
    if (found > bestCount) {
      best = delimiter;
      bestCount = found;
    }
  }
  return best;
}

/**
 * @returns {{delimiter: string, columns: string[], rows: string[][]}} the
 *   header names (trimmed; an empty one is `Column N`) and the data rows,
 *   every row as long as `columns`.
 */
export function parseCsv(text, { delimiter } = {}) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  const separator = DELIMITERS.includes(delimiter) ? delimiter : sniffDelimiter(source);
  const records = tokenize(source, separator);
  if (records.length === 0) throw noRows();
  const header = records[0].map((cell) => cell.trim());
  if (header.every((cell) => cell === "")) {
    throw new DocumentImportError("E_DOC_CSV_MALFORMED", "This CSV has no header row. The first line must name the columns.");
  }
  const columns = header.map((cell, index) => cell || columnName(index));
  const rows = [];
  for (const record of records.slice(1)) {
    const cells = record.map((cell) => cell.trim());
    if (cells.every((cell) => cell === "")) continue;
    while (columns.length < cells.length) columns.push(columnName(columns.length));
    rows.push(cells);
  }
  if (rows.length === 0) throw noRows();
  for (const row of rows) while (row.length < columns.length) row.push("");
  return { delimiter: separator, columns, rows };
}

/** The column that names each row: the first account-like header, else the first column. */
export function csvTitleColumn(columns) {
  const index = (Array.isArray(columns) ? columns : []).findIndex((column) => TITLE_PATTERN.test(String(column ?? "").trim()));
  return index < 0 ? 0 : index;
}

/** The Markdown for a parsed CSV: sections in row order, separated by a blank line. */
export function renderCsvDocument({ columns = [], rows = [] } = {}) {
  const titleIndex = csvTitleColumn(columns);
  return rows
    .map((row, index) => {
      const title = oneLine(row[titleIndex]).slice(0, MAX_TITLE_CHARS) || `Row ${index + 1}`;
      const lines = [`## ${title}`];
      row.forEach((cell, column) => {
        const value = oneLine(cell);
        if (value) lines.push(`- ${columns[column] ?? columnName(column)}: ${value}`);
      });
      return lines.join("\n");
    })
    .join("\n\n");
}

/** A cell on one line: line breaks and the blanks around them become one space. */
function oneLine(cell) {
  return String(cell ?? "").replace(/\s*\n\s*/g, " ").trim();
}

function columnName(index) {
  return `Column ${index + 1}`;
}

function noRows() {
  return new DocumentImportError("E_DOC_EMPTY", "This CSV has no rows.");
}

/**
 * Records as arrays of raw (untrimmed) cells. A quote starts a quoted cell
 * only at the start of the cell; inside, `""` is a literal quote and a lone
 * quote must be followed by the delimiter, a line break or the end of the
 * text. A final line break does not start a record.
 */
function tokenize(text, delimiter) {
  const records = [];
  let record = [];
  let cell = "";
  let line = 1;
  let quoted = false;
  let quoteLine = 0;
  let i = 0;
  const endRecord = () => {
    record.push(cell);
    records.push(record);
    record = [];
    cell = "";
  };
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        const next = text[i + 1];
        if (next !== undefined && next !== delimiter && next !== "\n") {
          throw new DocumentImportError("E_DOC_CSV_MALFORMED", `This CSV has a stray quote on line ${line}. Put quotes only around a whole cell.`);
        }
        quoted = false;
        i += 1;
        continue;
      }
      if (char === "\n") line += 1;
      cell += char;
      i += 1;
      continue;
    }
    if (char === '"' && cell === "") {
      quoted = true;
      quoteLine = line;
      i += 1;
      continue;
    }
    if (char === delimiter) {
      record.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (char === "\n") {
      endRecord();
      line += 1;
      i += 1;
      continue;
    }
    cell += char;
    i += 1;
  }
  if (quoted) {
    throw new DocumentImportError("E_DOC_CSV_MALFORMED", `This CSV has an unclosed quote on line ${quoteLine}. Close it and load the file again.`);
  }
  // Text that does not end with a line break still ends a record; a trailing
  // line break has already ended the last one.
  if (record.length > 0 || cell !== "") endRecord();
  return records;
}
