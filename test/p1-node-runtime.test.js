import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The transport must work without a global WebSocket: the desktop shell
 * passes `ws` explicitly, and a runtime without one must still connect. Bun
 * and Electron's Node 24 both have one, so in-process tests can never catch a
 * client that assumes it. These tests run a real session in a child process
 * under Electron's Node with --no-experimental-websocket.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixture = join(here, "fixtures", "node-runtime-session.mjs");

function electronBinary() {
  try {
    const path = createRequire(import.meta.url)("electron");
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}

function runFixture(command, args, env = {}) {
  const result = spawnSync(command, [...args, fixture], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 25_000,
    windowsHide: true,
  });
  const line = String(result.stdout ?? "")
    .split(/\r?\n/)
    .find((l) => l.startsWith("RESULT "));
  assert.ok(line, `fixture produced no result (status ${result.status}): ${result.stderr || result.stdout}`);
  return JSON.parse(line.slice("RESULT ".length));
}

function assertSessions(report) {
  assert.equal(report.globalWebSocket, "undefined", "this runtime must lack a global WebSocket");
  assert.equal(report.sessions.length, 2);
  for (const session of report.sessions) {
    assert.equal(session.error, null, `session ${session.round} failed: ${session.error}`);
    assert.equal(session.started, true);
    assert.equal(session.state, "live");
    assert.equal(session.capabilities, true, "session.state parsed as a text frame");
    assert.ok(session.transcripts > 0, `session ${session.round} received transcripts`);
    assert.ok(session.types.includes("turn.started"), "answers flow");
    assert.equal(session.binaryDownlink, 0, "text frames arrive as strings, not Buffers");
  }
}

const electron = electronBinary();

test("realtime client works under Electron's Node runtime (no global WebSocket)", { skip: !electron && "electron binary not installed", timeout: 30_000 }, () => {
  // Electron 44 bundles Node 24, which has a global WebSocket; the flag hides it so this child runs the no-global path the ws fallback exists for.
  const report = runFixture(electron, ["--no-experimental-websocket"], { ELECTRON_RUN_AS_NODE: "1" });
  assert.match(report.runtime, /^electron-/);
  assert.match(report.node, /^2[24]\./, "Electron 44 bundles Node 24 (Node 20 on Electron 33)");
  assertSessions(report);
});

test("realtime client works under Node with the global WebSocket disabled", { timeout: 30_000 }, () => {
  const probe = spawnSync("node", ["--no-experimental-websocket", "-e", "process.stdout.write(typeof WebSocket)"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.status !== 0 || probe.stdout !== "undefined") {
    // Older Node: the global never existed, so plain `node` is the same check.
    assertSessions(runFixture("node", []));
    return;
  }
  assertSessions(runFixture("node", ["--no-experimental-websocket"]));
});
