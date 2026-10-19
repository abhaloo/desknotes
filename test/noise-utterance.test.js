import test from "node:test";
import assert from "node:assert/strict";
import { NOISE_UTTERANCES, isNoiseUtterance } from "../src/server/engines/noise-utterance.js";

test("NOISE_UTTERANCES is frozen and contains the known noise phrases", () => {
  assert.ok(Object.isFrozen(NOISE_UTTERANCES));
  for (const phrase of ["you", "thank you", "thanks", "thank you for watching", "thanks for watching", "music", "bye"]) {
    assert.ok(NOISE_UTTERANCES.has(phrase), phrase);
  }
});

test("isNoiseUtterance is true for noise phrases, punctuation, empty text and one-word non-questions", () => {
  const noise = ["you", "You.", "Music", "[Music]", ".", "", "Thank you.", "Thanks for watching!", "okay"];
  for (const text of noise) {
    assert.equal(isNoiseUtterance(text), true, `expected noise for ${JSON.stringify(text)}`);
  }
});

test("isNoiseUtterance is false for real questions, including one-word questions with '?'", () => {
  const real = ["Why?", "Kubernetes?", "How do you scale it", "Thank you, how much does it cost?"];
  for (const text of real) {
    assert.equal(isNoiseUtterance(text), false, `expected question for ${JSON.stringify(text)}`);
  }
});
