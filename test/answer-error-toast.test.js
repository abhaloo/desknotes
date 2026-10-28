import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANSWER_RETRY_TEXT, answerErrorText } from "../src/desktop/renderer/answer-error.js";

/**
 * A failed answer used to be silent: the turn closed with empty text and the
 * card stayed blank, so a billing refusal looked like the app ignoring the
 * call. The `error` frame now becomes one short toast that names the fix.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(join(here, "..", "src", "desktop", "renderer", file), "utf8");

test("a refused answer names the fix, not the provider's error string", () => {
  // The exact message the Cerebras 402 produced in the session files.
  assert.match(
    answerErrorText({ code: "generation_failed", message: "answerer: chat endpoint HTTP 402" }),
    /out of credit.*Settings/,
  );
  assert.match(answerErrorText({ message: "chat endpoint HTTP 401" }), /API key/);
  assert.match(answerErrorText({ message: "chat endpoint HTTP 403" }), /refuses this account/);
  assert.match(answerErrorText({ message: "answerer: chat endpoint HTTP 429" }), /rate-limited/);
  assert.match(answerErrorText({ message: "provider request failed: fetch failed" }), /No connection/);
});

test("an unknown failure keeps a usable sentence, and a dead session gets no toast", () => {
  const generic = answerErrorText({ code: "generation_failed", message: "answerer.streamAnswer did not return an async iterable" });
  assert.match(generic, /No answer came back/);
  assert.equal(generic.includes("async iterable"), false, "no developer text reaches the overlay");
  // The realtime client already latched the session; a toast would double it.
  assert.equal(answerErrorText({ code: "session_ended" }), "");
  assert.equal(answerErrorText({ code: "session_not_found" }), "");
  assert.ok(answerErrorText({}).length > 0);
  assert.match(ANSWER_RETRY_TEXT, /Retrying/);
});

test("the overlay turns error and error.retry frames into toasts", () => {
  const app = read("app.js");
  assert.match(app, /import \{ ANSWER_RETRY_TEXT, answerErrorText \} from "\.\/answer-error\.js";/);
  assert.match(app, /case "error\.retry":[\s\S]{0,200}showToast\(ANSWER_RETRY_TEXT, "info", 2600\)/);
  assert.match(app, /case "error": \{[\s\S]{0,200}showToast\(text, "error", 7000\)/);
  // A session-dead code is not toasted twice: the text is empty and skipped.
  assert.match(app, /const text = answerErrorText\(data\);\s*if \(text\) showToast\(text/);
  // The toast has a style for the info kind it now uses.
  assert.match(read("styles.css"), /\.toast\[data-kind="info"\]/);
});

test("error.retry also starts the card over before the retry's tokens arrive", () => {
  const app = read("app.js");
  // The buffer resets the card (answers.restart) and the card repaints: `break` to renderAnswer, not `return`.
  assert.match(app, /case "error\.retry":[\s\S]{0,400}answers\.restart\(data, Date\.now\(\)\)/);
  assert.match(app, /case "error\.retry":(?:(?!return;)[\s\S]){0,400}break;/);
});
