import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import {
  KEYS_FILENAME,
  KEYS_TEMPLATE,
  MAX_KEYS_FILE_CHARS,
  ensureKeysFile,
  keySources,
  openInNotepad,
  parseKeysFile,
  readKeysFile,
} from "../src/desktop/keys-file.js";
import { USER_SCOPE_KEYS, adoptKeyValues } from "../src/desktop/user-env.js";
import { DATA_FILES } from "../src/desktop/data-dir.js";
import { COMMAND_CHANNELS, IPC } from "../src/desktop/ipc-gateway.js";
import { keysStatusText } from "../src/desktop/renderer/keys-status.js";

/**
 * keys.env in the data folder holds the provider keys, so a rep never has to
 * set Windows environment variables. It is read once at launch, only the four
 * provider key names count, and a key in the file wins over the environment.
 */
const here = dirname(fileURLToPath(import.meta.url));
const readDesktop = (file) => readFileSync(join(here, "..", "src", "desktop", file), "utf8");

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "keys-file-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseKeysFile reads NAME=value lines for the four provider keys only", () => {
  const text = [
    "\uFEFF# my keys",
    "DEEPSEEK_API_KEY=sk-deep0000000000001111",
    "",
    "  export CEREBRAS_API_KEY = \"csk-cere0000000000002222\"  ",
    "groq_api_key='gsk_groq0000000000003333'",
    "TYPESAFE_API_KEY=",
    "PATH=C:\\evil",
    "NODE_OPTIONS=--require evil.js",
    "just a pasted key sk-abcdef",
    "DEEPSEEK_API_KEY=sk-later000000000004444 # the newer one",
  ].join("\r\n");
  const parsed = parseKeysFile(text);
  assert.deepEqual(parsed.values, {
    DEEPSEEK_API_KEY: "sk-later000000000004444",
    CEREBRAS_API_KEY: "csk-cere0000000000002222",
    GROQ_API_KEY: "gsk_groq0000000000003333",
  }, "a later line wins, quotes and an inline comment come off, a lowercase name counts, an empty value is no key");
  assert.deepEqual(parsed.ignored.map((item) => item.line), [7, 8, 9]);
  for (const item of parsed.ignored) {
    assert.doesNotMatch(item.reason, /evil|sk-abcdef|PATH|NODE_OPTIONS/, "a reason never repeats what the line says");
  }
  assert.deepEqual(parseKeysFile(null), { values: {}, ignored: [] });
});

test("a value with a space in it is refused, never half-used", () => {
  const parsed = parseKeysFile("GROQ_API_KEY=gsk one two\n");
  assert.deepEqual(parsed.values, {});
  assert.equal(parsed.ignored.length, 1);
  assert.equal(parsed.ignored[0].line, 1);
  assert.doesNotMatch(parsed.ignored[0].reason, /gsk|one|two/);
});

test("readKeysFile: a missing file is no keys and no error; a huge file is not read", async () => withDir(async (dir) => {
  const file = join(dir, KEYS_FILENAME);
  assert.deepEqual(await readKeysFile(file), { values: {}, ignored: [], error: null });
  await writeFile(file, "CEREBRAS_API_KEY=csk-file0000000000005555\n");
  assert.deepEqual(await readKeysFile(file), { values: { CEREBRAS_API_KEY: "csk-file0000000000005555" }, ignored: [], error: null });
  await writeFile(file, `DEEPSEEK_API_KEY=sk-x\n${"#".repeat(MAX_KEYS_FILE_CHARS)}\n`);
  const huge = await readKeysFile(file);
  assert.deepEqual(huge.values, {});
  assert.match(huge.error, /too large/);
  const failing = await readKeysFile(file, { readFileImpl: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  assert.deepEqual(failing, { values: {}, ignored: [], error: "EACCES" });
}));

test("ensureKeysFile writes the template once and never touches an existing file", async () => withDir(async (dir) => {
  const file = join(dir, "nested", KEYS_FILENAME);
  assert.deepEqual(await ensureKeysFile(file), { created: true, error: null });
  assert.equal(await readFile(file, "utf8"), KEYS_TEMPLATE);
  await writeFile(file, "DEEPSEEK_API_KEY=sk-mine\n");
  assert.deepEqual(await ensureKeysFile(file), { created: false, error: null });
  assert.equal(await readFile(file, "utf8"), "DEEPSEEK_API_KEY=sk-mine\n");
  assert.equal(KEYS_FILENAME, "keys.env");
}));

test("the template names every key, sets none, and says when it applies", () => {
  for (const key of USER_SCOPE_KEYS) assert.match(KEYS_TEMPLATE, new RegExp(`^${key}=$`, "m"));
  assert.deepEqual(parseKeysFile(KEYS_TEMPLATE), { values: {}, ignored: [] });
  assert.match(KEYS_TEMPLATE, /restart/i);
  assert.match(KEYS_TEMPLATE, /environment variable/i);
});

test("adoptKeyValues: a key from the file replaces the environment's, an equal or empty one changes nothing", () => {
  const env = { CEREBRAS_API_KEY: "csk-windows000000000000abcd", GROQ_API_KEY: "gsk-same", PATH: "C:\\Windows" };
  const adopted = adoptKeyValues(env, {
    CEREBRAS_API_KEY: "csk-keysfile0000000000wxyz",
    DEEPSEEK_API_KEY: "sk-keysfile00000000000001",
    GROQ_API_KEY: "gsk-same",
    TYPESAFE_API_KEY: "",
    PATH: "C:\\evil",
  });
  assert.deepEqual(adopted.filled, ["DEEPSEEK_API_KEY"]);
  assert.deepEqual(adopted.replaced, [{ key: "CEREBRAS_API_KEY", before: "csk-win\u2026abcd", after: "csk-key\u2026wxyz" }]);
  assert.equal(env.CEREBRAS_API_KEY, "csk-keysfile0000000000wxyz");
  assert.equal(env.PATH, "C:\\Windows", "only the provider key names are ever set");
  assert.equal("TYPESAFE_API_KEY" in env, false);
  assert.deepEqual(adoptKeyValues({}, null), { filled: [], replaced: [] });
});

test("keySources says where each key came from, never what it is", () => {
  const env = { DEEPSEEK_API_KEY: "sk-a", CEREBRAS_API_KEY: "csk-b", GROQ_API_KEY: "" };
  assert.deepEqual(keySources(env, ["CEREBRAS_API_KEY"]), {
    DEEPSEEK_API_KEY: "environment",
    CEREBRAS_API_KEY: "keys.env",
    GROQ_API_KEY: null,
    TYPESAFE_API_KEY: null,
  });
  assert.deepEqual(keySources({}, ["DEEPSEEK_API_KEY"]).DEEPSEEK_API_KEY, null, "a file key that never reached the environment is missing");
});

test("keysStatusText: one skimmable line, provider names only", () => {
  assert.equal(
    keysStatusText({ DEEPSEEK_API_KEY: "keys.env", CEREBRAS_API_KEY: "environment", GROQ_API_KEY: null, TYPESAFE_API_KEY: "keys.env" }),
    "DeepSeek: keys.env \u00b7 Cerebras: environment \u00b7 Groq: missing \u00b7 TypeSafe: keys.env",
  );
  assert.equal(keysStatusText(undefined), "");
  assert.equal(keysStatusText({ DEEPSEEK_API_KEY: "sk-leak" }), "DeepSeek: missing \u00b7 Cerebras: missing \u00b7 Groq: missing \u00b7 TypeSafe: missing", "an unknown source is never shown");
});

function fakeSpawn({ fail = null } = {}) {
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
    const child = new EventEmitter();
    child.unrefCalled = false;
    child.unref = () => { child.unrefCalled = true; };
    calls.push({ cmd, args, options, child });
    queueMicrotask(() => (fail ? child.emit("error", fail) : child.emit("spawn")));
    return child;
  };
  return { calls, spawnImpl };
}

test("openInNotepad starts the system Notepad by its fixed path, without provider keys in its environment", async () => {
  const { calls, spawnImpl } = fakeSpawn();
  const exists = (p) => p === "C:\\Windows\\System32\\notepad.exe";
  const env = { SystemRoot: "D:\\Evil", PATH: "C:\\x", DEEPSEEK_API_KEY: "sk-a", LLM_API_KEY: "k", openai_api_key: "o" };
  assert.equal(await openInNotepad("C:\\data\\keys.env", { env, exists, spawnImpl }), "");
  assert.equal(calls[0].cmd, "C:\\Windows\\System32\\notepad.exe");
  assert.deepEqual(calls[0].args, ["C:\\data\\keys.env"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.deepEqual(Object.keys(calls[0].options.env).sort(), ["PATH", "SystemRoot"]);
  assert.equal(calls[0].child.unrefCalled, true);

  const failing = fakeSpawn({ fail: new Error("spawn EACCES") });
  assert.equal(await openInNotepad("C:\\data\\keys.env", { env, exists, spawnImpl: failing.spawnImpl }), "spawn EACCES");
  assert.equal(await openInNotepad("C:\\data\\keys.env", { env, exists: () => false, spawnImpl }), "Notepad was not found");
});

test("keys.env is never copied between data folders", () => {
  assert.equal(DATA_FILES.includes(KEYS_FILENAME), false);
});

test("settings:openKeys is a command wired end to end", () => {
  assert.equal(IPC.SETTINGS_OPEN_KEYS, "settings:openKeys");
  assert.ok(COMMAND_CHANNELS.includes(IPC.SETTINGS_OPEN_KEYS));

  const preload = readDesktop("preload.cjs");
  assert.match(preload, /SETTINGS_OPEN_KEYS: "settings:openKeys"/);
  assert.match(preload, /const COMMAND_CHANNELS = Object\.freeze\(\[[\s\S]*?IPC\.SETTINGS_OPEN_KEYS,[\s\S]*?\]\);/);
  assert.match(preload, /openKeysFile\(\) \{\s*return command\(IPC\.SETTINGS_OPEN_KEYS, null\);/);

  const main = readDesktop("main.mjs");
  assert.match(main, /\[IPC\.SETTINGS_OPEN_KEYS\]: \(\) => commandOpenKeysFile\(\),/);
  const handler = /async function commandOpenKeysFile\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
  assert.match(handler, /await ensureKeysFile\(file\)/, "a missing file gets the template before it opens");
  assert.match(handler, /process\.platform === "win32" && runsInRealElectron\(\) \? openInNotepad\(file\) : shell\.openPath\(file\)/);
  assert.match(handler, /failEnvelope\(ErrorCode\.OPEN_FILE,/);
  assert.match(main, /keySources: keySources\(process\.env, keysFromFile\),/, "settings:get says where each key came from");

  const app = readDesktop("renderer/app.js");
  assert.match(app, /btnOpenKeys: el\("btn-open-keys"\)/);
  assert.match(app, /els\.btnOpenKeys\?\.addEventListener\("click", onOpenKeys\)/);
  assert.match(app, /async function onOpenKeys\(\) \{[\s\S]*?await bridge\.openKeysFile\(\);[\s\S]*?showToast\(/);
  assert.match(app, /els\.keysStatus\.textContent = keysStatusText\(keySources\)/);

  const html = readDesktop("renderer/index.html");
  const section = /<section class="settings-section" aria-label="Answer quality">[\s\S]*?<\/section>\s*<section class="settings-section" aria-label="Grounding">/.exec(html)?.[0] ?? "";
  assert.match(section, /<p id="keys-status" class="meta">/);
  assert.match(section, /<button id="btn-open-keys" type="button" class="btn">Edit keys…<\/button>/);
});

test("main reads keys.env after the Windows keys and before the engines start, in a real app only", () => {
  const main = readDesktop("main.mjs");
  const adopt = /async function adoptProviderKeys\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
  assert.ok(adopt.indexOf("adoptUserEnvironment(process.env)") >= 0);
  assert.ok(adopt.indexOf("readKeysFile(keysFilePath())") > adopt.indexOf("adoptUserEnvironment(process.env)"), "the file is read last, so it wins");
  assert.match(adopt, /adoptKeyValues\(process\.env, file\.values\)/);
  assert.match(adopt, /keys\.env has \$\{after\}; using keys\.env/, "a replaced key is logged by fingerprint");
  assert.match(main, /runsInRealElectron\(\) \? adoptProviderKeys\(\) : null/);
  assert.ok(main.indexOf("adoptProviderKeys()") < main.indexOf(".then(bootstrap)"));
  assert.match(main, /join\(userDataDirectory\(\), KEYS_FILENAME\)/);
});
