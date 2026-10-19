/**
 * Server-side ASR engine: uplink PCM16 -> `transcript` frames.
 *
 * Interim cadence is the whole game for the prefetch pipeline: answers start
 * from partials, so the mock segmenter emits one every ~300 ms of active
 * speech instead of waiting for an utterance boundary. Finals close on
 * `finalize` (the client VAD already knows speech ended) or after 700 ms of
 * silence -- a lost `finalize` must not leave a segment open forever.
 *
 * `mock` is the default for an explicit demo. `mock-scripted` replays a fixed
 * transcript per stream. `openai-compatible` re-transcribes the accumulated
 * segment against a batch endpoint. Without live mode, a missing or rejected
 * provider falls back to the mock segmenter so session setup still starts.
 * Live mode never invents that transcript: it stays unconfigured until a real
 * recognition response succeeds, and an HTTP failure reports degraded until
 * the next successful response.
 */
import { PROTOCOL_VERSION, SAMPLE_RATE, STREAM } from "../../shared/protocol.js";
import { redactSecrets } from "../../security/url-policy.js";
import { unrefTimer } from "../../shared/timers.js";
import { checkProviderUrl, providerFetch, readJsonCapped } from "./provider-http.js";

const DEFAULT_INTERIM_MS = 300;
const DEFAULT_SILENCE_MS = 700;
const DEFAULT_ENERGY_FLOOR_DB = -50;
/** Watchdog period: no pushed audio at all still has to close a segment. */
const WATCHDOG_MS = 100;
const STT_FLUSH_MS = 1000;
const STT_TIMEOUT_MS = 20_000;

const SAFE_REASONS = new Set([
  "not_configured",
  "missing_provider",
  "missing_credentials",
  "missing_api_key",
  "missing_url",
  "mock_refused",
  "unknown_provider",
  "invalid_url",
  "unsupported_scheme",
  "credentials_in_url",
  "insecure_scheme",
  "stt_error",
]);

function safeReason(reason) {
  return typeof reason === "string" && SAFE_REASONS.has(reason) ? reason : undefined;
}

function safeLogMessage(err, secrets = []) {
  const raw = redactSecrets(String(err?.message ?? err), secrets);
  return raw.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]");
}

const STREAM_META = {
  [STREAM.MICROPHONE]: { role: "rep", source: "mic" },
  [STREAM.SYSTEM]: { role: "prospect", source: "system" },
};

/** Demo material: long enough that the >=8-word prefetch trigger is reachable. */
const MOCK_PHRASES = {
  [STREAM.MICROPHONE]:
    "We usually start with a two week pilot so your team can see the numbers before you commit",
  [STREAM.SYSTEM]:
    "How does your pricing work if we roll this out to about fifty sales reps",
};

export const DEFAULT_DEMO_SCRIPT = {
  [STREAM.MICROPHONE]: [
    "We usually start with a two week pilot so your team can see the numbers before you commit",
    "Most teams our size connect it to Salesforce in the first week",
  ],
  [STREAM.SYSTEM]: [
    "How does your pricing work if we roll this out to about fifty sales reps",
    "Do you integrate with Salesforce, and how long does the setup usually take",
  ],
};

/**
 * @param {{provider?: string, model?: string, baseUrl?: string, apiKey?: string,
 *   emit?: Function, onTranscript?: Function, log?: Function, script?: object,
 *   interimMs?: number, silenceMs?: number, energyFloorDb?: number,
 *   sampleRate?: number, mode?: "live"|"demo", allowMockFallback?: boolean,
 *   reason?: string}} [options]
 * @returns {{pushAudio: Function, finalize: Function, close: Function}}
 */
export function createAsr({
  provider = "mock",
  model,
  baseUrl,
  apiKey,
  emit,
  onTranscript,
  log,
  script,
  interimMs = DEFAULT_INTERIM_MS,
  silenceMs = DEFAULT_SILENCE_MS,
  energyFloorDb = DEFAULT_ENERGY_FLOOR_DB,
  sampleRate = SAMPLE_RATE,
  mode,
  allowMockFallback,
  reason,
  maxRequestsPerMinute,
  now = Date.now,
} = {}) {
  const warn = typeof log === "function" ? log : () => {};
  const transcriptHandlers = [];
  const seqByStream = new Map();
  // Segment bookkeeping for `segment_id` / `role_corrected`.
  const segmentByStream = new Map();
  let segmentSeq = 0;
  // Degradation latch for `transcription.state`.
  let pushBroken = false;
  let closed = false;

  const api = { pushAudio, finalize, close };
  // Non-enumerable so the frozen `{pushAudio, finalize, close}` surface stays
  // the enumerable contract while the pipeline can still tap transcripts and
  // re-route the outbound frame sink.
  Object.defineProperty(api, "emit", {
    value: typeof emit === "function" ? emit : () => {},
    writable: true,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(api, "onTranscript", {
    value(cb) {
      if (typeof cb !== "function") return () => {};
      transcriptHandlers.push(cb);
      return () => {
        const idx = transcriptHandlers.indexOf(cb);
        if (idx >= 0) transcriptHandlers.splice(idx, 1);
      };
    },
    writable: false,
    configurable: true,
    enumerable: false,
  });
  // Additive, non-enumerable like the taps above: request an interim covering
  // all audio so far (the pipeline calls it on a VAD end-of-turn hint).
  Object.defineProperty(api, "flushInterim", {
    value(streamIdx = STREAM.MICROPHONE) {
      if (closed) return false;
      try {
        return engine.flushInterim?.(streamIdx) ?? false;
      } catch (err) {
        warn({ type: "asr.flush_interim_error", message: safeLogMessage(err, [apiKey]) });
        return false;
      }
    },
    writable: false,
    configurable: true,
    enumerable: false,
  });
  if (typeof onTranscript === "function") transcriptHandlers.push(onTranscript);

  function emitTranscript(streamIdx, text, final, dropped = 0) {
    const meta =
      STREAM_META[streamIdx] ??
      { role: "unknown", source: streamIdx === STREAM.SYSTEM ? "system" : "mic" };
    const seq = seqByStream.get(streamIdx) ?? 0;
    seqByStream.set(streamIdx, seq + 1);
    // Segment identity: one ASR segment = one utterance. `segment_id`
    // is stable across the interims and closes with the final.
    let seg = segmentByStream.get(streamIdx);
    if (!seg) {
      seg = { id: `seg_${streamIdx}_${++segmentSeq}`, role: "unknown" };
      segmentByStream.set(streamIdx, seg);
    }
    // Protocol shape: interim/final transcripts share one frame type; clients
    // use `final:false` for the speaking indicator and the prefetch trigger.
    const data = {
      text,
      final,
      role: meta.role,
      source: meta.source,
      stream: streamIdx,
      seq,
      segment_id: seg.id,
    };
    // `role_corrected`: diarization revised this segment's speaker
    // after earlier frames shipped under the previous role (interims may
    // carry `unknown` until the final resolves it).
    if (final && seg.role !== meta.role) data.role_corrected = true;
    if (final) seg.role = meta.role;
    // Coalesced interim updates since the previous frame:
    // the ASR saw newer recognition state but the rate limit merged it away.
    if (dropped > 0) data.dropped = dropped;
    try {
      api.emit({ v: PROTOCOL_VERSION, type: "transcript", data });
    } catch (err) {
      warn({ type: "asr.emit_error", message: String(err?.message ?? err) });
    }
    for (const cb of transcriptHandlers) {
      try {
        cb(data);
      } catch (err) {
        warn({ type: "asr.transcript_listener_error", message: String(err?.message ?? err) });
      }
    }
    if (final) segmentByStream.delete(streamIdx);
  }

  /** ASR readiness signal. `status` and `state` carry the same value.
   * HTTP recovery to `live` happens only after a successful recognition. */
  function emitTranscriptionState(status, streamIdx, extra = {}) {
    const streamId = STREAM_META[streamIdx]?.source ?? String(streamIdx);
    const data = { state: status, status, stream_id: streamId };
    const resolvedMode = extra.mode ?? (mode === "live" || mode === "demo" ? mode : undefined);
    if (resolvedMode === "live" || resolvedMode === "demo") data.mode = resolvedMode;
    if (extra.provider === "mock" || extra.provider === "unconfigured" || extra.provider === "openai-compatible") {
      data.provider = extra.provider;
    }
    const coded = safeReason(extra.reason);
    if (coded) data.reason = coded;
    if (typeof extra.configured === "boolean") data.configured = extra.configured;
    try {
      api.emit({ v: PROTOCOL_VERSION, type: "transcription.state", data });
    } catch (err) {
      warn({ type: "asr.emit_error", message: safeLogMessage(err, [apiKey]) });
    }
  }

  const decision = resolveProvider({ provider, baseUrl, apiKey, warn, model, mode, allowMockFallback, reason });
  // Additive, non-enumerable: a batch endpoint transcribes the whole segment
  // per request, so its interims arrive about STT_FLUSH_MS apart (the
  // pipeline's prefetch rule reads this).
  Object.defineProperty(api, "batch", {
    value: decision.kind === "openai-compatible",
    writable: false,
    configurable: true,
    enumerable: false,
  });
  const recoverOnPush = decision.kind === "mock" || decision.kind === "mock-scripted";
  const engine =
    decision.kind === "openai-compatible"
      ? createHttpSttEngine({
          baseUrl,
          apiKey,
          model,
          emitTranscript,
          warn,
          sampleRate,
          silenceMs,
          maxRequestsPerMinute,
          now,
          onStatus(status, streamIdx, extra = {}) {
            if (status === "degraded") pushBroken = true;
            if (status === "live") pushBroken = false;
            emitTranscriptionState(status, streamIdx, { provider: "openai-compatible", mode, ...extra });
          },
        })
      : decision.kind === "unconfigured"
        ? createUnconfiguredEngine({
            reason: decision.reason,
            emitState(streamIdx) {
              emitTranscriptionState("unconfigured", streamIdx, {
                reason: decision.reason,
                provider: "unconfigured",
                configured: false,
                mode: mode === "demo" ? "demo" : "live",
              });
            },
          })
        : createMockSegmenter({
            scripted: decision.kind === "mock-scripted",
            script,
            emitTranscript,
            warn,
            sampleRate,
            interimMs,
            silenceMs,
            energyFloorDb,
          });
  if (decision.kind === "mock" || decision.kind === "mock-scripted") {
    if (mode === "demo") {
      emitTranscriptionState("demo", STREAM.MICROPHONE, { mode: "demo", provider: "mock" });
    }
  }

  function pushAudio(audio = {}) {
    if (closed) return;
    try {
      engine.pushAudio(audio);
      if (recoverOnPush && pushBroken) {
        // A later mock push succeeded. HTTP ASR does not use this path:
        // it reports live only from a successful recognition response.
        pushBroken = false;
        emitTranscriptionState("live", audio.streamIdx ?? STREAM.MICROPHONE);
      }
    } catch (err) {
      warn({ type: "asr.push_error", message: safeLogMessage(err, [apiKey]) });
      if (!pushBroken) {
        // The stream's ASR is not transcribing; surface it instead of
        // silently dropping audio.
        pushBroken = true;
        emitTranscriptionState("degraded", audio.streamIdx ?? STREAM.MICROPHONE);
      }
    }
  }

  function finalize(streamIdx = STREAM.MICROPHONE) {
    if (closed) return false;
    try {
      return engine.finalize(streamIdx);
    } catch (err) {
      warn({ type: "asr.finalize_error", message: String(err?.message ?? err) });
      return false;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      engine.close();
    } catch {
      /* best effort shutdown */
    }
  }

  return api;
}

function resolveProvider({ provider, baseUrl, apiKey, warn, model, mode, allowMockFallback, reason }) {
  const refuseMock = mode === "live" || (mode !== "demo" && allowMockFallback === false);
  if (provider === "unconfigured") {
    const coded = safeReason(reason) ?? "not_configured";
    warn({ type: "asr.unconfigured", reason: coded });
    return { kind: "unconfigured", reason: coded };
  }
  if (provider === "mock" || provider === "mock-scripted") {
    if (refuseMock) {
      warn({ type: "asr.unconfigured", provider, reason: "mock_refused" });
      return { kind: "unconfigured", reason: "mock_refused" };
    }
    return { kind: provider };
  }
  if (provider === "openai-compatible") {
    // Without live mode, a setup problem still starts the session on the
    // mock segmenter. Live mode stays unconfigured and invents no words.
    if (baseUrl && apiKey && typeof globalThis.fetch === "function") {
      // Call audio and the bearer key never cross a plaintext hop (https, or
      // http to loopback only). The reason is logged, never the URL.
      const endpoint = checkProviderUrl(baseUrl);
      if (endpoint.ok) return { kind: "openai-compatible" };
      warn({ type: "asr.provider_insecure_url", provider, model, reason: endpoint.reason });
      if (refuseMock) return { kind: "unconfigured", reason: safeReason(endpoint.reason) ?? "invalid_url" };
      return { kind: "mock" };
    }
    warn({ type: "asr.provider_unconfigured", provider, model });
    if (refuseMock) return { kind: "unconfigured", reason: "missing_credentials" };
    return { kind: "mock" };
  }
  warn({ type: "asr.provider_unknown", provider });
  if (refuseMock) return { kind: "unconfigured", reason: "unknown_provider" };
  return { kind: "mock" };
}

function createUnconfiguredEngine({ reason, emitState }) {
  const seen = new Set();
  function announce(streamIdx = STREAM.MICROPHONE) {
    const idx = streamIdx ?? STREAM.MICROPHONE;
    if (seen.has(idx)) return;
    seen.add(idx);
    emitState(idx, reason);
  }
  announce(STREAM.MICROPHONE);
  return {
    pushAudio(audio = {}) {
      announce(audio.streamIdx ?? STREAM.MICROPHONE);
    },
    finalize() {
      return false;
    },
    flushInterim() {
      return false;
    },
    close() {},
  };
}

/* ------------------------------------------------------------------ mock -- */

function createMockSegmenter({
  scripted,
  script,
  emitTranscript,
  warn,
  sampleRate,
  interimMs,
  silenceMs,
  energyFloorDb,
}) {
  const interimSamples = Math.max(1, Math.round((sampleRate * interimMs) / 1000));
  const silenceLimitSamples = Math.max(1, Math.round((sampleRate * silenceMs) / 1000));
  const streams = new Map();
  let closed = false;

  function state(streamIdx) {
    let s = streams.get(streamIdx);
    if (!s) {
      s = {
        active: false,
        activeSamples: 0,
        interimSamples: 0,
        silentSamples: 0,
        lastAudioWall: 0,
        segIndex: 0,
        lastText: "",
      };
      streams.set(streamIdx, s);
    }
    return s;
  }

  function entryFor(streamIdx, s) {
    if (!scripted) return null;
    const list =
      script?.[streamIdx] ??
      script?.[String(streamIdx)] ??
      DEFAULT_DEMO_SCRIPT[streamIdx] ??
      DEFAULT_DEMO_SCRIPT[STREAM.MICROPHONE];
    return Array.isArray(list) && list.length > 0 ? list[s.segIndex % list.length] : null;
  }

  function phraseFor(streamIdx, s) {
    const entry = entryFor(streamIdx, s);
    if (entry != null) return typeof entry === "string" ? entry : String(entry?.text ?? "");
    return MOCK_PHRASES[streamIdx] ?? MOCK_PHRASES[STREAM.MICROPHONE];
  }

  /** `{interim, text}` entries model a revising ASR: interims follow `interim`, the final is `text`. */
  function interimPhraseFor(streamIdx, s) {
    const entry = entryFor(streamIdx, s);
    if (entry && typeof entry === "object" && typeof entry.interim === "string" && entry.interim.trim()) {
      return entry.interim;
    }
    return phraseFor(streamIdx, s);
  }

  function interimText(streamIdx, s) {
    const phrase = interimPhraseFor(streamIdx, s);
    const words = phrase.split(/\s+/);
    // Scripted replay may finish the utterance before `finalize`; growth is
    // driven by audio time so demos behave the same at any push cadence.
    const count = Math.max(1, Math.min(words.length, 1 + Math.floor(s.activeSamples / interimSamples)));
    return words.slice(0, count).join(" ");
  }

  function finalText(streamIdx, s) {
    if (scripted) return phraseFor(streamIdx, s);
    return interimText(streamIdx, s);
  }

  function closeSegment(streamIdx, s, reason) {
    const text = finalText(streamIdx, s);
    s.active = false;
    s.activeSamples = 0;
    s.interimSamples = 0;
    s.silentSamples = 0;
    s.lastText = "";
    if (scripted) s.segIndex += 1;
    if (text) emitTranscript(streamIdx, text, true, s.dropped ?? 0);
    s.dropped = 0;
    warn({ type: "asr.segment_closed", stream: streamIdx, reason });
  }

  function pushAudio({ streamIdx = STREAM.MICROPHONE, pcm16 } = {}) {
    if (closed) return;
    const samples = asInt16(pcm16);
    if (samples.length === 0) return;
    const s = state(streamIdx);
    const now = Date.now();
    const speech = scripted ? true : rmsDb(samples) > energyFloorDb;
    if (speech) {
      if (!s.active) {
        s.active = true;
        s.activeSamples = 0;
        s.interimSamples = 0;
        s.silentSamples = 0;
        s.lastText = "";
      }
      s.activeSamples += samples.length;
      s.interimSamples += samples.length;
      s.silentSamples = 0;
      s.lastAudioWall = now;
      while (s.interimSamples >= interimSamples) {
        s.interimSamples -= interimSamples;
        const text = interimText(streamIdx, s);
        // Re-emitting identical text would just restart the prefetch for no
        // reason; the last word is what the stability rule watches. The
        // coalesced update is counted and reported as `dropped`.
        if (text !== s.lastText) {
          s.lastText = text;
          emitTranscript(streamIdx, text, false, s.dropped ?? 0);
          s.dropped = 0;
        } else {
          s.dropped = (s.dropped ?? 0) + 1;
        }
      }
    } else if (s.active) {
      s.silentSamples += samples.length;
      s.lastAudioWall = now;
      if (s.silentSamples >= silenceLimitSamples) closeSegment(streamIdx, s, "silence");
    } else {
      s.lastAudioWall = now;
    }
  }

  function finalize(streamIdx) {
    const s = streams.get(streamIdx);
    if (!s || !s.active) return false;
    closeSegment(streamIdx, s, "finalize");
    return true;
  }

  // Covers "audio simply stops": the sample-based path only runs if silent
  // chunks keep arriving (VAD may just stop forwarding instead).
  const watchdog = setInterval(() => {
    if (closed) return;
    const now = Date.now();
    for (const [streamIdx, s] of streams) {
      if (s.active && now - s.lastAudioWall >= silenceMs) closeSegment(streamIdx, s, "silence_watchdog");
    }
  }, WATCHDOG_MS);
  unrefTimer(watchdog);

  function close() {
    closed = true;
    clearInterval(watchdog);
  }

  return { pushAudio, finalize, close };
}

/* ------------------------------------------------------- http stt (opt) -- */

/**
 * Batch STT endpoints have no streaming state, so the segment lives here: all
 * audio since the segment opened is kept and every request transcribes the
 * WHOLE segment so far. Interims are therefore cumulative (the prefetch rule
 * watches a growing question, not disjoint fragments) and the final covers
 * the full utterance, not just the tail since the last interim.
 */
const MAX_SEGMENT_MS = 30_000;
/**
 * A flush followed by a tail this short is reused as the final. The client VAD
 * finalizes two 32 ms frames after its pause hint, while speech that resumed
 * after the hint needs the full 24-frame hangover (about 770 ms) before the
 * segment can close, so a tail this short after a flush is hangover silence.
 */
const FLUSH_REUSE_MAX_MS = 300;

/**
 * Provider request budget over a sliding minute (Groq's Whisper allows 20).
 * Finals always go, and interims stop while only the reserve is left, so a
 * segment's final is never the request the provider rejects.
 */
function createRequestBudget(perMinute, now) {
  if (!(perMinute > 0)) return { limited: false, allowInterim: () => true, note() {} };
  const reserve = Math.max(2, Math.ceil(perMinute * 0.2));
  const sent = [];
  function prune() {
    const cutoff = now() - 60_000;
    while (sent.length > 0 && sent[0] <= cutoff) sent.shift();
  }
  return {
    limited: true,
    allowInterim() {
      prune();
      return sent.length < perMinute - reserve;
    },
    note() {
      sent.push(now());
    },
  };
}

function createHttpSttEngine({
  baseUrl,
  apiKey,
  model,
  emitTranscript,
  warn,
  sampleRate,
  silenceMs,
  maxRequestsPerMinute,
  now = Date.now,
  onStatus = () => {},
}) {
  onStatus("connecting", STREAM.MICROPHONE);
  const budget = createRequestBudget(maxRequestsPerMinute, now);
  const flushSamples = Math.round((sampleRate * STT_FLUSH_MS) / 1000);
  const maxSegmentSamples = Math.round((sampleRate * MAX_SEGMENT_MS) / 1000);
  const flushReuseSamples = Math.round((sampleRate * FLUSH_REUSE_MAX_MS) / 1000);
  const streams = new Map();
  let closed = false;
  let segmentGen = 0;

  function state(streamIdx) {
    let s = streams.get(streamIdx);
    if (!s) {
      s = {
        chain: Promise.resolve(),
        gen: 0, // 0 = no open segment
        chunks: [],
        samples: 0,
        sinceInterim: 0,
        interimInFlight: false,
        inflight: null, // the interim request on the wire: { gen, covered, flush, before, result }
        flushPending: false,
        dropped: 0,
        lastText: "",
        lastAudioWall: 0,
      };
      streams.set(streamIdx, s);
    }
    return s;
  }

  function enqueue(s, task, after = s.chain) {
    // Serialize per stream so an interim can never land after the final it
    // logically precedes.
    s.chain = after.then(task, task).catch(() => {});
  }

  function snapshot(s) {
    return concatInt16(s.chunks, s.samples);
  }

  /** @returns {boolean} whether an interim covering this audio will be requested */
  function scheduleInterim(streamIdx, s, { flush = false } = {}) {
    s.sinceInterim = 0;
    // On a budget, only the prospect's speech gets partials: they seed the
    // speculative answer. The rep's lane still gets every final.
    if (budget.limited && streamIdx !== STREAM.SYSTEM) return false;
    if (s.interimInFlight) {
      // Coalesce: the next request covers this audio anyway. A flush must
      // not be lost, though: it is sent as soon as the in-flight one lands.
      s.dropped += 1;
      if (flush) s.flushPending = true;
      return flush;
    }
    if (!budget.allowInterim()) {
      s.dropped += 1;
      return false;
    }
    budget.note();
    s.interimInFlight = true;
    const gen = s.gen;
    const audio = snapshot(s);
    const covered = s.samples;
    // If the segment closes while this request is out, closeSegment reuses it
    // or queues the final behind `before` (the chain it waited on), not behind it.
    const before = s.chain;
    let settle;
    const result = new Promise((resolve) => {
      settle = resolve;
    });
    const inflight = { gen, covered, flush, before, result };
    s.inflight = inflight;
    enqueue(s, async () => {
      let failed = false;
      onStatus("connecting", streamIdx);
      try {
        const text = await transcribeWav({ audio, sampleRate, model, baseUrl, apiKey });
        settle({ text });
        if (!closed) onStatus("live", streamIdx);
        // Segment already closed: its final supersedes this interim.
        if (closed || s.gen !== gen || !text || text === s.lastText) return;
        s.lastText = text;
        emitTranscript(streamIdx, text, false, s.dropped);
        s.dropped = 0;
      } catch (err) {
        failed = true;
        settle({ error: true });
        warn({ type: "asr.stt_error", stage: "interim", message: safeLogMessage(err, [apiKey]) });
      } finally {
        if (s.inflight === inflight) s.inflight = null;
        s.interimInFlight = false;
        if (failed && !closed) onStatus("degraded", streamIdx, { reason: "stt_error" });
        if (s.flushPending) {
          s.flushPending = false;
          // A closed segment's final already covers the flushed audio.
          if (!closed && s.gen === gen && s.samples > covered) scheduleInterim(streamIdx, s, { flush: true });
        }
      }
    });
    return true;
  }

  /**
   * The final of a closed segment. `getText` starts its request (or returns one
   * already started). An empty or failed final falls back to the last interim.
   */
  function finalTask(streamIdx, getText, fallback, dropped) {
    return async () => {
      let text = "";
      let failed = false;
      onStatus("connecting", streamIdx);
      try {
        text = await getText();
        if (!closed) onStatus("live", streamIdx);
      } catch (err) {
        failed = true;
        warn({ type: "asr.stt_error", stage: "final", message: safeLogMessage(err, [apiKey]) });
      }
      if (failed && !closed) onStatus("degraded", streamIdx, { reason: "stt_error" });
      if (closed) return;
      // Always close what the client saw: a failed/empty final falls back to
      // the last interim so the segment (and the turn gate) never dangles.
      const finalText = text || fallback;
      if (finalText) emitTranscript(streamIdx, finalText, true, dropped);
    };
  }

  /**
   * Closes the open segment and queues its final. An interim of this segment
   * still in flight is reused when it is a flush and only a short tail followed
   * it; otherwise the final request starts now, beside that interim.
   */
  function closeSegment(streamIdx, s, reason) {
    if (!s.gen) return false;
    const inflight = s.inflight;
    const sameSegment = inflight !== null && inflight.gen === s.gen;
    const reuse =
      sameSegment && inflight.flush && reason === "finalize" && s.samples - inflight.covered <= flushReuseSamples;
    const audio = snapshot(s);
    const fallback = s.lastText;
    const dropped = s.dropped;
    s.gen = 0;
    s.chunks = [];
    s.samples = 0;
    s.sinceInterim = 0;
    s.lastText = "";
    s.dropped = 0;
    s.flushPending = false;
    const transcribe = () => transcribeWav({ audio, sampleRate, model, baseUrl, apiKey });
    if (reuse) {
      // The flush already covers everything but the hangover tail: its text is
      // the final, and no request is spent. It is only re-sent if the flush
      // failed or came back empty.
      enqueue(s, async () => {
        const flushed = await inflight.result;
        if (flushed.text) {
          if (!closed) emitTranscript(streamIdx, flushed.text, true, dropped);
          return;
        }
        budget.note();
        await finalTask(streamIdx, transcribe, fallback, dropped)();
      });
    } else if (sameSegment) {
      budget.note();
      const request = transcribe();
      // Observed by the final task below; must not reject unobserved.
      request.catch(() => {});
      // Queued behind what preceded the in-flight interim, so its frame never
      // waits for that interim (which emits nothing once the segment is closed).
      enqueue(s, finalTask(streamIdx, () => request, fallback, dropped), inflight.before);
    } else {
      budget.note();
      enqueue(s, finalTask(streamIdx, transcribe, fallback, dropped));
    }
    warn({ type: "asr.segment_closed", stream: streamIdx, reason });
    return true;
  }

  function pushAudio({ streamIdx = STREAM.MICROPHONE, pcm16 } = {}) {
    if (closed) return;
    const samples = asInt16(pcm16);
    if (samples.length === 0) return;
    const s = state(streamIdx);
    if (!s.gen) s.gen = ++segmentGen;
    s.chunks.push(samples);
    s.samples += samples.length;
    s.sinceInterim += samples.length;
    s.lastAudioWall = Date.now();
    if (s.samples >= maxSegmentSamples) {
      // Bound request size (each request re-sends the whole segment).
      closeSegment(streamIdx, s, "max_length");
      return;
    }
    if (s.sinceInterim >= flushSamples) scheduleInterim(streamIdx, s);
  }

  function finalize(streamIdx) {
    if (closed) return false;
    const s = streams.get(streamIdx);
    if (!s) return false;
    return closeSegment(streamIdx, s, "finalize");
  }

  /**
   * Interims normally cover whole seconds of audio, so at a pause the latest
   * one can trail the speaker by up to STT_FLUSH_MS. A VAD end-of-turn hint
   * asks for one covering everything said so far, so the speculative answer
   * starts from the full question instead of a stale prefix.
   */
  function flushInterim(streamIdx) {
    if (closed) return false;
    const s = streams.get(streamIdx);
    if (!s || !s.gen || s.sinceInterim === 0) return false;
    return scheduleInterim(streamIdx, s, { flush: true });
  }

  // A lost `finalize` (or VAD that simply stops forwarding) must not leave a
  // segment open forever.
  const watchdog = setInterval(() => {
    if (closed) return;
    const now = Date.now();
    for (const [streamIdx, s] of streams) {
      if (s.gen && now - s.lastAudioWall >= silenceMs) closeSegment(streamIdx, s, "silence_watchdog");
    }
  }, WATCHDOG_MS);
  unrefTimer(watchdog);

  function close() {
    closed = true;
    clearInterval(watchdog);
    streams.clear();
  }

  return { pushAudio, finalize, flushInterim, close };
}

async function transcribeWav({ audio, sampleRate, model, baseUrl, apiKey }) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, "")}/audio/transcriptions`;
  const form = new FormData();
  form.append("file", new Blob([encodeWav(audio, sampleRate)], { type: "audio/wav" }), "segment.wav");
  form.append("model", model ?? "stt-mock");
  // No redirects (the key and audio must not hop origins), key-free errors,
  // capped response body: see provider-http.js.
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(STT_TIMEOUT_MS)
      : undefined;
  const response = await providerFetch(
    endpoint,
    {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    },
    { apiKey },
  );
  if (!response.ok) throw new Error(`transcription endpoint HTTP ${response.status}`);
  const payload = await readJsonCapped(response);
  return String(payload?.text ?? "").trim();
}

function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  return new Uint8Array(buffer);
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/* -------------------------------------------------------------- helpers -- */

function concatInt16(chunks, total) {
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function rmsDb(samples) {
  if (samples.length === 0) return -120;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length) / 32768;
  return rms <= 0 ? -120 : 20 * Math.log10(rms);
}

/** Wire payloads arrive as Uint8Array views at an odd offset; copy to align. */
export function asInt16(pcm) {
  if (pcm instanceof Int16Array) return pcm;
  if (!pcm) return new Int16Array(0);
  let bytes;
  if (pcm instanceof Uint8Array) bytes = pcm;
  else if (pcm instanceof ArrayBuffer) bytes = new Uint8Array(pcm);
  else if (ArrayBuffer.isView(pcm)) bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  else return new Int16Array(0);
  const aligned = bytes.slice(0, bytes.byteLength & ~1);
  return new Int16Array(aligned.buffer, 0, aligned.byteLength >> 1);
}
