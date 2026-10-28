import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NO_DOCUMENT, groundingErrorText, groundingNoticeText, groundingStatusText } from "../src/desktop/renderer/grounding-view.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the status line shows the name and word count, or the no-document text", () => {
  assert.equal(groundingStatusText({ document: { name: "resume.md", words: 808, chars: 5720 } }), "resume.md · 808 words");
  assert.equal(groundingStatusText({ document: { name: "one.md", words: 1, chars: 3 } }), "one.md · 1 word");
  assert.equal(groundingStatusText({ document: { name: "big.md", words: 12345, chars: 1 } }), "big.md · 12,345 words");
  assert.equal(groundingStatusText({}), NO_DOCUMENT);
  assert.equal(NO_DOCUMENT, "No document. Answers use general knowledge.");
  const readError = "The saved document couldn't be read. Load it again.";
  assert.equal(groundingStatusText({ document: null, readError }), readError);
});

test("a document trimmed on load gets a notice under the status line until the rep loads another or clears", () => {
  assert.equal(
    groundingNoticeText({ name: "old.md", words: 2, chars: 12_000, trimmedFrom: 30_009 }),
    "old.md had 30,009 characters, over the 12,000 limit, so it was cut to the first 12,000. Load a shorter file to choose what stays.",
  );
  assert.equal(groundingNoticeText({ name: "resume.md", words: 808, chars: 5_720 }), "");
  assert.equal(groundingNoticeText(null), "");
  const html = readFileSync(join(root, "src", "desktop", "renderer", "index.html"), "utf8");
  assert.match(html, /<p id="grounding-notice" class="meta" hidden><\/p>/);
  const app = readFileSync(join(root, "src", "desktop", "renderer", "app.js"), "utf8");
  assert.match(app, /groundingNotice: el\("grounding-notice"\)/);
  const render = /function renderGrounding\([^)]*\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(render, /groundingNoticeText\(grounding\.document\)/);
  assert.match(render, /els\.groundingNotice\.hidden = !notice/);
});

test("errors show the main process's message, with a fallback", () => {
  assert.equal(groundingErrorText({ code: "E_DOC_EMPTY", message: "This file is empty." }), "This file is empty.");
  assert.equal(groundingErrorText(null), "Couldn't load the document.");
});

test("the control window has the grounding panel with the screen-share note", () => {
  const html = readFileSync(join(root, "src", "desktop", "renderer", "index.html"), "utf8");
  assert.match(html, /<section id="grounding-panel" class="[^"]*\bcontrol-only\b[^"]*"/);
  for (const id of ["grounding-status", "grounding-load", "grounding-clear", "settings-note"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /The file picker shows on a shared screen\. Load your document before you share\./);
  // The autostart toggle is folded into the capture checkbox: one control, not
  // two - and the promise that control makes is pinned here.
  assert.ok(!html.includes('id="toggle-autostart"'), "#toggle-autostart must be removed");
  assert.match(
    html,
    /<input id="toggle-capture" type="checkbox" \/>[\s\S]*?Listening starts when the app opens until you turn it off here\./,
    "the capture checkbox owns the app-open promise",
  );
  // The grounding panel lives in the settings dialog (Grounding section).
  const dialog = /<dialog id="settings-dialog"[\s\S]*<\/dialog>/.exec(html)?.[0] ?? "";
  assert.ok(dialog.includes('id="grounding-panel"'), "the grounding panel belongs to the settings dialog");
  assert.ok(dialog.includes(">Grounding</h2>"), "the dialog groups grounding under a heading");
});
