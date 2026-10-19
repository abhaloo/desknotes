import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";
import { createEngineFactory } from "../src/server/engines/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 3000, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

function fakeAsr() {
  const handlers = [];
  return {
    pushAudio() {},
    finalize() {
      return true;
    },
    close() {},
    onTranscript(cb) {
      handlers.push(cb);
    },
    send(streamIdx, text, final = false) {
      const data = {
        text,
        final,
        stream: streamIdx,
        role: streamIdx === 1 ? "prospect" : "rep",
        source: streamIdx === 1 ? "system" : "mic",
      };
      for (const cb of handlers) cb(data);
    },
  };
}

/** Echoes the question it was asked, like the mock answerer: a prefix answer is detectable. */
function echoAnswerer({ deltaMs = 4, count = 4 } = {}) {
  const calls = [];
  async function* streamAnswer(args) {
    const call = { question: args.question, cancelled: false };
    calls.push(call);
    for (let i = 0; i < count; i += 1) {
      await sleep(deltaMs);
      if (args.signal?.aborted) {
        call.cancelled = true;
        return;
      }
      yield i === 0 ? `ANSWER TO: ${args.question}` : ` .`;
    }
    call.finished = true;
  }
  return { calls, streamAnswer };
}

function fakeClock(start = 0) {
  let value = start;
  return { now: () => value, advance: (ms) => (value += ms) };
}

function setup(extra = {}) {
  const frames = [];
  const asr = fakeAsr();
  const answerer = echoAnswerer(extra.answererOptions);
  const clock = fakeClock();
  const engine = createPipelineEngine({
    emit: (frame) => frames.push(frame),
    asr,
    answerer,
    log: () => {},
    now: clock.now,
    ...extra.engineOptions,
  });
  engine.onSessionStart({ sessionId: "s" });
  return { frames, asr, answerer, clock, engine };
}

const dones = (frames) => frames.filter((f) => f.type === "turn.done");
const started = (frames) => frames.filter((f) => f.type === "turn.started");

const FULL = "how much does the enterprise tier with SSO cost per seat";

test("a prefetch for a short prefix is never committed as the answer to the full question", async () => {
  const { frames, asr, answerer, clock, engine } = setup();
  asr.send(1, "how much");
  clock.advance(300);
  asr.send(1, "how much"); // stability trigger on a 2-word prefix
  assert.equal(answerer.calls[0].question, "how much");

  clock.advance(300);
  asr.send(1, FULL);
  asr.send(1, FULL, true);
  const done = await waitFor(() => dones(frames).at(-1), { label: "turn.done" });
  await sleep(40);
  const committed = dones(frames);
  assert.equal(committed.length, 1, "exactly one answer is committed");
  assert.match(committed[0].data.text, new RegExp(`^ANSWER TO: ${FULL}`), "answer is for the full question");
  assert.ok(!committed[0].data.text.startsWith("ANSWER TO: how much ."), "never the prefix answer");
  const turn = started(frames).find((f) => f.data.turn_id === done.data.turn_id);
  assert.equal(turn.data.question, FULL);
  engine.dispose();
});

test("a FINISHED prefix prefetch is regenerated when the final adds material wording", async () => {
  const { frames, asr, answerer, clock, engine } = setup();
  asr.send(1, "what does pricing look like");
  clock.advance(300);
  asr.send(1, "what does pricing look like");
  // The prefetch is held (the speaker never paused), so it finishes unseen.
  await waitFor(() => answerer.calls[0]?.finished, { label: "prefetch finished" });
  assert.equal(dones(frames).length, 0, "a held prefetch never reaches the client");

  asr.send(1, "what does pricing look like for a team of two hundred on the enterprise plan", true);
  await waitFor(() => dones(frames).length === 1, { label: "committed answer" });
  assert.equal(answerer.calls.length, 2);
  assert.equal(answerer.calls[1].question, "what does pricing look like for a team of two hundred on the enterprise plan");
  engine.dispose();
});

test("a regressed partial keeps the stream and the final still commits it", async () => {
  const { frames, asr, answerer, clock, engine } = setup({ answererOptions: { deltaMs: 15, count: 6 } });
  const question = "can you tell me about the security review process you run";
  asr.send(1, question); // >= 8 words: immediate trigger
  clock.advance(100);
  asr.send(1, "can you tell me about the security review"); // ASR backtracked
  assert.equal(answerer.calls.length, 1, "regressions never restart");
  asr.send(1, question, true);
  await waitFor(() => dones(frames).length === 1);
  assert.equal(answerer.calls.length, 1, "the original generation is committed");
  assert.equal(started(frames).length, 1);
  engine.dispose();
});

test("minor partial growth does not restart the prefetch (no thrash)", async () => {
  const { asr, answerer, clock, engine } = setup({ answererOptions: { deltaMs: 30, count: 6 } });
  const words = "could you walk me through how onboarding works for new admins on day one".split(" ");
  for (let n = 8; n <= words.length; n += 1) {
    asr.send(1, words.slice(0, n).join(" "));
    clock.advance(120);
  }
  // 8 -> 15 words: restarts only when the question grows by a material
  // amount, so far fewer generations than partials.
  assert.ok(answerer.calls.length <= 2, `expected <= 2 generations, got ${answerer.calls.length}`);
  engine.dispose();
});

test("rep speech never supersedes the prospect's prefetch or queues a turn", async () => {
  const { frames, asr, answerer, clock, engine } = setup({ answererOptions: { deltaMs: 20, count: 5 } });
  const prospectQ = "what integrations do you support for our existing data warehouse";
  asr.send(1, prospectQ); // prefetch starts
  clock.advance(50);
  asr.send(0, "so the way I would think about that is in terms of the connectors we ship"); // 16-word rep partial
  asr.send(0, "so the way I would think about that is in terms of the connectors we ship", true);
  assert.equal(answerer.calls.length, 1, "rep partial/final must not start or supersede a turn");
  assert.ok(!frames.some((f) => f.type === "turn.superseded"));

  asr.send(1, prospectQ, true);
  await waitFor(() => dones(frames).length === 1);
  await sleep(60);
  assert.equal(dones(frames).length, 1, "no queued rep turn after the prospect's answer");
  assert.equal(answerer.calls.length, 1);
  engine.dispose();
});

test("answerRoles makes the gate configurable (rep questions answered when opted in)", async () => {
  const { frames, asr, answerer, engine } = setup({ engineOptions: { answerRoles: ["prospect", "rep"] } });
  asr.send(0, "what is the renewal date on this account again", true);
  await waitFor(() => dones(frames).length === 1);
  assert.equal(answerer.calls.length, 1);
  engine.dispose();
});

test("engine factory forwards answerRoles", async () => {
  const frames = [];
  const factory = createEngineFactory({
    asrOptions: { provider: "mock-scripted", script: { 0: ["what is the renewal date on this account again"] } },
    answererOptions: { provider: "mock", deltaMinMs: 1, deltaMaxMs: 2 },
  });
  const engine = factory({ emit: (f) => frames.push(f), log: () => {} });
  engine.onSessionStart({ sessionId: "f" });
  const chunk = new Int16Array(4800).fill(9000);
  for (let i = 0; i < 12; i += 1) engine.onAudio({ streamIdx: 0, seq: i, pcm16: chunk });
  engine.onFinalize({ streamIdx: 0 });
  await sleep(80);
  assert.ok(frames.some((f) => f.type === "transcript" && f.data.final));
  assert.ok(!frames.some((f) => f.type === "turn.started"), "default factory: rep audio never opens a turn");
  engine.dispose();
});
