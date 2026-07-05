# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Introduces D-Bus portal integration for reliable hotkey handling on GNOME/Wayland (avoiding X11's native-Wayland blind spot), refactors hotkey tiers into a three-layer fallback system (portal → uiohook → globalShortcut), adds repeat-debounce logic to prevent key-repeat artifacts, extends toggle hotkey to use uiohook/portal in addition to PTT, moves compact-mode UI button to header, and improves documentation around Wayland limitations.
