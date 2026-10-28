import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
      ["big.md", "a".repeat(MAX_DOCUMENT_CHARS + 1), "E_DOC_TOO_LARGE", /This file has 12,001 characters\. The limit is 12,000\. Trim it and load it again\./],
      ["huge.md", "a".repeat(128 * 1024 + 1), "E_DOC_TOO_LARGE", /This file is 129 KB\. The limit is 12,000 characters\./],
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

/**
 * An earlier build allowed 30,000 characters; the cap is now 12,000
 * (shared/context-budget.js). A saved document over the cap is not refused:
 * it loads cut to the first 12,000 characters, the file is rewritten once
 * that way with `trimmedFrom`, and the notice stays until the rep loads
 * another file or clears, so it is seen even if Settings is not opened in
 * the session where the trim happened.
 */
test("a saved document over the cap loads trimmed to the cap, rewritten once, and says where it came from", () =>
  withDirs(async ({ userData, docs }) => {
    const file = path.join(userData, GROUNDING_FILENAME);
    const long = `${"# Title\n\n"}${"x".repeat(30_000)}`;
    await writeFile(file, JSON.stringify({ version: 1, name: "old.md", text: long, loadedAt: "2026-01-01T00:00:00.000Z" }));
    const loaded = await createGroundingDocumentStore({ userDataDir: userData }).load();
    assert.equal(loaded.readError, null);
    assert.deepEqual(loaded.document, {
      name: "old.md",
      text: long.slice(0, MAX_DOCUMENT_CHARS),
      loadedAt: "2026-01-01T00:00:00.000Z",
      trimmedFrom: long.length,
    });
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.text.length, MAX_DOCUMENT_CHARS, "the file is rewritten trimmed");
    assert.equal(stored.trimmedFrom, long.length);
    assert.equal(stored.name, "old.md");
    assert.equal(stored.loadedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(stored.version, 1);
    // A later load reads the rewritten file: the same document, the notice still on.
    const again = await createGroundingDocumentStore({ userDataDir: userData }).load();
    assert.deepEqual(again, loaded);
    assert.deepEqual(documentMetadata(loaded.document), {
      name: "old.md",
      words: 3,
      chars: MAX_DOCUMENT_CHARS,
      loadedAt: "2026-01-01T00:00:00.000Z",
      trimmedFrom: long.length,
    });
    // Loading another file ends the notice: a fresh envelope, no trimmedFrom anywhere.
    const store = createGroundingDocumentStore({ userDataDir: userData, now: fixedNow });
    const fresh = path.join(docs, "new.md");
    await writeFile(fresh, "Short.");
    const doc = await store.importFile(fresh);
    assert.equal("trimmedFrom" in doc, false);
    assert.equal("trimmedFrom" in documentMetadata(doc), false);
    assert.equal("trimmedFrom" in JSON.parse(await readFile(file, "utf8")), false);
    assert.deepEqual((await store.load()).document, doc);
  }));

test("exactly the cap is not trimmed; a rewritten file that is within the cap keeps its notice; clear ends it", () =>
  withDirs(async ({ userData }) => {
    const file = path.join(userData, GROUNDING_FILENAME);
    await writeFile(file, JSON.stringify({ version: 1, name: "max.md", text: "y".repeat(MAX_DOCUMENT_CHARS) }));
    const exact = await createGroundingDocumentStore({ userDataDir: userData }).load();
    assert.equal(exact.document.text.length, MAX_DOCUMENT_CHARS);
    assert.equal("trimmedFrom" in exact.document, false);
    assert.ok(!("trimmedFrom" in JSON.parse(await readFile(file, "utf8"))), "nothing to rewrite");

    await writeFile(file, JSON.stringify({ version: 1, name: "cut.md", text: "z".repeat(100), trimmedFrom: 20_000 }));
    const kept = await createGroundingDocumentStore({ userDataDir: userData }).load();
    assert.equal(kept.document.trimmedFrom, 20_000);
    // A trimmedFrom that is not a count above the cap is ignored.
    for (const bad of ["20000", -1, 12_000, null]) {
      await writeFile(file, JSON.stringify({ version: 1, name: "cut.md", text: "z".repeat(100), trimmedFrom: bad }));
      assert.equal("trimmedFrom" in (await createGroundingDocumentStore({ userDataDir: userData }).load()).document, false, String(bad));
    }

    const store = createGroundingDocumentStore({ userDataDir: userData });
    await store.clear();
    assert.deepEqual(await store.load(), { document: null, readError: null });
  }));

test("when the trimmed file cannot be rewritten the trimmed document is still the one in use", () =>
  withDirs(async ({ userData }) => {
    const file = path.join(userData, GROUNDING_FILENAME);
    const long = "x".repeat(MAX_DOCUMENT_CHARS + 5);
    await writeFile(file, JSON.stringify({ version: 1, name: "old.md", text: long }));
    const fs = {
      ...(await import("node:fs/promises")),
      writeFile: async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    };
    const loaded = await createGroundingDocumentStore({ userDataDir: userData, fs }).load();
    assert.equal(loaded.readError, null);
    assert.equal(loaded.document.text.length, MAX_DOCUMENT_CHARS);
    assert.equal(loaded.document.trimmedFrom, long.length);
    assert.equal(JSON.parse(await readFile(file, "utf8")).text.length, long.length, "the file is as it was; the next launch trims again");
  }));

test("the store refuses a relative user-data directory", () => {
  assert.throws(() => createGroundingDocumentStore({ userDataDir: "relative/dir" }), /absolute/);
});
