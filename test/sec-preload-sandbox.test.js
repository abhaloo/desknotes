import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROADCAST_CHANNELS, COMMAND_CHANNELS, IPC, QUERY_CHANNELS } from "../src/desktop/ipc-gateway.js";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop");
const preloadPath = join(desktop, "preload.cjs");

/**
 * Evaluate the preload the way a sandboxed renderer does: plain script, a
 * `require` that only knows `electron`. Anything else it tries to load fails.
 */
function loadPreload() {
  const exposed = {};
  const invoked = [];
  const listeners = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (key, api) => (exposed[key] = api) },
    ipcRenderer: {
      invoke: async (channel, payload) => (invoked.push([channel, payload]), { ok: true, value: "v" }),
      on: (channel, fn) => listeners.push([channel, fn]),
      removeListener() {},
    },
  };
  const sandboxRequire = (name) => {
    if (name === "electron") return electron;
    throw new Error(`sandboxed preload cannot require "${name}"`);
  };
  const source = readFileSync(preloadPath, "utf8");
  runInNewContext(source, { require: sandboxRequire, module: { exports: {} }, exports: {} }, { filename: preloadPath });
  return { api: exposed.copilot, invoked, listeners };
}

test("the sandboxed preload is CommonJS and requires nothing but electron", () => {
  assert.ok(existsSync(preloadPath));
  assert.ok(!existsSync(join(desktop, "preload.mjs")), "the ESM preload (sandbox: false) is gone");
  const { api } = loadPreload();
  assert.equal(typeof api.request, "function");
});

test("inlined channel tables match ipc-gateway.js exactly", async () => {
  const { api, invoked } = loadPreload();
  assert.deepEqual({ ...api.channels }, { ...IPC });
  for (const channel of QUERY_CHANNELS) await api.request(channel);
  for (const channel of COMMAND_CHANNELS) await api.command(channel);
  assert.deepEqual(invoked.map(([c]) => c), [...QUERY_CHANNELS, ...COMMAND_CHANNELS]);
  // Everything else is refused before it reaches IPC.
  const others = Object.values(IPC).filter((c) => !QUERY_CHANNELS.includes(c));
  for (const channel of others) await assert.rejects(api.request(channel), /not a query channel/);
  const notCommands = Object.values(IPC).filter((c) => !COMMAND_CHANNELS.includes(c));
  for (const channel of notCommands) await assert.rejects(api.command(channel), /not a command channel/);
  for (const channel of BROADCAST_CHANNELS) assert.equal(typeof api.on(channel, () => {}), "function");
  const notBroadcasts = Object.values(IPC).filter((c) => !BROADCAST_CHANNELS.includes(c));
  for (const channel of notBroadcasts) assert.throws(() => api.on(channel, () => {}), /not a broadcast channel/);
});

test("main creates the app windows sandboxed with the CommonJS preload", () => {
  const main = readFileSync(join(desktop, "main.mjs"), "utf8");
  assert.match(main, /preload:\s*join\(__dirname,\s*"preload\.cjs"\)/);
  assert.match(main, /sandbox:\s*true/);
  assert.ok(!/sandbox:\s*false/.test(main), "no window runs unsandboxed");
});
