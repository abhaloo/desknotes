/**
 * Client-side screen capture + analysis orchestration for DeskNotes.
 *
 * Design:
 * - The realtime socket is the authoritative analysis channel: the
 *   command is minted, uploaded and referenced per the wire contract, and
 *   the reply arrives as a `screen.result` frame joined by `command_id`.
 * - Upload contract: a JSON mint POST
 *   `v3/sessions/{id}/screen/uploads` `{content_type, image_hash}` returns
 *   `{object_path, upload_url, exists?}`; the bytes then go to the signed URL
 *   with a PUT, unless the server says the content-addressed object already
 *   `exists` (an unchanged screen): then the upload is skipped. The legacy
 *   path is the all-in-one multipart `v3/sessions/{id}/screen`.
 * - A mint/upload failure ABORTS with a typed `upload` failure and sends
 *   nothing: a command referencing an object that does not exist is
 *   worse than no command at all.
 * - Typed failures carry a STRING tag on `result.failure`:
 *   "upload" | "timeout" | "unreachable".
 * - There is NO client-side dedup cache: `dedup` is a server verdict,
 *   and caching client-side poisoned repeat frames with stale failures.
 * - Malformed results are not successes: a frame whose
 *   `status` is not in {ok, empty, failed} is ignored, so the waiter falls
 *   through to the timeout instead of rendering `{}` as "ok".
 */
import { createHash } from "node:crypto";
import {
  CAPABILITIES,
  SCREEN_FAILURES,
  SCREEN_JPEG_QUALITY,
  SCREEN_MAX_WIDTH,
  SCREEN_STATUSES,
  SOLVE_NOT_REQUESTED,
  SOLVE_STATES,
} from "../shared/protocol.js";
import { unrefTimer } from "../shared/timers.js";
import { checkProviderUrl } from "../security/url-policy.js";

export { SCREEN_MAX_WIDTH, SCREEN_JPEG_QUALITY };

/** A screen command may legitimately take a while (larger model, queueing). */
export const SCREEN_RESULT_TIMEOUT_MS = 60_000;

/** Legacy (pre-capability) endpoints. */
export const LEGACY_ANALYSE_PATH = "v3/sessions/:id/screen";
export const LEGACY_UPLOAD_PATH = "v3/sessions/:id/screen/uploads";

/**
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes
 * @returns {string} lowercase hex sha256
 */
export function hashImage(bytes) {
  return createHash("sha256").update(toBytes(bytes)).digest("hex");
}

/**
 * Typed transport failure: `failure` is the string tag consumers
 * switch on; the string fields mirror the wire result so one shape fits all.
 * @param {string} kind one of SCREEN_FAILURES
 * @param {string} [message]
 */
function failure(kind, message = "") {
  if (!SCREEN_FAILURES.includes(kind)) kind = "unreachable";
  return {
    commandId: null,
    analysisId: "",
    status: "failed",
    kind: "",
    title: "",
    summary: "",
    error: message,
    dedup: false,
    solve: SOLVE_NOT_REQUESTED,
    failure: kind,
  };
}

/**
 * Normalize a `screen.result` frame payload. Returns null for malformed
 * frames (wrong/unknown status) so the waiter keeps waiting.
 * @param {object} data
 */
function normalizeResult(data) {
  if (!data || typeof data !== "object") return null;
  const status = typeof data.status === "string" ? data.status : "";
  if (!SCREEN_STATUSES.includes(status)) return null;
  const str = (key) => (typeof data[key] === "string" ? data[key] : "");
  const solve = str("solve");
  return {
    commandId: typeof data.command_id === "string" ? data.command_id : null,
    analysisId: str("analysis_id"),
    status,
    kind: str("kind"),
    title: str("title"),
    summary: str("summary"),
    error: str("error"),
    dedup: data.dedup === true,
    stub: data.stub === true,
    solve: SOLVE_STATES.includes(solve) ? solve : SOLVE_NOT_REQUESTED,
  };
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("expected image bytes");
}

/* ------------------------------ ScreenCapture ----------------------------- */

/**
 * Screenshot capture with fixed sizing constants:
 * maxWidth 1920, JPEG quality 85. The `desktopCapturer` dependency is
 * injected so this is testable without Electron.
 */
export class ScreenCapture {
  constructor({ desktopCapturer = null, maxWidth = SCREEN_MAX_WIDTH, jpegQuality = SCREEN_JPEG_QUALITY } = {}) {
    this.desktopCapturer = desktopCapturer;
    this.maxWidth = maxWidth;
    this.jpegQuality = jpegQuality;
  }

  /**
   * @param {{display?: {id?: string|number}}} [opts]
   * @returns {Promise<{bytes: Uint8Array, contentType: string, width: number, height: number}|null>}
   */
  async capture({ display } = {}) {
    if (!this.desktopCapturer?.getSources) return null;
    try {
      const sources = await this.desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: this.maxWidth, height: this.maxWidth },
      });
      if (!Array.isArray(sources) || sources.length === 0) return null;
      const wanted = display?.id != null ? sources.find((s) => String(s.id) === String(display.id)) : null;
      const source = wanted ?? sources[0];
      const image = source?.thumbnail;
      if (!image) return null;
      const size = image.getSize();
      if (!size?.width || !size?.height) return null;
      const scaled = size.width > this.maxWidth ? image.resize({ width: this.maxWidth }) : image;
      const jpeg = scaled.toJPEG(this.jpegQuality);
      const bytes = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
      return {
        bytes,
        contentType: "image/jpeg",
        width: scaled.getSize().width,
        height: scaled.getSize().height,
      };
    } catch {
      return null;
    }
  }
}

/* --------------------------- control-plane HTTP --------------------------- */

/**
 * Minimal `{ post, put }` transport over `fetch` for the upload contract
 * (protocol.md: JSON mint, then PUT to the signed URL). `baseUrl` is the
 * realtime server root; `ws(s)://` maps to `http(s)://` because the local
 * server serves both planes on one port.
 *
 * The bearer token is attached only to requests on the base origin: a signed
 * upload URL is its own credential and may point elsewhere, so the session
 * token must never travel to it.
 *
 * @param {{baseUrl: string, getToken?: () => string|null, fetchImpl?: Function, timeoutMs?: number}} options
 */
export function createHttpClient({ baseUrl, getToken = () => null, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("createHttpClient requires fetch");
  const root = new URL(String(baseUrl).replace(/^ws(s?):\/\//i, "http$1://"));
  root.pathname = "/";
  root.search = "";
  root.hash = "";
  // The bearer token rides every mint: TLS, or loopback only.
  const rootPolicy = checkProviderUrl(root.href);
  if (!rootPolicy.ok) throw new Error(`createHttpClient: base URL refused (${rootPolicy.reason})`);

  async function request(method, target, { json, body, contentType } = {}) {
    const url = /^https?:\/\//i.test(target) ? new URL(target) : new URL(String(target).replace(/^\/+/, ""), root);
    // A mint answer decides where the screenshot goes: never plaintext to a
    // remote host, never a non-http scheme.
    const policy = checkProviderUrl(url.href);
    if (!policy.ok) throw new Error(`${method} refused: upload URL fails the transport policy (${policy.reason})`);
    const headers = {};
    let payload;
    if (json !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(json);
    } else if (body !== undefined) {
      if (contentType) headers["content-type"] = contentType;
      payload = body;
    }
    const token = url.origin === root.origin ? getToken() : null;
    if (token) headers.authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timer = unrefTimer(setTimeout(() => controller.abort(), timeoutMs));
    try {
      // No redirects: a 30x could replay the bearer or the image elsewhere.
      const response = await fetchImpl(url.href, { method, headers, body: payload, signal: controller.signal, redirect: "error" });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${url.pathname} -> HTTP ${response.status}`);
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    post: (path, opts) => request("POST", path, opts),
    put: (url, opts) => request("PUT", url, opts),
  };
}

/* ------------------------------ ScreenAnalyser ---------------------------- */

let commandSeq = 0;

/**
 * Socket-first screen analysis. See module header for the flow.
 */
export class ScreenAnalyser {
  constructor({
    transport = null,
    http = null,
    sessionIdProvider = null,
    log = null,
    timeoutMs = SCREEN_RESULT_TIMEOUT_MS,
  } = {}) {
    this.transport = transport;
    this.http = http;
    this.sessionIdProvider = typeof sessionIdProvider === "function" ? sessionIdProvider : () => null;
    this.log = typeof log === "function" ? log : () => {};
    this.timeoutMs = timeoutMs;
    this._closed = false;
    this._waiters = new Map(); // command_id -> { resolve, timer }
    this._unsub = null;
  }

  /**
   * @param {{bytes?: Uint8Array, contentType?: string, purpose?: string, origin?: string, imageHash?: string}} request
   * @returns {Promise<object>} normalized result (see normalizeResult / failure)
   */
  async analyse({ bytes, contentType = "image/jpeg", purpose = "context", origin = "manual", imageHash } = {}) {
    if (this._closed) return failure("unreachable", "screen analyser closed");
    const payload = bytes ? toBytes(bytes) : null;
    const hash = imageHash ?? (payload && payload.byteLength > 0 ? hashImage(payload) : null);
    if (!hash) return failure("unreachable", "no screen image supplied for analysis");

    if (this.#socketAvailable()) {
      const viaSocket = await this.#analyseOverSocket({ hash, payload, contentType, purpose, origin });
      if (viaSocket !== null) return viaSocket;
      // The command could not even be sent: retrying through HTTP cannot
      // duplicate server work, so fall through to the legacy path.
    }
    return this.#analyseOverHttp({ hash, payload, contentType, purpose, origin });
  }

  /** Tear down subscriptions/waiters (shell teardown, tests). */
  close() {
    this._closed = true;
    for (const waiter of this._waiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      // Settle as a typed failure: an in-flight command must not fall
      // through to a second transport after teardown.
      waiter.resolve(failure("unreachable", "screen analyser closed"));
    }
    this._waiters.clear();
    if (this._unsub) {
      try {
        this._unsub();
      } catch {
        /* already gone */
      }
      this._unsub = null;
    }
  }

  #socketAvailable() {
    return Boolean(
      this.transport &&
        typeof this.transport.hasCapability === "function" &&
        this.transport.hasCapability(CAPABILITIES.SCREEN_ANALYSE) &&
        typeof this.transport.sendScreenAnalyse === "function",
    );
  }

  #subscribe() {
    if (this._unsub || typeof this.transport?.onScreenResult !== "function") return;
    const unsub = this.transport.onScreenResult((result) => this.#handleScreenResult(result));
    this._unsub = typeof unsub === "function" ? unsub : null;
  }

  #handleScreenResult(raw) {
    const data = raw && typeof raw === "object" && raw.data && typeof raw.data === "object" ? raw.data : raw;
    const normalized = normalizeResult(data);
    // Malformed frame: never resolve a waiter with a bogus success (§4.2) —
    // the timeout path turns it into a typed failure instead.
    if (!normalized) return;
    const commandId = normalized.commandId;
    const waiter = commandId != null ? this._waiters.get(commandId) : null;
    if (!waiter) return; // late duplicate after a timeout: nobody is waiting
    this.#settle(commandId);
    waiter.resolve(normalized);
  }

  #settle(commandId) {
    const waiter = this._waiters.get(commandId);
    if (!waiter) return;
    this._waiters.delete(commandId);
    if (waiter.timer) clearTimeout(waiter.timer);
  }

  async #analyseOverSocket({ hash, payload, contentType, purpose, origin }) {
    this.#subscribe();
    // Counter suffix: the same image analysed twice in one millisecond (hotkey
    // spam on an unchanged screen) must not share a waiter slot.
    const commandId = `cmd_${hash.slice(0, 12)}_${Date.now().toString(36)}_${(++commandSeq).toString(36)}`;

    // Mint + upload first. A failure here aborts the command with a
    // typed `upload` failure — nothing is sent to the server.
    let objectPath;
    try {
      const mint = await this.#mintUpload(hash, contentType);
      // Hash-first: an identical image is already stored server-side; the
      // PUT (hundreds of KB plus a server-side hash check) is pure latency.
      if (!mint.exists) await this.#putBytes(mint.uploadUrl, payload, contentType);
      else this.log({ type: "screen.upload_skipped", imageHash: hash });
      objectPath = mint.objectPath;
    } catch (error) {
      this.log({ type: "screen.upload_failed", message: error?.message ?? String(error) });
      return failure("upload", String(error?.message ?? error));
    }
    // Teardown raced the async mint: never register a waiter after close().
    if (this._closed) return failure("unreachable", "screen analyser closed");

    const outcome = new Promise((resolve) => {
      const timer = unrefTimer(
        setTimeout(() => {
          this.#settle(commandId);
          this.log({ type: "screen.timeout", commandId, timeoutMs: this.timeoutMs });
          resolve(failure("timeout", `no screen.result within ${this.timeoutMs} ms (command ${commandId})`));
        }, this.timeoutMs),
      );
      this._waiters.set(commandId, { resolve, timer });
    });

    const sent = this.transport.sendScreenAnalyse({
      commandId,
      purpose,
      origin,
      imageHash: hash,
      objectPath,
      contentType,
    });
    if (!sent) {
      // The command never left the process: cancel the waiter and let the
      // caller fall back to HTTP.
      this.#settle(commandId);
      return null;
    }
    return await outcome;
  }

  /** Legacy all-in-one multipart analyse (servers without the capability). */
  async #analyseOverHttp({ hash, payload, contentType, purpose, origin }) {
    if (!this.http || typeof this.http.post !== "function") {
      return failure("unreachable", "no analysis transport available");
    }
    const sessionId = this.sessionIdProvider();
    if (!sessionId) return failure("unreachable", "no active session for screen analyse");
    try {
      const response = await this.http.post(`v3/sessions/${encodeURIComponent(sessionId)}/screen`, {
        body: payload,
        contentType,
        purpose,
        origin,
        imageHash: hash,
      });
      const normalized = normalizeResult(response?.data ?? response);
      if (!normalized) return failure("unreachable", "malformed analyse response");
      return normalized;
    } catch (error) {
      // Transport errors are typed `unreachable` failures, never throws: on
      // multi-pod this path 404s off-owner and that must not read as "the
      // screen could not be analysed".
      this.log({ type: "screen.http_failed", message: error?.message ?? String(error) });
      return failure("unreachable", String(error?.message ?? error));
    }
  }

  /** JSON mint -> {object_path, upload_url}. The mint is control-plane
   * HTTP even on the socket path: the command references the uploaded
   * object rather than carrying the bytes. */
  async #mintUpload(imageHash, contentType) {
    if (typeof this.http?.post !== "function") {
      throw new Error("upload transport not configured (no http.post for the control-plane mint)");
    }
    const sessionId = this.sessionIdProvider() ?? "";
    const response = await this.http.post(
      `v3/sessions/${encodeURIComponent(sessionId)}/screen/uploads`,
      { json: { content_type: contentType, image_hash: imageHash } },
    );
    const mint = response?.data ?? response;
    const objectPath = mint?.object_path ?? mint?.objectPath;
    const uploadUrl = mint?.upload_url ?? mint?.uploadUrl;
    if (!objectPath || !uploadUrl) throw new Error("upload mint returned no object_path/upload_url");
    return { objectPath, uploadUrl, exists: mint?.exists === true };
  }

  /** PUT the bytes to the signed URL. */
  async #putBytes(uploadUrl, payload, contentType) {
    if (!payload) throw new Error("no image bytes to upload");
    if (typeof this.http?.put === "function") {
      await this.http.put(uploadUrl, { body: payload, contentType });
      return;
    }
    if (typeof this.http?.post !== "function") {
      throw new Error("upload transport not configured (no http.put for the signed URL)");
    }
    // Minimal fallback transport shape: post to the signed URL.
    await this.http.post(uploadUrl, { body: payload, contentType });
  }
}
