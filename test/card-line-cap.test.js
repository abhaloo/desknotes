import test from "node:test";
import assert from "node:assert/strict";
import { CONTINUATION, createLineCap } from "../src/server/engines/card-line-cap.js";

function run(deltas, options) {
  const cap = createLineCap(options);
  return deltas.map((delta) => cap.push(delta)).join("") + cap.flush();
}

/** The same text whole, then in 1- and 3-character pieces, must give one result. */
function runAllWays(text, options) {
  const whole = run([text], options);
  assert.equal(run([...text], options), whole, "1-char deltas");
  assert.equal(run(text.match(/[\s\S]{1,3}/g), options), whole, "3-char deltas");
  return whole;
}

const words = (n, from = 1) => Array.from({ length: n }, (_, i) => `w${from + i}`).join(" ");

test("lines within the cap pass through unchanged", () => {
  const text = `• VERDICT: ${words(12)}\n• HOW: ${words(20)}.\n• TRADE-OFF: short.`;
  assert.equal(runAllWays(text, { maxWords: 25 }), text);
  assert.equal(runAllWays(text), text, "no cap by default");
});

test("a long line is cut at its last clause break near the cap, with an ellipsis", () => {
  const line = `• MECHANICS: ${words(19)}, ${words(10, 20)} and more words here.`;
  assert.equal(runAllWays(`${line}\n• TRADE-OFF: short.`, { maxWords: 25 }), `• MECHANICS: ${words(19)}…\n• TRADE-OFF: short.`);
});

test("with no clause break near the cap, the line is cut at the cap", () => {
  const line = `• COST: ${words(40)}`;
  // The bullet and the label count as words: 2 + 23 = 25.
  assert.equal(runAllWays(`${line}\n• TRADE-OFF: short.`, { maxWords: 25 }), `• COST: ${words(23)}…\n• TRADE-OFF: short.`);
});

test("a cut line drops the rest of the line only", () => {
  // Cap 8 words, hold the last 2: words 1-6 stream, 7-8 are held, the 9th cuts.
  const cap = createLineCap({ maxWords: 8, holdWords: 2 });
  assert.equal(cap.push("• A: one two three four"), "• A: one two three four", "short so far: it streams");
  assert.equal(cap.push(" five six seven"), " five six…", "held, then cut at the cap");
  assert.equal(cap.push(" eight\n• B: next"), "\n• B: next", "the rest of the cut line is dropped");
  assert.equal(cap.flush(), "");
  assert.equal(cap.cuts, 1);
});

test("text far from the cap streams on the push that brought it", () => {
  const cap = createLineCap({ maxWords: 25 });
  assert.equal(cap.push("• VERDICT: use a queue"), "• VERDICT: use a queue");
});

test("lines inside a fenced code block are never cut", () => {
  const code = `\`\`\`python\nx = [${words(40).replaceAll(" ", ", ")}]\n\`\`\``;
  const text = `• VERDICT: use a list.\n${code}\n• TRADE-OFF: memory.`;
  assert.equal(runAllWays(text, { maxWords: 10 }), text);
});

test("a key phrase still open at the cut is closed", () => {
  const line = `• VERDICT: **${words(30)}`;
  const out = runAllWays(line, { maxWords: 12 });
  assert.equal((out.match(/\*\*/g) ?? []).length % 2, 0, out);
  assert.ok(out.endsWith("**…"), out);
});

test("the count restarts on every line and at the end nothing is lost", () => {
  const text = `• A: ${words(20)}\n• B: ${words(20)}`;
  assert.equal(runAllWays(text, { maxWords: 25 }), text);
});

test("with maxSegments, a long line continues on an indented line at its last clause break", () => {
  const line = `• MECHANICS: ${words(19)}, ${words(10, 20)} and more words here.`;
  assert.equal(
    runAllWays(`${line}\n• TRADE-OFF: short.`, { maxWords: 25, maxSegments: 3 }),
    `• MECHANICS: ${words(19)},\n${CONTINUATION}${words(10, 20)} and more words here.\n• TRADE-OFF: short.`,
  );
});

test("with maxSegments and no clause break, the line continues at the cap", () => {
  assert.equal(runAllWays(`• COST: ${words(40)}`, { maxWords: 25, maxSegments: 3 }), `• COST: ${words(23)}\n${CONTINUATION}${words(17, 24)}`);
});

test("a condition after the cap is kept, not dropped", () => {
  const line = "• MECHANICS: Allocate a larger contiguous buffer and copy each existing element into its matching position while preserving iteration order, but never publish the new pointer until allocation succeeds.";
  const out = runAllWays(line, { maxWords: 25, maxSegments: 3 });
  assert.ok(out.includes("but never publish the new pointer until allocation succeeds."), out);
  assert.equal(out.split("\n").length, 2, out);
});

test("past maxSegments the last segment is cut with an ellipsis", () => {
  const cap = createLineCap({ maxWords: 25, maxSegments: 3 });
  const out = cap.push(`• COST: ${words(100)}\n• TRADE-OFF: short.`) + cap.flush();
  assert.equal(out, `• COST: ${words(23)}\n${CONTINUATION}${words(25, 24)}\n${CONTINUATION}${words(25, 49)}…\n• TRADE-OFF: short.`);
  assert.equal(cap.wraps, 2);
  assert.equal(cap.cuts, 1);
});

test("a wrap streams: the held words go out with the break", () => {
  // Cap 8 words, hold the last 2: words 1-6 stream, 7-8 are held, the 9th wraps.
  const cap = createLineCap({ maxWords: 8, holdWords: 2, maxSegments: 2 });
  assert.equal(cap.push("• A: one two three four"), "• A: one two three four");
  assert.equal(cap.push(" five six seven"), ` five six\n${CONTINUATION}seven`);
  assert.equal(cap.push(" eight\n• B: next"), " eight\n• B: next");
  assert.equal(cap.flush(), "");
  assert.equal(cap.wraps, 1);
  assert.equal(cap.cuts, 0);
});

test("a key phrase open at a wrap is closed there and opened again on the next line", () => {
  const out = runAllWays(`• VERDICT: **${words(14)}** done.`, { maxWords: 12, maxSegments: 3 });
  const [first, second] = out.split("\n");
  assert.equal(first, `• VERDICT: **${words(10)}**`);
  assert.equal(second, `${CONTINUATION}**w11 w12 w13 w14** done.`);
});
