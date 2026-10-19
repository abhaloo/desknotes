/**
 * Overlay renderer. Plain DOM, no framework: the panel repaints on every
 * answer delta and every interim transcript, so render cost must stay trivial.
 * Deltas are appended as text nodes and lanes update incrementally, coalesced
 * to one paint per animation frame (stream-paint.js).
 *
 * All list/buffer/debounce logic lives in answer-buffer.js so it can be tested
 * without a DOM; this file only turns that view model into nodes.
 */
import { IPC } from "../ipc-gateway.js";
import {
  LANE,
  AnswerBuffer,
  TranscriptLanes,
  SpeakingIndicators,
  summariseVadStats,
  ScreenCards,
  screenLabel,
  screenCardNotes,
} from "./answer-buffer.js";
import { AnswerPainter, LanePainter, createFrameScheduler } from "./stream-paint.js";
import { TermsPainter, TermsState } from "./terms-view.js";
import { shouldFollow } from "./answer-scroll.js";
import { buildDeviceSelectors, createStatusGate, presentAudioStatus } from "./audio-status.js";
import { groundingErrorText, groundingStatusText } from "./grounding-view.js";
import { applyCaptureToggle } from "./capture-start.js";
import { installSplitters } from "./layout-splitters.js";

const bridge = window.copilot ?? null;
const CH = bridge?.channels ?? IPC;
const params = new URLSearchParams(window.location.search);
// `panel` windows render the answer surface only; they share this bundle (R2/R3).
document.body.dataset.mode = params.get("mode") === "control" ? "control" : params.get("mode") === "panel" ? "panel" : "overlay";
const isControl = document.body.dataset.mode === "control";

const el = (id) => document.getElementById(id);
const els = {
  statusPill: el("status-pill"),
  statusPillOverlay: el("status-pill-overlay"),
  realtimePill: el("realtime-pill"),
  realtimePillOverlay: el("realtime-pill-overlay"),
  answerText: el("answer-text"),
  answerTerms: el("answer-terms"),
  answerQuestion: el("answer-question"),
  answerState: el("answer-state"),
  screenCards: el("screen-cards"),
  laneProspect: el("lane-prospect"),
  laneRep: el("lane-rep"),
  dotProspect: el("dot-prospect"),
  dotRep: el("dot-rep"),
  vadBar: el("vad-bar"),
  vadState: el("vad-state"),
  vadMeta: el("vad-meta"),
  toggleCapture: el("toggle-capture"),
  toggleCaptureOverlay: el("toggle-capture-overlay"),
  toggleMultiAnswer: el("toggle-multi-answer"),
  windowOpacity: el("window-opacity"),
  toggleClickThrough: el("toggle-click-through"),
  clickThroughPill: el("click-through-pill"),
  clickThroughPillOverlay: el("click-through-pill-overlay"),
  shortcutHints: el("shortcut-hints"),
  toast: el("toast"),
  settingsDialog: el("settings-dialog"),
  btnSettings: el("btn-settings"),
  btnSettingsClose: el("btn-settings-close"),
  btnAnswerNow: el("btn-answer-now"),
  hintAnswerNow: el("hint-answer-now"),
  btnScreen: el("btn-screen"),
  btnClear: el("btn-clear"),
  btnHide: el("btn-hide"),
  audioMic: el("audio-mic"),
  audioSystem: el("audio-system"),
  audioRoute: el("audio-route"),
  audioMicStatus: el("audio-mic-status"),
  audioSystemStatus: el("audio-system-status"),
  audioAsrStatus: el("audio-asr-status"),
  audioLevels: el("audio-levels"),
  audioResolved: el("audio-resolved"),
  audioHeadphones: el("audio-headphones"),
  audioRetry: el("audio-retry"),
  audioExport: el("audio-export"),
  audioOverlay: el("audio-overlay-summary"),
  groundingStatus: el("grounding-status"),
  groundingLoad: el("grounding-load"),
  groundingClear: el("grounding-clear"),
  settingsNote: el("settings-note"),
  btnPractice: el("btn-practice"),
  answerModel: el("answer-model"),
  answerModelNote: el("answer-model-note"),
  repContext: el("rep-context"),
  highlights: el("highlights"),
  answerCards: el("answer-cards"),
  glossary: el("glossary"),
  glossaryNote: el("glossary-note"),
  answerInstructionsPath: el("answer-instructions-path"),
  btnOpenDataFolder: el("btn-open-data-folder"),
  btnOpenKnownTerms: el("btn-open-known-terms"),
};

const answers = new AnswerBuffer();const transcripts = new TranscriptLanes();
const speaking = new SpeakingIndicators({ quietMs: 1500 });
const screenCards = new ScreenCards();

const ANSWER_PLACEHOLDER = "Waiting for the first question…";
const frames = createFrameScheduler();
/* One view, two surfaces. The overlay keeps the compact chrome it had before the
   settings dialog existed (spec item 4: pills, VAD meter, capture toggle,
   click-through pill); the control window renders the same state inside the
   dialog. Both copies are written from one place, so they cannot drift. */
const STATUS_PILL_MIRRORS = [els.statusPill, els.statusPillOverlay];
const REALTIME_PILL_MIRRORS = [els.realtimePill, els.realtimePillOverlay];
// The VAD meter lives only in the Settings dialog (a diagnostic, not overlay chrome).
const VAD_BAR_MIRRORS = [els.vadBar];
const VAD_STATE_MIRRORS = [els.vadState];
const VAD_META_MIRRORS = [els.vadMeta];
const CLICK_THROUGH_PILL_MIRRORS = [els.clickThroughPill, els.clickThroughPillOverlay];
const CAPTURE_BOXES = [els.toggleCapture, els.toggleCaptureOverlay];

const answerPainter = new AnswerPainter(els.answerText, { placeholder: ANSWER_PLACEHOLDER });
// The Terms block under the answer: its own frame, its own paint job.
const terms = new TermsState();
const termsPainter = new TermsPainter(els.answerTerms);
let answerId = null;
let follow = false;
function createLine(text, interim) {
  const node = document.createElement("div");
  node.className = interim ? "line interim" : "line";
  node.textContent = text;
  return node;
}
const lanePainters = {
  [LANE.PROSPECT]: new LanePainter(els.laneProspect, createLine),
  [LANE.REP]: new LanePainter(els.laneRep, createLine),
};

const view = {
  lifecycle: "idle",
  realtime: "idle",
  clickThrough: false,
  repText: "",
  // Latest prospect utterance: "answer now" answers what was just ASKED.
  prospectText: "",
  // Capture state comes from the speech command results, not the lifecycle:
  // a live session whose capture failed must not show the toggle as on.
  capture: false,
  // A screen capture is being read (main's SCREEN_ANALYSIS_STATE): the
  // answer badge turns orange until the reading lands.
  screenBusy: false,
};

/** Never stay orange if the idle broadcast is lost (the server times out well before this). */
const SCREEN_BUSY_MAX_MS = 45_000;
let screenBusyTimer = null;

function setScreenBusy(busy) {
  clearTimeout(screenBusyTimer);
  view.screenBusy = Boolean(busy);
  if (view.screenBusy) screenBusyTimer = setTimeout(() => setScreenBusy(false), SCREEN_BUSY_MAX_MS);
  renderAnswer();
}

/** say_ids already rendered: re-sends at a join boundary must not duplicate. */
const renderedSays = new Set();

const ACTION_HINTS = {
  "toggle-click-through": "click-through",
  "toggle-overlay": "show/hide overlay",
  "answer-now": "answer now",
  "analyse-screen": "analyse screen",
  "clear-display": "clear",
  quit: "quit",
};

/* --------------------------------------------------------------- rendering */

function setPill(node, value, prefix = "") {
  if (!node) return;
  node.dataset.state = value;
  node.textContent = `${prefix}${value}`;
}

function renderStatus() {
  for (const node of STATUS_PILL_MIRRORS) setPill(node, view.lifecycle);
  for (const node of REALTIME_PILL_MIRRORS) setPill(node, view.realtime, "link: ");
  const active = view.lifecycle === "active";
  if (!active) view.capture = false;
  for (const box of CAPTURE_BOXES) {
    if (box) box.checked = active && view.capture;
  }
}

/** One incremental lane paint per animation frame, however many frames arrived. */
function renderLane(lane) {
  const container = lane === LANE.REP ? els.laneRep : els.laneProspect;
  if (!container) return;
  frames.request(`lane:${lane}`, () => {
    lanePainters[lane].paint(transcripts.lines(lane), transcripts.current(lane));
    container.scrollTop = container.scrollHeight; // one layout read per frame
  });
}

/** Tokens append as text nodes; the card paints at most once per frame. */
/** The loading line in the answer box: "" when nothing is on its way. */
function answerLoadingLabel({ pending, screenBusy }) {
  if (screenBusy) return "Reading the screen";
  return pending ? "Thinking" : "";
}

function renderAnswer() {
  frames.request("answer", () => {
    const active = answers.active;
    if (els.answerQuestion) {
      // Which question this answer is for: the prospect's words (or, for a
      // screen answer, what was captured), set once per turn.
      const question = active?.question ?? "";
      const shown = question ? `Q: ${question}` : "";
      if (els.answerQuestion.textContent !== shown) els.answerQuestion.textContent = shown;
      els.answerQuestion.hidden = !question;
    }
    // An answer is on its way but has no words yet: the turn started (the
    // question is processed) and the model has not sent its first token.
    const pending = Boolean(active && !active.done && !active.text);
    if (els.answerText) {
      answerPainter.paint(active);
      const loading = answerLoadingLabel({ pending, screenBusy: view.screenBusy });
      els.answerText.classList.toggle("streaming", answers.isStreaming && !pending);
      els.answerText.classList.toggle("pending", loading !== "");
      if (els.answerText.dataset.loading !== loading) els.answerText.dataset.loading = loading;
      // The engine cut this answer short (turn.done `cut`): a quiet note under the text.
      const cut = Boolean(active?.done && active.cut);
      if (cut) els.answerText.dataset.cut = "";
      else delete els.answerText.dataset.cut;
      const id = active?.id ?? null;
      if (id !== answerId) {
        answerId = id;
        follow = false;
        els.answerText.scrollTop = 0;
      } else if (follow) {
        els.answerText.scrollTop = els.answerText.scrollHeight; // one layout read per frame
      }
    }
    if (els.answerState) {
      let state = active ? (active.done ? "complete" : pending ? "thinking" : "streaming") : "idle";
      let dataState = active ? (active.done ? "ended" : pending ? "pending" : "active") : "idle";
      if (view.screenBusy) {
        state = "analysing screen";
        dataState = "screen";
      }
      if (els.answerState.textContent !== state) els.answerState.textContent = state;
      els.answerState.dataset.state = dataState;
    }
  });
}

/** The Terms block paints on its own frame job, never with a token. */
function renderTerms() {
  frames.request("terms", () => termsPainter.paint(terms.entries));
}

/* ------------------------------------------------------- screen analysis */

/**
 * One capture -> one compact record: what the screen showed (the vision
 * reading) and a status. The answer itself streams in the main field.
 */
function createScreenCard(card) {
  const node = document.createElement("article");
  node.id = `screen-card-${card.number}`;
  node.className = "screen-card";
  node.dataset.cardNumber = String(card.number);
  node.dataset.status = card.status;
  if (card.id) node.dataset.cardId = card.id;
  if (card.kind) node.dataset.kind = card.kind;

  const head = document.createElement("header");
  head.className = "screen-card-head";
  const title = document.createElement("span");
  title.className = "screen-card-title";
  title.textContent = `Screen #${card.number}`;
  // At most six words next to the title: the full reading is answer context only.
  const label = document.createElement("span");
  label.className = "screen-card-label";
  label.textContent = screenLabel(card);
  const badges = document.createElement("span");
  badges.className = "screen-card-badges";
  if (card.dedup) {
    const dedup = document.createElement("span");
    dedup.className = "badge screen-dedup";
    dedup.textContent = "seen before";
    badges.append(dedup);
  }
  head.append(title, label, badges);
  node.append(head);

  for (const noteText of screenCardNotes(card)) {
    const note = document.createElement("p");
    note.className = "screen-card-note";
    note.textContent = noteText;
    node.append(note);
  }
  return node;
}

/**
 * One analysis -> one numbered card. The command reply mirrors the pushed
 * `screen.result` frame; ingest() dedups by command_id/analysis_id so exactly
 * one renders. The answer arrives as ordinary turn frames (onAnswer).
 */
function onScreenResult(result) {
  if (!result || typeof result !== "object") return null;
  const { card, created } = screenCards.ingest(result, Date.now());
  if (!created) return card;
  if (els.screenCards) {
    els.screenCards.append(createScreenCard(card));
    els.screenCards.scrollTop = els.screenCards.scrollHeight;
  }
  return card;
}

function renderSpeaking(at = Date.now()) {
  els.dotProspect?.classList.toggle("speaking", speaking.speaking(LANE.PROSPECT, at));
  els.dotRep?.classList.toggle("speaking", speaking.speaking(LANE.REP, at));
}

function renderVad(stats) {
  const summary = summariseVadStats(stats);
  for (const bar of VAD_BAR_MIRRORS) {
    if (!bar) continue;
    bar.style.width = `${Math.round(summary.openRatio * 100)}%`;
    bar.classList.toggle("failed-open", summary.failedOpen);
    bar.classList.toggle("gated", !summary.failedOpen && !summary.speaking);
  }
  let label = "gated";
  let state = "idle";
  if (summary.failedOpen) {
    label = "fail-open";
    state = "failed";
  } else if (summary.speaking) {
    label = "open";
    state = "active";
  }
  for (const node of VAD_STATE_MIRRORS) {
    if (!node) continue;
    node.textContent = label;
    node.dataset.state = state;
  }
  const parts = [`fwd ${summary.forwarded}`, `gated ${summary.gated}`];
  if (summary.dropped > 0) parts.push(`dropped ${summary.dropped}`);
  if (summary.source) parts.push(summary.source);
  const meta = parts.join(" · ");
  for (const node of VAD_META_MIRRORS) {
    if (node) node.textContent = meta;
  }
}

/** Window state as main reports it: the click-through pills and the Settings toggle follow it. */
function renderWindowState(status = {}) {
  if (typeof status.clickThrough === "boolean") view.clickThrough = status.clickThrough;
  for (const node of CLICK_THROUGH_PILL_MIRRORS) {
    if (!node) continue;
    node.dataset.state = view.clickThrough ? "active" : "off";
    node.textContent = view.clickThrough ? "click-through on" : "click-through off";
  }
  // WINDOW_STATE_CHANGED also carries the click-through flag: one source of truth.
  if (els.toggleClickThrough && els.toggleClickThrough.checked !== view.clickThrough) {
    els.toggleClickThrough.checked = view.clickThrough;
  }
}

function formatAccelerator(accelerator) {
  return String(accelerator).replace("CommandOrControl", "Ctrl").replace(/\+/g, "+");
}

function renderHints(bindings = []) {
  if (els.shortcutHints) {
    // Each hint is also a button: clicking it runs the same shell action as
    // the keys (R5), so a shortcut is never the only way in.
    const nodes = bindings.map(({ accelerator, action }) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "hint-btn";
      button.dataset.action = action;
      const kbd = document.createElement("kbd");
      kbd.textContent = formatAccelerator(accelerator);
      button.append(kbd, document.createTextNode(` ${ACTION_HINTS[action] ?? action}`));
      button.addEventListener("click", () => void runShellAction(action));
      li.append(button);
      return li;
    });
    els.shortcutHints.replaceChildren(...nodes);
  }
  // R5: the Answer now button carries its accelerator, from the same bindings
  // list as the hints footer — never a hardcoded key string.
  if (els.hintAnswerNow) {
    const answerNow = bindings.find((binding) => binding?.action === "answer-now");
    els.hintAnswerNow.textContent = answerNow?.accelerator ? formatAccelerator(answerNow.accelerator) : "";
    els.hintAnswerNow.hidden = !answerNow?.accelerator;
  }
}

/** Panel feature state (R1/R10): every window mirrors the main process. */
function renderPanels(state = {}) {
  const toggle = els.toggleMultiAnswer;
  if (!toggle) return;
  if (typeof state.enabled === "boolean") toggle.checked = state.enabled;
  if (typeof state.count === "number") toggle.dataset.count = String(state.count);
}

let toastTimer = null;

/**
 * The toast is a manual popover (index.html): only the top layer outranks a
 * modal <dialog>, so a message raised from inside the settings dialog - or from
 * a background broadcast while it is open - stays visible. Re-raising moves an
 * already-open toast above a dialog that opened after it.
 */
function raiseToast() {
  if (!els.toast) return;
  els.toast.hidden = false;
  try {
    if (els.toast.matches(":popover-open")) els.toast.hidePopover();
    els.toast.showPopover();
  } catch {
    /* pre-popover runtime: the toast stays in the panel flow */
  }
}

function hideToast() {
  if (!els.toast) return;
  try {
    if (els.toast.matches(":popover-open")) els.toast.hidePopover();
  } catch {
    /* not a popover here */
  }
  els.toast.hidden = true;
}

function showToast(message, kind = "error", ttlMs = 4000) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.dataset.kind = kind;
  raiseToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ttlMs);
}

/**
 * No per-delta timers: exactly ONE pending repaint for the next dot to go
 * quiet. Each transcript replaces it (the old code started a new timer chain
 * per transcript, and none was ever cancelled).
 */
let speakingTimer = null;
function scheduleSpeakingRefresh() {
  clearTimeout(speakingTimer);
  speakingTimer = null;
  const remaining = speaking.nextExpiry(Date.now());
  if (!Number.isFinite(remaining)) return;
  speakingTimer = setTimeout(() => {
    speakingTimer = null;
    renderSpeaking();
    scheduleSpeakingRefresh();
  }, Math.max(50, remaining + 10));
}

/* ------------------------------------------------------------------- data */

function latestRepText(text) {
  if (text) view.repText = text;
}

function latestProspectText(text) {
  if (text) view.prospectText = text;
}

function onTranscript(frame = {}) {
  const at = Date.now();
  const { lane, entry } = transcripts.ingest(frame, at);
  if (lane === LANE.REP && entry.text) latestRepText(entry.text);
  if (lane === LANE.PROSPECT && entry.text && frame.source !== "agent") latestProspectText(entry.text);
  // Interim frames power the speaking dot: they arrive within ~300 ms of
  // speech, long before a final transcript exists.
  speaking.note(lane, at);
  renderLane(lane); // only the lane that changed
  renderSpeaking(at);
  scheduleSpeakingRefresh();
}

function onAnswer(frame = {}) {
  // Downlink answer vocabulary (docs/protocol.md): `gate.verdict`,
  // `turn.started`, `turn.token`, `turn.done`, `turn.superseded` — all
  // consumed from the raw-frame relay.
  const data = frame.data ?? frame;
  switch (frame.type) {
    case "turn.started":
      answers.start(data, Date.now());
      if (terms.start(data.turn_id)) renderTerms();
      break;
    case "turn.token":
      answers.append(data, Date.now());
      break;
    case "turn.done":
      answers.done(data, Date.now());
      break;
    case "turn.superseded":
      answers.supersede(data, Date.now());
      break;
    case "gate.verdict":
      // The gate announced a decision: the card can show "answering…" before
      // the first token lands.
      renderStatus();
      return;
    case "terms":
      // The finished card's terms, for the answer on screen only; the answer
      // itself is not repainted.
      if (terms.apply(data, answers.active?.id ?? null)) renderTerms();
      return;
    default:
      return;
  }
  renderAnswer();
}

/**
 * Clear (DISPLAY_CLEARED, sent to every window): the answer card, both lanes
 * and the screen cards empty. Listening is untouched; the next frames repaint.
 */
function clearDisplay() {
  answers.clear();
  transcripts.reset();
  screenCards.reset();
  view.prospectText = "";
  view.repText = "";
  els.screenCards?.replaceChildren();
  renderAnswer();
  if (terms.clear()) renderTerms();
  renderLane(LANE.PROSPECT);
  renderLane(LANE.REP);
}

/* -------------------------------------------------------------- bootstrap */

/** One dispatcher for buttons, hints and accelerators (R5). */
async function runShellAction(action) {
  if (!bridge) {
    showToast("Desktop bridge unavailable (open inside the shell)", "error");
    return null;
  }
  if (typeof bridge.shellAction !== "function") return null;
  try {
    return await bridge.shellAction(action);
  } catch (error) {
    showToast(error?.message ?? String(error), "error");
    return null;
  }
}

/* ------------------------------------------------------- window opacity */

let opacityDragging = false;
let opacitySending = false;
let opacityQueued = false;

/** The slider shows the shared value unless this window's user is dragging it. */
function renderWindowOpacity(value) {
  const slider = els.windowOpacity;
  if (!slider || typeof value !== "number" || !Number.isFinite(value) || opacityDragging) return;
  const percent = String(Math.round(value * 100));
  if (slider.value !== percent) slider.value = percent;
  slider.setAttribute("aria-valuetext", `${percent}%`);
}

/** One request in flight at a time; a drag sends its latest value, the release saves it. */
async function sendWindowOpacity(persist) {
  const slider = els.windowOpacity;
  if (!slider) return;
  slider.setAttribute("aria-valuetext", `${slider.value}%`);
  if (opacitySending && !persist) {
    opacityQueued = true;
    return;
  }
  opacitySending = true;
  try {
    await call(CH.WINDOW_SET_OPACITY, { opacity: Number(slider.value) / 100, persist }, { quiet: !persist });
  } finally {
    opacitySending = false;
  }
  if (opacityQueued) {
    opacityQueued = false;
    void sendWindowOpacity(false);
  }
}

async function call(command, payload = null, { quiet = false } = {}) {
  if (!bridge) {
    if (!quiet) showToast("Desktop bridge unavailable (open inside the shell)", "error");
    return null;
  }
  try {
    return await bridge.command(command, payload);
  } catch (error) {
    if (!quiet) showToast(error?.message ?? String(error), "error");
    return null;
  }
}

function wireEvents() {
  bridge?.on(CH.SPEECH_TRANSCRIPT_RECEIVED, onTranscript);
  // Raw wire relay: answer/turn frames are consumed straight off the
  // socket, one dispatch layer, zero batching.
  bridge?.on(CH.SPEECH_REALTIME_FRAME_RECEIVED, (raw) => {
    let frame = null;
    try {
      frame = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string") return;
    // `screen.result` frames carry the same analysis the screen:analyse
    // command reply resolves with; both feed the deduped card path.
    if (frame.type === "screen.result") onScreenResult(frame.data ?? frame);
    else onAnswer(frame);
  });
  bridge?.on(CH.COACH_SAY, (data) => {
    const sayId = typeof data?.say_id === "string" ? data.say_id : null;
    // "say" is the server's coach lane: render it as prospect speech so the
    // user sees exactly what would be spoken next. Main re-sends un-acked
    // says at every avatarReady boundary, so render each say_id once.
    if (!sayId || !renderedSays.has(sayId)) {
      if (sayId) renderedSays.add(sayId);
      onTranscript({ role: "prospect", source: "agent", text: data?.text ?? "", final: true });
    }
    // Delivery handshake: ACK so main stops holding it as pending.
    if (sayId) void call(CH.COACH_SAY_ECHOED, { say_id: sayId }, { quiet: true });
  });
  bridge?.on(CH.SPEECH_ERRORED, (error = {}) => {
    showToast(error?.message ?? "speech error", "error");
  });
  bridge?.on(CH.SPEECH_VAD_STATS, (stats = {}) => {
    renderVad(stats);
    // `active` = pipelines running: the capture toggle follows the real
    // state whichever path (button, shortcut, session start) changed it.
    if (typeof stats?.active === "boolean" && stats.active !== view.capture) {
      view.capture = stats.active;
      renderStatus();
    }
  });
  bridge?.on(CH.SPEECH_STATUS_CHANGED, (status = {}) => {
    if (typeof status.state === "string") {
      // say_ids restart with every session: a fresh start (not a recovery
      // from active) forgets the previous session's.
      if (status.state === "launching" && status.previous !== "active") renderedSays.clear();
      view.lifecycle = status.state;
    }
    if (status.error) showToast(status.error, "error");
    renderStatus();
  });
  bridge?.on(CH.SPEECH_REALTIME_STATUS_CHANGED, (status = {}) => {
    view.realtime = status.state ?? "unknown";
    renderStatus();
  });
  bridge?.on(CH.WINDOW_STATE_CHANGED, (status = {}) => {
    renderWindowState(status);
    renderWindowOpacity(status.windowOpacity);
  });
  // Panel feature state fans out to every window, so the checkbox cannot
  // drift from the main process (R1/R10).
  if (IPC.PANELS_CHANGED) bridge?.on(IPC.PANELS_CHANGED, renderPanels);
  bridge?.on(CH.DISPLAY_CLEARED ?? IPC.DISPLAY_CLEARED, clearDisplay);
  bridge?.on(CH.SCREEN_ANALYSIS_STATE ?? IPC.SCREEN_ANALYSIS_STATE, (payload) => setScreenBusy(payload?.busy === true));
  els.btnClear?.addEventListener("click", () => void runShellAction("clear-display"));

  // R5: one dispatcher for buttons and accelerators alike.
  els.btnAnswerNow?.addEventListener("click", () => void runShellAction("answer-now"));
  els.btnScreen?.addEventListener("click", async () => {
    // `result` is the unwrapped analysis (the bridge rejects on IPC failure).
    // The pushed `screen.result` frame mirrors it; onScreenResult renders
    // whichever arrives first and ignores the duplicate.
    const result = await call(CH.SCREEN_ANALYSE, { purpose: "context", origin: "manual" });
    if (!result) return;
    const card = onScreenResult(result);
    if (card?.status === "failed") {
      // The card is the durable record; the toast is the at-a-glance alert.
      const tag = card.failure ? ` [${card.failure}]` : "";
      showToast(`screen: ${card.error || "analysis failed"}${tag}`, "error");
    }
  });
  els.btnHide?.addEventListener("click", () => call(CH.WINDOW_HIDE));
  // Settings dialog: opened only by the gear button, closed by its Close button
  // (Escape closes a native <dialog> by itself).
  els.btnSettings?.addEventListener("click", () => {
    if (!els.settingsDialog || els.settingsDialog.open) return;
    els.settingsDialog.showModal();
    // The dialog just entered the top layer above any live toast: raise the
    // toast again so feedback that arrived before the click stays readable.
    if (els.toast && !els.toast.hidden) raiseToast();
  });
  els.btnSettingsClose?.addEventListener("click", () => els.settingsDialog?.close());

  // The checkbox is the window's only listening control AND the app-open
  // preference. With no session (auto-start off, COPILOT_AUTOSTART=0, a failed
  // boot, unreadable settings) it opens one first: speech:start alone would
  // answer E_NOT_ACTIVE and leave the user with no way back in.
  const onCaptureToggle = async (event) => {
    const { capture } = await applyCaptureToggle({
      lifecycle: view.lifecycle,
      checked: event.currentTarget.checked,
      startSession: () => call(CH.SESSION_START, {}),
      startSpeech: () => call(CH.SPEECH_START, {}),
      stopSpeech: () => call(CH.SPEECH_STOP, null),
      saveAutoStart: (autoStart) => persistAutoStart(autoStart),
    });
    // A rejected command was toasted by call(); renderStatus() reverts both
    // checkboxes to the real state.
    view.capture = capture;
    renderStatus();
  };
  els.toggleCapture?.addEventListener("change", onCaptureToggle);
  els.toggleCaptureOverlay?.addEventListener("change", onCaptureToggle);
  els.toggleMultiAnswer?.addEventListener("change", async () => {
    const checked = els.toggleMultiAnswer.checked;
    if (typeof bridge?.panelsSet !== "function") {
      els.toggleMultiAnswer.checked = !checked;
      return;
    }
    try {
      renderPanels((await bridge.panelsSet(checked)) ?? { enabled: checked });
    } catch (error) {
      els.toggleMultiAnswer.checked = !checked;
      showToast(error?.message ?? String(error), "error");
    }
  });
  // Title-row transparency for every window: live while dragging, saved on release.
  els.windowOpacity?.addEventListener("pointerdown", () => (opacityDragging = true));
  for (const type of ["pointerup", "pointercancel"]) {
    els.windowOpacity?.addEventListener(type, () => (opacityDragging = false));
  }
  els.windowOpacity?.addEventListener("input", () => void sendWindowOpacity(false));
  els.windowOpacity?.addEventListener("change", () => void sendWindowOpacity(true));
  if (isControl) {
    els.audioMic?.addEventListener("change", () => onAudioChoice("microphone", els.audioMic));
    els.audioSystem?.addEventListener("change", () => onAudioChoice("system", els.audioSystem));
    els.audioRetry?.addEventListener("click", async () => {
      const result = await call(CH.SPEECH_START, {});
      if (!result) return;
      view.capture = (result.sources?.length ?? 0) > 0;
      const failed = Array.isArray(result.failed) ? result.failed : [];
      if (failed.length > 0) showToast(failed.map((item) => `${item.source}: ${item.message}`).join(" "), "error", 6000);
      renderStatus();
    });
    els.audioExport?.addEventListener("click", async () => {
      const result = await call(CH.AUDIO_EXPORT_DIAGNOSTICS, {});
      if (result?.bytes !== undefined) showToast(`Diagnostics saved (${result.bytes} bytes)`, "info", 4000);
    });
    els.groundingLoad?.addEventListener("click", onGroundingLoad);
    els.answerModel?.addEventListener("change", onAnswerModelChange);
    els.repContext?.addEventListener("change", onRepContextChange);
    els.highlights?.addEventListener("change", onHighlightsChange);
    els.answerCards?.addEventListener("change", onAnswerCardsChange);
    els.glossary?.addEventListener("change", onGlossaryChange);
    els.answerText?.addEventListener("scroll", () => {
      follow = shouldFollow(els.answerText);
    }, { passive: true });
    els.groundingClear?.addEventListener("click", onGroundingClear);
    els.btnOpenDataFolder?.addEventListener("click", onOpenDataFolder);
    els.btnOpenKnownTerms?.addEventListener("click", onOpenKnownTerms);
    els.toggleClickThrough?.addEventListener("change", async () => {
      const wanted = els.toggleClickThrough.checked;
      const result = await call(CH.WINDOW_SET_CLICK_THROUGH, { enabled: wanted });
      if (!result) {
        els.toggleClickThrough.checked = !wanted;
        return;
      }
      view.clickThrough = Boolean(result.clickThrough ?? wanted);
      renderWindowState({});
    });
    // The button only opens the window; practice starts and ends inside it.
    els.btnPractice?.addEventListener("click", () => call(CH.PRACTICE_OPEN));
  }
  bridge?.on(CH.AUDIO_STATUS_CHANGED, onAudioStatus);
}

const audioGate = createStatusGate();
const audioCatalog = { microphone: [], system: [] };
let audioSelected = {
  microphone: { kind: "default", role: "communications" },
  system: { kind: "default", role: "multimedia" },
};

function choiceFromOption(value) {
  if (typeof value !== "string") return null;
  if (value.startsWith("default:")) {
    const role = value.slice("default:".length);
    if (role !== "multimedia" && role !== "communications") return null;
    return { kind: "default", role };
  }
  if (value.startsWith("endpoint:")) {
    const id = value.slice("endpoint:".length);
    if (!id) return null;
    return { kind: "endpoint", id };
  }
  return null;
}

// Rebuilding a <select>'s options while its dropdown popup is open makes
// Chromium close the popup instantly. Audio status arrives frequently (levels
// tick), so only touch the DOM when the presented selector actually changed.
const audioSelectFillKey = new WeakMap();

function fillAudioSelect(select, selector, enabled) {
  if (!select || !selector) return;
  const key = `${enabled === false ? "d" : "e"}\u0000${selector.selectedValue ?? ""}\u0000${selector.options
    .map((option) => `${option.value}\u0001${option.label}\u0001${option.unavailable ? 1 : 0}`)
    .join("\u0002")}`;
  if (audioSelectFillKey.get(select) === key) return;
  audioSelectFillKey.set(select, key);
  const nodes = selector.options.map((option) => {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    if (option.unavailable) node.dataset.unavailable = "true";
    return node;
  });
  select.replaceChildren(...nodes);
  if (selector.selectedValue && select.value !== selector.selectedValue) select.value = selector.selectedValue;
  select.disabled = enabled === false;
}

function paintAudio(update) {
  const presented = presentAudioStatus({
    ...update,
    supportsAec: false,
    capturing: view.capture || update?.phase === "capturing",
    phase: view.capture ? "capturing" : update?.phase,
  });
  if (els.audioRoute) els.audioRoute.textContent = presented.routingGuidance;
  if (els.audioMicStatus) els.audioMicStatus.textContent = `Microphone: ${presented.microphone.label}`;
  if (els.audioSystemStatus) els.audioSystemStatus.textContent = `Playback: ${presented.system.label}`;
  if (els.audioAsrStatus) els.audioAsrStatus.textContent = presented.transcription.label;
  if (els.audioLevels) {
    const mic = update?.sources?.microphone ?? {};
    const system = update?.sources?.system ?? {};
    els.audioLevels.textContent = `Mic level ${Number(mic.level ?? 0).toFixed(3)}, drops ${mic.dropped ?? 0}, gaps ${mic.discontinuities ?? 0}. Playback level ${Number(system.level ?? 0).toFixed(3)}, drops ${system.dropped ?? 0}, gaps ${system.discontinuities ?? 0}.`;
  }
  if (els.audioResolved) {
    const micName = presented.microphone.endpointName || presented.microphone.endpointId || "default";
    const systemName = presented.system.endpointName || presented.system.endpointId || "default";
    els.audioResolved.textContent = `Resolved microphone ${micName}. Resolved playback ${systemName}.`;
  }
  if (els.audioHeadphones) {
    els.audioHeadphones.hidden = !presented.headphonesRequired;
    els.audioHeadphones.textContent = presented.headphonesMessage;
  }
  const selectors = buildDeviceSelectors({ devices: audioCatalog, selected: audioSelected });
  fillAudioSelect(els.audioMic, selectors.microphone, presented.selectorsEnabled);
  fillAudioSelect(els.audioSystem, selectors.system, presented.selectorsEnabled);
  if (els.audioOverlay) {
    els.audioOverlay.textContent = `Mic ${presented.microphone.label}. Playback ${presented.system.label}. ${presented.transcription.label}.`;
  }
}

function onAudioStatus(update) {
  const result = audioGate.apply({
    generation: update?.generation,
    sources: update?.sources,
    transcription: update?.transcription,
    supportsAec: false,
    capturing: view.capture,
    phase: view.capture ? "capturing" : "idle",
  });
  if (!result.applied || !result.view) return;
  paintAudio(update);
}

async function loadAudioDevices() {
  if (!bridge || !isControl) return;
  try {
    const [status, microphone, system] = await Promise.all([
      bridge.request(CH.AUDIO_GET_STATUS),
      bridge.request(CH.AUDIO_LIST_DEVICES, { source: "microphone" }),
      bridge.request(CH.AUDIO_LIST_DEVICES, { source: "system" }),
    ]);
    audioCatalog.microphone = Array.isArray(microphone) ? microphone : [];
    audioCatalog.system = Array.isArray(system) ? system : [];
    const prefs = status?.preferences;
    if (prefs?.microphone?.choice) audioSelected.microphone = prefs.microphone.choice;
    if (prefs?.system?.choice) audioSelected.system = prefs.system.choice;
    onAudioStatus(status ?? { generation: 0, sources: {}, transcription: { state: "unconfigured" } });
  } catch (error) {
    showToast(error?.message ?? "audio devices unavailable", "error");
  }
}

async function onAudioChoice(source, select) {
  const choice = choiceFromOption(select?.value);
  if (!choice) return;
  const saved = await call(CH.AUDIO_SET_DEVICE, { source, choice });
  if (!saved) {
    await loadAudioDevices();
    return;
  }
  audioSelected[source] = saved;
  await loadAudioDevices();
}

/* --------------------------------------------- grounding + app settings */

/** Metadata only: main never sends the document text to a renderer. */
let grounding = { document: null, readError: null };

function renderGrounding(errorText = null) {
  if (!els.groundingStatus) return;
  els.groundingStatus.textContent = errorText ?? groundingStatusText(grounding);
  if (errorText) els.groundingStatus.dataset.state = "error";
  else delete els.groundingStatus.dataset.state;
  if (els.groundingClear) els.groundingClear.disabled = !grounding.document;
}

function renderSettings({ readError = null, answerModel, answerInstructionsPath, deepseekAvailable, cerebrasAvailable, repContext, highlights, answerCards, glossary } = {}) {
  if (els.settingsNote) {
    els.settingsNote.textContent = readError ?? "";
    els.settingsNote.hidden = !readError;
  }
  if (els.answerModel && typeof answerModel === "string") els.answerModel.value = answerModel;
  if (els.repContext && typeof repContext === "boolean") els.repContext.checked = repContext;
  if (els.highlights && typeof highlights === "boolean") els.highlights.checked = highlights;
  if (els.answerCards && typeof answerCards === "boolean") els.answerCards.checked = answerCards;
  if (els.glossary && typeof glossary === "boolean") els.glossary.checked = glossary;
  if (els.glossaryNote) {
    const missingKey = glossaryMissingKey({ deepseekAvailable });
    els.glossaryNote.textContent = missingKey ?? "";
    els.glossaryNote.hidden = !missingKey;
  }
  if (els.answerInstructionsPath && typeof answerInstructionsPath === "string") {
    els.answerInstructionsPath.textContent = answerInstructionsPath;
  }
  if (els.answerModelNote) {
    const missingKey = answerModelMissingKey(els.answerModel?.value, { deepseekAvailable, cerebrasAvailable });
    els.answerModelNote.textContent = missingKey ?? "Applies from the next answer.";
    if (missingKey) els.answerModelNote.dataset.state = "error";
    else delete els.answerModelNote.dataset.state;
  }
}

/**
 * The note for a choice whose key is missing, or null. Without a DeepSeek key
 * a DeepSeek choice answers on the configured engine (answer-models.js), which
 * is Qwen with thinking on Cerebras when CEREBRAS_API_KEY is set.
 */
function answerModelMissingKey(choice, { deepseekAvailable, cerebrasAvailable } = {}) {
  if (choice === "cerebras-qwen-thinking") {
    return cerebrasAvailable === false ? "CEREBRAS_API_KEY was not found, so Qwen 27B can't answer. Answers use demo text." : null;
  }
  if (deepseekAvailable !== false) return null;
  return cerebrasAvailable === false
    ? "DEEPSEEK_API_KEY and CEREBRAS_API_KEY were not found, so answers use demo text."
    : "DEEPSEEK_API_KEY was not found, so answers use Qwen 27B thinking (Cerebras).";
}

/** Terms runs only on DeepSeek (glossary.js): without its key there is no fallback. */
function glossaryMissingKey({ deepseekAvailable } = {}) {
  return deepseekAvailable === false ? "DEEPSEEK_API_KEY was not found, so terms are not explained." : null;
}

async function onAnswerModelChange() {
  if (!bridge || !els.answerModel) return;
  try {
    renderSettings((await bridge.command(CH.SETTINGS_SET, { answerModel: els.answerModel.value })) ?? {});
  } catch (error) {
    showToast(error?.message ?? "Couldn't save the setting.", "error");
    await loadGroundingPanel();
  }
}

/** Settings > "Use what I say in answers": saved at once, read by the next answer. */
async function onRepContextChange() {
  if (!bridge || !els.repContext) return;
  try {
    renderSettings((await bridge.command(CH.SETTINGS_SET, { repContext: els.repContext.checked })) ?? {});
  } catch (error) {
    showToast(error?.message ?? "Couldn't save the setting.", "error");
    await loadGroundingPanel();
  }
}

/** Settings > "Highlight key phrases": saved at once, read by the next answer. */
async function onHighlightsChange() {
  if (!bridge || !els.highlights) return;
  try {
    renderSettings((await bridge.command(CH.SETTINGS_SET, { highlights: els.highlights.checked })) ?? {});
  } catch (error) {
    showToast(error?.message ?? "Couldn't save the setting.", "error");
    await loadGroundingPanel();
  }
}

/** Settings > "Short answer cards": saved at once, read by the next answer. */
async function onAnswerCardsChange() {
  if (!bridge || !els.answerCards) return;
  try {
    renderSettings((await bridge.command(CH.SETTINGS_SET, { answerCards: els.answerCards.checked })) ?? {});
  } catch (error) {
    showToast(error?.message ?? "Couldn't save the setting.", "error");
    await loadGroundingPanel();
  }
}

/** Settings > "Explain terms": saved at once, read by the next answer turn. */
async function onGlossaryChange() {
  if (!bridge || !els.glossary) return;
  try {
    renderSettings((await bridge.command(CH.SETTINGS_SET, { glossary: els.glossary.checked })) ?? {});
  } catch (error) {
    showToast(error?.message ?? "Couldn't save the setting.", "error");
    await loadGroundingPanel();
  }
}

async function loadGroundingPanel() {
  if (!bridge) return;
  try {
    const [doc, settings] = await Promise.all([bridge.request(CH.GROUNDING_GET), bridge.request(CH.SETTINGS_GET)]);
    grounding = { document: doc?.document ?? null, readError: doc?.readError ?? null };
    renderGrounding();
    renderSettings(settings ?? {});
  } catch (error) {
    renderGrounding(groundingErrorText(error));
  }
}

async function onGroundingLoad() {
  if (!bridge || !els.groundingLoad) return;
  els.groundingLoad.disabled = true;
  try {
    // Main opens the file picker itself; this window never names a path.
    const result = await bridge.command(CH.GROUNDING_LOAD, null);
    if (result && result.cancelled === false) {
      grounding = { document: result.document ?? null, readError: null };
      renderGrounding();
      if (result.applied) showToast("Document loaded. It applies to the next answer.", "info", 3000);
    }
  } catch (error) {
    renderGrounding(groundingErrorText(error));
  } finally {
    els.groundingLoad.disabled = false;
  }
}

async function onGroundingClear() {
  if (!bridge) return;
  try {
    await bridge.command(CH.GROUNDING_CLEAR, null);
    grounding = { document: null, readError: null };
    renderGrounding();
  } catch (error) {
    renderGrounding(groundingErrorText(error));
  }
}

/** Main opens the data folder (answer instructions, settings) in the file manager. */
async function onOpenDataFolder() {
  if (!bridge) return;
  try {
    await bridge.openSettingsFolder();
  } catch (error) {
    showToast(error?.message ?? "Couldn't open the settings folder.", "error");
  }
}

/** Main opens known-terms.txt (one term per line, never explained) in the default editor. */
async function onOpenKnownTerms() {
  if (!bridge) return;
  try {
    await bridge.openKnownTerms();
  } catch (error) {
    showToast(error?.message ?? "Couldn't open the known-terms file.", "error");
  }
}

/** The capture checkbox also carries the old auto-start preference: one control. */
async function persistAutoStart(autoStart) {
  if (!bridge) return;
  try {
    await bridge.command(CH.SETTINGS_SET, { autoStart });
  } catch (error) {
    showToast(error?.message ?? "Couldn't save the setting.", "error");
  }
}

async function hydrate() {
  if (!bridge) {
    renderStatus();
    return;
  }
  try {
    const [, status, shortcuts, windows] = await Promise.all([
      bridge.request(CH.CONFIG_GET),
      bridge.request(CH.SPEECH_GET_REALTIME_STATUS),
      bridge.request(CH.SHORTCUTS_LIST),
      bridge.request(CH.WINDOW_GET_STATE),
    ]);
    renderWindowOpacity(windows?.windowOpacity);
    view.lifecycle = status?.lifecycle ?? "idle";
    view.realtime = status?.realtime ?? "idle";
    renderWindowState(windows ?? {});
    renderVad(status?.vad ?? {});
    renderHints(shortcuts?.bindings ?? []);
    view.capture = Boolean(status?.vad?.active);
    renderStatus();
    // Auto-start can fail before this window finished loading: show why.
    if (view.lifecycle === "failed" && status?.lastError) showToast(status.lastError, "error", 8000);
    // Join boundary of the say-lane handshake: main re-sends any say this
    // window has not ACKed yet (e.g. after a reload).
    void call(CH.COACH_AVATAR_READY, {}, { quiet: true });
    await loadAudioDevices();
    if (isControl) await loadGroundingPanel();
  } catch (error) {
    showToast(error?.message ?? String(error), "error");
  }
}

wireEvents();
// Adjustable answer / Prospect / You boxes (control and overlay windows only).
installSplitters({ document, window, mode: document.body.dataset.mode });
renderAnswer();
hydrate();
