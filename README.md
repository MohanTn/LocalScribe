# LocalScribe

Cross-platform desktop dictation and transcription, 100% local. Electron +
React + TypeScript in front, [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
underneath. Transcribe dropped audio/video files or dictate into any app with
global hotkeys and auto-paste.

## Features

- **Local model manager** — download Whisper models (tiny → large-v3 / turbo)
  from Hugging Face inside the app; switch via dropdown.
- **File transcription** — drag & drop any audio/video file (FFmpeg converts it),
  view/edit the transcript, export **.txt / .srt (word-level) / .vtt**.
- **Live dictation** — record from any microphone with incremental live captions
  (sliding-window transcription while you speak).
- **Global hotkeys** — customizable toggle-recording and push-to-talk shortcuts
  that work system-wide; finished text is **auto-pasted** into the app you were
  using.
- **System tray** — closes to the tray; Start Recording / Settings / Quit from
  the tray menu; colored status dot (idle / recording / processing / error).
- **History** — every transcription stored in a local SQLite database, searchable.
- **Polish (optional)** — send a transcript to Anthropic / OpenAI / a local
  Ollama endpoint to fix grammar and format into bullet points.
- **Hardware acceleration** — whisper.cpp built with Metal (macOS) or CUDA
  (Windows/Linux), automatic CPU fallback (`--no-gpu`).

## Prerequisites

You need:
1. **Node.js 20 or 22 LTS** (Electron 33 / better-sqlite3 11 require an ABI-compatible version).
2. **git** and **cmake ≥ 3.13**.
3. **A C/C++ toolchain** reachable by `node-gyp` — auto-used by the `postinstall` script to rebuild native modules against Electron's Node ABI.
4. *(GPU acceleration only, optional)* **NVIDIA CUDA Toolkit 12.x** with `nvcc` on `PATH`.

You do **not** need Python, PyTorch, or a system FFmpeg — `whisper.cpp` is standalone and `ffmpeg-static` ships inside the app.

### macOS

```bash
xcode-select --install          # Apple Clang + make
brew install cmake git
```

Metal is enabled automatically by the build script — no extra SDK install.

### Windows

1. Install **[Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)** with the **"Desktop development with C++"** workload (provides MSVC + Windows SDK).
2. Install **[cmake](https://cmake.org/download/)** (or `winget install Kitware.CMake`).
3. Install **[Git for Windows](https://git-scm.com/download/win)** — you need its **Git Bash** to run the setup script (see below).
4. *(Optional)* Install the **NVIDIA CUDA Toolkit 12.x** so `nvcc` is on `PATH` *before* you run the setup script.

> **Run the setup script in Git Bash, not PowerShell and not WSL.** Git Bash invokes your MSVC toolchain and produces a real `whisper-cli.exe`. WSL would produce a Linux ELF binary that the Windows app can't load.

### Linux

Debian/Ubuntu:

```bash
sudo apt install build-essential cmake git
# Only if you also want true push-to-talk:
sudo apt install libx11-dev libxtst-dev libxkbcommon-dev
```

Fedora:

```bash
sudo dnf install gcc-c++ make cmake git
```

*(Optional)* Install the **NVIDIA CUDA Toolkit** so `nvcc` is on `PATH` for GPU-accelerated whisper.cpp.

## Setup

All platforms: clone, install, then run.

```bash
git clone <this-repo> && cd local-scribe
npm install
```

`npm install` triggers the `postinstall` hook (`electron-builder install-app-deps`), which rebuilds `better-sqlite3` (and the optional `uiohook-napi`) against Electron's Node ABI. **You do not need to run `npm rebuild` yourself.**

### macOS

```bash
./scripts/setup-whisper.sh   # builds whisper.cpp with Metal
npm run dev
```

The first download/clone of whisper.cpp + a Release build may take a few minutes; subsequent rebuilds are incremental.

### Windows

Run from **Git Bash** (Start menu → "Git Bash"), *not* PowerShell and *not* WSL:

```bash
./scripts/setup-whisper.sh
npm run dev
```

If `nvcc` is on `PATH`, CUDA is enabled (-DGGML_CUDA=1). Otherwise it builds CPU-only. The app still passes `--no-gpu` at runtime to fall back to CPU when needed.

### Linux

```bash
./scripts/setup-whisper.sh   # auto-detects nvcc → CUDA, else CPU
npm run dev
```

## First run

1. Launch the app (`npm run dev`).
2. Open **Settings** from the sidebar.
3. **Download a model** (start with **`base`** or **`base.en`** for English-only).
4. Either **drop an audio/video file** on the Transcribe page, or **press the record button** to dictate.

Models are downloaded by the app directly from Hugging Face into your platform's `userData` directory — there is no manual `pip install` or Python step.

To use a custom `whisper-cli`, point `WHISPER_CPP_BIN` at it. The app's binary lookup chain is:

1. `WHISPER_CPP_BIN` environment variable
2. `resources/bin/whisper-cli(.exe)` (packaged app)
3. `vendor/whisper/whisper-cli(.exe)` (dev, produced by the setup script)
4. `whisper-cli(.exe)` on `PATH`

## Permissions & auto-paste

| Capability     | macOS                                                                                  | Windows                                                              | Linux                                          |
| -------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| Microphone     | Prompted automatically on first record                                                 | Settings → Privacy & security → Microphone → enable desktop apps     | ALSA / PulseAudio / PipeWire — no extra step   |
| Auto-paste     | Grant **Accessibility** *and* **Input Monitoring** in System Settings → Privacy & Security | Works out of the box (PowerShell `SendKeys`)                         | Install `xdotool` (X11) or `ydotool` (Wayland) |
| Global hotkeys | Native; works everywhere                                                               | Native                                                               | Native on X11; flaky on pure Wayland           |

If Accessibility is denied on macOS, paste falls back to a visible warning — re-grant it from System Settings.

On Linux, LocalScribe prefers `ydotool` on Wayland (no per-paste permission prompt) and `xdotool` on X11, but automatically falls back to whichever tool actually works if the preferred one fails. A common ydotool failure mode: the `ydotoold` daemon isn't running, or your user lacks access to `/dev/uinput` (add yourself to the `input` group, or run `ydotoold` as a service that has that access). If both tools fail or neither is installed, the transcript still lands on your clipboard and LocalScribe tells you to paste manually with Ctrl+V.

## Push-to-talk (optional native hook)

Electron's `globalShortcut` cannot observe key-*release*, which true hold-to-talk needs. Without this hook the PTT shortcut acts as a second toggle key.

```bash
# Linux only — X11 dev headers needed for uiohook-napi to compile:
sudo apt install libx11-dev libxtst-dev libxkbcommon-dev

npm install uiohook-napi
npm run postinstall      # rebuild native modules against Electron's Node ABI
```

Restart the app after installing. On macOS, you'll also be prompted for **Input Monitoring** permission the first time PTT fires.

## Packaging

Run `npm run typecheck` first if you've made changes, then:

```bash
npm run dist        # current platform
npm run dist:win    # .exe installer (NSIS) — install path is user-selectable
npm run dist:mac    # .dmg
npm run dist:linux  # .AppImage + .deb
```

Installers land in `release/`. The `vendor/whisper/whisper-cli(.exe)` you built with `setup-whisper.sh` is bundled automatically via `extraResources` — but **build on the target platform first** (you cannot ship a Linux build to Windows users, etc.).

### Per-platform gotchas

- **macOS**. No code-signing identity is configured. The first time a user opens the unsigned `.dmg`, Gatekeeper will report an "Unidentified Developer". Workaround: right-click → Open, or `xattr -cr "/Applications/LocalScribe.app"` on the installed copy. Add `mac.identity` to `electron-builder.yml` before distributing.
- **Linux AppImage**. Distros from Ubuntu 22.04+ / Debian 12 onward need `libfuse2` to mount AppImages: `sudo apt install libfuse2`.
- **Windows NSIS**. The installer asks where to install (`allowToChangeInstallationDirectory: true`) and installs Per-User or Per-Machine depending on the UAC elevation the user provides.

## Architecture notes

- **Process split** — the renderer owns the microphone (`getUserMedia`) and
  streams 16 kHz mono Int16 PCM to the main process; main owns the audio buffer,
  runs whisper.cpp, SQLite, hotkeys, tray, and paste synthesis. The preload is a
  narrow, context-isolated, typed bridge (`src/shared/api.ts` is the contract).
- **Per-job engine process** — whisper.cpp is spawned per transcription instead
  of being kept resident, so the idle (tray) footprint is just Electron —
  well under the 150 MB budget — and a native crash can't take the app down.
- **Live captions** — every 2.5 s the last ≤20 s of audio is re-transcribed for
  the partial display; the final pass on stop transcribes the full buffer.
- **Errors** — whisper/ffmpeg stderr is mapped to actionable messages (corrupt
  model → re-download, OOM → pick a smaller model, etc.); raw stack traces never
  reach the UI.
