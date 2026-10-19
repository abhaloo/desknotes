# Development notes

Details for working on DeskNotes. Start with the [README](../README.md).

## Runtimes

Bun runs the server, the tests and the demo. The Electron shell runs the
shared, transport and desktop modules under Node, so those modules must work
in both runtimes.

```powershell
bun scripts/demo.mjs          # the whole realtime loop with mock engines
bun src/server/main.js        # standalone realtime server on ws://localhost:8787
npm run dev                   # the desktop app from this checkout
npm test                      # every test file, each in its own Bun process
bun scripts/run-tests.mjs test/terms-engine.test.js   # some files only
```

`npm install` does not download the Electron binary (Electron 42 and later).
Run `node node_modules/electron/install.js` once after it. `npm run dev`
stops with this command when the binary is missing.

To check answer quality against a real provider (uses your keys), run the
sales question set against the sample product sheet:

```powershell
bun bench/answer-quality.mjs --questions bench/fixtures/sales-questions.json --doc bench/fixtures/sales-product-sheet.md --worksheet answers.md
```

It scores each card for the facts it must state and for skim limits, and
`answers.md` holds every card for you to read.

`npm test` runs each file in its own process because Bun's `node:test`
layer cannot run these files together. It also removes provider keys from
the test environment, so no test can reach a paid API. Files run one at a
time by default, because some tests bound real-timer latencies in tens of
milliseconds; `npm test -- --jobs 4` is faster on an idle machine.

`npm run dev` (`scripts\dev.ps1`) launches the code that is checked out now.
It first closes a dev copy that is already running from the same checkout.
The packaged exe shares the app's single-instance lock, so the script stops
and asks you to quit the exe; pass `-CloseExe` to close it for you.

## Windows audio capture

The default capture backend on Windows is native WASAPI. The control window
has **Microphone** and **Playback device** selectors. Each source can use an
endpoint by name and id, or the default multimedia or communications role.
A saved endpoint that is unplugged stays in the list as unavailable. The
shell does not switch an explicit endpoint when the Windows default device
changes.

Microphone, playback and ASR each have their own status. ASR states are
`unconfigured`, `connecting`, `live`, `degraded` and `demo`. Native capture
uses live ASR and does not invent transcript words when ASR is unconfigured.
`CAPTURE_BACKEND=simulated` or `file` stays in demo mode unless
`COPILOT_MODE` is set. Echo cancellation is not available
(`supportsAec: false`), so use headphones if your speakers echo into the
microphone.

Build and qualification:

```powershell
npm run build:native-audio
npm run test:native-audio
npm run test:audio:live -- --case catalog
npm run test:audio:live -- --case qualification
```

`test:audio:live` does not start the microphone until you use the Start
control. Hardware checks that need two playback endpoints are skipped when
only one endpoint is present.

Packaging refuses a missing or stale `audio_capture.node`. The addon ships as
an extra resource at `resources\audio_capture.node`. The native build
generates `src/desktop/native-audio-manifest.json`, which is not committed.

## Packaging

```powershell
npm run dist:win                 # portable exe -> dist\
npm run dist:win:installer       # NSIS installer -> dist\
npx electron-builder --win dir   # unpacked folder -> dist\win-unpacked\
```

The packaged app is self-contained: the realtime server starts inside the
app process. Set `EMBEDDED_SERVER=0` to turn it off, or `REALTIME_URL` to use
another server. The Silero model ships in `resources\app.asar.unpacked`.

On Windows accounts without symbolic-link privilege, electron-builder logs
symbolic-link errors while it extracts its code-signing bundle.
electron-builder 26 treats the symbolic-link errors as warnings, so no extra step is needed.

## Data folder

Answer instructions (`answer-instructions.txt`), the reference document,
`known-terms.txt`, settings, device choices, panel positions and practice
material live in one folder that the dev run and the packaged exe share:

- default: `%APPDATA%\DeskNotes`
- custom: set the `DESKNOTES_DATA_DIR` user environment variable to an
  absolute path. DeskNotes creates the folder if it does not exist and
  ignores a relative path.

The launch log prints `[app] data folder: <path>`.

Earlier builds kept these files in `%APPDATA%\Electron` (dev run) or
`%APPDATA%\mock-sales-copilot` (exe). The first launch of a folder copies
each file it lacks from those folders; the newest copy of each file wins. It
never overwrites a file and never changes the old folders.
`.migrated-from-legacy.json` records what was copied, so a document you clear
later does not come back.

## Prompts

Every prompt DeskNotes sends is a text file in `prompts/<set>/`. Edit one
and save: the next answer uses it, with no restart. To keep your changes
out of the repo, copy the file to the same path under
`%APPDATA%\DeskNotes\prompts\<set>\` instead; that copy wins. An empty
copy falls back to the shipped file. `PROMPT_SET` chooses the set.

`prompts/sets.json` names the default set. A file may include another with
`{{rules/no-chatbot}}` (one level), and `{{max_chars}}`-style variables are
filled when the prompt is used. The standalone server
(`bun src/server/main.js`) reads overrides from `PROMPTS_DIR` when it is set.

The exported constants (`CARD_RULE` and the rest) hold the default set's
shipped text and never see overrides; requests read the active store, which
lives in memory, so no answer reads the disk for its prompts.

## Feature switches

Each Settings checkbox also has an environment spelling. `0`, `false` or
`off` turns the feature off; any other value keeps the default and is logged.

| Variable | Setting |
|---|---|
| `ANSWER_CARDS` | Short answer cards |
| `GLOSSARY` | Explain terms |
| `HIGHLIGHTS` | Highlight key phrases |
| `REP_CONTEXT` | Use what I say in answers |

`ANSWER_MODEL` sets the answer model choice by id (`deepseek-flash-thinking`,
`deepseek-flash` or `cerebras-qwen-thinking`; see
`src/server/engines/answer-models.js`).

## Test-only switches

An unpackaged run honors this; a packaged build ignores it and logs that
it did:

- `COPILOT_TEST_A11Y=1`: keep renderer accessibility on, so UI automation can
  read page text (`scripts\dev.ps1 -A11y` sets it).

## Docs

- [protocol.md](protocol.md): the realtime wire protocol (frames, recovery,
  VAD gating rules, upload contract)
- [module-contracts.md](module-contracts.md): module boundaries and
  interfaces
