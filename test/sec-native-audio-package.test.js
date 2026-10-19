import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceDigestOf, validateNativeAudioPackage } from "../scripts/before-pack-audio.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function tree() {
  const dir = mkdtempSync(join(tmpdir(), "native-audio-pack-"));
  mkdirSync(join(dir, "native", "src"), { recursive: true });
  mkdirSync(join(dir, "native", "build", "Release"), { recursive: true });
  mkdirSync(join(dir, "src", "desktop"), { recursive: true });
  writeFileSync(join(dir, "native", "src", "addon.cc"), "int capture(){return 1;}\n");
  writeFileSync(join(dir, "native", "binding.gyp"), "{}\n");
  return dir;
}

function writeAddon(dir, bytes) {
  const addon = join(dir, "native", "build", "Release", "audio_capture.node");
  writeFileSync(addon, bytes);
  return addon;
}

function writeManifest(dir, manifest) {
  const file = join(dir, "src", "desktop", "native-audio-manifest.json");
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

function validManifest(dir, bytes) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    sha256,
    sourceDigest: sourceDigestOf(dir),
    apiVersion: 1,
    napiVersion: 8,
    arch: "x64",
    electronTarget: "44.9.0",
  };
}

test("package.json gates the addon before pack and ships it outside asar", () => {
  assert.equal(pkg.scripts["build:native-audio"], "node scripts/build-audio-native.mjs");
  assert.equal(pkg.scripts["test:native-audio"], "node scripts/test-audio-native.mjs");
  assert.equal(pkg.scripts["test:audio:live"], "electron test/live/wasapi-audio-probe.mjs");
  assert.equal(pkg.devDependencies["node-gyp"], "13.1.0");
  assert.equal(pkg.build.beforePack, "./scripts/before-pack-audio.mjs");
  assert.equal(pkg.build.afterPack, "./scripts/electron-fuses.mjs");
  const entry = pkg.build.extraResources.find((item) => item.to === "audio_capture.node");
  assert.equal(entry.from, "native/build/Release/audio_capture.node");
});

test("a matching addon, manifest, and source digest is accepted", () => {
  const dir = tree();
  try {
    const bytes = Buffer.from("native-addon-bytes");
    writeAddon(dir, bytes);
    writeManifest(dir, validManifest(dir, bytes));
    const result = validateNativeAudioPackage({ root: dir });
    assert.equal(result.arch, "x64");
    assert.equal(result.apiVersion, 1);
    assert.equal(result.napiVersion, 8);
    assert.equal(result.electronTarget, "44.9.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packaging rejects a missing addon", () => {
  const dir = tree();
  try {
    writeManifest(dir, validManifest(dir, Buffer.from("absent")));
    assert.throws(() => validateNativeAudioPackage({ root: dir }), /addon is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packaging rejects a missing manifest", () => {
  const dir = tree();
  try {
    writeAddon(dir, Buffer.from("native-addon-bytes"));
    assert.throws(() => validateNativeAudioPackage({ root: dir }), /manifest is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packaging rejects a tampered addon hash", () => {
  const dir = tree();
  try {
    const bytes = Buffer.from("native-addon-bytes");
    writeAddon(dir, bytes);
    const manifest = validManifest(dir, bytes);
    writeAddon(dir, Buffer.from("tampered-addon-bytes"));
    writeManifest(dir, manifest);
    assert.throws(() => validateNativeAudioPackage({ root: dir }), /hash does not match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packaging rejects a stale native source digest", () => {
  const dir = tree();
  try {
    const bytes = Buffer.from("native-addon-bytes");
    writeAddon(dir, bytes);
    const manifest = validManifest(dir, bytes);
    writeFileSync(join(dir, "native", "src", "addon.cc"), "int capture(){return 2;}\n");
    writeManifest(dir, manifest);
    assert.throws(() => validateNativeAudioPackage({ root: dir }), /source digest is stale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packaging rejects the wrong architecture and Electron target", () => {
  const dir = tree();
  try {
    const bytes = Buffer.from("native-addon-bytes");
    writeAddon(dir, bytes);
    const manifest = validManifest(dir, bytes);
    writeManifest(dir, { ...manifest, arch: "arm64" });
    assert.throws(() => validateNativeAudioPackage({ root: dir }), /arch must be "x64"/);
    writeManifest(dir, { ...manifest, electronTarget: "32.0.0" });
    assert.throws(() => validateNativeAudioPackage({ root: dir }), /electronTarget must be "44.9.0"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a loose hash file without a manifest is rejected", () => {
  const dir = tree();
  try {
    const bytes = Buffer.from("native-addon-bytes");
    const addon = writeAddon(dir, bytes);
    writeFileSync(`${addon}.sha256`, createHash("sha256").update(bytes).digest("hex"));
    assert.throws(() => validateNativeAudioPackage({ root: dir }), /manifest is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
