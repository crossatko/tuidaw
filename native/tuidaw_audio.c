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

// ── WSOLA Constants ─────────────────────────────────────────────────────────
// WSOLA (Waveform Similarity Overlap-Add) for pitch-preserving time stretch.
// Window ~23ms at 48kHz, 50% overlap, ±search range for best alignment.

#define WSOLA_WINDOW     1024       // analysis window size (samples)
#define WSOLA_HOP        512        // output hop size (WSOLA_WINDOW / 2)
#define WSOLA_SEARCH     256        // ±search range for similarity matching
#define WSOLA_OUTBUF_LEN 2048       // circular output buffer per track

// ── Track State ─────────────────────────────────────────────────────────────

// Per-track WSOLA time-stretch state
typedef struct {
    double  input_pos;               // fractional input read position (in source samples)
    float   window_buf[WSOLA_WINDOW]; // Hann-windowed overlap buffer
    float   out_buf[WSOLA_OUTBUF_LEN]; // circular output buffer
    int     out_write;               // write position in out_buf
    int     out_read;                // read position in out_buf
    int     out_avail;               // samples available in out_buf
    int     initialized;             // has been reset for current transport
} WsolaState;

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

    // WSOLA time-stretch state
    WsolaState    wsola;
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

    // Playback speed (1.0 = normal, 0.5 = half speed, 2.0 = double)
    _Atomic float playback_speed;

    // Output device
    int           output_device_index;   // -1 = default
    int           use_null_backend;      // force null (silent) backend for tests

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

// ── WSOLA Helpers ───────────────────────────────────────────────────────────
// Pitch-preserving time stretch using Waveform Similarity Overlap-Add.
// Each track has its own WSOLA state so tracks can be independently stretched.

// Reset WSOLA state for a track (called on transport start or speed change)
static void wsola_reset(WsolaState* ws, double start_pos) {
    ws->input_pos = start_pos;
    ws->out_write = 0;
    ws->out_read = 0;
    ws->out_avail = 0;
    ws->initialized = 1;
    memset(ws->window_buf, 0, sizeof(ws->window_buf));
    memset(ws->out_buf, 0, sizeof(ws->out_buf));
}

// Hann window coefficient for position i in window of size n
static inline float hann(int i, int n) {
    return 0.5f * (1.0f - cosf(2.0f * (float)M_PI * (float)i / (float)(n - 1)));
}

// Read a sample from the track with bounds checking (returns 0 outside range)
static inline float safe_read(const float* samples, int len, long pos) {
    if (pos < 0 || pos >= len) return 0.0f;
    return samples[pos];
}

// Find the best alignment offset within ±WSOLA_SEARCH of the target position
// by maximizing cross-correlation with the previous window tail.
// Returns the offset that gives the best overlap match.
static int wsola_find_best_offset(const float* samples, int len,
                                   long target_pos, const float* prev_tail, int tail_len) {
    int best_offset = 0;
    float best_corr = -1e30f;

    // If no previous tail data, just use target position directly
    if (tail_len <= 0) return 0;

    for (int offset = -WSOLA_SEARCH; offset <= WSOLA_SEARCH; offset++) {
        long pos = target_pos + offset;
        float corr = 0.0f;
        float norm1 = 0.0f;
        float norm2 = 0.0f;

        // Compare tail of previous window with beginning of candidate window
        // Use a subset for speed (every 4th sample)
        for (int i = 0; i < tail_len; i += 4) {
            float s1 = prev_tail[i];
            float s2 = safe_read(samples, len, pos + i);
            corr += s1 * s2;
            norm1 += s1 * s1;
            norm2 += s2 * s2;
        }

        float denom = sqrtf(norm1 * norm2 + 1e-20f);
        float normalized = corr / denom;

        if (normalized > best_corr) {
            best_corr = normalized;
            best_offset = offset;
        }
    }

    return best_offset;
}

// Generate WSOLA output samples for a track. Fills the circular output buffer.
// speed: playback speed (1.0 = normal, <1 = slower, >1 = faster)
// The input position advances by speed * WSOLA_HOP per output hop.
// When loop boundaries are provided (loop_start >= 0), input_pos wraps at
// loop_end back to loop_start so the WSOLA reader stays within the loop region.
static void wsola_generate(WsolaState* ws, const float* samples, int len,
                           float speed, long loop_start, long loop_end) {
    int has_loop = (loop_start >= 0 && loop_end > loop_start);

    // Generate enough output to fill a reasonable amount (at least WSOLA_HOP samples)
    while (ws->out_avail < WSOLA_OUTBUF_LEN - WSOLA_WINDOW) {
        long target_input = (long)ws->input_pos;

        // Wrap input_pos at loop boundary (content-space)
        if (has_loop && target_input >= loop_end) {
            long loop_len = loop_end - loop_start;
            long overshoot = target_input - loop_end;
            ws->input_pos = (double)(loop_start + (overshoot % loop_len));
            target_input = (long)ws->input_pos;
            // Clear overlap buffer on loop wrap to avoid cross-correlation
            // artifacts between end and start of loop
            memset(ws->window_buf, 0, sizeof(ws->window_buf));
        }

        // If we're past the end of the audio (no loop), output silence
        if (target_input >= len) {
            // Write silence to fill buffer
            for (int i = 0; i < WSOLA_HOP; i++) {
                ws->out_buf[ws->out_write] = 0.0f;
                ws->out_write = (ws->out_write + 1) % WSOLA_OUTBUF_LEN;
                ws->out_avail++;
            }
            ws->input_pos += (double)WSOLA_HOP * speed;
            return;
        }

        // Find best alignment by cross-correlating with previous window tail
        // The previous window tail is the second half of window_buf
        int best_offset = wsola_find_best_offset(
            samples, len, target_input,
            ws->window_buf + WSOLA_HOP,  // tail = second half of previous window
            WSOLA_HOP
        );

        long aligned_pos = target_input + best_offset;

        // Extract and window the new segment
        float new_window[WSOLA_WINDOW];
        for (int i = 0; i < WSOLA_WINDOW; i++) {
            new_window[i] = safe_read(samples, len, aligned_pos + i) * hann(i, WSOLA_WINDOW);
        }

        // Overlap-add: first half overlaps with tail of previous window,
        // second half is the new tail for next iteration
        for (int i = 0; i < WSOLA_HOP; i++) {
            // Overlap region: blend previous tail with start of new window
            float blended = ws->window_buf[WSOLA_HOP + i] + new_window[i];
            ws->out_buf[ws->out_write] = blended;
            ws->out_write = (ws->out_write + 1) % WSOLA_OUTBUF_LEN;
            ws->out_avail++;
        }

        // Store new window for next iteration's overlap
        memcpy(ws->window_buf, new_window, sizeof(float) * WSOLA_WINDOW);

        // Advance input position by hop * speed
        // speed < 1: input advances slower → audio stretches (slower playback)
        // speed > 1: input advances faster → audio compresses (faster playback)
        ws->input_pos += (double)WSOLA_HOP * speed;
    }
}

// Read one sample from the WSOLA output buffer
static float wsola_read_sample(WsolaState* ws) {
    if (ws->out_avail <= 0) return 0.0f;
    float s = ws->out_buf[ws->out_read];
    ws->out_read = (ws->out_read + 1) % WSOLA_OUTBUF_LEN;
    ws->out_avail--;
    return s;
}

// ── Playback Callback ───────────────────────────────────────────────────────
// Called on the audio thread. Mixes all tracks + click into the output buffer.
// When playback_speed != 1.0, uses WSOLA for pitch-preserving time stretch.

static void playback_callback(ma_device* pDevice, void* pOutput, const void* pInput, ma_uint32 frameCount) {
    (void)pDevice;
    (void)pInput;

    float* out = (float*)pOutput;
    memset(out, 0, frameCount * 2 * sizeof(float));  // stereo output

    if (!atomic_load(&g_engine.playing)) return;

    long playhead = atomic_load(&g_engine.playhead_samples);
    long loop_start = atomic_load(&g_engine.loop_start);
    long loop_end = atomic_load(&g_engine.loop_end);
    float speed = atomic_load(&g_engine.playback_speed);

    // Clamp speed to sane range
    if (speed < 0.25f) speed = 0.25f;
    if (speed > 2.0f) speed = 2.0f;

    int any_solo = has_any_solo();

    // Click state — click always plays at the current BPM (already adjusted by JS)
    int click_enabled = atomic_load(&g_engine.click_enabled);
    float bpm = atomic_load(&g_engine.click_bpm);
    int samples_per_beat = (bpm > 0) ? (int)(60.0f / bpm * SAMPLE_RATE) : SAMPLE_RATE;

    int use_wsola = (speed < 0.99f || speed > 1.01f);

    // If using WSOLA, ensure all active tracks have initialized state
    if (use_wsola) {
        for (int t = 0; t < MAX_TRACKS; t++) {
            TrackState* tk = &g_engine.tracks[t];
            if (!tk->active) continue;
            if (!tk->wsola.initialized) {
                wsola_reset(&tk->wsola, (double)playhead);
            }
            // Pre-generate WSOLA output for this callback
            // Loop boundaries are passed in content-space so wsola_generate
            // wraps input_pos at loop_end back to loop_start.
            if (tk->samples && tk->samples_len > 0 &&
                !atomic_load(&tk->muted) &&
                !(any_solo && !atomic_load(&tk->solo)) &&
                !atomic_load(&tk->recording)) {
                wsola_generate(&tk->wsola, tk->samples, tk->samples_len,
                               speed, loop_start, loop_end);
            }
        }
    }

    for (ma_uint32 frame = 0; frame < frameCount; frame++) {
        long pos = playhead + (long)frame;

        // Loop handling: wrap position (for click and non-WSOLA playback)
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
            if (atomic_load(&tk->recording)) continue;
            if (!tk->samples || tk->samples_len == 0) continue;

            float sample;
            if (use_wsola) {
                // Read from WSOLA output buffer (pitch-preserved time-stretched audio)
                sample = wsola_read_sample(&tk->wsola);
            } else {
                // Normal playback: direct sample read
                if (pos < 0 || pos >= tk->samples_len) continue;
                sample = tk->samples[pos];
            }

            float vol = atomic_load(&tk->volume);
            float pan = atomic_load(&tk->pan);

            // Equal-power panning
            float left_gain = cosf(((pan + 1.0f) / 2.0f) * (float)(M_PI / 2.0));
            float right_gain = sinf(((pan + 1.0f) / 2.0f) * (float)(M_PI / 2.0));

            left  += sample * vol * left_gain;
            right += sample * vol * right_gain;
        }

        // Click (metronome) — plays at the adjusted BPM rate, uses logical playhead position
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

    if (loop_start >= 0 && loop_end > loop_start) {
        if (use_wsola) {
            // In WSOLA + loop mode, the playhead tracks the WSOLA content
            // position. WSOLA input_pos wraps at loop boundaries internally
            // (in content-space), so we derive the playhead from it.
            // Find the first active non-muted track's WSOLA input_pos.
            for (int t = 0; t < MAX_TRACKS; t++) {
                TrackState* tk = &g_engine.tracks[t];
                if (!tk->active) continue;
                if (atomic_load(&tk->muted)) continue;
                if (atomic_load(&tk->recording)) continue;
                if (!tk->samples || tk->samples_len == 0) continue;
                if (tk->wsola.initialized) {
                    new_playhead = (long)tk->wsola.input_pos;
                    break;
                }
            }
            // Ensure playhead stays within loop bounds
            if (new_playhead >= loop_end) {
                long loop_len = loop_end - loop_start;
                long overshoot = new_playhead - loop_end;
                new_playhead = loop_start + (overshoot % loop_len);
            }
            if (new_playhead < loop_start) {
                new_playhead = loop_start;
            }
        } else {
            // Non-WSOLA loop: wrap playhead at content-space loop boundaries
            if (new_playhead >= loop_end) {
                long loop_len = loop_end - loop_start;
                long overshoot = new_playhead - loop_end;
                new_playhead = loop_start + (overshoot % loop_len);
            }
        }
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
    atomic_store(&g_engine.playback_speed, 1.0f);
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

// Initialize the audio engine with the null (silent) backend.
// Identical to tuidaw_init() but forces ma_backend_null so no audio is played.
// The playback callback still runs on a timer thread, so playhead/WSOLA work normally.
// Intended for automated tests.
EXPORT int tuidaw_init_null(void) {
    memset(&g_engine, 0, sizeof(g_engine));
    atomic_store(&g_engine.loop_start, -1);
    atomic_store(&g_engine.loop_end, -1);
    atomic_store(&g_engine.click_bpm, 120.0f);
    atomic_store(&g_engine.playback_speed, 1.0f);
    g_engine.output_device_index = -1;
    g_engine.use_null_backend = 1;

    ma_backend backends[] = { ma_backend_null };
    ma_context_config ctxConfig = ma_context_config_init();
    if (ma_context_init(backends, 1, &ctxConfig, &g_engine.context) != MA_SUCCESS) {
        return -1;
    }

    // Enumerate devices (will return null backend virtual devices)
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
    // Reset WSOLA states so each track re-syncs to the new position
    for (int i = 0; i < MAX_TRACKS; i++) {
        if (g_engine.tracks[i].active) {
            wsola_reset(&g_engine.tracks[i].wsola, (double)position);
        }
    }
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

// Set playhead position (for scrubbing — works during playback too).
// Resets WSOLA states so all tracks re-sync to the new position.
EXPORT void tuidaw_set_playhead(long position) {
    atomic_store(&g_engine.playhead_samples, position);
    // Reset WSOLA states so each track re-syncs to the new position
    for (int i = 0; i < MAX_TRACKS; i++) {
        if (g_engine.tracks[i].active) {
            wsola_reset(&g_engine.tracks[i].wsola, (double)position);
        }
    }
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

// ── Speed / WSOLA control ───────────────────────────────────────────────────

// Set playback speed ratio (1.0 = normal, 0.5 = half speed, 2.0 = double).
// Clamped to [0.25, 2.0]. WSOLA time-stretch is applied when speed != 1.0.
EXPORT void tuidaw_set_speed(float speed) {
    if (speed < 0.25f) speed = 0.25f;
    if (speed > 2.0f)  speed = 2.0f;
    atomic_store(&g_engine.playback_speed, speed);
}

// Get current playback speed.
EXPORT float tuidaw_get_speed(void) {
    return atomic_load(&g_engine.playback_speed);
}
