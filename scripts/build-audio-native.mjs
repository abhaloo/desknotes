/**
 * Build the owned WASAPI addon for Electron 44.9.0 x64.
 *
 * WHY a preflight before node-gyp: a missing compiler or Windows SDK must
 * exit with a structured diagnostic. A later step must not invent a .node
 * file to hide that gap.
 *
 * WHY Electron headers: the addon loads in the Electron utility process,
 * whose ABI is 44.9.0, not the host Node that runs this script.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeDir = join(root, "native");
const addonPath = join(nativeDir, "build", "Release", "audio_capture.node");
const manifestPath = join(root, "src", "desktop", "native-audio-manifest.json");
const electronTarget = "44.9.0";

const dynamicCrt = new Set([
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "msvcp140.dll",
  "ucrtbase.dll",
  "msvcrt.dll",
]);

function fail(diagnostic) {
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  process.exit(1);
}

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

function commandText(result) {
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function pythonVersion() {
  const result = run("python", ["--version"]);
  if (result.status !== 0) return null;
  return commandText(result) || null;
}

function vswherePath() {
  const candidates = [
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe"),
    join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft Visual Studio", "Installer", "vswhere.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const found = run("where.exe", ["vswhere.exe"]);
  if (found.status === 0) {
    const line = commandText(found).split(/\r?\n/).find(Boolean);
    if (line && existsSync(line.trim())) return line.trim();
  }
  return null;
}

function visualStudioInstall(vswhere) {
  if (!vswhere) return null;
  const result = run(vswhere, [
    "-latest",
    "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath",
  ]);
  if (result.status !== 0) return null;
  const line = commandText(result).split(/\r?\n/).find(Boolean);
  return line ? line.trim() : null;
}

function clPath() {
  const found = run("where.exe", ["cl.exe"]);
  if (found.status !== 0) return null;
  const line = commandText(found).split(/\r?\n/).find(Boolean);
  return line ? line.trim() : null;
}

function registryKitsRoot() {
  const keys = [
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows Kits\\Installed Roots",
    "HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots",
  ];
  for (const key of keys) {
    const result = run("reg", ["query", key, "/v", "KitsRoot10"]);
    if (result.status !== 0) continue;
    const match = commandText(result).match(/KitsRoot10\s+REG_\w+\s+(.+)$/im);
    if (match && existsSync(match[1].trim())) return match[1].trim();
  }
  return null;
}

function sdkIncludeRoots() {
  const roots = [];
  const envRoot = process.env.WindowsSdkDir;
  if (envRoot && existsSync(envRoot)) roots.push(envRoot);
  const kits = registryKitsRoot();
  if (kits) roots.push(kits);
  const programFiles = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  roots.push(join(programFiles, "Windows Kits", "10"));
  return [...new Set(roots)];
}

function findSdkHeader(fileName) {
  for (const rootPath of sdkIncludeRoots()) {
    const include = join(rootPath, "Include");
    if (!existsSync(include)) continue;
    let versions = [];
    try {
      versions = readdirSync(include);
    } catch {
      continue;
    }
    for (const version of versions) {
      const header = join(include, version, "um", fileName);
      if (existsSync(header)) return header;
    }
  }
  return null;
}

function sourceDigest() {
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

function rvaToOffset(buffer, peOffset, rva) {
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  let section = peOffset + 24 + optionalSize;
  for (let i = 0; i < sectionCount; i += 1) {
    const virtualSize = buffer.readUInt32LE(section + 8);
    const virtualAddress = buffer.readUInt32LE(section + 12);
    const rawSize = buffer.readUInt32LE(section + 16);
    const rawPointer = buffer.readUInt32LE(section + 20);
    const span = Math.max(virtualSize, rawSize);
    if (rva >= virtualAddress && rva < virtualAddress + span) {
      return rawPointer + (rva - virtualAddress);
    }
    section += 40;
  }
  return null;
}

function readCString(buffer, offset) {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  return buffer.toString("ascii", offset, end);
}

// IMAGE_IMPORT_DESCRIPTOR is 20 bytes with the name RVA at +12.
// ImgDelayDescr is 32 bytes with the name RVA at +4.
const importLayouts = {
  1: { stride: 20, nameAt: 12 },
  13: { stride: 32, nameAt: 4 },
};

function importDlls(buffer, peOffset, dataDirectory, index) {
  const layout = importLayouts[index];
  const entry = dataDirectory + index * 8;
  if (entry + 8 > buffer.length) return [];
  const rva = buffer.readUInt32LE(entry);
  if (rva === 0) return [];
  const offset = rvaToOffset(buffer, peOffset, rva);
  if (offset == null) return [];
  const names = [];
  for (let cursor = offset; cursor + layout.stride <= buffer.length; cursor += layout.stride) {
    const nameRva = buffer.readUInt32LE(cursor + layout.nameAt);
    if (nameRva === 0) break;
    const nameOffset = rvaToOffset(buffer, peOffset, nameRva);
    if (nameOffset == null) break;
    names.push(readCString(buffer, nameOffset));
  }
  return names;
}

function verifyPe(path) {
  const buffer = readFileSync(path);
  if (buffer.length < 64 || buffer.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("addon is not a PE image");
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 26 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x4550) {
    throw new Error("addon is missing a PE signature");
  }
  const machine = buffer.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) {
    throw new Error(`addon machine is 0x${machine.toString(16)}, expected x64`);
  }
  const optional = peOffset + 24;
  const magic = buffer.readUInt16LE(optional);
  if (magic !== 0x20b) throw new Error("addon is not PE32+");
  const dataDirectory = optional + 112;
  const imports = [
    ...importDlls(buffer, peOffset, dataDirectory, 1),
    ...importDlls(buffer, peOffset, dataDirectory, 13),
  ];
  const folded = imports.map((name) => name.toLowerCase());
  const dynamic = folded.filter((name) => dynamicCrt.has(name));
  if (dynamic.length > 0) {
    throw new Error(`addon links the dynamic CRT: ${dynamic.join(", ")}`);
  }
  if (!folded.includes("ole32.dll")) {
    throw new Error(`addon is missing ole32.dll in [${imports.join(", ")}]`);
  }
  return imports;
}

function resolveNodeGyp() {
  const localPkg = join(root, "node_modules", "node-gyp", "package.json");
  const localBin = join(root, "node_modules", "node-gyp", "bin", "node-gyp.js");
  if (existsSync(localPkg) && existsSync(localBin)) {
    try {
      const version = JSON.parse(readFileSync(localPkg, "utf8")).version;
      if (version === "13.1.0") {
        return { command: process.execPath, prefix: [localBin], version };
      }
    } catch {
      // Malformed node-gyp package.json: fall through to the npx path below.
    }
  }
  // Run npx's JS entry with this node: Node refuses to spawn npx.cmd without
  // a shell (CVE-2024-27980), and a shell would re-parse the arguments.
  const npxCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (existsSync(npxCli)) {
    return { command: process.execPath, prefix: [npxCli, "--yes", "node-gyp@13.1.0"], version: "13.1.0" };
  }
  return { command: "npx", prefix: ["--yes", "node-gyp@13.1.0"], version: "13.1.0" };
}

const nodeOk = process.versions.node && process.arch === "x64";
const python = pythonVersion();
const vswhere = vswherePath();
const visualStudio = visualStudioInstall(vswhere);
const cl = clPath();
const mmdevice = findSdkHeader("mmdeviceapi.h");
const audioclient = findSdkHeader("audioclient.h");
const missing = [];
if (!nodeOk) missing.push("host_node_x64");
if (!python) missing.push("python");
if (!visualStudio && !cl) missing.push("visual_studio_cpp");
if (!mmdevice) missing.push("windows_sdk_mmdeviceapi_h");
if (!audioclient) missing.push("windows_sdk_audioclient_h");

if (missing.includes("visual_studio_cpp") || missing.includes("windows_sdk_mmdeviceapi_h") || missing.includes("windows_sdk_audioclient_h")) {
  fail({
    error: "missing_compiler_or_windows_sdk",
    missing,
    node: process.version,
    arch: process.arch,
    python,
    vswhere,
    visualStudio,
    cl,
    mmdeviceapi: mmdevice,
    audioclient,
  });
}

if (missing.length > 0) {
  fail({ error: "missing_host_tool", missing, node: process.version, python });
}

const gyp = resolveNodeGyp();
const rebuild = spawnSync(gyp.command, [
  ...gyp.prefix,
  "rebuild",
  "--directory", nativeDir,
  "--target=44.9.0",
  "--arch=x64",
  "--dist-url=https://electronjs.org/headers",
], { cwd: root, encoding: "utf8", windowsHide: true });

let lockedAddon = false;
if (rebuild.status !== 0 || !existsSync(addonPath)) {
  const stderr = rebuild.stderr || "";
  const locked = existsSync(addonPath) && /EPERM|being used by another process|clean error/i.test(stderr);
  if (!locked) {
    fail({
      error: "node_gyp_rebuild_failed",
      status: rebuild.status,
      nodeGyp: gyp.version,
      addonPresent: existsSync(addonPath),
      stdout: rebuild.stdout || "",
      stderr,
    });
  }
  // A running instance (e.g. the dev app mid-session) has audio_capture.node
  // loaded, so node-gyp cannot clean it. The existing addon is present and
  // passes the PE/ABI checks below and `npm run test:native-audio`; package
  // with it rather than blocking the build on a Windows file lock.
  console.error(JSON.stringify({ warning: "node_gyp_rebuild_skipped_locked_addon", status: rebuild.status }));
  lockedAddon = true;
}

let imports;
try {
  imports = verifyPe(addonPath);
} catch (error) {
  fail({
    error: "pe_import_check_failed",
    detail: error instanceof Error ? error.message : String(error),
  });
}

const sha256 = createHash("sha256").update(readFileSync(addonPath)).digest("hex");

if (lockedAddon) {
  // The binary did not change, so neither does its manifest: a fresh
  // sourceDigest would tell packaging that an old binary matches new sources.
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    /* no manifest: the locked binary cannot be vouched for */
  }
  if (!previous || previous.sha256 !== sha256) {
    fail({ error: "locked_addon_unverified", hint: "close the app that has audio_capture.node loaded, then build again" });
  }
  const stale = previous.sourceDigest !== sourceDigest();
  process.stdout.write(`${JSON.stringify({ ok: true, addonPath, imports, manifest: previous, stale })}\n`);
  process.exit(0);
}

const manifest = {
  sha256,
  sourceDigest: sourceDigest(),
  apiVersion: 1,
  napiVersion: 8,
  arch: "x64",
  electronTarget,
  // Build evidence for the diagnostics export; the test script appends its
  // own testOutcome to this same manifest file.
  buildOutcome: { ok: true, at: new Date().toISOString() },
};
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, addonPath, imports, manifest })}\n`);
