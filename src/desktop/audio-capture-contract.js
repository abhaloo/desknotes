/**
 * ESM facade over `audio-capture-contract.cjs`.
 *
 * The utility-process worker is CommonJS and must synchronously require the
 * shared rules, so the single implementation lives in the `.cjs` file. This
 * module keeps the historical ESM import path stable for the host, the audio
 * adapter, preferences, main and the tests.
 */

import { join } from "node:path";
import contract from "./audio-capture-contract.cjs";

export const {
  AUDIO_SOURCES,
  DEFAULT_ROLES,
  HEALTH_HEARTBEAT_MS,
  MAX_SAMPLES_PER_PACKET,
  MAX_ADMITTED_AGE_MS,
  QPC_TICKS_PER_MS,
  PRIVATE_KEYS,
  FLAG_KEYS,
  AUDIO_PACKET_KEYS,
  TERMINAL_STATES,
  TERMINAL_CODES,
  makeCodedError,
  validateDeviceChoice,
  assertDeviceChoice,
  stripPrivate,
  coerceFloat32,
  normalizeFlags,
  audioPacket,
  deriveTimestampMs,
  validateWorkerAudioEvent,
  isTerminalCaptureEvent,
  validateNativeManifest,
} = contract;

/**
 * Packaged builds copy the addon beside the asar (`resources/audio_capture.node`).
 * Dev builds keep it under `native/build/Release`. The manifest stays next to
 * this module so it travels inside the asar.
 */
export function selectNativeAddonLocation({ isPackaged, resourcesPath, moduleDir } = {}) {
  if (typeof moduleDir !== "string" || moduleDir.trim() === "") {
    throw makeCodedError("invalid-path", "module directory is required");
  }
  const manifestPath = join(moduleDir, "native-audio-manifest.json");
  const addonPath = isPackaged
    ? join(typeof resourcesPath === "string" ? resourcesPath : "", "audio_capture.node")
    : join(moduleDir, "..", "..", "native", "build", "Release", "audio_capture.node");
  return { addonPath, manifestPath, packaged: Boolean(isPackaged) };
}
