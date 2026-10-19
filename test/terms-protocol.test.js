import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAME, makeFrame, parseFrame } from "../src/shared/protocol.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("terms is a downlink frame name", () => {
  assert.equal(FRAME.TERMS, "terms");
});

test("a terms frame round-trips through makeFrame and parseFrame", () => {
  const data = {
    turn_id: "turn_3",
    terms: [
      { term: "MQTT", full_name: "Message Queuing Telemetry Transport", what: "Lightweight publish/subscribe protocol." },
      { term: "backpressure", what: "A slow consumer makes the producer slow down." },
    ],
  };
  const parsed = parseFrame(makeFrame(FRAME.TERMS, { data }));
  assert.equal(parsed.type, "terms");
  assert.deepEqual(parsed.data, data);
});

test("protocol.md documents the terms frame", () => {
  const doc = readFileSync(join(root, "docs", "protocol.md"), "utf8");
  assert.match(doc, /`terms` — `\{v, type:"terms", seq, data:\{turn_id, terms:\[\{term, full_name\?, what\}\]\}\}`/);
});
