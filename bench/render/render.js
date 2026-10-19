/**
 * Renderer paint cost, old vs new (F11), with the overlay's real stylesheet.
 * A token or transcript burst is delivered in one task, as the IPC relay
 * does; we measure the task time (where tokens are handled) plus the next
 * frame, and the total over a whole answer and a long lane.
 */
import { AnswerPainter, LanePainter, createFrameScheduler } from "../../src/desktop/renderer/stream-paint.js";
import { TranscriptLanes, LANE } from "../../src/desktop/renderer/answer-buffer.js";

const answerEl = document.getElementById("answer-text");
const laneEl = document.getElementById("lane-prospect");
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const words = "start from the outcome the prospect cares about and work backwards with a concrete example ".split(" ");

function tokens(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${words[i % words.length]} `);
  return out;
}

async function answerOld(n) {
  let text = "";
  let busy = 0;
  for (const delta of tokens(n)) {
    const t = performance.now();
    text += delta;
    answerEl.textContent = text;
    answerEl.scrollTop = answerEl.scrollHeight;
    busy += performance.now() - t;
    if (Math.random() < 0.5) await nextFrame(); // ~2 tokens per frame
  }
  return busy;
}

async function answerNew(n) {
  const painter = new AnswerPainter(answerEl, { placeholder: "" });
  const frames = createFrameScheduler();
  let text = "";
  let busy = 0;
  const paint = () => {
    const t = performance.now();
    painter.paint({ id: "t", text });
    answerEl.scrollTop = answerEl.scrollHeight;
    busy += performance.now() - t;
  };
  for (const delta of tokens(n)) {
    const t = performance.now();
    text += delta;
    frames.request("answer", paint);
    busy += performance.now() - t;
    if (Math.random() < 0.5) await nextFrame();
  }
  await nextFrame();
  return busy;
}

function laneLine(text, interim) {
  const node = document.createElement("div");
  node.className = interim ? "line interim" : "line";
  node.textContent = text;
  return node;
}

async function laneOld(lanes, n) {
  let busy = 0;
  for (let i = 0; i < n; i++) {
    lanes.ingest({ role: "prospect", text: `interim ${i} ${words.slice(0, (i % 12) + 1).join(" ")}`, final: i % 6 === 5 });
    const t = performance.now();
    const nodes = lanes.lines(LANE.PROSPECT).map((e) => laneLine(e.text, false));
    const interim = lanes.current(LANE.PROSPECT);
    if (interim) nodes.push(laneLine(interim.text, true));
    laneEl.replaceChildren(...nodes);
    laneEl.scrollTop = laneEl.scrollHeight;
    busy += performance.now() - t;
    await nextFrame();
  }
  return busy;
}

async function laneNew(lanes, n) {
  const painter = new LanePainter(laneEl, laneLine);
  const frames = createFrameScheduler();
  let busy = 0;
  const paint = () => {
    const t = performance.now();
    painter.paint(lanes.lines(LANE.PROSPECT), lanes.current(LANE.PROSPECT));
    laneEl.scrollTop = laneEl.scrollHeight;
    busy += performance.now() - t;
  };
  for (let i = 0; i < n; i++) {
    lanes.ingest({ role: "prospect", text: `interim ${i} ${words.slice(0, (i % 12) + 1).join(" ")}`, final: i % 6 === 5 });
    const t = performance.now();
    frames.request("lane", paint);
    busy += performance.now() - t;
    await nextFrame();
  }
  return busy;
}

window.runRenderBench = async () => {
  const results = {};
  // Warm the lane to its 60-line steady state first (long call).
  for (const [name, fn] of [
    ["answer old (textContent + scrollHeight per token)", () => answerOld(800)],
    ["answer new (append + one read per frame)", () => answerNew(800)],
  ]) {
    answerEl.textContent = "";
    await nextFrame();
    results[name] = (await fn()).toFixed(1);
  }
  for (const [name, fn] of [
    ["lane old (rebuild 60 lines per transcript)", (l) => laneOld(l, 600)],
    ["lane new (incremental)", (l) => laneNew(l, 600)],
  ]) {
    laneEl.replaceChildren();
    const lanes = new TranscriptLanes({ maxLines: 60 });
    for (let i = 0; i < 60; i++) lanes.ingest({ role: "prospect", text: `earlier line ${i}`, final: true });
    await nextFrame();
    results[name] = (await fn(lanes)).toFixed(1);
  }
  return results;
};
document.title = "ready";
