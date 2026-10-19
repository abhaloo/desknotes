import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  hashImage,
  ScreenCapture,
  ScreenAnalyser,
  SCREEN_RESULT_TIMEOUT_MS,
} from "../src/vision/index.js";
import { SCREEN_MAX_WIDTH, SCREEN_JPEG_QUALITY } from "../src/shared/protocol.js";

/* ------------------------------- fakes ---------------------------------- */

function makeTransport({ capabilities = [], send } = {}) {
  const caps = new Set(capabilities);
  const listeners = new Set();
  const sent = [];
  const transport = {
    sent,
    hasCapability: (name) => caps.has(name),
    sendScreenAnalyse: (command) => {
      sent.push(command);
      if (send) return send(command, transport);
      return true;
    },
    onScreenResult: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    pushResult: (result) => {
      for (const cb of [...listeners]) cb(result);
    },
  };
  return transport;
}

function makeHttp({ mint, analyse, upload } = {}) {
  const calls = [];
  return {
    calls,
    post: async (path, opts = {}) => {
      calls.push({ path, opts });
      if (path.endsWith("/screen/uploads")) return (mint ?? (() => ({ object_path: "objects/abc", upload_url: "https://signed" })))();
      if (path.endsWith("/screen")) return (analyse ?? (() => ({ status: "ok", kind: "other", title: "", summary: "", error: "", dedup: false, solve: "not_requested" })))();
      return (upload ?? (() => ({})))();
    },
    put: async (path, opts = {}) => {
      calls.push({ path, opts });
      return {};
    },
  };
}

function jpegBytes(...values) {
  return new Uint8Array(values);
}

function nativeImage(width, height, journal) {
  return {
    getSize: () => ({ width, height }),
    resize: ({ width: w }) => {
      journal?.resizes.push([width, w]);
      return nativeImage(w, height, journal);
    },
    toJPEG: (quality) => {
      journal?.qualities.push(quality);
      return jpegBytes(0xff, 0xd8, width & 0xff, height & 0xff);
    },
  };
}

const IMAGE_A = jpegBytes(1, 2, 3, 4);
const IMAGE_B = jpegBytes(9, 9, 9);

/* ------------------------------ hashImage -------------------------------- */

test("hashImage is a stable sha256 hex digest", () => {
  assert.equal(hashImage(IMAGE_A), createHash("sha256").update(IMAGE_A).digest("hex"));
  assert.equal(hashImage(IMAGE_A), hashImage(IMAGE_A));
});

test("hashImage differs for different pixels", () => {
  assert.notEqual(hashImage(IMAGE_A), hashImage(IMAGE_B));
});

/* ----------------------------- ScreenCapture ----------------------------- */

test("ScreenCapture returns null when no capture source is injected", async () => {
  const capture = new ScreenCapture({});
  assert.equal(await capture.capture(), null);
});

test("ScreenCapture scales oversized thumbnails to maxWidth and encodes JPEG at quality 85", async () => {
  const journal = { resizes: [], qualities: [] };
  const capture = new ScreenCapture({
    desktopCapturer: {
      getSources: async () => [
        { id: "1", thumbnail: nativeImage(4000, 2000, journal) },
      ],
    },
  });
  const shot = await capture.capture();
  assert.deepEqual(journal.resizes, [[4000, SCREEN_MAX_WIDTH]]);
  assert.deepEqual(journal.qualities, [SCREEN_JPEG_QUALITY]);
  assert.equal(shot.contentType, "image/jpeg");
  assert.ok(shot.bytes.byteLength > 0);
});

test("ScreenCapture passes through already-encoded frames", async () => {
  const journal = { resizes: [], qualities: [] };
  const capture = new ScreenCapture({
    desktopCapturer: { getSources: async () => [{ id: "1", thumbnail: nativeImage(800, 600, journal) }] },
  });
  await capture.capture();
  assert.deepEqual(journal.resizes, [], "small frames are not resized");
  assert.deepEqual(journal.qualities, [SCREEN_JPEG_QUALITY]);
});

test("ScreenCapture selects the requested display by id and does not upscale small frames", async () => {
  const journal = { resizes: [], qualities: [] };
  const capture = new ScreenCapture({
    desktopCapturer: {
      getSources: async () => [
        { id: "1", thumbnail: nativeImage(100, 100, journal) },
        { id: "2", thumbnail: nativeImage(200, 200, journal) },
      ],
    },
  });
  const shot = await capture.capture({ display: { id: "2" } });
  assert.equal(shot.width, 200);
  assert.deepEqual(journal.resizes, []);
});

test("ScreenCapture returns null on capture errors and empty source lists", async () => {
  const boom = new ScreenCapture({ desktopCapturer: { getSources: async () => { throw new Error("denied"); } } });
  assert.equal(await boom.capture(), null);
  const empty = new ScreenCapture({ desktopCapturer: { getSources: async () => [] } });
  assert.equal(await empty.capture(), null);
});

/* ------------------------- socket-first analysis ------------------------- */

test("socket path: mint + upload first, command references the object path", async () => {
  const transport = makeTransport({
    capabilities: ["screen_analyse"],
    send: (command, self) => {
      // Async delivery: results must join a waiter registered before the send.
      setTimeout(() => {
        self.pushResult({
          command_id: command.commandId,
          analysis_id: "an-1",
          status: "ok",
          kind: "question",
          title: "T",
          summary: "structured answer",
          error: "",
          dedup: false,
          solve: "solving",
        });
      }, 5);
      return true;
    },
  });
  const http = makeHttp();
  const analyser = new ScreenAnalyser({ transport, http, sessionIdProvider: () => "session-9" });
  const result = await analyser.analyse({ bytes: IMAGE_A, purpose: "question", origin: "hotkey" });

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].imageHash, hashImage(IMAGE_A));
  assert.equal(transport.sent[0].objectPath, "objects/abc");
  assert.equal(transport.sent[0].purpose, "question");
  assert.equal(transport.sent[0].origin, "hotkey");
  // Mint goes to the session-scoped uploads endpoint.
  assert.ok(http.calls.some((c) => c.path === "v3/sessions/session-9/screen/uploads"));
  assert.ok(http.calls.some((c) => c.path === "https://signed"), "bytes PUT to the signed URL");

  assert.equal(result.status, "ok");
  assert.equal(result.kind, "question");
  assert.equal(result.analysisId, "an-1");
  assert.equal(result.summary, "structured answer");
  assert.equal(result.solve, "solving");
  assert.equal(result.dedup, false);
  analyser.close();
});

test("socket path: missing screen.result times out into a typed string failure", async () => {
  const transport = makeTransport({ capabilities: ["screen_analyse"] });
  const analyser = new ScreenAnalyser({ transport, http: makeHttp(), timeoutMs: 25 });
  const result = await analyser.analyse({ bytes: IMAGE_A });

  assert.equal(transport.sent.length, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.failure, "timeout", "failure is a string tag, not an object");
  assert.equal(result.solve, "not_requested");
  assert.equal(result.dedup, false);
  analyser.close();
});

test("socket path: an upload failure aborts before any command is sent", async () => {
  const transport = makeTransport({ capabilities: ["screen_analyse"] });
  const http = makeHttp({ mint: () => { throw new Error("mint refused"); } });
  const analyser = new ScreenAnalyser({ transport, http, timeoutMs: 25 });
  const result = await analyser.analyse({ bytes: IMAGE_A });

  assert.equal(transport.sent.length, 0, "a command referencing a missing object is never sent");
  assert.equal(result.status, "failed");
  assert.equal(result.failure, "upload");
  analyser.close();
});

test("socket path: a malformed screen.result is ignored and times out (no fake success)", async () => {
  const transport = makeTransport({
    capabilities: ["screen_analyse"],
    send: (command, self) => {
      setTimeout(() => self.pushResult({ command_id: command.commandId }), 5); // empty `{}`
      return true;
    },
  });
  const analyser = new ScreenAnalyser({ transport, http: makeHttp(), timeoutMs: 40 });
  const result = await analyser.analyse({ bytes: IMAGE_A });
  assert.equal(result.status, "failed");
  assert.equal(result.failure, "timeout");
  analyser.close();
});

test("socket path: late duplicate results after a timeout are ignored (waiter cleanup)", async () => {
  const transport = makeTransport({
    capabilities: ["screen_analyse"],
    send: () => true,
  });
  const analyser = new ScreenAnalyser({ transport, http: makeHttp(), timeoutMs: 20 });
  const result = await analyser.analyse({ bytes: IMAGE_A });
  assert.equal(result.failure, "timeout");
  assert.equal(analyser._waiters.size, 0, "the timeout settles and removes the waiter");
  // Late arrival: must not throw or resurrect the settled waiter.
  assert.doesNotThrow(() =>
    transport.pushResult({ command_id: transport.sent[0].commandId, status: "ok", kind: "code", solve: "not_requested" }),
  );
  assert.equal(analyser._waiters.size, 0, "a late duplicate never re-registers a waiter");
  assert.equal(result.status, "failed", "the settled result is not rewritten by the late frame");
  analyser.close();
});

test("repeated identical frames are each sent; dedup is a server verdict", async () => {
  const sends = [];
  const transport = makeTransport({
    capabilities: ["screen_analyse"],
    send: (cmd, self) => {
      sends.push(cmd);
      setTimeout(() => self.pushResult({ command_id: cmd.commandId, status: "ok", kind: "code", dedup: false }), 1);
      return true;
    },
  });
  const analyser = new ScreenAnalyser({ transport, http: makeHttp(), timeoutMs: 500 });
  const first = await analyser.analyse({ bytes: IMAGE_A });
  const second = await analyser.analyse({ bytes: IMAGE_A });
  assert.equal(sends.length, 2, "the client never suppresses a frame from a local cache");
  assert.equal(first.dedup, false);
  assert.equal(second.dedup, false, "the client must not fabricate the dedup flag");
  analyser.close();
});

test("fallback: capability absent -> legacy session-scoped HTTP analyse", async () => {
  const transport = makeTransport({ capabilities: [] });
  const http = makeHttp({
    analyse: () => ({ status: "ok", kind: "question", title: "T", summary: "say this", error: "", dedup: false, solve: "not_requested" }),
  });
  const analyser = new ScreenAnalyser({ transport, http, sessionIdProvider: () => "session-9" });
  const result = await analyser.analyse({ bytes: IMAGE_B, purpose: "context", origin: "manual" });

  assert.equal(transport.sent.length, 0);
  assert.ok(http.calls.some((c) => c.path === "v3/sessions/session-9/screen"));
  assert.equal(result.status, "ok");
  assert.equal(result.summary, "say this");
  analyser.close();
});

test("fallback: refused socket send retries over HTTP exactly once", async () => {
  const transport = makeTransport({ capabilities: ["screen_analyse"], send: () => false });
  const http = makeHttp();
  const analyser = new ScreenAnalyser({ transport, http, sessionIdProvider: () => "s" });
  const result = await analyser.analyse({ bytes: IMAGE_A });

  assert.equal(transport.sent.length, 1);
  // The socket attempt mints its upload first (the wire command references
  // the object path), so a refused send has already cost one mint. The retry
  // itself is exactly once: a single legacy analyse, no second mint.
  assert.deepEqual(
    http.calls.map((c) => c.path),
    ["v3/sessions/s/screen/uploads", "https://signed", "v3/sessions/s/screen"],
  );
  assert.equal(result.status, "ok");
  analyser.close();
});

test("fallback: HTTP error becomes an unreachable failure object, never a throw", async () => {
  const transport = makeTransport({ capabilities: [] });
  const http = makeHttp({ analyse: () => { throw new Error("connection refused"); } });
  const analyser = new ScreenAnalyser({ transport, http, sessionIdProvider: () => "s" });
  const result = await analyser.analyse({ bytes: IMAGE_A });

  assert.equal(result.status, "failed");
  assert.equal(result.failure, "unreachable");
  assert.match(result.error, /connection refused/);
  analyser.close();
});

test("fallback: no channel at all still returns a typed unreachable failure", async () => {
  const analyser = new ScreenAnalyser({ transport: null, http: null });
  const result = await analyser.analyse({ bytes: IMAGE_A });
  assert.equal(result.status, "failed");
  assert.equal(result.failure, "unreachable");
});

test("solve values outside the enum normalize to not_requested", async () => {
  const transport = makeTransport({
    capabilities: ["screen_analyse"],
    send: (cmd, self) => {
      setTimeout(() => self.pushResult({ command_id: cmd.commandId, status: "empty", kind: "", solve: "whatever" }), 1);
      return true;
    },
  });
  const analyser = new ScreenAnalyser({ transport, http: makeHttp() });
  const result = await analyser.analyse({ bytes: IMAGE_A });
  assert.equal(result.status, "empty");
  assert.equal(result.solve, "not_requested");
  analyser.close();
});

test("close() settles outstanding waiters and detaches the subscription", async () => {
  const transport = makeTransport({ capabilities: ["screen_analyse"], send: () => true });
  const analyser = new ScreenAnalyser({ transport, http: makeHttp(), timeoutMs: 60_000 });
  const pending = analyser.analyse({ bytes: IMAGE_A });
  analyser.close();
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.failure, "unreachable", "teardown settles with a typed failure, never a fake result");
});

test("default result timeout is the 60s window", () => {
  assert.equal(SCREEN_RESULT_TIMEOUT_MS, 60_000);
});
