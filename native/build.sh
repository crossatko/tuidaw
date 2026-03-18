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
