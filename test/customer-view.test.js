import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NO_PROFILE,
  PROFILE_APPLIED,
  PROFILE_CHARS,
  PROFILE_MAX_DOCUMENTS,
  documentLineText,
  profileErrorText,
  profileOptions,
  profileRoomText,
  profileStatusText,
} from "../src/desktop/renderer/customer-view.js";
import * as budget from "../src/shared/context-budget.js";

/**
 * Settings > Customer: pick a profile (None by default), make a new one,
 * add or remove a file, and read a status line like the grounding panel's.
 * The text helpers are pure (tested without a DOM); the markup and the
 * renderer wiring are pinned statically, like the grounding panel's.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, "src", "desktop", relative), "utf8");

const ACME = {
  id: "a1b2c3d4e5f6",
  name: "Acme Corp",
  chars: 7_000,
  words: 1_234,
  documents: [
    { id: "d1", name: "deals.csv", kind: "csv", chars: 5_000, words: 900, rows: 12, columns: 4, loadedAt: "2026-10-14T12:00:00.000Z" },
    { id: "d2", name: "notes.md", kind: "markdown", chars: 2_000, words: 334, loadedAt: "2026-10-14T12:01:00.000Z" },
  ],
  createdAt: "2026-10-14T12:00:00.000Z",
  updatedAt: "2026-10-14T12:01:00.000Z",
};

test("the status line shows the selected profile's name, file count and words, or why there is none", () => {
  assert.equal(profileStatusText({ profile: ACME }), "Acme Corp · 2 files · 1,234 words");
  assert.equal(profileStatusText({ profile: { ...ACME, documents: [ACME.documents[1]], words: 1 } }), "Acme Corp · 1 file · 1 word");
  assert.equal(profileStatusText({ profile: { ...ACME, documents: [], words: 0, chars: 0 } }), "Acme Corp · no files yet");
  assert.equal(profileStatusText({}), NO_PROFILE);
  assert.equal(profileStatusText({ profile: null }), NO_PROFILE);
  assert.equal(NO_PROFILE, "No profile. Answers use the grounding document and general knowledge.");
  const readError = "A saved customer profile couldn't be read. Create it again.";
  assert.equal(profileStatusText({ profile: null, readError }), readError);
  assert.equal(profileStatusText({ profile: ACME, readError }), "Acme Corp · 2 files · 1,234 words", "a profile on screen beats a read error about another file");
});

test("the room line says how much of the profile's budget is used", () => {
  // The renderer keeps its own copy of the two numbers (it does not import src/shared): pinned to the budget here.
  assert.equal(PROFILE_CHARS, budget.PROFILE_CHARS);
  assert.equal(PROFILE_MAX_DOCUMENTS, budget.PROFILE_MAX_DOCUMENTS);
  assert.equal(profileRoomText(ACME), "7,000 of 14,000 characters · 2 of 3 files");
  assert.equal(profileRoomText({ ...ACME, documents: [], chars: 0 }), "0 of 14,000 characters · 0 of 3 files");
  assert.equal(profileRoomText(null), "");
});

test("one line per file: name, rows for a CSV, and words", () => {
  assert.equal(documentLineText(ACME.documents[0]), "deals.csv · 12 rows · 900 words");
  assert.equal(documentLineText({ ...ACME.documents[0], rows: 1 }), "deals.csv · 1 row · 900 words");
  assert.equal(documentLineText(ACME.documents[1]), "notes.md · 334 words");
  assert.equal(documentLineText({ name: "one.txt", kind: "text", chars: 3, words: 1 }), "one.txt · 1 word");
});

test("the picker's options: None first, then the profiles as listed, with the selected one marked", () => {
  const globex = { ...ACME, id: "0000000000ff", name: "Globex" };
  assert.deepEqual(profileOptions([ACME, globex], globex.id), [
    { value: "", label: "None", selected: false },
    { value: "a1b2c3d4e5f6", label: "Acme Corp", selected: false },
    { value: "0000000000ff", label: "Globex", selected: true },
  ]);
  assert.deepEqual(profileOptions([], null), [{ value: "", label: "None", selected: true }]);
  assert.deepEqual(profileOptions([ACME], "not-a-profile"), [
    { value: "", label: "None", selected: true },
    { value: "a1b2c3d4e5f6", label: "Acme Corp", selected: false },
  ]);
});

test("errors show the main process's message, with a fallback; the applied toast is fixed text", () => {
  assert.equal(profileErrorText({ code: "E_PROFILE_TOO_LARGE", message: "This file has 2 characters." }), "This file has 2 characters.");
  assert.equal(profileErrorText(null), "Couldn't update the profile.");
  assert.equal(PROFILE_APPLIED, "Profile applies to the next answer.");
});

test("the settings dialog has a Customer section after Grounding with the picker, the status line, the file list and the actions", () => {
  const html = read("renderer/index.html");
  const dialog = /<dialog id="settings-dialog"[\s\S]*<\/dialog>/.exec(html)?.[0] ?? "";
  assert.ok(dialog.includes(">Customer</h2>"), "a Customer heading in the settings dialog");
  assert.ok(dialog.indexOf(">Grounding</h2>") < dialog.indexOf(">Customer</h2>"), "Customer follows Grounding");
  assert.ok(dialog.indexOf(">Customer</h2>") < dialog.indexOf(">Practice</h2>"), "and precedes Practice");
  assert.match(dialog, /<section id="customer-panel" class="[^"]*\bcontrol-only\b[^"]*" aria-label="Customer profile">/);
  const panel = /<section id="customer-panel"[\s\S]*?<\/section>/.exec(dialog)?.[0] ?? "";
  for (const id of ["profile-select", "profile-status", "profile-room", "profile-files", "profile-add-file", "profile-delete", "profile-name", "profile-new"]) {
    assert.ok(panel.includes(`id="${id}"`), `#${id} in the customer panel`);
  }
  assert.match(panel, /<select id="profile-select"[^>]*>\s*<option value="">None<\/option>\s*<\/select>/, "None is the only option until main lists profiles");
  assert.match(panel, /<p id="profile-status" class="meta">No profile\. Answers use the grounding document and general knowledge\.<\/p>/);
  assert.match(panel, /<ul id="profile-files"[^>]*>\s*<\/ul>/, "the file list starts empty");
  assert.match(panel, /<button id="profile-add-file" type="button" class="btn" disabled>Add file…<\/button>/, "no profile, nothing to add to");
  assert.match(panel, /<button id="profile-delete" type="button" class="btn" disabled>Delete profile<\/button>/);
  assert.match(panel, /<input id="profile-name" type="text"[^>]*maxlength="80"[^>]*>/, "the name is typed in (Electron has no window.prompt)");
  assert.match(panel, /<button id="profile-new" type="button" class="btn">New profile<\/button>/);
  assert.match(panel, /The file picker shows on a shared screen\. Add files before you share\./);
  assert.doesNotMatch(panel, /\stitle=/, "no tooltips");
});

test("app.js binds the panel, loads it with the grounding panel, and routes every action through the bridge", () => {
  const app = read("renderer/app.js");
  assert.match(app, /from\s+["']\.\/customer-view\.js["']/);
  for (const [binding, id] of [
    ["profileSelect", "profile-select"],
    ["profileStatus", "profile-status"],
    ["profileRoom", "profile-room"],
    ["profileFiles", "profile-files"],
    ["profileAddFile", "profile-add-file"],
    ["profileDelete", "profile-delete"],
    ["profileName", "profile-name"],
    ["profileNew", "profile-new"],
  ]) {
    assert.match(app, new RegExp(`${binding}: el\\("${id}"\\)`), `app.js must bind #${id} as ${binding}`);
  }
  assert.match(app, /els\.profileSelect\?\.addEventListener\("change", onProfileSelect\)/);
  assert.match(app, /els\.profileNew\?\.addEventListener\("click", onProfileNew\)/);
  assert.match(app, /els\.profileAddFile\?\.addEventListener\("click", onProfileAddFile\)/);
  assert.match(app, /els\.profileDelete\?\.addEventListener\("click", onProfileDelete\)/);
  assert.match(app, /els\.profileFiles\?\.addEventListener\("click", onProfileFileRemove\)/, "remove buttons in the list are delegated");
  // Metadata only, fetched with the rest of the settings panel.
  assert.match(app, /async function loadProfilesPanel\(\) \{[\s\S]*?bridge\.request\(CH\.PROFILES_LIST\)/);
  assert.match(app, /async function loadGroundingPanel\(\) \{[\s\S]*?loadProfilesPanel\(\)/, "the grounding panel load brings the profiles along");
  for (const [handler, channel] of [
    ["onProfileSelect", "PROFILES_SELECT"],
    ["onProfileNew", "PROFILES_CREATE"],
    ["onProfileAddFile", "PROFILES_ADD_DOCUMENT"],
    ["onProfileFileRemove", "PROFILES_REMOVE_DOCUMENT"],
    ["onProfileDelete", "PROFILES_DELETE"],
  ]) {
    const body = new RegExp(`async function ${handler}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(app)?.[0] ?? "";
    assert.ok(body, `${handler} exists`);
    assert.match(body, new RegExp(`bridge\\.command\\(CH\\.${channel},`), `${handler} sends ${channel}`);
  }
  assert.match(app, /showToast\(PROFILE_APPLIED, "info", 3000\)/, "a change that reached the live session says so, once");
  // The file list is built from metadata with textContent, never innerHTML.
  const render = /function renderProfiles\([^)]*\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.ok(render, "renderProfiles exists");
  assert.doesNotMatch(render, /innerHTML\s*=\s*[^"'`]/, "no markup from data");
  assert.match(render, /documentLineText\(/);
  assert.match(render, /profileOptions\(/);
  assert.match(render, /profileStatusText\(/);
  assert.match(render, /profileRoomText\(/);
});
