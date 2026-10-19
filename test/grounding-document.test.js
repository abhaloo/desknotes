import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GROUNDING_FILENAME,
  MAX_DOCUMENT_CHARS,
  STORED_DOCUMENT_UNREADABLE,
  createGroundingDocumentStore,
  documentMetadata,
} from "../src/desktop/grounding-document.js";

const fixedNow = () => new Date("2026-10-14T12:00:00.000Z");

async function withDirs(fn) {
  const userData = await mkdtemp(path.join(tmpdir(), "grounding-store-"));
  const docs = await mkdtemp(path.join(tmpdir(), "grounding-docs-"));
  try {
    await fn({ userData, docs });
  } finally {
    await rm(userData, { recursive: true, force: true });
    await rm(docs, { recursive: true, force: true });
  }
}

test("a missing file means no document and no error", () =>
  withDirs(async ({ userData }) => {
    const loaded = await createGroundingDocumentStore({ userDataDir: userData }).load();
    assert.deepEqual(loaded, { document: null, readError: null });
  }));

test("importFile normalizes the text, saves under the fixed name and survives a reload", () =>
  withDirs(async ({ userData, docs }) => {
    const source = path.join(docs, "resume.md");
    await writeFile(source, "\uFEFF# Pat Doe\r\n\r\nLed the Acme migration in 2021.\r\n");
    const store = createGroundingDocumentStore({ userDataDir: userData, now: fixedNow });
    const doc = await store.importFile(source);
    assert.deepEqual(doc, {
      name: "resume.md",
      text: "# Pat Doe\n\nLed the Acme migration in 2021.",
      loadedAt: "2026-10-14T12:00:00.000Z",
    });
    assert.deepEqual(await readdir(userData), [GROUNDING_FILENAME]);
    const again = await createGroundingDocumentStore({ userDataDir: userData }).load();
    assert.deepEqual(again, { document: doc, readError: null });
    assert.deepEqual(documentMetadata(doc), {
      name: "resume.md",
      words: 9,
      chars: doc.text.length,
      loadedAt: "2026-10-14T12:00:00.000Z",
    });
    assert.equal(documentMetadata(null), null);
  }));

test("upper-case extensions and .txt/.markdown are accepted", () =>
  withDirs(async ({ userData, docs }) => {
    const store = createGroundingDocumentStore({ userDataDir: userData });
    for (const name of ["NOTES.MD", "plain.txt", "long.markdown"]) {
      const file = path.join(docs, name);
      await writeFile(file, "Some facts.");
      assert.equal((await store.importFile(file)).name, name);
    }
  }));

test("each rejection leaves the previous document in place", () =>
  withDirs(async ({ userData, docs }) => {
    const store = createGroundingDocumentStore({ userDataDir: userData, now: fixedNow });
    const good = path.join(docs, "good.txt");
    await writeFile(good, "Keep me.");
    await store.importFile(good);
    const cases = [
      ["notes.pdf", Buffer.from("%PDF-1.7"), "E_DOC_TYPE", /Only \.md and \.txt files can be loaded/],
      ["big.md", "a".repeat(MAX_DOCUMENT_CHARS + 1), "E_DOC_TOO_LARGE", /This file has 30,001 characters\. The limit is 30,000\. Trim it and load it again\./],
      ["huge.md", "a".repeat(128 * 1024 + 1), "E_DOC_TOO_LARGE", /This file is 129 KB\. The limit is 30,000 characters\./],
      ["binary.md", Buffer.from([0x48, 0x00, 0x49]), "E_DOC_NOT_TEXT", /This file isn't plain text\. Save it as \.md or \.txt and load it again\./],
      ["latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9]), "E_DOC_NOT_TEXT", /isn't plain text/],
      ["empty.md", " \r\n\t ", "E_DOC_EMPTY", /^This file is empty\.$/],
    ];
    for (const [name, body, code, message] of cases) {
      const file = path.join(docs, name);
      await writeFile(file, body);
      await assert.rejects(() => store.importFile(file), (error) => {
        assert.equal(error.code, code, name);
        assert.match(error.message, message, name);
        return true;
      });
    }
    await assert.rejects(() => store.importFile(path.join(docs, "missing.md")), (error) => {
      assert.equal(error.code, "E_DOC_UNREADABLE");
      assert.match(error.message, /^Couldn't read this file/);
      return true;
    });
    const { document } = await store.load();
    assert.equal(document.text, "Keep me.");
  }));

test("a damaged saved file reads as no document plus a readError", () =>
  withDirs(async ({ userData }) => {
    for (const body of ["{not json", JSON.stringify({ version: 1, name: "a.md" }), JSON.stringify([1, 2])]) {
      await writeFile(path.join(userData, GROUNDING_FILENAME), body);
      const loaded = await createGroundingDocumentStore({ userDataDir: userData }).load();
      assert.deepEqual(loaded, { document: null, readError: STORED_DOCUMENT_UNREADABLE });
    }
    assert.equal(STORED_DOCUMENT_UNREADABLE, "The saved document couldn't be read. Load it again.");
  }));

test("clear removes the saved file and is safe to repeat", () =>
  withDirs(async ({ userData, docs }) => {
    const store = createGroundingDocumentStore({ userDataDir: userData });
    const file = path.join(docs, "a.md");
    await writeFile(file, "Facts.");
    await store.importFile(file);
    await store.clear();
    assert.deepEqual(await store.load(), { document: null, readError: null });
    await store.clear();
    assert.deepEqual(await readdir(userData), []);
  }));

test("the store refuses a relative user-data directory", () => {
  assert.throws(() => createGroundingDocumentStore({ userDataDir: "relative/dir" }), /absolute/);
});
