import test from "node:test";
import assert from "node:assert/strict";
import { SessionLifecycle, SESSION_STATES } from "../src/desktop/session-lifecycle.js";

/** Deterministic timers: tests fire the watchdog instead of waiting 30 s. */
function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    timers: {
      setTimeout(fn, ms) {
        const id = nextId++;
        pending.set(id, { fn, ms });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    fire(ms) {
      for (const [id, entry] of pending) {
        if (entry.ms === ms) {
          pending.delete(id);
          entry.fn();
          return true;
        }
      }
      return false;
    },
    get pending() {
      return [...pending.values()];
    },
  };
}

function makeClock(step = 1000) {
  let now = 1_000;
  return {
    now: () => now,
    tick: () => {
      now += step;
      return now;
    },
  };
}

test("session lifecycle walks idle -> launching -> active -> ending -> ended", () => {
  const clock = makeClock();
  const lifecycle = new SessionLifecycle({ now: clock.now });
  const seen = [];
  const unsubscribe = lifecycle.subscribe((snapshot) => seen.push(`${snapshot.previous}->${snapshot.state}`));

  assert.equal(lifecycle.getState(), SESSION_STATES.IDLE);
  assert.equal(lifecycle.send("START").ok, true);
  assert.equal(lifecycle.getState(), SESSION_STATES.LAUNCHING);
  assert.equal(lifecycle.send("LAUNCHED").ok, true);
  assert.equal(lifecycle.getState(), SESSION_STATES.ACTIVE);
  clock.tick();
  assert.equal(lifecycle.send("END").ok, true);
  assert.equal(lifecycle.getState(), SESSION_STATES.ENDING);
  assert.equal(lifecycle.send("ENDED").ok, true);
  assert.equal(lifecycle.getState(), SESSION_STATES.ENDED);

  assert.deepEqual(seen, [
    "idle->launching",
    "launching->active",
    "active->ending",
    "ending->ended",
  ]);
  unsubscribe();
  lifecycle.send("RETRY");
  assert.equal(seen.length, 4, "unsubscribe stops notifications");
  lifecycle.dispose();
});

test("launch and connection failures latch failed", () => {
  const a = new SessionLifecycle();
  a.send("START");
  a.send("LAUNCH_FAILED", { reason: "socket refused" });
  assert.equal(a.getState(), SESSION_STATES.FAILED);
  assert.equal(a.getSnapshot().reason, "socket refused");
  a.dispose();

  const b = new SessionLifecycle();
  b.send("START");
  b.send("LAUNCHED");
  b.send("CONNECTION_FAILED", { reason: "heartbeat deadline" });
  assert.equal(b.getState(), SESSION_STATES.FAILED);
  assert.equal(b.getSnapshot().event, "CONNECTION_FAILED");
  b.dispose();
});

test("launching watchdog expiry fails the session and retry re-launches", () => {
  const timers = fakeTimers();
  const lifecycle = new SessionLifecycle({ timers: timers.timers });
  lifecycle.send("START");
  assert.deepEqual(timers.pending.map((entry) => entry.ms), [30_000]);

  assert.equal(timers.fire(30_000), true);
  assert.equal(lifecycle.getState(), SESSION_STATES.FAILED);
  assert.equal(lifecycle.getSnapshot().reason, "watchdog:launching");
  assert.equal(lifecycle.getSnapshot().error.code, "E_TIMEOUT");

  assert.equal(lifecycle.send("RETRY").ok, true);
  assert.equal(lifecycle.getState(), SESSION_STATES.LAUNCHING);
  assert.deepEqual(timers.pending.map((entry) => entry.ms), [30_000], "retry arms a fresh watchdog");
  assert.equal(lifecycle.getSnapshot().error, null);

  lifecycle.send("LAUNCHED");
  assert.equal(lifecycle.getState(), SESSION_STATES.ACTIVE);
  assert.equal(timers.pending.length, 0, "opening the session disarms the launch watchdog");
  lifecycle.dispose();
});

test("ending watchdog expiry fails instead of leaving the UI stuck", () => {
  const timers = fakeTimers();
  const lifecycle = new SessionLifecycle({ timers: timers.timers });
  lifecycle.send("START");
  lifecycle.send("LAUNCHED");
  lifecycle.send("END");
  assert.equal(lifecycle.getState(), SESSION_STATES.ENDING);
  assert.deepEqual(timers.pending.map((entry) => entry.ms), [30_000]);

  timers.fire(30_000);
  assert.equal(lifecycle.getState(), SESSION_STATES.FAILED);
  assert.equal(lifecycle.getSnapshot().reason, "watchdog:ending");
  lifecycle.dispose();
});

test("END during launching still tears down through ending", () => {
  const lifecycle = new SessionLifecycle();
  lifecycle.send("START");
  lifecycle.send("END");
  assert.equal(lifecycle.getState(), SESSION_STATES.ENDING);
  lifecycle.send("ENDED");
  assert.equal(lifecycle.getState(), SESSION_STATES.ENDED);
  lifecycle.dispose();
});

test("late watchdog callbacks are inert after a transition", () => {
  const timers = fakeTimers();
  const lifecycle = new SessionLifecycle({ timers: timers.timers });
  lifecycle.send("START");
  const watchdog = timers.pending[0];
  lifecycle.send("LAUNCHED");
  watchdog.fn(); // timer already cleared; guard prevents a stale failure
  assert.equal(lifecycle.getState(), SESSION_STATES.ACTIVE);
  lifecycle.dispose();
});

test("ignored events are no-ops and never throw", () => {
  const lifecycle = new SessionLifecycle();
  for (const event of ["LAUNCHED", "END", "ENDED", "LAUNCH_FAILED", "CONNECTION_FAILED", "NOPE"]) {
    const result = lifecycle.send(event);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "ignored");
  }
  assert.equal(lifecycle.getState(), SESSION_STATES.IDLE);
  lifecycle.dispose();
});

test("a throwing subscriber cannot wedge the machine", () => {
  const lifecycle = new SessionLifecycle();
  lifecycle.subscribe(() => {
    throw new Error("renderer exploded");
  });
  const ok = [];
  lifecycle.subscribe((snapshot) => ok.push(snapshot.state));
  assert.doesNotThrow(() => lifecycle.send("START"));
  assert.deepEqual(ok, [SESSION_STATES.LAUNCHING]);
  lifecycle.dispose();
});

test("dispose clears timers and rejects further events", () => {
  const timers = fakeTimers();
  const lifecycle = new SessionLifecycle({ timers: timers.timers });
  lifecycle.send("START");
  lifecycle.dispose();
  assert.equal(timers.pending.length, 0);
  assert.equal(lifecycle.send("LAUNCHED").ok, false);
  assert.equal(lifecycle.send("LAUNCHED").reason, "disposed");
  assert.equal(lifecycle.getState(), SESSION_STATES.LAUNCHING);
});
