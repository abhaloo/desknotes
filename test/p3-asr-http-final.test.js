import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAsr } from "../src/server/engines/asr.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 4000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error("timed out");
    await sleep(10);
  }
}

/**
 * Stub transcriber that holds each response until the test releases it, so the
 * test decides the order in which requests land. One word per 4800 samples.
 */
async function holdingTranscriber() {
  const requests = [];
  const held = new Map();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const riff = body.indexOf("RIFF");
      const samples = riff >= 0 ? body.readUInt32LE(riff + 40) / 2 : 0;
      held.set(requests.length, { res, samples });
      requests.push({ samples, at: Date.now() });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  function release(index, { status = 200 } = {}) {
    const entry = held.get(index);
    if (!entry) throw new Error(`request ${index} is not waiting for a response`);
    held.delete(index);
    if (status !== 200) {
      entry.res.writeHead(status);
      entry.res.end();
      return;
    }
    const words = Array.from({ length: Math.floor(entry.samples / 4800) }, (_, i) => `w${i + 1}`);
    entry.res.writeHead(200, { "content-type": "application/json" });
    entry.res.end(JSON.stringify({ text: words.join(" ") }));
  }

  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    release,
    close: async () => {
      // Unanswered requests get a normal answer so no connection outlives the test.
      for (const index of [...held.keys()]) release(index);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function speech(samples) {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = Math.round(9000 * Math.sin(i / 7));
  return out;
}

function makeAsr(stub, extra = {}) {
  const frames = [];
  const asr = createAsr({
    provider: "openai-compatible",
    baseUrl: stub.baseUrl,
    apiKey: "k",
    model: "stt",
    emit: (frame) => frames.push(frame),
    log: () => {},
    ...extra,
  });
  const transcripts = () => frames.filter((f) => f.type === "transcript").map((f) => f.data);
  return { asr, transcripts };
}

/**
 * Stream 1 gets an interim (request #0, answered: "w1 w2 w3") and then a flush
 * covering 0.5 s more, left in flight as request #1 (24000 samples).
 */
async function flushInFlight(asr, stub, transcripts) {
  asr.pushAudio({ streamIdx: 1, pcm16: speech(16000) });
  await waitFor(() => stub.requests.length === 1);
  stub.release(0);
  await waitFor(() => transcripts().some((t) => !t.final));
  asr.pushAudio({ streamIdx: 1, pcm16: speech(8000) });
  assert.equal(asr.flushInterim(1), true, "the flush is requested");
  await waitFor(() => stub.requests.length === 2);
  assert.equal(stub.requests[1].samples, 24000, "the flush covers everything said so far");
}

/** 64 ms of silence: the hangover tail after a flush. */
const hangoverTail = () => new Int16Array(1024);

test("a flush in flight becomes the final when only hangover silence follows it", async () => {
  const stub = await holdingTranscriber();
  const { asr, transcripts } = makeAsr(stub, { silenceMs: 10_000 });
  try {
    await flushInFlight(asr, stub, transcripts);
    asr.pushAudio({ streamIdx: 1, pcm16: hangoverTail() });
    assert.equal(asr.finalize(1), true);
    await sleep(100);
    assert.equal(stub.requests.length, 2, "no final request while the flush is in flight");

    stub.release(1);
    const final = await waitFor(() => transcripts().find((t) => t.final));
    assert.equal(final.text, "w1 w2 w3 w4 w5", "the flush's text is the final");

    await sleep(200);
    assert.equal(stub.requests.length, 2, "the segment never sent a third request");
    assert.equal(
      transcripts().some((t) => !t.final && t.text.split(" ").length === 5),
      false,
      "the flush result was not shown as an interim",
    );
  } finally {
    asr.close();
    await stub.close();
  }
});

test("a longer tail starts the final at once, beside the flush, and the flush emits nothing", async () => {
  const stub = await holdingTranscriber();
  const { asr, transcripts } = makeAsr(stub, { silenceMs: 10_000 });
  try {
    await flushInFlight(asr, stub, transcripts);
    asr.pushAudio({ streamIdx: 1, pcm16: speech(8000) }); // 0.5 s: longer than the reuse window
    const finalizedAt = Date.now();
    assert.equal(asr.finalize(1), true);

    await waitFor(() => stub.requests.length === 3);
    assert.equal(stub.requests[2].samples, 32000, "the final covers all audio");
    assert.ok(stub.requests[2].at - finalizedAt < 100, "the final did not wait for the flush response");

    stub.release(2);
    const final = await waitFor(() => transcripts().find((t) => t.final));
    assert.equal(final.text, "w1 w2 w3 w4 w5 w6");

    stub.release(1);
    await sleep(150);
    assert.deepEqual(
      transcripts().map((t) => (t.final ? "final" : "interim")),
      ["interim", "final"],
      "the late flush emits nothing after the final",
    );
  } finally {
    asr.close();
    await stub.close();
  }
});

test("finalize while an ordinary interim is in flight starts the final at once", async () => {
  const stub = await holdingTranscriber();
  const { asr, transcripts } = makeAsr(stub, { silenceMs: 10_000 });
  try {
    asr.pushAudio({ streamIdx: 1, pcm16: speech(16000) }); // interim #0, held
    await waitFor(() => stub.requests.length === 1);
    assert.equal(asr.finalize(1), true);

    await waitFor(() => stub.requests.length === 2);
    assert.equal(stub.requests[1].samples, 16000, "the final covers the whole segment");
    stub.release(1);
    const final = await waitFor(() => transcripts().find((t) => t.final));
    assert.equal(final.text, "w1 w2 w3");

    stub.release(0);
    await sleep(150);
    assert.deepEqual(
      transcripts().map((t) => (t.final ? "final" : "interim")),
      ["final"],
      "the late interim is dropped, never emitted after the final",
    );
  } finally {
    asr.close();
    await stub.close();
  }
});

test("a failed flush falls back to a fresh final request for the whole segment", async () => {
  const stub = await holdingTranscriber();
  const { asr, transcripts } = makeAsr(stub, { silenceMs: 10_000 });
  try {
    await flushInFlight(asr, stub, transcripts);
    asr.pushAudio({ streamIdx: 1, pcm16: hangoverTail() });
    assert.equal(asr.finalize(1), true);

    stub.release(1, { status: 500 });
    await waitFor(() => stub.requests.length === 3);
    assert.equal(stub.requests[2].samples, 25024, "the fallback transcribes the whole segment, tail included");
    stub.release(2);
    const final = await waitFor(() => transcripts().find((t) => t.final));
    assert.equal(final.text, "w1 w2 w3 w4 w5", "the final uses the fallback's text");

    await sleep(200);
    assert.equal(stub.requests.length, 3, "exactly three requests");
  } finally {
    asr.close();
    await stub.close();
  }
});

test("the next segment's frames wait for the previous segment's final", async () => {
  const stub = await holdingTranscriber();
  const { asr, transcripts } = makeAsr(stub, { silenceMs: 10_000 });
  try {
    asr.pushAudio({ streamIdx: 1, pcm16: speech(16000) }); // segment A: interim #0, held
    await waitFor(() => stub.requests.length === 1);
    assert.equal(asr.finalize(1), true); // A's final #1 starts now, beside #0
    await waitFor(() => stub.requests.length === 2);

    asr.pushAudio({ streamIdx: 1, pcm16: speech(16000) }); // segment B: coalesced behind #0
    stub.release(0);
    await sleep(100); // #0 lands and emits nothing
    asr.pushAudio({ streamIdx: 1, pcm16: speech(16000) }); // B's next interim is due
    await sleep(100);
    assert.equal(stub.requests.length, 2, "B's interim waits behind A's final");
    assert.equal(transcripts().length, 0, "nothing is emitted before A's final");

    stub.release(1);
    await waitFor(() => stub.requests.length === 3);
    assert.equal(stub.requests[2].samples, 32000, "B's interim covers B's audio");
    stub.release(2);
    await waitFor(() => transcripts().length === 2);

    const [a, b] = transcripts();
    assert.equal(a.final, true);
    assert.equal(a.text, "w1 w2 w3");
    assert.equal(b.final, false);
    assert.equal(b.text, "w1 w2 w3 w4 w5 w6");
    assert.notEqual(b.segment_id, a.segment_id, "B's interim belongs to B's segment");
  } finally {
    asr.close();
    await stub.close();
  }
});

test("the reuse spends one request of the minute's budget fewer", async () => {
  const stub = await holdingTranscriber();
  // 6 per minute keeps a reserve of 2: interims stop once four requests are spent.
  const { asr, transcripts } = makeAsr(stub, { silenceMs: 10_000, maxRequestsPerMinute: 6 });
  try {
    await flushInFlight(asr, stub, transcripts);
    asr.pushAudio({ streamIdx: 1, pcm16: hangoverTail() });
    assert.equal(asr.finalize(1), true);
    stub.release(1);
    await waitFor(() => transcripts().some((t) => t.final));
    assert.equal(stub.requests.length, 2, "the segment cost two requests, not three");

    // Two more interims still fit before the reserve.
    for (let i = 0; i < 2; i += 1) {
      asr.pushAudio({ streamIdx: 1, pcm16: speech(16000) });
      await waitFor(() => stub.requests.length === 3 + i);
      stub.release(2 + i);
      await waitFor(() => transcripts().filter((t) => !t.final).length === 2 + i);
    }
    asr.pushAudio({ streamIdx: 1, pcm16: speech(16000) });
    await sleep(100);
    assert.equal(stub.requests.length, 4, "the reserve stops the fourth interim");
  } finally {
    asr.close();
    await stub.close();
  }
});
