import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnswerBuffer } from "../src/desktop/renderer/answer-buffer.js";
import { fallbackNoteText } from "../src/desktop/renderer/answer-fallback.js";
import { answerErrorText } from "../src/desktop/renderer/answer-error.js";

/**
 * A stand-in model (turn.done `fallback`) gets one quiet line after the card,
 * like "Answer cut short.": never inside the card text, never while streaming.
 */
const here = dirname(fileURLToPath(import.meta.url));
const readRenderer = (file) => readFileSync(join(here, "..", "src", "desktop", "renderer", file), "utf8");
const NOTE = Object.freeze({ to: "DeepSeek Flash", from: "Qwen 27B", reason: "out_of_credit" });

test("turn.done fallback lands on the entry; the next turn starts clean", () => {
  const answers = new AnswerBuffer();
  answers.start({ turn_id: "t1", question: "q" }, 1);
  assert.equal(answers.active.fallback, null, "nothing while streaming");
  answers.done({ turn_id: "t1", text: "• VERDICT: x.", fallback: NOTE }, 2);
  assert.deepEqual(answers.active.fallback, NOTE);
  answers.start({ turn_id: "t2", question: "q2" }, 3);
  assert.equal(answers.active.fallback, null);
  answers.done({ turn_id: "t2", text: "• VERDICT: y." }, 4);
  assert.equal(answers.active.fallback, null);
  answers.done({ turn_id: "t3", text: "z", fallback: "DeepSeek" }, 5);
  assert.equal(answers.active.fallback, null, "only an object with a model name counts");
});

test("the note names the stand-in first, then why, in a few words", () => {
  assert.equal(fallbackNoteText(NOTE), "Fallback: DeepSeek Flash · Qwen 27B out of credit");
  assert.equal(fallbackNoteText({ ...NOTE, reason: "key_rejected" }), "Fallback: DeepSeek Flash · Qwen 27B key rejected");
  assert.equal(fallbackNoteText({ ...NOTE, reason: "refused" }), "Fallback: DeepSeek Flash · Qwen 27B refused");
  assert.equal(fallbackNoteText({ ...NOTE, reason: "rate_limited" }), "Fallback: DeepSeek Flash · Qwen 27B rate-limited");
  assert.equal(fallbackNoteText({ ...NOTE, reason: "stalled" }), "Fallback: DeepSeek Flash · Qwen 27B stalled");
  assert.equal(fallbackNoteText({ ...NOTE, reason: "failed" }), "Fallback: DeepSeek Flash · Qwen 27B failed");
  assert.equal(
    fallbackNoteText({ to: "Qwen 27B", from: "DeepSeek Flash", reason: "no_key" }),
    "Fallback: Qwen 27B · no key for DeepSeek Flash",
  );
  assert.equal(fallbackNoteText({ to: "DeepSeek Flash", reason: "something new" }), "Fallback: DeepSeek Flash");
  assert.equal(fallbackNoteText({ to: "DeepSeek Flash", from: "Qwen 27B" }), "Fallback: DeepSeek Flash");
  assert.equal(fallbackNoteText(null), "");
  assert.equal(fallbackNoteText({ from: "Qwen 27B" }), "");
});

test("renderer: a done answer from a stand-in carries the note; CSS shows it after the text, with the cut note", () => {
  const app = readRenderer("app.js");
  const css = readRenderer("styles.css");
  assert.match(app, /import \{ fallbackNoteText \} from "\.\/answer-fallback\.js";/);
  assert.match(app, /const fallback = active\?\.done \? fallbackNoteText\(active\.fallback\) : "";/);
  assert.match(app, /if \(fallback\) els\.answerText\.dataset\.fallback = fallback;\s*else delete els\.answerText\.dataset\.fallback;/);
  assert.match(css, /\.answer-text\[data-fallback\]::after \{\s*content: attr\(data-fallback\);\s*\}/);
  assert.match(css, /\.answer-text\[data-cut\]\[data-fallback\]::after \{[^}]*content: "Answer cut short\." "\\A" attr\(data-fallback\)/);
  assert.match(css, /\.answer-text\[data-cut\]::after,\s*\.answer-text\[data-fallback\]::after \{[^}]*color: var\(--muted\)/);
});

test("no answer model: the toast says how to fix it, and Settings never promises demo text", () => {
  assert.match(
    answerErrorText({ code: "generation_failed", message: "answerer: no answer model is set up (unconfigured)" }),
    /No answer model is set up\. Add a DeepSeek or Cerebras key in Settings > Edit keys…, then restart the app\./,
  );
  assert.equal(readRenderer("app.js").includes("demo text"), false);
});
