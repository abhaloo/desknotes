# Third-party assets

## silero_vad.onnx

Silero VAD v5 voice-activity-detection model.

- Source: https://github.com/snakers4/silero-vad (MIT License)
- Copyright (c) Silero Team
- Used unchanged by `src/vad/index.js` via `onnxruntime-node`.

The model is MIT-licensed, so redistribution with attribution is permitted.

## all-MiniLM-L6-v2/ (not in the repository)

Sentence-embedding model for Session history search, fetched by
`scripts/fetch-embedder.mjs` into this folder (`model.onnx`, `vocab.txt`,
`NOTICE.txt`). It is ignored by git; a packaged build includes it when it
is present (`files` / `asarUnpack` in package.json).

- Source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 (Apache License 2.0)
- int8 ONNX export: https://huggingface.co/Xenova/all-MiniLM-L6-v2 (Apache License 2.0)
- Used unchanged by `src/desktop/recap/embedder.js` via `onnxruntime-node`.
