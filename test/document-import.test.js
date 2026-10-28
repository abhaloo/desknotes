import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DOCUMENT_EXTENSIONS,
  DocumentImportError,
  MAX_DOCUMENT_BYTES,
  decodeDocument,
  documentKind,
  importDocument,
} from "../src/desktop/document-import.js";

/**
 * The importer shared by the grounding document and customer profiles: a
 * path from main's own file picker in, normalized text out. A CSV comes out
 * as the Markdown the model will see (csv-document.js), and every cap is
 * applied to that text, not to the file.
 */

const fixedNow = () => new Date("2026-10-14T12:00:00.000Z");

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "document-import-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the accepted extensions and their kinds", () => {
  assert.deepEqual(DOCUMENT_EXTENSIONS, [".md", ".markdown", ".txt", ".csv"]);
  assert.equal(documentKind("notes.md"), "markdown");
  assert.equal(documentKind("notes.MARKDOWN"), "markdown");
  assert.equal(documentKind("notes.txt"), "text");
  assert.equal(documentKind("deals.CSV"), "csv");
  assert.equal(documentKind("deck.pdf"), null);
  assert.equal(documentKind("noext"), null);
  assert.equal(MAX_DOCUMENT_BYTES, 128 * 1024);
});

test("decodeDocument: UTF-8 only, BOM stripped, CRLF normalized, trimmed, capped", () => {
  assert.equal(decodeDocument(Buffer.from("\uFEFF  a\r\nb\rc\n\n")), "a\nb\nc");
  assert.equal(decodeDocument(Buffer.from("abc"), { maxChars: 3 }), "abc");
  for (const [bytes, code, message] of [
    [Buffer.from([0x48, 0x00, 0x49]), "E_DOC_NOT_TEXT", /isn't plain text/],
    [Buffer.from([0x63, 0x61, 0x66, 0xe9]), "E_DOC_NOT_TEXT", /isn't plain text/],
    [Buffer.from(" \r\n\t "), "E_DOC_EMPTY", /^This file is empty\.$/],
    [Buffer.from("abcd"), "E_DOC_TOO_LARGE", /This file has 4 characters\. The limit is 3\. Trim it and load it again\./],
  ]) {
    assert.throws(() => decodeDocument(bytes, { maxChars: 3 }), (error) => {
      assert.ok(error instanceof DocumentImportError);
      assert.equal(error.name, "DocumentImportError");
      assert.equal(error.code, code);
      assert.match(error.message, message);
      return true;
    });
  }
});

test("importDocument reads Markdown and text files into {name, kind, text, loadedAt}", () =>
  withDir(async (dir) => {
    const source = path.join(dir, "history.md");
    await writeFile(source, "\uFEFF# Acme\r\n\r\nRenewed in 2025.\r\n");
    assert.deepEqual(await importDocument(source, { now: fixedNow }), {
      name: "history.md",
      kind: "markdown",
      text: "# Acme\n\nRenewed in 2025.",
      loadedAt: "2026-10-14T12:00:00.000Z",
    });
    const plain = path.join(dir, "NOTES.TXT");
    await writeFile(plain, "Prefers email.");
    const imported = await importDocument(plain, { now: fixedNow });
    assert.equal(imported.name, "NOTES.TXT", "the name keeps its case");
    assert.equal(imported.kind, "text");
    assert.equal(imported.text, "Prefers email.");
  }));

test("importDocument renders a CSV to Markdown and reports its rows and columns", () =>
  withDir(async (dir) => {
    const source = path.join(dir, "deals.csv");
    await writeFile(source, '\uFEFFAccount Name,Stage,Amount\r\nAcme Corp,Closed Won,"48,000"\r\nAcme Corp,Renewal,\r\n');
    assert.deepEqual(await importDocument(source, { now: fixedNow }), {
      name: "deals.csv",
      kind: "csv",
      text: [
        "## Acme Corp",
        "- Account Name: Acme Corp",
        "- Stage: Closed Won",
        "- Amount: 48,000",
        "",
        "## Acme Corp",
        "- Account Name: Acme Corp",
        "- Stage: Renewal",
      ].join("\n"),
      rows: 2,
      columns: 3,
      loadedAt: "2026-10-14T12:00:00.000Z",
    });
  }));

test("the character cap applies to the rendered CSV, which is what the model sees", () =>
  withDir(async (dir) => {
    const source = path.join(dir, "wide.csv");
    // 70 bytes on disk; the rendering repeats each header, so it is longer.
    const body = "A very long column header,Another long header\n1,2\n3,4\n";
    await writeFile(source, body);
    assert.ok(body.length < 100);
    const imported = await importDocument(source, { maxChars: 200 });
    assert.ok(imported.text.length > body.length);
    await assert.rejects(() => importDocument(source, { maxChars: 100 }), (error) => {
      assert.equal(error.code, "E_DOC_TOO_LARGE");
      assert.match(error.message, /^This file has \d+ characters\. The limit is 100\./);
      return true;
    });
  }));

test("CSV errors carry their own codes and a file-level empty CSV is still E_DOC_EMPTY", () =>
  withDir(async (dir) => {
    const headerOnly = path.join(dir, "header.csv");
    await writeFile(headerOnly, "Account,Stage\n");
    await assert.rejects(() => importDocument(headerOnly), (error) => {
      assert.equal(error.code, "E_DOC_EMPTY");
      assert.match(error.message, /no rows/);
      return true;
    });
    const broken = path.join(dir, "broken.csv");
    await writeFile(broken, 'Account,Stage\n"Acme,Won\n');
    await assert.rejects(() => importDocument(broken), (error) => {
      assert.equal(error.code, "E_DOC_CSV_MALFORMED");
      return true;
    });
  }));

test("rejections: type, size on disk, size as text, binary, missing", () =>
  withDir(async (dir) => {
    const cases = [
      ["deck.pdf", Buffer.from("%PDF-1.7"), "E_DOC_TYPE", /^Only \.md, \.txt and \.csv files can be loaded\. Save it as one of those and load it again\.$/],
      ["big.md", "a".repeat(12_001), "E_DOC_TOO_LARGE", /This file has 12,001 characters\. The limit is 12,000\. Trim it and load it again\./],
      ["huge.md", "a".repeat(MAX_DOCUMENT_BYTES + 1), "E_DOC_TOO_LARGE", /This file is 129 KB\. The limit is 12,000 characters\./],
      ["binary.md", Buffer.from([0x48, 0x00, 0x49]), "E_DOC_NOT_TEXT", /This file isn't plain text\. Save it as \.md, \.txt or \.csv and load it again\./],
      ["empty.csv", "", "E_DOC_EMPTY", /^This file is empty\.$/],
    ];
    for (const [name, body, code, message] of cases) {
      const file = path.join(dir, name);
      await writeFile(file, body);
      await assert.rejects(() => importDocument(file), (error) => {
        assert.ok(error instanceof DocumentImportError, name);
        assert.equal(error.code, code, name);
        assert.match(error.message, message, name);
        return true;
      });
    }
    await assert.rejects(() => importDocument(path.join(dir, "missing.md")), (error) => {
      assert.equal(error.code, "E_DOC_UNREADABLE");
      assert.match(error.message, /^Couldn't read this file \(ENOENT\)\.$/);
      return true;
    });
    for (const bad of ["", null, 42]) {
      await assert.rejects(() => importDocument(bad), (error) => {
        assert.equal(error.code, "E_DOC_UNREADABLE");
        return true;
      });
    }
  }));

test("a caller may narrow the extensions, and the type message follows", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "deals.csv");
    await writeFile(file, "a\n1");
    await assert.rejects(() => importDocument(file, { extensions: [".md", ".markdown", ".txt"] }), (error) => {
      assert.equal(error.code, "E_DOC_TYPE");
      assert.match(error.message, /^Only \.md and \.txt files can be loaded\./);
      return true;
    });
  }));
