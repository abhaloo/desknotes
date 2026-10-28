import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Customer profiles through the real main module under a fake Electron
 * (test/fixtures/main-shell-driver.mjs, DRIVER_MODE=profiles): the store is
 * loaded at boot and the selected profile goes out with the first session;
 * every profiles:* command answers with metadata only and pushes the whole
 * context (grounding document plus profile) to the live session whenever the
 * selection or its files change, the way grounding:load does.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const driver = join(here, "fixtures", "main-shell-driver.mjs");

function electronBinary() {
  try {
    const path = createRequire(import.meta.url)("electron");
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}
const electron = electronBinary();
const skip = !electron && "electron binary not installed";

function runDriver(mode) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DRIVER_MODE: mode };
  // Provider keys too: a developer shell that has them must not reach the driver.
  for (const key of ["REALTIME_URL", "JWT", "SESSION_ID", "CAPTURE_BACKEND", "VAD_ENABLED", "EMBEDDED_SERVER", "REALTIME_PORT", "COPILOT_MODE", "COPILOT_AUTOSTART",
    "DEEPSEEK_API_KEY", "CEREBRAS_API_KEY", "GROQ_API_KEY", "TYPESAFE_API_KEY", "LLM_API_KEY", "VISION_API_KEY", "ANSWER_MODEL", "REP_CONTEXT", "HIGHLIGHTS", "ANSWER_CARDS"]) {
    delete env[key];
  }
  const result = spawnSync(electron, [driver], { cwd: root, env, encoding: "utf8", timeout: 60_000, windowsHide: true });
  const line = String(result.stdout ?? "").split(/\r?\n/).find((entry) => entry.startsWith("RESULT "));
  assert.ok(line, `driver produced no result (status ${result.status}): ${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(line.slice("RESULT ".length));
  assert.equal(report.error, undefined, report.error);
  return report.steps;
}

const RESUME = "# Pat Doe\n\nLed the Acme migration in 2021.";
const DEALS_TEXT = "## Acme Corp\n- Account Name: Acme Corp\n- Stage: Closed Won\n- Amount: 48000";
const NOTES_TEXT = "Prefers annual billing.";
const ACME_CUSTOMER = { name: "Acme Corp", docs: `File: deals.csv\n\n${DEALS_TEXT}` };
const ID = /^[0-9a-f]{12}$/;

test("the profile selected in an earlier run goes out with the first session, and the list is metadata only", { skip, timeout: 90_000 }, () => {
  const steps = runDriver("profiles");

  assert.equal(steps.bootContext.started, true);
  assert.equal(steps.bootContext.starts, 1);
  assert.deepEqual(steps.bootContext.context, { docs: "", name: "", customer: ACME_CUSTOMER }, "no grounding document, the profile alone");

  assert.equal(steps.listed.ok, true);
  assert.equal(steps.listed.readError, null);
  assert.equal(steps.listed.selectedId, steps.listed.acmeId);
  assert.equal(steps.listed.profiles.length, 1);
  const [acme] = steps.listed.profiles;
  assert.equal(acme.name, "Acme Corp");
  assert.equal(acme.chars, DEALS_TEXT.length);
  assert.equal(acme.documents.length, 1);
  assert.equal(acme.documents[0].name, "deals.csv");
  assert.equal(acme.documents[0].kind, "csv");
  assert.equal(acme.documents[0].rows, 1);
  assert.equal(acme.documents[0].columns, 3);
  assert.equal("text" in acme.documents[0], false);
  assert.equal(steps.listed.textLeaked, false, "the IPC reply carries metadata only");

  // create: trimmed, selected at once, pushed (an empty profile clears the customer on the wire).
  assert.equal(steps.created.ok, true);
  assert.match(steps.created.profile.id, ID);
  assert.equal(steps.created.profile.name, "Globex");
  assert.deepEqual(steps.created.profile.documents, []);
  assert.equal(steps.created.selectedId, steps.created.profile.id);
  assert.equal(steps.created.applied, true);
  assert.equal(steps.created.pushed, true);
  assert.deepEqual(steps.created.context, { docs: "", name: "" }, "nothing to ground on yet");
  assert.deepEqual(steps.created.listed, ["Acme Corp", "Globex"]);
  assert.equal(steps.createRefused.blankCode, "E_PROFILE_NAME");
  assert.equal(steps.createRefused.takenCode, "E_PROFILE_NAME_TAKEN");
  assert.equal(steps.createRefused.takenMessage, 'There is already a profile named "Acme Corp".');
  assert.equal(steps.createRefused.noPayloadCode, "E_PROFILE_NAME");
  assert.deepEqual(steps.createRefused.listed, ["Acme Corp", "Globex"], "a refused create adds nothing");

  // addDocument: main's picker; cancel changes nothing; a file applies live.
  assert.deepEqual(steps.cancelled, { ok: true, cancelled: true, files: 0, contexts: 0 });
  assert.equal(steps.added.ok, true);
  assert.equal(steps.added.applied, true);
  assert.equal(steps.added.pushed, true);
  assert.equal(steps.added.textLeaked, false);
  assert.deepEqual(
    steps.added.profile.documents.map((d) => [d.name, d.kind, d.chars]),
    [["notes.md", "markdown", NOTES_TEXT.length]],
  );
  assert.deepEqual(steps.added.context, { docs: "", name: "", customer: { name: "Globex", docs: `File: notes.md\n\n${NOTES_TEXT}` } });
  assert.equal(steps.added.dialogHasParent, true);
  assert.equal(steps.added.title, "Add a file to the profile");
  assert.deepEqual(steps.added.filters, [{ name: "Documents", extensions: ["md", "markdown", "txt", "csv"] }]);
  assert.deepEqual(steps.added.properties, ["openFile"]);

  assert.equal(steps.addedCsv.ok, true);
  assert.equal(steps.addedCsv.pushed, true);
  assert.deepEqual(
    steps.addedCsv.documents.map((d) => [d.name, d.kind, d.rows ?? null]),
    [["notes.md", "markdown", null], ["deals.csv", "csv", 1]],
  );
  assert.equal(steps.addedCsv.chars, NOTES_TEXT.length + DEALS_TEXT.length);
  assert.deepEqual(steps.addedCsv.context, {
    docs: "",
    name: "",
    customer: { name: "Globex", docs: `File: notes.md\n\n${NOTES_TEXT}\n\nFile: deals.csv\n\n${DEALS_TEXT}` },
  });

  assert.equal(steps.tooBig.ok, false);
  assert.equal(steps.tooBig.code, "E_DOC_TOO_LARGE");
  assert.match(steps.tooBig.message, /14,001 characters\. The limit is 14,000\./);
  assert.equal(steps.tooBig.files, 2, "a refused file leaves the profile as it was");
  assert.equal(steps.tooBig.contexts, 0, "and pushes nothing");
  assert.equal(steps.unknownProfile.code, "E_PROFILE_NOT_FOUND");

  // removeDocument: the wire follows.
  assert.equal(steps.removedDocument.ok, true);
  assert.deepEqual(steps.removedDocument.documents, ["notes.md"]);
  assert.equal(steps.removedDocument.applied, true);
  assert.equal(steps.removedDocument.pushed, true);
  assert.deepEqual(steps.removedDocument.context, { docs: "", name: "", customer: { name: "Globex", docs: `File: notes.md\n\n${NOTES_TEXT}` } });
  assert.equal(steps.removedDocument.againCode, "E_PROFILE_DOCUMENT_NOT_FOUND");

  // select: persisted, pushed; an unknown id is refused and changes nothing.
  assert.equal(steps.selected.ok, true);
  assert.equal(steps.selected.selectedId, steps.listed.acmeId);
  assert.equal(steps.selected.applied, true);
  assert.equal(steps.selected.pushed, true);
  assert.deepEqual(steps.selected.context, { docs: "", name: "", customer: ACME_CUSTOMER });
  assert.deepEqual(steps.selected.stored, { version: 1, selectedId: steps.listed.acmeId });
  assert.equal(steps.selected.unknownCode, "E_PROFILE_NOT_FOUND");
  assert.equal(steps.selected.selectedAfterUnknown, steps.listed.acmeId);

  // The grounding document and the profile travel together, and come back after a restart.
  assert.equal(steps.withGrounding.ok, true);
  assert.equal(steps.withGrounding.applied, true);
  assert.equal(steps.withGrounding.pushed, true);
  assert.deepEqual(steps.withGrounding.context, { docs: RESUME, name: "resume.md", customer: ACME_CUSTOMER });
  assert.equal(steps.resentOnStart.ok, true);
  assert.equal(steps.resentOnStart.pushed, true);
  assert.deepEqual(steps.resentOnStart.context, { docs: RESUME, name: "resume.md", customer: ACME_CUSTOMER });

  // None: the document stays, the profile goes.
  assert.equal(steps.selectedNone.ok, true);
  assert.equal(steps.selectedNone.selectedId, null);
  assert.equal(steps.selectedNone.applied, true);
  assert.equal(steps.selectedNone.pushed, true);
  assert.deepEqual(steps.selectedNone.context, { docs: RESUME, name: "resume.md" });
  assert.equal(steps.selectedNone.listedSelectedId, null);

  // delete: an unselected profile leaves the wire alone; the selected one clears the customer.
  assert.equal(steps.deleted.ok, true);
  assert.equal(steps.deleted.removed, true);
  assert.equal(steps.deleted.selectedId, null);
  assert.equal(steps.deleted.applied, false, "nothing on the wire depended on it");
  assert.equal(steps.deleted.contexts, 0);
  assert.equal(steps.deleted.fileGone, true);
  assert.deepEqual(steps.deleted.listed, ["Acme Corp"]);
  assert.equal(steps.deleted.againRemoved, false, "deleting it again is not an error");
  assert.equal(steps.deletedSelected.ok, true);
  assert.equal(steps.deletedSelected.removed, true);
  assert.equal(steps.deletedSelected.selectedId, null);
  assert.equal(steps.deletedSelected.applied, true);
  assert.equal(steps.deletedSelected.pushed, true);
  assert.deepEqual(steps.deletedSelected.context, { docs: RESUME, name: "resume.md" });
  assert.deepEqual(steps.deletedSelected.listed, []);
  assert.equal(steps.deletedSelected.listedSelectedId, null);
});
