#!/usr/bin/env bash
# Builds whisper.cpp with the best available acceleration and installs the CLI
# into vendor/whisper/, where LocalScribe looks for it (dev) and from where
# electron-builder ships it as resources/bin (packaged).
#
# Acceleration is a *compile-time* choice in whisper.cpp:
#   macOS            -> Metal (on by default)
#   Linux/Windows    -> CUDA when the CUDA toolkit is present,
#                       else Vulkan when the Vulkan SDK (glslc) is present,
#                       else CPU
# At runtime the app passes --no-gpu to fall back to CPU when needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/.whisper-cpp"
DEST="$ROOT/vendor/whisper"
WHISPER_REF="${WHISPER_REF:-v1.7.4}"

command -v cmake >/dev/null || { echo "cmake is required (apt install cmake / brew install cmake)"; exit 1; }
command -v git >/dev/null || { echo "git is required"; exit 1; }

if [ ! -d "$BUILD_DIR" ]; then
  git clone --depth 1 --branch "$WHISPER_REF" https://github.com/ggerganov/whisper.cpp "$BUILD_DIR"
fi

CMAKE_FLAGS=(-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF)
case "$(uname -s)" in
  Darwin)
    echo "==> Building with Metal acceleration"
    ;;
  *)
    if command -v nvcc >/dev/null 2>&1; then
      echo "==> CUDA toolkit found, building with CUDA acceleration"
      CMAKE_FLAGS+=(-DGGML_CUDA=1)
    elif command -v glslc >/dev/null 2>&1; then
      echo "==> Vulkan SDK found, building with Vulkan acceleration"
      CMAKE_FLAGS+=(-DGGML_VULKAN=1)
    else
      echo "==> No CUDA or Vulkan SDK found, building CPU-only"
    fi
    ;;
esac

cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build" "${CMAKE_FLAGS[@]}"
cmake --build "$BUILD_DIR/build" --config Release -j "$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "${NUMBER_OF_PROCESSORS:-4}")"

mkdir -p "$DEST"
# Layout differs by generator: Unix Makefiles put binaries straight in build/bin,
# the MSVC generator (Windows) nests them under a build/bin/Release config dir
# and names them with a .exe suffix.
BIN=""
for candidate in \
  "$BUILD_DIR/build/bin/whisper-cli" \
  "$BUILD_DIR/build/bin/whisper-cli.exe" \
  "$BUILD_DIR/build/bin/Release/whisper-cli.exe" \
  "$BUILD_DIR/build/bin/main" \
  "$BUILD_DIR/build/bin/main.exe" \
  "$BUILD_DIR/build/bin/Release/main.exe"; do
  if [ -f "$candidate" ]; then
    BIN="$candidate"
    break
  fi
done
[ -n "$BIN" ] || { echo "whisper-cli binary not found under $BUILD_DIR/build/bin" >&2; exit 1; }

DEST_NAME="whisper-cli"
[[ "$BIN" == *.exe ]] && DEST_NAME="whisper-cli.exe"
cp "$BIN" "$DEST/$DEST_NAME"
echo "==> Installed $(basename "$BIN") to vendor/whisper/$DEST_NAME"
