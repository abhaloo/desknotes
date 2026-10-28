/**
 * RealtimeClient — client side of the v1 realtime wire protocol (docs/protocol.md).
 *
 * Dual-runtime (Bun + Electron's Node): the global `WebSocket` is used when the
 * runtime has one and `ws` otherwise (Electron 44 main = Node 24, which has one;
 * Electron 33's Node 20 had none).
 * Socket construction is injectable, which keeps the reconnect/ring logic
 * unit-testable without a network.
 *
 * Latency/robustness reasoning:
 * - audio is framed and seq'd here so the server can account for loss without
 *   parsing timestamps;
 * - a bounded drop-oldest ring trades audio quality for bounded memory while
 *   the link is down, and flushes in-order so the ASR stream stays coherent;
 * - control commands are fire-and-forget: buffering an `answer_request` or a
 *   `screen_analyse` for seconds would deliver a stale answer, so they are
 *   dropped instead of replayed;
 * - a half-open link accepts send() without error, so frames already on the
 *   wire are kept (with their seq) until a pong proves the server processed
 *   them, and are resent after an unexpected drop; the server drops the ones
 *   it already has as duplicates. Liveness is probed within ~1.5 s whenever
 *   audio flows with nothing coming back;
 * - uplink backpressure: above a bufferedAmount high-water mark audio waits in
 *   the ring (seq still unassigned) and drains in order below the low mark,
 *   which also paces the reconnect flush instead of dumping 12 s at once.
 */
import {
  BASE_DELAY_MS,
  CAPABILITIES,
  CLOSE_AUTH,
  CLOSE_DISCONNECT,
  CLOSE_STOP,
  HEARTBEAT_TIMEOUT_MS,
  LIVENESS_PROBE_DEADLINE_MS,
  LIVENESS_PROBE_IDLE_MS,
  MAX_DELAY_MS,
  PING_INTERVAL_MS,
  RING_MAX_BYTES,
  SESSION_DEAD_ERROR_CODES,
  SOURCE_TO_STREAM,
  STABLE_RESET_MS,
  TERMINAL_CLOSE_CODES,
  TOPOLOGY_WIRING,
  TURN_HINT_STATES,
  UPLINK_HIGH_WATER_BYTES,
  UPLINK_LOW_WATER_BYTES,
  encodeAudioFrame,
  makeFrame,
  parseFrame,
} from "../shared/protocol.js";
import { unrefTimer } from "../shared/timers.js";
import { createRequire } from "node:module";

/**
 * Default socket factory. Bun and Node >= 22 ship a global WebSocket, and so
 * does Electron 44's main process (Node 24). Runtimes without one, such as
 * Electron 33's Node 20, use the browser-compatible client from `ws` (an
 * allowed dependency). `ws`
 * delivers text frames as strings and, with binaryType "arraybuffer", binary
 * frames as ArrayBuffers: the same event contract as the global client.
 */
let wsFallbackCtor = null;
export function defaultCreateSocket(url) {
  if (typeof globalThis.WebSocket === "function") return new globalThis.WebSocket(url);
  if (!wsFallbackCtor) {
    const require = createRequire(import.meta.url);
    wsFallbackCtor = require("ws");
  }
  return new wsFallbackCtor(url);
}

// Ready-state constants are inlined: fake sockets in tests only implement the
// numeric contract, and the values match both the browser and `ws` clients.
const WS_CONNECTING = 0;
const WS_OPEN = 1;

const CONNECT_TIMEOUT_MS = 12_000;
/** Retry cadence of a paced ring drain while the socket buffer is full. */
const DRAIN_RETRY_MS = 20;
/** A deadline timer this late means our own loop stalled (see below). */
const DEADLINE_STALL_SLACK_MS = 250;
const DEADLINE_STALL_GRACE_MS = 200;
/**
 * Server close codes announcing a restart / overload: every client sees the
 * same close at the same instant, so even the first retry keeps full jitter.
 */
const JITTERED_FIRST_RETRY_CODES = [1001, 1012, 1013];
const DEFAULT_URL = "ws://127.0.0.1:8787/v3/realtime";

/**
 * Unref only non-resolution-critical timers (heartbeat, stable-open reset): they
 * must not hold a parked process open, while anything a promise awaits on
 * (backoff sleeps, connect timeouts, shutdown fallbacks) stays referenced.
 * Runtime-guarded: Bun's unref'd timers stop firing while a Promise awaits
 * them (see src/shared/timers.js), so unref applies on Node/Electron only.
 */
function unref(timer) {
  return unrefTimer(timer);
}

export class RealtimeClient {
  constructor({
    createSocket = defaultCreateSocket,
    telemetry,
    pingIntervalMs = PING_INTERVAL_MS,
    heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
    baseUrl = DEFAULT_URL,
  } = {}) {
    this.createSocket = createSocket;
    this.telemetry = telemetry;
    this.pingIntervalMs = pingIntervalMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.baseUrl = baseUrl;

    /** "connecting" | "live" | "reconnecting" | "ended" | "failed" (plus "idle" before start). */
    this.state = "idle";
    this.session = null;

    this._want = false;
    this._terminal = false;
    this._stopped = true;
    this._socket = null;
    /** Every socket created and not yet closed: stop() must leave none open. */
    this._sockets = new Set();
    this._attempt = 0;
    this._retryPromise = null;
    this._sleepTimer = null;
    this._sleepResolve = null;
    this._pingTimer = null;
    this._heartbeatDeadline = null;
    this._stableTimer = null;
    this._lastRecvAt = 0;
    this._lastStatus = null;
    this._authRetried = false;

    this._seq = { 0: 0, 1: 0 };
    this._ring = [];
    this._ringBytes = 0;
    this._ringDropped = 0;
    /** Frames on the wire not yet proven received: {streamIdx, seq, pcm16}. */
    this._sentTail = [];
    this._sentTailBytes = 0;
    /** Next seq per stream at each outstanding ping (FIFO, matched by pong). */
    this._pingMarks = [];
    /** Backpressure latch (hysteresis between the high/low water marks). */
    this._uplinkPaused = false;
    this._drainTimer = null;
    this._resentFrames = 0;
    this._livenessProbes = 0;
    /** The last link ended without a clean close of ours: resend the tail. */
    this._linkLost = false;

    this._sentFrames = 0;
    this._droppedFrames = 0;
    this._reconnects = 0;
    /** Highest DOWNLINK frame seq seen; null until the first frame. */
    this._lastSeenSeq = null;

    this._capabilities = new Set();
    this._frameSubs = new Set();
    this._statusSubs = new Set();
    this._screenSubs = new Set();
  }

  /**
   * Fresh session. Resolves on OPEN (launch-readiness signal) and rejects on the
   * first connect failure — a launch must fail fast instead of silently
   * retrying behind the UI.
   */
  async start(session) {
    if (!session || typeof session.sessionId !== "string" || session.sessionId.length === 0) {
      throw new Error("start() requires a session with a sessionId");
    }
    this._teardownLink();
    this.session = {
      sessionId: session.sessionId,
      jwt: session.jwt,
      topology: session.topology || "general",
      captureAuthorized: !!session.captureAuthorized,
      // The rep's grounding document and customer profile: held for the whole
      // session and sent on every connection (the server builds a fresh
      // engine per hello).
      context: normalizeContext(session.context),
      // Carried through so the 4401 refresh-then-retry grace is reachable.
      ...(typeof session.getJwt === "function" && { getJwt: session.getJwt }),
    };
    this._want = true;
    this._terminal = false;
    this._stopped = false;
    this._attempt = 0;
    this._capabilities = new Set();
    this._seq = { 0: 0, 1: 0 };
    this._ring = [];
    this._ringBytes = 0;
    this._ringDropped = 0;
    this._clearSentTail();
    this._linkLost = false;
    this._uplinkPaused = false;
    this._sentFrames = 0;
    this._droppedFrames = 0;
    this._reconnects = 0;
    this._authRetried = false;
    this._lastSeenSeq = null;
    this._setState("connecting");
    try {
      await this._connectOnce();
    } catch (error) {
      this._want = false;
      this._socket = null;
      this._setState("failed");
      throw error;
    }
  }

  /**
   * Resume the same session. Unlike start(), transient failures are retried
   * with capped exponential backoff until the link is back.
   */
  async reconnect() {
    if (!this.session) throw new Error("reconnect() requires a session (call start() first)");
    if (this._terminal) throw new Error("session is terminal; call start() for a fresh session");
    if (this._socket && this._socket.readyState === WS_OPEN) {
      this._want = true;
      return;
    }
    this._want = true;
    this._attempt = 0; // user-initiated resume starts at the fast first step
    if (this._retryPromise) {
      // A backoff loop is already running. Cutting its sleep short IS the
      // immediate attempt; starting a second connect here would race the
      // loop's own and orphan whichever socket loses.
      this._cancelSleep();
      return this._retryPromise;
    }
    // One IMMEDIATE attempt first: the user explicitly asked to resume,
    // so a backoff sleep before the first try is pure added latency.
    try {
      await this._connectOnce();
      this._reconnects += 1;
      return;
    } catch {
      return this._retryLoop();
    }
  }

  /** Drop the link but keep the session server-side; auto-retry is suppressed. */
  disconnect() {
    if (!this.session || this._terminal || this._stopped) return;
    this._want = false;
    this._cancelSleep();
    const socket = this._socket;
    this._socket = null;
    this._stopHeartbeat();
    this._clearDrainTimer();
    // Our own clean close flushes everything already written: nothing to
    // resend on the next connect.
    this._clearSentTail();
    this._linkLost = false;
    if (socket) {
      this._sockets.delete(socket);
      this._detach(socket);
      try {
        socket.close(CLOSE_DISCONNECT, "client disconnect");
      } catch {
        /* already gone */
      }
    }
    this._setState("reconnecting");
  }

  /** End everything: clears the session and latches the terminal state. */
  stop() {
    this._terminal = true;
    this._want = false;
    this._stopped = true;
    this._cancelSleep();
    this._stopHeartbeat();
    this._clearStableTimer();
    this._clearDrainTimer();
    this._clearSentTail();
    this._socket = null;
    // Close EVERY socket this client created, not just the current one: a
    // superseded or still-connecting link must not outlive stop().
    for (const socket of [...this._sockets]) {
      this._sockets.delete(socket);
      this._detach(socket);
      try {
        if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) {
          socket.close(1000, "client stop");
        }
      } catch {
        /* already gone */
      }
    }
    this._ring = [];
    this._ringBytes = 0;
    this.session = null;
    this._capabilities = new Set();
    this._setState("ended");
  }

  /**
   * Frame + send one gated PCM16 chunk. While disconnected-but-wanting the
   * payload lands in the ring (no seq assigned yet — seq is consumed
   * only at the actual wire send, so ring loss surfaces as telemetry rather
   * than a hole in the seq space); otherwise it is dropped.
   */
  sendAudio(source, pcm16) {
    const streamIdx = typeof source === "number" ? source : SOURCE_TO_STREAM[source];
    if (streamIdx == null || !(streamIdx in this._seq)) throw new Error(`unknown audio source: ${source}`);
    if (!pcm16 || !(pcm16 instanceof Int16Array || pcm16 instanceof Uint8Array)) {
      throw new TypeError("pcm16 must be an Int16Array (or a raw byte view)");
    }

    if (this._socket && this._socket.readyState === WS_OPEN) {
      if (this._ring.length === 0 && !this._backpressured(this._socket)) {
        this._sendAudioFrame(this._socket, streamIdx, pcm16);
        return;
      }
      // Older audio is still queued (paced flush) or the socket buffer is
      // full: queue behind it so the stream stays in order.
      this._ringPush({ streamIdx, pcm16 });
      this._drainRing();
      return;
    }
    if (this._want && !this._terminal && !this._stopped) {
      this._ringPush({ streamIdx, pcm16 });
    } else {
      this._droppedFrames += 1;
    }
  }

  /** Assign seq and write one audio frame; on write failure buffer for the ring. */
  _sendAudioFrame(socket, streamIdx, pcm16) {
    const seq = this._seq[streamIdx];
    const frame = encodeAudioFrame(streamIdx, seq, pcm16);
    try {
      socket.send(frame);
    } catch {
      // Link died between the readyState check and send: fall through to the ring.
      if (this._want && !this._terminal && !this._stopped) this._ringPush({ streamIdx, pcm16 });
      else this._droppedFrames += 1;
      return;
    }
    this._seq[streamIdx] = (seq + 1) >>> 0;
    this._sentFrames += 1;
    this._retain(streamIdx, seq, pcm16);
    this._maybeProbeLiveness();
  }

  /** End-of-utterance: ask the server to close the ASR segment now. Never buffered. */
  finalizeStream(source) {
    const streamIdx = typeof source === "number" ? source : SOURCE_TO_STREAM[source];
    if (streamIdx == null) throw new Error(`unknown audio source: ${source}`);
    this._sendControl(makeFrame("finalize", { stream: streamIdx }));
  }

  /**
   * Client VAD end-of-turn hint ("pause" | "resume") for one stream. A pure
   * speculation signal, so it is never buffered: a stale hint is worthless.
   * Sent only to servers that advertise the `turn_hint` capability.
   * @returns {boolean} whether the frame was written
   */
  sendTurnHint(source, state) {
    const streamIdx = typeof source === "number" ? source : SOURCE_TO_STREAM[source];
    if (streamIdx == null) throw new Error(`unknown audio source: ${source}`);
    if (!TURN_HINT_STATES.includes(state)) throw new Error(`unknown turn hint state: ${state}`);
    if (!this.hasCapability(CAPABILITIES.TURN_HINT)) return false;
    return this._sendControl(makeFrame("turn_hint", { stream: streamIdx, state }));
  }

  /** User-initiated "answer anyway"; never buffered (a delayed answer is worthless). */
  requestAnswer(utterance, intent, gateSeq) {
    const fields = { utterance, intent };
    if (gateSeq !== undefined && gateSeq !== null) fields.gate_seq = gateSeq;
    this._sendControl(makeFrame("answer_request", fields));
  }

  /**
   * Clear: the server drops the screen context it keeps for later answers.
   * A fresh connection starts without one, so nothing is replayed.
   * @returns {boolean} whether the frame was written
   */
  clearScreenContext() {
    if (!this.hasCapability(CAPABILITIES.SCREEN_CLEAR)) return false;
    return this._sendControl(makeFrame("screen_clear"));
  }

  /** Live flip of screen-capture authorization without a reconnect. */
  setCaptureAuthorized(authorized) {
    const value = !!authorized;
    if (this.session) this.session.captureAuthorized = value;
    this._sendControl(makeFrame("set_capture_auth", { authorized: value }));
  }

  /**
   * Replace the session context mid-session: the grounding document and the
   * customer profile, `{docs, name?, customer?: {name?, docs}}` (null clears
   * both). Every call carries the whole state, so a context without a
   * customer drops the profile. The value is kept for the session and sent
   * again on every reconnect.
   * @returns {boolean} whether a frame was written now
   */
  setSessionContext(context) {
    if (!this.session) return false;
    const next = normalizeContext(context);
    const hadContext = Boolean(this.session.context);
    this.session.context = next;
    if (!next && !hadContext) return false;
    return this._sendSessionContext({ clear: !next });
  }

  _sendSessionContext({ clear = false } = {}) {
    if (!this.hasCapability(CAPABILITIES.SESSION_CONTEXT)) return false;
    const context = this.session?.context ?? null;
    if (!context && !clear) return false;
    const fields = context
      ? {
          docs: context.docs,
          ...(context.name && { name: context.name }),
          ...(context.customer && {
            customer: { ...(context.customer.name && { name: context.customer.name }), docs: context.customer.docs },
          }),
        }
      : { docs: "" };
    return this._sendControl(makeFrame("session_context", fields));
  }

  /**
   * Socket is the authoritative channel for vision. Returns false when the
   * link or the negotiated capability is unavailable so the caller can fall
   * back to the legacy HTTP path.
   */
  sendScreenAnalyse({ commandId, purpose, origin, imageHash, objectPath, contentType } = {}) {
    if (!this._socket || this._socket.readyState !== WS_OPEN) return false;
    if (!this.hasCapability(CAPABILITIES.SCREEN_ANALYSE)) return false;
    return this._sendControl(
      makeFrame("screen_analyse", {
        command_id: commandId,
        purpose,
        origin,
        image_hash: imageHash,
        object_path: objectPath,
        content_type: contentType,
      }),
    );
  }

  /** Capabilities are replaced wholesale by each session.state; false until the first one. */
  hasCapability(name) {
    return this._capabilities.has(name);
  }

  /** (raw: string, frame: object) for every parsed control frame. */
  onFrame(cb) {
    this._frameSubs.add(cb);
    return () => this._frameSubs.delete(cb);
  }

  /** ({state, attempt?}) on every link state transition. */
  onStatus(cb) {
    this._statusSubs.add(cb);
    return () => this._statusSubs.delete(cb);
  }

  /** (result) for screen.result frames, joined by command_id. */
  onScreenResult(cb) {
    this._screenSubs.add(cb);
    return () => this._screenSubs.delete(cb);
  }

  /** Additive transport diagnostics (the getStats keys are frozen). */
  getLinkStats() {
    return {
      resentFrames: this._resentFrames,
      unackedFrames: this._sentTail.length,
      livenessProbes: this._livenessProbes,
      uplinkPaused: this._uplinkPaused,
      queuedFrames: this._ring.length,
    };
  }

  getStats() {
    return {
      sentFrames: this._sentFrames,
      droppedFrames: this._droppedFrames,
      bufferedBytes: this._ringBytes,
      reconnects: this._reconnects,
      lastSeenSeq: this._lastSeenSeq,
    };
  }

  // ---------------------------------------------------------------------------
  // connection lifecycle
  // ---------------------------------------------------------------------------

  _connectOnce() {
    const socket = this.createSocket(this.baseUrl);
    // Never leave a previous link orphaned behind the new one.
    if (this._socket && this._socket !== socket) this._abort(this._socket);
    this._socket = socket;
    this._sockets.add(socket);
    try {
      socket.binaryType = "arraybuffer";
    } catch {
      /* fake sockets need not support it */
    }

    let settled = false;
    let opened = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._abort(socket);
        reject(new Error("websocket connect timeout"));
      }, CONNECT_TIMEOUT_MS);

      const failBeforeOpen = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._abort(socket);
        reject(error);
      };

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        opened = true;
        clearTimeout(timer);
        this._onOpen(socket);
        resolve();
      };
      socket.onmessage = (event) => this._onMessage(socket, event);
      socket.onerror = (event) => {
        const error =
          event && event.error instanceof Error ? event.error : new Error("websocket error");
        if (!settled) {
          failBeforeOpen(error);
          return;
        }
        // Post-open errors leave a half-dead link; force close so recovery is
        // owned by exactly one path (the close handler / retry loop).
        this._forceClose(socket);
      };
      socket.onclose = (event) => {
        this._sockets.delete(socket);
        if (!opened) {
          if (!settled) {
            failBeforeOpen(
              new Error(`websocket closed before open (code ${event?.code ?? "unknown"})`),
            );
          }
          return;
        }
        this._onClose(socket, event?.code);
      };
    });
  }

  _onOpen(socket) {
    if (this._socket !== socket) return;
    this._lastRecvAt = Date.now();
    this._setState("live");
    // hello must be the first frame so the server can replay from last_seen_seq
    // before any audio of this connection is processed.
    this._sendControl(makeFrame("hello", this._helloFields()));
    this._startHeartbeat();
    this._clearStableTimer(); // a previous link's timer must not leak
    this._stableTimer = unref(
      setTimeout(() => {
        if (this._socket === socket && this.state === "live") this._attempt = 0;
      }, STABLE_RESET_MS),
    );
    this._resendTail();
    this._flushRing();
  }

  _helloFields() {
    const wiring = TOPOLOGY_WIRING[this.session.topology] ?? TOPOLOGY_WIRING.general;
    return {
      jwt: this.session.jwt,
      session_id: this.session.sessionId,
      streams: wiring.streams,
      capture_authorized: this.session.captureAuthorized,
      // Key omitted entirely until a downlink frame has been seen:
      // the server must be able to tell "fresh session" from "resume at 0".
      ...(this._lastSeenSeq !== null && { last_seen_seq: this._lastSeenSeq }),
    };
  }

  _onMessage(socket, event) {
    if (this._socket !== socket) return;
    // Any inbound frame clears the heartbeat deadline.
    this._clearHeartbeatDeadline();
    const data = event?.data;
    // Binary downlink is not part of the documented server->client plane.
    if (typeof data !== "string") return;
    this._lastRecvAt = Date.now();
    const frame = parseFrame(data);
    if (!frame) return;
    this._handleFrame(frame, data);
  }

  _handleFrame(frame, raw) {
    // Downlink seq: the server numbers every frame it sends; the
    // highest seen is echoed as `last_seen_seq` on reconnect so the server can
    // replay the control frames this client missed.
    if (typeof frame.seq === "number") {
      this._lastSeenSeq =
        this._lastSeenSeq === null ? frame.seq : Math.max(this._lastSeenSeq, frame.seq);
    }
    if (frame.type === "pong") {
      this._onPong();
    } else if (frame.type === "session.state") {
      const caps = frame.data?.capabilities;
      // Replaced wholesale: a reconnect may land on a different server build.
      this._capabilities = new Set(Array.isArray(caps) ? caps : []);
      // Every connection gets a fresh server engine: send the document again.
      if (this.session?.context) this._sendSessionContext();
    } else if (frame.type === "session.ended") {
      this._latchSessionEnded();
    } else if (frame.type === "error") {
      // `session_ended` / `session_not_found` error codes are as terminal as
      // the session.ended frame itself.
      const code = frame.data?.code;
      if (code != null && SESSION_DEAD_ERROR_CODES.includes(code)) {
        this._latchSessionEnded();
      }
    } else if (frame.type === "screen.result") {
      this._emit(this._screenSubs, frame.data ?? frame);
    }
    this._emit(this._frameSubs, raw, frame);
  }

  /** Terminal: no reconnect until a fresh start(), per protocol. */
  _latchSessionEnded() {
    this._terminal = true;
    this._want = false;
    this._stopHeartbeat();
    this._clearStableTimer();
    this._cancelSleep();
    this._setState("ended");
    this._forceClose(this._socket ?? undefined);
  }

  _onClose(socket, code) {
    if (this._socket !== socket) return; // stale close from a superseded link
    this._socket = null;
    this._stopHeartbeat();
    this._clearStableTimer();
    this._clearDrainTimer();
    // Anything not proven received may have died with the link.
    this._linkLost = this._sentTail.length > 0;
    this._pingMarks = [];
    this._uplinkPaused = false;
    if (this._terminal || this._stopped || !this._want) return;
    if (this._isTerminalClose(code)) {
      this._terminal = true;
      this._want = false;
      this._cancelSleep();
      this._setState("ended");
      return;
    }
    if (code === CLOSE_AUTH && this._canRefreshJwt()) {
      // 4401 grace: refresh the token and retry immediately, once.
      this._authRetried = true;
      this._setState("reconnecting", this._attempt);
      this._resolveJwt()
        .then((jwt) => {
          if (this.session) this.session.jwt = jwt;
          return this._connectOnce();
        })
        .then(() => {
          this._reconnects += 1;
        })
        .catch(() => {
          this._retryLoop().catch(() => {
            /* give up only when stop()/disconnect() cancels the loop */
          });
        });
      return;
    }
    // Unexpected drop: the first attempt is immediate (every ms of backoff
    // here is speech piling up in the ring). Server-announced restarts keep
    // full jitter so a fleet does not reconnect in lockstep.
    this._retryLoop({ immediateFirst: !JITTERED_FIRST_RETRY_CODES.includes(code) }).catch(() => {
      /* give up only when stop()/disconnect() cancels the loop */
    });
  }

  /** A close is terminal when the session ended, on the fixed server codes,
   * or on a 4401 once the auth grace is spent / unavailable. */
  _isTerminalClose(code) {
    if (this._terminal) return true;
    if (TERMINAL_CLOSE_CODES.includes(code)) return true;
    if (code === CLOSE_AUTH) return this._authRetried || !this._canRefreshJwt();
    return false;
  }

  _canRefreshJwt() {
    return typeof this.session?.getJwt === "function";
  }

  async _resolveJwt() {
    if (!this.session?.getJwt) return this.session?.jwt;
    try {
      const token = await this.session.getJwt();
      return token || this.session.jwt;
    } catch {
      return this.session.jwt; // fall back to the snapshot token
    }
  }

  /**
   * Full-jitter backoff, one in-flight attempt at a time: the delay is
   * `random() * min(cap, base * 2^attempt)` so a fleet of clients never
   * retries in lockstep (anti-thundering-herd). The counter is only reset by a
   * stable open (or an explicit reconnect), so a flapping network backs off
   * instead of hammering the server.
   */
  _retryLoop({ immediateFirst = false } = {}) {
    if (this._retryPromise) return this._retryPromise;
    let first = true;
    const loop = (async () => {
      while (this._want && !this._terminal && !this._stopped) {
        this._attempt += 1;
        const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (this._attempt - 1));
        // Only the first attempt after an unexpected drop skips the jitter;
        // a flapping link (attempt counter not yet reset by a stable open)
        // still backs off.
        const delay = first && immediateFirst && this._attempt === 1 ? 0 : Math.random() * cap;
        first = false;
        this._setState("reconnecting", this._attempt);
        await this._sleep(delay);
        if (!this._want || this._terminal || this._stopped) break;
        // Another path (4401 refresh, a racing caller) may have brought a
        // link up while this loop slept: never replace a live socket.
        const current = this._socket;
        if (current && (current.readyState === WS_OPEN || current.readyState === WS_CONNECTING)) return;
        try {
          await this._connectOnce();
          this._reconnects += 1;
          return;
        } catch {
          // transient failure: loop and back off further
        }
      }
      // Cancelled by stop()/disconnect() or latched terminal: an expected end
      // state (reconnect resolves rather than rejecting), and a
      // rejection here would surface as an unhandledRejection in callers that
      // only awaited the immediate attempt.
      return;
    })();
    this._retryPromise = loop.finally(() => {
      this._retryPromise = null;
    });
    return this._retryPromise;
  }

  // ---------------------------------------------------------------------------
  // heartbeat
  // ---------------------------------------------------------------------------

  /**
   * Ping every PING_INTERVAL_MS; after each ping a single deadline of
   * HEARTBEAT_TIMEOUT_MS is armed. ANY inbound frame clears it (see
   * _onMessage), so it fires only when the socket has gone silent — the
   * half-open signature.
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._pingTimer = unref(
      setInterval(() => {
        if (!(this._socket && this._socket.readyState === WS_OPEN)) return;
        this._sendPing(this.heartbeatTimeoutMs);
      }, this.pingIntervalMs),
    );
  }

  /** Ping, remember how far the uplink had got (for the pong), arm the deadline. */
  _sendPing(deadlineMs) {
    if (!this._sendControl(makeFrame("ping"))) return false;
    this._pingMarks.push({ 0: this._seq[0], 1: this._seq[1] });
    if (this._pingMarks.length > 16) this._pingMarks.shift();
    this._armHeartbeatDeadline(deadlineMs);
    return true;
  }

  /**
   * Audio is flowing and nothing has come back for LIVENESS_PROBE_IDLE_MS:
   * probe now. On a live link the pong lands within one round trip; on a
   * half-open one the short deadline tears it down in seconds, not after the
   * next heartbeat tick plus its deadline.
   */
  _maybeProbeLiveness() {
    if (this._heartbeatDeadline) return; // a ping is already outstanding
    if (Date.now() - this._lastRecvAt < LIVENESS_PROBE_IDLE_MS) return;
    if (this._sendPing(Math.min(this.heartbeatTimeoutMs, LIVENESS_PROBE_DEADLINE_MS))) this._livenessProbes += 1;
  }

  _armHeartbeatDeadline(timeoutMs = this.heartbeatTimeoutMs) {
    if (this._heartbeatDeadline) return;
    const due = Date.now() + timeoutMs;
    let graced = false;
    const fire = () => {
      this._heartbeatDeadline = null;
      if (!(this._socket && this._socket.readyState === WS_OPEN)) return;
      // Stall-tolerant: if THIS process was blocked (the timer fires late),
      // frames that arrived meanwhile have not been read yet (timers run
      // before socket I/O). Give them one short grace instead of tearing
      // down a live link because of our own main-loop stall.
      if (!graced && Date.now() - due > DEADLINE_STALL_SLACK_MS) {
        graced = true;
        this._heartbeatDeadline = unref(setTimeout(fire, DEADLINE_STALL_GRACE_MS));
        return;
      }
      this._declareDead(this._socket);
    };
    this._heartbeatDeadline = unref(setTimeout(fire, timeoutMs));
  }

  _clearHeartbeatDeadline() {
    if (this._heartbeatDeadline) clearTimeout(this._heartbeatDeadline);
    this._heartbeatDeadline = null;
  }

  _stopHeartbeat() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
    this._clearHeartbeatDeadline();
  }

  _clearStableTimer() {
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = null;
  }

  // ---------------------------------------------------------------------------
  // gap ring
  // ---------------------------------------------------------------------------

  _ringPush(entry) {
    const size = entry.pcm16.byteLength;
    if (size > RING_MAX_BYTES) {
      // A single frame that cannot fit would evict the whole ring; losing one
      // frame is the better trade.
      this._droppedFrames += 1;
      return;
    }
    while (this._ringBytes + size > RING_MAX_BYTES && this._ring.length > 0) {
      const dropped = this._ring.shift();
      this._ringBytes -= dropped.pcm16.byteLength;
      this._ringDropped += 1;
      this._droppedFrames += 1;
    }
    this._ring.push(entry);
    this._ringBytes += size;
  }

  _flushRing() {
    this._drainRing();
    if (this._ringDropped > 0) {
      // Ring loss is invisible in the seq space; telemetry is the
      // only record of it.
      this._reportTelemetry({
        type: "gap",
        reason: "ring_overflow",
        droppedFrames: this._ringDropped,
        sentFrames: this._sentFrames,
      });
      this._ringDropped = 0;
    }
  }

  /**
   * Send queued ring audio in order (seq assigned at the actual send) while
   * the socket buffer is below the high-water mark; anything left drains on
   * the next send or a short timer. Live audio queues behind it. A write
   * failure (link died mid-flush) keeps the unsent tail, still unseq'd, for
   * the next reconnect.
   */
  _drainRing() {
    const socket = this._socket;
    if (!socket || socket.readyState !== WS_OPEN) return;
    while (this._ring.length > 0) {
      if (this._backpressured(socket)) break;
      const entry = this._ring[0];
      const seq = this._seq[entry.streamIdx];
      if (!this._write(encodeAudioFrame(entry.streamIdx, seq, entry.pcm16))) break;
      this._ring.shift();
      this._ringBytes -= entry.pcm16.byteLength;
      this._seq[entry.streamIdx] = (seq + 1) >>> 0;
      this._sentFrames += 1;
      this._retain(entry.streamIdx, seq, entry.pcm16);
    }
    if (this._ring.length > 0 && !this._drainTimer && socket.readyState === WS_OPEN) {
      this._drainTimer = setTimeout(() => {
        this._drainTimer = null;
        this._drainRing();
      }, DRAIN_RETRY_MS);
    }
  }

  _clearDrainTimer() {
    if (this._drainTimer) clearTimeout(this._drainTimer);
    this._drainTimer = null;
  }

  /** Hysteresis on bufferedAmount (absent on fake sockets = never congested). */
  _backpressured(socket) {
    const buffered = Number(socket?.bufferedAmount) || 0;
    if (this._uplinkPaused) {
      if (buffered <= UPLINK_LOW_WATER_BYTES) this._uplinkPaused = false;
    } else if (buffered > UPLINK_HIGH_WATER_BYTES) {
      this._uplinkPaused = true;
      // A buffer that will not drain is also what a half-open link looks
      // like: make sure a liveness deadline is running.
      if (!this._heartbeatDeadline) this._sendPing(Math.min(this.heartbeatTimeoutMs, LIVENESS_PROBE_DEADLINE_MS));
    }
    return this._uplinkPaused;
  }

  // ---------------------------------------------------------------------------
  // unacknowledged tail (half-open recovery)
  // ---------------------------------------------------------------------------

  /** Keep a sent frame until a pong proves the server processed it. */
  _retain(streamIdx, seq, pcm16) {
    this._sentTail.push({ streamIdx, seq, pcm16 });
    this._sentTailBytes += pcm16.byteLength;
    while (this._sentTailBytes > RING_MAX_BYTES && this._sentTail.length > 1) {
      this._sentTailBytes -= this._sentTail.shift().pcm16.byteLength;
    }
  }

  /**
   * The server answers pings in order on the same serial queue that consumes
   * audio, so a pong proves every frame sent before its ping was processed.
   */
  _onPong() {
    const mark = this._pingMarks.shift();
    if (!mark) return;
    const kept = this._sentTail.filter((entry) => entry.seq >= mark[entry.streamIdx]);
    if (kept.length !== this._sentTail.length) {
      this._sentTail = kept;
      this._sentTailBytes = kept.reduce((sum, entry) => sum + entry.pcm16.byteLength, 0);
    }
  }

  /**
   * After an unexpected drop, resend unproven frames with their ORIGINAL seq
   * (right after hello, before the ring). The server keeps per-session seq
   * accounting and drops what it already has as duplicates, so only the
   * audio the dead link swallowed reaches ASR again.
   */
  _resendTail() {
    const lost = this._linkLost;
    this._linkLost = false;
    if (!lost) return;
    for (const entry of this._sentTail) {
      if (!this._write(encodeAudioFrame(entry.streamIdx, entry.seq, entry.pcm16))) {
        this._linkLost = true; // died again: keep it for the next link
        return;
      }
      this._resentFrames += 1;
    }
  }

  _clearSentTail() {
    this._sentTail = [];
    this._sentTailBytes = 0;
    this._pingMarks = [];
  }

  // ---------------------------------------------------------------------------
  // plumbing
  // ---------------------------------------------------------------------------

  _sendControl(raw) {
    if (!(this._socket && this._socket.readyState === WS_OPEN)) return false;
    return this._write(raw);
  }

  _write(data) {
    const socket = this._socket;
    if (!socket || socket.readyState !== WS_OPEN) return false;
    try {
      socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A half-open link never completes a close handshake, so waiting for its
   * close event can take as long as the runtime's own close timeout. Treat it
   * as dropped NOW: detach, terminate (or close) it, and run the unexpected-
   * close path (immediate retry, unacknowledged-tail resend) ourselves.
   */
  _declareDead(socket) {
    if (!socket || this._socket !== socket) return;
    this._sockets.delete(socket);
    this._detach(socket);
    try {
      if (typeof socket.terminate === "function") socket.terminate();
      else if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) socket.close();
    } catch {
      /* already gone */
    }
    this._onClose(socket, 1006);
  }

  /** Close a socket that may be half-open; handlers stay attached for _onClose. */
  _forceClose(socket) {
    if (!socket) return;
    try {
      if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) socket.close();
    } catch {
      /* already gone */
    }
  }

  /** Drop a socket we are abandoning: detach first so no handler races the new link. */
  _abort(socket) {
    if (this._socket === socket) this._socket = null;
    this._sockets.delete(socket);
    this._detach(socket);
    try {
      if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) socket.close();
    } catch {
      /* already gone */
    }
  }

  _detach(socket) {
    try {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
    } catch {
      /* fake sockets may not expose setters */
    }
  }

  _teardownLink() {
    this._cancelSleep();
    this._stopHeartbeat();
    this._clearStableTimer();
    this._socket = null;
    for (const socket of [...this._sockets]) {
      this._sockets.delete(socket);
      this._detach(socket);
      try {
        if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) {
          socket.close(1000, "superseded");
        }
      } catch {
        /* already gone */
      }
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this._sleepResolve = resolve;
      // Referenced: backoff resolution must not stall when nothing else keeps
      // the host event loop busy (Bun's test runner, headless Electron).
      this._sleepTimer = setTimeout(() => {
        this._sleepTimer = null;
        this._sleepResolve = null;
        resolve();
      }, ms);
    });
  }

  /** Cancels a pending backoff so stop()/disconnect() take effect immediately. */
  _cancelSleep() {
    if (this._sleepTimer) {
      clearTimeout(this._sleepTimer);
      this._sleepTimer = null;
    }
    const resolve = this._sleepResolve;
    this._sleepResolve = null;
    if (resolve) resolve();
  }

  _setState(state, attempt) {
    this.state = state;
    const event = { state };
    if (attempt != null) event.attempt = attempt;
    const signature = `${state}:${attempt ?? ""}`;
    if (this._lastStatus === signature) return;
    this._lastStatus = signature;
    this._emit(this._statusSubs, event);
  }

  _emit(subscribers, ...args) {
    for (const cb of [...subscribers]) {
      try {
        cb(...args);
      } catch {
        // A UI callback must never break the transport.
      }
    }
  }

  _reportTelemetry(event) {
    try {
      if (typeof this.telemetry === "function") this.telemetry(event);
      else if (this.telemetry && typeof this.telemetry.track === "function") this.telemetry.track(event);
    } catch {
      /* telemetry must never break the audio path */
    }
  }
}

/**
 * `{docs, name, customer}`: the grounding document and the customer profile.
 * A customer is `{name, docs}` with a non-empty `docs`, else null. A context
 * with neither a document nor a customer is null.
 */
function normalizeContext(context) {
  if (!context || typeof context !== "object") return null;
  const docs = typeof context.docs === "string" ? context.docs : "";
  const customer = normalizeCustomer(context.customer);
  if (!docs && !customer) return null;
  return { docs, name: typeof context.name === "string" ? context.name : "", customer };
}

function normalizeCustomer(customer) {
  if (!customer || typeof customer !== "object") return null;
  const docs = typeof customer.docs === "string" ? customer.docs : "";
  if (!docs) return null;
  return { name: typeof customer.name === "string" ? customer.name : "", docs };
}

