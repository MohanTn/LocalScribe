# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Refactored vocabulary system from `{from, to}` object pairs to a plain `string[]` list with Levenshtein-based fuzzy matching. Migration code handles legacy settings files by extracting the `to` field. UI simplified from individual from/to input pairs to a single comma-separated textarea. Fuzzy matcher tolerates up to ~2 character differences (0.75 similarity threshold) while requiring exact matches for short words (< 4 chars). Comprehensive unit tests cover both migration paths and matching edge cases.
- Replaced the separate in-app compact-mode button with minimize button interception, so clicking OS minimize enters the always-on-top mini widget. Also improved scrollbar UX to auto-hide and show on hover/scroll. Expanded tests to cover the new minimize behavior.
- Adds a "Pause background media while recording" feature with platform-specific implementations (Linux: wpctl/pactl/amixer; macOS: AppleScript; Windows: PowerShell mute toggle). Includes comprehensive tests, Settings UI toggle, and integration into the recording start/stop IPC handlers.
- Introduces D-Bus portal integration for reliable hotkey handling on GNOME/Wayland (avoiding X11's native-Wayland blind spot), refactors hotkey tiers into a three-layer fallback system (portal → uiohook → globalShortcut), adds repeat-debounce logic to prevent key-repeat artifacts, extends toggle hotkey to use uiohook/portal in addition to PTT, moves compact-mode UI button to header, and improves documentation around Wayland limitations.
