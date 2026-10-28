# Module contracts

The interfaces between DeskNotes' modules. A signature change here is a
change to every caller: update the code, its tests and this file together.

## Conventions

1. ESM JavaScript on the **Bun** runtime (>= 1.1) for the server and the
   tests. The desktop shell runs under Electron's Node, so `src/shared/`,
   `src/transport/` and `src/desktop/` must stay dual-runtime: no Bun-only
   globals (`Bun.serve`, `Bun.file`, ...). Use the global `WebSocket` (both
   runtimes provide it) and `ws` for the server. Allowed **runtime** deps:
   built-ins, `ws`, optional `onnxruntime-node`. Build-only devDependencies
   are permitted for the native toolchain (currently `node-gyp`); no other
   runtime packages.
2. Tests use `node:test` + `node:assert`. Run them with `npm test`, which
   starts one Bun process per file. Keep every test under 30 s.
3. Wire constants and codecs live in `src/shared/protocol.js`; import them
   from there.
4. Comments explain WHY and the latency/robustness reasoning. Terse is fine,
   essays are not.
5. No network access except localhost in tests.
6. Never name a commercial vendor product in code, comments, docs or strings.

## Modules

The section headings below use these labels. Test files carry the same
prefix (`test/p1-*.test.js` for the transport, and so on).

| label | module | directories |
|-------|--------|-------------|
| shared | wire protocol | `src/shared/` |
| P1 | transport | `src/transport/`, `src/server/ws-server.js`, `src/server/mock-engine.js` |
| P2 | VAD and audio | `src/vad/`, `src/audio/`, `native/`, `src/desktop/audio-capture-*` |
| P3 | answer engine | `src/server/engines/`, `src/server/main.js` |
| P4 | vision | `src/vision/`, `src/server/engines/vision.js` |
| P5 | desktop shell | `src/desktop/` |

`test/sec-main-hardening.test.js` boots the real `main.mjs` under Bun's
`mock.module`; under `node --test` it skips instead of failing on the
Bun-only mock.

## src/shared/protocol.js

```js
export const PROTOCOL_VERSION = 1;
export const SAMPLE_RATE = 16000;
export const FRAME_HEADER_BYTES = 5;
export const RING_MAX_BYTES = 16000 * 2 * 12;      // 12 s of PCM16 mono
export const STREAM = { MICROPHONE: 0, SYSTEM: 1 };
export const SOURCE_TO_STREAM = { microphone: 0, system: 1 };
export const STREAM_TO_SOURCE = { 0: "microphone", 1: "system" };
export const CAPABILITIES = { SCREEN_ANALYSE: "screen_analyse", ANSWER_REQUEST: "answer_request", REPLAY: "replay", SESSION_COMMANDS: "session_commands" };
export function encodeAudioFrame(streamIdx, seq, pcm) // -> ArrayBuffer (Uint8Array|Int16Array payload)
export function decodeAudioFrame(data)               // -> { streamIdx, seq, pcm: Uint8Array }
export function makeFrame(type, fields)   // -> JSON string with {v:1, type, ...fields}
export function parseFrame(raw)           // -> object | null
```

## P2 — `src/vad/index.js`

```js
export const VadConfig = {
  enabled: true,
  frameSamples: 512,            // 32 ms @ 16 kHz, Silero v5 fixed frame
  sampleRate: 16000,
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  redemptionFrames: 24,         // ~0.77 s hangover
  preRollMs: 384,
  maxQueueFrames: 32,
  maxDroppedBeforeFailOpen: 64,
};
export class SileroVad {
  static async create({ modelPath } = {})   // onnxruntime-node; throws if asset missing
  async process(frame /* Float32Array(512) */, carry /* Float32Array */) // -> { probability, nextState }
  async dispose()
}
export class EnergyVad {   // zero-dependency fallback, SAME process() contract
  constructor({ noiseFloorDb = -55 } = {})
  async process(frame, carry) // -> { probability, nextState: carry }
}
export class VadGate {
  constructor({ probe, onSend, onSpeechEnd, onFailedOpen, initialState, tunables })
  feed(chunk /* Float32Array, any length */)  // buffers to 512-sample frames; gates with pre-roll + redemption
  flush()        // end of stream: emit held tail + onSpeechEnd if speaking
  // additive (optional) constructor callbacks: onSpeechStart, onSpeechPause
  // (probable end of turn, VadLatencyConfig.pauseHintFrames), onSpeechResume.
  // additive export: VadLatencyConfig, energyProbability(frame, noiseFloorDb)
  stats()        // { forwarded, gated, dropped, speaking, failedOpen }
  close()
}
```

## P2 — `src/audio/index.js`

```js
export function createCapture({ backend = "simulated", source, filePath, sampleRate = 16000, chunkMs = 32 })
//   -> { async start(), stop(), onChunk(cb) -> unsub, info() }
//   cb receives { pcm: Float32Array (native rate, mono), sampleRate, timestampMs }
//   backends: "simulated" (procedural speech-like bursts + silence, test-friendly),
//             "file" (16-bit PCM WAV reader), "native" (MUST exist but may throw
//             a clear "unsupported on this platform" error — real WASAPI/CoreAudio
//             capture is out of scope for tests)
export function resampleTo16kMono(input /* Float32Array */, srcRate)  // -> Float32Array
export function floatToPcm16(input /* Float32Array */)                // -> Int16Array
export function createSpeechPipeline({ capture, vad, sink, source, log })
//   -> { async start(), async stop(), onEvent(cb) -> unsub }
//   vad: { probe(frame512, carry), initialState() } OR null (= forward everything)
//   sink: { sendAudio(source, pcm16), finalizeStream(source), hintStream?(source, "pause"|"resume") }
//   events: { type: "vad", speaking } | { type: "audio", bytes } | { type: "error", error }
```

## P1 — `src/transport/realtime-client.js`

```js
export class RealtimeClient {
  constructor({ createSocket = (url) => new WebSocket(url), telemetry, pingIntervalMs = 5000, baseUrl })  // PING_INTERVAL_MS (was 15000)
  async start(session)   // session: { sessionId, jwt, topology = "general", captureAuthorized = false }
                         // resolves on OPEN, rejects on first-connect failure
  async reconnect()      // resume same session: keeps retrying transient failures
  disconnect()           // drop link, KEEP session (server keeps it alive)
  stop()                 // end everything
  sendAudio(source /* "microphone"|"system" */, pcm16 /* Int16Array */)
  finalizeStream(source)
  requestAnswer(utterance, intent, gateSeq)
  setCaptureAuthorized(authorized)
  sendScreenAnalyse({ commandId, purpose, origin, imageHash, objectPath, contentType }) // -> bool (false if not OPEN)
  sendTurnHint(source, "pause"|"resume") // additive -> bool (false without the turn_hint capability)
  hasCapability(name)    // -> bool (false until first session.state)
  onFrame(cb)   // (raw: string, frame: object) -> unsub
  onStatus(cb)  // ({state: "connecting"|"live"|"reconnecting"|"ended"|"failed", attempt?}) -> unsub
  onScreenResult(cb) // (result) -> unsub
  getStats()    // { sentFrames, droppedFrames, bufferedBytes, reconnects, lastSeenSeq }
  getLinkStats() // additive: { resentFrames, unackedFrames, livenessProbes, uplinkPaused, queuedFrames }
}
```

## P1 — `src/server/ws-server.js`

```js
export class RealtimeServer {
  constructor({ port = 0, createEngine, verifyToken = () => true, replayBufferSize = 240 })
  async start()   // -> { port, url }
  async stop()
  // createEngine({ emit, log }) -> engine instance, one per connection
}
// engine interface (mock (P1) and pipeline (P3) both implement it):
//   onSessionStart({ sessionId, streams, captureAuthorized, lastSeenSeq })
//   onAudio({ streamIdx, seq, source, pcm16, timestampMs })
//   onFinalize({ streamIdx })
//   onAnswerRequest({ utterance, intent, gateSeq })
//   onScreenAnalyse(request) -> Promise<result>   (request.signal: AbortSignal, additive)
//   onTurnHint?({ streamIdx, state })              (additive, optional)
//   onScreenClear?()                               (additive, optional: `screen_clear`)
//   onSessionEnd()
//   dispose()
// emit(frameObject) sends a JSON frame to the owning client.
```

Server must implement: per-stream seq gap accounting (report via
`log({type:"gap",...})`), a per-session replay ring of recent DOWNLINK frames so
`hello.last_seen_seq` can be satisfied (uplink audio is never replayed; the
client's gap ring covers it) (capability `replay`), `session.state`
with capabilities on connect, `pong` replies, and `session.ended` handling.

## P1 — `src/server/mock-engine.js`

`export function createMockEngine({ emit })` — deterministic stub engine:
emits a canned `session.state`, turns audio into mock transcripts at most every
500 ms (`final:false` interims, `final:true` on `finalize`), answers
`answer_request` with `gate.verdict` + `turn.started` + 3–5 `turn.token`
frames + `turn.done`, echoes `say`
for prospect-role transcripts, returns a stub `screen.result`. Used by P1
tests and as the fallback engine.

## P3 — `src/server/engines/`

```js
// index.js
export function createPipelineEngine({ emit, asr, answerer, vision, log })  // -> engine (contract above)
// asr.js
export function createAsr({ provider = "mock", model, baseUrl, apiKey, emit })
//   -> { pushAudio({streamIdx, seq, source, pcm16, ts}), finalize(streamIdx), close() }
//   provider "mock": energy-based segmentation emitting interims every ~300 ms
//   provider "openai-compatible": optional streaming STT (skip cleanly if no key)
//   ASR emits transcript frames through emit (partial + final, with role/source).
// answerer.js
export function createAnswerer({ provider = "mock", model = "mock", baseUrl, apiKey, systemPrompt, temperature,
  reasoningEffort, promptMode = "spoken", routes = {} })
//   -> { async *streamAnswer({ question, context, intent, mode, signal, screen }), async answerOnce(...) }
//   screen (additive): "context" = the Context carries a SCREEN block (adds
//   SCREEN_RULE); "capture" = the turn a screen capture started (adds
//   SCREEN_RULE + SCREEN_TURN_RULE and, in spoken mode, section 4 of the
//   answer-instructions file after the base prompt).
//   promptMode: "spoken" (rep voice, default) | "technical" (senior-engineer
//   written answers). `mode` overrides it per call. routes: per-mode provider
//   overrides ({spoken|technical: {provider?, model?, baseUrl?, apiKey?,
//   temperature?, reasoningEffort?, systemPrompt?}}) merged over the base
//   options; both slots go through the same transport policy. Only provider
//   "mock" mocks; any other unusable configuration (no key, unknown provider,
//   "unconfigured", a URL that fails the policy) answers nothing: streamAnswer
//   throws `no_answer_model` (`retryable: false`). Live mode never configures
//   the mock (config.js), so a real call never shows demo text. The
//   spoken-text filter runs in both modes.
//   streamAnswer({highlights: true}) adds HIGHLIGHT_RULE after the base prompt
//   (and a screen turn's section 4) and keeps `**` key phrases through the
//   filter (createSpokenTextFilter({highlights: true}): at most one per bullet,
//   three per answer, five words each; a lone `*` is dropped); anything else
//   is the prompt and filter output from before highlights, byte for byte.
//   Exports DEFAULT_SYSTEM_PROMPT, TECHNICAL_SYSTEM_PROMPT, GROUNDING_RULE,
//   GROUNDING_RULE_TECHNICAL, SURFACE_RULES, NO_CHATBOT_RULES, SCREEN_RULE,
//   SCREEN_TURN_RULE, SCREEN_USE, HIGHLIGHT_RULE, systemMessage.
//   PREFETCH RULE (the whole point of this recreation): start streaming an
//   answer as soon as a partial transcript crosses the trigger (last word
//   stable >= 250 ms or >= 8 words), cancel/restart on newer partials, commit
//   on the final transcript. answer_request supersedes only when no turn is
//   in flight.
```

`pipeline.js` wires ASR + answerer + vision, maintains session context
(resume/playbook/docs strings passed in `onSessionStart`), and emits
`transcript`, `turn.*` (started/token/done/superseded), `gate.verdict`, `say`,
`screen.result` (full shape: analysis_id/title/summary/error + solve enum).
`main.js` starts `RealtimeServer` with `createPipelineEngine`, reads `PORT`,
`ANSWER_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` env vars, logs
`ws://localhost:<port>`, and shuts down cleanly on SIGINT.

`pipeline.js` exports `buildContext({ resume, playbook, docs, history, screen, prospect, conversation }) -> string` (additive).
`history` is `[{q, a}]`: the last two finished committed exchanges, capped (1,000 chars total),
rendered as `RECENT EXCHANGE:` after `DOCUMENTS:`. `screen` is `{text, kind?, title?, ageMs}`, rendered
as `SCREEN (captured <age>; kind: ...; title: ...):` between `DOCUMENTS:` and `RECENT EXCHANGE:`
(1,500 chars). `prospect` is recent prospect speech, oldest first, rendered last as
`PROSPECT SPEECH (latest last):` (900 chars, newest kept). `conversation` is rep context's lines
(`[{who: "prospect"|"rep", text, at}]`, see "Rep context" below), rendered as
`RECENT CONVERSATION (oldest first; REP lines are what the rep actually said):` between `SCREEN` and
`RECENT EXCHANGE:` (last 8 lines as `PROSPECT: ...` / `REP: ...`, 300 chars per line, 1,200 chars,
oldest dropped first), and only when a REP line survives the caps; prospect lines that `PROSPECT SPEECH`
already carries are skipped. With the block, `RECENT EXCHANGE` labels its answers `Suggested:` instead of
`A:`; without it, the context is exactly what it is without `conversation`. `buildContext` budgets the
sections itself (`RESUME`/`PLAYBOOK` 4,000 chars each, `DOCUMENTS` gets the remainder of 32,000).

Screen turns (`pipeline.js`, exports `SCREEN_CONTEXT_TTL_MS` = 10 minutes): `onScreenAnalyse` is
stage 1 (vision interprets) and returns the vision result unchanged. When that result is `ok` with a
non-empty `summary`, and the capture was not aborted, cleared or overtaken by a newer capture, stage 2
starts at once: one committed turn (`reason`/`intent` `"screen"`, never gated) through the normal
answerer, cancellation and telemetry paths. It replaces whatever holds the lane (cancel/replace, like
`startTurn`) and drops a queued final, whose words are already in its prompt. Its question is the
prospect's latest words (or "Answer the question or task shown on the screen."), and its context adds
the SCREEN block and `PROSPECT SPEECH` (the last three answering-role finals plus a segment still
open). The interpretation then stays in every later turn's context (`screen: "context"`) until
`onScreenClear`, a newer successful capture or the TTL; only the latest is kept, and a failed capture
keeps the previous one. The finished screen answer joins `RECENT EXCHANGE` as
`Q: [screen: <title>] <latest words>`. Telemetry: `screen.analysed` {commandId, status, kind, dedup,
stub, chars, visionMs, overtaken?}; the screen turn's `turn.started` adds `screen` {analysisId, kind,
chars, dedup, stub, visionMs} and its `turn.done` adds `screen` {visionMs, firstDeltaMs, answerMs};
`screen.cleared` {had} and `screen.expired`.
`buildEngineConfig(env).answererOptions` adds `promptMode` (`ANSWER_PROMPT_MODE=spoken|technical`,
default spoken) and `routes.technical` when any `LLM_TECHNICAL_BASE_URL|API_KEY|MODEL|
REASONING_EFFORT` is set; the technical slot keeps the operator's `ANSWER_PROVIDER` (it never
turns a mock session live), and the shared LLM key only follows the technical slot onto the LLM
origin. `buildEngineConfig(env).repContext` is `REP_CONTEXT` (`0`/`false`/`off` off; unset, `1`,
`true`, `on` on; any other value warns and stays on), forwarded by `createEngineFactory`.
`buildEngineConfig(env).highlights` is `HIGHLIGHTS`, parsed the same way.
`buildEngineConfig(env).answerCards` is `ANSWER_CARDS`, parsed the same way.
`buildEngineConfig(env).glossary` is `GLOSSARY`, parsed the same way; `buildEngineConfig(env, {knownTermsPath}).glossaryOptions`
is `{apiKey: DEEPSEEK_API_KEY, knownTermsPath}` (the option, else `KNOWN_TERMS_PATH`, else null) and null without
`DEEPSEEK_API_KEY` (no other key or engine stands in). `createEngineFactory` builds one glossary per session from it and
reads `glossaryResolver` once per turn (see "Terms" below).
`bench/answer-quality.mjs` + `bench/answer-quality-checks.mjs` + `bench/answer-quality-report.mjs`
+ `bench/answer-quality-compare.mjs` run the labelled eval set in
`bench/fixtures/answer-quality-questions.json` and apply the decision rule of the answer-quality
spec (docs/superpowers/specs/2026-10-15-answer-quality-design.md).

## P4 — `src/vision/index.js` + `src/server/engines/vision.js`

```js
// src/vision/index.js (client side)
export function hashImage(bytes) // -> hex sha256
export class ScreenCapture {
  constructor({ desktopCapturer, maxWidth = SCREEN_MAX_WIDTH, jpegQuality = SCREEN_JPEG_QUALITY }) // 1920, 85
  async capture({ display })  // -> { bytes: Uint8Array, contentType: "image/jpeg", width, height } | null
}
export class ScreenAnalyser {
  constructor({ transport, http, sessionIdProvider, log })
  // transport: { sendScreenAnalyse, hasCapability, onScreenResult } (RealtimeClient)
  // http: { post(path, opts) } | null  (legacy fallback transport)
  async analyse({ bytes, contentType, purpose = "context", origin = "manual" }) // -> result
  // socket-first: dedup by image_hash, mint upload when needed, HTTP fallback
  // when the socket path is unavailable.
  // result: { status, kind, dedup, solve, failure? }
}
// src/server/engines/vision.js (server side)
export function createVisionEngine({ log })
//   -> { async analyse(request, { emit, sessionId }) -> result }
//   Stage 1 of a screen turn: INTERPRETS, never answers. result: { status:
//   "ok"|"empty"|"failed", kind: "question"|"code"|"other", title (<= 80),
//   summary: the interpretation (<= MAX_INTERPRETATION_CHARS = 1,200: visible
//   question/task text and key code verbatim, diagrams and tables summarised,
//   the kind of screen), solve: "not_requested", stub?: true, failure? }.
//   The prompt is the fixed INTERPRET_PROMPT (JSON reply {kind, title,
//   interpretation}; a reply cut off by the token cap is recovered by
//   parseModelAnswer). dedup by image_hash (LRU). No model configured (or no
//   pixels) -> a deterministic stub reading (stub: true), in demo mode only:
//   with allowMockFallback false (live mode, config.js) no model -> status
//   "failed", failure "unconfigured" (names DEEPSEEK_API_KEY), and no pixels
//   -> failure "provider". A configured model that fails -> status "failed",
//   failure "provider" (not cached).
```

## P5 — `src/desktop/`

Electron shell recreating the product surface: `main.mjs` (window manager +
IPC gateway + session lifecycle + wiring P1/P2/P4), `preload.cjs`
(contextBridge), `renderer/index.html` + `renderer/app.js` (overlay UI),
`session-lifecycle.js` (state machine: idle -> launching -> active ->
ending -> ended | failed), `ipc-gateway.js`.

Adjustable boxes (`renderer/layout-splitters.js`, renderer-only, no IPC): in
the control and overlay windows, `#split-answer` sits between the answer card
and the lanes and `#split-lanes` between Prospect and You. Each is a no-drag
`role="separator"`: drag it, step it with the arrow keys (5%) or Page Up /
Page Down (15%), Home / End for the limits, and double-click or Enter for the
default layout. A split is stored as a share of the two boxes' space in
`localStorage` under `desknotes.layout.v1.<mode>` (control and overlay apart),
and CSS applies it as flex / grid weights with the floors `--answer-min`
(120px), `--lanes-min` (160px) and `--lane-min` (56px), so a saved layout
re-clamps at every window size and the outer column still scrolls what does
not fit. Without a stored share the layout is the content-driven default.
Multi-answer panel windows have no splitters.

Multi-answer windows are owned by `src/desktop/panel-manager.js`:
`createPanelManager(deps)` returns `{ ensurePanels(enabled),
applyClickThrough(enabled), reclampAll(), closeAll() }` and owns exactly two
overlay-style panels (`state.windows.panels`), their bounds in
`userDataDirectory()/panel-bounds.json` (clamped to live display work areas),
and their click-through wiring. Every shortcut button and
accelerator dispatches through `triggerShellAction(action)` so they cannot
drift. Additive IPC: `panels:set` (command, `{enabled}`), `panels:changed`
(broadcast, `{enabled, count}`), `shell:action` (command, `{action}`),
`display:cleared` (broadcast, `{at}`). Shell actions: `answer-now`,
`analyse-screen`, `toggle-click-through`,
`toggle-overlay`, `clear-display` (every window drops its answer, lanes and
screen cards, and main sends `screen_clear` so the server drops its screen
context; the session keeps listening) and `quit`. `analyse-screen` puts one
record card (`Screen #n`: the vision reading and a status) in
`#screen-cards`; its answer streams in the Streaming answer field as an
ordinary turn. Quit is an in-app
Ctrl+Q handled in `before-input-event`, never a `globalShortcut`, so Ctrl+Q
in other applications is untouched. Each shortcut hint renders as a button
that runs its shell action.

IPC channel names (fidelity): `speech:start|stop|reconnect|disconnect|
requestAnswer|transcript:received|status:changed|realtime-status:changed|
vad:stats|setVadEnabled|getVadEnabled|getRealtimeStatus`, `screen:analyse`,
`session:start|end|captureFullscreen`,
`shortcuts:*`, `window:*`, `config:get`.

Selected-device audio channels (additive):

- `audio:listDevices` query `{source:"microphone"|"system"}` -> `Device[]`.
  Listing does not start capture.
- `audio:getCapabilities` query -> `{supportsAec:false, ...}`. There is
  no acoustic-echo-cancellation control.
- `audio:getStatus` query -> `{generation, sources, transcription,
  preferences, capabilities}`.
- `audio:setDevice` command `{source, choice}` -> saved `DeviceChoice`.
  `choice` is `{kind:"endpoint", id}` or `{kind:"default", role:
  "multimedia"|"communications"}`. A change while capture is active
  fails with `AUDIO_CAPTURE_ACTIVE` and type `CONFLICT`.
- `audio:exportDiagnostics` command -> `{path, bytes}`. Main chooses the
  file under its user-data `diagnostics` directory. The body is metadata
  only and at most 64 KiB. The renderer cannot supply the path.
- `audio:status:changed` broadcast -> `{generation, sources, transcription}`.
  Level updates are limited to 10 per second.

`DeviceChoice` preferences live in `audio-device-preferences.json` under
the app user-data directory. A missing saved endpoint stays visible and
unavailable until the owner picks another device or retries. Native
capture passes the choice and a generation token into the utility-process
host. Speech sinks bind to the session transport object that was current
when that generation started.

Overlay window: always-on-top ("screen-saver" level), frameless, transparent,
optional click-through (`setIgnoreMouseEvents(true, { forward: true })`),
sized like a side panel.

Window opacity (`window-opacity.js`, slider `#window-opacity` in the title row
of the control and overlay windows, after Multi-answer): one value for the
control window, the overlay and every multi-answer panel, including panels
opened later. Range 0.3-1 (default 1), so no window can be made invisible.
`window:setOpacity` (command) takes `{ opacity: number, persist?: boolean }`
and returns `{ windowOpacity }`; the value is clamped, `persist: true` (sent
when a drag ends) saves it as `windowOpacity` in `app-preferences.json`, and
`window:getState` / `window:state:changed` carry `windowOpacity` so every
slider follows. Opacity is applied by the window presenter
(`window-presenter.js`): `show` sets the user's value before it shows a
window, and `applyOpacity(win)` sets it on a window that is already open. A
missing or destroyed window is skipped. The practice window keeps full opacity.

The renderer shows: live transcript (prospect vs rep lanes), a
streaming answer card (deltas render immediately), speaking indicators driven
by interim transcripts (debounced 1.5 s), a VAD gate meter, and
capture toggles.

Electron may be unavailable: keep `session-lifecycle.js` and `ipc-gateway.js`
PURE (no `electron` import) so they are unit-testable with `bun test`; import
`electron` only from `main.mjs` / `preload.cjs`.

### Grounding document and app settings

| Channel | Kind | Payload | Value |
|---|---|---|---|
| `grounding:get` | query | none | `{ document: {name, words, chars, loadedAt} \| null, readError: string \| null }` |
| `grounding:load` | command | ignored: main opens the file picker and never reads a renderer path | `{ cancelled: true, document }` or `{ cancelled: false, document, applied }`; failures `E_DOC_TYPE`, `E_DOC_TOO_LARGE`, `E_DOC_NOT_TEXT`, `E_DOC_EMPTY`, `E_DOC_UNREADABLE`, `E_DOC_SAVE` |
| `grounding:clear` | command | none | `{ document: null }` |
| `settings:get` | query | none | `{ autoStart: boolean, answerModel: "deepseek-flash-thinking" \| "deepseek-flash" \| "cerebras-qwen-thinking", answerInstructionsPath: string, deepseekAvailable: boolean, cerebrasAvailable: boolean, keySources: { DEEPSEEK_API_KEY \| CEREBRAS_API_KEY \| GROQ_API_KEY \| TYPESAFE_API_KEY: "keys.env" \| "environment" \| null }, windowOpacity: number, repContext: boolean, highlights: boolean, answerCards: boolean, glossary: boolean, knownTermsPath: string, readError: string \| null }` |
| `settings:set` | command | `{ autoStart?: boolean, answerModel?: string, windowOpacity?: number, repContext?: boolean, highlights?: boolean, answerCards?: boolean, glossary?: boolean }`, at least one; `answerModel` must be a listed choice, `windowOpacity` a finite number (clamped to 0.3-1), `repContext`, `highlights`, `answerCards` and `glossary` booleans | the saved settings; `E_INVALID_PAYLOAD` otherwise |
| `settings:openFolder` | command | none | `{ opened: true, path }` after `shell.openPath(userDataDirectory())`; `E_OPEN_FOLDER` when the shell reports an error |
| `settings:openKnownTerms` | command | none | `{ opened: true, path }` after creating `known-terms.txt` empty when it is missing and `shell.openPath(path)`; `E_OPEN_FILE` when the shell reports an error |
| `settings:openKeys` | command | none | `{ opened: true, path }` after writing the `keys.env` template when the file is missing and opening it (Notepad by its fixed path in the real Windows app, `shell.openPath(path)` otherwise); `E_OPEN_FILE` when it cannot be created or opened |

The document text never crosses IPC. Main hands it to `RealtimeClient.start({ context })` and `setSessionContext()`; the server passes it to the engine's optional `onContextSet({ docs, name })` (see protocol.md, `session_context`). Auto-start runs once at boot through `startSession()`; `COPILOT_AUTOSTART=0` turns it off for scripted runs.

Answer model (`src/server/engines/answer-models.js`): three choices. `deepseek-flash-thinking` ("DeepSeek V4.1 Flash", the default) and `deepseek-flash` ("DeepSeek V4.1 Flash (fast)") both answer with model `deepseek-flash` (DeepSeek-V4.1-Flash; DeepSeek has no non-Flash V4.1) on `https://api.deepseek.com` with `DEEPSEEK_API_KEY`, which main reads from the Windows user environment or keys.env at launch (a key the launch environment already carries is replaced when the registry value differs: a terminal or Explorer opened before the key was changed hands down the old one for as long as it lives). The default sends `thinking: {type: "enabled"}`; the fast choice and every other request to the DeepSeek origin (screen analysis included) send `thinking: {type: "disabled"}`. Thinking adds about 1-7 s before the first visible token (measured 2026-10-15: median 2.5 s, against 0.7 s with it off), and it can use up a capped vision reply. `reasoning_effort` is never sent to DeepSeek. `cerebras-qwen-thinking` ("Qwen 27B thinking (Cerebras)") is the engine the environment configured, with `reasoning_effort: "high"`. That engine is the `CEREBRAS_API_KEY` preset (`qwen-3.8-27b`, `reasoning_effort: "high"`) unless `LLM_*` overrides it (`LLM_REASONING_EFFORT` sets the preset's effort). No Settings choice runs Qwen without thinking. Cerebras streams the reasoning in a separate `reasoning` field the answer stream never shows, and the first token still lands in about 0.3-1.3 s (measured 2026-10-15). It applies only when the configured engine is on the Cerebras origin. Otherwise, or without `CEREBRAS_API_KEY`, DeepSeek V4.1 Flash with thinking stands in when `DEEPSEEK_API_KEY` is set, else the configured engine when it is a real one. A DeepSeek choice without `DEEPSEEK_API_KEY` answers on the configured engine. With no usable engine at all the answer fails as `no_answer_model`; there are no demo answers. Every stand-in answer carries turn.done `fallback` (below), and the Settings note names the missing key (`deepseekAvailable` / `cerebrasAvailable`). The choice is read for every answer, so a change applies to the next answer of a live session; practice mode follows it too. Saved values from earlier builds migrate on load: `""` (Automatic) and any unknown value become the default, `deepseek-v4-pro` becomes `deepseek-flash` (it answered with thinking off), and `cerebras-qwen` (Qwen with reasoning off) becomes `cerebras-qwen-thinking`. `settings:set` accepts only the three listed ids. `ANSWER_MODEL` is the env spelling for a standalone server; the desktop app uses it only while the settings file is not loaded.

Refused answers (`src/server/engines/index.js`, `createSelectableAnswerer`): a chosen engine that refuses the request before its first token — 401 key, 402 out of credit, 403 paywalled model, 429 quota (a provider's `x-should-retry: false` is obeyed over the status class) — is replayed on the next rung of the stand-in ladder (below), and the session log records `engine.answer_failover` `{status, from, to, choice, thinking}`. A failure after the first token is not replayed here (the pipeline retries it, below), and a rung that refuses is paused like the chosen engine and the next rung is tried. `answerer.js` throws the status (`httpStatusError` in `provider-http.js`), and `pipeline.js` skips its retries when `error.retryable === false`, so a billing refusal costs one attempt instead of three. Measured 2026-10-20 with a Cerebras key whose org has no usable credit: HTTP 402 → 578-char card from DeepSeek in 7.1 s. The refused engine is then paused: for 30 s after a 429 and 5 min after a 401/402/403, every answer goes straight to the next rung (logged `engine.answer_failover` with `paused: true`) and the engine is not primed, and after the pause the chosen engine is tried again. The pause belongs to that engine and choice; picking another answer model applies at once.

Stand-in ladder (`createSelectableAnswerer`, `ladderFor`): every engine with a key, fastest first — Cerebras Qwen (`CEREBRAS_API_KEY`, `cerebrasApiKey` from `buildEngineConfig`; the configured options when they are on that origin), DeepSeek Flash with thinking (`DEEPSEEK_API_KEY`), then a configured `LLM_*` engine on any other origin — one rung per origin, never the chosen engine's own origin (the same provider would fail the same way). A rung's answerer is built when first used. The pipeline's last retry asks for a stand-in with `streamAnswer({standIn: true, retryOf})`: the answer goes to the first rung that is not paused (logged `engine.answer_stand_in`, reported as reason `stalled` or `failed`); nothing is paused for it, so the next answer goes to the chosen engine again. With no rung, the chosen engine answers again, with no note.

Stalled and failed answers (`answerer.js`, `pipeline.js`): a provider that sends no bytes for `stallMs` (`ANSWER_STALL_MS`, default `DEFAULT_STALL_MS` 8 s; any bytes count, including reasoning-only events and keep-alive comments, so a thinking model is not a stall) is dropped and the answer fails as `{code: "stalled", retryable: true}`, logged `answerer.stalled {after_ms, emitted}`; the watchdog also bounds the wait for the response headers and a non-streaming body. The pipeline retries every retryable failure (a stall, a 5xx, a dropped connection), before or after the first token, `MAX_RETRIES` (2) times for the same turn: the partial card is discarded (`error.retry` tells the client to start the card over; `AnswerBuffer.restart`), the whole answer is generated again, first on the chosen engine (`retryOf: "stalled"|"error"`), then on the stand-in (`standIn: true`); logged `turn.retry {reason, attempt, chars, stand_in}`. A refusal is never retried, and a rescue is never retried. A third failure closes the turn with `error` and the last attempt's text.

Fallback notes (`streamAnswer({onFallback})` → turn.done `fallback`): whenever an engine other than the chosen one answers (a missing key or a refusal, above), `createSelectableAnswerer` reports `{to, from, reason}` once per hop: short names (`engineShortName`: "DeepSeek Flash", "Qwen 27B", or the model id) and a reason code, `no_key` | `unavailable` | `out_of_credit` | `key_rejected` | `refused` | `rate_limited` | `stalled` | `failed`. `pipeline.js` keeps the report of the attempt that answered (a retry starts clean), copies only those three strings onto turn.done, the turn log and telemetry, and carries it to a rescue like `cut`. When the chosen engine answers, turn.done has no `fallback` field. The overlay paints it with `fallbackNoteText` (`src/desktop/renderer/answer-fallback.js`) as one muted line after the card, "Fallback: DeepSeek Flash · Qwen 27B out of credit", in the same `::after` note as "Answer cut short." (both on two lines). It is never part of the card text and never shows while the answer streams.

Rep context setting ("Use what I say in answers", Settings > Answer quality): `repContext` in `app-preferences.json`, on by default. A file from an earlier build, a non-boolean value and a damaged file all read as on; only `false` turns it off. Like the answer model, it is read for every answer (`createEngineFactory({ repContextResolver })`), so a change applies to the next answer of a live session. `REP_CONTEXT=0` is the env spelling for a standalone server; the desktop app uses it only while the settings file is not loaded.

Highlights setting ("Highlight key phrases", Settings > Answer quality; `src/shared/highlights.js`): `highlights` in `app-preferences.json`, on by default and read like `repContext` (only `false` turns it off; `createEngineFactory({ highlightsResolver })`, read for every answer; `HIGHLIGHTS=0` for a standalone server). On, the pipeline passes `highlights: true` to `streamAnswer`, the answer text carries `**` key phrases, and the answer card paints each pair as `<span class="hl">` (orange text, CSS token `--highlight`; `stream-paint.js` AnswerPainter, text nodes only, never HTML). Answer text reused as plain words (RECENT EXCHANGE history, the rep-context card comparison) has the markers stripped. Practice mode never asks for highlights. Off, prompts, filter output and frames are byte-identical to the build before the feature (test/highlights-*.test.js against values captured on 0926e36).

Answer cards setting ("Short answer cards", Settings > Answer quality; `src/shared/answer-cards.js`): `answerCards` in `app-preferences.json`, on by default and read like `highlights` (only `false` turns it off; `createEngineFactory({ answerCardsResolver })`, read for every answer; `ANSWER_CARDS=0` for a standalone server). On, the pipeline passes `cards: true` to `streamAnswer`, the answerer applies the card rules and line budget, continues a card line past `CARD_LIMITS.lineWords` on an indented line at a clause break and cuts it with "…" only after `CARD_LIMITS.lineSegments` lines (`card-line-cap.js`), lets one late TRADE-OFF line through past the line budget, and the answer card paints the VERDICT headline and quiet label tags (stream-paint.js AnswerPainter). When the delivered answer is not the whole answer, `streamAnswer`'s `onCut` reports why (`lines`, `code`, `line`, `length`), `turn.done` carries it as `cut`, and the card shows "Answer cut short.". With highlights on, each card line marks the phrase that carries its own main point (one per line, `CARD_HIGHLIGHT_RULE`), instead of three per answer. Practice mode passes `cards: true` to practice answers when on. Off, prompts, filter output and frames are byte-identical to the build before the feature.

Terms setting ("Explain terms", Settings > Answer quality; `src/server/engines/glossary.js`, `src/desktop/renderer/terms-view.js`): `glossary` in `app-preferences.json`, on by default and read like `answerCards` (only `false` turns it off; `createEngineFactory({ glossaryResolver })`, read once per turn; `GLOSSARY=0` for a standalone server). It needs `DEEPSEEK_API_KEY`; without it nothing is explained and the Settings note says "DEEPSEEK_API_KEY was not found, so terms are not explained." `known-terms.txt` beside `app-preferences.json` (one term per line, `#` comments) is created empty at boot and by "Known terms…" (`settings:openKnownTerms`), and read again for every request. Every answer window paints the `terms` frame in `#answer-terms` under `#answer-text` (sticky at the bottom of whichever box scrolls, hidden while empty): "TERM (Full Name): what it is and does", text nodes only, no tooltips. The block shows the terms of the turn on screen only: it empties on `turn.started` and Clear, and a frame for any other turn is ignored. It is painted only from a `terms` frame through the frame scheduler; `turn.token` painting never touches it. Practice mode has no Terms.

Provider keys from Windows (`src/desktop/user-env.js`): at launch, a real Electron app only (no `ELECTRON_RUN_AS_NODE`, no test double) reads `DEEPSEEK_API_KEY`, `CEREBRAS_API_KEY`, `GROQ_API_KEY` and `TYPESAFE_API_KEY` from `HKCU\Environment` with the pinned `reg.exe` and a secret-free environment, and the registry wins over `process.env`: a missing key is filled, and one whose value differs is replaced, because a terminal or Explorer opened before the key was changed keeps handing down the old value for as long as it lives. Both cases log names and fingerprints only (`[app] CEREBRAS_API_KEY: the launch environment had csk-old…1111, Windows has csk-new…2222; using Windows`). The names are a pinned list: nothing else is ever read (test/p5-clear-quit-settings.test.js).

Provider keys from keys.env (`src/desktop/keys-file.js`): right after the registry, `adoptProviderKeys` in `main.mjs` reads `keys.env` beside `app-preferences.json` and it wins over both the registry and the launch environment, so a rep can keep every key in one file and set no environment variables. The format is `NAME=value` lines (`#` comments, an optional `export `, one pair of quotes, a ` # comment` after an unquoted value, case-insensitive names, a later line wins, at most 64 KB). Only the four names above count; a line naming anything else, a line that is not `NAME=value` and a value with a space in it are skipped with a warning that gives the line number and never the line. An empty value is no key, which is how the template lists all four. A replaced key logs fingerprints only (`[app] CEREBRAS_API_KEY: the environment had csk-…, keys.env has csk-…; using keys.env`). Settings > Answer quality > API keys shows where each key came from (`keySources`, "DeepSeek: keys.env · Cerebras: environment · Groq: missing · TypeSafe: missing"), and "Edit keys…" (`settings:openKeys`) writes the template once (mode 0600, never over an existing file) and opens the file. The keys apply from the next launch. The file is never created at boot, never read by a test driver, and never copied between data folders (not in `DATA_FILES`).

Answer failures on screen (`src/desktop/renderer/answer-error.js`): `onAnswer` in `renderer/app.js` turns `error` into a 7 s toast and `error.retry` into a 2.6 s info toast, so a failed turn never closes silently with an empty card. `answerErrorText` maps no answer model ("No answer model is set up. Add a DeepSeek or Cerebras key in Settings > Edit keys…, then restart the app.") and 402 / 403 / 401 / 429 / network failures to one sentence naming the fix ("The answer model is out of credit. Check its billing, or pick another answer model in Settings."), keeps a generic sentence for an unknown failure, and returns `""` for `session_ended` / `session_not_found` (the realtime client already latched the session). The renderer keeps its own copy of the dead-session codes: it imports nothing from `src/shared`.

Data folder (`src/desktop/data-dir.js`): the real app pins `userData` with `app.setPath("userData", dir)` at module load, before `app.requestSingleInstanceLock()` (keyed on userData) and before `ready`. `dir` is `%APPDATA%\DeskNotes`, or `DESKNOTES_DATA_DIR` when that is an absolute path (read from `process.env` only; created if missing; the default is used if it cannot be created). Earlier builds used `%APPDATA%\Electron` (dev) and `%APPDATA%\mock-sales-copilot` (exe). `migrateLegacyData` copies each app data file (`DATA_FILES`: answer instructions, app and audio-device preferences, grounding document, known terms, panel bounds, practice material and debrief; never Chromium profile files) that the folder lacks from the source where it is newest, never overwrites, never changes the sources, and runs once per folder (marker `.migrated-from-legacy.json`, written even when nothing was copied, so a later Clear is not undone). A custom folder takes `%APPDATA%\DeskNotes` as its first source; once that folder has migrated it is the only source. Refused launches and test drivers (`__COPILOT_SHELL_LIBRARY__`, `createMainShell({ userDataDir })`) skip all of this.

Answer instructions (`src/server/engines/answer-instructions.js`): `answer-instructions.txt` beside `app-preferences.json`. It is seeded on first run with the built-in prompts. An existing file is never overwritten, except one that is byte-identical to an earlier seed (`LEGACY_ANSWER_INSTRUCTIONS`): that file was never edited, so it is replaced by the current seed (`ensureAnswerInstructionsFile` returns `updated: true`). It has four numbered sections: 1. Tone and writing style, 2. Role, 3. Answers to produce for detected questions, 4. Answers to produce for screenshots. Answers use Role + Tone + section 3. The answer that a screen capture starts appends section 4 (spoken mode). The screen interpretation prompt is fixed and does not read the file. The file is read for every provider call. An unreadable file falls back to the built-in prompt, and an empty section to its default. `ANSWER_INSTRUCTIONS_PATH` sets the path for a standalone server.

Vision routing (`config.js`): `visionOptions` inherits only the LLM settings the operator set (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` in the environment). The Cerebras vendor preset configures text answers only (Qwen takes no images), so with `CEREBRAS_API_KEY` and `DEEPSEEK_API_KEY` screenshots go to the DeepSeek vision preset.

## Judge (optional) — `src/server/engines/judge.js`

TypeSafe Jev (System One) yes/no judgments for the turn pipeline. On when
`TYPESAFE_API_KEY` is set (`JEV_JUDGMENTS` defaults to `gate,rescue`;
`JEV_JUDGMENTS=off` turns it off). The desktop app reads the key from the
Windows user environment at launch when the process lacks it (`user-env.js`), and replaces one whose inherited value differs.

| Env | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | — | Required. Never falls back to `LLM_API_KEY`. |
| `JEV_JUDGMENTS` | off | `gate`, `rescue`, or `gate,rescue`. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | https, or loopback http. |
| `TYPESAFE_MODEL` | `jev-latest` | Any Jev model id/alias. |
| `JEV_TIMEOUT_MS` | 500 | Clamped to 50–5000. |

`createJudge(options) -> { enabled, features: {gate, rescue}, evaluate({utterance, answeredFor?, recent?, askComplete?}), close() }`.
`evaluate` never rejects; it resolves `{ isQuestion, answersSame, isComplete, latencyMs, error }`
with probabilities in 0..1 or `null` (disabled, timeout, HTTP error, or not
asked). All questions go in one `POST /v1/systemone` request: `is_question`
always, `answers_same` with `answeredFor`, `is_complete` ("has the prospect
finished their thought?") with `askComplete`. The pipeline uses a verdict to
cancel a small-talk turn (gate), to reuse an answer a reworded final
transcript still matches (rescue), and to decide when a held answer is shown
(reveal, below); it never waits on one to start work.

Held answers (`createPipelineEngine({ holdSpeculation = true })`): a turn
started while the prospect is still talking (`partial_trigger`,
`partial_extend`, `partial_diverge`, `pause_hint`) generates as before but
sends nothing to the client. It is shown, buffered tokens coalesced into one
`turn.token`, at the first of: a `turn_hint` `pause` (~0.7 s of silence) for
which Jev returns `is_question >= 0.5` and `is_complete >= 0.5` (without a
judge, the pause alone); or the final transcript committing it. A held turn
that is superseded, gated out or never committed leaves no frames at all.
Committed, manual and screen turns are never held. Measured 2026-10-15 on 18
labelled utterances: `is_complete` 17/18 (the miss was "right", which is not
a question either), p50 81 ms.

Rep context (`src/server/engines/conversation-context.js`; `createPipelineEngine({ repContext = true })`,
a boolean or a function read per transcript and per answer; a throwing function reads as off). The rep's
own mic speech reaches answers that START LATER; a card already on screen keeps the context its
generation started with. `onTranscript` records every final of both speakers in a ring of 8
`{who, text, at}` lines (`at` from the injected `now()`), after the speaker gate has run, so the rep
still never opens, commits or supersedes a turn; rep partials are ignored. A rep final is dropped
before it is stored when it is: an echo (60% or more of its content words, lowercased with punctuation
and a small stopword list removed, are in prospect finals or the latest prospect partial within 3 s
either side; prospect speech that lands after the rep line removes it then, and a prospect final
does so before the turn it starts reads the ring), filler (nothing left once filler such as "yeah",
"mm-hmm", "let me think", "good question" and stopwords are removed, or, under 4 words, under 2 content
words left), or card reading (70% or more of its content words are in the latest answer shown to the
client). Echo and card reading never drop a line with a number (a digit run or a number word) or a
correction word ("not", "instead", "actually", "don't" and a few more) that the prospect speech or the
card lacks. Drops are logged as
`conversation.rep_dropped` {reason, chars}, never the text. `buildContext` renders the
`RECENT CONVERSATION` block (above), and when it does, `streamAnswer` gets `repContext: true` and the
answerer adds `REP_CONTEXT_RULE` after the screen rules, in every prompt mode. A prospect final is
recorded after the turn it starts, so that turn's block never repeats its own question. Session start
and `onScreenClear` (Clear) empty the ring. Off (`repContext: false`, `REP_CONTEXT=0`, or the Settings
checkbox), nothing is recorded and the ring is emptied at the next transcript; prompts, contexts and
frames are byte-identical to the build before the feature (test/rep-context-pipeline.test.js replays a
scripted call against values captured on 8ec5b18). No new wire frames and no Jev calls.

## Terms — `src/server/engines/glossary.js`

Design: `docs/superpowers/specs/2026-10-18-terms-design.md`. Explains up to three terms of each finished answer card.

`createGlossary({ apiKey, baseUrl = "https://api.deepseek.com", model = "deepseek-flash", timeoutMs = 5000, knownTermsPath, fetchImpl, readFileImpl, log, now }) -> { enabled, explain({ text, signal }), close() }`.
Without `apiKey`, or on a refused URL, it is `DISABLED_GLOSSARY` (`enabled: false`). `explain` never rejects; it resolves
`{ terms: [{term, full_name?, what}], added, latencyMs, error }` with `error` one code (`timeout`, `aborted`, `closed`,
`http_<status>`, `bad_json`, `too_large`, `request_failed`, `empty`, `disabled`) and `terms` empty on any error. One
`POST /chat/completions` per call (same transport as the judge: `provider-http.js`), thinking disabled
(`providerRequestExtras`), `response_format: json_object`, the fixed `GLOSSARY_PROMPT`, then a user message with the terms
to skip (known and already explained terms that the card mentions) and the card text without `**` markers.

Validation fails closed (`validateEntries`): the term must appear in the card on a word boundary (case-sensitive for an
all-caps acronym); known terms (`known-terms.txt`, read again for every call) and terms already explained this session are
dropped, case-insensitively; a `full_name` is kept only when it spells the acronym by the standard acronym rule
(`acronymMatches`): the full name splits into words on whitespace and "/" only (a hyphenated word is one word), every word
that is not a minor word ("of", "and", "the"…) gives its first letter as the next acronym letter (a minor word may be skipped
or give its initial), and after its initial a word may give further letters from anywhere later inside it, in order
("Hypertext Transfer Protocol" for HTTP, "Time-Series Database" for TSDB, "Open Authorization" for OAuth). A plural "s" is
ignored, a digit after a letter repeats it (S3, EC2, W3C; a 2 may read "to", P2P), a full name that only repeats the term is
refused, and an acronym over 10 letters or a full name over 12 words or 120 characters is refused unchecked; the search is
memoized on (letter, word, position in the word); `what` must be plain text, at most 25 words (26-35 keep
the whole sentences that fit, never cut mid-sentence; over 35 drops the entry). Each validated entry is cached for the session
(one glossary per session, `createEngineFactory`). `composeTerms`: the new entries, then cached entries whose term is in the
card, each in order of first appearance in the card, at most 3 (`GLOSSARY_LIMITS`).

Pipeline (`createPipelineEngine({ glossary = true, glossaryEngine })`): once the client has a committed turn's `turn.done`
(a commit of a finished prefetch and a rescue count; superseded, cancelled, held, shadow and failed turns never do), the
switch is read once and the request starts a macrotask later on its own promise, so a final queued behind the card starts
first, and only if the client still shows that card. An in-flight request is aborted when the client's card changes: when
a newer `turn.started` is actually sent (`sendFrame`: an unheld turn at its start, a held turn at its reveal, a rescue),
and at session start and session end (which also calls `close()`); a held turn that is never shown aborts nothing. One
`glossary.request` log and telemetry entry per request `{turnId, latencyMs, entries, added, error}` (`error: "aborted"`
when the client's card changed, `"not_shown"` when the card was cleared from the client, `"engine_error"` when the engine
threw). A non-empty block for the card on screen is sent as `terms` `{turn_id, terms}` (protocol.md); nothing on
the question-to-first-token path awaits, reads or locks anything the glossary uses (test/terms-latency.test.js).

## Session telemetry recorder — `src/server/telemetry/session-recorder.js`

Buffered JSONL session logs for support and latency forensics. Off by default
(logs hold call transcripts). `SESSION_TELEMETRY=1`, `true`, or `on` turns it on. A disabled recorder touches no filesystem at
all. The desktop app writes telemetry to `%APPDATA%\DeskNotes\logs\telemetry` (or `DESKNOTES_DATA_DIR`),
while standalone servers default to `<cwd>/logs/telemetry`. The server wires one recorder per session
through `createEngineFactory`; the pipeline receives it as the `telemetry` option.

| Env | Default | Meaning |
|---|---|---|
| `SESSION_TELEMETRY` | off | `1`, `true`, or `on` enables recording; anything else (unset, empty, `0`) is off. |
| `SESSION_TELEMETRY_DIR` | `<cwd>/logs/telemetry` (standalone) or `<userData>/logs/telemetry` (desktop) | Directory for the JSONL files. |
| `SESSION_TELEMETRY_KEEP_DAYS` | 7 | Positive integer. `*.jsonl` older than this is deleted at construction. |

`recorderOptionsFromEnv(env, { dir: defaultDir } = {}) -> { enabled, dir, keepDays }`.
`createSessionRecorder({ enabled = false, dir, keepDays, fs, now, log }) -> { record, flush, close }`.

- `record(event)` never blocks the caller: the event is stamped and buffered in
  memory, and batches are written by an unref'd 250 ms timer, on `flush()`, or on
  `close()`. Each line is `{ ...event, sessionId, ts, monoMs }`; `ts` (ISO) and
  `monoMs` (ms since construction) are always stamped by the recorder. The
  buffer holds at most 20,000 events: older events are dropped and reported as
  `{ type: "telemetry.dropped", count }` before the next batch.
- The file is `<dir>/<startedAt with ":" -> "-">-<sessionId ?? "nosession">.jsonl`,
  named at the first `record()`; its first line is
  `{ type: "telemetry.meta", version: 1, sessionId, startedAt, keepDays }`.
- A file stops at 32 MiB: the flush that would cross the cap writes a final
  `{ type: "telemetry.truncated", ts }` line and the file takes no more events;
  later records count as dropped.
- No failure reaches the pipeline. An fs or serialization failure logs one
  `{ type: "telemetry.error", message }` entry through the injected `log`, then
  the recorder permanently no-ops. `flush()` and `close()` are idempotent and
  safe on a disabled recorder.
- Any field whose key matches `/key|token|secret|password|auth/i` is written as
  `"[redacted]"`, at any depth. Callers must not put credentials in events.

## Practice / rehearsal (additive) — `src/desktop/practice/`, `src/desktop/practice-debrief.js`

Design: `docs/superpowers/specs/2026-10-15-practice-mode-design.md`. Practice
answering runs only between `practice:start` and `practice:end`, and practice
events are delivered only to the practice window.

### IPC

| Channel | Kind | Payload | Value |
|---|---|---|---|
| `practice:get` | query | none | `{ material, materialReadError, session: {active, startedAt, questions, skipped} \| null, debrief: {savedAt, title, text, stats} \| null, debriefReadError }` |
| `practice:setMaterial` | command | `{ problemStatement: string }` | `{ material }`; failures `E_PRACTICE_MATERIAL_EMPTY`, `E_PRACTICE_MATERIAL_TOO_LARGE`, `E_PRACTICE_MATERIAL_NOT_TEXT`, `E_PRACTICE_SAVE` |
| `practice:start` | command | none | `{ startedAt }`; failures `E_PRACTICE_NO_MATERIAL`, `E_PRACTICE_ACTIVE`, or the `session:start` failure when capture cannot start |
| `practice:end` | command | none | `{ debrief: {savedAt, title, text, stats} }` (+ `saveError` when the write failed); failure `E_PRACTICE_NOT_ACTIVE` |
| `practice:open` | command | none | `{ opened: true }` (idempotent: brings the existing window forward) |
| `practice:event` | broadcast name, targeted | `PracticeEvent` \| `{ type: "ended", debrief, saveError? }` | sent only through `state.windows.practice.webContents.send` (`sendToPractice`), never `gateway.broadcast` |

The channels are in both `ipc-gateway.js` and the inlined tables of
`preload.cjs` (`test/sec-preload-sandbox.test.js` fails on drift).
`practice:start` calls `startSession({})` when no session is active, so
practice works from a cold app. Sender trust (`web-hardening.js`
`guardIpcHandler({ trustedPages })`): `practice:get|setMaterial|start|end`
accept index.html and practice.html; every other channel, `practice:open`
included, accepts index.html only, so the practice page never reaches
session or shell commands.

### Practice window

A normal window titled `DeskNotes — Practice`: framed, resizable, in
the taskbar, never always-on-top, never click-through. It is pinned to
`practice.html` (`hardenWebContents`), ships the same CSP as `index.html`, and
is brought forward with `restore()` + `focus()`. Closing it while a session is
active ends the session and saves the debrief.

### Modules

```js
// practice/segmenter.js — local heuristic, no model call
export const QUESTION_AT = 0.5, BORDERLINE_AT = 0.2, MAX_RECENT = 3;
export function fallbackQuestion(text) // -> { band: "question"|"small-talk", reason }
export function createQuestionSegmenter({ ask }) // -> { consider({text}) -> Promise<SegmentDecision> }
//   `ask` is accepted for contract compatibility and never called. consider
//   never rejects. SegmentDecision = { band, p: null, source: "fallback", reason }
//   reason: "ends with a question mark" | `opens with "<opener>"` |
//   "no question signal" | "empty utterance" (printed verbatim in the debrief).

// practice/session.js
export function buildPracticeContext({ problemStatement, docsName, docsText }) // -> string
export function createPracticeSession({ material, segmenter, streamAnswer, onEvent, now })
//   -> { start(), onUtterance(u), end() -> PracticeSessionRecord|null, isActive(), record() }
//   Only final, non-empty, non-"agent", non-duplicate utterances count. One
//   streamAnswer({ question, context, intent: "practice", mode: "technical",
//   signal }) per question, concurrent; end() aborts them (status "cut") and no
//   event follows end() (cut answers get no answer-done).
//   PracticeEvent: question | answer-start | answer-delta | answer-done |
//   answer-failed | skipped (typedefs in session.js).

// practice/material.js
export const PRACTICE_MATERIAL_FILENAME = "practice-material.json", PRACTICE_MATERIAL_VERSION = 1;
export const MAX_PROBLEM_STATEMENT_CHARS = 8_000;
export function validateProblemStatement(value) // -> trimmed string; throws PracticeMaterialError(.code)
export function createPracticeMaterialStore({ userDataDir, fs, now })
//   -> { load() -> {material|null, readError}, save({problemStatement}) -> material, clear() }

// practice/debrief.js — pure
export function firstSentence(text)
export function buildDebrief(record, { now }) // -> PracticeDebrief
export function formatDebrief(debrief) // -> the readable document text

// practice-debrief.js
export const PRACTICE_DEBRIEF_FILENAME = "practice-debrief.json", PRACTICE_DEBRIEF_VERSION = 1;
export const MAX_DEBRIEF_BYTES = 512 * 1024;
export function createPracticeDebriefStore({ userDataDir, fs, now })
//   -> { save(debrief) -> {savedAt}, load() -> {debrief|null, readError}, clear() }
//   The envelope stores the record plus text: formatDebrief(debrief); the
//   window shows debrief.text verbatim.
```

All stores follow `grounding-document.js`: absolute main-owned `userDataDir`,
fixed file name, `atomicReplace`, injected `fs`, size cap before write and on
load, corrupt file -> `null` + `readError`; the renderer never supplies a path.

### Judge and answer engine

`judge.js` is unchanged: there is no `segment` feature. Question detection
is the local heuristic above by owner decision (no judge on the transcript
path), so practice adds no network call beyond the answer stream. The
`mode: "technical"` argument on `streamAnswer` is the one cross-project
dependency, owned by the answer-quality project (`createAnswerer` honours a
per-call `mode`); without it the answerer ignores the field and uses the
spoken prompt.
