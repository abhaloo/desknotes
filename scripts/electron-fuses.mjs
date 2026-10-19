/**
 * electron-builder `afterPack` hook: flip Electron fuses in the packaged
 * binary before it is signed.
 *
 * WHY: by default any local process can turn the shipped executable into a
 * plain Node runtime (ELECTRON_RUN_AS_NODE), inject code with NODE_OPTIONS or
 * --inspect, or swap the app code next to it. All of those run with the
 * app's identity, which is trusted with call audio, screenshots and keys.
 *
 * WHY a hand-rolled flipper: electron-builder 26 has `electronFuses`, but this
 * flipper is kept because it fails closed on an unexpected fuse layout.
 * The fuse wire is a documented, stable format:
 * sentinel, u8 version (1), u8 length, then one ASCII byte per fuse
 * ('0' off, '1' on, 'r' removed). Anything unexpected fails the build:
 * shipping without fuses must never be silent.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const WIRE_VERSION = 1;
const OFF = 0x30;
const ON = 0x31;
const REMOVED = 0x72;

/**
 * FuseV1Options in wire order. `want: null` leaves the fuse as shipped.
 * GrantFileProtocolExtraPrivileges stays ON for now: the renderer is loaded
 * from file:// with ES modules, which need those privileges. Moving to a
 * custom app:// protocol (phase 2) lets it go OFF.
 * WasmTrapHandlers (Electron 41 and later, the 9th fuse) stays as shipped:
 * V8 uses it to trap out-of-bounds WebAssembly access.
 */
export const FUSES = Object.freeze([
  { name: "RunAsNode", want: false },
  { name: "EnableCookieEncryption", want: true },
  { name: "EnableNodeOptionsEnvironmentVariable", want: false },
  { name: "EnableNodeCliInspectArguments", want: false },
  { name: "EnableEmbeddedAsarIntegrityValidation", want: true },
  { name: "OnlyLoadAppFromAsar", want: true },
  { name: "LoadBrowserProcessSpecificV8Snapshot", want: null },
  { name: "GrantFileProtocolExtraPrivileges", want: null },
  { name: "WasmTrapHandlers", want: null },
]);

/** @param {Buffer} buf */
export function readFuseWire(buf) {
  const sentinel = Buffer.from(FUSE_SENTINEL, "latin1");
  const at = buf.indexOf(sentinel);
  if (at < 0) throw new Error("electron-fuses: fuse sentinel not found in binary");
  if (buf.indexOf(sentinel, at + 1) >= 0) throw new Error("electron-fuses: fuse sentinel appears more than once");
  const versionAt = at + sentinel.length;
  const version = buf[versionAt];
  const length = buf[versionAt + 1];
  const start = versionAt + 2;
  if (start + length > buf.length) throw new Error("electron-fuses: truncated fuse wire");
  return { version, start, length, wire: buf.subarray(start, start + length).toString("latin1") };
}

/**
 * Flip the configured fuses in place.
 * @param {Buffer} buf
 * @returns {{before: string, after: string, changed: boolean}}
 */
export function flipFuseWire(buf, fuses = FUSES) {
  const { version, start, length, wire } = readFuseWire(buf);
  if (version !== WIRE_VERSION) throw new Error(`electron-fuses: unsupported fuse wire version ${version}`);
  if (length < fuses.length) {
    throw new Error(`electron-fuses: binary has ${length} fuses, expected at least ${fuses.length}`);
  }
  for (let i = 0; i < length; i += 1) {
    const byte = buf[start + i];
    if (byte !== OFF && byte !== ON && byte !== REMOVED) {
      throw new Error(`electron-fuses: unexpected fuse byte 0x${byte.toString(16)} at index ${i}`);
    }
  }
  fuses.forEach((fuse, i) => {
    if (fuse.want === null) return;
    if (buf[start + i] === REMOVED) throw new Error(`electron-fuses: fuse ${fuse.name} was removed from this Electron`);
    buf[start + i] = fuse.want ? ON : OFF;
  });
  const after = buf.subarray(start, start + length).toString("latin1");
  return { before: wire, after, changed: after !== wire };
}

/** The binary that carries the fuse wire for a packaged app. */
function fuseBinaryPath(context) {
  const name = context.packager?.appInfo?.productFilename;
  switch (context.electronPlatformName) {
    case "darwin":
    case "mas":
      return join(context.appOutDir, `${name}.app`, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework");
    case "win32":
      return join(context.appOutDir, `${name}.exe`);
    default:
      return join(context.appOutDir, context.packager?.executableName ?? name);
  }
}

/** electron-builder hook entry (resolved by name, or as the default export). */
export async function afterPack(context) {
  const target = fuseBinaryPath(context);
  if (!existsSync(target)) throw new Error(`electron-fuses: packaged binary not found: ${target}`);
  const buf = readFileSync(target);
  const { before, after, changed } = flipFuseWire(buf);
  if (changed) writeFileSync(target, buf);
  console.log(`[electron-fuses] ${target}: ${before} -> ${after}`);
}

export default afterPack;
