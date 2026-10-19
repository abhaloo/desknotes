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
 * Stub OpenAI-compatible transcriber: finds the WAV inside the multipart body
 * and answers one word per 300 ms of audio ("w1 w2 ..."), so the test can see
 * exactly how much audio each request carried.
 */
async function stubTranscriber() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const riff = body.indexOf("RIFF");
      const dataBytes = riff >= 0 ? body.readUInt32LE(riff + 40) : 0;
      const samples = dataBytes / 2;
      requests.push({ path: req.url, auth: req.headers.authorization, samples });
      const words = Math.floor(samples / 4800);
      const text = Array.from({ length: words }, (_, i) => `w${i + 1}`).join(" ");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text }));
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
  return { asr, frames, transcripts };
}

test("openai-compatible: interims are cumulative and the final transcribes the WHOLE segment", async () => {
  const stub = await stubTranscriber();
  const { asr, transcripts } = makeAsr(stub);
  try {
    for (let i = 0; i < 30; i += 1) {
      asr.pushAudio({ streamIdx: 1, pcm16: speech(1600) }); // 30 x 100 ms = 3 s
      await sleep(5);
    }
    await waitFor(() => transcripts().filter((t) => !t.final).length >= 2);
    assert.equal(asr.finalize(1), true);
    const final = await waitFor(() => transcripts().find((t) => t.final));

    const interims = transcripts().filter((t) => !t.final);
    for (let i = 1; i < interims.length; i += 1) {
      assert.ok(interims[i].text.startsWith(interims[i - 1].text), `interim ${i} must extend the previous one`);
      assert.ok(interims[i].text.length > interims[i - 1].text.length);
    }
    assert.equal(final.text.split(" ").length, 10, "3 s of audio -> 10 words: the full segment, not the tail");
    assert.equal(final.role, "prospect");
    assert.equal(stub.requests.at(-1).samples, 48000, "final request carries the whole segment");
    assert.equal(stub.requests[0].auth, "Bearer k");
  } finally {
    asr.close();
    await stub.close();
  }
});

test("openai-compatible: finalize right after an interim flush still emits a final", async () => {
  const stub = await stubTranscriber();
  const { asr, transcripts } = makeAsr(stub);
  try {
    asr.pushAudio({ streamIdx: 0, pcm16: speech(16000) }); // exactly one flush window
    assert.equal(asr.finalize(0), true, "an open segment always finalizes");
    const final = await waitFor(() => transcripts().find((t) => t.final));
    assert.equal(final.text.split(" ").length, 3);
    assert.equal(asr.finalize(0), false, "one-shot per segment");
  } finally {
    asr.close();
    await stub.close();
  }
});

test("openai-compatible: the silence watchdog closes a segment when audio just stops", async () => {
  const stub = await stubTranscriber();
  const { asr, transcripts } = makeAsr(stub, { silenceMs: 200 });
  try {
    asr.pushAudio({ streamIdx: 1, pcm16: speech(9600) }); // 600 ms, then nothing
    const final = await waitFor(() => transcripts().find((t) => t.final), 3000);
    assert.equal(final.text, "w1 w2");
  } finally {
    asr.close();
    await stub.close();
  }
});

test("openai-compatible: a failing transcriber still closes the segment with the last interim", async () => {
  let fail = false;
  const frames = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (fail) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "partial words" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const asr = createAsr({
    provider: "openai-compatible",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKey: "k",
    emit: (f) => frames.push(f),
    log: () => {},
  });
  try {
    asr.pushAudio({ streamIdx: 1, pcm16: speech(16000) });
    await waitFor(() => frames.some((f) => f.type === "transcript" && !f.data.final));
    fail = true;
    asr.finalize(1);
    const final = await waitFor(() => frames.find((f) => f.type === "transcript" && f.data.final)?.data);
    assert.equal(final.text, "partial words");
  } finally {
    asr.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("flushInterim transcribes everything said so far, ahead of the 1 s interim cadence", async () => {
  const stub = await stubTranscriber();
  const { asr, frames } = makeAsr(stub);
  try {
    asr.pushAudio({ streamIdx: 1, pcm16: speech(9600) }); // 0.6 s: below the interim cadence
    await sleep(50);
    assert.equal(stub.requests.length, 0, "no interim yet");
    assert.equal(asr.flushInterim(1), true);
    await waitFor(() => stub.requests.length === 1);
    assert.equal(stub.requests[0].samples, 9600, "the interim covers all audio so far");
    await waitFor(() => frames.some((f) => f.data?.final === false));
    assert.equal(asr.flushInterim(1), false, "nothing new since the last interim");
    assert.equal(asr.flushInterim(0), false, "no open segment on that stream");
  } finally {
    asr.close();
    await stub.close();
  }
});
