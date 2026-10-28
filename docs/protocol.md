# Realtime wire protocol (v1)

The wire contract for DeskNotes' realtime voice/vision engine.
Client and server both implement this document. Anything not pinned here is
free.

## Transport

- One WebSocket per session. Client connects to `wss://<host>/v3/realtime`
  (local server: `ws://localhost:<port>`).
- Two frame families:
  - **Binary** frames = audio uplink only.
  - **Text** frames = JSON control plane, always `{"v":1,"type":"..."}`.
- **Downlink frames carry a session-scoped top-level `seq`**. The client
  tracks the highest seq it has seen and echoes it as `last_seen_seq` on
  reconnect; the server then replays the frames above it verbatim. Uplink
  audio is NEVER replayed by the server — the client's own gap ring covers it.
  The capability frame sent on connect (before hello, so before any session
  exists) carries the reserved `seq: 0`; session-scoped downlink frames are
  numbered from 1. A client that only saw that frame therefore resumes with
  `last_seen_seq: 0` and gets the whole session replayed.
- **Origin gate.** Upgrades (and HTTP control-plane requests) that carry an
  `Origin` header are refused (403) unless the origin is explicitly
  allowlisted. Browsers always send Origin; native clients (`ws`, the desktop
  main process) do not, so a web page can never open the session socket.

## Binary audio frame (client -> server)

| offset | size | field                                    |
|--------|------|------------------------------------------|
| 0      | 1    | `stream_idx` (unsigned)                  |
| 1      | 4    | `seq` (uint32 LE, monotonic per stream)  |
| 5      | n    | PCM16LE payload                           |

Payload is gated 16 kHz mono PCM16. `seq` is consumed **only at the actual
wire send**: frames buffered in the client's gap ring take their seq when
they are flushed, so ring loss surfaces as telemetry, never as a hole in the
seq space. `seq` keeps increasing across reconnects of one session.

Stream indices and hello stream descriptors (topology "general"):

| idx | stream_id   | source | role         |
|-----|-------------|--------|--------------|
| 0   | rep   | mic    | rep  |
| 1   | prospect | system | prospect  |

## Client -> server JSON frames

- `hello` — first frame of every connection:
  `{v, type:"hello", jwt, session_id, streams:[{stream_id, source, role, encoding:"pcm16", sample_rate:16000}], capture_authorized:bool, last_seen_seq?:number}`
  The `last_seen_seq` key is **omitted entirely on a fresh session** —
  present only when the client has seen downlink frames it may have missed.
  A hello without it starts the session over server-side: the per-stream
  uplink seq accounting and the replay ring for that `session_id` reset, so a
  new session that restarts its uplink seq at 0 is never dropped as
  duplicates of an earlier one.
- `finalize` — `{v, type:"finalize", stream}` where `stream` is the **numeric
  stream_idx**. End-of-utterance control: the VAD gate stopped forwarding, so
  the server must close the pending ASR segment NOW instead of waiting for
  trailing silence. One-shot per pending segment.
- `answer_request` — `{v, type:"answer_request", utterance, intent, gate_seq?}`.
  User-action only (never auto-fired). The server honors it only when no turn
  is in flight; it never supersedes a live answer.
- `screen_analyse` — `{v, type:"screen_analyse", command_id, purpose, origin,
  image_hash, object_path, content_type}`. Socket is the authoritative channel
  (owner-pod routing); the reply arrives as `screen.result` joined by
  `command_id`. The command is never ring-buffered. The server runs the
  analysis BESIDE the connection's ordered message queue, never inside it:
  audio, `finalize` and every other command keep flowing while a vision call
  is in flight, and the result is sent whenever it lands. The server answers
  with `status:"failed", error:"analysis_timeout"` after its deadline (30 s)
  and with `status:"failed", solve:"busy", error:"busy"` beyond two in-flight
  analyses per connection. A pipeline engine also answers an `ok` result in
  the answer lane: right after the result it opens a normal committed turn
  (`turn.started` with `intent:"screen"`, then `turn.token` / `turn.done`)
  whose prompt carries the screen reading and the recent conversation. A
  failed, empty or timed-out analysis opens no turn.
- `set_capture_auth` — `{v, type:"set_capture_auth", authorized}`.
- `turn_hint` — `{v, type:"turn_hint", stream, state:"pause"|"resume"}`
  (additive; sent only when the server advertises `turn_hint`). The client
  VAD's speculation signal: `pause` = probable end of turn (22 quiet frames,
  ~0.7 s, while the segment is still open), `resume` = the speaker kept
  going before the hangover closed the segment. It never closes anything:
  `finalize` still marks the end of the segment, and only the final
  transcript commits a turn. Never buffered (a stale hint is worthless).
- `session_context` — `{v, type:"session_context", docs, name?}` (additive;
  sent only when the server advertises `session_context`). The rep's
  grounding document: `docs` is the whole text (at most 32,000 characters;
  `""` clears it) and `name` is the file name (cut to 200 characters). The
  server hands it to the engine's optional `onContextSet({docs, name})`. A
  frame before `hello`, or one whose `docs` is not a string or is too long,
  is logged and dropped. The server builds a fresh engine for every
  connection, so the client sends the document again after every
  `session.state` that advertises the capability. Never buffered. Logs carry
  its length only.
- `screen_clear` — `{v, type:"screen_clear"}` (additive; sent only when the
  server advertises `screen_clear`). Clear: the engine drops the screen
  reading it keeps for later answers (optional `onScreenClear()`), cancels a
  screen answer still streaming, and discards analyses still in flight. No
  payload; never buffered. A fresh connection starts with no screen context.
- `ping` — every PING_INTERVAL_MS (5 s); server replies `pong`. After each
  ping the client arms a HEARTBEAT_TIMEOUT_MS (5 s) deadline that ANY
  inbound frame clears — silence for a full deadline = half-open link.
  While audio is being sent and nothing has come back for
  LIVENESS_PROBE_IDLE_MS (1.5 s), the client pings at once with a
  LIVENESS_PROBE_DEADLINE_MS (2.5 s) deadline, so a link that dies mid-speech
  is detected in ~4 s. A deadline that fires late because the client's own
  loop stalled gets one 200 ms grace to read frames that already arrived.
  The server answers pings in order on the same queue that consumes audio,
  so a `pong` proves every frame sent before its ping was processed.

## Server -> client JSON frames

- `session.state` — `{v, type:"session.state", seq, data:{capabilities:[...]}}`
  (sent on connect, before hello, with `seq: 0`).
  Capability list: `screen_analyse`, `answer_request`, `replay`,
  `session_commands`, `turn_hint` (additive: the server accepts
  `turn_hint`), `session_context`, `screen_clear` (additive). Replaced
  wholesale per connection.
- `transcript` — `{v, type:"transcript", seq, data:{text, final:bool,
  role:"rep"|"prospect"|"unknown", source:"mic"|"system"|"agent",
  stream, seq, segment_id, role_corrected?:bool, dropped?:number}}`.
  `segment_id` is stable across a segment's interims and closes with its
  final; `role_corrected` marks a diarization revision; `dropped` counts
  coalesced interim updates.
- `transcription.state` — `{v, type:"transcription.state", seq,
  data:{state:"unconfigured"|"connecting"|"live"|"degraded"|"demo",
  stream_id, mode?, provider?, reason?}}`. Capture health and this
  state are separate. `unconfigured` means live ASR has no usable
  endpoint and the server emits no canned words. `connecting` is the
  wait before the first recognition. `live` follows a real recognition.
  `degraded` follows an ASR failure and clears only after a later
  success. `demo` is an explicit simulated or file demo. The desktop
  shell forwards this object on `audio:status:changed`.
- `gate.verdict` — `{v, type:"gate.verdict", seq, data:{gate_seq, verdict,
  turn_id}}`: the server-side gate announces its decision before a turn opens.
- `turn.started` / `turn.token` / `turn.done` / `turn.superseded` — the
  answer lifecycle. `turn.started` carries `gate_seq` on the FIRST frame so
  the answer renders under its question immediately: `{turn_id, question?,
  intent, gate_seq?}`; `turn.token` = `{turn_id, delta}`; `turn.done` =
  `{turn_id, text, gate_seq?, cut?, fallback?}`; `turn.superseded` = `{turn_id}` (an in-flight
  turn retired by a newer one). `cut` is why the text is not the whole answer
  (a card budget ran out). `fallback` = `{to, from?, reason?}` (additive) is
  present only when a model other than the chosen one wrote the answer: short
  model names and a reason code (`no_key`, `unavailable`, `out_of_credit`,
  `key_rejected`, `refused`, `rate_limited`, `stalled`, `failed`). The desktop overlay shows it as
  one muted line after the card ("Fallback: DeepSeek Flash · Qwen 27B out of
  credit"). With highlights on (the default;
  `HIGHLIGHTS=0` or the Settings checkbox "Highlight key phrases" turns them
  off) answer text may wrap key phrases in `**`: at most one pair per bullet
  and three per answer, each pair balanced and at most five words
  (`src/shared/highlights.js`). A `**` marker can be split across two
  `turn.token` deltas; a client that does not render highlights strips every
  `**`. Off, no `**` reaches the wire. With answer cards on (the default;
  `ANSWER_CARDS=0` or the Settings checkbox "Short answer cards" turns them
  off) answers follow card rules: a VERDICT line, then HOW / EXAMPLE /
  TRADE-OFF lines at the architecture level (or a detail card for specifics)
  within a strict line budget (`src/shared/answer-cards.js`). Finals and
  pause hints that are noise (such as silence or music artifacts like "you",
  "music", ".") start no turn and emit `turn.final_noise` in server telemetry.
- `terms` — `{v, type:"terms", seq, data:{turn_id, terms:[{term, full_name?, what}]}}`
  (additive). Up to three terms from the finished answer of `turn_id`, each
  with its full name when it is an acronym and what it is and does (at most
  25 words). Sent after that turn's `turn.done`, only for a committed turn the
  client saw, and only when there is at least one term. A client shows it for
  the turn on screen and ignores it for any other turn. Off with `GLOSSARY=0`
  or the Settings checkbox "Explain terms"; without a DeepSeek key no frame is
  ever sent.
- `say` — `{v, type:"say", seq, data:{text, say_id}}`. Server-generated
  prospect/coach speech. The desktop shell runs a delivery handshake:
  says stay pending until the renderer ACKs them (`coach:sayEchoed`), un-acked
  says are re-sent at every `coach:avatarReady` join boundary, and the last
  delivered `say_id` is a complete dedupe slate (says are replayed verbatim on
  server reconnects).
- `screen.result` — `{v, type:"screen.result", seq, data:{command_id,
  analysis_id, status:"ok"|"empty"|"failed", kind, title, summary, error,
  dedup:bool, solve}}`. `solve` is an ENUM: `solving|busy|duplicate|
  unsolvable|not_requested`. `summary` is the vision model's reading of the
  screen (at most 1,200 characters; visible question text and key code
  verbatim) and `title` a short label. Neither is an answer: the answer
  arrives as an ordinary turn (see `screen_analyse`).
  `dedup` is a SERVER verdict: the client has no dedup cache and never
  fabricates the flag. Transport-level failures carry a string tag on the
  client-side result's `failure` field: `upload` | `timeout` | `unreachable`.
- `error` — `{v, type:"error", seq, data:{code, ...}}`. Codes `session_ended`
  / `session_not_found` latch the session as terminal. `generation_failed`
  carries the provider's message and closes the turn with empty text: the
  desktop overlay turns it into one short toast naming the fix (no answer
  model, out of credit, rejected key, rate limit, no connection;
  `renderer/answer-error.js`), because an empty card alone reads as the app
  ignoring the call. Live mode has no demo answers: with no usable answer
  model every turn fails this way ("answerer: no answer model is set up").
- `error.retry` — `{v, type:"error.retry", seq, data:{turn_id, attempt}}`:
  a generation failure the server is retrying transparently (the overlay
  shows "The answer model faltered. Retrying now."). The card for `turn_id`
  starts over: the client drops the text it has shown for that turn, and the
  retry's `turn.token` frames carry the whole answer again from its first
  token (a provider that stalls or drops the connection may have painted
  half an answer). `attempt` is 2, then 3: the chosen engine once more, then
  the stand-in engine, whose `turn.done` carries `fallback` with reason
  `stalled` or `failed`. A refusal is not retried: a non-retryable status
  (401/402/403/429, or `x-should-retry: false`) is replayed on the failover
  engine instead, and only a real failure emits `error`.
- `session.ended` — terminal. Any later close is terminal for the client.
- `pong`.

## Screen capture upload contract

The socket command references an uploaded object; the bytes never ride the
control socket:

1. JSON mint: `POST v3/sessions/{id}/screen/uploads` with
   `{content_type, image_hash}` -> `{object_path, upload_url, exists?}`.
   Objects are content-addressed by `image_hash`; `exists: true` (additive)
   means the session already holds this exact image, so the client skips
   step 2. `upload_url` is always present for older clients. Requires
   `Authorization: Bearer <session jwt>` and a session that has said hello.
2. `PUT` the bytes to the signed `upload_url` (no bearer token: the
   one-shot, short-lived URL is the credential). The local server checks the
   body's sha256 against `image_hash`.
3. Send `screen_analyse` referencing `object_path`; the server resolves it
   only within the same session.

The local server (`src/server/ws-server.js`) serves the mint and the PUT on
the same port as the session socket (`http://` instead of `ws://`).

A mint/upload failure ABORTS the command with the `upload` failure tag and
sends nothing. The legacy (pre-capability) path is one multipart
`POST v3/sessions/{id}/screen`. Capture constants: maxWidth 1920, JPEG
quality 85.

## Client recovery semantics

- Reconnect backoff is **full jitter**: `random() * min(15000, 500 *
  2^attempt)` — a fleet must never retry in lockstep. The attempt counter
  resets 30 s after a stable open. Exception: the FIRST attempt after an
  unexpected drop (transport close, heartbeat deadline) is immediate, since
  every millisecond of backoff is speech piling up in the ring; closes that
  announce a server restart or overload (1001, 1012, 1013) keep full jitter
  on every attempt, because every client sees them at the same instant.
- `reconnect()` (user-initiated) makes one IMMEDIATE attempt first.
- First connect is the launch-readiness signal: resolves on OPEN, rejects on
  connect-level failure (no reconnect loop at launch).
- Close codes: 4001 = client `disconnect()` (session kept alive), 1000 =
  client `stop()`, 4400 = protocol violation, 4401 = auth (the client gets
  ONE refresh-then-retry grace via `session.getJwt()`), 4404 = session not
  found, 4409 = session ended. 4400/4404/4409 and a spent 4401 latch
  terminal until a fresh `start()`. An auth failure is signalled by the
  4401 close ALONE — the server sends no `session.ended` first (that frame
  latches the client terminal and would make the grace unreachable), and
  nothing of the session is replayed to an unauthenticated hello.
- Audio gap ring: while disconnected-but-wanting, payloads are held in a
  bounded ring (16000*2*12 = 384 000 bytes, drop-oldest) and flushed in
  order on reconnect. Commands are never ring-buffered.
- Half-open recovery: `send()` on a half-open link does not fail, so the
  client keeps every frame it sent (with its seq, bounded by the same 12 s)
  until a `pong` proves it was processed. After an UNEXPECTED drop it resends
  those frames with their ORIGINAL seq right after `hello`, before the ring;
  the server's per-session seq accounting drops the ones it already has as
  duplicates (`dup` log). A clean `disconnect()` resends nothing.
- Uplink backpressure: while the socket's `bufferedAmount` is above
  UPLINK_HIGH_WATER_BYTES (64 KiB, ~2 s of audio) new audio waits in the gap
  ring (seq still unassigned) and drains in order once it is back below
  UPLINK_LOW_WATER_BYTES (16 KiB). The reconnect flush is paced the same way,
  and a buffer that will not drain arms a liveness probe.

## VAD gating (client-side, before uplink)

Silero v5 via onnxruntime (single-threaded sessions; outputs strictly
validated — a NaN probability is an inference failure), one instance per
capture stream: 512 samples/frame @ 16 kHz (32 ms), LSTM state carry
[2,1,128] + 64-sample context carry (model input = 576 samples), thresholds
positive 0.5 / negative 0.35, redemption (hangover) 24 frames ~= 0.77 s,
pre-roll 384 ms flushed on speech onset.

Two robustness rules are load-bearing:

- **Backlog saturation forwards.** When the inference queue is full the gate
  stops gating: the held pre-roll is flushed and the frame is forwarded.
  Stranding speech behind a stalled detector is the worse error.
- **Fail-open on the FIRST inference failure.** A broken detector is not
  "one missed detection" — the `maxDroppedBeforeFailOpen` = 64 budget is for
  backlog DROPS only. Fail-open forwards everything and stops probing.

On speech end the gate sends `finalize` so ASR segments close immediately.

Additive latency rules (`VadLatencyConfig`; the tunables above are frozen):

- **End-of-turn hint.** 22 quiet frames (~0.7 s) into a pause inside a live
  segment the gate raises `onSpeechPause` (-> `turn_hint` `pause`), and
  `onSpeechResume` (-> `resume`) if speech returns first. The segment still
  closes only after the 24-frame redemption.
- **Windowed drop budget.** The 64-drop budget counts drops inside a sliding
  256-frame (~8.2 s) window of audio, so isolated main-loop bursts on a long
  call cannot add up to a permanent fail-open; a hung detector still fails
  open after 64 consecutive drops. A BACKLOG fail-open re-arms after 256
  frames once the detector is idle again; an inference failure stays latched.
- **Endpointing survives fail-open.** While failed open every frame is still
  forwarded, but end of speech is tracked on frame energy so `finalize` (and
  the hint) keep flowing after the normal 24-frame hangover.
- The pre-roll keeps every frame still awaiting inference plus 384 ms of
  classified context, and `flush()` forwards the trailing sub-frame remainder.

## Answer generation policy

The decision to answer is made by a server-side gate. `answer_request` fires
only on explicit user actions. The mock engine additionally implements a
documented accelerator: generation starts from converging partial transcripts
(>= 8 words, or last word stable >= 250 ms) and commits on the final
transcript. The stability rule runs on a timer (it fires 250 ms after the
last word arrived even when no newer partial follows) and needs >= 3 words.
A `turn_hint` `pause` also starts an uncommitted turn on the current
segment's latest partial when the lane is idle (and asks a batch ASR for a
fresh interim); a `resume` cancels that turn if it is still streaming. Prefix-related partials keep the current turn (regressed partials
must never discard completed work); only a materially different question
supersedes an in-flight turn. Turns started before the prospect is done are
held: generated, but not sent to the client until a `pause` hint that the
judge agrees ends a finished question (or, without a judge, the pause alone),
or the final transcript commits them (see module-contracts, Judge).

- **Committed answers answer the asked question.** The final commits an
  in-flight or finished prefetch only if it matches the text that generation
  was STARTED from. A question that grows by material wording (>= 3 new words
  and the generated-for text covering < 2/3 of it) restarts the prefetch at
  the partial, or the final starts a fresh committed turn — an answer to
  "how much" is never committed for "how much does the enterprise tier cost
  per seat". The coverage ratio keeps restarts logarithmic in question length.
- **Only the prospect asks.** Turns open and commit only on prospect speech
  (stream 1 / system audio by default; the server's `ANSWER_ROLES` setting,
  `answerRoles` in code, can widen it). Rep speech never starts, supersedes
  or queues a turn. With rep context on (the default; `REP_CONTEXT=0` or
  the Settings checkbox turns it off), the rep's finals still reach the
  context of LATER answers as `REP:` lines (module-contracts.md, "Rep
  context"); this adds no frame and changes no frame.

## Desktop shell notes

- `session:start` takes no endpoint or credential from the renderer: a
  payload with `url` or `jwt` is rejected (`E_INVALID_PAYLOAD`). The main
  process uses `REALTIME_URL`/`JWT`, or for the embedded server a random
  port and a per-launch secret that never leaves the main process. Every
  session gets a fresh random `session_id`.
- Command failures reach the renderer as ONE envelope (`{ok:false,error}`);
  the preload rejects with a coded error. No capture source starting is
  `E_CAPTURE_UNAVAILABLE`, never an empty success.
- IPC channel names follow the documented surface (`speech:*`, `coach:*`,
  `screen:*`, `shortcuts:*`, `window:*`, `config:get`), and the
  renderer consumes the raw wire relay `speech:realtime-frame:received`.
- `speech:vad:stats` carries the aggregate gate status
  (`{enabled, active, failedOpen, forwarded, gated, dropped}`), change-gated
  at 1 Hz.
