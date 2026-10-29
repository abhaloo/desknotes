# Roadmap

Work planned for DeskNotes, roughly in order. Estimates are rough.

## Reliability

- **Audio calls have deadlines (3 h).** Starting a device or listing devices
  times out instead of waiting forever, so End never hangs.
- **End during Start (3 h).** Pressing End while a session is still
  connecting must not leave capture running for a session nobody sees.
- **Screen analysis on two monitors (2 h).** On Windows, Electron can return
  an empty display id; fall back to the display index so the right screen is
  captured.

## Features

- **Prompt set picker (4 h).** Choose the prompt set in Settings and open the
  prompt folder from there, instead of setting `PROMPT_SET`.
- **Streaming speech to text (10 h).** Add a streaming provider, so a
  transcript no longer waits for a whole speech segment to upload.
- **Customer profiles from a multi-account CRM export (4 h).** Import one
  CSV of many accounts and pick the account's rows by a column match, instead
  of exporting one file per customer. (Single-account profiles shipped: see
  Settings > Customer.)
- **Feedback note on a session recap (6 h).** A button in the recap window
  that asks the answer model for a short note on the call, from the saved
  transcript, and stores it with the recap. Never automatic.
- **Recap checkpoints (3 h).** Write the recap in progress every 30 s, so a
  crash mid-call loses at most half a minute instead of the whole session.

## Privacy

- **Session log switch in Settings (3 h).** Turn transcript logs on or off
  without an environment variable.
- **Delete my data (2 h).** One action that removes logs, documents,
  practice material, session recaps and their search index
  (`sessions-index`) from the data folder.
- **Audio capture off on first launch (1 h).** A new install waits for you to
  turn capture on.

## Code health

- **Smaller main process (10 h).** Split `src/desktop/main.mjs` along its
  sections (windows, sessions, audio, screen, settings).
- **Smaller pipeline (8 h).** Split the turn pipeline into question
  matching, context building and turn lifecycle modules.
- **Tests for the answer on screen (6 h).** Run the renderer's token-to-card
  path in tests, and cover the provider retry and failure paths.

## Release

- **Installer and signing guide (3 h).** Document a signed NSIS build and
  publish releases on GitHub.
