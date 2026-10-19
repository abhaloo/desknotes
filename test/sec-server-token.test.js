import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { main, resolveServerToken } from "../src/server/main.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function helloOutcome(url, jwt) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* gone */
      }
      resolve(value);
    };
    ws.on("open", () => {
      ws.send(JSON.stringify({ v: 1, type: "hello", jwt, session_id: `s-${Math.random()}`, streams: [], capture_authorized: false }));
      setTimeout(() => done("accepted"), 300);
    });
    ws.on("close", (code) => done(code));
    ws.on("error", () => done("error"));
  });
}

test("REALTIME_TOKEN pins the token; a short one is not accepted as a secret", () => {
  assert.deepEqual(resolveServerToken({ REALTIME_TOKEN: "t".repeat(32) }), { token: "t".repeat(32), generated: false });
  const short = resolveServerToken({ REALTIME_TOKEN: "abc" }, { generate: () => "g".repeat(64) });
  assert.deepEqual(short, { token: "g".repeat(64), generated: true, rejectedShort: true });
  const fresh = resolveServerToken({});
  assert.equal(fresh.generated, true);
  assert.match(fresh.token, /^[0-9a-f]{64}$/);
});

test("the standalone server refuses a hello without the token (close 4401)", async () => {
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  let started;
  try {
    started = await main({ PORT: "0", REALTIME_TOKEN: "k".repeat(40) });
  } finally {
    Object.assign(console, quiet);
  }
  try {
    assert.equal(await helloOutcome(started.url, "wrong"), 4401);
    assert.equal(await helloOutcome(started.url, ""), 4401);
    assert.equal(await helloOutcome(started.url, undefined), 4401);
    assert.equal(await helloOutcome(started.url, "k".repeat(40)), "accepted");
  } finally {
    await started.server.stop();
    await sleep(10);
  }
});

test("a generated token is printed once to stderr, never in the listening line", async () => {
  const lines = { log: [], error: [] };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.log.push(a.join(" "));
  console.error = (...a) => lines.error.push(a.join(" "));
  console.warn = () => {};
  let started;
  try {
    started = await main({ PORT: "0" });
  } finally {
    Object.assign(console, quiet);
  }
  try {
    const tokenLine = lines.error.find((l) => /REALTIME_TOKEN/.test(l));
    assert.ok(tokenLine, "operator is told the generated token");
    const token = /([0-9a-f]{64})/.exec(tokenLine)?.[1];
    assert.ok(token);
    assert.ok(!lines.log.some((l) => l.includes(token)), "stdout never carries the token");
    assert.equal(await helloOutcome(started.url, token), "accepted");
  } finally {
    await started.server.stop();
  }
});
