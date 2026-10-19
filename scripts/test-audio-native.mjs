/**
 * Run the native core executable, then load the addon inside Electron's
 * utility process.
 *
 * WHY Electron and not host Node: audio_capture.node is built for Electron
 * 33.4.11. Host Node can run this script, but it must not load the addon.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testExe = join(root, "native", "build", "Release", "audio_core_test.exe");
const addonPath = join(root, "native", "build", "Release", "audio_capture.node");
const driverPath = join(root, "test", "fixtures", "native-audio-driver.cjs");
const manifestPath = join(root, "src", "desktop", "native-audio-manifest.json");

/** Record the run into the manifest so the diagnostics export can report it. */
function recordTestOutcome(ok, detail) {
  try {
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return;
    manifest.testOutcome = {
      ok,
      at: new Date().toISOString(),
      ...(ok ? {} : { detail: typeof detail === "string" ? detail : "native test failed" }),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    /* evidence is best-effort; the exit code still reports the outcome */
  }
}

function fail(diagnostic) {
  recordTestOutcome(false, diagnostic?.error);
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  process.exit(1);
}

if (!existsSync(testExe) || !existsSync(addonPath)) {
  fail({
    error: "missing_native_artifact",
    testExe,
    testExePresent: existsSync(testExe),
    addonPath,
    addonPresent: existsSync(addonPath),
    hint: "node scripts/build-audio-native.mjs",
  });
}

const native = spawnSync(testExe, [], { encoding: "utf8", cwd: root, windowsHide: true });
if (native.status !== 0) {
  fail({
    error: "native_core_test_failed",
    status: native.status,
    stdout: native.stdout || "",
    stderr: native.stderr || "",
  });
}

let electronPath;
try {
  electronPath = createRequire(import.meta.url)("electron");
} catch (error) {
  fail({
    error: "electron_runtime_missing",
    detail: error instanceof Error ? error.message : String(error),
  });
}

const electron = spawnSync(electronPath, [driverPath], {
  encoding: "utf8",
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    NATIVE_AUDIO_ADDON: addonPath,
  },
});

const report = `${electron.stdout || ""}${electron.stderr || ""}`.trim();
if (electron.status !== 0) {
  fail({
    error: "electron_utility_load_failed",
    status: electron.status,
    output: report,
  });
}

process.stdout.write(`${native.stdout || ""}`);
process.stdout.write(`${report}\n`);
recordTestOutcome(true);
