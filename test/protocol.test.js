import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAudioFrame,
  decodeAudioFrame,
  makeFrame,
  parseFrame,
  FRAME_HEADER_BYTES,
  STREAM,
  RING_MAX_BYTES,
} from "../src/shared/protocol.js";

test("audio frame round-trips streamIdx, seq and payload", () => {
  const pcm = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = encodeAudioFrame(STREAM.MICROPHONE, 42, pcm);
  assert.equal(frame.byteLength, FRAME_HEADER_BYTES + pcm.byteLength);
  const decoded = decodeAudioFrame(frame);
  assert.equal(decoded.streamIdx, 0);
  assert.equal(decoded.seq, 42);
  assert.deepEqual([...decoded.pcm], [...pcm]);
});

test("seq is uint32 little-endian and survives large values", () => {
  const decoded = decodeAudioFrame(encodeAudioFrame(1, 0xabcdef01, new Uint8Array(2)));
  assert.equal(decoded.streamIdx, 1);
  assert.equal(decoded.seq, 0xabcdef01);
});

test("Int16Array payloads are framed from their raw bytes", () => {
  const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
  const decoded = decodeAudioFrame(encodeAudioFrame(0, 7, pcm));
  assert.equal(decoded.pcm.byteLength, 10);
  // Payload starts at byte 5 (odd): typed-array views need an aligned copy.
  const back = new Int16Array(decoded.pcm.slice().buffer);
  assert.deepEqual([...back], [...pcm]);
});

test("control frames stamp version and type, and parse back", () => {
  const raw = makeFrame("finalize", { stream: 1 });
  const frame = parseFrame(raw);
  assert.equal(frame.v, 1);
  assert.equal(frame.type, "finalize");
  assert.equal(frame.stream, 1);
});

test("parseFrame rejects binary, garbage and unversioned payloads", () => {
  assert.equal(parseFrame(new Uint8Array([1, 2, 3])), null);
  assert.equal(parseFrame("not json"), null);
  assert.equal(parseFrame(JSON.stringify({ type: "hello" })), null);
  assert.equal(parseFrame(JSON.stringify({ v: 99, type: "hello" })), null);
});

test("gap ring budget is 12s of pcm16 mono", () => {
  assert.equal(RING_MAX_BYTES, 384000);
});
