import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_CHANNELS, IPC } from "../src/desktop/ipc-gateway.js";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop");
const read = (relative) => readFileSync(join(desktop, relative), "utf8");

test("main pins userData to the data folder before the single-instance lock, in the real app only", () => {
  const main = read("main.mjs");
  assert.match(main, /import \{ prepareDataDir \} from "\.\/data-dir\.js";/);
  assert.match(main, /prepareDataDir\(\{ env: process\.env, appData: app\.getPath\("appData"\) \}\)/);
  assert.match(main, /app\.setPath\("userData", dir\)/);
  assert.match(main, /console\.log\(`\[app\] data folder: \$\{dir\}`\)/);
  const pin = main.indexOf("if (REFUSED_SWITCHES.length === 0 && !globalThis.__COPILOT_SHELL_LIBRARY__) pinDataDirectory();");
  const lock = main.indexOf("app.requestSingleInstanceLock()");
  assert.ok(pin > 0, "the pin runs at module load, guarded off for refused launches and test drivers");
  assert.ok(pin < lock, "userData is pinned before the lock (the lock is keyed on userData)");
  assert.ok(pin < main.indexOf(".whenReady()"), "...and before ready");
});

test("Open settings folder sits with the answer instructions path", () => {
  const html = read("renderer/index.html");
  const field = /<span class="field-label">Answer instructions file<\/span>[\s\S]*?<\/div>\s*<\/div>/.exec(html)?.[0] ?? "";
  assert.match(field, /id="answer-instructions-path"/);
  const button = /<button id="btn-open-data-folder"[^>]*>[^<]*<\/button>/.exec(field)?.[0] ?? "";
  assert.ok(button, "the button is inside the answer instructions field");
  assert.match(button, /type="button" class="btn">Open settings folder</);
  assert.doesNotMatch(button, /\stitle=|aria-live/);
});

test("settings:openFolder is a command wired end to end", () => {
  assert.equal(IPC.SETTINGS_OPEN_FOLDER, "settings:openFolder");
  assert.ok(COMMAND_CHANNELS.includes(IPC.SETTINGS_OPEN_FOLDER));

  const preload = read("preload.cjs");
  assert.match(preload, /SETTINGS_OPEN_FOLDER: "settings:openFolder"/);
  assert.match(preload, /const COMMAND_CHANNELS = Object\.freeze\(\[[\s\S]*?IPC\.SETTINGS_OPEN_FOLDER,[\s\S]*?\]\);/);
  assert.match(preload, /openSettingsFolder\(\) \{\s*return command\(IPC\.SETTINGS_OPEN_FOLDER, null\);/);

  const main = read("main.mjs");
  assert.match(main, /import \{[^}]*\bshell \} from "electron";/);
  assert.match(main, /\[IPC\.SETTINGS_OPEN_FOLDER\]: \(\) => commandOpenSettingsFolder\(\),/);
  assert.match(main, /await shell\.openPath\(dir\)/);
  assert.match(main, /const dir = userDataDirectory\(\);/);
  assert.match(main, /failEnvelope\(ErrorCode\.OPEN_FOLDER,/);

  const app = read("renderer/app.js");
  assert.match(app, /btnOpenDataFolder: el\("btn-open-data-folder"\)/);
  assert.match(app, /els\.btnOpenDataFolder\?\.addEventListener\("click", onOpenDataFolder\)/);
  assert.match(app, /async function onOpenDataFolder\(\) \{[\s\S]*?await bridge\.openSettingsFolder\(\);[\s\S]*?showToast\(/);
});
