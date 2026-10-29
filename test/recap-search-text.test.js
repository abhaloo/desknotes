import test from "node:test";
import assert from "node:assert/strict";

/**
 * Session search, phase 1a: what of a recap is searchable
 * (src/desktop/recap/search-text.js, pure, no node: imports).
 *
 *   searchChunks(recap, { chunkWords?, maxChunks? })
 *     -> [{ kind: "transcript"|"qa"|"terms"|"screen", text, ref }]
 *   chunkText(recap, ref)     -> the same text again, from the recap alone (refs are what the
 *                                index keeps; the text is never written beside the recap)
 *   snippetFor(recap, ref)    -> the head of that text, whole words, <= SNIPPET_CHARS
 *   lexicalWords(texts)       -> unique lowercase words for the keyword boost (no stopwords, capped)
 *   normalizeQuery(q)         -> trimmed, collapsed, bounded; "" when nothing is left
 *   queryWords(q)             -> the words of a query, the same way lexicalWords cuts them
 *
 * Model chatter (gate verdicts, first-token markers, retries, superseded
 * markers, error codes) is never indexed: it carries no topic.
 */
const load = () => import("../src/desktop/recap/search-text.js");

const T0 = Date.parse("2026-10-28T14:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const line = (type, offsetMs, fields) => ({ type, at: iso(T0 + offsetMs), offsetMs, ...fields });
const words = (n, word = "word") => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ");

function recap(extra = {}) {
  return {
    version: 1,
    id: "session-1",
    startedAt: iso(T0),
    endedAt: iso(T0 + 60_000),
    durationMs: 60_000,
    endReason: "user",
    lines: [
      line("transcript", 1_000, { role: "prospect", source: "system", text: "How does your SSO integration work with Okta?" }),
      line("gate.verdict", 1_050, { turnId: "t1", gateSeq: 1, verdict: "answer" }),
      line("turn.started", 1_100, { turnId: "t1", question: "How does your SSO integration work with Okta?", intent: "final" }),
      line("turn.token", 1_200, { turnId: "t1" }),
      line("turn.done", 2_500, { turnId: "t1", text: "VERDICT: <b>SAML</b> or OIDC, both supported.", cut: null, fallback: null }),
      line("terms", 2_900, { turnId: "t1", terms: [{ term: "OIDC", full_name: "OpenID Connect", what: "A sign-on layer." }] }),
      line("transcript", 5_000, { role: "rep", source: "mic", text: "We support both, and SCIM provisioning too." }),
      line("error.retry", 5_100, { turnId: "t2", attempt: 1 }),
      line("error", 5_200, { turnId: "t2", code: "E_UPSTREAM", message: "provider timeout" }),
      line("turn.superseded", 5_300, { turnId: "t2" }),
      line("screen.result", 8_000, { status: "done", title: "Pricing page", summary: "Three tiers, enterprise is custom." }),
      line("transcript", 9_000, { role: "prospect", source: "system", text: "And what about pricing for 200 seats?" }),
    ],
    turns: [],
    questions: [
      { turnId: "t1", at: iso(T0 + 1_100), offsetMs: 1_100, question: "How does your SSO integration work with Okta?", intent: "final", status: "done", answer: "VERDICT: <b>SAML</b> or OIDC, both supported.", cut: null, terms: ["OIDC"] },
      { turnId: "t2", at: iso(T0 + 5_100), offsetMs: 5_100, question: "Do you have SCIM?", intent: "final", status: "failed", answer: "", cut: null, terms: [] },
    ],
    gaps: [],
    terms: [{ turnId: "t1", at: iso(T0 + 2_900), offsetMs: 2_900, term: "OIDC", full_name: "OpenID Connect", what: "A sign-on layer.", question: "How does your SSO integration work with Okta?" }],
    stats: {},
    savedAt: iso(T0 + 61_000),
    text: "Session recap — …",
    ...extra,
  };
}

test("searchChunks: transcript lines become one chunk with speaker labels, in order", async () => {
  const { searchChunks } = await load();
  const chunks = searchChunks(recap());
  const transcript = chunks.filter((chunk) => chunk.kind === "transcript");
  assert.equal(transcript.length, 1, "three short lines fit one chunk");
  assert.equal(transcript[0].text, "Prospect: How does your SSO integration work with Okta?\nYou: We support both, and SCIM provisioning too.\nProspect: And what about pricing for 200 seats?");
  assert.deepEqual(transcript[0].ref, { lineStart: 0, lineEnd: 11 });
});

test("searchChunks: one chunk per detected question with its answer, tags stripped", async () => {
  const { searchChunks } = await load();
  const qa = searchChunks(recap()).filter((chunk) => chunk.kind === "qa");
  assert.equal(qa.length, 2);
  assert.equal(qa[0].text, "How does your SSO integration work with Okta?\nVERDICT: SAML or OIDC, both supported.");
  assert.deepEqual(qa[0].ref, { turnId: "t1" });
  assert.equal(qa[1].text, "Do you have SCIM?", "a failed answer leaves the question alone");
  assert.deepEqual(qa[1].ref, { turnId: "t2" });
});

test("searchChunks: the terms explained are one chunk; a screen analysis is one chunk", async () => {
  const { searchChunks } = await load();
  const chunks = searchChunks(recap());
  const terms = chunks.filter((chunk) => chunk.kind === "terms");
  assert.equal(terms.length, 1);
  assert.equal(terms[0].text, "OIDC (OpenID Connect): A sign-on layer.");
  assert.deepEqual(terms[0].ref, { termStart: 0, termEnd: 1 });
  const screen = chunks.filter((chunk) => chunk.kind === "screen");
  assert.equal(screen.length, 1);
  assert.equal(screen[0].text, "Pricing page: Three tiers, enterprise is custom.");
  assert.deepEqual(screen[0].ref, { lineStart: 10, lineEnd: 10 });
});

test("searchChunks: model chatter is never indexed", async () => {
  const { searchChunks } = await load();
  const all = searchChunks(recap()).map((chunk) => chunk.text).join("\n");
  for (const noise of ["Gate", "First token", "Retrying", "superseded", "E_UPSTREAM", "provider timeout", "attempt 1"]) {
    assert.ok(!all.includes(noise), `"${noise}" must not be searchable`);
  }
});

test("searchChunks: an empty recap, a recap with no lines, and a damaged recap give no chunks", async () => {
  const { searchChunks } = await load();
  assert.deepEqual(searchChunks({}), []);
  assert.deepEqual(searchChunks(recap({ lines: [], questions: [], terms: [] })), []);
  assert.deepEqual(searchChunks(null), []);
  assert.deepEqual(searchChunks(recap({ lines: "nope", questions: null, terms: 3 })), []);
  assert.deepEqual(searchChunks(recap({ lines: [{ type: "transcript", role: "prospect", text: "   " }], questions: [], terms: [] })), [], "blank text is not a chunk");
});

test("searchChunks: transcript windows close at chunkWords and overlap by their last line", async () => {
  const { searchChunks } = await load();
  const lines = [
    line("transcript", 0, { role: "prospect", text: words(100, "a") }),
    line("transcript", 1, { role: "rep", text: words(100, "b") }),
    line("transcript", 2, { role: "prospect", text: words(100, "c") }),
    line("transcript", 3, { role: "rep", text: words(10, "d") }),
  ];
  const chunks = searchChunks(recap({ lines, questions: [], terms: [] }), { chunkWords: 180 });
  assert.deepEqual(
    chunks.map((chunk) => chunk.ref),
    [
      { lineStart: 0, lineEnd: 1 }, // a + b = 200 words >= 180: closes
      { lineStart: 1, lineEnd: 2 }, // overlap: b again, then c
      { lineStart: 2, lineEnd: 3 }, // overlap: c, then the tail
    ],
  );
  assert.ok(chunks[1].text.startsWith("You: b0 b1"));
});

test("searchChunks: a single line longer than the window is cut into word ranges of that line", async () => {
  const { searchChunks, chunkText } = await load();
  const long = recap({ lines: [line("transcript", 0, { role: "prospect", text: words(450, "w") })], questions: [], terms: [] });
  const chunks = searchChunks(long, { chunkWords: 200 });
  assert.deepEqual(
    chunks.map((chunk) => chunk.ref),
    [
      { lineStart: 0, lineEnd: 0, wordStart: 0, wordEnd: 200 },
      { lineStart: 0, lineEnd: 0, wordStart: 200, wordEnd: 400 },
      { lineStart: 0, lineEnd: 0, wordStart: 400, wordEnd: 450 },
    ],
  );
  assert.equal(chunks[1].text, `Prospect: ${words(450, "w").split(" ").slice(200, 400).join(" ")}`);
  for (const chunk of chunks) assert.equal(chunkText(long, chunk.ref), chunk.text);
});

test("searchChunks: maxChunks caps a huge recap", async () => {
  const { searchChunks, SEARCH_MAX_CHUNKS } = await load();
  assert.ok(SEARCH_MAX_CHUNKS >= 500);
  const lines = Array.from({ length: 400 }, (_, i) => line("transcript", i, { role: "prospect", text: words(50, `l${i}x`) }));
  const chunks = searchChunks(recap({ lines, questions: [], terms: [] }), { chunkWords: 100, maxChunks: 25 });
  assert.equal(chunks.length, 25);
});

test("chunkText rebuilds every chunk's text from the recap and its ref alone", async () => {
  const { searchChunks, chunkText } = await load();
  const r = recap();
  for (const chunk of searchChunks(r)) assert.equal(chunkText(r, chunk.ref), chunk.text, `${chunk.kind} ${JSON.stringify(chunk.ref)}`);
});

test("chunkText: a ref that no longer matches the recap gives an empty string, never a throw", async () => {
  const { chunkText } = await load();
  const r = recap();
  assert.equal(chunkText(r, { lineStart: 40, lineEnd: 50 }), "");
  assert.equal(chunkText(r, { turnId: "t-gone" }), "");
  assert.equal(chunkText(r, { termStart: 5, termEnd: 9 }), "");
  assert.equal(chunkText(r, {}), "");
  assert.equal(chunkText(r, null), "");
  assert.equal(chunkText(null, { lineStart: 0, lineEnd: 0 }), "");
  assert.equal(chunkText(r, { lineStart: 1, lineEnd: 1 }), "", "a non-transcript line is not a transcript chunk");
});

test("snippetFor: the head of the chunk, whole words, bounded, with an ellipsis when cut", async () => {
  const { snippetFor, SNIPPET_CHARS } = await load();
  assert.ok(SNIPPET_CHARS >= 120 && SNIPPET_CHARS <= 240);
  const r = recap();
  assert.equal(snippetFor(r, { turnId: "t1" }), "How does your SSO integration work with Okta? VERDICT: SAML or OIDC, both supported.");
  const long = recap({ lines: [line("transcript", 0, { role: "prospect", text: words(100, "needle") })], questions: [], terms: [] });
  const snippet = snippetFor(long, { lineStart: 0, lineEnd: 0 });
  assert.ok(snippet.length <= SNIPPET_CHARS + 1, "the ellipsis is the only thing past the cap");
  assert.ok(snippet.endsWith("…"));
  assert.ok(!/needle\d*…$/.test(snippet) || /\sneedle\d+…$/.test(snippet), "never cut inside a word");
  assert.equal(snippetFor(r, { turnId: "nope" }), "");
});

test("lexicalWords: unique, lowercase, no stopwords, no short tokens, capped", async () => {
  const { lexicalWords, LEXICAL_MAX_WORDS } = await load();
  const got = lexicalWords(["Pricing for 200 seats, the pricing page.", "Okta SSO — and SCIM!", "The the a of"]);
  assert.deepEqual([...got].sort(), ["200", "okta", "page", "pricing", "scim", "seats", "sso"]);
  assert.ok(LEXICAL_MAX_WORDS >= 1000);
  const many = lexicalWords([words(LEXICAL_MAX_WORDS + 500, "tok")]);
  assert.equal(many.length, LEXICAL_MAX_WORDS);
  assert.deepEqual(lexicalWords([]), []);
  assert.deepEqual(lexicalWords(["", null, 42]), []);
});

test("normalizeQuery and queryWords", async () => {
  const { normalizeQuery, queryWords, QUERY_MAX_CHARS } = await load();
  assert.equal(normalizeQuery("  the   call about\tpricing \n"), "the call about pricing");
  assert.equal(normalizeQuery("   "), "");
  assert.equal(normalizeQuery(""), "");
  assert.equal(normalizeQuery(null), "");
  assert.equal(normalizeQuery(42), "");
  assert.ok(QUERY_MAX_CHARS >= 200 && QUERY_MAX_CHARS <= 1000);
  assert.equal(normalizeQuery("x".repeat(QUERY_MAX_CHARS + 50)).length, QUERY_MAX_CHARS);
  assert.deepEqual(queryWords("The call where they pushed back on PRICING, pricing!"), ["call", "where", "pushed", "back", "pricing"]);
  assert.deepEqual(queryWords(""), []);
  assert.deepEqual(queryWords("a of"), []);
});
