import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_CHANNELS, IPC, QUERY_CHANNELS } from "../src/desktop/ipc-gateway.js";

/**
 * The customer-profile IPC surface and its wiring in main, pinned statically
 * (the behaviour runs in customer-profiles-main.test.js under Electron).
 *
 *   profiles:list            query    -> { profiles: ProfileMeta[], selectedId, readError }
 *   profiles:create          command  { name }            -> { profile, selectedId, applied }   (a new profile is selected)
 *   profiles:select          command  { id: string|null } -> { selectedId, applied }
 *   profiles:addDocument     command  { id }              -> { cancelled: true, profile } | { cancelled: false, profile, applied }
 *   profiles:removeDocument  command  { id, documentId }  -> { profile, applied }
 *   profiles:delete          command  { id }              -> { removed, selectedId, applied }
 *
 * `applied`, as for grounding:load, is true when a live session holds the
 * new context now. Document text never crosses IPC; the picker path comes
 * from main's own dialog.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, "src", "desktop", relative), "utf8");

const CHANNELS = {
  PROFILES_LIST: "profiles:list",
  PROFILES_CREATE: "profiles:create",
  PROFILES_SELECT: "profiles:select",
  PROFILES_ADD_DOCUMENT: "profiles:addDocument",
  PROFILES_REMOVE_DOCUMENT: "profiles:removeDocument",
  PROFILES_DELETE: "profiles:delete",
};

test("the gateway names the channels: one query, five commands", () => {
  for (const [key, channel] of Object.entries(CHANNELS)) assert.equal(IPC[key], channel, key);
  assert.ok(QUERY_CHANNELS.includes(IPC.PROFILES_LIST));
  for (const key of ["PROFILES_CREATE", "PROFILES_SELECT", "PROFILES_ADD_DOCUMENT", "PROFILES_REMOVE_DOCUMENT", "PROFILES_DELETE"]) {
    assert.ok(COMMAND_CHANNELS.includes(IPC[key]), `${key} is a command`);
    assert.ok(!QUERY_CHANNELS.includes(IPC[key]), `${key} is not a query`);
  }
  assert.ok(!COMMAND_CHANNELS.includes(IPC.PROFILES_LIST));
});

test("the preload mirrors the channels and their kinds", () => {
  const preload = read("preload.cjs");
  for (const [key, channel] of Object.entries(CHANNELS)) {
    assert.match(preload, new RegExp(`${key}: "${channel}"`), key);
  }
  assert.match(preload, /const QUERY_CHANNELS = Object\.freeze\(\[[\s\S]*?IPC\.PROFILES_LIST,[\s\S]*?\]\);/);
  const commands = /const COMMAND_CHANNELS = Object\.freeze\(\[[\s\S]*?\]\);/.exec(preload)?.[0] ?? "";
  for (const key of ["PROFILES_CREATE", "PROFILES_SELECT", "PROFILES_ADD_DOCUMENT", "PROFILES_REMOVE_DOCUMENT", "PROFILES_DELETE"]) {
    assert.ok(commands.includes(`IPC.${key},`), `${key} in the preload's command list`);
  }
  assert.ok(!commands.includes("IPC.PROFILES_LIST,"));
});

test("main loads the store at boot, caches the selected profile, and puts it in the session context", () => {
  const main = read("main.mjs");
  assert.match(main, /import \{[^}]*createCustomerProfileStore[^}]*\} from "\.\/customer-profiles\.js";/);
  assert.match(main, /import \{[^}]*renderProfileText[^}]*\} from "\.\/customer-profiles\.js";/);
  assert.match(main, /import \{[^}]*profileMetadata[^}]*\} from "\.\/customer-profiles\.js";/);
  // The store reads the disk; sessionContext() is synchronous, so the selected profile is cached in main's state.
  assert.match(main, /customer: \{ store: null, selected: null, readError: null \},/);
  const load = /async function loadDesktopSettings\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
  assert.match(load, /state\.customer\.store = createCustomerProfileStore\(\{\s*userDataDir,\s*groundingChars: \(\) => state\.grounding\.document\?\.text\.length \?\? 0,?\s*\}\)/, "the shared budget reads the grounding document main holds");
  assert.match(load, /state\.customer\.selected = await state\.customer\.store\.selected\(\)/, "the selection is loaded before any session starts");
  assert.match(load, /state\.customer\.readError/);
  const context = /function sessionContext\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
  assert.ok(context, "sessionContext exists");
  assert.match(context, /renderProfileText\(state\.customer\.selected\)/);
  assert.match(context, /customer: \{ name: [^,]+, docs: /, "the profile goes out as customer {name, docs}");
  assert.ok(!/function applyGroundingToSession/.test(main), "the push is no longer about the grounding document alone");
  const apply = /function applyContextToSession\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
  assert.ok(apply, "applyContextToSession exists");
  assert.match(apply, /client\.setSessionContext\(sessionContext\(\)\)/);
  // The post-start check must notice a profile that changed while the link opened, not only the document.
  const start = /async function startSession\([^)]*\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
  assert.match(start, /sameSessionContext\(/, "the whole context is compared, customer included");
  assert.ok(!/held\?\.docs \?\? ""\) !== \(latest\?\.docs/.test(start), "not a docs/name-only comparison");
});

test("main routes every profile channel to a handler that pushes the context when the selection changes", () => {
  const main = read("main.mjs");
  assert.match(main, /\[IPC\.PROFILES_LIST\]: \(\) => queryProfiles\(\),/);
  assert.match(main, /\[IPC\.PROFILES_CREATE\]: \(payload\) => commandCreateProfile\(payload\),/);
  assert.match(main, /\[IPC\.PROFILES_SELECT\]: \(payload\) => commandSelectProfile\(payload\),/);
  assert.match(main, /\[IPC\.PROFILES_ADD_DOCUMENT\]: \(payload\) => commandAddProfileDocument\(payload\),/);
  assert.match(main, /\[IPC\.PROFILES_REMOVE_DOCUMENT\]: \(payload\) => commandRemoveProfileDocument\(payload\),/);
  assert.match(main, /\[IPC\.PROFILES_DELETE\]: \(payload\) => commandDeleteProfile\(payload\),/);
  // Every change to the selection or its files refreshes main's cache and pushes it, in one place.
  const refresh = /async function refreshSelectedProfile\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
  assert.match(refresh, /state\.customer\.selected = await state\.customer\.store\.selected\(\)/);
  assert.match(refresh, /return applyContextToSession\(\)/);
  for (const name of ["commandCreateProfile", "commandSelectProfile", "commandAddProfileDocument", "commandRemoveProfileDocument", "commandDeleteProfile"]) {
    const body = new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(main)?.[0] ?? "";
    assert.ok(body, `${name} exists`);
    assert.match(body, /await refreshSelectedProfile\(\)/, `${name} pushes the context`);
    assert.doesNotMatch(body, /\.text\b|renderProfileText/, `${name} answers with metadata, never text`);
  }
  const add = /async function commandAddProfileDocument\([^)]*\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
  assert.match(add, /dialog\.showOpenDialog\(/, "main opens the picker itself");
  assert.match(add, /extensions: \["md", "markdown", "txt", "csv"\]/);
  assert.match(add, /properties: \["openFile"\]/, "one file at a time, like the grounding document");
  assert.match(add, /cancelled: true/);
  const grounding = /async function commandLoadGrounding\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
  assert.match(grounding, /applyContextToSession\(\)/, "the grounding load uses the same push");
  const clear = /async function commandClearGrounding\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
  assert.match(clear, /applyContextToSession\(\)/);
});
