/**
 * Electron entry that loads audio_capture.node inside a utility process.
 *
 * WHY a utility process: native faults stay out of the app main process.
 * This driver lists devices only. It does not call startSource.
 */
"use strict";

const fs = require("node:fs");

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(error, extra) {
  emit({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...extra,
  });
  process.exit(1);
}

function assertDevice(device, source, type) {
  if (!device || typeof device.id !== "string" || device.id.length === 0) {
    throw new Error("device id missing");
  }
  if (typeof device.name !== "string") throw new Error("device name missing");
  if (device.source !== source) throw new Error(`device source ${device.source}`);
  if (device.type !== type) throw new Error(`device type ${device.type}`);
  if (typeof device.isDefault !== "boolean") throw new Error("isDefault missing");
  if (typeof device.channels !== "number") throw new Error("channels missing");
  if (typeof device.sampleRate !== "number") throw new Error("sampleRate missing");
  if (device.state !== "active") throw new Error(`device state ${device.state}`);
  if (!Array.isArray(device.defaultRoles)) throw new Error("defaultRoles missing");
}

async function valueOf(value) {
  if (value && typeof value.then === "function") return value;
  return value;
}

async function runWorker() {
  const addonPath = process.env.NATIVE_AUDIO_ADDON || "";
  if (!addonPath || !fs.existsSync(addonPath)) {
    fail(new Error("owned_addon_missing"), { addonPath });
  }
  let startedCaptureSources = 0;
  const addon = require(addonPath);
  if (typeof addon.startSource !== "function") {
    throw new Error("startSource export missing");
  }
  // The addon's exports are read-only, so count starts on a wrapper that
  // shadows startSource instead of reassigning the export.
  const binding = Object.create(addon, {
    startSource: {
      value: function countedStart(...args) {
        startedCaptureSources += 1;
        return addon.startSource(...args);
      },
    },
  });
  const capabilities = binding.getCapabilities();
  const expected = {
    apiVersion: 1,
    backend: "wasapi-loopback",
    napiVersion: 8,
    arch: "x64",
    supportsMicrophone: true,
    supportsSystemAudio: true,
    supportsInputDeviceSelection: true,
    supportsOutputDeviceSelection: true,
    supportsAec: false,
  };
  for (const [key, want] of Object.entries(expected)) {
    if (capabilities[key] !== want) {
      throw new Error(`capability ${key} is ${capabilities[key]}`);
    }
  }
  const microphones = await valueOf(binding.listDevices("microphone"));
  const system = await valueOf(binding.listDevices("system"));
  if (!Array.isArray(microphones) || !Array.isArray(system)) {
    throw new Error("listDevices did not return arrays");
  }
  for (const device of microphones) assertDevice(device, "microphone", "input");
  for (const device of system) assertDevice(device, "system", "output");

  await valueOf(binding.dispose());
  if (startedCaptureSources !== 0) {
    throw new Error(`started capture sources ${startedCaptureSources}`);
  }
  emit({
    ok: true,
    capabilities,
    microphoneCount: microphones.length,
    systemCount: system.length,
    startedCaptureSources,
  });
  process.exit(0);
}

if ((process.env.NATIVE_AUDIO_DRIVER_ROLE || "parent") === "worker") {
  runWorker().catch((error) => fail(error, { stage: "worker" }));
} else {
  const electron = require("electron");
  if (!electron || !electron.app || !electron.utilityProcess) {
    fail(new Error("electron_runtime_required"));
  }
  const { app, utilityProcess } = electron;
  const path = require("node:path");
  app.whenReady().then(() => {
    const child = utilityProcess.fork(path.resolve(__filename), [], {
      serviceName: "native-audio-catalog",
      stdio: "pipe",
      env: {
        ...process.env,
        NATIVE_AUDIO_DRIVER_ROLE: "worker",
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      process.stdout.write(output);
      app.exit(code || 0);
    });
  });
}
