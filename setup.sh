#!/bin/bash
# TUIDAW setup script
# Downloads the Zig toolchain (if needed) and builds the native audio library.
# Usage: ./setup.sh [debug|release]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$SCRIPT_DIR/native"
ZIG_DIR="$NATIVE_DIR/zig-toolchain"
ZIG="$ZIG_DIR/zig"
ZIG_VERSION="0.14.0"

# ── Detect platform and architecture ─────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Linux*)   PLATFORM="linux" ;;
    Darwin*)  PLATFORM="macos" ;;
    *)
        echo "Error: Unsupported OS: $OS"
        echo "TUIDAW currently supports Linux and macOS."
        exit 1
        ;;
esac

case "$ARCH" in
    x86_64|amd64)   ZIG_ARCH="x86_64" ;;
    aarch64|arm64)   ZIG_ARCH="aarch64" ;;
    *)
        echo "Error: Unsupported architecture: $ARCH"
        echo "TUIDAW supports x86_64 and aarch64."
        exit 1
        ;;
esac

echo "Platform: $PLATFORM-$ZIG_ARCH"

# ── Check system dependencies ────────────────────────────────────────────

echo ""
echo "Checking dependencies..."

MISSING=""

if ! command -v bun &>/dev/null; then
    MISSING="$MISSING  - bun (https://bun.sh)\n"
fi

if ! command -v ffmpeg &>/dev/null; then
    MISSING="$MISSING  - ffmpeg (for export mixdown)\n"
fi

if [ "$PLATFORM" = "linux" ] && ! command -v zenity &>/dev/null; then
    MISSING="$MISSING  - zenity (for file dialogs)\n"
fi

if [ -n "$MISSING" ]; then
    echo "Warning: Missing optional/required dependencies:"
    echo -e "$MISSING"
    echo "Install them with your package manager. Continuing anyway..."
    echo ""
fi

# ── Download Zig toolchain ───────────────────────────────────────────────

if [ -f "$ZIG" ]; then
    echo "Zig toolchain already present at $ZIG_DIR"
else
    ZIG_TARBALL="zig-$PLATFORM-$ZIG_ARCH-$ZIG_VERSION.tar.xz"
    ZIG_URL="https://ziglang.org/download/$ZIG_VERSION/$ZIG_TARBALL"

    echo "Downloading Zig $ZIG_VERSION for $PLATFORM-$ZIG_ARCH..."
    echo "  URL: $ZIG_URL"

    TMPFILE="$(mktemp)"
    trap "rm -f '$TMPFILE'" EXIT

    if command -v curl &>/dev/null; then
        curl -fSL --progress-bar -o "$TMPFILE" "$ZIG_URL"
    elif command -v wget &>/dev/null; then
        wget -q --show-progress -O "$TMPFILE" "$ZIG_URL"
    else
        echo "Error: Neither curl nor wget found. Install one to download Zig."
        exit 1
    fi

    echo "Extracting Zig toolchain..."
    mkdir -p "$ZIG_DIR"
    tar xf "$TMPFILE" -C "$ZIG_DIR" --strip-components=1
    rm -f "$TMPFILE"
    trap - EXIT

    if [ ! -f "$ZIG" ]; then
        echo "Error: Zig extraction failed — $ZIG not found"
        exit 1
    fi

    echo "Zig $ZIG_VERSION installed to $ZIG_DIR"
fi

# ── Install JS dependencies ─────────────────────────────────────────────

echo ""
echo "Installing JS dependencies..."
cd "$SCRIPT_DIR"
bun install

# ── Build native audio library ───────────────────────────────────────────

echo ""
MODE="${1:-release}"
echo "Building native audio library ($MODE)..."
cd "$NATIVE_DIR"
bash build.sh "$MODE"

echo ""
echo "Setup complete! Run with:"
echo "  bun run start"
