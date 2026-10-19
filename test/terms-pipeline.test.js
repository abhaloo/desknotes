import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 3000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

function fakeAsr() {
  const handlers = [];
  return {
    pushAudio() {},
    finalize() {
      return true;
    },
    close() {},
    onTranscript(cb) {
      handlers.push(cb);
    },
    send(streamIdx, text, final = false) {
      const data = { text, final, stream: streamIdx, role: streamIdx === 1 ? "prospect" : "rep", source: streamIdx === 1 ? "system" : "mic" };
      for (const cb of handlers) cb(data);
    },
  };
}

const CARD = ["• VERDICT: stream readings over **MQTT** into Kafka.\n", "• HOW: a TSDB keeps them.\n", "• TRADE-OFF: more ops."];
const CARD_TEXT = CARD.join("");

/** Streams CARD for every question; `fail` makes every attempt throw before its first token. */
function cardAnswerer({ deltaMs = 1, fail = false } = {}) {
  const calls = [];
  async function* streamAnswer(args) {
    const call = { question: args.question, finished: false };
    calls.push(call);
    if (fail) throw new Error("provider down");
    for (const piece of CARD) {
      await sleep(deltaMs);
      if (args.signal?.aborted) return;
      yield piece;
    }
    call.finished = true;
  }
  return { calls, streamAnswer };
}

/** A glossary whose reply the test controls; records each call with the frames sent before it. */
function fakeGlossary(frames, { reply = () => ({ terms: [{ term: "MQTT", what: "Publish/subscribe protocol." }], added: 1, latencyMs: 7, error: null }), enabled = true } = {}) {
  const glossary = {
    enabled,
    calls: [],
    closed: false,
    explain(args) {
      glossary.calls.push({ ...args, framesBefore: frames.map((frame) => ({ type: frame.type, id: frame.data?.turn_id })) });
      return reply(args);
    },
    close() {
      glossary.closed = true;
    },
  };
  return glossary;
}

function setup({ glossaryOptions, answerer, ...engineOptions } = {}) {
  const frames = [];
  const logs = [];
  const telemetry = [];
  const asr = fakeAsr();
  const ans = answerer ?? cardAnswerer();
  const glossary = fakeGlossary(frames, glossaryOptions);
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer: ans,
    log: (entry) => logs.push(entry),
    telemetry: { record: (event) => telemetry.push(event) },
    glossaryEngine: glossary,
    ...engineOptions,
  });
  engine.onSessionStart({ sessionId: "s" });
  const of = (type) => frames.filter((frame) => frame.type === type);
  return { engine, frames, logs, telemetry, asr, answerer: ans, glossary, of };
}

const Q1 = "How would you ingest sensor data for a greenhouse?";
const Q2 = "And how would you alert on a failing sensor?";

test("a committed answer gets one terms frame, after its turn.done", async () => {
  const { asr, frames, glossary, logs, telemetry, of, engine } = setup();
  asr.send(1, Q1, true);
  const terms = await waitFor(() => of("terms")[0], "terms frame");
  const id = of("turn.started")[0].data.turn_id;
  assert.deepEqual(terms.data, { turn_id: id, terms: [{ term: "MQTT", what: "Publish/subscribe protocol." }] });
  assert.equal(terms.v, 1);
  const types = frames.map((frame) => frame.type);
  assert.ok(types.indexOf("turn.done") < types.indexOf("terms"), "terms follows turn.done");
  assert.equal(glossary.calls.length, 1);
  assert.equal(glossary.calls[0].text, CARD_TEXT.replaceAll("**", ""), "the card's final text, without key-phrase markers");
  assert.ok(glossary.calls[0].signal instanceof AbortSignal);
  const logged = logs.filter((entry) => entry.type === "glossary.request");
  assert.deepEqual(logged, [{ type: "glossary.request", turn_id: id, latency_ms: 7, entries: 1, added: 1, error: null }]);
  const recorded = telemetry.filter((event) => event.type === "glossary.request");
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    { turnId: recorded[0].turnId, latencyMs: recorded[0].latencyMs, entries: recorded[0].entries, added: recorded[0].added, error: recorded[0].error },
    { turnId: id, latencyMs: 7, entries: 1, added: 1, error: null },
  );
  assert.ok(telemetry.some((event) => event.type === "wire.frame" && event.frame.type === "terms"), "the frame is recorded like every wire frame");
  engine.onSessionEnd();
  assert.equal(glossary.closed, true, "session end closes the glossary");
});

test("the switch: off sends nothing and never calls the glossary; it is read once per turn", async () => {
  const boom = () => {
    throw new Error("settings unreadable");
  };
  for (const glossarySwitch of [false, () => false, boom]) {
    const { asr, glossary, of } = setup({ glossary: glossarySwitch });
    asr.send(1, Q1, true);
    await waitFor(() => of("turn.done").length === 1, "answer");
    await sleep(20);
    assert.equal(glossary.calls.length, 0, String(glossarySwitch));
    assert.equal(of("terms").length, 0);
  }

  let on = false;
  let reads = 0;
  const resolver = () => {
    reads += 1;
    return on;
  };
  const { asr, glossary, of } = setup({ glossary: resolver });
  asr.send(1, Q1, true);
  await waitFor(() => of("turn.done").length === 1, "answer 1");
  await sleep(20);
  assert.equal(glossary.calls.length, 0);
  assert.equal(reads, 1, "read once for turn 1");
  on = true;
  asr.send(1, Q2, true);
  await waitFor(() => of("terms").length === 1, "terms for turn 2");
  assert.equal(reads, 2, "read once for turn 2");
});

test("no glossary engine, or a disabled one: no frames and no calls", async () => {
  for (const options of [{ glossaryEngine: undefined }, { glossaryOptions: { enabled: false } }]) {
    const { asr, glossary, of } = setup(options);
    asr.send(1, Q1, true);
    await waitFor(() => of("turn.done").length === 1, "answer");
    await sleep(20);
    assert.equal(of("terms").length, 0);
    assert.equal(glossary.calls.length, 0);
  }
});

test("an empty block or a failed request sends no frame; each request is logged once with its code", async () => {
  const replies = [
    { terms: [], added: 0, latencyMs: 3, error: null },
    { terms: [], added: 0, latencyMs: 5000, error: "timeout" },
  ];
  for (const reply of replies) {
    const { asr, logs, of } = setup({ glossaryOptions: { reply: () => Promise.resolve(reply) } });
    asr.send(1, Q1, true);
    await waitFor(() => logs.some((entry) => entry.type === "glossary.request"), "request logged");
    await sleep(10);
    assert.equal(of("terms").length, 0);
    const logged = logs.filter((entry) => entry.type === "glossary.request");
    assert.equal(logged.length, 1);
    assert.equal(logged[0].error, reply.error);
  }
  const rejecting = setup({ glossaryOptions: { reply: () => Promise.reject(new Error("boom")) } });
  rejecting.asr.send(1, Q1, true);
  await waitFor(() => rejecting.logs.some((entry) => entry.type === "glossary.request"), "rejection logged");
  assert.equal(rejecting.logs.find((entry) => entry.type === "glossary.request").error, "engine_error");
  const throwing = setup({
    glossaryOptions: {
      reply: () => {
        throw new Error("sync boom");
      },
    },
  });
  throwing.asr.send(1, Q1, true);
  await waitFor(() => throwing.logs.some((entry) => entry.type === "glossary.request"), "throw logged");
  assert.equal(throwing.of("terms").length, 0);
});

test("a held prefetch gets terms only once the final commits it", async () => {
  const long = "could you walk me through how you would ingest the sensor data";
  const { asr, answerer, glossary, of } = setup();
  asr.send(1, long, false); // >= 8 words: a held prefetch starts
  await waitFor(() => answerer.calls[0]?.finished, "the prefetch finishes unseen");
  await sleep(20);
  assert.equal(of("turn.started").length, 0, "held: nothing sent yet");
  assert.equal(of("turn.done").length, 0);
  assert.equal(glossary.calls.length, 0, "not shown, not committed: no request");
  asr.send(1, long, true);
  const terms = await waitFor(() => of("terms")[0], "terms after the commit");
  assert.equal(terms.data.turn_id, of("turn.done")[0].data.turn_id);
  assert.equal(glossary.calls.length, 1);
});

test("an uncommitted answer the client saw waits for its final; one never committed gets none", async () => {
  const long = "could you walk me through how you would ingest the sensor data";
  const { asr, glossary, of } = setup({ holdSpeculation: false });
  asr.send(1, long, false);
  await waitFor(() => of("turn.done").length === 1, "prefetch done on the wire");
  await sleep(20);
  assert.equal(glossary.calls.length, 0, "shown but not committed: no request yet");
  asr.send(1, long, true);
  await waitFor(() => of("terms").length === 1, "terms after the commit");

  const never = setup({ holdSpeculation: false });
  never.asr.send(1, long, false);
  await waitFor(() => never.of("turn.done").length === 1, "prefetch done");
  await sleep(30);
  assert.equal(never.glossary.calls.length, 0);
});

test("superseded and failed turns get no terms", async () => {
  const diverging = setup({ holdSpeculation: false, answerer: cardAnswerer({ deltaMs: 15 }) });
  diverging.asr.send(1, "could you walk me through how you would ingest the sensor data", false);
  await sleep(5);
  diverging.asr.send(1, "what is your salary expectation for this role and the start date", false);
  await waitFor(() => diverging.of("turn.superseded").length === 1, "first prefetch superseded");
  await sleep(80);
  assert.equal(diverging.glossary.calls.length, 0);

  const failing = setup({ answerer: cardAnswerer({ fail: true }) });
  failing.asr.send(1, Q1, true);
  await waitFor(() => failing.of("turn.done").length === 1, "failed turn closed");
  await sleep(20);
  assert.equal(failing.of("error").length, 1, "the generation failed");
  assert.equal(failing.glossary.calls.length, 0);
  assert.equal(failing.of("terms").length, 0);
});

test("a rescued turn gets terms", async () => {
  const TIER = "how much is the pro tier per seat for a team of forty";
  const PLAN = "how much is the pro plan per seat for a team of forty";
  const judge = {
    enabled: true,
    features: { gate: true, rescue: true },
    async evaluate(input) {
      await sleep(10);
      return { isQuestion: 0.95, answersSame: input.answeredFor ? 0.95 : null, latencyMs: 10, error: null };
    },
    close() {},
  };
  const { asr, logs, glossary, of } = setup({ judge, holdSpeculation: false, answerer: cardAnswerer({ deltaMs: 2 }) });
  asr.send(1, TIER, false);
  await waitFor(() => of("turn.done").length === 1, "prefetch finished");
  asr.send(1, PLAN, true);
  const rescued = await waitFor(() => logs.find((entry) => entry.type === "turn.rescued"), "rescue");
  const terms = await waitFor(() => of("terms")[0], "terms for the rescued turn");
  assert.equal(terms.data.turn_id, rescued.turn_id);
  assert.equal(glossary.calls.length, 1);
});

test("a new unheld turn aborts the in-flight request as its card reaches the client; the late reply is dropped", async () => {
  let resolveFirst;
  const { asr, glossary, logs, of } = setup({
    glossaryOptions: {
      reply: () =>
        glossary.calls.length === 1
          ? new Promise((resolve) => {
              resolveFirst = resolve;
            })
          : Promise.resolve({ terms: [{ term: "TSDB", what: "Stores readings by time." }], added: 1, latencyMs: 2, error: null }),
    },
  });
  asr.send(1, Q1, true);
  await waitFor(() => glossary.calls.length === 1, "first request");
  const first = glossary.calls[0];
  assert.equal(first.signal.aborted, false);
  asr.send(1, Q2, true);
  assert.equal(first.signal.aborted, true, "the committed turn's turn.started is sent at once, and that aborts it");
  resolveFirst({ terms: [{ term: "MQTT", what: "Late." }], added: 1, latencyMs: 900, error: null });
  const terms = await waitFor(() => of("terms")[0], "terms for turn 2");
  assert.equal(terms.data.turn_id, of("turn.started")[1].data.turn_id, "only the new turn's terms reach the wire");
  await sleep(10);
  assert.equal(of("terms").length, 1);
  const logged = logs.filter((entry) => entry.type === "glossary.request");
  assert.equal(logged.length, 2);
  assert.equal(logged[0].error, "aborted");
});

/** A glossary whose first reply waits for the test; later replies explain TSDB at once. */
function deferredFirst() {
  const gate = {};
  const glossaryOptions = {
    reply: (args) =>
      gate.calls++ === 0
        ? new Promise((resolve) => {
            gate.resolve = resolve;
          })
        : Promise.resolve({ terms: [{ term: "TSDB", what: "Stores readings by time." }], added: 1, latencyMs: 2, error: null }),
  };
  gate.calls = 0;
  return { gate, glossaryOptions };
}

const LATE_MQTT = { terms: [{ term: "MQTT", what: "Publish/subscribe protocol." }], added: 1, latencyMs: 900, error: null };

test("a held turn that is never shown leaves the card on screen and its request alone", async () => {
  const { gate, glossaryOptions } = deferredFirst();
  const { asr, glossary, of } = setup({ glossaryOptions, answerer: cardAnswerer({ deltaMs: 15 }) });
  asr.send(1, Q1, true);
  await waitFor(() => glossary.calls.length === 1, "the first card's request");
  const shown = of("turn.started")[0].data.turn_id;
  // The prospect keeps talking: a held prefetch starts, then a different question retires it unseen.
  asr.send(1, "could you walk me through how you would ingest the sensor data", false);
  await sleep(5);
  asr.send(1, "what is your salary expectation for this role and the start date", false);
  await sleep(5);
  assert.equal(of("turn.started").length, 1, "no held turn reached the client");
  assert.equal(glossary.calls[0].signal.aborted, false, "a hidden turn does not abort the shown card's request");
  gate.resolve(LATE_MQTT);
  const terms = await waitFor(() => of("terms")[0], "terms for the card on screen");
  assert.equal(terms.data.turn_id, shown);
});

test("a held turn that is revealed aborts the older card's request; its late reply is dropped", async () => {
  const { gate, glossaryOptions } = deferredFirst();
  const { asr, glossary, of } = setup({ glossaryOptions, answerer: cardAnswerer({ deltaMs: 15 }) });
  asr.send(1, Q1, true);
  await waitFor(() => glossary.calls.length === 1, "the first card's request");
  const long = "could you walk me through how you would ingest the sensor data";
  asr.send(1, long, false); // held prefetch
  await sleep(5);
  assert.equal(glossary.calls[0].signal.aborted, false, "held: not yet");
  asr.send(1, long, true); // the final commits and reveals it
  assert.equal(of("turn.started").length, 2, "the revealed turn reached the client");
  assert.equal(glossary.calls[0].signal.aborted, true, "the client's card changed: the request is aborted");
  gate.resolve(LATE_MQTT);
  const terms = await waitFor(() => of("terms")[0], "terms for the revealed card");
  assert.equal(terms.data.turn_id, of("turn.started")[1].data.turn_id);
  await sleep(10);
  assert.equal(of("terms").length, 1, "nothing for the older card");
});

test("a request whose card was cleared from the client sends no frame", async () => {
  const { gate, glossaryOptions } = deferredFirst();
  const { asr, engine, glossary, logs, of } = setup({ glossaryOptions });
  asr.send(1, Q1, true);
  await waitFor(() => glossary.calls.length === 1, "request");
  engine.onScreenClear();
  gate.resolve(LATE_MQTT);
  await waitFor(() => logs.some((entry) => entry.type === "glossary.request"), "request logged");
  assert.equal(of("terms").length, 0);
  assert.equal(logs.find((entry) => entry.type === "glossary.request").error, "not_shown");
});

test("a final queued behind the answer starts first; the older card's request is never sent", async () => {
  const { asr, glossary, of } = setup({ answerer: cardAnswerer({ deltaMs: 5 }) });
  asr.send(1, Q1, true);
  await sleep(2);
  asr.send(1, Q2, true); // queued behind the committed answer
  await waitFor(() => of("turn.done").length === 2, "both answers");
  await waitFor(() => of("terms").length === 1, "terms for the second");
  assert.equal(glossary.calls.length, 1, "the first card was replaced before its request could start");
  assert.equal(of("terms")[0].data.turn_id, of("turn.started")[1].data.turn_id);
});

test("session end aborts the in-flight request and no frame follows", async () => {
  let resolveIt;
  const { asr, glossary, of, engine } = setup({
    glossaryOptions: {
      reply: () =>
        new Promise((resolve) => {
          resolveIt = resolve;
        }),
    },
  });
  asr.send(1, Q1, true);
  await waitFor(() => glossary.calls.length === 1, "request");
  engine.onSessionEnd();
  assert.equal(glossary.calls[0].signal.aborted, true);
  resolveIt({ terms: [{ term: "MQTT", what: "Late." }], added: 1, latencyMs: 1, error: null });
  await sleep(10);
  assert.equal(of("terms").length, 0);
});
