import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FUSE_SENTINEL, FUSES, afterPack, flipFuseWire, readFuseWire } from "../scripts/electron-fuses.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Fake binary: junk, the sentinel, version 1, length 9, Electron 44's default wire. */
function fakeBinary(wire = "101100011", { version = 1, copies = 1 } = {}) {
  const parts = [Buffer.from("MZ junk before")];
  for (let i = 0; i < copies; i += 1) {
    parts.push(Buffer.from(FUSE_SENTINEL, "latin1"), Buffer.from([version, wire.length]), Buffer.from(wire, "latin1"));
  }
  parts.push(Buffer.from("junk after"));
  return Buffer.concat(parts);
}

test("flips the hardening fuses and leaves the file-protocol fuse on", () => {
  const buf = fakeBinary();
  const { before, after, changed } = flipFuseWire(buf);
  assert.equal(before, "101100011");
  // RunAsNode off, cookie encryption on, NODE_OPTIONS off, --inspect off,
  // ASAR integrity on, only-load-from-asar on, V8 snapshot untouched,
  // GrantFileProtocolExtraPrivileges kept ON (file:// ES-module renderer),
  // WasmTrapHandlers (the 9th fuse, Electron 41+) left ON as shipped.
  assert.equal(after, "010011011");
  assert.equal(changed, true);
  assert.equal(readFuseWire(buf).wire, "010011011", "the buffer is modified in place");
  assert.equal(buf.subarray(0, 14).toString("latin1"), "MZ junk before", "bytes outside the wire are untouched");
});

test("is idempotent", () => {
  const buf = fakeBinary();
  flipFuseWire(buf);
  const second = flipFuseWire(buf);
  assert.equal(second.changed, false);
  assert.equal(second.after, "010011011");
});

test("fails closed on an unexpected binary layout", () => {
  assert.throws(() => flipFuseWire(Buffer.from("no sentinel here")), /sentinel/);
  assert.throws(() => flipFuseWire(fakeBinary("101100011", { copies: 2 })), /more than once/);
  assert.throws(() => flipFuseWire(fakeBinary("101100011", { version: 2 })), /version/);
  assert.throws(() => flipFuseWire(fakeBinary("1011")), /fuses/);
  assert.throws(() => flipFuseWire(fakeBinary("1r1100011")), /removed/);
  assert.throws(() => flipFuseWire(fakeBinary("10x100011")), /unexpected/);
});

test("the fuse table matches the documented FuseV1Options order", () => {
  assert.deepEqual(
    FUSES.map((f) => f.name),
    [
      "RunAsNode",
      "EnableCookieEncryption",
      "EnableNodeOptionsEnvironmentVariable",
      "EnableNodeCliInspectArguments",
      "EnableEmbeddedAsarIntegrityValidation",
      "OnlyLoadAppFromAsar",
      "LoadBrowserProcessSpecificV8Snapshot",
      "GrantFileProtocolExtraPrivileges",
      "WasmTrapHandlers",
    ],
  );
});

test("afterPack flips the packaged Windows executable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msc-fuses-"));
  try {
    const exe = join(dir, "MockSalesCopilot.exe");
    writeFileSync(exe, fakeBinary());
    await afterPack({
      appOutDir: dir,
      electronPlatformName: "win32",
      packager: { appInfo: { productFilename: "MockSalesCopilot" } },
    });
    assert.equal(readFuseWire(readFileSync(exe)).wire, "010011011");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("afterPack targets the framework binary on macOS and the executable on Linux", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msc-fuses-"));
  try {
    const fw = join(dir, "MockSalesCopilot.app", "Contents", "Frameworks", "Electron Framework.framework");
    mkdirSync(fw, { recursive: true });
    writeFileSync(join(fw, "Electron Framework"), fakeBinary());
    await afterPack({
      appOutDir: dir,
      electronPlatformName: "darwin",
      packager: { appInfo: { productFilename: "MockSalesCopilot" } },
    });
    assert.equal(readFuseWire(readFileSync(join(fw, "Electron Framework"))).wire, "010011011");

    writeFileSync(join(dir, "mock-sales-copilot"), fakeBinary());
    await afterPack({
      appOutDir: dir,
      electronPlatformName: "linux",
      packager: { executableName: "mock-sales-copilot", appInfo: { productFilename: "MockSalesCopilot" } },
    });
    assert.equal(readFuseWire(readFileSync(join(dir, "mock-sales-copilot"))).wire, "010011011");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("afterPack fails the build when the executable is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msc-fuses-"));
  try {
    await assert.rejects(
      afterPack({ appOutDir: dir, electronPlatformName: "win32", packager: { appInfo: { productFilename: "Nope" } } }),
      /not found/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the installed Electron binary has the fuse layout this hook expects (read-only)", () => {
  const exe = join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
  if (!existsSync(exe)) return; // not downloaded: node node_modules/electron/install.js

  const { version, wire } = readFuseWire(readFileSync(exe));
  assert.equal(version, 1);
  assert.ok(wire.length >= FUSES.length, `wire ${wire} shorter than the fuse table`);
});

test("electron-builder runs the fuse hook and keeps ASAR packaging on", () => {
  assert.equal(pkg.build.afterPack, "./scripts/electron-fuses.mjs");
  assert.notEqual(pkg.build.asar, false, "fuse OnlyLoadAppFromAsar requires an asar build");
});

test("dependencies are pinned to the exact locked versions", () => {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      assert.match(spec, /^\d+\.\d+\.\d+$/, `${name}@${spec} must be an exact version`);
      assert.equal(lock.packages[`node_modules/${name}`]?.version, spec, `${name} lock/package mismatch`);
      assert.equal(lock.packages[""][field]?.[name], spec, `${name} lockfile root spec mismatch`);
    }
  }
  // Install-script allowlist entries must name the versions actually pinned.
  for (const key of Object.keys(pkg.allowScripts ?? {})) {
    const at = key.lastIndexOf("@");
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    const pinned = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.optionalDependencies?.[name];
    assert.equal(pinned, version, `allowScripts ${key} does not match the pinned ${name}`);
  }
});
