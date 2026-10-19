import test from "node:test";
import assert from "node:assert/strict";
import { VadGate } from "../src/vad/index.js";

test("flush() forwards the trailing sub-frame remainder instead of dropping it", async () => {
  const sent = [];
  const gate = new VadGate({
    probe: async (frame, carry) => ({ probability: 0.9, nextState: carry }),
    onSend: (frame) => sent.push(frame.length),
  });
  gate.feed(new Float32Array(512 * 2 + 200).fill(0.2));
  await gate.drain();
  gate.flush();
  assert.deepEqual(sent, [512, 512, 200], "all 1224 samples reach the sink, in order");
  gate.flush();
  assert.equal(sent.length, 3, "idempotent");
  gate.close();
});

test("flush() on a pass-through gate also forwards the remainder", () => {
  const sent = [];
  const gate = new VadGate({ probe: null, onSend: (frame) => sent.push(frame.length) });
  gate.feed(new Float32Array(700));
  gate.close();
  assert.deepEqual(sent, [512, 188]);
});
