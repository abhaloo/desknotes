/**
 * Capture-on recovery, pure so it is tested without a DOM.
 *
 * The capture checkbox is the window's only listening control, so turning it on
 * has to work from every state. A live session only needs `speech:start`, while
 * a window that booted without one (auto-start off, COPILOT_AUTOSTART=0, a
 * refused REALTIME_URL, settings that could not be read) used to dead-end at
 * E_NOT_ACTIVE ("no realtime session is open") with no way back in the app.
 * Opening the session is the renderer's job: the checkbox is a real recovery
 * path, not a status light.
 *
 * A command callback resolves with the command's value, or null when the call
 * failed (the renderer has already reported the reason).
 */

/** Lifecycle states that already hold a transport - or are opening one. */
const SESSION_LIVE_STATES = new Set(["launching", "active", "ending"]);

export function sessionIsLive(lifecycle) {
  return SESSION_LIVE_STATES.has(lifecycle);
}

/**
 * Turn listening on: open a session when there is none, then start capture.
 * @returns the speech result, or null when nothing could be started.
 */
export async function startListening({ lifecycle, startSession, startSpeech }) {
  if (!sessionIsLive(lifecycle)) {
    const opened = await startSession();
    if (!opened) return null;
  }
  return startSpeech();
}

/**
 * One checkbox change. The checkbox also carries the app-open preference, so
 * what main accepted is what gets persisted - never a failed attempt.
 * @returns {{ capture: boolean, applied: boolean }} the real capture state and
 *   whether main accepted the command.
 */
export async function applyCaptureToggle({ lifecycle, checked, startSession, startSpeech, stopSpeech, saveAutoStart }) {
  if (!checked) {
    const stopped = await stopSpeech();
    if (!stopped) return { capture: true, applied: false }; // refused: capture is still on
    await saveAutoStart(false);
    return { capture: false, applied: true };
  }
  const started = await startListening({ lifecycle, startSession, startSpeech });
  if (!started) return { capture: false, applied: false };
  await saveAutoStart(true);
  return { capture: Array.isArray(started.sources) ? started.sources.length > 0 : true, applied: true };
}
