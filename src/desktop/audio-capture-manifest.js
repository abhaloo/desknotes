/**
 * File/path verification for the native audio host.
 *
 * Split out of `audio-capture-host.js` so the host keeps only fork/startup,
 * credit accounting, slot lifecycle and message routing. The contract module
 * stays pure; this module owns the fs-facing checks that need real paths.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { makeCodedError } from "./audio-capture-contract.js";

// DLL search needs SystemRoot/PATH. Everything else — provider keys,
// NODE_OPTIONS, inspect flags — stays in the main process.
export const ENV_ALLOW = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "ComSpec",
  "SystemDrive",
]);

export function minimalWindowsEnv(source = process.env) {
  const env = {};
  for (const key of ENV_ALLOW) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

export function readQpc100ns() {
  return Number(process.hrtime.bigint() / 100n);
}

export function verifiedFile(input, label) {
  if (typeof input !== "string" || input.includes("\0") || !isAbsolute(input)) {
    throw makeCodedError("invalid-path", `${label} must be an absolute path`);
  }
  try {
    return realpathSync(input);
  } catch {
    throw makeCodedError("invalid-path", `${label} is not a verified file`);
  }
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
