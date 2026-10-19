import test from "node:test";
import assert from "node:assert/strict";
import { createSpokenTextFilter } from "../src/server/engines/spoken-text-filter.js";

function run(deltas) {
  const filter = createSpokenTextFilter();
  return deltas.map((delta) => filter.push(delta)).join("") + filter.flush();
}

test("every line starts with a bullet and a space, across deltas", () => {
  assert.equal(run(["Hello there. ", "We ship weekly."]), "• Hello there. We ship weekly.");
  assert.equal(run(["One.\n\nTwo."]), "• One.\n• Two.");
  assert.equal(run(["We have 30"]), "• We have 30");
  assert.equal(run([""]), "", "an empty answer stays empty");
});

test("em and en dashes become commas, and ranges between digits become 'to'", () => {
  assert.equal(run(["costs ", "—", " about"]), "• costs, about");
  assert.equal(run(["We cut costs — about 30% — last year."]), "• We cut costs, about 30%, last year.");
  assert.equal(run(["pages 10", "–", "20."]), "• pages 10 to 20.");
  assert.equal(run(["from 2019 - 2021"]), "• from 2019 - 2021", "a spaced hyphen between numbers may be a minus: it stays");
  assert.equal(run(["fast -- really fast"]), "• fast, really fast");
  assert.equal(run(["fast - really"]), "• fast, really");
  assert.equal(run(["Done. — Next"]), "• Done. Next");
  assert.equal(run(["— Sure thing"]), "• Sure thing");
  assert.equal(run(["First.\n— Second"]), "• First.\n• Second", "a dash opening a line is a marker, not a comma");
});

test("hyphenated words are left alone", () => {
  assert.equal(run(["end-to-end and trade-off"]), "• end-to-end and trade-off");
  assert.equal(run(["end-", "to-end"]), "• end-to-end");
});

test("the model's own markers, headings and emphasis become plain '• ' bullets", () => {
  assert.equal(run(["**Bold** and __under__ text"]), "• Bold and under text");
  assert.equal(run(["**Bo", "ld*", "* text"]), "• Bold text");
  assert.equal(
    run(["## Plan\n- First item\n- Second item\n1. Third"]),
    "• Plan\n• First item\n• Second item\n• Third",
  );
  assert.equal(run(["* one\n", "* two"]), "• one\n• two");
  assert.equal(run(["- one\n\n\n- two"]), "• one\n• two", "blank lines between bullets collapse");
  assert.equal(run(["- ", "Split marker"]), "• Split marker", "a marker split across deltas is not doubled");
  assert.equal(run(["• Already a bullet"]), "• Already a bullet", "the model's own bullet glyph is not doubled");
});

test("curly quotes become straight quotes", () => {
  assert.equal(run(["“Yes,” she said, ‘it’s fine’"]), "• \"Yes,\" she said, 'it's fine'");
});

test("emojis are removed and the spaces around them collapse", () => {
  assert.equal(run(["Great work 🚀🎉 team ✅"]), "• Great work team");
});

test("leading and trailing whitespace is dropped", () => {
  assert.equal(run(["  Hello  "]), "• Hello");
});

test("push never returns held-back pattern starts; flush releases them", () => {
  const filter = createSpokenTextFilter();
  assert.equal(filter.push("costs "), "• costs");
  assert.equal(filter.push("—"), "");
  assert.equal(filter.push(" about"), ", about");
  assert.equal(filter.flush(), "");
});

test("a bullet holds at most two sentences; the third starts a new bullet", () => {
  const five = "One is here. Two is here! Three is here? Four is here. Five is here.";
  const want = "• One is here. Two is here!\n• Three is here? Four is here.\n• Five is here.";
  assert.equal(run([five]), want);
  // Streamed in tiny pieces, the breaks land in the same places.
  assert.equal(run(five.match(/.{1,3}/gs)), want);
  assert.equal(run(["One. Two."]), "• One. Two.", "two sentences: one bullet, no trailing break");
});

test("sentence counting ignores decimals, abbreviations and lowercase continuations", () => {
  assert.equal(run(["It costs $4.50 a seat. Mr. Smith agreed. See e.g. the docs. Done."]),
    "• It costs $4.50 a seat. Mr. Smith agreed.\n• See e.g. the docs. Done.");
  // A closing quote after the full stop still ends the sentence.
  assert.equal(run(['He said "yes." We signed. Done.']), '• He said "yes." We signed.\n• Done.');
});

test("a line break from the model starts a new bullet and restarts the count", () => {
  assert.equal(run(["One.\nTwo. Three. Four."]), "• One.\n• Two. Three.\n• Four.");
});
