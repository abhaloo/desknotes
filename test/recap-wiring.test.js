import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_PREFERENCES_FILENAME, createAppPreferences, validateSettingsUpdate } from "../src/desktop/app-preferences.js";
import { BROADCAST_CHANNELS, COMMAND_CHANNELS, IPC, QUERY_CHANNELS } from "../src/desktop/ipc-gateway.js";

/**
 * Session recap, phase 0 + main wiring, checked without Electron: the
 * setting, the IPC surface, and the shape of the wiring in main.mjs.
 *
 * Structural rules pinned here:
 *   - the recorder subscribes itself (lifecycle + gateway bus), wired ONCE at
 *     boot: handleServerFrame, startSession and endSession carry no recap code;
 *   - quitting saves the recap before the app exits: onBeforeQuit awaits
 *     endSession("quit") and the recorder's settled(), under a deadline,
 *     before app.quit().
 * The real module is driven end to end in recap-main-wiring.test.js.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "src", "desktop");
const read = (relative) => readFileSync(join(desktop, relative), "utf8");
const main = () => read("main.mjs");

/** The body of `function name(` (or `async function name(`) in main.mjs, up to the next top-level function. */
function body(source, name) {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `main.mjs has function ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n(?:export )?(?:async )?function |\n\/\*\*|\nconst |\nlet /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "recap-settings-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------- the setting */

test("settings:set takes sessionRecap as a boolean and refuses anything else", () => {
  assert.deepEqual(validateSettingsUpdate({ sessionRecap: false }), { sessionRecap: false });
  assert.deepEqual(validateSettingsUpdate({ sessionRecap: true, glossary: false }), { sessionRecap: true, glossary: false });
  for (const bad of [{ sessionRecap: "false" }, { sessionRecap: 0 }, { sessionRecap: null }, { sessionRecap: {} }]) {
    assert.throws(() => validateSettingsUpdate(bad), (error) => error.code === "E_INVALID_PAYLOAD", JSON.stringify(bad));
  }
});

test("sessionRecap is on by default, persists, and an older or damaged file reads as on", () =>
  withDir(async (dir) => {
    const file = path.join(dir, APP_PREFERENCES_FILENAME);
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).sessionRecap, true, "first run");
    const prefs = createAppPreferences({ userDataDir: dir });
    await prefs.load();
    assert.equal((await prefs.save({ sessionRecap: false })).sessionRecap, false);
    assert.equal(JSON.parse(await readFile(file, "utf8")).sessionRecap, false);
    assert.equal((await prefs.save({ glossary: false })).sessionRecap, false, "saving another setting keeps it");
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).sessionRecap, false);
    for (const [saved, expected] of [[undefined, true], ["no", true], [0, true], [true, true], [false, false]]) {
      await writeFile(file, JSON.stringify({ version: 1, autoStart: true, ...(saved === undefined ? {} : { sessionRecap: saved }) }));
      assert.equal((await createAppPreferences({ userDataDir: dir }).load()).sessionRecap, expected, `saved ${JSON.stringify(saved)}`);
    }
    await writeFile(file, "{");
    assert.equal((await createAppPreferences({ userDataDir: dir }).load()).sessionRecap, true, "a damaged file keeps the default");
  }));

test("main reads the setting through currentSessionRecap() and reports it in settings:get", () => {
  const source = main();
  assert.match(body(source, "currentSessionRecap"), /typeof state\.settings\?\.sessionRecap === "boolean"/);
  assert.match(body(source, "querySettings"), /sessionRecap: currentSessionRecap\(\),/);
});

/* -------------------------------------------------------------- IPC surface */

test("recap channels: two queries, two commands, one broadcast", () => {
  assert.equal(IPC.RECAP_LIST, "recap:list");
  assert.equal(IPC.RECAP_GET, "recap:get");
  assert.equal(IPC.RECAP_OPEN, "recap:open");
  assert.equal(IPC.RECAP_DELETE, "recap:delete");
  assert.equal(IPC.RECAP_READY, "recap:ready");
  assert.ok(QUERY_CHANNELS.includes(IPC.RECAP_LIST));
  assert.ok(QUERY_CHANNELS.includes(IPC.RECAP_GET));
  assert.ok(COMMAND_CHANNELS.includes(IPC.RECAP_OPEN));
  assert.ok(COMMAND_CHANNELS.includes(IPC.RECAP_DELETE));
  assert.ok(BROADCAST_CHANNELS.includes(IPC.RECAP_READY));
  // preload.cjs inlines these tables; test/sec-preload-sandbox.test.js fails on drift.
  const preload = read("preload.cjs");
  for (const name of ["RECAP_LIST", "RECAP_GET", "RECAP_OPEN", "RECAP_DELETE", "RECAP_READY"]) {
    assert.match(preload, new RegExp(`${name}: "${IPC[name] ?? "missing"}"`), name);
  }
});

test("main routes every recap channel", () => {
  const source = body(main(), "registerIpcRoutes");
  for (const name of ["RECAP_LIST", "RECAP_GET", "RECAP_OPEN", "RECAP_DELETE"]) {
    assert.match(source, new RegExp(`\\[IPC\\.${name}\\]:`), name);
  }
});

test("the recap page may call recap:get and nothing else", () => {
  const source = body(main(), "registerIpcRoutes");
  assert.match(source, /const recapChannels = new Set\(\[IPC\.RECAP_GET\]\);/);
  assert.match(source, /recapChannels\.has\(channel\)[\s\S]*?trustedPages: RECAP_SENDER_PAGES/);
  assert.match(main(), /const RECAP_SENDER_PAGES = Object\.freeze\(\["index\.html", "recap\.html"\]\);/);
});

/* ------------------------------------------------------------ the recorder */

test("main imports the recorder and the store", () => {
  const source = main();
  assert.match(source, /import \{[^}]*\bcreateRecapRecorder\b[^}]*\} from "\.\/recap\/recorder\.js";/);
  assert.match(source, /import \{[^}]*\bcreateRecapStore\b[^}]*\} from "\.\/recap\/store\.js";/);
});

test("the recorder is wired once at boot, on the lifecycle and the gateway bus", () => {
  const boot = body(main(), "bootstrap");
  const wiring = /state\.recap = createRecapRecorder\(\{[\s\S]*?\n {2}\}\);/.exec(boot)?.[0] ?? "";
  assert.ok(wiring, "bootstrap creates state.recap");
  assert.ok(boot.indexOf("state.recap = createRecapRecorder(") > boot.indexOf("state.lifecycle = new SessionLifecycle("), "after the lifecycle exists");
  assert.ok(boot.indexOf("state.recap = createRecapRecorder(") > boot.indexOf("state.gateway = new IpcGateway("), "after the bus exists");
  assert.match(wiring, /lifecycle: state\.lifecycle,/);
  assert.match(wiring, /bus: state\.gateway,/);
  assert.match(wiring, /isEnabled: \(\) => currentSessionRecap\(\),/);
  assert.match(wiring, /isPractice: \(\) => Boolean\(state\.practice\.session\?\.isActive\(\)\),/);
  assert.match(wiring, /sessionId: \(\) => state\.sessionId,/);
  assert.match(wiring, /save: /);
  assert.match(wiring, /onSaved: /);
  assert.match(main(), /broadcast\(IPC\.RECAP_READY, /, "a finished recap is announced to every window");
});

test("the frame path and the session commands carry no recap code", () => {
  const source = main();
  for (const name of ["handleServerFrame", "startSession", "endSession", "handleRealtimeStatus"]) {
    assert.doesNotMatch(body(source, name), /recap/i, `${name} must not know about recaps`);
  }
});

test("quitting saves the recap before the app exits, under a deadline", () => {
  const source = main();
  const quit = body(source, "onBeforeQuit");
  const ended = quit.indexOf('endSession("quit")');
  const settled = quit.search(/state\.recap\??\.settled\(\)/);
  const exit = quit.indexOf("app.quit()");
  assert.ok(ended >= 0, "onBeforeQuit ends the session itself, so the lifecycle reaches ended before exit");
  assert.match(quit, /await [^\n]*endSession\("quit"\)|endSession\("quit"\)[\s\S]*?await/, "and waits for it");
  assert.ok(settled > ended, "then waits for the recap save");
  assert.ok(exit > settled, "and only then quits");
  assert.match(quit, /RECAP_QUIT_TIMEOUT_MS/, "a stuck disk never blocks quitting forever");
  assert.match(source, /const RECAP_QUIT_TIMEOUT_MS = \d+;/);
});

/* ------------------------------------------------------------ recap window */

test("the recap window is its own pinned page, like practice", () => {
  const source = main();
  assert.match(source, /const RECAP_PAGE = join\(RENDERER_DIR, "recap\.html"\);/);
  const create = body(source, "createRecapWindow");
  assert.match(create, /title: "DeskNotes — Session recap"/);
  assert.match(create, /hardenWebContents\(win\.webContents, \{ pages: \[RECAP_PAGE\]/);
  assert.match(create, /loadFile\(RECAP_PAGE, \{ query: \{ id/);
  assert.doesNotMatch(create, /alwaysOnTop: true/);
  assert.match(body(source, "hardenSessions"), /RECAP_PAGE/, "app windows may show recap.html");
});

test("recap.html ships the same CSP as index.html and loads recap.js", () => {
  const file = join(desktop, "renderer", "recap.html");
  assert.ok(existsSync(file), "recap.html exists");
  const html = readFileSync(file, "utf8");
  const csp = (source) => /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(source)?.[1] ?? null;
  assert.equal(csp(html), csp(read("renderer/index.html")));
  assert.match(html, /<script type="module" src="\.?\/?recap\.js"><\/script>/);
  for (const id of ["recap-title", "recap-meta", "recap-status", "recap-timeline", "recap-questions", "recap-gaps", "recap-terms"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
});

test("recap renderer files never use innerHTML or a hand cursor", () => {
  for (const file of ["renderer/recap.js", "renderer/recap.html", "renderer/recap-view.js", "renderer/recap-history.js"]) {
    assert.ok(existsSync(join(desktop, file)), `${file} exists`);
    const source = read(file);
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/, `${file}: text nodes only`);
    assert.doesNotMatch(source, /cursor:\s*pointer/, file);
  }
});

/* ------------------------------------------------------- control window UI */

test("index.html: a hidden Session recap button in the answer actions", () => {
  const html = read("renderer/index.html");
  const actions = /<div class="card-actions panel-hidden">[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
  assert.match(actions, /<button id="btn-recap" type="button" class="btn" hidden>Session recap<\/button>/);
  assert.match(actions, /<button id="recap-problem" type="button" class="btn btn-icon recap-problem" hidden aria-label="Session recap problem">/, "the problem icon sits beside it");
});

test("app.js subscribes to recap:ready like every other broadcast, and keeps the history in its own module", () => {
  const app = read("renderer/app.js");
  assert.match(app, /bridge\?\.on\(CH\.RECAP_READY, onRecapReady\);/);
  assert.doesNotMatch(app, /RECAP_READY \?\? IPC/, "no fallback the other listeners do not use");
  assert.match(app, /import \{ createRecapHistory \} from "\.\/recap-history\.js";/);
  assert.doesNotMatch(app, /historyRowView/, "rows are built in recap-history.js");
});

test("index.html: Settings has a Session history section with the switch, the list and Delete all", () => {
  const html = read("renderer/index.html");
  const section = /<section class="settings-section" aria-label="Session history">[\s\S]*?<\/section>\s*(?:<section|<\/div>)/.exec(html)?.[0] ?? "";
  assert.ok(section, "the section exists");
  assert.match(section, /<input id="session-recap" type="checkbox" \/>\s*<span>Save a recap of each session<\/span>/);
  assert.match(section, /<ul id="recap-history" class="recap-history"><\/ul>/);
  assert.match(section, /<p id="recap-history-empty" class="meta">No saved sessions yet\.<\/p>/);
  assert.match(section, /<button id="recap-delete-all" type="button" class="btn">Delete all…<\/button>/);
  assert.doesNotMatch(section, /\stitle=/, "no tooltips");
});

/* --------------------------------------------------------------------- docs */

test("README says recaps are saved, where, and how to turn them off", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const data = /## Your data[\s\S]*?\n## /.exec(readme)?.[0] ?? "";
  assert.doesNotMatch(data, /so DeskNotes saves no transcripts to disk/, "no longer true");
  assert.match(data, /session recap/i);
  assert.match(data, /sessions/);
  assert.match(data, /Save a recap of each session/);
});

test("module-contracts documents the recap channels", () => {
  const contracts = readFileSync(join(root, "docs", "module-contracts.md"), "utf8");
  for (const channel of ["recap:list", "recap:get", "recap:open", "recap:delete", "recap:ready"]) {
    assert.match(contracts, new RegExp(`\`${channel}\``), channel);
  }
});
