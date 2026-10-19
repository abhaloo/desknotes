import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSpokenTextFilter } from "../src/server/engines/spoken-text-filter.js";

/** Filter output captured on 0926e36, before highlights existed. */
const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(here, "fixtures", "highlights-off-baseline.json"), "utf8"));

function run(deltas, options = { highlights: true }) {
  const filter = createSpokenTextFilter(options);
  return deltas.map((delta) => filter.push(delta)).join("") + filter.flush();
}
const on = (text) => run([text]);

/** Every way to cut `text` in two, plus one character per delta. */
function splits(text) {
  const out = [Array.from(text)];
  for (let cut = 1; cut < text.length; cut += 1) out.push([text.slice(0, cut), text.slice(cut)]);
  return out;
}

test("off: every push and flush is byte-identical to the filter before highlights", () => {
  assert.ok(BASELINE.filter.length >= 30);
  for (const options of [undefined, {}, { highlights: false }]) {
    for (const { deltas, pushes, flush } of BASELINE.filter) {
      const filter = createSpokenTextFilter(options);
      assert.deepEqual(deltas.map((delta) => filter.push(delta)), pushes, JSON.stringify(deltas));
      assert.equal(filter.flush(), flush, JSON.stringify(deltas));
    }
  }
});

test("on: a key phrase keeps its pair, and the rest of the cleanup is unchanged", () => {
  assert.equal(on("- Use **Go Live** to start.\n- Only **one session at a time** runs."), "• Use **Go Live** to start.\n• Only **one session at a time** runs.");
  assert.equal(on('Click **"Return to session"** to come back.'), '• Click **"Return to session"** to come back.');
  assert.equal(on("We cut costs — **about 30%** — last year."), "• We cut costs, **about 30%**, last year.");
  assert.equal(on("“**Yes**,” she said 🚀"), '• "**Yes**," she said');
  assert.equal(on("__under__ and *single* emphasis"), "• under and single emphasis", "a lone star is dropped when highlights are on");
  assert.equal(on("No phrase here."), "• No phrase here.");
});

test("on: a marker split across deltas at every position gives the same answer", () => {
  const text = "- Use **Go Live** to start.\n- Then **Return to session**.";
  const want = "• Use **Go Live** to start.\n• Then **Return to session**.";
  for (const deltas of splits(text)) assert.equal(run(deltas), want, JSON.stringify(deltas));
});

test("on: at most one phrase per bullet and three per answer; extras stream unwrapped", () => {
  assert.equal(on("**One** and **two** here."), "• **One** and two here.");
  assert.equal(
    on("- **A** one.\n- **B** two.\n- **C** three.\n- **D** four."),
    "• **A** one.\n• **B** two.\n• **C** three.\n• D four.",
  );
  // The two-sentence split starts a new bullet, and so a new allowance.
  assert.equal(on("Go **Live**. Then **wait**. Third **one** here."), "• Go **Live**. Then wait.\n• Third **one** here.");
});

test("on: a phrase over five words goes out unwrapped", () => {
  assert.equal(on("You get **one live session at a time** here."), "• You get one live session at a time here.");
  assert.equal(on("**a b c d e** fits"), "• **a b c d e** fits");
  for (const deltas of splits("x **a b c d e f** y")) assert.equal(run(deltas), "• x a b c d e f y", JSON.stringify(deltas));
});

test("on: an open phrase closes at the line break and at the end of the answer", () => {
  assert.equal(on("- Use **Go Live\n- Next one."), "• Use **Go Live**\n• Next one.");
  assert.equal(on("It ends **open"), "• It ends **open**");
  assert.equal(on("It ends **open   "), "• It ends **open**");
});

test("on: empty pairs, stray markers and star runs never show a star", () => {
  assert.equal(on("Empty ** ** pair and ****"), "• Empty pair and");
  assert.equal(on("***Bold italic*** text"), "• **Bold italic** text");
  assert.equal(on("Trailing marker **"), "• Trailing marker");
  assert.equal(on("Only punctuation **:** here"), "• Only punctuation : here");
  assert.equal(on("Use ** Go Live ** now"), "• Use **Go Live** now");
  assert.equal(on("x *🚀**two** y"), "• x **two** y", "a star next to a removed emoji never touches a marker");
});

test("on: a kept phrase is held only until it closes; plain text still streams", () => {
  const filter = createSpokenTextFilter({ highlights: true });
  assert.equal(filter.push("Use "), "• Use");
  assert.equal(filter.push("**Go"), " ", "the space before the phrase is plain text");
  assert.equal(filter.push(" Live"), "", "the phrase waits for its closer");
  assert.equal(filter.push("** to start"), "**Go Live** to start");
  assert.equal(filter.flush(), "");
  const capped = createSpokenTextFilter({ highlights: true });
  assert.equal(capped.push("**A** b **c"), "• **A** b c", "past the cap: streams at once");
});
