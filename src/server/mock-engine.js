/**
 * Mock engine for the realtime server. Deterministic: every output is derived
 * from the audio sample count, so tests can assert exact frame sequences
 * without wall-clock timing (latency work belongs in the real pipeline).
 *
 * It is also the fallback engine when the answer pipeline is unavailable, so
 * it must never throw on malformed input.
 */

/** Interim transcripts fire at most every 500 ms of audio (16 kHz mono). */
const INTERIM_INTERVAL_SAMPLES = 8_000;

const CAPABILITY_LIST = ["screen_analyse", "answer_request", "replay", "session_commands"];

const streamSource = (streamIdx) => (streamIdx === 0 ? "mic" : "system");
const streamRole = (streamIdx) => (streamIdx === 0 ? "rep" : "prospect");

/** Split text into `parts` near-equal chunks; join(chunks) === text. */
function splitEvenly(text, parts) {
  const out = [];
  let start = 0;
  let remaining = text.length;
  let remainingParts = parts;
  for (let i = 0; i < parts; i += 1) {
    const take = remainingParts <= 1 ? remaining : Math.ceil(remaining / remainingParts);
    out.push(text.slice(start, start + take));
    start += take;
    remaining -= take;
    remainingParts -= 1;
  }
  return out;
}

export function createMockEngine({ emit = () => {} } = {}) {
  const state = {
    sessionId: null,
    pendingSamples: { 0: 0, 1: 0 },
    lastSeq: { 0: 0, 1: 0 },
    interimCount: { 0: 0, 1: 0 },
    answerCount: 0,
    sayCount: 0,
    disposed: false,
  };

  return {
    onSessionStart({ sessionId } = {}) {
      state.sessionId = sessionId ?? null;
      // Canned capability announcement mirrors a real server build.
      emit({
        type: "session.state",
        data: { capabilities: [...CAPABILITY_LIST], session_id: state.sessionId },
      });
    },

    onAudio({ streamIdx, seq, pcm16 } = {}) {
      const idx = streamIdx === 1 ? 1 : 0;
      const samples = pcm16?.length ?? 0;
      state.lastSeq[idx] = seq ?? state.lastSeq[idx];
      state.pendingSamples[idx] += samples;
      if (state.pendingSamples[idx] < INTERIM_INTERVAL_SAMPLES) return;
      state.pendingSamples[idx] = 0;
      state.interimCount[idx] += 1;
      emit({
        type: "transcript",
        data: {
          text: `mock interim ${state.interimCount[idx]}`,
          final: false,
          role: streamRole(idx),
          source: streamSource(idx),
          stream: idx,
          seq: state.lastSeq[idx],
        },
      });
    },

    onFinalize({ streamIdx } = {}) {
      const idx = streamIdx === 1 ? 1 : 0;
      state.pendingSamples[idx] = 0;
      const text = `mock final ${state.interimCount[idx] + 1}`;
      emit({
        type: "transcript",
        data: {
          text,
          final: true,
          role: streamRole(idx),
          source: streamSource(idx),
          stream: idx,
          seq: state.lastSeq[idx],
        },
      });
      // Prospect speech is also echoed into the "say" lane so the overlay
      // can render the coach/other-party lane without a second pipeline.
      if (streamRole(idx) === "prospect") {
        state.sayCount += 1;
        emit({ type: "say", data: { text, say_id: `say_${state.sayCount}` } });
      }
    },

    onAnswerRequest({ utterance, gateSeq } = {}) {
      const text = String(utterance ?? "").trim() || "mock answer";
      const parts = 3 + (text.length % 3); // 3..5 deltas, deterministic
      const chunks = splitEvenly(text, parts);
      state.answerCount += 1;
      const turnId = `t_${state.answerCount}`;
      // The gate announces the decision and the turn opens with
      // `gate_seq` on the first frame, then tokens stream.
      if (gateSeq != null) {
        emit({
          type: "gate.verdict",
          data: { gate_seq: gateSeq, verdict: "answer", turn_id: turnId },
        });
      }
      emit({
        type: "turn.started",
        data: {
          turn_id: turnId,
          intent: "answer_request",
          ...(gateSeq != null ? { gate_seq: gateSeq } : {}),
        },
      });
      for (const chunk of chunks) {
        emit({ type: "turn.token", data: { turn_id: turnId, delta: chunk } });
      }
      emit({
        type: "turn.done",
        data: {
          turn_id: turnId,
          text: chunks.join(""),
          ...(gateSeq != null ? { gate_seq: gateSeq } : {}),
        },
      });
    },

    onScreenAnalyse(request = {}) {
      return Promise.resolve({
        command_id: request.commandId ?? null,
        status: "ok",
        kind: "other",
        dedup: false,
        solve: "mock solution",
      });
    },

    onSessionEnd() {
      emit({ type: "session.ended", data: { reason: "session_end" } });
    },

    dispose() {
      state.disposed = true;
    },
  };
}
