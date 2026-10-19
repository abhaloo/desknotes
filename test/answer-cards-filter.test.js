import test from "node:test";
import assert from "node:assert/strict";
import { createSpokenTextFilter } from "../src/server/engines/spoken-text-filter.js";

function run(deltas, options) {
  const filter = createSpokenTextFilter(options);
  return deltas.map((delta) => filter.push(delta)).join("") + filter.flush();
}

/** The same text streamed whole, then in 1- and 3-character pieces, must give one result. */
function runAllWays(text, options) {
  const whole = run([text], options);
  assert.equal(run([...text], options), whole, "1-char deltas");
  assert.equal(run(text.match(/[\s\S]{1,3}/g), options), whole, "3-char deltas");
  return whole;
}

test("a fenced code block passes through exactly as written, fence lines included", () => {
  const text = "- VERDICT: use a map.\n```python\ndef f(a, b):\n    # sum - minus\n    return a - b * 2  # “quoted” — 🚀\n```\n- TRADE-OFF: memory.";
  assert.equal(
    runAllWays(text),
    "• VERDICT: use a map.\n```python\ndef f(a, b):\n    # sum - minus\n    return a - b * 2  # “quoted” — 🚀\n```\n• TRADE-OFF: memory.",
  );
  assert.equal(runAllWays(text, { highlights: true }), runAllWays(text), "highlights do not touch code");
});

test("a block that opens the answer, or is never closed, is closed at the end", () => {
  assert.equal(runAllWays("```js\nconst x = 1;"), "```js\nconst x = 1;\n```");
  assert.equal(runAllWays("```js\nconst x = 1;\n"), "```js\nconst x = 1;\n```");
});

test("inline code is not rewritten", () => {
  assert.equal(runAllWays("Use `a - b` and `x -- y` here."), "• Use `a - b` and `x -- y` here.");
  assert.equal(runAllWays("Call `f(a ? b : c)`. Then `g()`. Then stop."), "• Call `f(a ? b : c)`. Then `g()`.\n• Then stop.");
});

test("a spaced hyphen with a digit on one side, or inside brackets, is a minus sign", () => {
  assert.equal(runAllWays("Index with hash & (cap - 1) for tables."), "• Index with hash & (cap - 1) for tables.");
  assert.equal(runAllWays("Keep n - 1 items."), "• Keep n - 1 items.");
  assert.equal(runAllWays("z = (current_value - rolling_mean) / std"), "• z = (current_value - rolling_mean) / std");
  // Prose dashes between words still become commas; an en dash between numbers still reads "to".
  assert.equal(runAllWays("fast - really"), "• fast, really");
  assert.equal(runAllWays("pages 10–20"), "• pages 10 to 20");
  // A spaced hyphen between numbers may be a minus, so it stays as written.
  assert.equal(runAllWays("COST: 5 - 3 = 2."), "• COST: 5 - 3 = 2.");
  assert.equal(runAllWays("from 2019 - 2021"), "• from 2019 - 2021");
});

test("arrows are not dashes", () => {
  assert.equal(runAllWays("Sensors +--> Queue -> DB <-- API"), "• Sensors +--> Queue -> DB <-- API");
});

test("a ? or . inside brackets does not end a sentence", () => {
  assert.equal(
    runAllWays("Grow by (n < 9 ? 3 : 6) plus n. Java grows 1.5x. Done."),
    "• Grow by (n < 9 ? 3 : 6) plus n. Java grows 1.5x.\n• Done.",
  );
});

test("with highlights on, a lone * between spaces is multiplication and stays", () => {
  assert.equal(runAllWays("Mark stale after interval * 3 seconds.", { highlights: true }), "• Mark stale after interval * 3 seconds.");
  assert.equal(runAllWays("Click **Go Live** now.", { highlights: true }), "• Click **Go Live** now.");
});

test("maxLines: the filter stops before the line past the budget and reports full", () => {
  const text = "- A one.\n- B two.\n- C three.\n- D four.\n- E five.";
  assert.equal(runAllWays(text, { maxLines: 3 }), "• A one.\n• B two.\n• C three.");
  const filter = createSpokenTextFilter({ maxLines: 2 });
  assert.equal(filter.full, false);
  const first = filter.push("- A one.\n- B two.\n- C");
  assert.equal(first, "• A one.\n• B two.");
  assert.equal(filter.full, true);
  assert.equal(filter.push(" three."), "", "nothing goes out once full");
  assert.equal(filter.flush(), "");
  // A sentence split that would open a line past the budget also stops it.
  assert.equal(runAllWays("One. Two. Three. Four.", { maxLines: 1 }), "• One. Two.");
});

test("maxLines: a code block is not a bullet line", () => {
  const text = "- V: x\n```\ncode - 1\n```\n- T: y\n- Z: z";
  assert.equal(runAllWays(text, { maxLines: 2 }), "• V: x\n```\ncode - 1\n```\n• T: y");
});

test("maxCodeLines: a runaway block ends with a cut mark, is closed, and the answer ends", () => {
  const filter = createSpokenTextFilter({ maxCodeLines: 3 });
  const out = filter.push("```\na\nb\nc\nd\n```\n- after") + filter.flush();
  assert.equal(out, "```\na\nb\nc\n…\n```");
  assert.equal(filter.full, true);
  assert.equal(filter.cut, "code");
});

test("maxCodeLines counts body lines only: a block that ends at the limit is complete", () => {
  const text = "```js\na\n  b\nc\n```\n- after";
  assert.equal(runAllWays(text, { maxCodeLines: 3 }), "```js\na\n  b\nc\n```\n• after");
  const filter = createSpokenTextFilter({ maxCodeLines: 3 });
  filter.push(text);
  filter.flush();
  assert.equal(filter.cut, null);
});

test("reserveLabel: past the line budget, a later TRADE-OFF line still goes out, once", () => {
  const text = "- VERDICT: v.\n- A: a.\n- B: b.\n- C: c.\n- TRADE-OFF: t.\n- D: d.\n- TRADE-OFF: again.";
  const options = { maxLines: 3, reserveLabel: "TRADE-OFF" };
  assert.equal(runAllWays(text, options), "• VERDICT: v.\n• A: a.\n• B: b.\n• TRADE-OFF: t.");
  for (const label of ["**TRADE-OFF**: t.", "Trade-off: t.", "TRADE-OFFS: t.", "TRADEOFF: t."]) {
    const out = runAllWays(`- VERDICT: v.\n- A: a.\n- B: b.\n${label}`, { maxLines: 2, reserveLabel: "TRADE-OFF", highlights: true });
    assert.ok(out.endsWith(`\n• ${label}`), `${label} -> ${out}`);
  }
  const filter = createSpokenTextFilter(options);
  filter.push(text);
  filter.flush();
  assert.equal(filter.cut, "lines");
});

test("reserveLabel: without a TRADE-OFF line the card stops at the budget, and the scan is bounded", () => {
  const options = { maxLines: 2, reserveLabel: "TRADE-OFF" };
  assert.equal(runAllWays("- VERDICT: v.\n- A: a.\n- B: b.\n- C: c.", options), "• VERDICT: v.\n• A: a.");
  const filter = createSpokenTextFilter(options);
  filter.push("- VERDICT: v.\n- A: a.\n");
  assert.equal(filter.full, false);
  filter.push(Array.from({ length: 200 }, (_, i) => `- LINE: filler line number ${i}.\n`).join(""));
  assert.equal(filter.full, true, "the scan for a TRADE-OFF line gives up");
  assert.equal(filter.cut, "lines");
});

test("reserveLabel: a TRADE-OFF line after a cut code block still goes out", () => {
  const text = "- VERDICT: v.\n```\na\nb\nc\nd\n```\n- TRADE-OFF: t.";
  assert.equal(runAllWays(text, { maxCodeLines: 2, reserveLabel: "TRADE-OFF" }), "• VERDICT: v.\n```\na\nb\n…\n```\n• TRADE-OFF: t.");
});

test("reserveLabel list: past the line budget, a later NEXT STEP line still goes out, once", () => {
  const text = "- VERDICT: v.\n- A: a.\n- B: b.\n- NEXT STEP: n.";
  assert.equal(runAllWays(text, { maxLines: 2, reserveLabel: ["TRADE-OFF", "NEXT STEP"] }), "• VERDICT: v.\n• A: a.\n• NEXT STEP: n.");
});

test("reserveLabel list: a TRADE-OFF line still goes out", () => {
  const text = "- VERDICT: v.\n- A: a.\n- B: b.\n- TRADE-OFF: t.";
  assert.equal(runAllWays(text, { maxLines: 2, reserveLabel: ["TRADE-OFF", "NEXT STEP"] }), "• VERDICT: v.\n• A: a.\n• TRADE-OFF: t.");
});

test("reserveLabel list: only the first closing line goes out", () => {
  const options = { maxLines: 2, reserveLabel: ["TRADE-OFF", "NEXT STEP"] };
  assert.equal(runAllWays("- VERDICT: v.\n- A: a.\n- B: b.\n- NEXT STEP: n.\n- TRADE-OFF: t.", options), "• VERDICT: v.\n• A: a.\n• NEXT STEP: n.");
  assert.equal(runAllWays("- VERDICT: v.\n- A: a.\n- B: b.\n- TRADE-OFF: t.\n- NEXT STEP: n.", options), "• VERDICT: v.\n• A: a.\n• TRADE-OFF: t.");
});

test("cut is null when the card fits its budget", () => {
  const filter = createSpokenTextFilter({ maxLines: 3, reserveLabel: "TRADE-OFF" });
  filter.push("- VERDICT: v.\n- TRADE-OFF: t.");
  filter.flush();
  assert.equal(filter.cut, null);
  assert.equal(filter.full, false);
});

test("highlightLines: key phrases only in the first lines", () => {
  const text = "- VERDICT: use **Go Live** now.\n- HOW: click **Start** here.";
  assert.equal(runAllWays(text, { highlights: true, highlightLines: 1 }), "• VERDICT: use **Go Live** now.\n• HOW: click Start here.");
});

test("sentencesPerBullet: Infinity keeps the model's own lines", () => {
  assert.equal(runAllWays("One. Two. Three. Four.", { sentencesPerBullet: Infinity }), "• One. Two. Three. Four.");
  assert.equal(runAllWays("- A. B. C.\n- D.", { sentencesPerBullet: Infinity }), "• A. B. C.\n• D.");
});

test("highlightsPerAnswer raises the per-answer cap; one mark per line still holds", () => {
  const text = "- A: **one**\n- B: **two**\n- C: **three**\n- D: **four** and **five**";
  assert.equal(runAllWays(text, { highlights: true }), "• A: **one**\n• B: **two**\n• C: **three**\n• D: four and five", "default: three per answer");
  assert.equal(runAllWays(text, { highlights: true, highlightsPerAnswer: 7 }), "• A: **one**\n• B: **two**\n• C: **three**\n• D: **four** and five");
});
