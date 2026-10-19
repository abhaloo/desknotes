import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineEngine } from "../src/server/engines/pipeline.js";
import { createJudge } from "../src/server/engines/judge.js";

/**
 * The gate (when a turn starts) and the pause reveal (when the speaker stops)
 * ask the judge about the same utterance with the same questions. The judge
 * caches verdicts by utterance and questions, so when the utterance has not
 * changed by the pause the reveal costs no request of its own.
 */
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
      const data = { text, final, stream: streamIdx, role: streamIdx === 1 ? "prospect" : "rep", source: streamIdx === 1 ? "system" : "mic" };
      for (const cb of handlers) cb(data);
    },
  };
}

function answerer({ deltaMs = 3, count = 4 } = {}) {
  const calls = [];
  async function* streamAnswer(args) {
    const call = { question: args.question, finished: false };
    calls.push(call);
    for (let i = 0; i < count; i += 1) {
      await sleep(deltaMs);
      if (args.signal?.aborted) return;
      yield i === 0 ? `ANSWER TO: ${args.question}` : " .";
    }
    call.finished = true;
  }
  return { calls, streamAnswer };
}

/** A real judge over a fake transport: every request body is recorded, every answer is the same. */
function judgeWithFetch({ isQuestion = 0.97, isComplete = 0.95 } = {}) {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    await sleep(20);
    const answers = { is_question: { noul: isQuestion }, is_complete: { noul: isComplete } };
    return new Response(JSON.stringify({ answers }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const judge = createJudge({ apiKey: "k", features: "gate", timeoutMs: 2000, fetchImpl });
  return { judge, requests };
}

function setup(judge) {
  const frames = [];
  const logs = [];
  const asr = fakeAsr();
  const engine = createPipelineEngine({
    emit: (f) => frames.push(f),
    asr,
    answerer: answerer(),
    judge,
    log: (e) => logs.push(e),
  });
  engine.onSessionStart({ sessionId: "cache" });
  const turnFrames = () => frames.filter((f) => f.type.startsWith("turn."));
  const of = (type) => frames.filter((f) => f.type === type);
  return { frames, logs, asr, engine, turnFrames, of };
}

const QUESTION = "how much does the enterprise plan cost per seat for us";

test("the reveal at a pause reuses the gate's verdict: one judge request", async () => {
  const { judge, requests } = judgeWithFetch();
  const { asr, engine, of, logs } = setup(judge);
  try {
    asr.send(1, QUESTION); // >= 8 words: a held turn starts and the gate asks
    await waitFor(() => requests.length === 1, { label: "gate request" });
    const [gate] = requests;
    assert.ok(gate.questions.is_question, "the gate asks whether this needs an answer");
    assert.ok(gate.questions.is_complete, "the gate also asks whether the thought is complete");
    assert.equal(gate.state.utterance, QUESTION);

    engine.onTurnHint({ streamIdx: 1, state: "pause" });
    await waitFor(() => of("turn.started").length === 1, { label: "reveal" });
    assert.equal(requests.length, 1, "the reveal was answered from the gate's verdict");
    assert.ok(logs.some((e) => e.type === "turn.revealed" && e.why === "pause_judged"));
  } finally {
    engine.dispose();
  }
});

test("a changed utterance at the pause still asks the judge again", async () => {
  const { judge, requests } = judgeWithFetch();
  const { asr, engine, of } = setup(judge);
  try {
    asr.send(1, QUESTION);
    await waitFor(() => requests.length === 1, { label: "gate request" });
    assert.ok(requests[0].questions.is_complete, "the gate asks the same questions a reveal asks");

    // One more word is non-material growth: the turn keeps the answer it is
    // generating and the pause judges the new wording, which nothing cached.
    const grown = `${QUESTION} please`;
    asr.send(1, grown);
    engine.onTurnHint({ streamIdx: 1, state: "pause" });
    await waitFor(() => requests.length === 2, { label: "reveal request" });
    assert.equal(requests[1].state.utterance, grown, "the reveal asks about what the prospect now said");
    assert.ok(requests[1].questions.is_complete);

    await waitFor(() => of("turn.started").length === 1, { label: "reveal" });
    assert.equal(of("turn.started")[0].data.question, grown, "the revealed answer shows the latest wording");
  } finally {
    engine.dispose();
  }
});

test("the gate's decision is unchanged: small talk is still gated out", async () => {
  const smallTalk = "yeah that makes sense I think the team would be fine";
  const { judge, requests } = judgeWithFetch({ isQuestion: 0.03, isComplete: 0.9 });
  const { asr, engine, logs, turnFrames } = setup(judge);
  try {
    asr.send(1, smallTalk); // >= 8 words: a held turn starts and the gate asks
    await waitFor(() => logs.some((e) => e.type === "turn.gated_out"), { label: "gated out" });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].questions.is_question);
    assert.ok(requests[0].questions.is_complete);

    asr.send(1, smallTalk, true);
    await sleep(30);
    assert.deepEqual(turnFrames(), [], "no turn frame, held or shown");
  } finally {
    engine.dispose();
  }
});
