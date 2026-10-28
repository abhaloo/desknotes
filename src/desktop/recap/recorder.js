/**
 * Session recap recorder: subscribes itself, so the call path knows nothing
 * about recaps.
 *
 * - Frames come from the gateway bus main already relays every raw wire
 *   frame on (`speech:realtime-frame:received`); the bus stamps each message
 *   with the time main received it, which is the timestamp of every line.
 * - The session lifecycle says when: a timeline opens when the session goes
 *   launching -> active (the setting is read once, there), and it finishes on
 *   ONE lifecycle event, the terminal state (ended or failed), when no further
 *   frame can arrive. Finishing on `ending` would lose the finals the server
 *   still flushes while speech stops.
 * - Frames that arrive while practice is active are left out; the live call
 *   around a practice run is the more valuable recap and is kept. A session
 *   with nothing left in it is not saved.
 *
 * Saving is `save(recap)` (the store, injected); the outcome reaches main
 * through `onSaved` so it can announce `recap:ready`. settled() waits for
 * every pending save: the quit path awaits it before the app exits.
 * Nothing here may throw into the lifecycle or the bus.
 */
import { randomUUID } from "node:crypto";
import { IPC } from "../ipc-gateway.js";
import { SESSION_STATES } from "../session-lifecycle.js";
import { buildRecap } from "./build.js";
import { createRecapTimeline } from "./timeline.js";

/**
 * @param {{ lifecycle: { subscribe: Function }, bus: { subscribe: Function },
 *   isEnabled: () => boolean, isPractice: () => boolean, sessionId: () => string|null,
 *   save: (recap: object) => Promise<object>, onSaved?: Function, log?: Function,
 *   limits?: object }} options
 * @returns {{ recording: () => boolean, settled: () => Promise<void>, dispose: () => void }}
 */
export function createRecapRecorder({ lifecycle, bus, isEnabled, isPractice, sessionId, save, onSaved, log, limits } = {}) {
  const logger = typeof log === "function" ? log : () => {};
  let timeline = null;
  /** The END transition's reason ("user" | "remote" | "quit"), kept until ENDED. */
  let endReason = null;
  const pending = new Set();

  function note(entry) {
    try {
      logger(entry);
    } catch {
      /* the log hook must not turn a contained failure into a throw */
    }
  }

  function enabled() {
    try {
      return isEnabled() === true;
    } catch (error) {
      note({ type: "recap.error", message: String(error?.message ?? error) });
      return false;
    }
  }

  /** A broken probe reads as "not practice": the live recap is the one worth keeping. */
  function practice() {
    try {
      return isPractice() === true;
    } catch {
      return false;
    }
  }

  function recapId() {
    try {
      const id = sessionId();
      if (typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id)) return id;
    } catch {
      /* fall through to a fresh id */
    }
    return `session-${randomUUID()}`;
  }

  function open(snapshot) {
    if (!enabled()) return;
    timeline = createRecapTimeline({ id: recapId(), startedAt: snapshot.since, limits, log: logger });
    endReason = null;
  }

  function close(snapshot) {
    const current = timeline;
    timeline = null;
    const reason = snapshot.state === SESSION_STATES.FAILED ? "failed" : endReason ?? "user";
    endReason = null;
    const record = current.finish({ endedAt: snapshot.since, reason });
    if (record.lines.length === 0 && record.turns.length === 0) return; // nothing happened: no recap
    const task = persist(buildRecap(record));
    pending.add(task);
    task.finally(() => pending.delete(task));
  }

  async function persist(recap) {
    let summary = null;
    let saveError = null;
    try {
      summary = await save(recap);
    } catch (error) {
      saveError = String(error?.message ?? error);
      note({ type: "recap.save_failed", id: recap.id, message: saveError });
    }
    try {
      onSaved?.({ id: recap.id, recap, summary, saveError });
    } catch (error) {
      note({ type: "recap.error", message: String(error?.message ?? error) });
    }
  }

  function onLifecycle(snapshot = {}) {
    try {
      if (snapshot.state === SESSION_STATES.ACTIVE && snapshot.previous === SESSION_STATES.LAUNCHING) {
        if (timeline) close(snapshot); // never expected; never lose what was recorded
        open(snapshot);
      } else if (snapshot.state === SESSION_STATES.ENDING) {
        if (timeline && typeof snapshot.reason === "string") endReason = snapshot.reason;
      } else if (snapshot.state === SESSION_STATES.ENDED || snapshot.state === SESSION_STATES.FAILED) {
        if (timeline) close(snapshot);
      }
    } catch (error) {
      note({ type: "recap.error", message: String(error?.message ?? error) });
    }
  }

  function onBus(message = {}) {
    try {
      if (!timeline || message.channel !== IPC.SPEECH_REALTIME_FRAME_RECEIVED) return;
      if (practice()) return;
      let frame = message.payload;
      if (typeof frame === "string") {
        try {
          frame = JSON.parse(frame);
        } catch {
          return;
        }
      }
      timeline.observe(frame, message.at);
    } catch (error) {
      note({ type: "recap.error", message: String(error?.message ?? error) });
    }
  }

  const offLifecycle = lifecycle.subscribe(onLifecycle);
  const offBus = bus.subscribe(onBus);

  return {
    recording: () => timeline !== null,
    /** Resolves once every save in flight has finished (never rejects). */
    settled: () => Promise.all([...pending]).then(() => undefined, () => undefined),
    dispose() {
      offLifecycle?.();
      offBus?.();
      timeline = null;
      endReason = null;
    },
  };
}
