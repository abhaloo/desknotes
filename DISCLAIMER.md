# Disclaimer

## Provenance

DeskNotes is an original implementation. All source code in this
repository was written from scratch for this project.

The *design* of the realtime architecture documented here was informed by an
engineering study of real-time assistant desktop applications in this product
category: how a low-latency speech -> guidance loop can be built so that
helpful context arrives during a live conversation rather than after it. No
source code, binaries, assets, model weights, or other material from any
third-party application were copied into this repository, and no proprietary
material is redistributed here. The Silero VAD model used here is the
MIT-licensed release obtained from its upstream open-source project.

Functional ideas, wire-format shapes, and behavioral conventions are not the
property of any vendor; every line of implementation, test, and documentation
in this repository is independently authored.

## Design review record

During development, the implementation was put through an adversarial design
review against a documented behavioral specification, in order to make this
project's behavior well-specified and robust. The review produced 27 findings
(internal IDs D-01..D-27): 24 confirmed behavioral divergences from the
specification, 1 internal defect, and 2 accepted deviations. All confirmed
divergences and the defect were remediated; the two accepted deviations were
documented as intentional. The findings covered:

- wire framing and session-resume semantics (hello/replay, per-stream
  sequence numbering, end-of-utterance signaling)
- connection robustness (jittered reconnect backoff, terminal close-code
  classes, auth retry grace, heartbeat half-open detection)
- voice-activity gating behavior (onset pre-roll, hangover, backlog
  saturation, fail-open rules, inference output validation)
- answer-turn lifecycle framing (gate verdict, turn start/token/done/
  superseded, reference echoing on first frames)
- vision analysis transport (signed upload minting, typed failure tags,
  enum-valued status fields, server-side dedup authority)
- desktop surface conventions (IPC channel naming, status payload shapes)

Conclusions from that review are reflected in the behavior of this codebase
and in `docs/protocol.md`. Executable behavioral specifications derived from
it live on in the test suite (notably `test/review-divergences.test.js` and
`test/review-pins.test.js`).

## Non-affiliation

DeskNotes is not affiliated with, endorsed by, or connected to any
vendor of sales-engagement, sales-assistant, or conversation-intelligence
software. Any trademarks referred to descriptively belong to their respective
owners.

## Intended use

This project is provided as is, for engineering study, demonstration and real
use on sales calls where every party has agreed to the recording. Using it on
real sales calls raises consent and recording obligations that vary by
jurisdiction — many require that every party to a call is informed and
consents to capture and transcription — as well as platform-governance rules
and employer policies on recording, transcription, and AI assistance. You are
responsible for obtaining any required consent and for how you use this
software.
