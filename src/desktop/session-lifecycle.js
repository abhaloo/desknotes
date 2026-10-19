/**
 * Pure session state machine for the desktop shell.
 *
 * WHY pure: the shell must stay unit-testable with `bun test` even when
 * Electron is absent, so this file never imports `electron` and takes its
 * timers as an injected dependency (tests fire watchdogs deterministically).
 *
 * States: idle -> launching -> active -> ending -> ended | failed
 *
 * Watchdogs matter because the shell owns the user's UI: if `launching` or
 * `ending` never resolves (hung transport, dropped teardown ack) the overlay
 * would be stuck forever, so both phases expire into `failed`, which the UI can
 * surface and `RETRY` can leave in one step.
 */

export const SESSION_STATES = Object.freeze({
  IDLE: "idle",
  LAUNCHING: "launching",
  ACTIVE: "active",
  ENDING: "ending",
  ENDED: "ended",
  FAILED: "failed",
});

export const SESSION_EVENTS = Object.freeze([
  "START",
  "LAUNCHED",
  "LAUNCH_FAILED",
  "CONNECTION_FAILED",
  "END",
  "ENDED",
  "RETRY",
]);

/** Public event -> next state. Anything missing here is a no-op. */
const TRANSITIONS = Object.freeze({
  [SESSION_STATES.IDLE]: {
    START: SESSION_STATES.LAUNCHING,
    RETRY: SESSION_STATES.LAUNCHING,
  },
  [SESSION_STATES.LAUNCHING]: {
    LAUNCHED: SESSION_STATES.ACTIVE,
    LAUNCH_FAILED: SESSION_STATES.FAILED,
    CONNECTION_FAILED: SESSION_STATES.FAILED,
    // Cancel during launch: teardown still needs to complete, so route through
    // `ending` and let the caller confirm with ENDED.
    END: SESSION_STATES.ENDING,
  },
  [SESSION_STATES.ACTIVE]: {
    END: SESSION_STATES.ENDING,
    CONNECTION_FAILED: SESSION_STATES.FAILED,
  },
  [SESSION_STATES.ENDING]: {
    ENDED: SESSION_STATES.ENDED,
  },
  [SESSION_STATES.ENDED]: {
    START: SESSION_STATES.LAUNCHING,
    RETRY: SESSION_STATES.LAUNCHING,
  },
  [SESSION_STATES.FAILED]: {
    START: SESSION_STATES.LAUNCHING,
    RETRY: SESSION_STATES.LAUNCHING,
  },
});

const WATCHDOG_MS = Object.freeze({
  [SESSION_STATES.LAUNCHING]: 30_000,
  [SESSION_STATES.ENDING]: 30_000,
});

const defaultTimers = Object.freeze({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
});

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class SessionLifecycle {
  #state = SESSION_STATES.IDLE;
  #previous = SESSION_STATES.IDLE;
  #event = null;
  #reason = null;
  #error = null;
  #since;
  #transitions = 0;
  #listeners = new Set();
  #timers;
  #now;
  #watchdog = null;
  #watchdogMs;
  #disposed = false;

  constructor({
    launchingTimeoutMs = WATCHDOG_MS[SESSION_STATES.LAUNCHING],
    endingTimeoutMs = WATCHDOG_MS[SESSION_STATES.ENDING],
    timers = defaultTimers,
    now = () => Date.now(),
  } = {}) {
    this.#watchdogMs = Object.freeze({
      [SESSION_STATES.LAUNCHING]: launchingTimeoutMs,
      [SESSION_STATES.ENDING]: endingTimeoutMs,
    });
    this.#timers = timers;
    this.#now = now;
    this.#since = now();
  }

  get state() {
    return this.#state;
  }

  getState() {
    return this.#state;
  }

  /** Fresh snapshot: callers cannot corrupt machine state by mutating it. */
  getSnapshot() {
    return {
      state: this.#state,
      previous: this.#previous,
      event: this.#event,
      reason: this.#reason,
      error: this.#error,
      since: this.#since,
      transitions: this.#transitions,
    };
  }

  /** @returns {() => void} unsubscribe */
  subscribe(listener) {
    if (typeof listener !== "function") {
      throw codedError("E_LISTENER", "subscribe(listener) requires a function");
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * @param {string} event one of SESSION_EVENTS
   * @param {{reason?: string, error?: unknown}} [payload]
   * @returns {{ok: boolean, state: string, event: string, reason?: string}}
   */
  send(event, payload = {}) {
    if (typeof event !== "string") {
      return { ok: false, state: this.#state, event: String(event), reason: "invalid-event" };
    }
    if (this.#disposed) {
      return { ok: false, state: this.#state, event, reason: "disposed" };
    }
    const table = TRANSITIONS[this.#state];
    if (!table || !Object.hasOwn(table, event)) {
      return { ok: false, state: this.#state, event, reason: "ignored" };
    }
    this.#enter(table[event], {
      event,
      reason: typeof payload.reason === "string" ? payload.reason : null,
      error: payload.error ?? null,
    });
    return { ok: true, state: this.#state, event };
  }

  /** Clears the active watchdog and stops emitting. */
  dispose() {
    this.#disposed = true;
    this.#clearWatchdog();
    this.#listeners.clear();
  }

  #enter(nextState, { event, reason, error }) {
    const left = this.#state;
    this.#clearWatchdog();
    this.#previous = left;
    this.#state = nextState;
    this.#event = event;
    // Keep a fault reason sticky across `failed` so the UI can explain it;
    // recovery transitions (launching) clear stale faults.
    this.#reason = nextState === SESSION_STATES.FAILED ? reason ?? event : reason ?? null;
    this.#error = nextState === SESSION_STATES.FAILED ? error : null;
    this.#since = this.#now();
    this.#transitions += 1;
    if (WATCHDOG_MS[nextState] !== undefined || this.#watchdogMs[nextState] !== undefined) {
      this.#armWatchdog(nextState);
    }
    this.#notify();
  }

  #armWatchdog(state) {
    const ms = this.#watchdogMs[state];
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.#watchdog = this.#timers.setTimeout(() => {
      this.#watchdog = null;
      // A watchdog is an internal transition: none of the 7 public events
      // should carry "timed out" meaning, but the failure must latch.
      if (this.#state !== state) return;
      this.#previous = this.#state;
      this.#state = SESSION_STATES.FAILED;
      this.#event = "WATCHDOG";
      this.#reason = `watchdog:${state}`;
      this.#error = codedError("E_TIMEOUT", `session stuck in ${state} for ${ms} ms`);
      this.#since = this.#now();
      this.#transitions += 1;
      this.#notify();
    }, ms);
  }

  #clearWatchdog() {
    if (this.#watchdog !== null) {
      this.#timers.clearTimeout(this.#watchdog);
      this.#watchdog = null;
    }
  }

  #notify() {
    const snapshot = this.getSnapshot();
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A broken observer (renderer bridge, logger) must never wedge the
        // machine: transitions are the source of truth, not listeners.
      }
    }
  }
}
