// ============================================================================
// tuidaw - Native Audio Engine (miniaudio-based)
// ============================================================================
// Cross-platform audio I/O via miniaudio. Compiled as a shared library,
// called from TypeScript via Bun FFI.
//
// Architecture:
//   - Single playback device with a mixing callback
//   - Per-track sample buffers with volume/pan (atomic parameter changes)
//   - Per-track capture devices for recording
//   - Click generator inline in the playback callback
//   - Sample-accurate playhead tracking
//   - Loop region handled in the callback
// ============================================================================

#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

#include <string.h>
#include <stdlib.h>
#include <math.h>
#include <stdatomic.h>

// ── Constants ───────────────────────────────────────────────────────────────

#define SAMPLE_RATE       48000
#define MAX_TRACKS        64
#define MAX_DEVICE_NAME   256
#define RECORDING_BUF_SEC 600   // 10 minutes max recording per track
#define RECORDING_BUF_LEN (SAMPLE_RATE * RECORDING_BUF_SEC)

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ── Track State ─────────────────────────────────────────────────────────────

typedef struct {
    int           active;            // slot in use
    int           id;                // track ID (from JS)
    float*        samples;           // playback sample buffer (mono, owned by JS — NOT freed here)
    int           samples_len;       // length of samples buffer
    _Atomic float volume;            // 0.0 - 1.0
    _Atomic float pan;               // -1.0 (L) to 1.0 (R)
    _Atomic int   muted;             // boolean
    _Atomic int   solo;              // boolean

    // Recording state
    _Atomic int   recording;         // currently recording
    float*        rec_buffer;        // ring buffer for captured audio (owned by us)
    _Atomic int   rec_write_pos;     // write position in rec_buffer
    int           rec_device_index;  // miniaudio capture device index (-1 = default)
    ma_device     rec_device;        // capture device (active only while recording)
    int           rec_device_active; // is rec_device initialized and started
} TrackState;

// ── Engine State ────────────────────────────────────────────────────────────

typedef struct {
    ma_context    context;
    ma_device     playback_device;
    int           playback_active;

    TrackState    tracks[MAX_TRACKS];

    _Atomic int   playing;               // transport running
    _Atomic long  playhead_samples;      // current playhead position (in samples)
    long          transport_start_pos;   // playhead position when transport started

    // Click state
    _Atomic int   click_enabled;
    _Atomic float click_bpm;

    // Loop state
    _Atomic long  loop_start;            // -1 = no loop
    _Atomic long  loop_end;              // -1 = no loop

    // Output device
    int           output_device_index;   // -1 = default

    // Device info cache
    ma_device_info* playback_infos;
    ma_uint32       playback_count;
    ma_device_info* capture_infos;
    ma_uint32       capture_count;
} EngineState;

static EngineState g_engine;

// ── Helpers ─────────────────────────────────────────────────────────────────

static TrackState* find_track(int id) {
    for (int i = 0; i < MAX_TRACKS; i++) {
        if (g_engine.tracks[i].active && g_engine.tracks[i].id == id) {
            return &g_engine.tracks[i];
        }
    }
    return NULL;
}

static TrackState* find_free_slot(void) {
    for (int i = 0; i < MAX_TRACKS; i++) {
        if (!g_engine.tracks[i].active) {
            return &g_engine.tracks[i];
        }
    }
    return NULL;
}

static int has_any_solo(void) {
    for (int i = 0; i < MAX_TRACKS; i++) {
        if (g_engine.tracks[i].active && atomic_load(&g_engine.tracks[i].solo)) {
            return 1;
        }
    }
    return 0;
}

// ── Playback Callback ───────────────────────────────────────────────────────
// Called on the audio thread. Mixes all tracks + click into the output buffer.

static void playback_callback(ma_device* pDevice, void* pOutput, const void* pInput, ma_uint32 frameCount) {
    (void)pDevice;
    (void)pInput;

    float* out = (float*)pOutput;
    memset(out, 0, frameCount * 2 * sizeof(float));  // stereo output

    if (!atomic_load(&g_engine.playing)) return;

    long playhead = atomic_load(&g_engine.playhead_samples);
    long loop_start = atomic_load(&g_engine.loop_start);
    long loop_end = atomic_load(&g_engine.loop_end);

    int any_solo = has_any_solo();

    // Click state
    int click_enabled = atomic_load(&g_engine.click_enabled);
    float bpm = atomic_load(&g_engine.click_bpm);
    int samples_per_beat = (bpm > 0) ? (int)(60.0f / bpm * SAMPLE_RATE) : SAMPLE_RATE;

    for (ma_uint32 frame = 0; frame < frameCount; frame++) {
        long pos = playhead + (long)frame;

        // Loop handling: wrap position
        if (loop_start >= 0 && loop_end > loop_start && pos >= loop_end) {
            long loop_len = loop_end - loop_start;
            long overshoot = pos - loop_end;
            pos = loop_start + (overshoot % loop_len);
        }

        float left = 0.0f;
        float right = 0.0f;

        // Mix tracks
        for (int t = 0; t < MAX_TRACKS; t++) {
            TrackState* tk = &g_engine.tracks[t];
            if (!tk->active) continue;
            if (atomic_load(&tk->muted)) continue;
            if (any_solo && !atomic_load(&tk->solo)) continue;
            if (atomic_load(&tk->recording)) continue;  // recording tracks don't play back their old audio
            if (!tk->samples || tk->samples_len == 0) continue;

            if (pos < 0 || pos >= tk->samples_len) continue;

            float sample = tk->samples[pos];
            float vol = atomic_load(&tk->volume);
            float pan = atomic_load(&tk->pan);

            // Equal-power panning
            float left_gain = cosf(((pan + 1.0f) / 2.0f) * (float)(M_PI / 2.0));
            float right_gain = sinf(((pan + 1.0f) / 2.0f) * (float)(M_PI / 2.0));

            left  += sample * vol * left_gain;
            right += sample * vol * right_gain;
        }

        // Click (metronome)
        if (click_enabled && pos >= 0) {
            long beat_pos = pos % samples_per_beat;
            int click_len = (int)(SAMPLE_RATE * 0.02f);  // 20ms click
            if (beat_pos < click_len) {
                float t = (float)beat_pos / SAMPLE_RATE;
                float envelope = 1.0f - (float)beat_pos / click_len;
                float click_sample = sinf(2.0f * (float)M_PI * 1000.0f * t) * envelope * 0.5f;
                left  += click_sample;
                right += click_sample;
            }
        }

        // Clamp
        if (left > 1.0f) left = 1.0f;
        if (left < -1.0f) left = -1.0f;
        if (right > 1.0f) right = 1.0f;
        if (right < -1.0f) right = -1.0f;

        out[frame * 2 + 0] = left;
        out[frame * 2 + 1] = right;
    }

    // Advance playhead
    long new_playhead = playhead + (long)frameCount;

    // Handle loop wrap at the engine level
    if (loop_start >= 0 && loop_end > loop_start && new_playhead >= loop_end) {
        long loop_len = loop_end - loop_start;
        long overshoot = new_playhead - loop_end;
        new_playhead = loop_start + (overshoot % loop_len);
    }

    atomic_store(&g_engine.playhead_samples, new_playhead);
}

// ── Capture Callback (per-track recording) ──────────────────────────────────

static void capture_callback(ma_device* pDevice, void* pOutput, const void* pInput, ma_uint32 frameCount) {
    (void)pOutput;

    TrackState* tk = (TrackState*)pDevice->pUserData;
    if (!tk || !atomic_load(&tk->recording) || !tk->rec_buffer) return;

    const float* input = (const float*)pInput;
    int write_pos = atomic_load(&tk->rec_write_pos);

    for (ma_uint32 i = 0; i < frameCount; i++) {
        if (write_pos >= RECORDING_BUF_LEN) break;
        tk->rec_buffer[write_pos] = input[i];
        write_pos++;
    }

    atomic_store(&tk->rec_write_pos, write_pos);
}

// ── Exported API ────────────────────────────────────────────────────────────

#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

// Initialize the audio engine. Returns 0 on success, -1 on failure.
EXPORT int tuidaw_init(void) {
    memset(&g_engine, 0, sizeof(g_engine));
    atomic_store(&g_engine.loop_start, -1);
    atomic_store(&g_engine.loop_end, -1);
    atomic_store(&g_engine.click_bpm, 120.0f);
    g_engine.output_device_index = -1;

    ma_context_config ctxConfig = ma_context_config_init();
    if (ma_context_init(NULL, 0, &ctxConfig, &g_engine.context) != MA_SUCCESS) {
        return -1;
    }

    // Enumerate devices
    ma_context_get_devices(&g_engine.context,
        &g_engine.playback_infos, &g_engine.playback_count,
        &g_engine.capture_infos, &g_engine.capture_count);

    return 0;
}

// Shut down the audio engine.
EXPORT void tuidaw_deinit(void) {
    // Stop transport
    atomic_store(&g_engine.playing, 0);

    // Stop and free all recording devices
    for (int i = 0; i < MAX_TRACKS; i++) {
        TrackState* tk = &g_engine.tracks[i];
        if (tk->rec_device_active) {
            ma_device_uninit(&tk->rec_device);
            tk->rec_device_active = 0;
        }
        if (tk->rec_buffer) {
            free(tk->rec_buffer);
            tk->rec_buffer = NULL;
        }
        tk->active = 0;
    }

    // Stop playback device
    if (g_engine.playback_active) {
        ma_device_uninit(&g_engine.playback_device);
        g_engine.playback_active = 0;
    }

    ma_context_uninit(&g_engine.context);
}

// ── Device Enumeration ──────────────────────────────────────────────────────

// Refresh device list. Returns 0 on success.
EXPORT int tuidaw_refresh_devices(void) {
    // Re-enumerate
    ma_context_get_devices(&g_engine.context,
        &g_engine.playback_infos, &g_engine.playback_count,
        &g_engine.capture_infos, &g_engine.capture_count);
    return 0;
}

// Get number of playback or capture devices.
// type: 0 = playback (output), 1 = capture (input)
EXPORT int tuidaw_get_device_count(int type) {
    if (type == 0) return (int)g_engine.playback_count;
    return (int)g_engine.capture_count;
}

// Get device name. Writes into the provided buffer.
// Returns 0 on success, -1 on failure.
EXPORT int tuidaw_get_device_name(int type, int index, char* out_name, int max_len) {
    ma_device_info* infos;
    ma_uint32 count;
    if (type == 0) {
        infos = g_engine.playback_infos;
        count = g_engine.playback_count;
    } else {
        infos = g_engine.capture_infos;
        count = g_engine.capture_count;
    }
    if (index < 0 || (ma_uint32)index >= count) return -1;
    strncpy(out_name, infos[index].name, max_len - 1);
    out_name[max_len - 1] = '\0';
    return 0;
}

// Check if a device is the system default.
// Returns 1 if default, 0 otherwise.
EXPORT int tuidaw_is_device_default(int type, int index) {
    ma_device_info* infos;
    ma_uint32 count;
    if (type == 0) {
        infos = g_engine.playback_infos;
        count = g_engine.playback_count;
    } else {
        infos = g_engine.capture_infos;
        count = g_engine.capture_count;
    }
    if (index < 0 || (ma_uint32)index >= count) return 0;
    return infos[index].isDefault ? 1 : 0;
}

// Set the output device index. -1 = default.
// Takes effect on next tuidaw_start_playback_device() call.
EXPORT void tuidaw_set_output_device(int index) {
    g_engine.output_device_index = index;
}

// ── Playback Device Management ──────────────────────────────────────────────

// Start (or restart) the playback device. Must be called before playing.
// Returns 0 on success.
EXPORT int tuidaw_start_playback_device(void) {
    // If already active, stop first
    if (g_engine.playback_active) {
        ma_device_uninit(&g_engine.playback_device);
        g_engine.playback_active = 0;
    }

    ma_device_config config = ma_device_config_init(ma_device_type_playback);
    config.playback.format   = ma_format_f32;
    config.playback.channels = 2;
    config.sampleRate        = SAMPLE_RATE;
    config.dataCallback      = playback_callback;
    config.periodSizeInFrames = 256;  // ~5.3ms latency

    if (g_engine.output_device_index >= 0 &&
        (ma_uint32)g_engine.output_device_index < g_engine.playback_count) {
        config.playback.pDeviceID = &g_engine.playback_infos[g_engine.output_device_index].id;
    }

    if (ma_device_init(&g_engine.context, &config, &g_engine.playback_device) != MA_SUCCESS) {
        return -1;
    }

    if (ma_device_start(&g_engine.playback_device) != MA_SUCCESS) {
        ma_device_uninit(&g_engine.playback_device);
        return -1;
    }

    g_engine.playback_active = 1;
    return 0;
}

// Stop the playback device.
EXPORT void tuidaw_stop_playback_device(void) {
    if (g_engine.playback_active) {
        ma_device_uninit(&g_engine.playback_device);
        g_engine.playback_active = 0;
    }
}

// ── Track Management ────────────────────────────────────────────────────────

// Register a track. Returns 0 on success, -1 if no slots available.
EXPORT int tuidaw_add_track(int id) {
    if (find_track(id)) return 0;  // already exists
    TrackState* tk = find_free_slot();
    if (!tk) return -1;

    memset(tk, 0, sizeof(TrackState));
    tk->active = 1;
    tk->id = id;
    atomic_store(&tk->volume, 0.8f);
    atomic_store(&tk->pan, 0.0f);
    atomic_store(&tk->muted, 0);
    atomic_store(&tk->solo, 0);
    atomic_store(&tk->recording, 0);
    tk->rec_device_index = -1;
    tk->rec_device_active = 0;
    tk->rec_buffer = NULL;
    tk->samples = NULL;
    tk->samples_len = 0;
    return 0;
}

// Remove a track.
EXPORT void tuidaw_remove_track(int id) {
    TrackState* tk = find_track(id);
    if (!tk) return;

    // Stop recording if active
    if (tk->rec_device_active) {
        ma_device_uninit(&tk->rec_device);
        tk->rec_device_active = 0;
    }
    if (tk->rec_buffer) {
        free(tk->rec_buffer);
        tk->rec_buffer = NULL;
    }

    tk->active = 0;
    tk->samples = NULL;
    tk->samples_len = 0;
}

// Set a track's sample buffer. The pointer must remain valid until
// tuidaw_set_track_samples is called again or the track is removed.
// The memory is owned by the caller (JS side).
EXPORT void tuidaw_set_track_samples(int id, float* samples, int len) {
    TrackState* tk = find_track(id);
    if (!tk) return;
    tk->samples = samples;
    tk->samples_len = len;
}

EXPORT void tuidaw_set_track_volume(int id, float volume) {
    TrackState* tk = find_track(id);
    if (!tk) return;
    atomic_store(&tk->volume, volume);
}

EXPORT void tuidaw_set_track_pan(int id, float pan) {
    TrackState* tk = find_track(id);
    if (!tk) return;
    atomic_store(&tk->pan, pan);
}

EXPORT void tuidaw_set_track_muted(int id, int muted) {
    TrackState* tk = find_track(id);
    if (!tk) return;
    atomic_store(&tk->muted, muted);
}

EXPORT void tuidaw_set_track_solo(int id, int solo) {
    TrackState* tk = find_track(id);
    if (!tk) return;
    atomic_store(&tk->solo, solo);
}

// Set the capture device index for a track. -1 = default.
EXPORT void tuidaw_set_track_input_device(int id, int device_index) {
    TrackState* tk = find_track(id);
    if (!tk) return;
    tk->rec_device_index = device_index;
}

// ── Transport ───────────────────────────────────────────────────────────────

// Start playback from the given sample position.
// The playback device must already be started.
EXPORT void tuidaw_play(long position) {
    g_engine.transport_start_pos = position;
    atomic_store(&g_engine.playhead_samples, position);
    atomic_store(&g_engine.playing, 1);
}

// Stop transport.
EXPORT void tuidaw_stop(void) {
    atomic_store(&g_engine.playing, 0);
}

// Get current playhead position in samples.
EXPORT long tuidaw_get_playhead(void) {
    return atomic_load(&g_engine.playhead_samples);
}

// Set playhead position (for scrubbing while stopped).
EXPORT void tuidaw_set_playhead(long position) {
    atomic_store(&g_engine.playhead_samples, position);
}

// ── Click / Metronome ───────────────────────────────────────────────────────

EXPORT void tuidaw_set_click(int enabled, float bpm) {
    atomic_store(&g_engine.click_bpm, bpm);
    atomic_store(&g_engine.click_enabled, enabled);
}

// ── Loop Region ─────────────────────────────────────────────────────────────

EXPORT void tuidaw_set_loop(long start, long end) {
    atomic_store(&g_engine.loop_start, start);
    atomic_store(&g_engine.loop_end, end);
}

// ── Recording ───────────────────────────────────────────────────────────────

// Start recording on a track. Opens a capture device and starts writing.
// Returns 0 on success, -1 on failure.
EXPORT int tuidaw_start_recording(int id) {
    TrackState* tk = find_track(id);
    if (!tk) return -1;

    // Allocate recording buffer if needed
    if (!tk->rec_buffer) {
        tk->rec_buffer = (float*)calloc(RECORDING_BUF_LEN, sizeof(float));
        if (!tk->rec_buffer) return -1;
    }
    atomic_store(&tk->rec_write_pos, 0);

    // Set up capture device
    ma_device_config config = ma_device_config_init(ma_device_type_capture);
    config.capture.format   = ma_format_f32;
    config.capture.channels = 1;
    config.sampleRate       = SAMPLE_RATE;
    config.dataCallback     = capture_callback;
    config.pUserData        = tk;
    config.periodSizeInFrames = 256;  // ~5.3ms

    if (tk->rec_device_index >= 0 &&
        (ma_uint32)tk->rec_device_index < g_engine.capture_count) {
        config.capture.pDeviceID = &g_engine.capture_infos[tk->rec_device_index].id;
    }

    if (ma_device_init(&g_engine.context, &config, &tk->rec_device) != MA_SUCCESS) {
        return -1;
    }

    if (ma_device_start(&tk->rec_device) != MA_SUCCESS) {
        ma_device_uninit(&tk->rec_device);
        return -1;
    }

    tk->rec_device_active = 1;
    atomic_store(&tk->recording, 1);
    return 0;
}

// Stop recording on a track. Returns the number of samples recorded.
EXPORT int tuidaw_stop_recording(int id) {
    TrackState* tk = find_track(id);
    if (!tk) return 0;

    atomic_store(&tk->recording, 0);

    if (tk->rec_device_active) {
        ma_device_uninit(&tk->rec_device);
        tk->rec_device_active = 0;
    }

    return atomic_load(&tk->rec_write_pos);
}

// Get pointer to the recording buffer and the current write position.
// The caller can copy data out of this buffer.
EXPORT float* tuidaw_get_recording_buffer(int id) {
    TrackState* tk = find_track(id);
    if (!tk || !tk->rec_buffer) return NULL;
    return tk->rec_buffer;
}

// Get current recording write position (number of samples recorded so far).
EXPORT int tuidaw_get_recording_length(int id) {
    TrackState* tk = find_track(id);
    if (!tk) return 0;
    return atomic_load(&tk->rec_write_pos);
}
