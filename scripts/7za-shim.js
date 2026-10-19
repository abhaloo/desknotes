/**
 * 7za.exe shim for electron-builder on Windows (packaging workaround).
 *
 * electron-builder's Go helper (app-builder.exe) extracts its winCodeSign
 * bundle with `7za x -snld`, which creates entries as SYMBOLIC LINKS. On
 * accounts without SeCreateSymbolicLinkPrivilege (no admin / Developer Mode)
 * that fails the whole extraction — even though the only links in the bundle
 * are macOS dylibs no Windows build ever touches.
 *
 * This shim strips `-snld`, forwards everything else to the real 7za, and
 * treats "Cannot create symbolic link" sub-item errors as non-fatal. Any
 * other error still fails the build.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const real = join(dirname(process.execPath), "7za-real.exe");
const args = process.argv.slice(2).filter((arg) => arg !== "-snld");

const result = spawnSync(real, args, { stdio: ["inherit", "pipe", "pipe"], windowsHide: true });
const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");

const symlinkOnlyFailure =
  result.status !== 0 &&
  out.includes("Cannot create symbolic link") &&
  !out.includes("ERROR: No files"); // real extraction failures must stay fatal

process.exit(symlinkOnlyFailure ? 0 : (result.status ?? 1));
