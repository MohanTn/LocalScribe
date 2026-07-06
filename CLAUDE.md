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
npm run test               # vitest run
npm run dist               # package for current platform -> release/
npm run dist:win|mac|linux # platform-specific packaging
```

Before `npm run dev` will work, the whisper.cpp CLI must be built locally:

```bash
./scripts/setup-whisper.sh   # clones ggerganov/whisper.cpp into .whisper-cpp/, builds, copies binary to vendor/whisper/
```

`npm install` runs `electron-builder install-app-deps` via `postinstall`, which rebuilds `better-sqlite3` against Electron's Node ABI — never run `npm rebuild` manually. The postinstall first runs `scripts/alias-uiohook-prebuilds.mjs`: `uiohook-napi` ships N-API prebuilds named `uiohook-napi.node`, which `@electron/rebuild` doesn't recognize (it only looks for `node.napi.node`-style names), so without the alias it would rebuild uiohook from source — exactly what broke CI on runners lacking X11 headers (Linux) or Visual Studio (Windows). The alias makes the rebuild step skip uiohook and use the shipped prebuild.

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
   - every 2.5 s, re-transcribes the last ≤10 s as a sliding window for **live partial captions** (best-effort; errors are swallowed — the final pass surfaces real failures). The window is deliberately short: it's only a live preview, so a smaller re-transcription finishes faster and frees the GPU sooner; the final pass restores full-recording context regardless,
   - on stop, transcribes the full buffer for the **final result**. `stopRecording` first awaits any in-flight partial so the two whisper jobs don't overlap — on a small (e.g. 4 GB) GPU, two concurrent jobs each run ~1.8× slower from VRAM contention, felt directly as post-stop latency.
4. `src/main/whisper.ts` spawns the whisper.cpp CLI **per job** (not a resident process) — this keeps idle memory near zero (well under the ~150 MB tray budget) and isolates native crashes from the app. It parses whisper's `-oj -ojf` JSON output and collapses whisper's sub-word tokens into whole words with timestamps (`tokensToWords`) for word-level SRT export.
5. File transcription (`transcribe:file` in `ipc.ts`) instead normalizes the input through `src/main/ffmpeg.ts` (bundled `ffmpeg-static`, falls back to system `ffmpeg` on PATH) to 16 kHz mono PCM WAV before handing off to the same `transcribeWav`.

GPU acceleration is a **compile-time** choice in whisper.cpp (Metal on macOS by default; on Linux/Windows, CUDA if `nvcc` was present when `setup-whisper.sh` ran, else Vulkan if `glslc` was present, else CPU-only). At runtime the app only chooses whether to pass `--no-gpu` (`detectGpu()` / `forceCpu` setting) — there's no dynamic layer-offload flag like llama.cpp. `detectGpu()` probes `nvidia-smi` then `vulkaninfo` to tell CUDA/Vulkan/CPU apart; flash attention (`-fa`) is only passed for cuda/metal since Vulkan support for it isn't reliable.

whisper.cpp / ffmpeg stderr is translated to actionable messages in `friendlyWhisperError()` (`whisper.ts`) and inline in `ffmpeg.ts`'s `close` handler — raw stack traces should never reach the UI. Follow this pattern for new failure modes rather than surfacing raw child-process output.

### Pause-media-on-record

`src/main/media.ts`'s `pauseMedia()`/`resumeMedia()` are called from the `audio:start`/`audio:stop`/`audio:abort` IPC handlers in `ipc.ts` (not from `recording.ts`), because those handlers are the one choke point every recording start/stop passes through regardless of trigger (toggle hotkey, PTT, in-app record button). `pauseMedia()` is awaited *before* `startRecording()` so it resolves before the renderer's `recorder.start()` fires — muting background audio before mic capture begins, not just before whisper runs, is what keeps bleed-through out of the transcript. `resumeMedia()` in `audio:stop` runs immediately, before the `await stopRecording()` transcription pass, so audio comes back the instant the user releases the hotkey rather than after whisper finishes.

This mutes system audio output at the OS mixer level rather than pausing individual apps/players (an earlier per-player design using `playerctl`/MPRIS was scrapped: it silently did nothing for apps that don't expose a media-control interface, which includes most browser tabs — exactly the YouTube-in-browser case this feature exists for). Linux tries `wpctl` (PipeWire) → `pactl` (PulseAudio) → `amixer` (ALSA), whichever is present; macOS reads/writes `output muted` via AppleScript — both capture the exact original mute state and restore it, rather than blindly unmuting a user who'd already muted themselves. Windows has no free way to query or set mute without a Core Audio COM shim, so it sends a blind `VK_VOLUME_MUTE` toggle, the same thing a hardware mute key does — low-risk in practice since nothing else is likely to flip system mute mid-recording. Both `pauseMedia()` and `resumeMedia()` are wrapped in a timeout race so a hung external tool can never block or delay recording start/stop. Muted playback keeps advancing in the background, so a video/song will have skipped ahead by the recording's length once unmuted rather than resuming from the exact frame it was at — an accepted tradeoff for working with any audio source uniformly.

### Linux sandbox

`build/afterPack.js` does two things to Linux builds after packaging:
1. Deletes the packaged `chrome-sandbox` helper outright. electron-builder's deb/AppImage targets ship it without root ownership or the setuid bit (the build runs unprivileged and can't grant either); Chromium's zygote host validates that file's permissions *unconditionally* and aborts with a FATAL `setuid_sandbox_host.cc` error regardless of `--no-sandbox` if the file exists and is misconfigured. Removing it sidesteps that check entirely.
2. Renames the real binary to `<name>.bin` and writes a shell wrapper in its place (same name, same path) that execs it with `--no-sandbox --disable-dev-shm-usage`. `src/main/index.ts` *also* calls `app.commandLine.appendSwitch('no-sandbox')`, but that alone doesn't work for packaged builds: on Linux, Electron forks the zygote process from native code before Node.js loads and runs `index.ts`, so a switch appended from JS never reaches the zygote host's sandbox negotiation — confirmed by testing, where JS-only `no-sandbox` still hit `zygote_host_impl_linux.cc: No usable sandbox!`. Only a switch present in the process's actual argv at exec time reaches that check, hence the wrapper. The `.desktop` file, `/usr/bin/local-scribe` symlink, and AppImage `AppRun` all still point at the original binary name, so they transparently launch the wrapper instead.

The renderer only ever loads bundled local HTML (never remote content), so trading the sandbox's defense-in-depth for an install that works out of the box is an acceptable tradeoff here. macOS/Windows are unaffected (different sandbox mechanisms, no setuid helper involved); the JS-side `appendSwitch` calls in `index.ts` are what cover the unpackaged `npm run dev`/`npm run start` case, where there's no wrapper.

**Known related issue**: on Ubuntu 24.04+, `kernel.apparmor_restrict_unprivileged_userns=1` (AppArmor's unprivileged-userns hardening) denies Chromium's zygote `CAP_SYS_ADMIN` inside the unprivileged user namespace it creates, which can surface as a `platform_shared_memory_region_posix` FATAL (shared-memory allocation failing with `ESRCH` on both `/dev/shm` and `/tmp`) even once `--no-sandbox` is correctly in effect. If this recurs after the wrapper fix, the properly-supported remedy is a bundled AppArmor profile granting the binary `userns,` (what Chrome/Chromium's own `.deb` ships) — not yet implemented here. Don't reach for `disable-namespace-sandbox`/`disable-setuid-sandbox`/`disable-gpu-sandbox` as a fix: tried already, made things worse (regressed to the earlier, more fatal "No usable sandbox" error).

### Hotkeys and push-to-talk

`src/main/hotkeys.ts` prefers the native `uiohook-napi` module for *both* the toggle and PTT hotkeys when it loads, falling back to Electron's `globalShortcut` for each independently when it doesn't. It's an `optionalDependency` (N-API prebuilds for win/mac/linux), so packaged builds ship it — but the install can still legitimately fail (unsupported platform, `--omit=optional`), which is why it's loaded through `src/main/uiohookLoader.ts`'s try/catch-guarded `require` (an indirection that also lets unit tests mock its presence/absence). uiohook fixes one of `globalShortcut`'s two limitations: true push-to-talk needs a key-*release* event, which `globalShortcut` can't provide at all. It does **not** fix the other: `globalShortcut` grabs keys via X11 (through XWayland on a Wayland session), so it silently never sees native-Wayland client windows (many terminal emulators, GTK4 apps, etc.) — and on Linux, `uiohook-napi`'s backend is *also* X11-only (`XRecord`, see `libuiohook/src/x11`), so it has the exact same native-Wayland blind spot. Without uiohook, PTT degrades to a second toggle shortcut, and the toggle hotkey falls back to `globalShortcut` (fine on X11, flaky on pure Wayland — see README's hotkey reliability table). Don't assume `uiohook-napi` is present — always feature-detect via `loadUiohook()`.

On Linux, `applyHotkeys` additionally tries `src/main/hotkeysPortal.ts` in the background after registering the tiers above: the `org.freedesktop.portal.GlobalShortcuts` D-Bus portal, implemented by the compositor itself, so it has no X11/native-Wayland blind spot at all. It only accepts calls from a process the compositor can attribute to an installed app — a systemd `app-<id>-<pid>.scope`, which GNOME assigns when the app is launched from its `.desktop` entry — so it fails closed (logged, not thrown) for dev-mode/CLI launches and desktops without a portal backend, leaving the `globalShortcut`/uiohook registration in place. If it binds successfully, that registration is torn down so hotkeys don't double-fire. Binding is keyed by our own `shortcut_id` strings (`toggle-recording`, `push-to-talk`); the actual key combo is only passed as a `preferred_trigger` *hint* — GNOME's confirmation dialog lets the user rebind it independent of LocalScribe's own hotkey settings field, an intentional UX gap not yet reconciled in the Settings UI.

### Status and tray

`src/main/status.ts` is a tiny observable (`idle | recording | processing | error`) that the tray icon (`src/main/tray.ts`), renderer status dot, and tray menu labels all subscribe to — it's the single source of truth for app-wide state; don't duplicate status tracking elsewhere.

### Persistence

- **Settings** (`src/main/settings.ts`): a plain JSON file in `userData`, cached in-memory, merged shallowly except `llm` which is merged one level deep. No schema/migration system.
- **History** (`src/main/history.ts`): SQLite via `better-sqlite3`. If the native module fails to load (ABI mismatch is the classic cause), it degrades to an in-memory array so transcription keeps working even though history won't persist — preserve this fallback behavior when touching this file.

### Binary/vendor layout

`vendor/whisper/` (dev, produced by `setup-whisper.sh`) and `.whisper-cpp/` (the cloned+built whisper.cpp source tree) are both gitignored. `src/main/whisper.ts`'s `candidates()` defines the binary lookup order: `WHISPER_CPP_BIN` env var → packaged `resources/bin/` → dev `vendor/whisper/` → `PATH`. `electron-builder.yml`'s `extraResources` copies `vendor/whisper` → `resources/bin` at package time, and `asarUnpack` covers native `.node` files and `ffmpeg-static` since neither can execute from inside the asar archive.

### Models

`src/main/models.ts` hardcodes the model catalog (tiny/tiny.en/base/base.en/small/medium/large-v3/large-v3-turbo) as GGML files hosted on Hugging Face (`ggerganov/whisper.cpp`). Downloads stream to a `.part` file and rename on completion so a partial download is never mistaken for a usable model; cancellation is treated as a non-error (`isAbort`).
