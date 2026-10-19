import test from "node:test";
import assert from "node:assert/strict";
import { IpcGateway, ErrorCode, okEnvelope, failEnvelope } from "../src/desktop/ipc-gateway.js";

test("handler-returned failure envelopes pass through unchanged (and reach onError)", async () => {
  const errors = [];
  const gateway = new IpcGateway({ onError: (envelope) => errors.push(envelope) });
  gateway.registerCommand("session:start", () => failEnvelope(ErrorCode.SESSION_START, "WebSocket is not defined"));
  const result = await gateway.handleCommand("session:start", {});
  assert.deepEqual(result, { ok: false, error: { code: "E_SESSION_START", message: "WebSocket is not defined" } });
  assert.equal(errors.length, 1);
});

test("handler-returned ok envelopes are not wrapped a second time", async () => {
  const gateway = new IpcGateway();
  gateway.registerCommand("screen:analyse", async () => okEnvelope({ status: "ok", kind: "code" }));
  assert.deepEqual(await gateway.handleCommand("screen:analyse"), { ok: true, value: { status: "ok", kind: "code" } });
});

test("plain values that merely carry an `ok` field are still wrapped", async () => {
  const gateway = new IpcGateway();
  gateway.registerQuery("x:query", () => ({ ok: true, delivered: 2 }));
  gateway.registerQuery("y:query", () => ({ ok: false }));
  assert.deepEqual(await gateway.handleQuery("x:query"), { ok: true, value: { ok: true, delivered: 2 } });
  assert.deepEqual(await gateway.handleQuery("y:query"), { ok: true, value: { ok: false } });
});

test("a passed-through envelope is still checked for cloneability", async () => {
  const gateway = new IpcGateway();
  gateway.registerCommand("bad:cmd", () => okEnvelope({ fn: () => {} }));
  const result = await gateway.handleCommand("bad:cmd");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ErrorCode.RESULT_NOT_SERIALIZABLE);
});
