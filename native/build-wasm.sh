#!/bin/bash
# Build the tuidaw native audio library as WebAssembly via Emscripten.
# Produces tuidaw_audio.js + tuidaw_audio.wasm for use in the browser.
# miniaudio automatically selects its Web Audio backend when compiled with emcc.
#
# Usage: ./build-wasm.sh [debug|release]
#
# Prerequisites: Emscripten SDK installed in native/emsdk/
#   ./emsdk install latest && ./emsdk activate latest

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMSDK_ENV="$SCRIPT_DIR/emsdk/emsdk_env.sh"

if [ ! -f "$EMSDK_ENV" ]; then
    echo "Error: Emscripten SDK not found at $SCRIPT_DIR/emsdk/"
    echo "Install it: cd native/emsdk && ./emsdk install latest && ./emsdk activate latest"
    exit 1
fi

# Source Emscripten environment (provides emcc)
source "$EMSDK_ENV" 2>/dev/null

if ! command -v emcc &>/dev/null; then
    echo "Error: emcc not found after sourcing emsdk_env.sh"
    exit 1
fi

MODE="${1:-release}"
OUTDIR="$SCRIPT_DIR/../web/wasm"
mkdir -p "$OUTDIR"

echo "Building tuidaw_audio WASM ($MODE) -> $OUTDIR/"

# All exported C functions (must match EXPORT functions in tuidaw_audio.c)
EXPORTED_FUNCTIONS="['_tuidaw_init','_tuidaw_init_null','_tuidaw_deinit','_tuidaw_refresh_devices','_tuidaw_get_device_count','_tuidaw_get_device_name','_tuidaw_is_device_default','_tuidaw_set_output_device','_tuidaw_get_active_device_index','_tuidaw_start_playback_device','_tuidaw_stop_playback_device','_tuidaw_add_track','_tuidaw_remove_track','_tuidaw_set_track_samples','_tuidaw_set_track_volume','_tuidaw_set_track_pan','_tuidaw_set_track_muted','_tuidaw_set_track_solo','_tuidaw_set_track_input_device','_tuidaw_play','_tuidaw_stop','_tuidaw_get_playhead','_tuidaw_set_playhead','_tuidaw_set_click','_tuidaw_generate_click','_tuidaw_set_click_samples','_tuidaw_set_click_volume','_tuidaw_set_click_pan','_tuidaw_set_loop','_tuidaw_start_recording','_tuidaw_stop_recording','_tuidaw_get_recording_buffer','_tuidaw_get_recording_length','_tuidaw_set_speed','_tuidaw_get_speed','_tuidaw_render','_malloc','_free']"

# Exported runtime methods needed for JS interop
EXPORTED_RUNTIME="['ccall','cwrap','setValue','getValue','UTF8ToString','stringToUTF8','stackAlloc','stackSave','stackRestore','HEAPF32','HEAP32']"

# Common flags
CFLAGS="-I$SCRIPT_DIR"
CFLAGS="$CFLAGS -sEXPORTED_FUNCTIONS=$EXPORTED_FUNCTIONS"
CFLAGS="$CFLAGS -sEXPORTED_RUNTIME_METHODS=$EXPORTED_RUNTIME"
CFLAGS="$CFLAGS -sALLOW_MEMORY_GROWTH=1"
CFLAGS="$CFLAGS -sINITIAL_MEMORY=67108864"  # 64MB initial (DAW needs memory for audio buffers)
CFLAGS="$CFLAGS -sSTACK_SIZE=1048576"        # 1MB stack (WSOLA uses stack arrays)
CFLAGS="$CFLAGS -sAUDIO_WORKLET=1"           # Use AudioWorklet (not ScriptProcessorNode)
CFLAGS="$CFLAGS -sWASM_WORKERS=1"            # Required for AUDIO_WORKLET
CFLAGS="$CFLAGS -sMODULARIZE=1"             # Wrap in a factory function
CFLAGS="$CFLAGS -sEXPORT_NAME='TuidawAudio'" # Factory function name
CFLAGS="$CFLAGS -sENVIRONMENT=web,worker"    # Browser-only (no Node.js)
CFLAGS="$CFLAGS -sPTHREAD_POOL_SIZE=4"       # Thread pool for audio callbacks
CFLAGS="$CFLAGS -sUSE_PTHREADS=1"            # miniaudio uses pthreads for audio thread
CFLAGS="$CFLAGS -lm"

if [ "$MODE" = "debug" ]; then
    CFLAGS="-g -O0 -sASSERTIONS=2 $CFLAGS"
else
    CFLAGS="-O2 -DNDEBUG $CFLAGS"
fi

emcc $SCRIPT_DIR/tuidaw_audio.c \
    $CFLAGS \
    -o "$OUTDIR/tuidaw_audio.js" \
    2>&1

if [ $? -eq 0 ]; then
    echo "Success!"
    ls -la "$OUTDIR"/tuidaw_audio.*
    echo ""
    echo "Files generated in $OUTDIR/:"
    ls "$OUTDIR/"
else
    echo "Build failed!"
    exit 1
fi
