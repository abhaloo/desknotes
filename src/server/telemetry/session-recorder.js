/**
 * Session telemetry recorder: buffered, crash-safe JSONL event logs.
 *
 * WHY: the pipeline records on the realtime hot path, so `record` must never
 * wait on a disk. Events are stamped and buffered in memory, then written in
 * batches by an unref'd timer (plus `flush`/`close`). Every failure — fs or
 * serialization — is contained: one `telemetry.error` entry through the
 * injected `log`, then the recorder no-ops forever. Recording must never
 * break a call.
 *
 * Secrets: callers never put credentials in events. As a second line of
 * defence any field whose key looks credential-shaped is redacted here.
 *
 * Enabled by default; disabled when SESSION_TELEMETRY=0, false, or off.
 * A disabled recorder touches no filesystem.
 */
import * as nodeFs from "node:fs";
import { join } from "node:path";

const META_VERSION = 1;
const MAX_BUFFERED_EVENTS = 20_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 250;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_KEEP_DAYS = 7;
const REDACT_KEY = /key|token|secret|password|auth/i;
const REDACTED = "[redacted]";

/**
 * Recorder options from the environment.
 * @param {Record<string, string|undefined>} [env]
 * @param {{dir?: string}} [options]
 * @returns {{enabled: boolean, dir: string, keepDays: number}}
 */
export function recorderOptionsFromEnv(env = process.env, { dir: defaultDir } = {}) {
  const source = env ?? {};
  const dir =
    typeof source.SESSION_TELEMETRY_DIR === "string" && source.SESSION_TELEMETRY_DIR.length > 0
      ? source.SESSION_TELEMETRY_DIR
      : defaultDir ?? join(process.cwd(), "logs", "telemetry");
  const parsed = Number.parseInt(String(source.SESSION_TELEMETRY_KEEP_DAYS ?? ""), 10);
  const rawSwitch = typeof source.SESSION_TELEMETRY === "string" ? source.SESSION_TELEMETRY.trim().toLowerCase() : "";
  const disabled = rawSwitch === "0" || rawSwitch === "false" || rawSwitch === "off";
  return {
    enabled: !disabled,
    dir,
    keepDays: Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_KEEP_DAYS,
  };
}

/**
 * One recorder per session. `record` buffers; disk work happens on the timer
 * or an explicit flush/close, so the caller's path never blocks.
 * @param {{enabled?: boolean, dir?: string, keepDays?: number, fs?: object,
 *   now?: () => number, log?: Function}} [options]
 * @returns {{record: (event: object) => void, flush: () => Promise<void>, close: () => Promise<void>}}
 */
export function createSessionRecorder({
  enabled = true,
  dir,
  keepDays = DEFAULT_KEEP_DAYS,
  fs = nodeFs,
  now = Date.now,
  log,
} = {}) {
  const logger = typeof log === "function" ? log : () => {};
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const targetDir =
    typeof dir === "string" && dir.length > 0 ? dir : join(process.cwd(), "logs", "telemetry");
  const retentionDays =
    Number.isFinite(keepDays) && keepDays > 0 ? keepDays : DEFAULT_KEEP_DAYS;

  /** "disabled" | "open" | "truncated" | "closed" | "failed" */
  let state = enabled ? "open" : "disabled";
  let timer = null;
  let filePath = null;
  let fileSessionId = null;
  let headerWritten = false;
  let bytesWritten = 0;
  let dropped = 0;
  let buffer = [];
  /** Serializes flushes: appendFile is async and batches must stay ordered. */
  let chain = Promise.resolve();

  if (state === "open") {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      purge();
      timer = setInterval(() => {
        void flush();
      }, FLUSH_INTERVAL_MS);
      if (typeof timer?.unref === "function") timer.unref();
    } catch (error) {
      fail(error);
    }
  }

  /** Delete aged logs before adding another session's file to the directory. */
  function purge() {
    const cutoff = now() - retentionDays * DAY_MS;
    for (const name of fs.readdirSync(targetDir)) {
      if (typeof name !== "string" || !name.endsWith(".jsonl")) continue;
      const path = join(targetDir, name);
      if (fs.statSync(path).mtimeMs < cutoff) fs.unlinkSync(path);
    }
  }

  function fail(error) {
    if (state === "failed") return;
    const wasActive = state !== "disabled";
    state = "failed";
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    buffer = [];
    if (wasActive) {
      try {
        logger({ type: "telemetry.error", message: String(error?.message ?? error) });
      } catch {
        /* the log hook must not turn a contained failure into a throw */
      }
    }
  }

  /** Stamp every credential-shaped key, at any depth, without mutating the event. */
  function redact(value) {
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = REDACT_KEY.test(key) ? REDACTED : redact(item);
      }
      return out;
    }
    return value;
  }

  /** The session id as a file-name part: the id comes off the wire, so no separators or dots. */
  function label(sessionId) {
    const safe = typeof sessionId === "string" ? sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) : "";
    return safe.length > 0 ? safe : "nosession";
  }

  /**
   * The file is named at the first record, when the sessionId is known first;
   * a null sessionId is acceptable and names the file "nosession".
   */
  function record(event) {
    try {
      if (state !== "open" && state !== "truncated") return;
      if (state === "truncated") {
        dropped += 1;
        return;
      }
      const source = event && typeof event === "object" ? event : {};
      const at = now();
      if (filePath === null) {
        fileSessionId = source.sessionId ?? null;
        filePath = join(targetDir, `${startedAt.replaceAll(":", "-")}-${label(fileSessionId)}.jsonl`);
      }
      buffer.push(
        `${JSON.stringify({
          ...redact(source),
          sessionId: source.sessionId ?? null,
          ts: new Date(at).toISOString(),
          monoMs: at - startedAtMs,
        })}\n`,
      );
      while (buffer.length > MAX_BUFFERED_EVENTS) {
        buffer.shift();
        dropped += 1;
      }
    } catch (error) {
      fail(error);
    }
  }

  async function append(payload) {
    // node:fs.appendFile is callback-style; prefer its promise API. An
    // injected fake may instead expose a promise-returning appendFile or a
    // sync appendFileSync (tests inject either).
    const promised = fs.promises && typeof fs.promises.appendFile === "function" ? fs.promises.appendFile : null;
    if (promised) {
      await promised.call(fs.promises, filePath, payload);
      return;
    }
    if (typeof fs.appendFile === "function") {
      await fs.appendFile(filePath, payload);
      return;
    }
    if (typeof fs.appendFileSync === "function") {
      fs.appendFileSync(filePath, payload);
      return;
    }
    throw new Error("appendFile is not available");
  }

  /** Take a snapshot of the buffer and write it, meta first, within the cap. */
  async function writeBatch() {
    if (state !== "open") return; // failed/closed: no write may happen after the failure
    if (filePath === null) {
      if (buffer.length === 0) return; // nothing recorded yet: no file
      fileSessionId = null;
      filePath = join(targetDir, `${startedAt.replaceAll(":", "-")}-nosession.jsonl`);
    }
    const pending = buffer;
    buffer = [];
    const droppedNow = dropped;
    dropped = 0;

    const parts = [];
    if (!headerWritten) {
      headerWritten = true;
      parts.push(
        `${JSON.stringify({
          type: "telemetry.meta",
          version: META_VERSION,
          sessionId: fileSessionId,
          startedAt,
          keepDays: retentionDays,
        })}\n`,
      );
    }
    if (droppedNow > 0) {
      parts.push(`${JSON.stringify({ type: "telemetry.dropped", count: droppedNow })}\n`);
    }

    let batchBytes = Buffer.byteLength(parts.join(""), "utf8");
    let index = 0;
    for (; index < pending.length; index += 1) {
      const size = Buffer.byteLength(pending[index], "utf8");
      if (bytesWritten + batchBytes + size > MAX_FILE_BYTES) break;
      parts.push(pending[index]);
      batchBytes += size;
    }

    if (index < pending.length) {
      // At the cap: mark the file final, stop accepting new events. The
      // events that did not fit were accepted but never written, so they
      // count as dropped like every record after the cap.
      dropped += pending.length - index;
      state = "truncated";
      parts.push(`${JSON.stringify({ type: "telemetry.truncated", ts: new Date(now()).toISOString() })}\n`);
    }

    if (parts.length > 0) {
      await append(parts.join(""));
      bytesWritten += batchBytes;
    }
  }

  /**
   * Append everything buffered; safe to call repeatedly and when disabled.
   * Truncated is terminal: the telemetry.truncated line is the final line of
   * that file, so later flushes must not append a dropped line behind it.
   */
  function flush() {
    if (state !== "open") return Promise.resolve();
    const run = chain.then(writeBatch);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch((error) => fail(error));
  }

  /** Flush and release the timer; safe to call repeatedly and when disabled. */
  function close() {
    if (state !== "open" && state !== "truncated") return Promise.resolve();
    return flush().then(() => {
      if (state === "failed") return;
      state = "closed";
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    });
  }

  return { record, flush, close };
}
