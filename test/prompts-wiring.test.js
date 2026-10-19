import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

/** startEmbeddedServer's source: from its header to the next top-level function. */
function embeddedServerBody(source) {
  const start = source.indexOf("async function startEmbeddedServer");
  assert.ok(start >= 0, "startEmbeddedServer not found");
  const next = source.slice(start + 1).search(/\n(async )?function /);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

test("package.json ships the prompts folder", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.build.files.includes("prompts/**/*"));
});

test("main.mjs configures prompts before the embedded server starts", () => {
  const body = embeddedServerBody(read("src/desktop/main.mjs"));
  const configured = body.indexOf("engines.configurePrompts(");
  assert.ok(configured >= 0, "startEmbeddedServer does not configure prompts");
  assert.ok(configured < body.indexOf("new RealtimeServer("), "prompts are configured after the server is built");
});

test("the standalone server configures prompts", () => {
  const source = read("src/server/main.js");
  const configured = source.indexOf("configurePrompts(");
  assert.ok(configured >= 0, "src/server/main.js does not configure prompts");
  assert.ok(configured < source.indexOf("createEngineFactory("), "prompts are configured after the engine factory");
});
