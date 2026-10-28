import test from "node:test";
import assert from "node:assert/strict";
import { buildContext, createPipelineEngine } from "../src/server/engines/pipeline.js";
import { GROUNDING_RULE } from "../src/server/engines/answerer.js";
import { CONVERSATION_HEADING } from "../src/server/engines/conversation-context.js";
import { CONTEXT_CHARS, CUSTOMER_CHARS, DOCUMENTS_CHARS, GROUNDING_CHARS, PROFILE_CHARS } from "../src/shared/context-budget.js";

/**
 * The customer profile in the answer pipeline. `session_context` now carries
 * `customer: {name, docs}` beside the grounding document; the pipeline keeps
 * it as its own CUSTOMER PROFILE section, after DOCUMENTS (closest to the
 * question, and the grounding document changes less often than the profile,
 * so the cacheable prefix stays longer across a profile switch). Like the
 * document, it is read once per generation: a switch reaches the next answer
 * and the answer in flight keeps what it started with.
 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(5);
  }
}

function fakeAsr() {
  return { pushAudio() {}, finalize: () => true, close() {}, onTranscript() {} };
}

function recordingAnswerer({ deltaMs = 5, count = 3 } = {}) {
  const calls = [];
  const primes = [];
  async function* streamAnswer(args) {
    calls.push({ args });
    for (let i = 0; i < count; i += 1) {
      await delay(deltaMs);
      if (args.signal?.aborted) return;
      yield `[${calls.length}:${i}] `;
    }
  }
  return { calls, primes, streamAnswer, answerOnce: async () => "", prime: (args) => primes.push(args) };
}

function engineWith(answerer, { logs = [], frames = [] } = {}) {
  const engine = createPipelineEngine({ emit: (frame) => frames.push(frame), asr: fakeAsr(), answerer, log: (entry) => logs.push(entry), now: Date.now });
  engine.onSessionStart({ sessionId: "s-customer" });
  return engine;
}

const ACME = { name: "Acme Corp", docs: "File: deals.csv\n\n## Acme Corp\n- Stage: Closed Won\n- Amount: 48,000" };
const GLOBEX = { name: "Globex", docs: "File: notes.md\n\nPrefers annual billing." };
const PRODUCT = { docs: "Pricing: forty dollars a seat.", name: "product.md" };

/* ------------------------------------------------------- buildContext -- */

test("the customer profile renders as its own section after DOCUMENTS, with the account name", () => {
  assert.equal(
    buildContext({ docs: "File: product.md\n\nPricing: forty dollars a seat.", customer: { name: "Acme Corp", text: ACME.docs } }),
    `DOCUMENTS:\nFile: product.md\n\nPricing: forty dollars a seat.\n\nCUSTOMER PROFILE (Acme Corp):\n${ACME.docs}`,
  );
  assert.equal(buildContext({ customer: { name: "Acme Corp", text: ACME.docs } }), `CUSTOMER PROFILE (Acme Corp):\n${ACME.docs}`, "a profile alone");
  assert.equal(buildContext({ customer: { name: "", text: "facts" } }), "CUSTOMER PROFILE:\nfacts", "no name, plain heading");
  assert.equal(buildContext({ customer: { name: "  Acme  ", text: "facts" } }), "CUSTOMER PROFILE (Acme):\nfacts", "the name is trimmed");
  assert.equal(buildContext({ customer: { name: "Acme", text: "" } }), "", "no text, no section");
  assert.equal(buildContext({ customer: { name: "Acme", text: "   " } }), "", "blank text, no section");
  assert.equal(buildContext({ customer: null, docs: "d" }), "DOCUMENTS:\nd");
  assert.equal(buildContext({ customer: "not an object", docs: "d" }), "DOCUMENTS:\nd");
});

test("the section sits between DOCUMENTS and the per-question tail", () => {
  const context = buildContext({
    docs: "product facts",
    customer: { name: "Acme Corp", text: "account facts" },
    history: [{ q: "q1", a: "a1" }],
    prospect: ["what about seats"],
  });
  assert.equal(context, "DOCUMENTS:\nproduct facts\n\nCUSTOMER PROFILE (Acme Corp):\naccount facts\n\nRECENT EXCHANGE:\nQ: q1\nA: a1\n\nPROSPECT SPEECH (latest last):\n- what about seats");
});

/** A Markdown body of exactly `chars` characters, a heading section about every 1,000. */
function sections(chars, label) {
  let text = "";
  for (let i = 1; text.length < chars; i += 1) text += `## ${label} ${i}\n${"x".repeat(980)}\n`;
  return text.slice(0, chars);
}

test("a grounding document and a profile both at their caps fit whole beside every other section at its cap", () => {
  assert.equal(GROUNDING_CHARS + PROFILE_CHARS, DOCUMENTS_CHARS);
  const docs = `File: product.md\n\n${sections(GROUNDING_CHARS, "Product")}`;
  const customer = ["File: a.md", "File: deals.csv", "File: objections.txt"]
    .map((label, i) => `${label}\n\n${sections(Math.floor(PROFILE_CHARS / 3) + (i === 0 ? PROFILE_CHARS % 3 : 0), label)}`)
    .join("\n\n");
  assert.ok(customer.length >= PROFILE_CHARS && customer.length < PROFILE_CHARS + 100);
  const conversation = Array.from({ length: 8 }, (_, i) => ({ who: i % 2 ? "rep" : "prospect", text: `line ${i} ${"w".repeat(290)}` }));
  const context = buildContext({
    docs,
    customer: { name: "Acme Corp", text: customer },
    question: "what did we agree on seats last time",
    history: [
      { q: "q".repeat(300), a: "a".repeat(600) },
      { q: "Q".repeat(300), a: "A".repeat(600) },
    ],
    screen: { text: "s".repeat(1_500), kind: "slides", title: "t".repeat(100), ageMs: 40_000 },
    prospect: ["p".repeat(400), "P".repeat(400), "r".repeat(400)],
    conversation,
  });
  assert.ok(context.length <= CONTEXT_CHARS, `context is ${context.length}`);
  assert.ok(context.includes(`DOCUMENTS:\n${docs}\n\n`), "the grounding document is whole");
  assert.ok(context.includes(`CUSTOMER PROFILE (Acme Corp):\n${customer}\n\n`), "the profile is whole");
  for (const heading of ["RECENT EXCHANGE:", "SCREEN (", "PROSPECT SPEECH", CONVERSATION_HEADING]) {
    assert.ok(context.includes(heading), heading);
  }
});

test("an oversized profile (a host that skipped the import and wire checks) is cut to its own cap by whole sections, and never starves DOCUMENTS", () => {
  const docs = `File: product.md\n\n${sections(GROUNDING_CHARS, "Product")}`;
  // Section 37 is far past the cap in document order; the question names it.
  const huge = sections(40_000, "Deal").replace("## Deal 37\n", "## Renewal terms\n");
  const context = buildContext({ docs, customer: { name: "Acme Corp", text: huge }, question: "what were the renewal terms" });
  assert.ok(context.length <= CONTEXT_CHARS);
  assert.ok(context.includes(`DOCUMENTS:\n${docs}\n\n`), "the grounding document is whole");
  const body = context.slice(context.indexOf("CUSTOMER PROFILE (Acme Corp):\n") + "CUSTOMER PROFILE (Acme Corp):\n".length);
  assert.ok(body.length <= CUSTOMER_CHARS, `profile body is ${body.length}`);
  assert.ok(body.includes("## Renewal terms\n"), "the section the question names is kept, wherever it is");
  assert.ok(body.includes("## Deal 1\n"), "then sections in document order while they fit");
  assert.ok(!body.includes("## Deal 40\n"), "sections past the cap are dropped whole");
  // Both oversized: the profile keeps its cap, the document gets the rest, and the total still fits.
  const both = buildContext({ docs: sections(40_000, "Product"), customer: { name: "Acme Corp", text: huge } });
  assert.ok(both.length <= CONTEXT_CHARS);
  const profileAt = both.indexOf("CUSTOMER PROFILE (Acme Corp):\n");
  assert.ok(profileAt > 0);
  assert.ok(both.length - profileAt - "CUSTOMER PROFILE (Acme Corp):\n".length <= CUSTOMER_CHARS);
  assert.ok(profileAt >= CONTEXT_CHARS - CUSTOMER_CHARS - 1_100, "DOCUMENTS took everything the profile did not (to within one section)");
});

/* -------------------------------------------------------- onContextSet -- */

test("onContextSet with a customer grounds the next answer with both sections; logs carry lengths only", async () => {
  const answerer = recordingAnswerer();
  const logs = [];
  const engine = engineWith(answerer, { logs });
  engine.onContextSet({ ...PRODUCT, customer: ACME });
  engine.onAnswerRequest({ utterance: "what did we close them at" });
  await waitFor(() => answerer.calls.length === 1);
  assert.equal(
    answerer.calls[0].args.context,
    `DOCUMENTS:\nFile: product.md\n\nPricing: forty dollars a seat.\n\nCUSTOMER PROFILE (Acme Corp):\n${ACME.docs}`,
  );
  const entry = logs.find((log) => log.type === "pipeline.context_set");
  assert.equal(entry.context_chars, answerer.calls[0].args.context.length);
  assert.equal(entry.customer_chars, ACME.docs.length);
  assert.ok(!JSON.stringify(logs).includes("Closed Won"), "logs never carry the profile text");
  assert.ok(!JSON.stringify(logs).includes("Acme"), "nor the account name");
  engine.dispose();
});

test("every frame carries the whole state: a frame without a customer drops the profile, docs '' clears both", async () => {
  const answerer = recordingAnswerer();
  const logs = [];
  const frames = [];
  const engine = engineWith(answerer, { logs, frames });
  /** Asks, waits for the turn to finish (a request during a turn is ignored), and returns that answer's context. */
  const contextOfNextAnswer = async (utterance) => {
    const before = answerer.calls.length;
    const doneBefore = frames.filter((frame) => frame.type === "turn.done").length;
    assert.equal(engine.onAnswerRequest({ utterance }), true, utterance);
    await waitFor(() => frames.filter((frame) => frame.type === "turn.done").length === doneBefore + 1);
    assert.equal(answerer.calls.length, before + 1);
    return answerer.calls[before].args.context;
  };

  engine.onContextSet({ ...PRODUCT, customer: ACME });
  assert.ok((await contextOfNextAnswer("first")).includes("CUSTOMER PROFILE (Acme Corp):"));

  engine.onContextSet({ ...PRODUCT, customer: GLOBEX });
  const switched = await contextOfNextAnswer("second");
  assert.ok(switched.includes(`CUSTOMER PROFILE (Globex):\n${GLOBEX.docs}`), "the new profile");
  assert.ok(!switched.includes("Acme"), "the old one is gone");

  engine.onContextSet(PRODUCT);
  const dropped = await contextOfNextAnswer("third");
  assert.ok(dropped.startsWith("DOCUMENTS:\nFile: product.md\n\nPricing: forty dollars a seat."));
  assert.ok(!dropped.includes("CUSTOMER PROFILE"), "no customer field, no profile");
  assert.equal(logs.filter((log) => log.type === "pipeline.context_set").at(-1).customer_chars, 0);

  engine.onContextSet({ docs: "", customer: ACME });
  const alone = await contextOfNextAnswer("fourth");
  assert.ok(alone.startsWith(`CUSTOMER PROFILE (Acme Corp):\n${ACME.docs}`), "a profile without a grounding document");
  assert.ok(!alone.includes("DOCUMENTS:"));

  engine.onContextSet({ docs: "" });
  const cleared = await contextOfNextAnswer("fifth");
  assert.ok(!cleared.includes("DOCUMENTS:") && !cleared.includes("CUSTOMER PROFILE"), "docs '' clears both");
  assert.ok(cleared.startsWith("RECENT EXCHANGE:"), "the session history stays");
  engine.dispose();
});

test("a customer with no text, or one that is not an object, is no customer", async () => {
  const answerer = recordingAnswerer();
  const engine = engineWith(answerer);
  for (const customer of [{ name: "Acme", docs: "" }, { name: "Acme" }, "Acme", 42, [], null]) {
    engine.onContextSet({ ...PRODUCT, customer });
  }
  engine.onAnswerRequest({ utterance: "q" });
  await waitFor(() => answerer.calls.length === 1);
  assert.equal(answerer.calls[0].args.context, "DOCUMENTS:\nFile: product.md\n\nPricing: forty dollars a seat.");
  engine.dispose();
});

test("a switch mid-answer: the answer in flight keeps the old profile, the next one gets the new", async () => {
  const answerer = recordingAnswerer({ deltaMs: 20, count: 4 });
  const frames = [];
  const engine = engineWith(answerer, { frames });
  engine.onContextSet({ ...PRODUCT, customer: ACME });
  engine.onAnswerRequest({ utterance: "what did we close them at" });
  await waitFor(() => answerer.calls.length === 1);
  engine.onContextSet({ ...PRODUCT, customer: GLOBEX });
  await waitFor(() => frames.some((frame) => frame.type === "turn.done"));
  assert.ok(answerer.calls[0].args.context.includes("CUSTOMER PROFILE (Acme Corp):"));
  assert.ok(!answerer.calls[0].args.context.includes("Globex"));
  const done = frames.find((frame) => frame.type === "turn.done");
  assert.equal(done.data.text, "[1:0] [1:1] [1:2] [1:3] ", "the first answer finished on the old profile");

  engine.onAnswerRequest({ utterance: "how do they like to be billed" });
  await waitFor(() => answerer.calls.length === 2);
  assert.ok(answerer.calls[1].args.context.includes("CUSTOMER PROFILE (Globex):"));
  assert.ok(!answerer.calls[1].args.context.includes("Acme"));
  engine.dispose();
});

test("a profile primes the answerer like a document does, with the next answer's context", async () => {
  const answerer = recordingAnswerer();
  const engine = engineWith(answerer);
  engine.onContextSet({ docs: "", customer: ACME });
  await waitFor(() => answerer.primes.length === 1, 1500);
  assert.equal(answerer.primes[0].context, `CUSTOMER PROFILE (Acme Corp):\n${ACME.docs}`);
  engine.onContextSet({ docs: "", customer: GLOBEX });
  await waitFor(() => answerer.primes.length === 2, 1500);
  assert.equal(answerer.primes[1].context, `CUSTOMER PROFILE (Globex):\n${GLOBEX.docs}`);
  engine.dispose();
});

/* -------------------------------------------------------------- prompt -- */

test("the grounding rule names CUSTOMER PROFILE as what the rep knows about this account", () => {
  assert.match(GROUNDING_RULE, /DOCUMENTS, RESUME and PLAYBOOK are the rep's own material/, "the existing sentence stays");
  assert.match(GROUNDING_RULE, /CUSTOMER PROFILE is what the rep knows about the account on this call: past deals, contracts, objections and contacts/);
  assert.match(GROUNDING_RULE, /For a question about this account, answer from the CUSTOMER PROFILE first and keep its names, dates and amounts exactly as written/);
  assert.match(GROUNDING_RULE, /Never invent product facts/);
  // Order: the material sentence and its "When they cover the question" rule stay together (so "they" is
  // DOCUMENTS, RESUME and PLAYBOOK), then the profile, then what was said on the call.
  const coverIndex = GROUNDING_RULE.indexOf("When they cover the question, answer from them");
  const profileIndex = GROUNDING_RULE.indexOf("CUSTOMER PROFILE is what the rep knows");
  const saidIndex = GROUNDING_RULE.indexOf("SCREEN, PROSPECT SPEECH, RECENT CONVERSATION and RECENT EXCHANGE show what was on screen, said or suggested");
  assert.ok(coverIndex > 0 && profileIndex > coverIndex && saidIndex > profileIndex, "material rule, then profile, then what was said");
});
