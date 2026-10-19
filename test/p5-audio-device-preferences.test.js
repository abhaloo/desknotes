import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_CHOICES,
  MAX_PREFERENCES_BYTES,
  PREFERENCES_FILENAME,
  createAudioDevicePreferences,
  reconcileDevicePreferences,
} from "../src/desktop/audio-device-preferences.js";

async function makeDir() {
  return mkdtemp(path.join(tmpdir(), "audio-prefs-"));
}

test("missing preferences file returns the canonical per-source defaults", async () => {
  const dir = await makeDir();
  try {
    const prefs = createAudioDevicePreferences({ userDataDir: dir });
    const loaded = await prefs.load();
    assert.deepEqual(loaded.microphone.choice, { kind: "default", role: "communications" });
    assert.deepEqual(loaded.system.choice, { kind: "default", role: "multimedia" });
    assert.equal(loaded.microphone.invalidPreference, false);
    assert.equal(loaded.system.invalidPreference, false);
    assert.deepEqual(DEFAULT_CHOICES.microphone, { kind: "default", role: "communications" });
    assert.deepEqual(DEFAULT_CHOICES.system, { kind: "default", role: "multimedia" });
    await assert.rejects(() => stat(path.join(dir, PREFERENCES_FILENAME)), (error) => error.code === "ENOENT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("save persists an explicit endpoint and a default role under the fixed file name", async () => {
  const dir = await makeDir();
  try {
    const prefs = createAudioDevicePreferences({ userDataDir: dir });
    await prefs.save("microphone", { kind: "endpoint", id: "MIC-1" });
    await prefs.save("system", { kind: "default", role: "communications" });
    const loaded = await prefs.load();
    assert.deepEqual(loaded.microphone.choice, { kind: "endpoint", id: "MIC-1" });
    assert.deepEqual(loaded.system.choice, { kind: "default", role: "communications" });
    const names = await readdir(dir);
    assert.deepEqual(names, [PREFERENCES_FILENAME]);
    assert.equal(PREFERENCES_FILENAME, "audio-device-preferences.json");
    assert.equal(MAX_PREFERENCES_BYTES, 16384);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("save rejects an unknown source, a bad choice, and renderer native options", async () => {
  const dir = await makeDir();
  try {
    const prefs = createAudioDevicePreferences({ userDataDir: dir });
    await assert.rejects(() => prefs.save("mic", { kind: "default", role: "multimedia" }), (error) => {
      assert.equal(error.code, "INVALID_SOURCE");
      return true;
    });
    await assert.rejects(() => prefs.save("system", { kind: "endpoint", id: "" }), (error) => {
      assert.equal(error.code, "INVALID_DEVICE_CHOICE");
      return true;
    });
    await assert.rejects(
      () => prefs.save("system", { kind: "default", role: "console" }),
      (error) => error.code === "INVALID_DEVICE_CHOICE",
    );
    await assert.rejects(
      () => prefs.save("microphone", { kind: "endpoint", id: "MIC-1", workerPath: "C:\\helper.js" }),
      (error) => error.code === "INVALID_DEVICE_CHOICE",
    );
    await assert.rejects(() => stat(path.join(dir, PREFERENCES_FILENAME)), (error) => error.code === "ENOENT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed and oversized files stay invalid and are not replaced with defaults", async () => {
  const dir = await makeDir();
  const filePath = path.join(dir, PREFERENCES_FILENAME);
  try {
    await writeFile(filePath, "{");
    const prefs = createAudioDevicePreferences({ userDataDir: dir });
    const malformed = await prefs.load();
    assert.equal(malformed.microphone.invalidPreference, true);
    assert.equal(malformed.system.invalidPreference, true);
    assert.equal(malformed.microphone.choice, null);
    assert.equal(malformed.system.choice, null);
    assert.equal(malformed.microphone.error.code, "PREFERENCES_MALFORMED");
    assert.equal(await readFile(filePath, "utf8"), "{");

    await writeFile(filePath, "x".repeat(MAX_PREFERENCES_BYTES + 1));
    const oversized = await prefs.load();
    assert.equal(oversized.microphone.invalidPreference, true);
    assert.equal(oversized.microphone.error.code, "PREFERENCES_TOO_LARGE");
    assert.equal((await readFile(filePath, "utf8")).length, MAX_PREFERENCES_BYTES + 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file over 16 KiB is not read, and a file of exactly 16 KiB may be parsed", async () => {
  let reads = 0;
  const prefs = createAudioDevicePreferences({
    userDataDir: "C:\\audio-user-data",
    fs: {
      async stat() {
        return { size: MAX_PREFERENCES_BYTES + 1 };
      },
      async readFile() {
        reads += 1;
        return "{}";
      },
    },
  });
  const oversized = await prefs.load();
  assert.equal(reads, 0);
  assert.equal(oversized.system.error.code, "PREFERENCES_TOO_LARGE");

  const bounded = createAudioDevicePreferences({
    userDataDir: "C:\\audio-user-data",
    fs: {
      async stat() {
        return { size: MAX_PREFERENCES_BYTES };
      },
      async readFile() {
        return JSON.stringify({
          microphone: { kind: "default", role: "communications" },
          system: { kind: "endpoint", id: "OUT-A" },
        });
      },
    },
  });
  const loaded = await bounded.load();
  assert.deepEqual(loaded.system.choice, { kind: "endpoint", id: "OUT-A" });
  assert.equal(loaded.system.invalidPreference, false);
});

test("one invalid source stays invalid while the other saved choice remains", async () => {
  const dir = await makeDir();
  const filePath = path.join(dir, PREFERENCES_FILENAME);
  try {
    await writeFile(filePath, JSON.stringify({
      microphone: { kind: "default", role: "communications" },
      system: { kind: "endpoint", id: "" },
    }));
    const prefs = createAudioDevicePreferences({ userDataDir: dir });
    const loaded = await prefs.load();
    assert.deepEqual(loaded.microphone.choice, { kind: "default", role: "communications" });
    assert.equal(loaded.system.invalidPreference, true);
    assert.equal(loaded.system.choice, null);
    assert.equal(loaded.system.error.code, "INVALID_DEVICE_CHOICE");

    await prefs.save("microphone", { kind: "endpoint", id: "MIC-9" });
    const again = await prefs.load();
    assert.deepEqual(again.microphone.choice, { kind: "endpoint", id: "MIC-9" });
    assert.equal(again.system.invalidPreference, true);
    assert.equal(again.system.choice, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing saved endpoint stays unavailable instead of being replaced", () => {
  const snapshot = {
    microphone: {
      choice: { kind: "default", role: "communications" },
      invalidPreference: false,
      error: null,
    },
    system: {
      choice: { kind: "endpoint", id: "GONE" },
      invalidPreference: false,
      error: null,
    },
  };
  const missing = reconcileDevicePreferences(snapshot, {
    microphone: [{ id: "MIC-1", name: "Headset" }],
    system: [{ id: "LIVE", name: "Speakers" }],
  });
  assert.deepEqual(missing.system.choice, { kind: "endpoint", id: "GONE" });
  assert.equal(missing.system.available, false);
  assert.equal(missing.system.unavailableSavedEndpoint, true);
  assert.equal(missing.microphone.unavailableSavedEndpoint, false);

  const present = reconcileDevicePreferences(snapshot, {
    system: [{ id: "GONE", name: "Dock" }],
  });
  assert.equal(present.system.available, true);
  assert.equal(present.system.unavailableSavedEndpoint, false);
  assert.deepEqual(present.system.choice, { kind: "endpoint", id: "GONE" });
});

test("an invalid preference is not reconciled onto a live catalog device", () => {
  const snapshot = {
    microphone: {
      choice: null,
      invalidPreference: true,
      error: { code: "INVALID_DEVICE_CHOICE", message: "Microphone choice is invalid." },
    },
    system: {
      choice: { kind: "default", role: "multimedia" },
      invalidPreference: false,
      error: null,
    },
  };
  const view = reconcileDevicePreferences(snapshot, {
    microphone: [{ id: "MIC-1", name: "Headset" }],
  });
  assert.equal(view.microphone.choice, null);
  assert.equal(view.microphone.invalidPreference, true);
  assert.equal(view.microphone.available, false);
});

test("save throws CONFLICT / AUDIO_CAPTURE_ACTIVE while capture is active and does not write", async () => {
  const dir = await makeDir();
  try {
    const prefs = createAudioDevicePreferences({ userDataDir: dir, isCapturing: () => true });
    await assert.rejects(
      () => prefs.save("system", { kind: "endpoint", id: "OUT-A" }),
      (error) => {
        assert.equal(error.code, "AUDIO_CAPTURE_ACTIVE");
        assert.equal(error.type, "CONFLICT");
        return true;
      },
    );
    await assert.rejects(() => stat(path.join(dir, PREFERENCES_FILENAME)), (error) => error.code === "ENOENT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a renderer-supplied path is refused and is not created", async () => {
  const dir = await makeDir();
  const planted = path.join(dir, "renderer-picked.json");
  try {
    assert.throws(
      () => createAudioDevicePreferences({ userDataDir: dir, filePath: planted }),
      (error) => error.code === "RENDERER_PATH_REJECTED",
    );
    assert.throws(
      () => createAudioDevicePreferences({ userDataDir: dir, preferencesPath: planted, nativeOptions: {} }),
      (error) => error.code === "RENDERER_PATH_REJECTED",
    );
    assert.throws(
      () => createAudioDevicePreferences({ userDataDir: "relative\\data" }),
      (error) => error.code === "INVALID_USER_DATA_DIR",
    );
    await assert.rejects(() => stat(planted), (error) => error.code === "ENOENT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("save writes a temp file in the same directory and then renames it into place", async () => {
  const dir = "C:\\audio-user-data";
  const calls = [];
  const mem = new Map();
  const fs = {
    async mkdir() {},
    async stat(filePath) {
      if (!mem.has(filePath)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return { size: Buffer.byteLength(mem.get(filePath)) };
    },
    async readFile(filePath) {
      if (!mem.has(filePath)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return mem.get(filePath);
    },
    async writeFile(filePath, data) {
      calls.push(["write", filePath]);
      mem.set(filePath, data);
    },
    async rename(from, to) {
      calls.push(["rename", from, to]);
      if (mem.has(to) && calls.filter((call) => call[0] === "rename").length === 1) {
        const error = new Error("exists");
        error.code = "EPERM";
        throw error;
      }
      mem.set(to, mem.get(from));
      mem.delete(from);
    },
    async unlink(filePath) {
      calls.push(["unlink", filePath]);
      mem.delete(filePath);
    },
  };
  const prefs = createAudioDevicePreferences({ userDataDir: dir, fs });
  await prefs.save("system", { kind: "endpoint", id: "OUT-A" });
  assert.equal(calls[0][0], "write");
  assert.equal(path.dirname(calls[0][1]), dir);
  assert.equal(calls[0][1].endsWith(".tmp"), true);
  assert.equal(calls[1][0], "rename");
  assert.equal(calls[1][2], path.join(dir, PREFERENCES_FILENAME));
  const stored = JSON.parse(mem.get(path.join(dir, PREFERENCES_FILENAME)));
  assert.deepEqual(stored.system, { kind: "endpoint", id: "OUT-A" });
  assert.equal([...mem.keys()].some((name) => name.endsWith(".tmp")), false);
});

test("replacing an existing preferences file leaves only the final JSON", async () => {
  const dir = await makeDir();
  try {
    const prefs = createAudioDevicePreferences({ userDataDir: dir });
    await prefs.save("system", { kind: "endpoint", id: "OUT-A" });
    await prefs.save("system", { kind: "endpoint", id: "OUT-B" });
    const text = await readFile(path.join(dir, PREFERENCES_FILENAME), "utf8");
    assert.match(text, /OUT-B/);
    assert.doesNotMatch(text, /OUT-A/);
    const names = await readdir(dir);
    assert.deepEqual(names, [PREFERENCES_FILENAME]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
