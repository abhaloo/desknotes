import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Between "the question is processed" (turn.started) and the first token,
 * the answer box shows an animated "Thinking..." line and the badge says
 * "thinking"; a screen capture shows "Reading the screen...". No live region:
 * the overlay stays silent to screen readers on a shared screen.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(join(here, "..", "src", "desktop", "renderer", file), "utf8");

test("app: pending is a started, unfinished answer with no text yet", () => {
  const app = read("app.js");
  assert.match(app, /const pending = Boolean\(active && !active\.done && !active\.text\);/);
  assert.match(app, /if \(screenBusy\) return "Reading the screen";\s*return pending \? "Thinking" : "";/);
  assert.match(app, /els\.answerText\.classList\.toggle\("pending", loading !== ""\);/);
  assert.match(app, /els\.answerText\.classList\.toggle\("streaming", answers\.isStreaming && !pending\);/, "no caret before the first word");
  assert.match(app, /pending \? "thinking" : "streaming"/);
  assert.match(app, /pending \? "pending" : "active"/);
});

test("css: the loading line animates its dots, and holds still for reduced motion", () => {
  const css = read("styles.css");
  assert.match(css, /\.answer-text\.pending::before \{[^}]*content: attr\(data-loading\)[^}]*animation: loading-dots/);
  assert.match(css, /@keyframes loading-dots/);
  assert.match(css, /#answer-state\[data-state="pending"\] \{/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.answer-text\.pending::before \{\s*animation: none;/);
  const html = read("index.html");
  assert.ok(!/aria-live/.test(html), "no live region");
});
