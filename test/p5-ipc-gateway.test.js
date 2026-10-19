import test from "node:test";
import assert from "node:assert/strict";
import {
  IpcGateway,
  IPC,
  QUERY_CHANNELS,
  COMMAND_CHANNELS,
  BROADCAST_CHANNELS,
  ErrorCode,
} from "../src/desktop/ipc-gateway.js";

test("all documented channel names are present", () => {
  const expected = [
    "speech:start",
    "speech:stop",
    "speech:reconnect",
    "speech:disconnect",
    "speech:requestAnswer",
    "speech:transcript:received",
    "speech:status:changed",
    "speech:realtime-status:changed",
    "speech:vad:stats",
    "speech:setVadEnabled",
    "speech:getVadEnabled",
    "speech:getRealtimeStatus",
    "screen:analyse",
    "session:start",
    "session:end",
    "session:captureFullscreen",
    "config:get",
  ];
  const names = new Set([...QUERY_CHANNELS, ...COMMAND_CHANNELS, ...BROADCAST_CHANNELS]);
  for (const channel of expected) assert.ok(names.has(channel), `missing ${channel}`);
});

test("query handlers resolve through an ok envelope", async () => {
  const gateway = new IpcGateway();
  gateway.registerQuery("config:get", () => ({ realtimeUrl: "ws://localhost:8787" }));
  const result = await gateway.handleQuery("config:get", null);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { realtimeUrl: "ws://localhost:8787" });
  assert.equal(gateway.hasQuery("config:get"), true);
  assert.deepEqual(gateway.getChannels(), { queries: ["config:get"], commands: [] });
});

test("unknown channels map to a clean error instead of throwing", async () => {
  const gateway = new IpcGateway();
  const query = await gateway.handleQuery("nope:query", {});
  assert.equal(query.ok, false);
  assert.equal(query.error.code, ErrorCode.UNKNOWN_CHANNEL);
  const command = await gateway.handleCommand("nope:command", {});
  assert.equal(command.ok, false);
  assert.equal(command.error.code, ErrorCode.UNKNOWN_CHANNEL);
});

test("async handler rejections map to E_HANDLER_FAILED (never rethrow)", async () => {
  const gateway = new IpcGateway();
  gateway.registerCommand(IPC.SPEECH_START, async () => {
    throw new Error("capture backend unavailable");
  });
  const result = await gateway.handleCommand(IPC.SPEECH_START, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ErrorCode.HANDLER_FAILED);
  assert.equal(result.error.message, "capture backend unavailable");
  assert.equal(result.error.channel, IPC.SPEECH_START);
  // Envelopes must be structured-clone/JSON safe.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)));
});

test("non-Error throws and handler error codes survive mapping", async () => {
  const gateway = new IpcGateway();
  gateway.registerQuery("x:query", () => {
    throw "plain string";
  });
  const plain = await gateway.handleQuery("x:query");
  assert.equal(plain.error.code, ErrorCode.HANDLER_FAILED);
  assert.equal(plain.error.message, "plain string");

  gateway.registerQuery("y:query", () => {
    const error = new Error("missing transport");
    error.code = ErrorCode.MODULE_UNAVAILABLE;
    throw error;
  });
  const coded = await gateway.handleQuery("y:query");
  assert.equal(coded.error.code, ErrorCode.HANDLER_FAILED);
  assert.equal(coded.error.handlerCode, ErrorCode.MODULE_UNAVAILABLE);
});

test("handlers returning non-serializable values are contained", async () => {
  const gateway = new IpcGateway();
  gateway.registerQuery("bad:query", () => ({ fn: () => {} }));
  const result = await gateway.handleQuery("bad:query");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ErrorCode.RESULT_NOT_SERIALIZABLE);
});

test("undefined handler results become null, not `undefined`", async () => {
  const gateway = new IpcGateway();
  gateway.registerCommand("noop:command", () => {});
  const result = await gateway.handleCommand("noop:command");
  assert.deepEqual(result, { ok: true, value: null });
});

test("payload guard rejects oversized and non-serializable payloads", async () => {
  const gateway = new IpcGateway({ maxPayloadBytes: 128 });
  let called = 0;
  gateway.registerQuery("echo:query", (payload) => {
    called += 1;
    return payload;
  });

  const huge = await gateway.handleQuery("echo:query", { text: "x".repeat(500) });
  assert.equal(huge.ok, false);
  assert.equal(huge.error.code, ErrorCode.PAYLOAD_TOO_LARGE);
  assert.equal(huge.error.limit, 128);
  assert.equal(called, 0, "oversized payload never reaches the handler");

  const circular = {};
  circular.self = circular;
  const cyclic = await gateway.handleQuery("echo:query", circular);
  assert.equal(cyclic.ok, false);
  assert.equal(cyclic.error.code, ErrorCode.PAYLOAD_NOT_SERIALIZABLE);

  const ok = await gateway.handleQuery("echo:query", { text: "small" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { text: "small" });
});

test("broadcast fans out to every subscriber and reports delivery count", () => {
  const gateway = new IpcGateway();
  const a = [];
  const b = [];
  gateway.subscribe((message) => a.push(message));
  gateway.subscribe((message) => b.push(message));

  const result = gateway.broadcast(IPC.SPEECH_VAD_STATS, { speaking: true });
  assert.deepEqual(result, { ok: true, delivered: 2 });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].channel, IPC.SPEECH_VAD_STATS);
  assert.deepEqual(a[0].payload, { speaking: true });
  assert.equal(typeof a[0].at, "number");
});

test("one throwing subscriber cannot stop the fan-out", () => {
  const errors = [];
  const gateway = new IpcGateway({ onError: (envelope) => errors.push(envelope) });
  const seen = [];
  gateway.subscribe(() => {
    throw new Error("bridge closed");
  });
  gateway.subscribe((message) => seen.push(message.channel));

  const result = gateway.broadcast(IPC.SPEECH_STATUS_CHANGED, { state: "active" });
  assert.deepEqual(result, { ok: true, delivered: 1 });
  assert.deepEqual(seen, [IPC.SPEECH_STATUS_CHANGED]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.code, ErrorCode.LISTENER_FAILED);
});

test("broadcast payload guard blocks oversized frames", () => {
  const gateway = new IpcGateway({ maxPayloadBytes: 64 });
  const seen = [];
  gateway.subscribe((message) => seen.push(message));
  const result = gateway.broadcast(IPC.SPEECH_TRANSCRIPT_RECEIVED, { text: "y".repeat(200) });
  assert.equal(result.ok, false);
  assert.equal(result.delivered, 0);
  assert.equal(result.error.code, ErrorCode.PAYLOAD_TOO_LARGE);
  assert.equal(seen.length, 0);
});

test("duplicate registration fails loudly, unregister frees the channel", () => {
  const gateway = new IpcGateway();
  const off = gateway.registerQuery("config:get", () => 1);
  assert.throws(() => gateway.registerQuery("config:get", () => 2), /already registered/);
  assert.equal(off(), true);
  assert.equal(gateway.hasQuery("config:get"), false);
  assert.doesNotThrow(() => gateway.registerQuery("config:get", () => 3));
});

test("registration validates channel and handler shapes", () => {
  const gateway = new IpcGateway();
  assert.throws(() => gateway.registerQuery("nocolon", () => 1), /namespaced/);
  assert.throws(() => gateway.registerCommand("ok:command", null), /function handler/);
});

test("error envelopes are serializable and carry code/message/channel", async () => {
  const gateway = new IpcGateway();
  gateway.registerQuery("boom:query", async () => {
    throw new Error("kaboom");
  });
  const envelope = await gateway.handleQuery("boom:query", {});
  const roundTripped = JSON.parse(JSON.stringify(envelope));
  assert.deepEqual(roundTripped, envelope);
  assert.equal(roundTripped.error.code, ErrorCode.HANDLER_FAILED);
});
