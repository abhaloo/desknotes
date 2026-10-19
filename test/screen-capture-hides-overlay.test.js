import test from "node:test";
import assert from "node:assert/strict";
import { withAppWindowsHidden } from "../src/desktop/capture-visibility.js";

/** A window that appends each call to the shared log, tagged with its name. */
function fakeWindow(name, log, { visible = true, destroyed = false } = {}) {
  const win = {
    destroyed,
    isDestroyed: () => win.destroyed,
    isVisible: () => visible,
    hide() { log.push(`hide ${name}`); },
    showInactive() { log.push(`showInactive ${name}`); },
  };
  return win;
}

/** A `wait` that resolves at once and records the delay it was asked for. */
function fakeWait(log) {
  return async (ms) => { log.push(`wait ${ms}`); };
}

test("hides visible windows during the capture and restores them", async () => {
  const log = [];
  const a = fakeWindow("A", log);
  const result = await withAppWindowsHidden([a], async () => {
    log.push("run");
    return "shot";
  }, { wait: fakeWait(log) });
  assert.equal(result, "shot");
  assert.deepEqual(log, ["hide A", "wait 120", "run", "showInactive A"]);
});

test("a hidden window stays hidden", async () => {
  const log = [];
  const hiddenWin = fakeWindow("A", log, { visible: false });
  const visibleWin = fakeWindow("B", log);
  await withAppWindowsHidden([hiddenWin, visibleWin], async () => {
    log.push("run");
  }, { wait: fakeWait(log) });
  assert.deepEqual(log, ["hide B", "wait 120", "run", "showInactive B"]);
});

test("restores even when the capture throws", async () => {
  const log = [];
  const a = fakeWindow("A", log);
  await assert.rejects(
    withAppWindowsHidden([a], async () => {
      log.push("run");
      throw new Error("capture failed");
    }, { wait: fakeWait(log) }),
    { message: "capture failed" },
  );
  assert.deepEqual(log, ["hide A", "wait 120", "run", "showInactive A"]);
});

test("no visible window means no wait", async () => {
  const log = [];
  const waits = [];
  const hiddenWin = fakeWindow("A", log, { visible: false });
  const result = await withAppWindowsHidden([hiddenWin, null, undefined], async () => {
    log.push("run");
    return "shot";
  }, { wait: async (ms) => { waits.push(ms); } });
  assert.equal(result, "shot");
  assert.deepEqual(waits, []);
  assert.deepEqual(log, ["run"]);
});

test("missing or destroyed windows are skipped", async () => {
  const log = [];
  const destroyed = fakeWindow("A", log, { destroyed: true });
  await withAppWindowsHidden([null, undefined, destroyed], async () => {
    log.push("run");
  }, { wait: fakeWait(log) });
  assert.deepEqual(log, ["run"]);
});

test("a window destroyed during the capture is not shown again", async () => {
  const log = [];
  const a = fakeWindow("A", log);
  await withAppWindowsHidden([a], async () => {
    log.push("run");
    a.destroyed = true;
  }, { wait: fakeWait(log) });
  assert.deepEqual(log, ["hide A", "wait 120", "run"]);
});
