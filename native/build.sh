#!/bin/bash
# Build the tuidaw native audio library using zig cc
# Usage: ./build.sh [debug|release]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ZIG="$SCRIPT_DIR/zig-toolchain/zig"

if [ ! -f "$ZIG" ]; then
    echo "Error: Zig not found at $ZIG"
    echo "Run the setup to download Zig first."
    exit 1
fi

MODE="${1:-release}"

# Detect platform for output filename
case "$(uname -s)" in
    Linux*)   LIBNAME="libtuidaw_audio.so" ;;
    Darwin*)  LIBNAME="libtuidaw_audio.dylib" ;;
    MINGW*|MSYS*|CYGWIN*) LIBNAME="tuidaw_audio.dll" ;;
    *)        LIBNAME="libtuidaw_audio.so" ;;
esac

echo "Building tuidaw_audio ($MODE) -> $LIBNAME"

CFLAGS="-shared -fPIC -o $SCRIPT_DIR/$LIBNAME $SCRIPT_DIR/tuidaw_audio.c"
CFLAGS="$CFLAGS -I$SCRIPT_DIR"
CFLAGS="$CFLAGS -lm -lpthread"

# Platform-specific audio backends
case "$(uname -s)" in
    Linux*)
        # Link ALSA for Linux (PipeWire provides ALSA compatibility)
        CFLAGS="$CFLAGS -ldl"
        ;;
    Darwin*)
        CFLAGS="$CFLAGS -framework CoreFoundation -framework CoreAudio -framework AudioUnit"
        ;;
esac

if [ "$MODE" = "debug" ]; then
    CFLAGS="-g -O0 $CFLAGS"
else
    CFLAGS="-O2 -DNDEBUG $CFLAGS"
fi

# Use zig cc for compilation (cross-platform C compiler)
$ZIG cc $CFLAGS

if [ $? -eq 0 ]; then
    echo "Success: $SCRIPT_DIR/$LIBNAME"
    ls -la "$SCRIPT_DIR/$LIBNAME"
else
    echo "Build failed!"
    exit 1
fi

# ── Build PipeWire custom node helper (Linux only) ──────────────────────
# This helper creates custom ALSA nodes without auto-link/node-group properties
# that cause audio corruption on multi-channel USB devices in pro-audio profile.
# It requires libpipewire-0.3-dev. If not available, skip silently — monitoring
# will still work via PulseAudio duplex fallback.
case "$(uname -s)" in
    Linux*)
        if pkg-config --exists libpipewire-0.3 2>/dev/null; then
            echo "Building pw_custom_node helper..."
            PW_CFLAGS=$(pkg-config --cflags libpipewire-0.3)
            PW_LIBS=$(pkg-config --libs libpipewire-0.3)
            if [ "$MODE" = "debug" ]; then
                PW_OPT="-g -O0"
            else
                PW_OPT="-O2 -DNDEBUG"
            fi
            cc $PW_OPT -o "$SCRIPT_DIR/pw_custom_node" "$SCRIPT_DIR/pw_custom_node.c" $PW_CFLAGS $PW_LIBS -lm 2>&1
            if [ $? -eq 0 ]; then
                echo "Success: $SCRIPT_DIR/pw_custom_node"
            else
                echo "Warning: pw_custom_node build failed (monitoring will use PulseAudio fallback)"
            fi
        else
            echo "Skipping pw_custom_node (libpipewire-0.3-dev not found)"
        fi
        ;;
esac
