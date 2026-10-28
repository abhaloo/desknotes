import test from "node:test";
import assert from "node:assert/strict";
import { SessionLifecycle, SESSION_STATES } from "../src/desktop/session-lifecycle.js";
import { IpcGateway, IPC } from "../src/desktop/ipc-gateway.js";

/**
 * Session recap, phase 1b: the recorder (src/desktop/recap/recorder.js)
 * subscribes ITSELF, so main's handleServerFrame / startSession / endSession
 * carry no recap code:
 *   - frames: the gateway bus main already relays every raw wire frame on
 *     (`speech:realtime-frame:received`); the bus stamps each message `at`;
 *   - lifecycle: it starts a timeline when the session goes launching ->
 *     active, and finishes on ONE lifecycle event, the terminal one (ended or
 *     failed), when no further frame can arrive.
 *
 *   createRecapRecorder({ lifecycle, bus, isEnabled, isPractice, sessionId,
 *                         save, onSaved, log, limits? })
 *     -> { recording(): boolean, settled(): Promise<void>, dispose() }
 *   save(recap) -> Promise<summary>; onSaved({ id, recap, summary, saveError })
 *
 * These tests drive the REAL SessionLifecycle and IpcGateway on one fake clock.
 */
const load = () => import("../src/desktop/recap/recorder.js");
const T0 = Date.parse("2026-10-28T14:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(overrides = {}) {
  const clock = { now: T0 };
  const now = () => clock.now;
  const lifecycle = new SessionLifecycle({ now, timers: { setTimeout: () => 0, clearTimeout: () => {} } });
  const bus = new IpcGateway({ now });
  const saved = [];
  const ready = [];
  const logs = [];
  const flags = { enabled: true, practice: false, sessionId: "session-1" };
  let seq = 0;
  const options = {
    lifecycle,
    bus,
    isEnabled: () => flags.enabled,
    // A function in flags.practice stands in for a probe that throws.
    isPractice: () => (typeof flags.practice === "function" ? flags.practice() : flags.practice),
    sessionId: () => flags.sessionId,
    save: async (recap) => {
      saved.push(recap);
      return { id: recap.id, startedAt: recap.startedAt, stats: recap.stats };
    },
    onSaved: (event) => ready.push(event),
    log: (entry) => logs.push(entry),
    ...overrides,
  };
  const at = (ms) => {
    clock.now = T0 + ms;
  };
  /** Exactly what main does: broadcast the raw string on the relay channel. */
  const wire = (type, data, ms) => {
    at(ms);
    bus.broadcast(IPC.SPEECH_REALTIME_FRAME_RECEIVED, JSON.stringify({ v: 1, type, seq: ++seq, data }));
  };
  const say = (text, ms, segment = `s${seq}`) => wire("transcript", { text, final: true, role: "prospect", source: "system", segment_id: segment }, ms);
  const begin = (ms = 0) => {
    at(ms);
    lifecycle.send("START");
    lifecycle.send("LAUNCHED");
  };
  const end = (ms, reason = "user") => {
    at(ms);
    lifecycle.send("END", { reason });
    lifecycle.send("ENDED");
  };
  return { clock, at, lifecycle, bus, saved, ready, logs, flags, options, wire, say, begin, end };
}

test("recorder: starts on launching -> active and saves once on ended", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  assert.equal(recorder.recording(), false);
  h.begin(0);
  assert.equal(recorder.recording(), true);
  h.say("How does SSO work?", 3_000);
  h.end(60_000);
  await recorder.settled();
  assert.equal(recorder.recording(), false);
  assert.equal(h.saved.length, 1);
  const recap = h.saved[0];
  assert.equal(recap.id, "session-1");
  assert.equal(recap.startedAt, iso(T0));
  assert.equal(recap.endedAt, iso(T0 + 60_000));
  assert.equal(recap.endReason, "user");
  assert.deepEqual(recap.lines.map((line) => [line.text, line.offsetMs]), [["How does SSO work?", 3_000]]);
  assert.ok(recap.stats && recap.questions && recap.gaps && recap.terms, "the saved recap is the built recap");
  assert.equal(h.ready.length, 1);
  assert.deepEqual(h.ready[0].summary, { id: "session-1", startedAt: iso(T0), stats: recap.stats });
  assert.equal(h.ready[0].id, "session-1");
  assert.equal(h.ready[0].saveError, null);
  recorder.dispose();
});

test("recorder: a line is stamped with the time main received the frame (the bus clock)", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  h.begin(0);
  h.wire("transcript", { text: "Is there", final: false, role: "prospect", segment_id: "a" }, 1_250);
  h.wire("transcript", { text: "Is there an API?", final: true, role: "prospect", segment_id: "a" }, 2_750);
  h.wire("turn.started", { turn_id: "t1", question: "Is there an API?", intent: "final" }, 2_800);
  h.end(5_000);
  await recorder.settled();
  const [transcript, started] = h.saved[0].lines;
  assert.equal(transcript.heardAt, iso(T0 + 1_250));
  assert.equal(transcript.at, iso(T0 + 2_750));
  assert.equal(started.at, iso(T0 + 2_800));
  recorder.dispose();
});

test("recorder: frames before the session is active, and after it ended, are not recorded", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  h.say("Before any session.", 100);
  h.at(200);
  h.lifecycle.send("START");
  h.say("While launching.", 300);
  h.lifecycle.send("LAUNCHED");
  h.say("Live.", 400);
  h.end(500);
  h.say("After the end.", 600);
  await recorder.settled();
  assert.deepEqual(h.saved[0].lines.map((line) => line.text), ["Live."]);
  recorder.dispose();
});

test("recorder: only the relay channel is read; other broadcasts are ignored", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  h.begin(0);
  h.bus.broadcast(IPC.SPEECH_TRANSCRIPT_RECEIVED, { text: "duplicate of the relay", final: true, role: "prospect" });
  h.bus.broadcast(IPC.SPEECH_REALTIME_FRAME_RECEIVED, "{not json");
  h.bus.broadcast(IPC.SPEECH_REALTIME_FRAME_RECEIVED, { v: 1, type: "transcript", seq: 77, data: { text: "An object payload works too.", final: true, role: "rep" } });
  h.end(1_000);
  await recorder.settled();
  assert.deepEqual(h.saved[0].lines.map((line) => line.text), ["An object payload works too."]);
  recorder.dispose();
});

test("recorder: the end reason comes from the END transition; quit and remote are kept", async () => {
  const { createRecapRecorder } = await load();
  for (const reason of ["user", "remote", "quit"]) {
    const h = harness();
    const recorder = createRecapRecorder(h.options);
    h.begin(0);
    h.say("Hello?", 10);
    h.end(20, reason);
    await recorder.settled();
    assert.equal(h.saved[0].endReason, reason);
    recorder.dispose();
  }
});

test("recorder: a connection failure finishes the recap with endReason failed", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  h.begin(0);
  h.say("Can you hear me?", 1_000);
  h.at(2_000);
  h.lifecycle.send("CONNECTION_FAILED", { reason: "transport failed" });
  assert.equal(h.lifecycle.getState(), SESSION_STATES.FAILED);
  await recorder.settled();
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].endReason, "failed");
  assert.equal(h.saved[0].endedAt, iso(T0 + 2_000));
  recorder.dispose();
});

test("recorder: it finishes on the terminal event, so finals flushed while ending are kept", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  h.begin(0);
  h.at(1_000);
  h.lifecycle.send("END", { reason: "user" });
  // stopSpeech() finalizes the streams: the last final lands during `ending`.
  h.say("Last words.", 1_200);
  assert.equal(h.saved.length, 0, "nothing is saved while ending");
  h.at(1_500);
  h.lifecycle.send("ENDED");
  await recorder.settled();
  assert.deepEqual(h.saved[0].lines.map((line) => line.text), ["Last words."]);
  assert.equal(h.saved[0].endedAt, iso(T0 + 1_500));
  recorder.dispose();
});

test("recorder: a launch that never went active records nothing", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  h.at(0);
  h.lifecycle.send("START");
  h.lifecycle.send("LAUNCH_FAILED", { reason: "no server" });
  h.lifecycle.send("START");
  h.lifecycle.send("END", { reason: "user" });
  h.lifecycle.send("ENDED");
  await recorder.settled();
  assert.equal(h.saved.length, 0);
  assert.equal(h.ready.length, 0);
  recorder.dispose();
});

test("recorder: with the setting off at session start nothing is recorded or saved", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  h.flags.enabled = false;
  const recorder = createRecapRecorder(h.options);
  h.begin(0);
  assert.equal(recorder.recording(), false);
  h.say("Not recorded.", 10);
  h.end(20);
  await recorder.settled();
  assert.equal(h.saved.length, 0);
  assert.equal(h.ready.length, 0);
  recorder.dispose();
});

test("recorder: the setting is read at session start; turning it off mid-call keeps this recap", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  h.begin(0);
  h.flags.enabled = false;
  h.say("Still recorded.", 10);
  h.end(20);
  await recorder.settled();
  assert.equal(h.saved.length, 1);
  recorder.dispose();
});

test("recorder: frames while practice is active are left out; the live session around it is kept", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  h.begin(0);
  h.say("Before practice.", 500);
  // practice:start on a live session does not restart it; practice:end does not end it.
  h.flags.practice = true;
  h.say("How would you shard it?", 1_000);
  h.wire("turn.started", { turn_id: "p1", question: "How would you shard it?", intent: "final" }, 1_100);
  h.flags.practice = false;
  h.say("After practice.", 2_000);
  h.end(3_000);
  await recorder.settled();
  assert.equal(h.saved.length, 1);
  assert.deepEqual(h.saved[0].lines.map((line) => line.text ?? line.type), ["Before practice.", "After practice."]);
  assert.deepEqual(h.saved[0].turns, []);
  recorder.dispose();
});

test("recorder: a session that was only ever practice has nothing left and is not saved", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  // practice:start from a cold app calls startSession() first, so practice is not active at launch.
  h.begin(0);
  h.flags.practice = true;
  h.say("How would you shard it?", 1_000);
  h.end(2_000);
  await recorder.settled();
  assert.equal(h.saved.length, 0);
  assert.equal(h.ready.length, 0);
  recorder.dispose();
});

test("recorder: a session with nothing said and no answers is not saved", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  h.begin(0);
  h.wire("transcription.state", { state: "live", stream_id: "prospect" }, 10);
  h.end(5_000);
  await recorder.settled();
  assert.equal(h.saved.length, 0);
  assert.equal(h.ready.length, 0);
  recorder.dispose();
});

test("recorder: each session gets a fresh timeline and its own id", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  h.begin(0);
  h.say("First call.", 10);
  h.end(20);
  h.flags.sessionId = "session-2";
  h.begin(1_000);
  h.say("Second call.", 1_010);
  h.end(1_020);
  await recorder.settled();
  assert.deepEqual(h.saved.map((recap) => [recap.id, recap.lines.map((line) => line.text)]), [
    ["session-1", ["First call."]],
    ["session-2", ["Second call."]],
  ]);
  assert.equal(h.saved[1].lines[0].offsetMs, 10, "offsets restart per session");
  recorder.dispose();
});

test("recorder: a missing session id still gets a safe, unique recap id", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  h.flags.sessionId = null;
  const recorder = createRecapRecorder(h.options);
  h.begin(0);
  h.say("Hi.", 10);
  h.end(20);
  await recorder.settled();
  assert.match(h.saved[0].id, /^session-[A-Za-z0-9_-]+$/);
  recorder.dispose();
});

test("recorder: a failed save is reported, logged and never thrown", async () => {
  const { createRecapRecorder } = await load();
  const h = harness({
    save: async () => {
      throw Object.assign(new Error("Couldn't save the session recap."), { code: "E_RECAP_SAVE" });
    },
  });
  const recorder = createRecapRecorder(h.options);
  h.begin(0);
  h.say("Hello.", 10);
  h.end(20);
  await assert.doesNotReject(recorder.settled());
  assert.equal(h.ready.length, 1);
  assert.equal(h.ready[0].saveError, "Couldn't save the session recap.");
  assert.equal(h.ready[0].summary, null);
  assert.equal(h.ready[0].recap.lines.length, 1, "the unsaved recap is handed over so main can still show it");
  assert.ok(h.logs.some((entry) => entry.type === "recap.save_failed"));
  recorder.dispose();
});

test("recorder: settled() waits for a slow save (the quit path awaits it)", async () => {
  const { createRecapRecorder } = await load();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let finished = false;
  const h = harness({
    save: async (recap) => {
      await gate;
      finished = true;
      return { id: recap.id };
    },
  });
  const recorder = createRecapRecorder(h.options);
  assert.equal(await Promise.race([recorder.settled().then(() => "settled"), tick().then(() => "pending")]), "settled", "idle settles at once");
  h.begin(0);
  h.say("Bye.", 10);
  h.end(20, "quit");
  const pending = recorder.settled();
  assert.equal(await Promise.race([pending.then(() => "settled"), tick().then(() => "pending")]), "pending");
  release();
  await pending;
  assert.equal(finished, true);
  assert.equal(h.saved.length, 0, "the harness save was replaced");
  recorder.dispose();
});

test("recorder: a throwing onSaved or isPractice never breaks the lifecycle or the bus", async () => {
  const { createRecapRecorder } = await load();
  const h = harness({
    onSaved: () => {
      throw new Error("listener broke");
    },
  });
  const recorder = createRecapRecorder(h.options);
  h.begin(0);
  h.flags.practice = () => {
    throw new Error("practice probe broke");
  };
  h.say("Still fine.", 10);
  h.end(20);
  await assert.doesNotReject(recorder.settled());
  assert.equal(h.lifecycle.getState(), SESSION_STATES.ENDED);
  const delivered = h.bus.broadcast("any:channel", { ok: true });
  assert.equal(delivered.ok, true);
  recorder.dispose();
});

test("recorder: dispose unsubscribes from the lifecycle and the bus", async () => {
  const { createRecapRecorder } = await load();
  const h = harness();
  const recorder = createRecapRecorder(h.options);
  recorder.dispose();
  h.begin(0);
  h.say("Nobody is listening.", 10);
  h.end(20);
  await recorder.settled();
  assert.equal(recorder.recording(), false);
  assert.equal(h.saved.length, 0);
});
