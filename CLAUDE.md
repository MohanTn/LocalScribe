# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LocalScribe: a cross-platform Electron + React + TypeScript desktop app for local speech-to-text, using [whisper.cpp](https://github.com/ggerganov/whisper.cpp) as the transcription engine (no Python, no PyTorch). Drag-and-drop file transcription plus live dictation with global hotkeys and auto-paste. Everything runs locally except the optional "Polish" post-processing step (Anthropic/OpenAI/Ollama).

## Commands

```bash
npm run dev              # electron-vite dev (hot reload)
npm run typecheck        # tsc --noEmit for both main and web tsconfig projects
npm run build             # typecheck + electron-vite build
npm run start             # electron-vite preview (built app, no dev server)
npm run dist               # package for current platform -> release/
npm run dist:win|mac|linux # platform-specific packaging
```

There is no test suite/runner configured in this repo.

Before `npm run dev` will work, the whisper.cpp CLI must be built locally:

```bash
./scripts/setup-whisper.sh   # clones ggerganov/whisper.cpp into .whisper-cpp/, builds, copies binary to vendor/whisper/
```

`npm install` runs `electron-builder install-app-deps` via `postinstall`, which rebuilds native modules (`better-sqlite3`, optional `uiohook-napi`) against Electron's Node ABI — never run `npm rebuild` manually.

To point at a custom whisper.cpp build, set `WHISPER_CPP_BIN` rather than editing the binary lookup chain in `src/main/whisper.ts`.

## Architecture

### Process split (Electron)

- **`src/main/`** — Node context. Owns everything stateful: the audio byte buffer, whisper.cpp/ffmpeg child processes, SQLite history, settings file, global hotkeys, tray, and paste synthesis.
- **`src/preload/index.ts`** — the *only* bridge between renderer and main (`contextIsolation: true`, `nodeIntegration: false`). Exposes a single narrow, typed `window.api` object.
- **`src/renderer/`** — React UI. Owns the microphone (`getUserMedia` only exists here) and streams captured audio to main; it never touches Node or IPC directly, only `window.api`.
- **`src/shared/`** — `types.ts` and `api.ts` define the `LocalScribeApi` contract consumed by both tsconfig projects (`tsconfig.node.json` covers main+preload, `tsconfig.web.json` covers renderer). Keep this directory free of runtime/Node imports since it's compiled into both.

Every `ipcMain.handle` in `src/main/ipc.ts` is wrapped by a `handle()` helper that returns `{ ok, data | error }` envelopes instead of letting Electron's generic "Error invoking remote method" leak through; the preload's `invoke()` unwraps this back into a thrown `Error` with the real user-facing message. When adding a new IPC channel, register it with `handle()` (or `ipcMain.on` for fire-and-forget like `audio:chunk`), add the method to `LocalScribeApi` in `src/shared/api.ts`, and wire it up in `src/preload/index.ts`.

### Audio pipeline

1. Renderer (`src/renderer/src/lib/recorder.ts`) captures mic audio via an `AudioContext` created at 16 kHz (so Chromium resamples in native code) and an `AudioWorklet` that converts Float32 frames to Int16 PCM.
2. PCM chunks stream to main over `audio:chunk` (fire-and-forget IPC, ~10 msg/sec).
3. Main (`src/main/recording.ts`) accumulates chunks in a buffer (so a backgrounded/GC'd renderer never loses audio) and:
   - every 2.5 s, re-transcribes the last ≤20 s as a sliding window for **live partial captions** (best-effort; errors are swallowed — the final pass surfaces real failures),
   - on stop, transcribes the full buffer for the **final result**.
4. `src/main/whisper.ts` spawns the whisper.cpp CLI **per job** (not a resident process) — this keeps idle memory near zero (well under the ~150 MB tray budget) and isolates native crashes from the app. It parses whisper's `-oj -ojf` JSON output and collapses whisper's sub-word tokens into whole words with timestamps (`tokensToWords`) for word-level SRT export.
5. File transcription (`transcribe:file` in `ipc.ts`) instead normalizes the input through `src/main/ffmpeg.ts` (bundled `ffmpeg-static`, falls back to system `ffmpeg` on PATH) to 16 kHz mono PCM WAV before handing off to the same `transcribeWav`.

GPU acceleration is a **compile-time** choice in whisper.cpp (Metal on macOS by default, CUDA on Linux/Windows if `nvcc` was present when `setup-whisper.sh` ran). At runtime the app only chooses whether to pass `--no-gpu` (`detectGpu()` / `forceCpu` setting) — there's no dynamic layer-offload flag like llama.cpp.

whisper.cpp / ffmpeg stderr is translated to actionable messages in `friendlyWhisperError()` (`whisper.ts`) and inline in `ffmpeg.ts`'s `close` handler — raw stack traces should never reach the UI. Follow this pattern for new failure modes rather than surfacing raw child-process output.

### Hotkeys and push-to-talk

`src/main/hotkeys.ts` uses Electron's `globalShortcut` for the toggle hotkey (press-only is fine there). True push-to-talk needs a key-*release* event, which `globalShortcut` can't provide, so PTT uses the optional native `uiohook-napi` dependency (loaded via `require`, guarded by try/catch) when installed; if it's absent, PTT silently degrades to a second toggle shortcut. Don't assume `uiohook-napi` is present — always feature-detect via `loadUiohook()`.

### Status and tray

`src/main/status.ts` is a tiny observable (`idle | recording | processing | error`) that the tray icon (`src/main/tray.ts`), renderer status dot, and tray menu labels all subscribe to — it's the single source of truth for app-wide state; don't duplicate status tracking elsewhere.

### Persistence

- **Settings** (`src/main/settings.ts`): a plain JSON file in `userData`, cached in-memory, merged shallowly except `llm` which is merged one level deep. No schema/migration system.
- **History** (`src/main/history.ts`): SQLite via `better-sqlite3`. If the native module fails to load (ABI mismatch is the classic cause), it degrades to an in-memory array so transcription keeps working even though history won't persist — preserve this fallback behavior when touching this file.

### Binary/vendor layout

`vendor/whisper/` (dev, produced by `setup-whisper.sh`) and `.whisper-cpp/` (the cloned+built whisper.cpp source tree) are both gitignored. `src/main/whisper.ts`'s `candidates()` defines the binary lookup order: `WHISPER_CPP_BIN` env var → packaged `resources/bin/` → dev `vendor/whisper/` → `PATH`. `electron-builder.yml`'s `extraResources` copies `vendor/whisper` → `resources/bin` at package time, and `asarUnpack` covers native `.node` files and `ffmpeg-static` since neither can execute from inside the asar archive.

### Models

`src/main/models.ts` hardcodes the model catalog (tiny/tiny.en/base/base.en/small/medium/large-v3/large-v3-turbo) as GGML files hosted on Hugging Face (`ggerganov/whisper.cpp`). Downloads stream to a `.part` file and rename on completion so a partial download is never mistaken for a usable model; cancellation is treated as a non-error (`isAbort`).
