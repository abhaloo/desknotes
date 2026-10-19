/**
 * Main-owned audio device choices.
 *
 * The renderer never supplies the file path: the name is fixed and the
 * directory is the app user-data directory. A bad file stays invalid so
 * capture cannot silently move to another endpoint.
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicReplace } from "./atomic-file.js";
import { validateDeviceChoice } from "./audio-capture-contract.js";

export const PREFERENCES_FILENAME = "audio-device-preferences.json";
export const MAX_PREFERENCES_BYTES = 16 * 1024;
export const PREFERENCES_VERSION = 1;

export const AUDIO_SOURCES = Object.freeze(["microphone", "system"]);

export const DEFAULT_CHOICES = Object.freeze({
  microphone: Object.freeze({ kind: "default", role: "communications" }),
  system: Object.freeze({ kind: "default", role: "multimedia" }),
});

const FORBIDDEN_OPTION_KEYS = Object.freeze([
  "filePath",
  "preferencesPath",
  "filename",
  "path",
  "nativeOptions",
  "workerPath",
  "addonPath",
  "scriptPath",
  "credentials",
]);

const defaultFs = Object.freeze({
  mkdir,
  stat,
  readFile,
  writeFile,
  rename,
  unlink,
});

export class AudioPreferenceError extends Error {
  constructor(code, message, type) {
    super(message);
    this.name = "AudioPreferenceError";
    this.code = code;
    if (type) this.type = type;
  }
}

export function createAudioDevicePreferences(options = {}) {
  assertOwnedLocation(options);
  const { userDataDir, fs, isCapturing, log } = options;
  const io = fs ?? defaultFs;
  const capturing = typeof isCapturing === "function" ? isCapturing : () => isCapturing === true;
  const filePath = path.join(userDataDir, PREFERENCES_FILENAME);
  let last = null;
  let tail = Promise.resolve();

  function enqueue(task) {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function load() {
    const snapshot = copySnapshot(await readSnapshot(io, filePath));
    last = copySnapshot(snapshot);
    log?.({ event: "audio-preferences.load", invalid: snapshot.microphone.invalidPreference || snapshot.system.invalidPreference });
    return snapshot;
  }

  function save(source, choice) {
    return enqueue(async () => {
      if (capturing()) throw captureConflict();
      if (!AUDIO_SOURCES.includes(source)) {
        throw new AudioPreferenceError("INVALID_SOURCE", "Audio source must be microphone or system.");
      }
      const validated = validateDeviceChoice(choice);
      if (!validated.ok) throw new AudioPreferenceError(validated.code, validated.message);
      const snapshot = await readSnapshot(io, filePath);
      snapshot[source] = validSource(validated.choice);
      if (capturing()) throw captureConflict();
      const body = serializeSnapshot(snapshot);
      if (Buffer.byteLength(body) > MAX_PREFERENCES_BYTES) {
        throw new AudioPreferenceError("PREFERENCES_TOO_LARGE", "Preferences exceed 16 KiB.");
      }
      await atomicReplace(io, filePath, body);
      last = copySnapshot(snapshot);
      log?.({ event: "audio-preferences.save", source, result: "ok", kind: validated.choice.kind });
      return { ...validated.choice };
    });
  }

  function reconcile(catalog) {
    if (!last) {
      throw new AudioPreferenceError("PREFERENCES_NOT_LOADED", "Load preferences before reconcile.");
    }
    return reconcileDevicePreferences(last, catalog);
  }

  return { load, save, reconcile };
}

export function reconcileDevicePreferences(snapshot, catalog) {
  const next = copySnapshot(snapshot);
  for (const source of AUDIO_SOURCES) {
    const entry = next[source];
    if (!entry || entry.invalidPreference || !entry.choice) {
      if (entry) {
        entry.available = false;
        entry.unavailableSavedEndpoint = false;
      }
      continue;
    }
    if (entry.choice.kind === "endpoint") {
      const found = devicesFor(catalog, source).some((device) => device && device.id === entry.choice.id);
      entry.available = found;
      entry.unavailableSavedEndpoint = !found;
      continue;
    }
    entry.available = true;
    entry.unavailableSavedEndpoint = false;
  }
  return next;
}

function assertOwnedLocation(options) {
  for (const key of FORBIDDEN_OPTION_KEYS) {
    if (options && Object.prototype.hasOwnProperty.call(options, key)) {
      throw new AudioPreferenceError(
        "RENDERER_PATH_REJECTED",
        "Preferences keep the main-owned file name and refuse a renderer-supplied path.",
      );
    }
  }
  if (typeof options.userDataDir !== "string" || !path.isAbsolute(options.userDataDir)) {
    throw new AudioPreferenceError("INVALID_USER_DATA_DIR", "userDataDir must be an absolute main-owned directory.");
  }
}

function captureConflict() {
  return new AudioPreferenceError(
    "AUDIO_CAPTURE_ACTIVE",
    "Stop audio before changing the selected device.",
    "CONFLICT",
  );
}

async function readSnapshot(io, filePath) {
  let info;
  try {
    info = await io.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return defaultSnapshot();
    throw error;
  }
  if (typeof info?.size === "number" && info.size > MAX_PREFERENCES_BYTES) {
    return invalidFile("PREFERENCES_TOO_LARGE", "Preferences file exceeds 16 KiB.");
  }
  let text;
  try {
    text = await io.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return defaultSnapshot();
    throw error;
  }
  if (Buffer.byteLength(text) > MAX_PREFERENCES_BYTES) {
    return invalidFile("PREFERENCES_TOO_LARGE", "Preferences file exceeds 16 KiB.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidFile("PREFERENCES_MALFORMED", "Preferences file is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalidFile("PREFERENCES_MALFORMED", "Preferences file must be a JSON object.");
  }
  return {
    microphone: parseStoredSource(parsed.microphone, "microphone"),
    system: parseStoredSource(parsed.system, "system"),
  };
}

function parseStoredSource(value, source) {
  if (value === undefined) return validSource(freshDefault(source));
  if (!value || typeof value !== "object" || Array.isArray(value) || value.invalidPreference === true) {
    const code = value?.error?.code || "INVALID_DEVICE_CHOICE";
    const message = value?.error?.message || `${labelFor(source)} choice is invalid.`;
    return invalidSource(code, message);
  }
  const validated = validateDeviceChoice(value);
  if (!validated.ok) return invalidSource(validated.code, validated.message);
  return validSource(validated.choice);
}

function defaultSnapshot() {
  return {
    microphone: validSource(freshDefault("microphone")),
    system: validSource(freshDefault("system")),
  };
}

function freshDefault(source) {
  return { ...DEFAULT_CHOICES[source] };
}

function validSource(choice) {
  return {
    choice,
    invalidPreference: false,
    error: null,
    available: true,
    unavailableSavedEndpoint: false,
  };
}

function invalidSource(code, message) {
  return {
    choice: null,
    invalidPreference: true,
    error: { code, message },
    available: false,
    unavailableSavedEndpoint: false,
  };
}

function invalidFile(code, message) {
  return {
    microphone: invalidSource(code, message),
    system: invalidSource(code, message),
  };
}

function serializeSnapshot(snapshot) {
  return `${JSON.stringify({
    version: PREFERENCES_VERSION,
    microphone: serializeSource(snapshot.microphone, "microphone"),
    system: serializeSource(snapshot.system, "system"),
  }, null, 2)}\n`;
}

function serializeSource(entry, source) {
  if (!entry || entry.invalidPreference || !entry.choice) {
    return {
      invalidPreference: true,
      error: {
        code: entry?.error?.code || "INVALID_DEVICE_CHOICE",
        message: entry?.error?.message || `${labelFor(source)} choice is invalid.`,
      },
    };
  }
  return entry.choice.kind === "endpoint"
    ? { kind: "endpoint", id: entry.choice.id }
    : { kind: "default", role: entry.choice.role };
}

function devicesFor(catalog, source) {
  if (!catalog) return [];
  if (Array.isArray(catalog)) return catalog.filter((device) => device?.source === source);
  if (Array.isArray(catalog[source])) return catalog[source];
  return [];
}

function copySnapshot(snapshot) {
  return {
    microphone: copySource(snapshot?.microphone),
    system: copySource(snapshot?.system),
  };
}

function copySource(entry) {
  if (!entry) return invalidSource("INVALID_DEVICE_CHOICE", "Device choice is missing.");
  return {
    choice: entry.choice ? { ...entry.choice } : null,
    invalidPreference: Boolean(entry.invalidPreference),
    error: entry.error ? { code: entry.error.code, message: entry.error.message } : null,
    available: entry.available !== false,
    unavailableSavedEndpoint: Boolean(entry.unavailableSavedEndpoint),
  };
}

function labelFor(source) {
  return source === "system" ? "Playback" : "Microphone";
}
