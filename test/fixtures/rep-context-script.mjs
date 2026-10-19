/**
 * One scripted call, both speakers, through the real pipeline and the real
 * openai-compatible answerer (fetch faked): what the provider receives for
 * every answer, and every frame the client receives. The rep-context tests
 * replay it with the feature off and compare against the values captured on
 * 8ec5b18 (rep-context-baseline.json), before rep context existed.
 */
import { createAnswerer } from "../../src/server/engines/answerer.js";
import { createPipelineEngine } from "../../src/server/engines/pipeline.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label) {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > 3000) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

export const SCRIPT_DOC = "Pricing: the Team plan is $45 per seat per month. Volume discounts start at 50 seats.";
export const SCRIPT_ANSWER = "- The Team plan is $45 a seat per month.\n- Volume discounts start at 50 seats.";

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

/**
 * @param {object} [engineOptions]  extra createPipelineEngine options (e.g. `repContext`).
 *   Highlights and answer cards are off unless they say otherwise: the
 *   baseline predates them.
 * @param {{answer?: string}} [script]  answer: what the fake provider replies
 * @returns {Promise<{requests: object[], frames: object[]}>}  requests: each
 *   provider request body's `messages`; frames: every frame sent to the client.
 */
export async function runScriptedCall(engineOptions = {}, { answer = SCRIPT_ANSWER } = {}) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body).messages);
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    let clock = 1_000_000;
    const frames = [];
    const asr = fakeAsr();
    const answerer = createAnswerer({ provider: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m" });
    const engine = createPipelineEngine({
      emit: (frame) => frames.push(frame),
      asr,
      answerer,
      log: () => {},
      now: () => clock,
      highlights: false,
      answerCards: false,
      vision: {
        async analyse() {
          return { status: "ok", kind: "document", title: "Pricing page", summary: "The pricing page lists the Team plan at $45 per seat.", analysisId: "a1" };
        },
      },
      ...engineOptions,
    });
    const done = () => frames.filter((frame) => frame.type === "turn.done").length;
    const step = (ms = 1000) => (clock += ms);

    engine.onSessionStart({ sessionId: "s" });
    engine.onContextSet({ docs: SCRIPT_DOC, name: "pricing.md" });

    step();
    asr.send(1, "How much is the Team plan per seat?", true);
    await waitFor(() => done() === 1, "answer 1");

    step();
    asr.send(0, "actually it's fifty");
    asr.send(0, "Actually it's fifty-five a seat now since the October update.", true);
    step();
    asr.send(0, "yeah okay", true);
    step(5000);
    asr.send(1, "do you offer any volume discounts for larger teams");
    asr.send(0, "do you offer any volume discounts for larger teams", true);
    asr.send(1, "Do you offer any volume discounts for larger teams?", true);
    await waitFor(() => done() === 2, "answer 2");

    step();
    asr.send(0, "Volume discounts start at 50 seats.", true);
    step();
    engine.onAnswerRequest({ utterance: "What about annual billing?" });
    await waitFor(() => done() === 3, "answer 3");

    step();
    await engine.onScreenAnalyse({ command_id: "c1" });
    await waitFor(() => done() === 4, "screen answer");

    step();
    engine.onScreenClear();
    asr.send(1, "And how long does onboarding take?", true);
    await waitFor(() => done() === 5, "answer 5");

    engine.onSessionEnd();
    return { requests, frames };
  } finally {
    globalThis.fetch = previousFetch;
  }
}
