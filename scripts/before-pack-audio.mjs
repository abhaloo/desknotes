/**
 * electron-builder beforePack gate for the WASAPI addon.
 *
 * A direct `electron-builder --win dir` must refuse a missing, stale, or
 * mismatched native binary. The manifest's artifact hash and the native
 * source digest are both required. A loose hash file is not a substitute.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED = Object.freeze({
  arch: "x64",
  apiVersion: 1,
  napiVersion: 8,
  electronTarget: "44.9.0",
});

function fail(message) {
  const error = new Error(message);
  error.code = "NATIVE_AUDIO_PACKAGE";
  throw error;
}

export function sourceDigestOf(root) {
  const nativeDir = join(root, "native");
  if (!existsSync(nativeDir)) fail("native audio source directory is missing");
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) {
        if (name === "build") continue;
        walk(full);
      } else {
        files.push(full);
      }
    }
  }
  walk(nativeDir);
  files.sort();
  const hash = createHash("sha256");
  for (const full of files) {
    hash.update(relative(root, full).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(full));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * @param {{ root?: string, addonPath?: string, manifestPath?: string }} [options]
 */
export function validateNativeAudioPackage({
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  addonPath,
  manifestPath,
} = {}) {
  const addon = addonPath ?? join(root, "native", "build", "Release", "audio_capture.node");
  const manifestFile = manifestPath ?? join(root, "src", "desktop", "native-audio-manifest.json");
  if (!existsSync(addon)) fail("native audio addon is missing");
  if (!existsSync(manifestFile)) fail("native audio manifest is missing");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    fail("native audio manifest is not valid JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("native audio manifest must be an object");
  }
  const sha256 = typeof manifest.sha256 === "string" ? manifest.sha256.toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail("native audio manifest sha256 is missing");
  if (typeof manifest.sourceDigest !== "string" || manifest.sourceDigest.trim() === "") {
    fail("native audio manifest sourceDigest is missing");
  }
  if (manifest.apiVersion !== EXPECTED.apiVersion) fail("native audio manifest apiVersion must be 1");
  if (manifest.napiVersion !== EXPECTED.napiVersion) fail("native audio manifest napiVersion must be 8");
  if (manifest.arch !== EXPECTED.arch) fail('native audio manifest arch must be "x64"');
  if (manifest.electronTarget !== EXPECTED.electronTarget) {
    fail('native audio manifest electronTarget must be "44.9.0"');
  }
  const actual = createHash("sha256").update(readFileSync(addon)).digest("hex");
  if (actual !== sha256) fail("native audio addon hash does not match the manifest");
  const digest = sourceDigestOf(root);
  if (digest !== manifest.sourceDigest) fail("native audio source digest is stale");
  return Object.freeze({
    addon,
    manifestFile,
    sha256,
    sourceDigest: digest,
    arch: EXPECTED.arch,
    apiVersion: EXPECTED.apiVersion,
    napiVersion: EXPECTED.napiVersion,
    electronTarget: EXPECTED.electronTarget,
  });
}

export async function beforePack() {
  validateNativeAudioPackage();
}

export default beforePack;
