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

/** Stub transcriber: one word per 300 ms of audio, answered after `delayMs`. */
async function stubTranscriber({ delayMs = 0 } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const riff = body.indexOf("RIFF");
      const samples = riff >= 0 ? body.readUInt32LE(riff + 40) / 2 : 0;
      requests.push({ samples });
      const words = Math.floor(samples / 4800);
      const text = Array.from({ length: words }, (_, i) => `w${i + 1}`).join(" ");
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text }));
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
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

test("a flush requested while an interim is in flight is sent when that interim lands", async () => {
  const stub = await stubTranscriber({ delayMs: 150 });
  // A long silence window: the watchdog's final must not stand in for the flush.
  const { asr, transcripts } = makeAsr(stub, { silenceMs: 10_000 });
  try {
    asr.pushAudio({ streamIdx: 1, pcm16: speech(16000) }); // 1 s: interim cadence
    await waitFor(() => stub.requests.length === 1);
    asr.pushAudio({ streamIdx: 1, pcm16: speech(8000) }); // 0.5 s more, interim still in flight
    assert.equal(asr.flushInterim(1), true, "the flush is queued, not dropped");
    await waitFor(() => stub.requests.length === 2);
    assert.equal(stub.requests[1].samples, 24000, "the flushed interim covers everything said so far");
    const latest = await waitFor(() => transcripts().find((t) => !t.final && t.text.split(" ").length === 5));
    assert.equal(latest.final, false);
    assert.equal(transcripts().some((t) => t.final), false, "it was an interim, not the segment's final");
  } finally {
    asr.close();
    await stub.close();
  }
});

test("on a request budget the rep's mic lane sends no interims, only its final", async () => {
  const stub = await stubTranscriber();
  const { asr, transcripts } = makeAsr(stub, { maxRequestsPerMinute: 20 });
  try {
    for (let i = 0; i < 3; i += 1) {
      asr.pushAudio({ streamIdx: 0, pcm16: speech(16000) });
      await sleep(30);
    }
    assert.equal(stub.requests.length, 0, "no interim requests for the rep");
    assert.equal(asr.finalize(0), true);
    const final = await waitFor(() => transcripts().find((t) => t.final));
    assert.equal(stub.requests.length, 1);
    assert.equal(final.text.split(" ").length, 10, "the final covers the whole 3 s segment");
  } finally {
    asr.close();
    await stub.close();
  }
});

test("prospect interims stop at the reserve; the final still goes; the budget refills after a minute", async () => {
  const stub = await stubTranscriber();
  let clock = 1_000_000;
  // 6/min keeps a reserve of 2: four interims, then finals only.
  const { asr, transcripts } = makeAsr(stub, { maxRequestsPerMinute: 6, now: () => clock });
  try {
    for (let i = 0; i < 8; i += 1) {
      asr.pushAudio({ streamIdx: 1, pcm16: speech(16000) });
      await sleep(40);
    }
    await sleep(40);
    assert.equal(stub.requests.length, 4, "interims stop with only the reserve left");
    assert.equal(asr.finalize(1), true);
    await waitFor(() => transcripts().find((t) => t.final));
    assert.equal(stub.requests.length, 5, "the final is never held back by the budget");

    clock += 61_000;
    asr.pushAudio({ streamIdx: 1, pcm16: speech(16000) });
    await waitFor(() => stub.requests.length === 6);
  } finally {
    asr.close();
    await stub.close();
  }
});

test("without a budget both lanes keep their interims", async () => {
  const stub = await stubTranscriber();
  const { asr } = makeAsr(stub);
  try {
    asr.pushAudio({ streamIdx: 0, pcm16: speech(16000) });
    await waitFor(() => stub.requests.length === 1);
  } finally {
    asr.close();
    await stub.close();
  }
});
