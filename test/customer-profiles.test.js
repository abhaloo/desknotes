import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_PROFILE_NAME_CHARS,
  PROFILES_DIRNAME,
  PROFILE_SELECTION_FILENAME,
  PROFILE_VERSION,
  STORED_PROFILE_UNREADABLE,
  STORED_SELECTION_UNREADABLE,
  createCustomerProfileStore,
  profileMetadata,
  renderProfileText,
} from "../src/desktop/customer-profiles.js";
import { DOCUMENTS_CHARS, PROFILE_CHARS, PROFILE_MAX_DOCUMENTS } from "../src/shared/context-budget.js";

/**
 * Customer profiles: a named set of up to three documents (Markdown, text or
 * a CSV export) about the account on the call, kept under
 * <userData>/profiles/<id>.json with the selection in profiles/selected.json.
 * Same discipline as grounding-document.js: main owns the paths, documents
 * are imported through main's own file picker, the text leaves the store only
 * towards the realtime session, and renderers get metadata only.
 */

const ID = /^[0-9a-f]{12}$/;
const fixedNow = () => new Date("2026-10-14T12:00:00.000Z");

/** A clock that moves one second per read, so updatedAt is observable. */
function ticking(start = "2026-10-14T12:00:00.000Z") {
  let t = new Date(start).getTime();
  return () => new Date((t += 1000));
}

async function withDirs(fn) {
  const userData = await mkdtemp(path.join(tmpdir(), "profiles-store-"));
  const docs = await mkdtemp(path.join(tmpdir(), "profiles-docs-"));
  try {
    await fn({ userData, docs });
  } finally {
    await rm(userData, { recursive: true, force: true });
    await rm(docs, { recursive: true, force: true });
  }
}

async function file(dir, name, body) {
  const target = path.join(dir, name);
  await writeFile(target, body);
  return target;
}

const DEALS_CSV = "Account Name,Stage,Amount\nAcme Corp,Closed Won,48000\nAcme Corp,Renewal,52000\n";
const DEALS_MD = ["## Acme Corp", "- Account Name: Acme Corp", "- Stage: Closed Won", "- Amount: 48000", "", "## Acme Corp", "- Account Name: Acme Corp", "- Stage: Renewal", "- Amount: 52000"].join("\n");

test("constants", () => {
  assert.equal(PROFILES_DIRNAME, "profiles");
  assert.equal(PROFILE_SELECTION_FILENAME, "selected.json");
  assert.equal(PROFILE_VERSION, 1);
  assert.equal(MAX_PROFILE_NAME_CHARS, 80);
  assert.equal(STORED_PROFILE_UNREADABLE, "A saved customer profile couldn't be read. Create it again.");
  assert.equal(STORED_SELECTION_UNREADABLE, "The selected customer profile couldn't be read. Select it again.");
});

test("an empty data folder lists no profiles, selects none and creates nothing on disk", () =>
  withDirs(async ({ userData }) => {
    const store = createCustomerProfileStore({ userDataDir: userData });
    assert.deepEqual(await store.list(), { profiles: [], selectedId: null, readError: null });
    assert.equal(await store.selected(), null);
    assert.equal(await store.get("000000000000"), null);
    assert.deepEqual(await readdir(userData), [], "listing never writes");
  }));

test("create saves profiles/<id>.json, lists by name, and a fresh store reads them back", () =>
  withDirs(async ({ userData }) => {
    const store = createCustomerProfileStore({ userDataDir: userData, now: fixedNow });
    const acme = await store.create({ name: "  Acme Corp  " });
    assert.match(acme.id, ID);
    assert.deepEqual(acme, {
      id: acme.id,
      name: "Acme Corp",
      chars: 0,
      words: 0,
      documents: [],
      createdAt: "2026-10-14T12:00:00.000Z",
      updatedAt: "2026-10-14T12:00:00.000Z",
    });
    const globex = await store.create({ name: "globex" });
    const beta = await store.create({ name: "Beta Industries" });
    assert.notEqual(acme.id, globex.id);
    assert.deepEqual(await readdir(userData), [PROFILES_DIRNAME]);
    const saved = (await readdir(path.join(userData, PROFILES_DIRNAME))).sort();
    assert.deepEqual(saved, [acme.id, beta.id, globex.id].map((id) => `${id}.json`).sort());
    const raw = JSON.parse(await readFile(path.join(userData, PROFILES_DIRNAME, `${acme.id}.json`), "utf8"));
    assert.equal(raw.version, PROFILE_VERSION);
    assert.equal(raw.id, acme.id);
    assert.equal(raw.name, "Acme Corp");
    assert.deepEqual(raw.documents, []);

    const listed = await createCustomerProfileStore({ userDataDir: userData }).list();
    assert.deepEqual(
      listed.profiles.map((p) => p.name),
      ["Acme Corp", "Beta Industries", "globex"],
      "sorted by name, case-insensitive",
    );
    assert.deepEqual(listed.profiles[0], acme);
    assert.equal(listed.selectedId, null);
    assert.equal(listed.readError, null);
  }));

test("a name is trimmed, at most 80 characters, plain text and unique (case-insensitive)", () =>
  withDirs(async ({ userData }) => {
    const store = createCustomerProfileStore({ userDataDir: userData });
    await store.create({ name: "Acme Corp" });
    for (const [name, code, message] of [
      ["", "E_PROFILE_NAME", /^Give the profile a name\.$/],
      ["   ", "E_PROFILE_NAME", /Give the profile a name/],
      [undefined, "E_PROFILE_NAME", /Give the profile a name/],
      [42, "E_PROFILE_NAME", /Give the profile a name/],
      ["x".repeat(MAX_PROFILE_NAME_CHARS + 1), "E_PROFILE_NAME", /^The name can have at most 80 characters\.$/],
      ["a\u0000b", "E_PROFILE_NAME", /plain text/],
      ["two\nlines", "E_PROFILE_NAME", /plain text/],
      ["acme corp", "E_PROFILE_NAME_TAKEN", /^There is already a profile named "Acme Corp"\.$/],
      [" ACME CORP ", "E_PROFILE_NAME_TAKEN", /already a profile/],
    ]) {
      await assert.rejects(() => store.create({ name }), (error) => {
        assert.equal(error.name, "CustomerProfileError", String(name));
        assert.equal(error.code, code, String(name));
        assert.match(error.message, message, String(name));
        return true;
      });
    }
    assert.equal((await store.list()).profiles.length, 1);
    assert.equal((await store.create({ name: "x".repeat(MAX_PROFILE_NAME_CHARS) })).name.length, 80);
  }));

test("rename changes the name and updatedAt, checks uniqueness against the others only", () =>
  withDirs(async ({ userData }) => {
    const store = createCustomerProfileStore({ userDataDir: userData, now: ticking() });
    const acme = await store.create({ name: "Acme Corp" });
    await store.create({ name: "Globex" });
    const renamed = await store.rename(acme.id, " Acme Corporation ");
    assert.equal(renamed.name, "Acme Corporation");
    assert.equal(renamed.createdAt, acme.createdAt);
    assert.ok(renamed.updatedAt > acme.updatedAt);
    assert.equal((await store.rename(acme.id, "ACME CORPORATION")).name, "ACME CORPORATION", "its own name is not a clash");
    await assert.rejects(() => store.rename(acme.id, "globex"), (error) => {
      assert.equal(error.code, "E_PROFILE_NAME_TAKEN");
      return true;
    });
    await assert.rejects(() => store.rename("000000000000", "Nobody"), (error) => {
      assert.equal(error.code, "E_PROFILE_NOT_FOUND");
      assert.equal(error.message, "That profile no longer exists.");
      return true;
    });
    await assert.rejects(() => store.rename(acme.id, ""), (error) => {
      assert.equal(error.code, "E_PROFILE_NAME");
      return true;
    });
    assert.equal((await store.get(acme.id)).name, "ACME CORPORATION");
  }));

test("select persists in profiles/selected.json, survives a reload, and null clears it", () =>
  withDirs(async ({ userData }) => {
    const store = createCustomerProfileStore({ userDataDir: userData });
    const acme = await store.create({ name: "Acme Corp" });
    assert.deepEqual(await store.select(acme.id), { selectedId: acme.id });
    const raw = JSON.parse(await readFile(path.join(userData, PROFILES_DIRNAME, PROFILE_SELECTION_FILENAME), "utf8"));
    assert.deepEqual(raw, { version: PROFILE_VERSION, selectedId: acme.id });
    const again = createCustomerProfileStore({ userDataDir: userData });
    assert.equal((await again.list()).selectedId, acme.id);
    assert.equal((await again.selected()).id, acme.id);
    assert.deepEqual(await again.select(null), { selectedId: null });
    assert.equal((await again.list()).selectedId, null);
    assert.equal(await again.selected(), null);
    await assert.rejects(() => again.select("000000000000"), (error) => {
      assert.equal(error.code, "E_PROFILE_NOT_FOUND");
      return true;
    });
    assert.equal((await again.list()).selectedId, null, "a failed select changes nothing");
    await assert.rejects(() => again.select(42), (error) => {
      assert.equal(error.code, "E_PROFILE_NOT_FOUND");
      return true;
    });
  }));

test("addDocument imports Markdown, text and CSV; metadata carries counts, never text", () =>
  withDirs(async ({ userData, docs }) => {
    const store = createCustomerProfileStore({ userDataDir: userData, now: ticking() });
    const acme = await store.create({ name: "Acme Corp" });
    const history = await file(docs, "history.md", "# Acme\r\n\r\nRenewed in 2025 at 52k.\r\n");
    const deals = await file(docs, "deals.csv", DEALS_CSV);
    const notes = await file(docs, "objections.txt", "Worried about SSO and data residency.");

    const one = await store.addDocument(acme.id, history);
    assert.equal(one.documents.length, 1);
    assert.match(one.documents[0].id, ID);
    assert.deepEqual(one.documents[0], {
      id: one.documents[0].id,
      name: "history.md",
      kind: "markdown",
      chars: "# Acme\n\nRenewed in 2025 at 52k.".length,
      words: 7,
      loadedAt: one.documents[0].loadedAt,
    });
    const two = await store.addDocument(acme.id, deals);
    assert.deepEqual(two.documents[1], {
      id: two.documents[1].id,
      name: "deals.csv",
      kind: "csv",
      chars: DEALS_MD.length,
      words: DEALS_MD.split(/\s+/).filter(Boolean).length,
      rows: 2,
      columns: 3,
      loadedAt: two.documents[1].loadedAt,
    });
    const three = await store.addDocument(acme.id, notes);
    assert.deepEqual(
      three.documents.map((d) => d.name),
      ["history.md", "deals.csv", "objections.txt"],
      "documents keep load order",
    );
    assert.equal(three.chars, three.documents.reduce((sum, d) => sum + d.chars, 0));
    assert.equal(three.words, three.documents.reduce((sum, d) => sum + d.words, 0));
    assert.ok(three.updatedAt > acme.updatedAt);
    assert.ok(!JSON.stringify(three).includes("Renewed in 2025"), "metadata never carries text");
    assert.ok(!JSON.stringify(await store.list()).includes("Renewed in 2025"));

    const full = await store.get(acme.id);
    assert.equal(full.documents[0].text, "# Acme\n\nRenewed in 2025 at 52k.");
    assert.equal(full.documents[1].text, DEALS_MD);
    assert.deepEqual(profileMetadata(full), three);
    assert.equal(profileMetadata(null), null);
    assert.equal(
      renderProfileText(full),
      [
        "File: history.md\n\n# Acme\n\nRenewed in 2025 at 52k.",
        `File: deals.csv\n\n${DEALS_MD}`,
        "File: objections.txt\n\nWorried about SSO and data residency.",
      ].join("\n\n"),
    );
    assert.equal(renderProfileText({ ...full, documents: [] }), "");
    assert.equal(renderProfileText(null), "");

    const reloaded = await createCustomerProfileStore({ userDataDir: userData }).get(acme.id);
    assert.deepEqual(reloaded, full, "documents survive a restart");
  }));

test("loading a file with the name of an existing document replaces it in place", () =>
  withDirs(async ({ userData, docs }) => {
    const store = createCustomerProfileStore({ userDataDir: userData, now: ticking() });
    const acme = await store.create({ name: "Acme Corp" });
    await store.addDocument(acme.id, await file(docs, "a.md", "first"));
    const deals = await file(docs, "deals.csv", DEALS_CSV);
    const before = await store.addDocument(acme.id, deals);
    await store.addDocument(acme.id, await file(docs, "c.md", "third"));
    await writeFile(deals, "Account Name,Stage\nAcme Corp,Won\n");
    const after = await store.addDocument(acme.id, deals);
    assert.equal(after.documents.length, 3, "a replacement does not take a slot");
    assert.deepEqual(
      after.documents.map((d) => d.name),
      ["a.md", "deals.csv", "c.md"],
    );
    assert.equal(after.documents[1].id, before.documents[1].id, "the document keeps its id");
    assert.equal(after.documents[1].rows, 1);
    assert.ok(after.documents[1].loadedAt > before.documents[1].loadedAt);
    assert.equal((await store.get(acme.id)).documents[1].text, "## Acme Corp\n- Account Name: Acme Corp\n- Stage: Won");
    // Windows file names: the match is case-insensitive.
    const upper = await file(docs, "A.MD", "FIRST AGAIN");
    const again = await store.addDocument(acme.id, upper);
    assert.equal(again.documents.length, 3);
    assert.equal(again.documents[0].name, "A.MD", "the new name is kept");
    assert.equal((await store.get(acme.id)).documents[0].text, "FIRST AGAIN");
  }));

test("a profile holds at most three documents", () =>
  withDirs(async ({ userData, docs }) => {
    assert.equal(PROFILE_MAX_DOCUMENTS, 3);
    const store = createCustomerProfileStore({ userDataDir: userData });
    const acme = await store.create({ name: "Acme Corp" });
    for (const name of ["a.md", "b.md", "c.md"]) await store.addDocument(acme.id, await file(docs, name, name));
    await file(docs, "d.md", "d");
    await assert.rejects(() => store.addDocument(acme.id, path.join(docs, "d.md")), (error) => {
      assert.equal(error.name, "CustomerProfileError");
      assert.equal(error.code, "E_PROFILE_DOCUMENTS");
      assert.equal(error.message, "This profile already has 3 files. Remove one and load it again.");
      return true;
    });
    assert.equal((await store.get(acme.id)).documents.length, 3);
  }));

test("a profile is at most 14,000 characters, and a single file over that is rejected as too large", () =>
  withDirs(async ({ userData, docs }) => {
    assert.equal(PROFILE_CHARS, 14_000);
    const store = createCustomerProfileStore({ userDataDir: userData });
    const acme = await store.create({ name: "Acme Corp" });
    await store.addDocument(acme.id, await file(docs, "a.md", "a".repeat(7_000)));
    await store.addDocument(acme.id, await file(docs, "b.md", "b".repeat(7_000)));
    assert.equal((await store.get(acme.id)).documents.length, 2);
    await file(docs, "c.md", "cc");
    await assert.rejects(() => store.addDocument(acme.id, path.join(docs, "c.md")), (error) => {
      assert.equal(error.code, "E_PROFILE_TOO_LARGE");
      assert.equal(
        error.message,
        "This file has 2 characters. The profile has 0 of 14,000 left. Remove a file or trim this one and load it again.",
      );
      return true;
    });
    const meta = await store.removeDocument(acme.id, (await store.get(acme.id)).documents[1].id);
    assert.equal(meta.chars, 7_000);
    await file(docs, "big.md", "x".repeat(7_001));
    await assert.rejects(() => store.addDocument(acme.id, path.join(docs, "big.md")), (error) => {
      assert.equal(error.code, "E_PROFILE_TOO_LARGE");
      assert.match(error.message, /^This file has 7,001 characters\. The profile has 7,000 of 14,000 left\./);
      return true;
    });
    await file(docs, "huge.md", "x".repeat(14_001));
    await assert.rejects(() => store.addDocument(acme.id, path.join(docs, "huge.md")), (error) => {
      assert.equal(error.code, "E_DOC_TOO_LARGE", "a file that can never fit fails as a document, before any profile arithmetic");
      assert.match(error.message, /This file has 14,001 characters\. The limit is 14,000\./);
      return true;
    });
    assert.equal(profileMetadata(await store.get(acme.id)).chars, 7_000, "every rejection leaves the profile as it was");
    // Replacing a document counts only the net change.
    await store.addDocument(acme.id, await file(docs, "a.md", "a".repeat(14_000)));
    assert.equal(profileMetadata(await store.get(acme.id)).chars, 14_000);
  }));

test("the grounding document and the profile share one budget: a file over it is rejected, not trimmed", () =>
  withDirs(async ({ userData, docs }) => {
    assert.equal(DOCUMENTS_CHARS, 26_000);
    let grounding = 20_000;
    const store = createCustomerProfileStore({ userDataDir: userData, groundingChars: () => grounding });
    const acme = await store.create({ name: "Acme Corp" });
    await store.addDocument(acme.id, await file(docs, "a.md", "a".repeat(5_000)));
    await file(docs, "b.md", "b".repeat(1_001));
    await assert.rejects(() => store.addDocument(acme.id, path.join(docs, "b.md")), (error) => {
      assert.equal(error.code, "E_PROFILE_BUDGET");
      assert.equal(
        error.message,
        "This file has 1,001 characters. With the grounding document (20,000 characters) this profile has 1,000 left of the 26,000 answers can use. Trim one of them and load it again.",
      );
      return true;
    });
    assert.equal((await store.get(acme.id)).documents.length, 1);
    const ok = await store.addDocument(acme.id, await file(docs, "c.md", "c".repeat(1_000)));
    assert.equal(ok.chars, 6_000, "exactly the budget fits");
    // The grounding document is read when the file is added, not when the store is made.
    grounding = 0;
    assert.equal((await store.addDocument(acme.id, await file(docs, "d.md", "d".repeat(8_000)))).chars, 14_000);
    // A store without a grounding reader assumes no grounding document.
    const alone = createCustomerProfileStore({ userDataDir: userData });
    const other = await alone.create({ name: "Globex" });
    assert.equal((await alone.addDocument(other.id, await file(docs, "e.md", "e".repeat(14_000)))).chars, 14_000);
  }));

test("import failures keep their document codes and the profile is unchanged", () =>
  withDirs(async ({ userData, docs }) => {
    const store = createCustomerProfileStore({ userDataDir: userData });
    const acme = await store.create({ name: "Acme Corp" });
    for (const [name, body, code] of [
      ["deck.pdf", "%PDF", "E_DOC_TYPE"],
      ["empty.md", "  ", "E_DOC_EMPTY"],
      ["binary.txt", Buffer.from([0x48, 0x00]), "E_DOC_NOT_TEXT"],
      ["header.csv", "a,b\n", "E_DOC_EMPTY"],
      ["broken.csv", 'a,b\n"x,1', "E_DOC_CSV_MALFORMED"],
    ]) {
      await file(docs, name, body);
      await assert.rejects(() => store.addDocument(acme.id, path.join(docs, name)), (error) => {
        assert.equal(error.code, code, name);
        return true;
      });
    }
    await assert.rejects(() => store.addDocument(acme.id, path.join(docs, "missing.md")), (error) => {
      assert.equal(error.code, "E_DOC_UNREADABLE");
      return true;
    });
    await assert.rejects(() => store.addDocument("000000000000", path.join(docs, "deck.pdf")), (error) => {
      assert.equal(error.code, "E_PROFILE_NOT_FOUND");
      return true;
    });
    assert.deepEqual((await store.get(acme.id)).documents, []);
  }));

test("removeDocument drops one document by id", () =>
  withDirs(async ({ userData, docs }) => {
    const store = createCustomerProfileStore({ userDataDir: userData, now: ticking() });
    const acme = await store.create({ name: "Acme Corp" });
    await store.addDocument(acme.id, await file(docs, "a.md", "alpha"));
    const two = await store.addDocument(acme.id, await file(docs, "b.md", "beta"));
    const meta = await store.removeDocument(acme.id, two.documents[0].id);
    assert.deepEqual(
      meta.documents.map((d) => d.name),
      ["b.md"],
    );
    assert.equal(meta.chars, 4);
    assert.ok(meta.updatedAt > two.updatedAt);
    assert.equal((await store.get(acme.id)).documents.length, 1);
    await assert.rejects(() => store.removeDocument(acme.id, two.documents[0].id), (error) => {
      assert.equal(error.code, "E_PROFILE_DOCUMENT_NOT_FOUND");
      assert.equal(error.message, "That file is no longer in the profile.");
      return true;
    });
    await assert.rejects(() => store.removeDocument("000000000000", two.documents[1].id), (error) => {
      assert.equal(error.code, "E_PROFILE_NOT_FOUND");
      return true;
    });
  }));

test("remove deletes the profile file and clears the selection when it was selected", () =>
  withDirs(async ({ userData, docs }) => {
    const store = createCustomerProfileStore({ userDataDir: userData });
    const acme = await store.create({ name: "Acme Corp" });
    const globex = await store.create({ name: "Globex" });
    await store.addDocument(acme.id, await file(docs, "a.md", "alpha"));
    await store.select(acme.id);
    assert.deepEqual(await store.remove(acme.id), { removed: true, selectedId: null });
    assert.deepEqual(
      (await readdir(path.join(userData, PROFILES_DIRNAME))).sort(),
      [`${globex.id}.json`, PROFILE_SELECTION_FILENAME].sort(),
    );
    const listed = await store.list();
    assert.deepEqual(
      listed.profiles.map((p) => p.id),
      [globex.id],
    );
    assert.equal(listed.selectedId, null);
    assert.equal(await store.selected(), null);
    await store.select(globex.id);
    assert.deepEqual(await store.remove("000000000000"), { removed: false, selectedId: globex.id }, "removing nothing is not an error");
    assert.equal((await store.list()).selectedId, globex.id);
  }));

test("a damaged profile file is reported and skipped; the others still list", () =>
  withDirs(async ({ userData }) => {
    const store = createCustomerProfileStore({ userDataDir: userData });
    const acme = await store.create({ name: "Acme Corp" });
    const dir = path.join(userData, PROFILES_DIRNAME);
    for (const body of ["{not json", JSON.stringify({ version: 1, id: "bad" }), JSON.stringify([1]), JSON.stringify({ version: 1, id: "aaaaaaaaaaaa", name: "x", documents: "nope" })]) {
      await writeFile(path.join(dir, "aaaaaaaaaaaa.json"), body);
      const listed = await store.list();
      assert.deepEqual(
        listed.profiles.map((p) => p.id),
        [acme.id],
        body,
      );
      assert.equal(listed.readError, STORED_PROFILE_UNREADABLE, body);
    }
    // A profile file whose size is not ours is not even read.
    await writeFile(path.join(dir, "bbbbbbbbbbbb.json"), "x".repeat(128 * 1024 + 1));
    assert.equal((await store.list()).readError, STORED_PROFILE_UNREADABLE);
    assert.equal(await store.get("bbbbbbbbbbbb"), null);
    // Stray files are not profiles and not errors.
    await rm(path.join(dir, "aaaaaaaaaaaa.json"));
    await rm(path.join(dir, "bbbbbbbbbbbb.json"));
    await writeFile(path.join(dir, "README.txt"), "not a profile");
    await writeFile(path.join(dir, ".acme.json.deadbeef.tmp"), "{}");
    await mkdir(path.join(dir, "folder.json"));
    const clean = await store.list();
    assert.deepEqual(
      clean.profiles.map((p) => p.id),
      [acme.id],
    );
    assert.equal(clean.readError, null);
  }));

test("a damaged or stale selection reads as no selection", () =>
  withDirs(async ({ userData }) => {
    const store = createCustomerProfileStore({ userDataDir: userData });
    const acme = await store.create({ name: "Acme Corp" });
    const selection = path.join(userData, PROFILES_DIRNAME, PROFILE_SELECTION_FILENAME);
    await writeFile(selection, "{not json");
    let listed = await store.list();
    assert.equal(listed.selectedId, null);
    assert.equal(listed.readError, STORED_SELECTION_UNREADABLE);
    assert.equal(await store.selected(), null);
    // Points at a profile that is gone: silently none.
    await writeFile(selection, JSON.stringify({ version: 1, selectedId: "000000000000" }));
    listed = await store.list();
    assert.equal(listed.selectedId, null);
    assert.equal(listed.readError, null);
    assert.equal(await store.selected(), null);
    // A good selection again.
    await store.select(acme.id);
    assert.equal((await store.list()).selectedId, acme.id);
  }));

test("the store refuses a relative user-data directory", () => {
  assert.throws(() => createCustomerProfileStore({ userDataDir: "relative/dir" }), (error) => {
    assert.equal(error.name, "CustomerProfileError");
    assert.equal(error.code, "E_PROFILE_USER_DATA");
    assert.match(error.message, /absolute/);
    return true;
  });
});
