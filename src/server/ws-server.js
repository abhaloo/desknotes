/**
 * RealtimeServer — `ws`-based server side of the v1 wire protocol.
 *
 * Design notes (robustness/latency):
 * - one engine per connection, but session state (replay ring + seq accounting)
 *   lives per session_id, so a reconnect gets a fresh engine while ASR
 *   continuity is reconstructed from the replay ring;
 * - messages for one connection are processed through a promise queue: hello
 *   may await token verification while audio frames are already arriving, and
 *   out-of-order ASR input would be worse than a few ms of buffering;
 * - screen analysis is the one command that is NOT awaited on that queue: a
 *   vision call takes seconds, and audio / finalize stalled behind it delayed
 *   every answer and tripped the ASR silence watchdog into a truncated final.
 *   It runs beside the queue with a deadline and a per-connection cap;
 * - the replay ring is bounded, because keeping an unbounded session history
 *   would turn every long session into a memory leak.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  CAPABILITIES,
  CLOSE_AUTH,
  CLOSE_STOP,
  FRAME_HEADER_BYTES,
  SCREEN_STATUSES,
  SOURCE_TO_STREAM,
  STREAM_TO_SOURCE,
  TURN_HINT_STATES,
  decodeAudioFrame,
  makeFrame,
  parseFrame,
} from "../shared/protocol.js";

const OPEN = WebSocket.OPEN;
const CLOSED = WebSocket.CLOSED;

const SERVER_CAPABILITIES = [
  CAPABILITIES.SCREEN_ANALYSE,
  CAPABILITIES.ANSWER_REQUEST,
  CAPABILITIES.REPLAY,
  CAPABILITIES.SESSION_COMMANDS,
  CAPABILITIES.TURN_HINT,
  CAPABILITIES.SESSION_CONTEXT,
  CAPABILITIES.SCREEN_CLEAR,
];

/** session_context bounds: the desktop caps documents at 30,000 characters; this is the wire guard. */
const MAX_SESSION_CONTEXT_CHARS = 32_000;
const MAX_CONTEXT_NAME_CHARS = 200;

const MAX_LOGS = 200;

/**
 * Screen analysis runs off the per-connection queue (see header). The
 * deadline answers a hung provider with a typed failure well before the
 * client's own 60 s wait expires; the cap keeps a hotkey burst from stacking
 * unbounded model calls on one connection.
 */
const SCREEN_ANALYSE_TIMEOUT_MS = 30_000;
const MAX_INFLIGHT_SCREEN = 2;
const SOCKET_CLOSE_GRACE_MS = 150;

/**
 * Screen upload store (docs/protocol.md "Screen capture upload contract").
 * Bounded per session: screenshots are large and only the most recent few
 * can still be referenced by an in-flight `screen_analyse`.
 */
const UPLOAD_TTL_MS = 60_000;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const MAX_OBJECTS_PER_SESSION = 8;
const MAX_JSON_BYTES = 16 * 1024;
const UPLOADS_ROUTE = /^\/v3\/sessions\/([^/]+)\/screen\/uploads$/;
/**
 * Screenshot types only. SVG is an image/* type but scriptable markup, and
 * nothing in the app produces anything but JPEG (PNG/WebP kept for tools).
 */
const UPLOAD_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/*
 * Socket and message limits (security audit F8). The largest legitimate
 * inbound frame is one 32 ms audio frame (~1 KB; ring flush and tail resend
 * send frame by frame) or a JSON control frame (bounded by the 512 KB IPC
 * cap), so 1 MiB is generous while keeping a peer from making the server
 * buffer the `ws` default of 100 MiB per message.
 *
 * Unauthenticated sockets: loopback is shared by every local process and OS
 * user, so they must never be able to lock the real client out. With
 * `requireUpgradeAuth` (the embedded server) a socket without the credential
 * is refused at the handshake and none exists. Otherwise pending sockets get
 * a short hello deadline, and a full pending set evicts its OLDEST member
 * instead of refusing the newcomer: a flood can only ever push out other
 * not-yet-authenticated sockets, never block a client that says hello.
 */
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_HELLO_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_PENDING_CONNECTIONS = 32;
/** A session nobody is connected to is dropped after this (replay ring, uploads). */
const DEFAULT_SESSION_IDLE_MS = 10 * 60_000;
const HTTP_HEADERS_TIMEOUT_MS = 10_000;
const HTTP_REQUEST_TIMEOUT_MS = 30_000;

/** Host header names that can only mean this machine (DNS-rebinding defence). */
function isLoopbackHostHeader(value) {
  if (typeof value !== "string" || value === "") return false;
  let hostname;
  try {
    hostname = new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function isLoopbackBind(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
const PUT_ROUTE = /^\/v3\/uploads\/([A-Za-z0-9_-]+)$/;

/**
 * The pre-hello `session.state` is stamped seq 0 and session-scoped downlink
 * seqs start at 1: a client that only saw the capability frame echoes
 * `last_seen_seq: 0` and gets the whole session replayed, never less.
 */
const PRE_HELLO_SEQ = 0;
const FIRST_SESSION_SEQ = 1;

/** Session-ended close code (terminal, never retry). */
const CLOSE_SESSION_ENDED = 4409;

/**
 * Close-code vocabulary: 4400 protocol violation, 4401 auth (the
 * client gets one refresh-then-retry grace), 4404 session not found, 4409
 * session ended/conflict — all of which latch terminal on the client.
 */
function closeCodeFor(reason) {
  switch (reason) {
    case "unauthorized":
      return CLOSE_AUTH;
    case "bad_hello":
    case "bad_frame":
      return 4400;
    case "session_not_found":
    case "no_session":
      return 4404;
    case "session_ended":
    case "engine_error":
      return CLOSE_SESSION_ENDED;
    default:
      return CLOSE_STOP;
  }
}

/** Normalize whatever `ws` hands us into a byte view without copying when possible. */
function asBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(0);
}

const TEXT_DECODER = new TextDecoder();

/** String-coerce helper for wire fields (never emits null/undefined). */
function str(value) {
  return typeof value === "string" ? value : "";
}

/** Aligned Int16Array copy: engines get samples, not an odd-offset byte view. */
function toInt16(view) {
  const out = new Int16Array(view.byteLength >> 1);
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  for (let i = 0; i < out.length; i += 1) out[i] = dv.getInt16(i * 2, true);
  return out;
}

/** Accepts numeric stream indices and both source spellings ("mic"/"microphone"). */
function resolveStream(value) {
  if (typeof value === "number" && STREAM_TO_SOURCE[value] !== undefined) return value;
  if (typeof value === "string") {
    if (SOURCE_TO_STREAM[value] !== undefined) return SOURCE_TO_STREAM[value];
    if (value === "mic") return SOURCE_TO_STREAM.microphone;
  }
  return null;
}

export class RealtimeServer {
  /**
   * `allowedOrigins`: upgrades and HTTP requests that carry an `Origin`
   * header are rejected unless the origin is listed. Browsers always send
   * Origin and native clients (`ws`, Electron main) do not, so the default
   * empty allowlist blocks cross-site WebSocket hijacking from any web page.
   */
  constructor({
    port = 0,
    createEngine,
    verifyToken = () => true,
    replayBufferSize = 240,
    allowedOrigins = [],
    host = "127.0.0.1",
    screenAnalyseTimeoutMs = SCREEN_ANALYSE_TIMEOUT_MS,
    maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
    helloTimeoutMs = DEFAULT_HELLO_TIMEOUT_MS,
    maxPendingConnections = DEFAULT_MAX_PENDING_CONNECTIONS,
    sessionIdleMs = DEFAULT_SESSION_IDLE_MS,
    requireUpgradeAuth = false,
  } = {}) {
    if (typeof createEngine !== "function") {
      throw new TypeError("RealtimeServer requires createEngine({ emit, log })");
    }
    this.port = port;
    this.createEngine = createEngine;
    this.verifyToken = verifyToken;
    this.replayBufferSize = replayBufferSize;
    this.allowedOrigins = new Set(Array.isArray(allowedOrigins) ? allowedOrigins : []);
    this.host = host;
    this.screenAnalyseTimeoutMs = screenAnalyseTimeoutMs;
    this.maxPayloadBytes = maxPayloadBytes;
    this.helloTimeoutMs = helloTimeoutMs;
    this.maxPendingConnections = maxPendingConnections;
    this.sessionIdleMs = sessionIdleMs;
    /** Handshake auth: `Authorization: Bearer <token>` checked with verifyToken. */
    this.requireUpgradeAuth = Boolean(requireUpgradeAuth);

    this._wss = null;
    this._http = null;
    /** upload grant -> pending signed-URL entry. */
    this._uploads = new Map();
    this._boundPort = null;
    this._conns = new Set();
    this._sessions = new Map();

    /** Bounded, inspectable server log (gap accounting included). */
    this.logs = [];
    /** Optional `(entry) => void` hook for ops; engine `log` entries flow here too. */
    this.onLog = null;
    this._log = (entry) => {
      const record = { ts: Date.now(), ...entry };
      this.logs.push(record);
      if (this.logs.length > MAX_LOGS) this.logs.shift();
      try {
        this.onLog?.(record);
      } catch {
        /* ops hooks must not break a session */
      }
    };
  }

  async start() {
    if (this._wss) return this._addresses();
    // One port serves both planes: the WebSocket session and the HTTP
    // control-plane routes the upload contract needs (mint + signed PUT).
    const httpServer = createServer((req, res) => {
      this._onHttpRequest(req, res).catch((error) => {
        this._log({ type: "http_error", message: String(error?.message ?? error) });
        sendJson(res, 500, { error: "internal_error" });
      });
    });
    httpServer.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
    httpServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
    const wss = new WebSocketServer({
      server: httpServer,
      maxPayload: this.maxPayloadBytes,
      verifyClient: (info, done) => this._verifyUpgrade(info, done),
    });
    this._wss = wss;
    this._http = httpServer;
    wss.on("connection", (socket) => this._onConnection(socket));
    wss.on("error", (error) => this._log({ type: "server_error", message: String(error?.message ?? error) }));

    await new Promise((resolve, reject) => {
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        httpServer.off("listening", onListening);
        this._wss = null;
        this._http = null;
        try {
          wss.close();
        } catch {
          /* never started */
        }
        reject(error);
      };
      httpServer.once("listening", onListening);
      httpServer.once("error", onError);
      httpServer.listen(this.port, this.host);
    });
    httpServer.on("error", (error) => this._log({ type: "server_error", message: String(error?.message ?? error) }));

    const address = httpServer.address();
    this._boundPort = typeof address === "object" && address ? address.port : this.port;
    return this._addresses();
  }

  _addresses() {
    return {
      port: this._boundPort,
      url: `ws://127.0.0.1:${this._boundPort}`,
      httpUrl: `http://127.0.0.1:${this._boundPort}`,
    };
  }

  /** Origin gate shared by the upgrade and HTTP paths. */
  _originAllowed(origin) {
    if (origin === undefined || origin === null || origin === "") return true;
    return this.allowedOrigins.has(String(origin));
  }

  /** A loopback-bound server only answers to loopback Host names (DNS rebinding). */
  _hostAllowed(hostHeader) {
    return !isLoopbackBind(this.host) || isLoopbackHostHeader(hostHeader);
  }

  _pendingConnections() {
    const pending = [];
    for (const conn of this._conns) if (!conn.hello && !conn.ended) pending.push(conn);
    return pending;
  }

  /** Make room for a newcomer by dropping the oldest not-yet-authenticated socket. */
  _evictOldestPending() {
    const pending = this._pendingConnections();
    if (pending.length < this.maxPendingConnections) return;
    pending.sort((a, b) => a.openedAt - b.openedAt);
    for (const conn of pending.slice(0, pending.length - this.maxPendingConnections + 1)) {
      this._log({ type: "pending_evicted" });
      this._rejectUnauthorized(conn);
    }
  }

  _verifyUpgrade(info, done) {
    const headers = info?.req?.headers ?? {};
    if (!this._hostAllowed(headers.host)) {
      this._log({ type: "host_rejected", host: String(headers.host) });
      done(false, 403);
      return;
    }
    const origin = headers.origin;
    if (!this._originAllowed(origin)) {
      this._log({ type: "origin_rejected", origin: String(origin) });
      done(false, 403);
      return;
    }
    if (!this.requireUpgradeAuth) {
      this._evictOldestPending();
      done(true);
      return;
    }
    // Handshake auth: the credential never appears in the URL; it is not logged.
    const auth = String(headers.authorization ?? "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    Promise.resolve()
      .then(() => this.verifyToken(token, { transport: "upgrade" }))
      .catch(() => false)
      .then((ok) => {
        if (!ok) {
          this._log({ type: "upgrade_unauthorized" });
          done(false, 401);
          return;
        }
        this._evictOldestPending();
        done(true);
      });
  }

  async stop() {
    const wss = this._wss;
    if (!wss) return;
    this._wss = null;

    const conns = [...this._conns];
    await Promise.all(conns.map((conn) => this._endConnection(conn, "server_shutdown")));

    await new Promise((resolve) => {
      // The host HTTP server can stall its close callback while an upgraded
      // socket finishes tearing down, so the fallback is referenced (resolution
      // must not depend on an unref'd timer) and bounded.
      const timer = setTimeout(resolve, 500);
      wss.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    const httpServer = this._http;
    this._http = null;
    if (httpServer) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        try {
          httpServer.closeAllConnections?.();
        } catch {
          /* runtime without the helper */
        }
        httpServer.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    this._conns.clear();
    this._sessions.clear();
    this._uploads.clear();
    this._boundPort = null;
  }

  // ---------------------------------------------------------------------------
  // connection handling
  // ---------------------------------------------------------------------------

  _onConnection(socket) {
    const conn = {
      socket,
      engine: null,
      sessionId: null,
      session: null,
      hello: false,
      ended: false,
      captureAuthorized: false,
      queue: Promise.resolve(),
      /** In-flight screen analyses (AbortControllers), outside the queue. */
      screenJobs: new Set(),
      helloTimer: null,
      openedAt: Date.now(),
    };
    this._conns.add(conn);
    // An unauthenticated socket costs a slot of the pending cap: it gets a
    // bounded time to authenticate.
    conn.helloTimer = setTimeout(() => {
      conn.helloTimer = null;
      if (conn.hello || conn.ended) return;
      this._log({ type: "hello_timeout" });
      this._rejectUnauthorized(conn);
    }, this.helloTimeoutMs);
    conn.helloTimer.unref?.();

    socket.on("message", (data, isBinary) => {
      // `ws` enforces maxPayload itself on Node; Bun's built-in `ws` shim
      // ignores it, so the standalone (bun) server checks here too.
      const size = typeof data === "string" ? data.length : (data?.byteLength ?? data?.length ?? 0);
      if (size > this.maxPayloadBytes) {
        this._log({ type: "oversized_frame", sessionId: conn.sessionId, bytes: size });
        conn.ended = true;
        try {
          socket.close(1009, "message too big");
        } catch {
          /* already gone */
        }
        return;
      }
      // Serialize per connection so async hello/verify never reorders audio.
      conn.queue = conn.queue
        .then(() => this._handleMessage(conn, data, isBinary))
        .catch((error) => this._log({ type: "handler_error", sessionId: conn.sessionId, message: String(error?.message ?? error) }));
    });
    socket.on("close", () => {
      if (conn.helloTimer) clearTimeout(conn.helloTimer);
      if (conn.session) conn.session.lastActiveAt = Date.now();
      this._conns.delete(conn);
      this._disposeEngine(conn);
    });
    socket.on("error", (error) => {
      this._log({ type: "socket_error", sessionId: conn.sessionId, message: String(error?.message ?? error) });
    });

    // Capabilities are announced on connect (not after hello) so a slow token
    // check cannot delay the client's socket-first/legacy-HTTP decision. No
    // session exists yet, so _sendFrame stamps the reserved PRE_HELLO_SEQ.
    this._sendFrame(conn, {
      type: "session.state",
      data: { capabilities: [...SERVER_CAPABILITIES] },
    });
  }

  async _handleMessage(conn, data, isBinary) {
    if (conn.socket.readyState !== OPEN) return;
    const bytes = asBytes(data);

    let text = null;
    if (!isBinary) {
      text = typeof data === "string" ? data : TEXT_DECODER.decode(bytes);
    } else if (bytes.length > 0 && bytes[0] === 0x7b) {
      // Defensive: some runtimes deliver text frames flagged as binary.
      const rep = TEXT_DECODER.decode(bytes);
      if (parseFrame(rep)) text = rep;
    }

    if (text !== null) {
      const frame = parseFrame(text);
      if (!frame) {
        this._log({ type: "bad_frame", sessionId: conn.sessionId });
        return;
      }
      await this._handleControl(conn, frame);
      return;
    }
    await this._handleAudio(conn, bytes);
  }

  async _handleControl(conn, frame) {
    switch (frame.type) {
      case "hello":
        await this._handleHello(conn, frame);
        return;
      case "finalize": {
        const streamIdx = resolveStream(frame.stream);
        if (streamIdx === null) {
          this._log({ type: "bad_stream", sessionId: conn.sessionId, frame: "finalize" });
          return;
        }
        try {
          await conn.engine?.onFinalize?.({ streamIdx });
        } catch (error) {
          this._log({ type: "engine_error", sessionId: conn.sessionId, where: "onFinalize", message: String(error?.message ?? error) });
        }
        return;
      }
      case "turn_hint": {
        // Client VAD "probable end of turn" / "resumed": a speculation signal
        // only (the segment still closes on `finalize`). Never buffered.
        const streamIdx = resolveStream(frame.stream);
        if (streamIdx === null || !TURN_HINT_STATES.includes(frame.state)) {
          this._log({ type: "bad_turn_hint", sessionId: conn.sessionId });
          return;
        }
        try {
          await conn.engine?.onTurnHint?.({ streamIdx, state: frame.state });
        } catch (error) {
          this._log({ type: "engine_error", sessionId: conn.sessionId, where: "onTurnHint", message: String(error?.message ?? error) });
        }
        return;
      }
      case "answer_request":
        try {
          await conn.engine?.onAnswerRequest?.({
            utterance: frame.utterance ?? "",
            intent: frame.intent ?? null,
            gateSeq: frame.gate_seq,
          });
        } catch (error) {
          this._log({ type: "engine_error", sessionId: conn.sessionId, where: "onAnswerRequest", message: String(error?.message ?? error) });
        }
        return;
      case "screen_analyse":
        // Deliberately not awaited: the queue keeps carrying audio while the
        // vision call runs; the result is sent whenever it lands.
        void this._handleScreenAnalyse(conn, frame).catch((error) =>
          this._log({ type: "handler_error", sessionId: conn.sessionId, message: String(error?.message ?? error) }),
        );
        return;
      case "set_capture_auth":
        conn.captureAuthorized = !!frame.authorized;
        try {
          await conn.engine?.onCaptureAuth?.(conn.captureAuthorized);
        } catch (error) {
          this._log({ type: "engine_error", sessionId: conn.sessionId, where: "onCaptureAuth", message: String(error?.message ?? error) });
        }
        return;
      case "session_context": {
        // The rep's grounding document. The engine is created per hello, so a
        // frame before hello has nowhere to go: the client re-sends it after
        // every session.state that advertises the capability.
        if (!conn.hello || !conn.engine) {
          this._log({ type: "context_before_hello", sessionId: conn.sessionId });
          return;
        }
        const docs = frame.docs;
        if (typeof docs !== "string" || docs.length > MAX_SESSION_CONTEXT_CHARS) {
          this._log({
            type: "bad_session_context",
            sessionId: conn.sessionId,
            chars: typeof docs === "string" ? docs.length : null,
          });
          return;
        }
        const name = typeof frame.name === "string" ? frame.name.slice(0, MAX_CONTEXT_NAME_CHARS) : "";
        try {
          await conn.engine.onContextSet?.({ docs, name });
        } catch (error) {
          this._log({ type: "engine_error", sessionId: conn.sessionId, where: "onContextSet", message: String(error?.message ?? error) });
        }
        // Length only: the text is the rep's private document.
        this._log({ type: "session_context", sessionId: conn.sessionId, chars: docs.length });
        return;
      }
      case "screen_clear":
        // Clear: the engine drops its screen context (and a screen answer
        // still streaming). No payload; never buffered.
        try {
          await conn.engine?.onScreenClear?.();
        } catch (error) {
          this._log({ type: "engine_error", sessionId: conn.sessionId, where: "onScreenClear", message: String(error?.message ?? error) });
        }
        return;
      case "ping":
        this._sendFrame(conn, { type: "pong" });
        return;
      default:
        this._log({ type: "unknown_frame", sessionId: conn.sessionId, frameType: frame.type });
    }
  }

  async _handleHello(conn, frame) {
    if (conn.hello) {
      this._log({ type: "duplicate_hello", sessionId: conn.sessionId });
      return;
    }

    let authorized = false;
    try {
      authorized = !!(await this.verifyToken(frame.jwt, frame));
    } catch (error) {
      this._log({ type: "auth_error", message: String(error?.message ?? error) });
    }
    if (!authorized) {
      // Close 4401 ONLY: a `session.ended` frame would latch the client
      // terminal and make the documented refresh-then-retry grace
      // unreachable. Nothing of the session is replayed to this peer.
      this._log({ type: "auth_failed", sessionId: frame.session_id });
      this._rejectUnauthorized(conn);
      return;
    }

    const sessionId = typeof frame.session_id === "string" ? frame.session_id : "";
    if (!sessionId) {
      this._log({ type: "bad_hello", reason: "missing session_id" });
      this._endConnectionWith(conn, "bad_hello");
      return;
    }

    // A hello WITHOUT `last_seen_seq` is a fresh session (protocol.md): the
    // client restarted its uplink seq at 0, so stale per-stream accounting
    // from an earlier session under the same id would drop every frame as a
    // duplicate. Resuming clients always echo last_seen_seq (the pre-hello
    // session.state alone gives them seq 0), so only true restarts reset.
    const fresh = !Number.isFinite(frame.last_seen_seq);
    this._pruneSessions();
    const session = this._getSession(sessionId, { fresh });
    session.lastActiveAt = Date.now();
    conn.sessionId = sessionId;
    conn.session = session;
    conn.captureAuthorized = !!frame.capture_authorized;
    conn.hello = true;
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }

    // `last_seen_seq` is the highest DOWNLINK frame seq the client has seen
    //. Absent = fresh session: nothing to replay.
    const lastSeenSeq = Number.isFinite(frame.last_seen_seq)
      ? frame.last_seen_seq >>> 0
      : -1;

    let engine;
    try {
      engine = this.createEngine({
        emit: (out) => this._sendFrame(conn, out),
        log: this._log,
      });
    } catch (error) {
      this._log({ type: "engine_create_failed", sessionId, message: String(error?.message ?? error) });
      this._endConnectionWith(conn, "engine_error");
      return;
    }
    conn.engine = engine;

    try {
      await engine.onSessionStart?.({
        sessionId,
        streams: Array.isArray(frame.streams) ? frame.streams : [],
        captureAuthorized: conn.captureAuthorized,
        lastSeenSeq: lastSeenSeq >= 0 ? lastSeenSeq : undefined,
      });
    } catch (error) {
      this._log({ type: "engine_error", sessionId, where: "onSessionStart", message: String(error?.message ?? error) });
    }

    // Downlink replay: re-send verbatim (same seq) every frame this
    // session produced while the client was away. Uplink audio is never
    // replayed by the server — the client's own gap ring covers that.
    if (lastSeenSeq >= 0) {
      for (const entry of session.downlinkRing) {
        if (entry.seq > lastSeenSeq) this._writeRaw(conn, entry.raw);
      }
    }
  }

  async _handleAudio(conn, bytes) {
    if (bytes.byteLength < FRAME_HEADER_BYTES) {
      this._log({ type: "short_frame", sessionId: conn.sessionId, bytes: bytes.byteLength });
      return;
    }
    if (!conn.hello || !conn.engine || !conn.session) {
      this._log({ type: "audio_before_hello", sessionId: conn.sessionId });
      return;
    }

    const { streamIdx, seq, pcm } = decodeAudioFrame(bytes);
    const source = STREAM_TO_SOURCE[streamIdx];
    if (source === undefined) {
      this._log({ type: "unknown_stream", sessionId: conn.sessionId, streamIdx });
      return;
    }

    const session = conn.session;
    const previous = session.lastSeq[streamIdx];
    const isNew = previous === undefined || seq > previous;
    if (isNew) {
      if (previous !== undefined && seq > previous + 1) {
        session.gapCount += 1;
        // The client's ring dropped audio (or the link swallowed it): tell ops
        // exactly how much so loss is measurable, not mysterious.
        this._log({
          type: "gap",
          sessionId: session.id,
          streamIdx,
          expected: (previous + 1) >>> 0,
          got: seq,
          missing: seq - previous - 1,
        });
      }
      session.lastSeq[streamIdx] = seq;
    } else {
      // Duplicate after a half-open resend: account for it and drop it.
      this._log({ type: "dup", sessionId: session.id, streamIdx, seq });
      return;
    }

    try {
      await conn.engine.onAudio?.({
        streamIdx,
        seq,
        source,
        pcm16: toInt16(pcm),
        timestampMs: Date.now(),
      });
    } catch (error) {
      this._log({ type: "engine_error", sessionId: session.id, where: "onAudio", message: String(error?.message ?? error) });
    }
  }

  async _handleScreenAnalyse(conn, frame) {
    if (conn.screenJobs.size >= MAX_INFLIGHT_SCREEN) {
      this._sendScreenResult(conn, frame, { status: "failed", error: "busy", solve: "busy" });
      return;
    }
    // Resolve the referenced upload: only objects of THIS session are visible.
    const stored =
      typeof frame.object_path === "string" ? conn.session?.objects?.get(frame.object_path) : undefined;
    const controller = new AbortController();
    conn.screenJobs.add(controller);
    const request = {
      signal: controller.signal,
      ...(stored ? { imageBytes: stored.bytes } : {}),
      commandId: frame.command_id,
      purpose: frame.purpose,
      origin: frame.origin,
      imageHash: frame.image_hash,
      objectPath: frame.object_path,
      contentType: frame.content_type,
      sessionId: conn.sessionId,
    };
    let result = null;
    let timer = null;
    try {
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          this._log({ type: "screen_timeout", sessionId: conn.sessionId, commandId: frame.command_id });
          resolve({ status: "failed", error: "analysis_timeout" });
        }, this.screenAnalyseTimeoutMs);
      });
      result = await Promise.race([Promise.resolve(conn.engine?.onScreenAnalyse?.(request)), deadline]);
    } catch (error) {
      this._log({ type: "engine_error", sessionId: conn.sessionId, where: "onScreenAnalyse", message: String(error?.message ?? error) });
      result = { status: "failed", error: "engine_error" };
    } finally {
      clearTimeout(timer);
      conn.screenJobs.delete(controller);
    }
    if (controller.signal.aborted && !result) return; // connection went away
    if (!result) result = { status: "failed", error: "no_engine" };
    this._sendScreenResult(conn, frame, result);
  }

  _sendScreenResult(conn, frame, result) {
    const commandId = frame.command_id ?? result.command_id ?? null;
    // Wire shape: string fields + a closed status set. Transport-level
    // failures (`upload`/`timeout`/`unreachable`) never cross the wire — those
    // tags are assigned client-side. An invalid engine status is coerced to a
    // typed failure rather than a bogus success.
    const status = SCREEN_STATUSES.includes(result.status) ? result.status : "failed";
    this._sendFrame(conn, {
      type: "screen.result",
      data: {
        command_id: commandId,
        analysis_id: str(result.analysisId),
        status,
        kind: str(result.kind),
        title: str(result.title),
        summary: str(result.summary),
        error: status === "failed" ? str(result.error || result.failure || "analysis_failed") : str(result.error),
        dedup: result.dedup === true,
        stub: result.stub === true,
        solve: str(result.solve) || "not_requested",
      },
    });
  }

  // ---------------------------------------------------------------------------
  // session bookkeeping
  // ---------------------------------------------------------------------------

  _getSession(sessionId, { fresh = false } = {}) {
    let session = this._sessions.get(sessionId);
    if (!session || fresh) {
      session = {
        id: sessionId,
        downlinkRing: [],
        downlinkSeq: FIRST_SESSION_SEQ,
        lastSeq: {},
        gapCount: 0,
        objects: new Map(),
      };
      this._sessions.set(sessionId, session);
    }
    return session;
  }

  // ---------------------------------------------------------------------------
  // HTTP control plane: screen upload mint + signed PUT
  // ---------------------------------------------------------------------------

  async _onHttpRequest(req, res) {
    if (!this._hostAllowed(req.headers.host)) {
      this._log({ type: "host_rejected", host: String(req.headers.host), path: req.url });
      sendJson(res, 403, { error: "forbidden_host" });
      return;
    }
    if (!this._originAllowed(req.headers.origin)) {
      this._log({ type: "origin_rejected", origin: String(req.headers.origin), path: req.url });
      sendJson(res, 403, { error: "forbidden_origin" });
      return;
    }
    const path = String(req.url ?? "").split("?")[0];
    const mint = UPLOADS_ROUTE.exec(path);
    if (mint && req.method === "POST") {
      await this._handleMint(req, res, decodeURIComponent(mint[1]));
      return;
    }
    const put = PUT_ROUTE.exec(path);
    if (put && req.method === "PUT") {
      await this._handleUploadPut(req, res, put[1]);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  }

  /** `POST v3/sessions/{id}/screen/uploads` -> `{object_path, upload_url}`. */
  async _handleMint(req, res, sessionId) {
    const auth = String(req.headers.authorization ?? "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let authorized = false;
    try {
      authorized = !!(await this.verifyToken(token, { session_id: sessionId, transport: "http" }));
    } catch (error) {
      this._log({ type: "auth_error", message: String(error?.message ?? error) });
    }
    if (!authorized) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const session = this._sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "session_not_found" });
      return;
    }
    let body;
    try {
      body = JSON.parse(TEXT_DECODER.decode(await readBody(req, MAX_JSON_BYTES)));
    } catch {
      sendJson(res, 400, { error: "bad_json" });
      return;
    }
    const imageHash = typeof body?.image_hash === "string" ? body.image_hash.toLowerCase() : "";
    const contentType = typeof body?.content_type === "string" ? body.content_type.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(imageHash) || !UPLOAD_CONTENT_TYPES.has(contentType)) {
      sendJson(res, 400, { error: "bad_mint_request" });
      return;
    }
    this._pruneUploads();
    const grant = randomBytes(24).toString("base64url");
    const objectPath = `sessions/${sessionId}/screen/${imageHash}`;
    // Hash-first: objects are content-addressed, so an identical screenshot
    // (unchanged screen, hotkey spam) is already stored. Say so and let the
    // client skip the PUT. upload_url is still minted so a client that
    // predates `exists` keeps working (it just uploads again).
    const stored = session.objects.get(objectPath);
    if (stored) {
      session.objects.delete(objectPath);
      session.objects.set(objectPath, stored); // refresh recency
    }
    // Bounded outstanding grants per session. Evict the session's oldest
    // rather than refusing: a hash-first `exists` answer leaves its grant
    // unused until it expires, and hotkey spam must not start failing.
    const mine = [...this._uploads].filter(([, entry]) => entry.sessionId === sessionId);
    for (let i = 0; i <= mine.length - MAX_OBJECTS_PER_SESSION; i += 1) this._uploads.delete(mine[i][0]);
    this._uploads.set(grant, {
      sessionId,
      objectPath,
      imageHash,
      contentType,
      expiresAt: Date.now() + UPLOAD_TTL_MS,
    });
    sendJson(res, 200, {
      object_path: objectPath,
      upload_url: `http://127.0.0.1:${this._boundPort}/v3/uploads/${grant}`,
      ...(stored && { exists: true }),
    });
  }

  /** Signed PUT: the unguessable one-shot grant in the URL is the credential. */
  async _handleUploadPut(req, res, grant) {
    const entry = this._uploads.get(grant);
    this._uploads.delete(grant); // one-shot
    if (!entry || entry.expiresAt < Date.now()) {
      sendJson(res, 403, { error: "upload_grant_invalid" });
      return;
    }
    // The body must be declared as the type that was minted (parameters such
    // as "; charset" are ignored). Magic bytes are checked where bytes leave
    // the process (engines/vision.js), the only place a mislabel matters.
    const declared = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (declared !== entry.contentType) {
      sendJson(res, 415, { error: "content_type_mismatch" });
      return;
    }
    let bytes;
    try {
      bytes = await readBody(req, MAX_UPLOAD_BYTES);
    } catch {
      sendJson(res, 413, { error: "upload_too_large" });
      return;
    }
    // Integrity: the object must be the image the mint was issued for.
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.imageHash) {
      sendJson(res, 400, { error: "hash_mismatch" });
      return;
    }
    const session = this._sessions.get(entry.sessionId);
    if (!session) {
      sendJson(res, 404, { error: "session_not_found" });
      return;
    }
    session.objects.set(entry.objectPath, { bytes, contentType: entry.contentType });
    while (session.objects.size > MAX_OBJECTS_PER_SESSION) {
      session.objects.delete(session.objects.keys().next().value);
    }
    sendJson(res, 200, { object_path: entry.objectPath });
  }

  /** Drop sessions nobody is connected to once they have idled past sessionIdleMs. */
  _pruneSessions() {
    const cutoff = Date.now() - this.sessionIdleMs;
    const live = new Set();
    for (const conn of this._conns) if (conn.session) live.add(conn.session);
    for (const [id, session] of this._sessions) {
      if (live.has(session) || (session.lastActiveAt ?? 0) > cutoff) continue;
      this._sessions.delete(id);
      for (const [grant, entry] of this._uploads) if (entry.sessionId === id) this._uploads.delete(grant);
    }
  }

  _pruneUploads() {
    const now = Date.now();
    for (const [grant, entry] of this._uploads) {
      if (entry.expiresAt < now) this._uploads.delete(grant);
    }
  }

  /** Bounded history of downlink frames for last_seen_seq replay. */
  _pushDownlink(session, entry) {
    session.downlinkRing.push(entry);
    while (session.downlinkRing.length > this.replayBufferSize) session.downlinkRing.shift();
  }

  // ---------------------------------------------------------------------------
  // outbound + shutdown
  // ---------------------------------------------------------------------------

  _sendFrame(conn, frame) {
    if (!frame || typeof frame.type !== "string") return;
    if (conn.ended) return;
    const socket = conn.socket;
    if (!socket || socket.readyState !== OPEN) return;
    const { type, ...fields } = frame;
    // Downlink frames carry a session-scoped top-level `seq`: the
    // client echoes the highest it has seen as `last_seen_seq`, and the
    // session ring can then replay exactly what it missed.
    let raw;
    if (conn.session) {
      const seq = conn.session.downlinkSeq++;
      raw = makeFrame(type, { ...fields, seq });
      this._pushDownlink(conn.session, { seq, raw });
    } else {
      // Pre-hello (capability announcement): not part of the session's
      // replayable history, but still seq-stamped per protocol.md.
      raw = makeFrame(type, { ...fields, seq: PRE_HELLO_SEQ });
    }
    this._writeRaw(conn, raw);
    if (type === "session.ended") {
      conn.ended = true;
      try {
        socket.close(CLOSE_SESSION_ENDED, "session ended");
      } catch {
        /* peer already gone */
      }
    }
  }

  /** Write pre-serialized bytes (used verbatim by last_seen_seq replay). */
  _writeRaw(conn, raw) {
    const socket = conn.socket;
    if (!socket || socket.readyState !== OPEN) return;
    try {
      socket.send(raw);
    } catch (error) {
      this._log({ type: "send_error", sessionId: conn.sessionId, message: String(error?.message ?? error) });
    }
  }

  /** Terminal hand-off: engine gets onSessionEnd, client always gets session.ended. */
  _endConnectionWith(conn, reason) {
    if (!conn.ended) {
      try {
        conn.engine?.onSessionEnd?.();
      } catch (error) {
        this._log({ type: "engine_error", sessionId: conn.sessionId, where: "onSessionEnd", message: String(error?.message ?? error) });
      }
      this._sendFrame(conn, { type: "session.ended", data: { reason } });
    }
    conn.ended = true;
    try {
      conn.socket.close(closeCodeFor(reason), reason);
    } catch {
      /* peer already gone */
    }
  }

  /** Auth failure: close 4401 without a terminal `session.ended` frame. */
  _rejectUnauthorized(conn) {
    conn.ended = true;
    try {
      conn.socket.close(CLOSE_AUTH, "unauthorized");
    } catch {
      /* peer already gone */
    }
  }

  _disposeEngine(conn) {
    // In-flight vision calls belong to this connection: stop paying for them.
    for (const job of conn.screenJobs ?? []) job.abort();
    conn.screenJobs?.clear();
    const engine = conn.engine;
    conn.engine = null;
    if (!engine) return;
    try {
      engine.dispose?.();
    } catch (error) {
      this._log({ type: "engine_error", sessionId: conn.sessionId, where: "dispose", message: String(error?.message ?? error) });
    }
  }

  async _endConnection(conn, reason) {
    if (!conn.ended) {
      try {
        conn.engine?.onSessionEnd?.();
      } catch (error) {
        this._log({ type: "engine_error", sessionId: conn.sessionId, where: "onSessionEnd", message: String(error?.message ?? error) });
      }
      this._sendFrame(conn, { type: "session.ended", data: { reason } });
    }
    conn.ended = true;
    await this._closeSocket(conn.socket, closeCodeFor(reason));
    this._disposeEngine(conn);
    this._conns.delete(conn);
  }

  _closeSocket(socket, code = 1000) {
    return new Promise((resolve) => {
      if (!socket || socket.readyState === CLOSED) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          socket.terminate?.();
        } catch {
          /* already gone */
        }
        finish();
      }, SOCKET_CLOSE_GRACE_MS);
      socket.once("close", finish);
      try {
        socket.close(code, "server shutdown");
      } catch {
        finish();
      }
    });
  }
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Bounded body reader: rejects as soon as the limit is crossed. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const out = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(out);
    });
    req.on("error", reject);
  });
}
