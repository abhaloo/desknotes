import test from "node:test";
import assert from "node:assert/strict";
import { CSV_TITLE_HEADERS, csvTitleColumn, parseCsv, renderCsvDocument, sniffDelimiter } from "../src/desktop/csv-document.js";

/**
 * A CSV (a CRM export) is rendered to Markdown at import time: one `##`
 * section per row, one `- Column: value` line per non-empty cell. The
 * pipeline's fitDocuments() keeps whole heading sections, so each row is
 * then a unit it can keep or drop by relevance.
 */

const DEALS = [
  "Account Name,Stage,Amount,Notes",
  'Acme Corp,Closed Won,"48,000","Asked for net-60; got net-45.',
  'Wants SSO next renewal."',
  ",,,",
  "Globex,Negotiation,,",
].join("\n");

test("parseCsv handles quotes, escaped quotes, embedded newlines, CRLF and blank rows", () => {
  const parsed = parseCsv(DEALS.replace(/\n/g, "\r\n"));
  assert.equal(parsed.delimiter, ",");
  assert.deepEqual(parsed.columns, ["Account Name", "Stage", "Amount", "Notes"]);
  assert.deepEqual(parsed.rows, [
    ["Acme Corp", "Closed Won", "48,000", "Asked for net-60; got net-45.\nWants SSO next renewal."],
    ["Globex", "Negotiation", "", ""],
  ]);
  assert.deepEqual(parseCsv('q\n"He said ""hi"""').rows, [['He said "hi"']]);
  // A trailing newline is not a row.
  assert.equal(parseCsv("a,b\n1,2\n").rows.length, 1);
});

test("cells and headers are trimmed; an empty header becomes Column N", () => {
  const parsed = parseCsv(" a , ,c \n 1 , 2 , 3 ");
  assert.deepEqual(parsed.columns, ["a", "Column 2", "c"]);
  assert.deepEqual(parsed.rows, [["1", "2", "3"]]);
});

test("ragged rows: short rows are padded, long rows grow the columns as Column N", () => {
  const parsed = parseCsv("a,b\n1,2,3\n4");
  assert.deepEqual(parsed.columns, ["a", "b", "Column 3"]);
  assert.deepEqual(parsed.rows, [
    ["1", "2", "3"],
    ["4", "", ""],
  ]);
});

test("the delimiter is sniffed from the header line: comma, semicolon or tab", () => {
  assert.equal(sniffDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(sniffDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(sniffDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  assert.equal(sniffDelimiter("single column\nrow"), ",", "nothing to split on: comma");
  // A European export: semicolons separate, commas are decimals.
  const parsed = parseCsv("Konto;Betrag\nAcme;48,5");
  assert.equal(parsed.delimiter, ";");
  assert.deepEqual(parsed.rows, [["Acme", "48,5"]]);
  assert.deepEqual(parseCsv("a\tb\n1\t2").rows, [["1", "2"]]);
});

test("a header-only file, a blank header and an unclosed quote are rejected with coded errors", () => {
  for (const [body, code, message] of [
    ["a,b\n", "E_DOC_EMPTY", /^This CSV has no rows\.$/],
    ["a,b", "E_DOC_EMPTY", /no rows/],
    ["a,b\n,,\n", "E_DOC_EMPTY", /no rows/],
    [",,\n1,2", "E_DOC_CSV_MALFORMED", /header/i],
    ['a,b\n"unclosed,1', "E_DOC_CSV_MALFORMED", /unclosed quote on line 2/],
    ['a,b\n"x"y,1', "E_DOC_CSV_MALFORMED", /line 2/],
  ]) {
    assert.throws(() => parseCsv(body), (error) => {
      assert.equal(error.name, "DocumentImportError", body);
      assert.equal(error.code, code, body);
      assert.match(error.message, message, body);
      return true;
    });
  }
});

test("csvTitleColumn picks the first account-like header, else the first column", () => {
  assert.deepEqual(CSV_TITLE_HEADERS, ["account", "company", "customer", "name", "deal", "opportunity", "subject", "title"]);
  assert.equal(csvTitleColumn(["Id", "Deal Name", "Owner"]), 1);
  assert.equal(csvTitleColumn(["Amount", "Company"]), 1);
  assert.equal(csvTitleColumn(["ACCOUNT", "Stage"]), 0, "case-insensitive");
  assert.equal(csvTitleColumn(["Contact", "Email"]), 0, "no match: first column");
  assert.equal(csvTitleColumn(["Opportunity Name", "Account Name"]), 0, "first matching header wins, in column order");
  assert.equal(csvTitleColumn(["Renamed", "Subject"]), 1, "the header must start with the word");
  assert.equal(csvTitleColumn([]), 0);
});

test("renderCsvDocument writes one heading section per row with the non-empty cells as bullets", () => {
  const rendered = renderCsvDocument(parseCsv(DEALS));
  assert.equal(
    rendered,
    [
      "## Acme Corp",
      "- Account Name: Acme Corp",
      "- Stage: Closed Won",
      "- Amount: 48,000",
      "- Notes: Asked for net-60; got net-45. Wants SSO next renewal.",
      "",
      "## Globex",
      "- Account Name: Globex",
      "- Stage: Negotiation",
    ].join("\n"),
  );
});

test("a row without a title gets Row N (its number among the kept rows); newlines in a cell become one space", () => {
  const rendered = renderCsvDocument(parseCsv('Name,Notes\n,"first\n\n  second"\nBeta,ok'));
  assert.equal(rendered, ["## Row 1", "- Notes: first second", "", "## Beta", "- Name: Beta", "- Notes: ok"].join("\n"));
});

test("the title column is the one csvTitleColumn picks, and the title cell is still listed", () => {
  const rendered = renderCsvDocument(parseCsv("Stage,Company\nWon,Initech"));
  assert.equal(rendered, ["## Initech", "- Stage: Won", "- Company: Initech"].join("\n"));
});

test("a title is cut to 80 characters and never starts a new heading or a new line", () => {
  const long = "x".repeat(100);
  const rendered = renderCsvDocument(parseCsv(`Name\n${long}`));
  assert.equal(rendered.split("\n")[0], `## ${"x".repeat(80)}`);
  const tricky = renderCsvDocument(parseCsv('Name\n"# not a heading\nsecond"'));
  assert.equal(tricky.split("\n")[0], "## # not a heading second");
});
