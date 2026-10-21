# DeskNotes — a sales copilot for live calls

On your calls, DeskNotes listens to the prospect and shows short answer
cards for the questions they ask: pricing, objections, integrations,
security, next steps.

DeskNotes is a Windows desktop app. It listens to your call, turns speech
into text, and streams a short answer card into a small overlay. It starts
the answer from the partial transcript, so the first words often appear
before the other person finishes their sentence.

DeskNotes is an engineering project, not a finished product. Read
[Responsible use](#responsible-use) before you use it on a real call.

**Who it's for:** sales reps and solutions engineers on video or phone calls
who want the answer to the prospect's question on screen while they talk.

**Built with:** Electron (desktop shell and overlay), JavaScript on Node and
Bun (embedded realtime server and tests), a C++ N-API addon for Windows audio
capture (WASAPI), a local Silero VAD model (ONNX Runtime), and hosted APIs for
speech to text (Groq Whisper) and answers (DeepSeek or Cerebras).

**What's next:** see [ROADMAP.md](ROADMAP.md).

## What it does

- **Hears both sides of the call.** It captures your microphone and your
  speakers through Windows audio (WASAPI).
- **Answers early.** It starts an answer from the partial transcript and
  keeps it when the final transcript agrees.
- **Keeps answers short.** Each card opens with a one-line verdict and a few
  short bullets you can read at a glance.
- **Explains jargon.** An optional Terms strip under the card explains up
  to three technical terms from the answer.
- **Reads your screen when you ask.** Press `Ctrl+Shift+M` to analyze what
  is on your screen.
- **Uses your own notes.** Add a reference document and your own answer
  instructions, and answers draw on them.
- **Edits like text.** Every prompt is a file in `prompts/sales/`; change one
  and the next answer uses it.
- **Lets you rehearse.** In practice mode, DeskNotes answers each question
  after it is asked, then shows a debrief of what was covered and what was
  missed.

## How it stays fast

Every part of the loop from speech to answer is built to save time:

1. **Speech detection on your PC.** A local Silero VAD model sends only
   speech to the transcription service, and keeps 384 ms of audio before
   each onset so first words are not cut.
2. **Answers start from partial transcripts.** A new answer starts when the
   partial transcript looks like a question. It restarts only when the final
   transcript adds real content.
3. **A fast judge for complete questions.** An optional judge model decides
   in about 70 ms whether the speaker has finished.
4. **Tokens stream straight to the card.** The card shows each word as it
   arrives.
5. **Warm connections.** DeskNotes reuses HTTP connections. With Cerebras,
   it also warms the prompt cache when a session starts or your document
   changes.

The wire protocol is in [docs/protocol.md](docs/protocol.md).

## Requirements

- Windows 10 or 11 (64-bit)
- [Node.js](https://nodejs.org) 20 or later
- [Bun](https://bun.sh) 1.1 or later, for the tests, the demo and the
  standalone server
- Visual Studio Build Tools with the **Desktop development with C++**
  workload, and Python 3, to build the audio capture addon
- API keys for speech to text and answers (see [API keys](#api-keys))

## Try the demo (no keys needed)

```powershell
git clone https://github.com/abhaloo/desknotes.git
cd desknotes
npm install
bun scripts/demo.mjs
```

The demo runs the whole loop with mock engines and prints every step as it
happens: partial transcripts, a new answer, streamed tokens and a screen
analysis.

## Run the app

1. Install the packages:

   ```powershell
   npm install
   ```

   Electron 42 and later do not download their binary during `npm install`.
   Download it once:

   ```powershell
   node node_modules/electron/install.js
   ```

2. Build the audio capture addon:

   ```powershell
   npm run build:native-audio
   ```

3. Add your API keys (see [API keys](#api-keys)).

4. Start DeskNotes:

   ```powershell
   npm run dev
   ```

5. In the control window, open **Settings**. Choose your microphone and
   playback device, then turn on **Audio capture**.

Set your call app to play through the playback device you chose, so
DeskNotes hears the other side of the call.

## API keys

The easiest way is the keys file. Open **Settings**, go to **API keys** and
click **Edit keys…**. DeskNotes opens `keys.env` in Notepad. Paste each key
after its `=` sign, save the file, then restart DeskNotes:

```
GROQ_API_KEY=your-key
DEEPSEEK_API_KEY=your-key
```

The **API keys** line in Settings then shows where each key came from. The
file lives in the data folder (`%APPDATA%\DeskNotes`) and is plain text, so
keep it out of shared and synced folders.

Environment variables also work. Save each key as a Windows user variable:

```powershell
setx GROQ_API_KEY "your-key"
```

You don't need to restart your terminal: DeskNotes also reads user variables
that you saved after the terminal opened. A key in `keys.env` wins over the
same environment variable. [.env.example](.env.example) lists every variable
with a short note; never commit real values.

| Variable | What it powers | Needed |
|---|---|---|
| `GROQ_API_KEY` | Speech to text (Whisper large v3 turbo) | Yes, for live transcripts |
| `DEEPSEEK_API_KEY` | The default answer model, screen analysis and Terms | Yes, unless you set `CEREBRAS_API_KEY` |
| `CEREBRAS_API_KEY` | Qwen on Cerebras, the fastest answer model | Optional |
| `TYPESAFE_API_KEY` | The judge that decides when a question is complete | Optional |

To choose the answer model, open **Settings** in the control window.

**Other providers.** Any OpenAI-compatible endpoint works:

- Answers: set `ANSWER_PROVIDER=openai-compatible`, `LLM_BASE_URL`,
  `LLM_API_KEY` and `LLM_MODEL`.
- Speech to text: set `ASR_PROVIDER=openai-compatible`, `ASR_BASE_URL`,
  `ASR_API_KEY` and `ASR_MODEL`.

Provider URLs must use HTTPS, or HTTP to `localhost`.

## Edit the prompts

Every prompt DeskNotes sends is a text file in `prompts/<set>/`. Edit one
and save: the next answer uses it, with no restart. To keep your changes
out of the repo, copy the file to the same path under
`%APPDATA%\DeskNotes\prompts\<set>\` instead; that copy wins. An empty
copy falls back to the shipped file. `PROMPT_SET` chooses the set.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+A` | Answer now |
| `Ctrl+Shift+M` | Analyze the screen |
| `Ctrl+Shift+X` | Clear the answers |
| `Ctrl+Shift+H` | Show or hide the overlay |
| `Ctrl+Shift+Space` | Turn click-through on or off |
| `Ctrl+Q` | Quit (when a DeskNotes window has focus) |

## Build an .exe

```powershell
npm run dist:win              # portable exe in dist\
npm run dist:win:installer    # installer in dist\
```

If the build stops with a symbolic link error, turn on Windows
**Developer Mode** and run the build again. For other options, see
[docs/development.md](docs/development.md#packaging).

## Run the tests

```powershell
npm test                      # every test file, each in its own Bun process
npm test -- --jobs 4          # faster: four files at a time
npm run test:native-audio     # the audio addon (after build:native-audio)
```

## Your data

DeskNotes keeps your settings, documents and answer instructions in
`%APPDATA%\DeskNotes`. To use another folder, set `DESKNOTES_DATA_DIR` to an
absolute path. **Settings > Open settings folder** opens it.

Session logs include transcripts and answers. DeskNotes writes them to
`logs\telemetry` in that folder and deletes them after 7 days. Set
`SESSION_TELEMETRY=0` to turn them off, or `SESSION_TELEMETRY_KEEP_DAYS` to
keep them longer or shorter.

Audio goes only to your speech-to-text provider. Transcripts go to your
answer and judge providers. A screenshot leaves your PC only when you ask
for a screen analysis.

## Project layout

| Folder | What's inside |
|---|---|
| `src/desktop` | Electron shell, overlay and control windows |
| `src/server` | Embedded realtime server and engines: speech to text, judge, answers, Terms, screen analysis |
| `src/transport` | WebSocket client with reconnect and replay |
| `src/audio`, `src/vad` | Capture pipeline and voice activity detection |
| `native` | WASAPI audio capture addon (C++) |
| `test` | Unit and integration tests |
| `bench` | Latency and answer-quality benchmarks |
| `docs` | Wire protocol, module contracts, development notes |

## Responsible use

Many places regulate how you record and transcribe a call. Some require
every person on the call to know and agree. Your employer or your meeting
platform may have rules too. You are responsible for how you use DeskNotes.
See [DISCLAIMER.md](DISCLAIMER.md).

## License

MIT. See [LICENSE](LICENSE).
