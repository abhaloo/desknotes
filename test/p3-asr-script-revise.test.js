import test from "node:test";
import assert from "node:assert/strict";
import { createAsr } from "../src/server/engines/asr.js";

function tone(samples, amplitude = 9000) {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = Math.round(amplitude * Math.sin(i / 7));
  return out;
}

function collector() {
  const frames = [];
  return { frames, emit: (frame) => frames.push(frame) };
}

function interims(frames) {
  return frames.filter((f) => f.type === "transcript" && f.data.final === false);
}

function finals(frames) {
  return frames.filter((f) => f.type === "transcript" && f.data.final === true);
}

test("mock-scripted {interim, text} entries revise the wording at the final", () => {
  const { frames, emit } = collector();
  const interim = "how much is the pro tier per seat for a team of forty";
  const text = "how much is the pro plan per seat for a team of forty";
  const asr = createAsr({ provider: "mock-scripted", script: { 1: [{ interim, text }] }, emit, log: () => {} });
  const chunk = tone(1600);
  for (let i = 0; i < 40; i += 1) asr.pushAudio({ streamIdx: 1, seq: i, pcm16: chunk }); // 4 s
  const seen = interims(frames);
  assert.ok(seen.length >= 3);
  assert.ok(seen.every((f) => interim.startsWith(f.data.text)), "interims follow the interim wording");
  assert.ok(seen.some((f) => f.data.text.includes("tier")), "the revised word is visible in an interim");
  asr.finalize(1);
  assert.equal(finals(frames)[0].data.text, text, "the final carries the revised wording");
});

test("plain string and {text} entries behave as before", () => {
  const { frames, emit } = collector();
  const asr = createAsr({ provider: "mock-scripted", script: { 1: [{ text: "what is the renewal date on this account" }] }, emit, log: () => {} });
  const chunk = tone(1600);
  for (let i = 0; i < 12; i += 1) asr.pushAudio({ streamIdx: 1, seq: i, pcm16: chunk });
  asr.finalize(1);
  assert.equal(finals(frames)[0].data.text, "what is the renewal date on this account");
});
