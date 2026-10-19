import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_GLOSSARY_TIMEOUT_MS,
  GLOSSARY_LIMITS,
  GLOSSARY_PROMPT,
  KNOWN_TERMS_FILENAME,
  acronymMatches,
  buildGlossaryRequest,
  cleanWhat,
  composeTerms,
  createGlossary,
  ensureKnownTermsFile,
  parseGlossaryReply,
  parseKnownTerms,
  readKnownTerms,
  termInText,
  validateEntries,
} from "../src/server/engines/glossary.js";

const KEY = "sk-glossary-test-key-123456";

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "terms-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------ term check -- */

test("a term must appear in the card on a word boundary", () => {
  const card = "• VERDICT: sensors publish over MQTT to Kafka; a C++ agent and gRPC feed the TSDB.";
  assert.equal(termInText("MQTT", card), true);
  assert.equal(termInText("Kafka", card), true);
  assert.equal(termInText("kafka", card), true, "a mixed-case term matches in any case");
  assert.equal(termInText("C++", card), true);
  assert.equal(termInText("gRPC", card), true);
  assert.equal(termInText("TSDB", card), true);
  assert.equal(termInText("MQ", card), false, "inside a longer word is not a match");
  assert.equal(termInText("RPC", card), false, "gRPC does not contain RPC on a boundary");
  assert.equal(termInText("Redis", card), false, "a term the card never names");
  assert.equal(termInText("", card), false);
});

test("an all-caps acronym is matched case-sensitively", () => {
  assert.equal(termInText("MQTT", "we used mqtt here"), false);
  assert.equal(termInText("WAL", "a wal file"), false);
  assert.equal(termInText("WAL", "the WAL file"), true);
  assert.equal(termInText("Wal", "a wal file"), true, "not all caps: any case");
});

/* --------------------------------------------------------- acronym check -- */

test("a full name must spell the acronym: each content word gives its initial, then letters from inside it", () => {
  const good = [
    ["MQTT", "Message Queuing Telemetry Transport"],
    ["HTTP", "Hypertext Transfer Protocol"],
    ["HTTP", "HyperText Transfer Protocol"],
    ["TSDB", "Time-Series Database"],
    ["CRDT", "Conflict-free Replicated Data Type"],
    ["JSON", "JavaScript Object Notation"],
    ["JWT", "JSON Web Token"],
    ["gRPC", "gRPC Remote Procedure Calls"],
    ["OAuth", "Open Authorization"],
    ["SQL", "Structured Query Language"],
    ["WAL", "Write-Ahead Log"],
    ["ETL", "Extract, Transform, Load"],
    ["CI/CD", "Continuous Integration / Continuous Delivery"],
    ["TCP/IP", "Transmission Control Protocol/Internet Protocol"],
    ["IoT", "Internet of Things"],
    ["SaaS", "Software as a Service"],
    ["TTL", "Time to Live"],
    ["TCO", "Total Cost of Ownership"],
    ["APIs", "Application Programming Interfaces"],
    ["SLAs", "Service Level Agreements"],
    ["S3", "Simple Storage Service"],
    ["EC2", "Elastic Compute Cloud"],
    ["W3C", "World Wide Web Consortium"],
    ["P2P", "Peer-to-Peer"],
    ["mTLS", "mutual Transport Layer Security"],
  ];
  for (const [term, fullName] of good) assert.equal(acronymMatches(term, fullName), true, `${term} = ${fullName}`);
});

test("a full name that does not spell the acronym is refused", () => {
  const bad = [
    ["MQTT", "Message Queuing Telemetry Transport Protocol"], // an extra content word gives no letter
    ["MQTT", "Message Queue Transfer"],
    ["SQL", "Simple Query Language Protocol"],
    ["TCO", "Total Cost Ownership Model"],
    ["S3", "Amazon Simple Storage Service"],
    ["TSDB", "Time Database"],
    ["Kafka", "Kafka"],
    ["JSON", "JSON"], // only repeats the term
    ["JSON", "J-S-O-N"],
    ["backpressure", "Back Pressure"],
    ["CDC", ""],
  ];
  for (const [term, fullName] of bad) assert.equal(acronymMatches(term, fullName), false, `${term} = ${fullName}`);
  assert.equal(acronymMatches("MQTT", null), false);
});

test("the acronym check stays fast on adversarial input", () => {
  const time = (term, fullName) => {
    const started = performance.now();
    const result = acronymMatches(term, fullName);
    return { result, ms: performance.now() - started };
  };
  const capitals = Array.from({ length: 12 }, () => "AaAaAaAaA").join(" ");
  for (const term of ["AAAAAAAAAZ", "AAAAAAAAAA", "AaAaAaAaAZ"]) {
    const { ms } = time(term, capitals);
    assert.ok(ms < 50, `${term}: ${ms.toFixed(1)} ms`);
  }
  // The inner-letter search: long words of one repeated letter, an acronym of that letter that cannot fit.
  const twelve = Array.from({ length: 12 }, () => "a".repeat(9)).join(" "); // 119 characters
  const three = Array.from({ length: 3 }, () => "a".repeat(39)).join(" "); // 119 characters
  for (const [term, fullName] of [["AAAAAAAAAA", twelve], ["AAAAAAAAAY", three], ["AAAAAAAAAY", twelve]]) {
    const { result, ms } = time(term, fullName);
    assert.equal(result, false, `${term} against ${fullName.length} characters`);
    assert.ok(ms < 50, `${term}: ${ms.toFixed(1)} ms`);
  }
});

test("the acronym check's bounds remove the full name, as a mismatch does", () => {
  const words = (initials) => [...initials].map((letter) => `${letter}x`).join(" ");
  assert.equal(acronymMatches("ABCDEFGHIJ", words("ABCDEFGHIJ")), true, "10 letters");
  assert.equal(acronymMatches("ABCDEFGHIJK", words("ABCDEFGHIJK")), false, "11 letters");
  assert.equal(acronymMatches("ABC8", "Alpha Beta Cat Cat Cat Cat Cat Cat Cat Cat"), true, "10 letters after the digit");
  assert.equal(acronymMatches("ABC9", "Alpha Beta Cat Cat Cat Cat Cat Cat Cat Cat Cat"), false, "11 letters after the digit");
  assert.equal(acronymMatches("ABCDEFGHIJ", `${words("ABCDEFGHIJ")} of of`), true, "12 words");
  assert.equal(acronymMatches("ABCDEFGHIJ", `${words("ABCDEFGHIJ")} of of of`), false, "13 words");
  assert.equal(acronymMatches("AB", `Alpha ${"b".repeat(114)}`), true, "120 characters");
  assert.equal(acronymMatches("AB", `Alpha ${"b".repeat(115)}`), false, "121 characters");
  const card = "• VERDICT: the AB layer.";
  assert.deepEqual(validateEntries([{ term: "AB", full_name: `Alpha Beta ${"of ".repeat(11).trim()}`, what: "A layer." }], { text: card }), [
    { term: "AB", full_name: null, what: "A layer." },
  ]);
});

/* ------------------------------------------------------------ what check -- */

test("what: plain text of at most 25 words; whole sentences trimmed; over 35 words dropped", () => {
  assert.equal(cleanWhat("  Lightweight   publish/subscribe\nprotocol for sensors. "), "Lightweight publish/subscribe protocol for sensors.");
  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  assert.equal(cleanWhat(`${words(25)}.`), `${words(25)}.`);
  const first = `First sentence has ${words(16)}.`; // 19 words
  const second = `Second one adds ${words(10)}.`; // 13 words
  assert.equal(cleanWhat(`${first} ${second}`), first, "26-35 words: cut after a whole sentence");
  const long = `One sentence of ${words(27)}.`; // 30 words
  assert.equal(cleanWhat(long), long, "a single sentence is never cut mid-sentence");
  assert.equal(cleanWhat(`${words(36)}.`), null, "over 35 words: dropped");
  for (const markup of ["Uses **topics** to route.", "Runs `SELECT` queries.", "A <b>broker</b>.", "See [docs](http://x).", "- a list item", "Fast &amp; small."]) {
    assert.equal(cleanWhat(markup), null, markup);
  }
  assert.equal(cleanWhat(""), null);
  assert.equal(cleanWhat(42), null);
});

/* ------------------------------------------------------- entry validation -- */

const CARD = [
  "• VERDICT: stream sensor readings over MQTT into Kafka, then a TSDB.",
  "• HOW: a stream processor applies backpressure when the rule engine lags.",
  "• TRADE-OFF: Kafka adds operations work.",
].join("\n");

test("validation keeps entries that appear in the card, at most 3, first come first kept", () => {
  const raw = [
    { term: "MQTT", full_name: "Message Queuing Telemetry Transport", what: "Lightweight publish/subscribe messaging protocol." },
    { term: "Redis", full_name: null, what: "In-memory key-value store." },
    { term: "TSDB", full_name: "Time-Series DataBase", what: "Stores readings by timestamp." },
    { term: "mqtt", full_name: null, what: "Duplicate in another case." },
    { term: "backpressure", full_name: null, what: "A slow consumer makes the producer slow down." },
    { term: "Kafka", full_name: null, what: "Distributed commit log." },
  ];
  assert.deepEqual(validateEntries(raw, { text: CARD }), [
    { term: "MQTT", full_name: "Message Queuing Telemetry Transport", what: "Lightweight publish/subscribe messaging protocol." },
    { term: "TSDB", full_name: "Time-Series DataBase", what: "Stores readings by timestamp." },
    { term: "backpressure", full_name: null, what: "A slow consumer makes the producer slow down." },
  ]);
});

test("validation drops known and already explained terms, case-insensitively", () => {
  const raw = [
    { term: "MQTT", full_name: null, what: "Messaging protocol." },
    { term: "Kafka", full_name: null, what: "Distributed log." },
    { term: "backpressure", full_name: null, what: "Flow control." },
  ];
  assert.deepEqual(
    validateEntries(raw, { text: CARD, known: ["kafka"], explained: ["mqtt"] }).map((entry) => entry.term),
    ["backpressure"],
  );
});

test("a wrong full name is removed but the entry stays; a bad what or term drops the entry", () => {
  const raw = [
    { term: "MQTT", full_name: "Message Queue Transfer", what: "Messaging protocol." },
    { term: "TSDB", full_name: "Time-Series DataBase", what: "**Stores** readings." },
    { term: "Kafka <b>", full_name: null, what: "Distributed log." },
    { term: "Kafka", fullName: "Kafka", what: "Distributed commit log." },
    { term: null, what: "No term." },
    "not an object",
  ];
  assert.deepEqual(validateEntries(raw, { text: CARD }), [
    { term: "MQTT", full_name: null, what: "Messaging protocol." },
    { term: "Kafka", full_name: null, what: "Distributed commit log." },
  ]);
  assert.deepEqual(validateEntries(null, { text: CARD }), []);
});

test("compose: new entries first, then cached terms in the card by first appearance, up to 3", () => {
  const cache = [
    { term: "Kafka", full_name: null, what: "Distributed log." },
    { term: "Redis", full_name: null, what: "In-memory store." },
    { term: "MQTT", full_name: "Message Queuing Telemetry Transport", what: "Messaging protocol." },
  ];
  const fresh = [
    { term: "backpressure", full_name: null, what: "Flow control." },
    { term: "TSDB", full_name: null, what: "Stores readings by timestamp." },
  ];
  assert.deepEqual(composeTerms({ fresh, cache, text: CARD }), [
    { term: "TSDB", what: "Stores readings by timestamp." },
    { term: "backpressure", what: "Flow control." },
    { term: "MQTT", full_name: "Message Queuing Telemetry Transport", what: "Messaging protocol." },
  ]);
  assert.deepEqual(composeTerms({ fresh: [], cache, text: CARD }).map((entry) => entry.term), ["MQTT", "Kafka"]);
  assert.equal(GLOSSARY_LIMITS.terms, 3);
});

/* ------------------------------------------------------------ known terms -- */

test("known terms: one per line, # comments and blank lines skipped, BOM tolerated", () => {
  assert.deepEqual(parseKnownTerms("\uFEFF# my terms\nKafka\n\n  REST  \n# another\nC#\nkafka\n"), ["Kafka", "REST", "C#"]);
  assert.deepEqual(parseKnownTerms(""), []);
  assert.deepEqual(parseKnownTerms(null), []);
});

test("the known-terms file is created empty when missing, never overwritten, and read again each time", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "nested", KNOWN_TERMS_FILENAME);
    assert.equal(KNOWN_TERMS_FILENAME, "known-terms.txt");
    assert.deepEqual(await readKnownTerms(file), [], "a missing file reads as no terms");
    assert.deepEqual(await ensureKnownTermsFile(file), { created: true, error: null });
    assert.equal(await readFile(file, "utf8"), "");
    await writeFile(file, "Kafka\n");
    assert.deepEqual(await ensureKnownTermsFile(file), { created: false, error: null });
    assert.deepEqual(await readKnownTerms(file), ["Kafka"]);
    await writeFile(file, "Kafka\nRedis\n");
    assert.deepEqual(await readKnownTerms(file), ["Kafka", "Redis"]);
  }));

/* -------------------------------------------------------------- transport -- */

test("the request: DeepSeek V4.1 Flash, thinking off, JSON reply, card and skip list", () => {
  const body = buildGlossaryRequest({ baseUrl: "https://api.deepseek.com", model: "deepseek-flash", text: CARD, skip: ["Kafka"] });
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, GLOSSARY_PROMPT);
  assert.match(GLOSSARY_PROMPT, /JSON/);
  assert.equal(body.messages[1].role, "user");
  assert.ok(body.messages[1].content.includes(CARD));
  assert.match(body.messages[1].content, /SKIP[^\n]*:\n- Kafka/);
  assert.match(buildGlossaryRequest({ baseUrl: "https://api.deepseek.com", model: "m", text: CARD, skip: [] }).messages[1].content, /SKIP[^\n]*:\n\(none\)/);
});

test("the reply: a terms array from JSON content, fenced or not; anything else is null", () => {
  const reply = (content) => ({ choices: [{ message: { content } }] });
  const entry = { term: "MQTT", full_name: null, what: "Protocol." };
  assert.deepEqual(parseGlossaryReply(reply(JSON.stringify({ terms: [entry] }))), [entry]);
  assert.deepEqual(parseGlossaryReply(reply("```json\n" + JSON.stringify({ terms: [entry] }) + "\n```")), [entry]);
  assert.deepEqual(parseGlossaryReply(reply(JSON.stringify({ terms: [] }))), []);
  assert.equal(parseGlossaryReply(reply("{\"terms\": [")), null);
  assert.equal(parseGlossaryReply(reply("no json here")), null);
  assert.equal(parseGlossaryReply(reply(JSON.stringify({ entries: "x" }))), null);
  assert.equal(parseGlossaryReply({}), null);
});

function okResponse(content) {
  const body = JSON.stringify({ choices: [{ message: { content } }] });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

function replyWith(terms) {
  return okResponse(JSON.stringify({ terms }));
}

test("explain: one POST to DeepSeek with the key; validated terms come back and are cached", async () => {
  const calls = [];
  const glossary = createGlossary({
    apiKey: KEY,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return calls.length === 1
        ? replyWith([
            { term: "MQTT", full_name: "Message Queuing Telemetry Transport", what: "Lightweight publish/subscribe protocol." },
            { term: "Kafka", full_name: null, what: "Distributed commit log." },
          ])
        : replyWith([
            { term: "MQTT", full_name: "Something Else Entirely Wrong", what: "A different reading." },
            { term: "ClickHouse", full_name: null, what: "Column-oriented analytics database." },
          ]);
    },
  });
  assert.equal(glossary.enabled, true);
  const first = await glossary.explain({ text: CARD });
  assert.equal(first.error, null);
  assert.equal(first.added, 2);
  assert.deepEqual(first.terms, [
    { term: "MQTT", full_name: "Message Queuing Telemetry Transport", what: "Lightweight publish/subscribe protocol." },
    { term: "Kafka", what: "Distributed commit log." },
  ]);
  assert.equal(typeof first.latencyMs, "number");
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error", "the hardened transport never follows a redirect");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].body.model, "deepseek-flash");
  assert.deepEqual(calls[0].body.thinking, { type: "disabled" });

  const second = await glossary.explain({ text: "• VERDICT: keep MQTT at the edge and ClickHouse for analytics." });
  assert.match(calls[1].body.messages[1].content, /SKIP[^\n]*:\n- MQTT\n/, "an explained term in the card is sent as skip");
  assert.doesNotMatch(calls[1].body.messages[1].content, /- Kafka/, "an explained term not in the card is not sent");
  assert.equal(second.added, 1, "the explained term is never explained again");
  assert.deepEqual(second.terms, [
    { term: "ClickHouse", what: "Column-oriented analytics database." },
    { term: "MQTT", full_name: "Message Queuing Telemetry Transport", what: "Lightweight publish/subscribe protocol." },
  ]);
});

test("explain: known terms are read from the file on every request, sent as skip, and dropped", async () => {
  let reads = 0;
  let known = "Kafka\n";
  const bodies = [];
  const glossary = createGlossary({
    apiKey: KEY,
    knownTermsPath: "C:\\fake\\known-terms.txt",
    readFileImpl: async () => {
      reads += 1;
      return known;
    },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return replyWith([
        { term: "Kafka", full_name: null, what: "Distributed log." },
        { term: "TSDB", full_name: null, what: "Stores readings by timestamp." },
      ]);
    },
  });
  const first = await glossary.explain({ text: CARD });
  assert.deepEqual(first.terms.map((entry) => entry.term), ["TSDB"]);
  assert.match(bodies[0].messages[1].content, /- Kafka/);
  known = "Kafka\nTSDB\n";
  await glossary.explain({ text: "• VERDICT: Kafka feeds the TSDB." });
  assert.equal(reads, 2, "read again for the second request");
  assert.match(bodies[1].messages[1].content, /- Kafka\n- TSDB/);
});

test("explain never rejects: HTTP error, bad JSON, network error, timeout and abort give no terms and one code", async () => {
  const run = async (fetchImpl, options = {}) => createGlossary({ apiKey: KEY, fetchImpl, ...options }).explain({ text: CARD, signal: options.signal });

  assert.deepEqual(await run(async () => new Response("{}", { status: 500 })).then(({ terms, error }) => ({ terms, error })), { terms: [], error: "http_500" });
  assert.equal((await run(async () => okResponse("not json"))).error, "bad_json");
  assert.equal((await run(async () => new Response("<html>", { status: 200 }))).error, "bad_json");

  const network = await run(async () => {
    throw new Error(`connect failed for Bearer ${KEY}`);
  });
  assert.equal(network.error, "request_failed");
  assert.ok(!JSON.stringify(network).includes(KEY), "the key never reaches the result");

  const hang = (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const started = Date.now();
  const timedOut = await run(hang, { timeoutMs: 30 });
  assert.equal(timedOut.error, "timeout");
  assert.deepEqual(timedOut.terms, []);
  assert.ok(Date.now() - started < 1000, "the timeout ends the request");

  const controller = new AbortController();
  const pending = run(hang, { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).error, "aborted");

  const failingRead = await run(async () => replyWith([{ term: "Kafka", full_name: null, what: "Log." }]), {
    knownTermsPath: "C:\\fake\\known-terms.txt",
    readFileImpl: async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    },
  });
  assert.deepEqual(failingRead.terms.map((entry) => entry.term), ["Kafka"], "an unreadable known-terms file reads as no terms");
  assert.equal(DEFAULT_GLOSSARY_TIMEOUT_MS, 5000);
});

test("without a key, or on an insecure URL, the glossary is off and never calls out", async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    return replyWith([]);
  };
  for (const options of [{}, { apiKey: "" }, { apiKey: KEY, baseUrl: "http://api.example.com" }]) {
    const glossary = createGlossary({ ...options, fetchImpl });
    assert.equal(glossary.enabled, false);
    const result = await glossary.explain({ text: CARD });
    assert.deepEqual(result.terms, []);
    assert.equal(result.error, "disabled");
  }
  assert.equal(called, 0);
});

test("close aborts an in-flight request and later requests do nothing", async () => {
  const glossary = createGlossary({
    apiKey: KEY,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  });
  const pending = glossary.explain({ text: CARD });
  glossary.close();
  assert.equal((await pending).error, "closed");
  assert.equal((await glossary.explain({ text: CARD })).error, "closed");
});
