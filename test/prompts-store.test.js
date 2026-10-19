import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import {
  PROMPT_FILES,
  configurePrompts,
  createPromptStore,
  loadPromptSet,
  prompt,
} from "../src/server/engines/prompts.js";

const JUDGE_TEXT = '{"is_question":{"type":"noul","instructions":"q","criteria":{"true":"y","false":"n"}}}';

function put(dir, rel, text) {
  const file = join(dir, rel);
  nodeFs.mkdirSync(dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text);
  return file;
}

function tempDir(t) {
  const dir = nodeFs.mkdtempSync(join(os.tmpdir(), "prompts-"));
  t.after(() => nodeFs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A root whose set "t" holds every id; `texts` replaces entries by id. */
function makeRoot(t, texts = {}) {
  const root = tempDir(t);
  for (const [id, rel] of Object.entries(PROMPT_FILES)) {
    put(join(root, "t"), rel, id === "judge" ? JUDGE_TEXT : `text of ${id}`);
  }
  for (const [id, text] of Object.entries(texts)) put(join(root, "t"), PROMPT_FILES[id], text);
  return root;
}

/** An override folder; `texts` maps ids to file text. */
function makeOverrides(t, texts) {
  const dir = tempDir(t);
  for (const [id, text] of Object.entries(texts)) put(join(dir, "t"), PROMPT_FILES[id], text);
  return dir;
}

test("loads every id of a set", (t) => {
  const texts = loadPromptSet({ root: makeRoot(t), set: "t" });
  assert.equal(texts["cards/card"], "text of cards/card");
  for (const id of Object.keys(PROMPT_FILES)) {
    if (id !== "judge") assert.equal(texts[id], `text of ${id}`, id);
  }
  assert.equal(texts.judge, JUDGE_TEXT);
});

test("CRLF files load as LF and lose one trailing newline", (t) => {
  const root = makeRoot(t, { "cards/card": "a\r\nb\r\n" });
  assert.equal(loadPromptSet({ root, set: "t" })["cards/card"], "a\nb");
});

test("includes are resolved one level", (t) => {
  const root = makeRoot(t, { "answer/spoken": "X {{rules/no-chatbot}} Y", "rules/no-chatbot": "NC" });
  assert.equal(loadPromptSet({ root, set: "t" })["answer/spoken"], "X NC Y");
});

test("an unknown include throws", (t) => {
  const root = makeRoot(t, { "answer/spoken": "{{rules/nope}}" });
  assert.throws(() => loadPromptSet({ root, set: "t" }), /unknown prompt include: rules\/nope in answer\/spoken/);
});

test("a nested include throws", (t) => {
  const root = makeRoot(t, {
    "rules/no-chatbot": "{{rules/surface}}",
    "answer/spoken": "{{rules/no-chatbot}}",
  });
  assert.throws(() => loadPromptSet({ root, set: "t" }), /nested prompt include in answer\/spoken/);
});

test("a missing shipped file throws", (t) => {
  const root = makeRoot(t);
  nodeFs.rmSync(join(root, "t", "cards", "card.md"));
  assert.throws(() => loadPromptSet({ root, set: "t" }), /prompt file missing: .*cards[\\/]card\.md/);
});

test("an override wins", (t) => {
  const root = makeRoot(t);
  const overrideDir = makeOverrides(t, { "cards/card": "mine" });
  const store = createPromptStore({ root, set: "t", overrideDir });
  assert.equal(store.get("cards/card"), "mine");
});

test("an empty override falls back", (t) => {
  const root = makeRoot(t);
  const overrideDir = makeOverrides(t, { "cards/card": "  \n" });
  const store = createPromptStore({ root, set: "t", overrideDir });
  assert.equal(store.get("cards/card"), "text of cards/card");
});

test("variables are filled at get time", (t) => {
  const root = makeRoot(t, { "vision/interpret": "max {{max_chars}}" });
  const store = createPromptStore({ root, set: "t" });
  assert.equal(store.get("vision/interpret", { max_chars: 1200 }), "max 1200");
  assert.equal(store.get("vision/interpret"), "max {{max_chars}}");
});

test("variable values are not re-expanded", (t) => {
  const root = makeRoot(t, { "terms/user": "{{skip}}|{{card}}" });
  const store = createPromptStore({ root, set: "t" });
  assert.equal(store.get("terms/user", { skip: "{{card}}", card: "C" }), "{{card}}|C");
});

test("json returns the parsed object", (t) => {
  const store = createPromptStore({ root: makeRoot(t), set: "t" });
  assert.equal(store.json("judge").is_question.type, "noul");
});

test("invalid JSON override falls back", (t) => {
  const root = makeRoot(t);
  const overrideDir = makeOverrides(t, { judge: "{bad" });
  const logs = [];
  const store = createPromptStore({ root, set: "t", overrideDir, log: (event) => logs.push(event) });
  assert.deepEqual(store.json("judge"), JSON.parse(JUDGE_TEXT));
  assert.deepEqual(logs, [{ type: "prompts.override_invalid", id: "judge" }]);
});

test("a failed reload keeps the previous texts", (t) => {
  const root = makeRoot(t);
  const logs = [];
  const store = createPromptStore({ root, set: "t", log: (event) => logs.push(event) });
  nodeFs.rmSync(join(root, "t", "cards", "card.md"));
  assert.equal(store.reload(), false);
  assert.equal(store.get("cards/card"), "text of cards/card");
  assert.ok(logs.some((event) => event.type === "prompts.reload_failed"));
});

test("watch reloads after the debounce", async (t) => {
  const root = makeRoot(t);
  const overrideDir = makeOverrides(t, {});
  const watched = [];
  const closed = [];
  const watchFn = (dir, options, listener) => {
    watched.push({ dir, options, listener });
    return { close: () => closed.push(dir) };
  };
  const store = createPromptStore({ root, set: "t", overrideDir, watchFn, debounceMs: 20 });
  store.watch();
  assert.deepEqual(watched.map((entry) => entry.dir), [join(root, "t"), join(overrideDir, "t")]);

  put(join(overrideDir, "t"), PROMPT_FILES["cards/card"], "fresh");
  watched[1].listener("change", "card.md");
  await new Promise((resolve) => setTimeout(resolve, 20 + 50));
  assert.equal(store.get("cards/card"), "fresh");

  store.close();
  assert.equal(closed.length, 2);
});

test("configurePrompts swaps the active store and prompt() reads it", (t) => {
  const root = makeRoot(t);
  configurePrompts({ root, set: "t" });
  assert.equal(prompt("cards/card"), "text of cards/card");
});

test("an unknown set falls back to the default", (t) => {
  const root = makeRoot(t);
  nodeFs.writeFileSync(join(root, "sets.json"), JSON.stringify({ default: "t", sets: { t: "Test set" } }));
  const logs = [];
  const store = configurePrompts({ root, set: "zzz", log: (event) => logs.push(event) });
  assert.deepEqual(logs, [{ type: "prompts.unknown_set", set: "zzz" }]);
  assert.equal(store.set, "t");
});
