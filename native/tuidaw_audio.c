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
#include <strings.h>  // strcasecmp
#include <stdlib.h>
#include <math.h>
#include <stdatomic.h>
#include <dlfcn.h>

// ── JACK API (dynamically loaded via dlopen) ────────────────────────────────
// We load libjack.so.0 at runtime to avoid a hard build/link dependency.
// This allows the binary to work on systems without JACK installed — monitoring
// simply falls back to PulseAudio duplex.
//
// Direct JACK API bypasses miniaudio's JACK backend, which fails for duplex
// devices on PipeWire because miniaudio uses JackPortIsPhysical to find ports,
// and PipeWire's split/filter ports (e.g., Scarlett Inst/Line input) don't have
// that flag. By using jack_get_ports() without JackPortIsPhysical and connecting
// manually, we get working duplex with ~42ms round-trip vs ~68ms via PulseAudio.

// JACK types (minimal subset needed for monitoring)
typedef int32_t jack_nframes_t;
typedef int     jack_options_t;
typedef int     jack_status_t;
typedef float   jack_default_audio_sample_t;
typedef struct _jack_client jack_client_t;
typedef struct _jack_port   jack_port_t;

// JACK constants
#define JACK_DEFAULT_AUDIO_TYPE "32 bit float mono audio"
#define JackPortIsInput   0x1
#define JackPortIsOutput  0x2
#define JackNullOption    0x00
#define JackNoStartServer 0x01

// JACK process callback type
typedef int (*JackProcessCallback)(jack_nframes_t nframes, void* arg);

// JACK function pointer table (loaded via dlopen)
typedef struct {
    void* lib_handle;  // dlopen handle

    jack_client_t* (*client_open)(const char* name, jack_options_t options,
                                  jack_status_t* status);
    int            (*client_close)(jack_client_t* client);
    int            (*activate)(jack_client_t* client);
    int            (*deactivate)(jack_client_t* client);
    jack_nframes_t (*get_sample_rate)(jack_client_t* client);
    jack_nframes_t (*get_buffer_size)(jack_client_t* client);
    jack_port_t*   (*port_register)(jack_client_t* client, const char* name,
                                    const char* type, unsigned long flags,
                                    unsigned long buffer_size);
    int            (*port_unregister)(jack_client_t* client, jack_port_t* port);
    void*          (*port_get_buffer)(jack_port_t* port, jack_nframes_t nframes);
    const char*    (*port_name)(const jack_port_t* port);
    const char**   (*get_ports)(jack_client_t* client, const char* port_name_pattern,
                                const char* type_name_pattern, unsigned long flags);
    int            (*connect)(jack_client_t* client, const char* src, const char* dst);
    int            (*disconnect)(jack_client_t* client, const char* src, const char* dst);
    int            (*set_process_callback)(jack_client_t* client,
                                          JackProcessCallback callback, void* arg);
    void           (*free)(void* ptr);
} JackFunctions;

static JackFunctions g_jack = {0};

// Load JACK library and resolve function pointers.
// Returns 1 on success, 0 if JACK is not available.
static int jack_load(void) {
    if (g_jack.lib_handle) return 1;  // already loaded

    g_jack.lib_handle = dlopen("libjack.so.0", RTLD_NOW | RTLD_LOCAL);
    if (!g_jack.lib_handle) {
        g_jack.lib_handle = dlopen("libjack.so", RTLD_NOW | RTLD_LOCAL);
    }
    if (!g_jack.lib_handle) return 0;

    #define LOAD_SYM(name) \
        g_jack.name = dlsym(g_jack.lib_handle, "jack_" #name); \
        if (!g_jack.name) { dlclose(g_jack.lib_handle); g_jack.lib_handle = NULL; return 0; }

    LOAD_SYM(client_open)
    LOAD_SYM(client_close)
    LOAD_SYM(activate)
    LOAD_SYM(deactivate)
    LOAD_SYM(get_sample_rate)
    LOAD_SYM(get_buffer_size)
    LOAD_SYM(port_register)
    LOAD_SYM(port_unregister)
    LOAD_SYM(port_get_buffer)
    LOAD_SYM(port_name)
    LOAD_SYM(get_ports)
    LOAD_SYM(connect)
    LOAD_SYM(disconnect)
    LOAD_SYM(set_process_callback)
    LOAD_SYM(free)

    #undef LOAD_SYM
    return 1;
}

static void jack_unload(void) {
    if (g_jack.lib_handle) {
        dlclose(g_jack.lib_handle);
        memset(&g_jack, 0, sizeof(g_jack));
    }
}

// ── PipeWire Custom Node Helper ─────────────────────────────────────────────
// Some multi-channel USB devices (e.g. Neural DSP Nano Cortex) produce corrupt
// audio when using PipeWire's pro-audio profile because the auto-generated ALSA
// nodes have api.alsa.auto-link + node.group properties that cause the capture
// and playback nodes to share scheduling, corrupting mmap buffer conversion.
//
// Fix: set the card profile to "off" (destroying the broken nodes), spawn a
// helper process (pw_custom_node) that creates clean ALSA nodes without those
// properties, then proceed with JACK monitoring. The helper must stay alive
// while monitoring is active.
//
// This is only needed on Linux with PipeWire. The helper binary is built
// alongside libtuidaw_audio.so by build.sh.

#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <libgen.h>  // dirname
#include <unistd.h>  // fork, exec, atexit

// State for a custom node helper process associated with a capture device.
// Multiple tracks can share the same helper if they use the same device.
typedef struct {
    pid_t    pid;                     // helper process PID (0 = not running)
    char     card_name[256];          // PulseAudio card name (for profile restore)
    char     alsa_device[32];         // ALSA device path (e.g. "hw:5")
    int      channels;               // number of channels
    int      ref_count;              // number of tracks using this helper
    int      helper_id;              // ID used in node naming (tuidaw-custom-cap-N)
} CustomNodeHelper;

#define MAX_CUSTOM_HELPERS 8
static CustomNodeHelper g_custom_helpers[MAX_CUSTOM_HELPERS];
static int g_custom_helper_count = 0;

// Path to the pw_custom_node binary (resolved relative to the .so at init time)
static char g_helper_path[512] = {0};

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
    int           rec_channel;       // which channel to capture from multi-ch device (0-based, -1 = mono downmix)
    ma_device     rec_device;        // capture device (active only while recording)
    int           rec_device_active; // is rec_device initialized and started

    // Input monitoring state (low-latency full-duplex passthrough)
    _Atomic int   monitoring;        // input monitoring enabled
    ma_device     mon_device;        // full-duplex device for monitoring (PulseAudio fallback)
    int           mon_device_active; // is mon_device initialized and started

    // Direct JACK monitoring state (preferred — ~58ms vs ~68ms PulseAudio)
    jack_client_t* jack_client;      // JACK client for this track's monitoring
    jack_port_t*   jack_capture;     // JACK input port (receives from selected capture device)
    jack_port_t*   jack_playback_L;  // JACK output port (sends to selected output L)
    jack_port_t*   jack_playback_R;  // JACK output port (sends to selected output R)
    int            jack_mon_active;  // is JACK monitoring active

    // Direct JACK recording state (for devices needing custom nodes, without monitoring)
    jack_client_t* jack_rec_client;  // JACK client for capture-only recording
    jack_port_t*   jack_rec_capture; // JACK input port for recording
    int            jack_rec_active;  // is JACK recording client active

    // PipeWire custom node helper for this track's capture device
    CustomNodeHelper* custom_helper; // pointer into g_custom_helpers (NULL if not needed)

    // WSOLA time-stretch state
    WsolaState    wsola;
} TrackState;

// ── Engine State ────────────────────────────────────────────────────────────

typedef struct {
    ma_context    context;
    ma_device     playback_device;
    int           playback_active;

    // Direct JACK API availability (loaded via dlopen at init time).
    // When available, monitoring uses JACK for lower latency (~42ms round-trip)
    // vs PulseAudio fallback (~68ms round-trip).
    int           jack_available;

    TrackState    tracks[MAX_TRACKS];

    _Atomic int   playing;               // transport running
    _Atomic long  playhead_samples;      // current playhead position (in samples)
    long          transport_start_pos;   // playhead position when transport started

    // Click state
    _Atomic int   click_enabled;
    _Atomic float click_volume;           // 0.0 - 2.0+ (allows above 100%)
    _Atomic float click_pan;              // -1.0 (L) to 1.0 (R), 0.0 = center

    // Click sample buffer (owned by native engine — allocated via malloc/realloc).
    // Contains a long pre-rendered click track: click tones (960 samples of
    // 1kHz sine + 20ms decay) placed at correct beat positions, with silence
    // between them. The buffer is generated by tuidaw_generate_click(bpm,
    // duration_frames) and is long enough for the full project duration or
    // 10 minutes (whichever is requested). The native callback reads
    // click_samples[counter] with a bounds check — no modulo, no floating-point
    // BPM math. Beat positions use GCD-exact integer arithmetic for zero drift.
    float*        click_samples;          // owned by C (malloc'd), freed on regenerate/deinit
    _Atomic int   click_samples_len;      // total number of samples in buffer
    int           click_samples_capacity; // allocated capacity (for realloc efficiency)
    _Atomic long  click_frame_counter;    // output frame counter for click timing (reset on play/seek)

    // Loop state
    _Atomic long  loop_start;            // -1 = no loop
    _Atomic long  loop_end;              // -1 = no loop

    // Playback speed (1.0 = normal, 0.5 = half speed, 2.0 = double)
    _Atomic float playback_speed;

    // Output device
    int           output_device_index;   // -1 = default (requested)
    int           active_device_index;   // -1 = default (currently active on playback_device)
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
// Called on the audio thread. Mixes all tracks + click + monitoring into the output buffer.
// When playback_speed != 1.0, uses WSOLA for pitch-preserving time stretch.
//
// Click is now a pre-baked buffer (one full beat: tone + silence) owned
// by JS. The native engine reads it with simple integer modulo
// (counter % buffer_length) — no BPM math in the callback, no fmod,
// no floating-point precision issues. When BPM changes, JS regenerates
// the buffer with a new length.

static void playback_callback(ma_device* pDevice, void* pOutput, const void* pInput, ma_uint32 frameCount) {
    (void)pDevice;
    (void)pInput;

    float* out = (float*)pOutput;
    memset(out, 0, frameCount * 2 * sizeof(float));  // stereo output

    int is_playing = atomic_load(&g_engine.playing);

    long playhead = 0;
    long loop_start = -1;
    long loop_end = -1;
    float speed = 1.0f;
    int any_solo = 0;
    int click_enabled = 0;
    float click_vol = 0.0f;
    float click_pan = 0.0f;
    float* click_samples = NULL;
    int click_samples_len = 0;
    int use_wsola = 0;

    if (is_playing) {
        playhead = atomic_load(&g_engine.playhead_samples);
        loop_start = atomic_load(&g_engine.loop_start);
        loop_end = atomic_load(&g_engine.loop_end);
        speed = atomic_load(&g_engine.playback_speed);

        // Clamp speed to sane range
        if (speed < 0.25f) speed = 0.25f;
        if (speed > 2.0f) speed = 2.0f;

        any_solo = has_any_solo();

        // Click state
        click_enabled = atomic_load(&g_engine.click_enabled);
        click_vol = atomic_load(&g_engine.click_volume);
        click_pan = atomic_load(&g_engine.click_pan);
        click_samples = g_engine.click_samples;
        click_samples_len = atomic_load(&g_engine.click_samples_len);

        use_wsola = (speed < 0.99f || speed > 1.01f);

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
    }

    for (ma_uint32 frame = 0; frame < frameCount; frame++) {
        float left = 0.0f;
        float right = 0.0f;

        // Track mixing + click only when transport is playing
        if (is_playing) {
            long pos = playhead + (long)frame;

            // Loop handling: wrap position (for non-WSOLA playback)
            if (loop_start >= 0 && loop_end > loop_start && pos >= loop_end) {
                long loop_len = loop_end - loop_start;
                long overshoot = pos - loop_end;
                pos = loop_start + (overshoot % loop_len);
            }

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

            // Click (metronome) — pre-rendered long buffer in OUTPUT-SPACE.
            // The click_samples buffer contains the full click track: click tones
            // placed at exact beat positions (at display BPM) with silence between.
            // We index by click_frame_counter (output-space time).
            // On loop wrap, the counter is reset to correspond to loop_start.
            if (click_enabled && click_samples && click_samples_len > 0) {
                long counter = atomic_load(&g_engine.click_frame_counter) + (long)frame;
                if (counter >= 0 && counter < (long)click_samples_len) {
                    float click_sample = click_samples[counter] * click_vol;

                    // Equal-power panning for click
                    float cl_left  = cosf(((click_pan + 1.0f) / 2.0f) * (float)(M_PI / 2.0));
                    float cl_right = sinf(((click_pan + 1.0f) / 2.0f) * (float)(M_PI / 2.0));
                    left  += click_sample * cl_left;
                    right += click_sample * cl_right;
                }
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

    // Advance playhead + click counter only when transport is playing
    if (is_playing) {
        // Advance playhead.
        // All coordinates are in content-space (source sample positions).
        // When WSOLA is active, the playhead tracks wsola.input_pos which
        // advances at speed * hop per output hop — so at 0.5x speed, the
        // playhead advances half as fast through the source material.
        // When WSOLA is not active, playhead == wall-clock == content-space
        // (since speed is 1.0).
        long new_playhead;

        if (use_wsola) {
            // Derive playhead from WSOLA input_pos (content-space).
            // This ensures playhead always tracks the actual source position
            // being read, regardless of speed.
            new_playhead = playhead + (long)frameCount; // fallback
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

            // Handle loop wrapping (input_pos is already wrapped by wsola_generate,
            // but clamp to be safe if it overshoots)
            if (loop_start >= 0 && loop_end > loop_start) {
                if (new_playhead >= loop_end) {
                    long loop_len = loop_end - loop_start;
                    long overshoot = new_playhead - loop_end;
                    new_playhead = loop_start + (overshoot % loop_len);
                }
                // NOTE: Do NOT clamp new_playhead to loop_start when it's before
                // the loop region. If the user seeks before the loop, playback
                // should advance linearly until reaching loopEnd, then wrap.
            }
        } else {
            // No WSOLA (speed == 1.0): playhead advances in real-time
            // which equals content-space when speed is 1.0
            new_playhead = playhead + (long)frameCount;

            if (loop_start >= 0 && loop_end > loop_start) {
                if (new_playhead >= loop_end) {
                    long loop_len = loop_end - loop_start;
                    long overshoot = new_playhead - loop_end;
                    new_playhead = loop_start + (overshoot % loop_len);
                }
            }
        }

        // Advance click counter with loop-wrap handling.
        // The click counter is ABSOLUTE output-space (content position / speed).
        // The click buffer contains tones at GCD-exact beat positions in output-space.
        //
        // On loop: the click counter wraps when it reaches the output-space position
        // corresponding to loop_end in content-space. Since the counter is absolute:
        //   output_end = loop_end / speed
        //   output_start = loop_start / speed
        // The counter wraps from output_end back to output_start, so the click
        // re-aligns with the content beat grid on each loop iteration.
        //
        // We detect the wrap from the counter itself (not from playhead comparison),
        // because WSOLA look-ahead can cause the playhead to wrap before the output
        // actually reaches the loop boundary.
        if (click_enabled) {
            long old_counter = atomic_load(&g_engine.click_frame_counter);
            long new_counter = old_counter + (long)frameCount;

            if (loop_start >= 0 && loop_end > loop_start && speed > 0.01f) {
                double loop_output_end = (double)loop_end / (double)speed;
                double loop_output_start = (double)loop_start / (double)speed;
                double loop_output_len = loop_output_end - loop_output_start;

                if (loop_output_len > 0 && (double)new_counter >= loop_output_end) {
                    // Wrap counter to loop start, preserving fractional overshoot
                    double overshoot = (double)new_counter - loop_output_end;
                    double wrapped = loop_output_start + fmod(overshoot, loop_output_len);
                    new_counter = (long)(wrapped + 0.5);
                }
            }

            atomic_store(&g_engine.click_frame_counter, new_counter);
        }

        atomic_store(&g_engine.playhead_samples, new_playhead);
    }
}

// ── Capture Callback (per-track recording) ──────────────────────────────────

static _Atomic int capture_diag_counter = 0; // diagnostic: counts callbacks

static void capture_callback(ma_device* pDevice, void* pOutput, const void* pInput, ma_uint32 frameCount) {
    (void)pOutput;

    TrackState* tk = (TrackState*)pDevice->pUserData;
    if (!tk || !atomic_load(&tk->recording) || !tk->rec_buffer) return;

    const float* input = (const float*)pInput;
    int write_pos = atomic_load(&tk->rec_write_pos);
    int channels = (int)pDevice->capture.channels;
    int sel_ch = tk->rec_channel; // -1 = mono downmix, >=0 = specific channel

    // Diagnostic: log first few callbacks to file
    int diag = atomic_fetch_add(&capture_diag_counter, 1);
    if (diag < 5) {
        FILE* f = fopen("debug/capture.log", "a");
        if (f) {
            float peak_all = 0.0f;
            float peak_ch = 0.0f;
            for (ma_uint32 s = 0; s < frameCount * channels && s < 256; s++) {
                float v = input[s] < 0 ? -input[s] : input[s];
                if (v > peak_all) peak_all = v;
            }
            // Also measure peak of the selected channel specifically
            if (sel_ch >= 0 && sel_ch < channels) {
                for (ma_uint32 i = 0; i < frameCount; i++) {
                    float v = input[i * channels + sel_ch];
                    if (v < 0) v = -v;
                    if (v > peak_ch) peak_ch = v;
                }
            }
            fprintf(f, "capture_cb #%d: frames=%u channels=%d sel_ch=%d write_pos=%d peak_all=%.6f peak_sel_ch=%.6f\n",
                    diag, frameCount, channels, sel_ch, write_pos, peak_all, peak_ch);
            fclose(f);
        }
    }

    for (ma_uint32 i = 0; i < frameCount; i++) {
        if (write_pos >= RECORDING_BUF_LEN) break;
        if (sel_ch >= 0 && sel_ch < channels) {
            // Extract specific channel from interleaved multi-channel data
            tk->rec_buffer[write_pos] = input[i * channels + sel_ch];
        } else if (channels == 1) {
            tk->rec_buffer[write_pos] = input[i];
        } else {
            // Mono downmix: average all channels
            float sum = 0.0f;
            for (int ch = 0; ch < channels; ch++) {
                sum += input[i * channels + ch];
            }
            tk->rec_buffer[write_pos] = sum / channels;
        }
        write_pos++;
    }

    atomic_store(&tk->rec_write_pos, write_pos);
}

// ── Full-Duplex Monitor Callback (zero-latency input passthrough) ───────────
// In a full-duplex device, pInput and pOutput are provided in the SAME callback
// invocation. We copy captured audio directly to the output buffer with
// volume/pan applied. This eliminates all ring buffer latency — the only delay
// is the device's own period size.

static void duplex_monitor_callback(ma_device* pDevice, void* pOutput, const void* pInput, ma_uint32 frameCount) {
    TrackState* tk = (TrackState*)pDevice->pUserData;
    if (!tk || !atomic_load(&tk->monitoring)) {
        // Output silence
        memset(pOutput, 0, frameCount * 2 * sizeof(float));
        return;
    }

    const float* input = (const float*)pInput;
    float* output = (float*)pOutput;

    float vol = atomic_load(&tk->volume);
    float pan = atomic_load(&tk->pan);
    float left_gain  = cosf(((pan + 1.0f) / 2.0f) * (float)(M_PI / 2.0));
    float right_gain = sinf(((pan + 1.0f) / 2.0f) * (float)(M_PI / 2.0));

    int cap_channels = (int)pDevice->capture.channels;
    int sel_ch = tk->rec_channel;

    for (ma_uint32 i = 0; i < frameCount; i++) {
        float sample;
        if (cap_channels > 1 && sel_ch >= 0 && sel_ch < cap_channels) {
            // Extract specific channel from interleaved multi-channel input
            sample = input[i * cap_channels + sel_ch] * vol;
        } else if (cap_channels > 1) {
            // Mono downmix of all channels
            float sum = 0.0f;
            for (int c = 0; c < cap_channels; c++) {
                sum += input[i * cap_channels + c];
            }
            sample = (sum / cap_channels) * vol;
        } else {
            sample = input[i] * vol;
        }
        output[i * 2 + 0] = sample * left_gain;
        output[i * 2 + 1] = sample * right_gain;
    }
}

// ── JACK Monitor Process Callback ───────────────────────────────────────────
// Direct JACK API process callback for input monitoring. Receives mono capture
// audio and outputs stereo with volume/pan applied. Same logic as the miniaudio
// duplex callback above, but uses JACK port buffers directly.

static int jack_monitor_process(jack_nframes_t nframes, void* arg) {
    TrackState* tk = (TrackState*)arg;
    if (!tk) return 0;

    float* in = (float*)g_jack.port_get_buffer(tk->jack_capture, nframes);
    float* out_L = (float*)g_jack.port_get_buffer(tk->jack_playback_L, nframes);
    float* out_R = (float*)g_jack.port_get_buffer(tk->jack_playback_R, nframes);

    if (!atomic_load(&tk->monitoring)) {
        memset(out_L, 0, nframes * sizeof(float));
        memset(out_R, 0, nframes * sizeof(float));
        return 0;
    }

    float vol = atomic_load(&tk->volume);
    float pan = atomic_load(&tk->pan);
    float left_gain  = cosf(((pan + 1.0f) / 2.0f) * (float)(M_PI / 2.0));
    float right_gain = sinf(((pan + 1.0f) / 2.0f) * (float)(M_PI / 2.0));

    for (jack_nframes_t i = 0; i < nframes; i++) {
        float sample = in[i] * vol;
        out_L[i] = sample * left_gain;
        out_R[i] = sample * right_gain;
    }

    // If the track is recording, also capture the raw input into the recording
    // buffer. This handles the case where the PulseAudio device is unavailable
    // (card profile set to "off" for custom node workaround).
    if (atomic_load(&tk->recording) && tk->rec_buffer) {
        int write_pos = atomic_load(&tk->rec_write_pos);
        for (jack_nframes_t i = 0; i < nframes; i++) {
            if (write_pos >= RECORDING_BUF_LEN) break;
            tk->rec_buffer[write_pos++] = in[i];
        }
        atomic_store(&tk->rec_write_pos, write_pos);
    }

    return 0;
}

// ── JACK Record-Only Process Callback ───────────────────────────────────────
// Used for recording from devices that need custom ALSA nodes (multi-channel
// USB devices with corrupted auto-link nodes) when monitoring is NOT active.
// Capture only — no output ports, no playback routing.

static int jack_rec_process(jack_nframes_t nframes, void* arg) {
    TrackState* tk = (TrackState*)arg;
    if (!tk) return 0;

    if (!atomic_load(&tk->recording) || !tk->rec_buffer) return 0;

    float* in = (float*)g_jack.port_get_buffer(tk->jack_rec_capture, nframes);
    int write_pos = atomic_load(&tk->rec_write_pos);
    for (jack_nframes_t i = 0; i < nframes; i++) {
        if (write_pos >= RECORDING_BUF_LEN) break;
        tk->rec_buffer[write_pos++] = in[i];
    }
    atomic_store(&tk->rec_write_pos, write_pos);

    return 0;
}

// ── PipeWire Custom Node Helper Management ──────────────────────────────────

// Resolve the path to the pw_custom_node helper binary.
// It's expected to be in the same directory as libtuidaw_audio.so.
static void resolve_helper_path(void) {
    if (g_helper_path[0]) return;  // already resolved

    // Try to find our .so via /proc/self/maps (Linux-specific)
    FILE* f = fopen("/proc/self/maps", "r");
    if (f) {
        char line[1024];
        while (fgets(line, sizeof(line), f)) {
            if (strstr(line, "libtuidaw_audio")) {
                // Extract path: format is "addr-addr perms offset dev inode pathname"
                char* path_start = strchr(line, '/');
                if (path_start) {
                    char* nl = strchr(path_start, '\n');
                    if (nl) *nl = '\0';
                    // Get directory of the .so
                    char so_path[512];
                    strncpy(so_path, path_start, sizeof(so_path) - 1);
                    so_path[sizeof(so_path) - 1] = '\0';
                    char* dir = dirname(so_path);
                    snprintf(g_helper_path, sizeof(g_helper_path),
                             "%s/pw_custom_node", dir);
                    break;
                }
            }
        }
        fclose(f);
    }

    // Fallback: try relative to CWD
    if (!g_helper_path[0]) {
        strncpy(g_helper_path, "native/pw_custom_node", sizeof(g_helper_path) - 1);
    }
}

// Check if the pw_custom_node helper binary exists and is executable.
static int helper_available(void) {
    resolve_helper_path();
    return access(g_helper_path, X_OK) == 0;
}

// Determine if a capture device needs the custom node workaround.
// Returns 1 if the device is a multi-channel (>2) USB device using
// PipeWire's pro-audio profile (which has the auto-link corruption bug).
// Writes the ALSA card name and device path to the output params.
//
// Detection strategy: parse the PulseAudio stable device ID string.
// Pro-audio profile devices have IDs like:
//   "alsa_input.usb-Neural_DSP_Nano_Cortex_NA00AF103-00.pro-input-0"
// The card name would be:
//   "alsa_card.usb-Neural_DSP_Nano_Cortex_NA00AF103-00"
static int device_needs_custom_node(int cap_device_index,
                                     char* out_card_name, int card_name_len,
                                     char* out_alsa_device, int alsa_device_len,
                                     int* out_channels) {
    if (cap_device_index < 0 || (ma_uint32)cap_device_index >= g_engine.capture_count)
        return 0;

    // Check channel count — only multi-channel devices have this issue
    int channels = 0;
    {
        ma_device_info detailed;
        if (ma_context_get_device_info(&g_engine.context, ma_device_type_capture,
                &g_engine.capture_infos[cap_device_index].id, &detailed) == MA_SUCCESS) {
            if (detailed.nativeDataFormatCount > 0)
                channels = (int)detailed.nativeDataFormats[0].channels;
        }
    }
    if (channels <= 2) return 0;  // stereo devices don't have this issue

    // Check if the PulseAudio device ID indicates pro-audio profile
    const char* pulse_id = g_engine.capture_infos[cap_device_index].id.pulse;
    if (!strstr(pulse_id, ".pro-")) return 0;  // not pro-audio profile

    // Extract the card name from the device ID
    // "alsa_input.usb-Foo_Bar-00.pro-input-0" → "alsa_card.usb-Foo_Bar-00"
    const char* usb_start = strstr(pulse_id, "usb-");
    if (!usb_start) return 0;

    // Find the ".pro-" suffix to get the bus-id part
    const char* pro_start = strstr(usb_start, ".pro-");
    if (!pro_start) return 0;

    int bus_id_len = (int)(pro_start - usb_start);
    char bus_id[256] = {0};
    if (bus_id_len > 255) bus_id_len = 255;
    strncpy(bus_id, usb_start, bus_id_len);

    snprintf(out_card_name, card_name_len, "alsa_card.%s", bus_id);

    // Get the ALSA card number by running pactl
    // We parse: api.alsa.card = "5" from pactl list cards
    // Use fork/exec instead of popen to avoid signal interference.
    {
        int card_pipe[2];
        if (pipe(card_pipe) == 0) {
            pid_t cpid = fork();
            if (cpid == 0) {
                close(card_pipe[0]);
                dup2(card_pipe[1], STDOUT_FILENO);
                close(card_pipe[1]);
                int devnull = open("/dev/null", O_WRONLY);
                if (devnull >= 0) { dup2(devnull, STDERR_FILENO); close(devnull); }
                char cmd[512];
                snprintf(cmd, sizeof(cmd),
                         "pactl list cards 2>/dev/null | grep -A 50 'Name: %s' | grep 'api.alsa.card =' | head -1",
                         out_card_name);
                execl("/bin/sh", "sh", "-c", cmd, (char*)NULL);
                _exit(127);
            } else if (cpid > 0) {
                close(card_pipe[1]);
                char line[256] = {0};
                ssize_t nr = read(card_pipe[0], line, sizeof(line) - 1);
                close(card_pipe[0]);
                waitpid(cpid, NULL, 0);
                if (nr > 0) {
                    line[nr] = '\0';
                    char* eq = strstr(line, "= \"");
                    if (eq) {
                        int card_num = atoi(eq + 3);
                        snprintf(out_alsa_device, alsa_device_len, "hw:%d", card_num);
                    }
                }
            } else {
                close(card_pipe[0]);
                close(card_pipe[1]);
            }
        }
    }

    if (!out_alsa_device[0]) return 0;  // couldn't determine ALSA device

    if (out_channels) *out_channels = channels;
    return 1;
}

// Run a command via fork/exec/waitpid without using system() or popen(),
// which can interfere with signal handling in the parent process.
// Returns the exit status (0 = success).
static int run_command(const char* cmd) {
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        // Child: redirect stdout/stderr to /dev/null
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) {
            dup2(devnull, STDOUT_FILENO);
            dup2(devnull, STDERR_FILENO);
            close(devnull);
        }
        execl("/bin/sh", "sh", "-c", cmd, (char*)NULL);
        _exit(127);
    }
    int status = 0;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

// Find or create a custom node helper for the given capture device.
// If a helper is already running for this card, increment its ref count.
// Otherwise, spawn a new helper process.
// Returns a pointer to the helper, or NULL on failure.
static CustomNodeHelper* acquire_custom_helper(int cap_device_index) {
    char card_name[256] = {0};
    char alsa_device[32] = {0};
    int channels = 0;

    if (!device_needs_custom_node(cap_device_index, card_name, sizeof(card_name),
                                   alsa_device, sizeof(alsa_device), &channels))
        return NULL;

    if (!helper_available()) return NULL;

    // Check if we already have a helper for this card (even if ref_count is 0 —
    // the helper stays alive between monitoring toggles to avoid the profile-switch
    // race condition)
    for (int i = 0; i < g_custom_helper_count; i++) {
        if (g_custom_helpers[i].pid > 0 &&
            strcmp(g_custom_helpers[i].card_name, card_name) == 0) {
            g_custom_helpers[i].ref_count++;
            FILE* f = fopen("debug/monitor.log", "a");
            if (f) {
                fprintf(f, "  acquire_custom_helper: reusing existing helper pid=%d ref_count=%d\n",
                        g_custom_helpers[i].pid, g_custom_helpers[i].ref_count);
                fclose(f);
            }
            return &g_custom_helpers[i];
        }
    }

    // Need to spawn a new helper
    if (g_custom_helper_count >= MAX_CUSTOM_HELPERS) return NULL;

    CustomNodeHelper* h = &g_custom_helpers[g_custom_helper_count];

    // Step 1: Set card profile to "off" to destroy the broken auto-linked nodes
    {
        char cmd[512];
        snprintf(cmd, sizeof(cmd), "pactl set-card-profile %s off", card_name);
        int ret = run_command(cmd);
        if (ret != 0) {
            // Profile switch failed — device may not support it
            FILE* f = fopen("debug/monitor.log", "a");
            if (f) {
                fprintf(f, "  pactl set-card-profile off FAILED (ret=%d)\n", ret);
                fclose(f);
            }
            return NULL;
        }
    }

    // Brief delay for PipeWire to process the profile change
    usleep(100000);  // 100ms

    // Step 2: Spawn the helper process
    int pipefd[2];
    if (pipe(pipefd) != 0) {
        // Restore profile on failure
        char cmd[512];
        snprintf(cmd, sizeof(cmd), "pactl set-card-profile %s pro-audio 2>/dev/null", card_name);
        run_command(cmd);
        return NULL;
    }

    pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        char cmd[512];
        snprintf(cmd, sizeof(cmd), "pactl set-card-profile %s pro-audio 2>/dev/null", card_name);
        run_command(cmd);
        return NULL;
    }

    if (pid == 0) {
        // Child process
        close(pipefd[0]);  // close read end
        dup2(pipefd[1], STDOUT_FILENO);  // redirect stdout to pipe
        close(pipefd[1]);

        // Redirect stderr to /dev/null to avoid polluting the terminal
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) {
            dup2(devnull, STDERR_FILENO);
            close(devnull);
        }

        // NOTE: Do NOT set PIPEWIRE_LATENCY here. The custom nodes already
        // have node.latency + api.alsa.period-size for ALSA-level buffering.
        // Forcing a low graph quantum (256) causes PipeWire to deliver stale
        // (duplicated) buffers to the JACK client — the standalone capture
        // test at default quantum produced clean audio.

        char ch_str[8];
        snprintf(ch_str, sizeof(ch_str), "%d", channels);
        char id_str[8];
        snprintf(id_str, sizeof(id_str), "%d", g_custom_helper_count);

        execl(g_helper_path, "pw_custom_node",
              "--device", alsa_device,
              "--channels", ch_str,
              "--track-id", id_str,
              "--card", card_name,
              (char*)NULL);

        // If execl fails
        _exit(127);
    }

    // Parent process
    close(pipefd[1]);  // close write end

    // Wait for "READY" from the helper (with timeout)
    char buf[64] = {0};
    int ready = 0;

    // Set pipe to non-blocking for timeout
    int flags = fcntl(pipefd[0], F_GETFL, 0);
    fcntl(pipefd[0], F_SETFL, flags | O_NONBLOCK);

    // Wait up to 3 seconds for READY
    for (int attempt = 0; attempt < 60; attempt++) {
        ssize_t n = read(pipefd[0], buf, sizeof(buf) - 1);
        if (n > 0) {
            buf[n] = '\0';
            if (strstr(buf, "READY")) {
                ready = 1;
                break;
            }
        }
        usleep(50000);  // 50ms
    }

    close(pipefd[0]);

    if (!ready) {
        // Helper didn't become ready — kill it and restore profile
        kill(pid, SIGTERM);
        waitpid(pid, NULL, 0);
        char cmd[512];
        snprintf(cmd, sizeof(cmd), "pactl set-card-profile %s pro-audio 2>/dev/null", card_name);
        run_command(cmd);

        FILE* f = fopen("debug/monitor.log", "a");
        if (f) {
            fprintf(f, "  pw_custom_node helper did not become ready\n");
            fclose(f);
        }
        return NULL;
    }

    // Wait for JACK ports to appear (the custom nodes need a moment to register)
    usleep(300000);  // 300ms

    // Success — save state
    strncpy(h->card_name, card_name, sizeof(h->card_name) - 1);
    strncpy(h->alsa_device, alsa_device, sizeof(h->alsa_device) - 1);
    h->channels = channels;
    h->helper_id = g_custom_helper_count;  // matches --track-id arg
    h->pid = pid;
    h->ref_count = 1;
    g_custom_helper_count++;

    FILE* f = fopen("debug/monitor.log", "a");
    if (f) {
        fprintf(f, "  custom node helper started: pid=%d card=%s dev=%s ch=%d\n",
                pid, card_name, alsa_device, channels);
        fclose(f);
    }

    return h;
}

// Release a custom node helper. Decrements ref count. Does NOT kill the
// process — the helper stays alive so it can be reused without the
// profile-toggle race condition. Use kill_custom_helper() to actually
// terminate the process (called from track removal / engine shutdown).
static void release_custom_helper(CustomNodeHelper* h) {
    if (!h || h->pid <= 0) return;

    if (h->ref_count > 0)
        h->ref_count--;

    FILE* f = fopen("debug/monitor.log", "a");
    if (f) {
        fprintf(f, "  release_custom_helper: pid=%d ref_count=%d (kept alive)\n",
                h->pid, h->ref_count);
        fclose(f);
    }
}

// Actually kill a custom node helper process and restore the card profile.
// Called from track removal and engine shutdown — NOT from monitoring toggle.
static void kill_custom_helper(CustomNodeHelper* h) {
    if (!h || h->pid <= 0) return;

    kill(h->pid, SIGTERM);
    waitpid(h->pid, NULL, 0);

    FILE* f = fopen("debug/monitor.log", "a");
    if (f) {
        fprintf(f, "  kill_custom_helper: pid=%d card=%s (killed + restoring profile)\n",
                h->pid, h->card_name);
        fclose(f);
    }

    h->pid = 0;
    h->ref_count = 0;

    // Restore the card profile
    char cmd[512];
    snprintf(cmd, sizeof(cmd), "pactl set-card-profile %s pro-audio 2>/dev/null", h->card_name);
    run_command(cmd);
}

// Find the custom node helper associated with a capture device index.
static CustomNodeHelper* find_helper_for_device(int cap_device_index) {
    if (cap_device_index < 0 || (ma_uint32)cap_device_index >= g_engine.capture_count)
        return NULL;

    // Extract card name from device ID
    const char* pulse_id = g_engine.capture_infos[cap_device_index].id.pulse;
    const char* usb_start = strstr(pulse_id, "usb-");
    if (!usb_start) return NULL;
    const char* pro_start = strstr(usb_start, ".pro-");
    if (!pro_start) return NULL;

    char card_name[256];
    int bus_id_len = (int)(pro_start - usb_start);
    char bus_id[256] = {0};
    if (bus_id_len > 255) bus_id_len = 255;
    strncpy(bus_id, usb_start, bus_id_len);
    snprintf(card_name, sizeof(card_name), "alsa_card.%s", bus_id);

    for (int i = 0; i < g_custom_helper_count; i++) {
        if (g_custom_helpers[i].pid > 0 &&
            strcmp(g_custom_helpers[i].card_name, card_name) == 0) {
            return &g_custom_helpers[i];
        }
    }
    return NULL;
}

// Cleanup all custom node helpers (called on engine shutdown).
static void cleanup_all_helpers(void) {
    for (int i = 0; i < g_custom_helper_count; i++) {
        if (g_custom_helpers[i].pid > 0) {
            kill_custom_helper(&g_custom_helpers[i]);
        }
    }
    g_custom_helper_count = 0;
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
    atomic_store(&g_engine.click_volume, 0.5f);
    atomic_store(&g_engine.click_pan, 0.0f);
    atomic_store(&g_engine.click_samples_len, 0);
    g_engine.click_samples = NULL;
    atomic_store(&g_engine.click_frame_counter, 0L);
    atomic_store(&g_engine.playback_speed, 1.0f);
    g_engine.output_device_index = -1;
    g_engine.active_device_index = -1;

    // Register atexit handler to clean up custom node helpers if the process
    // exits without calling tuidaw_deinit(). This ensures the card profile is
    // restored even on unexpected exit (the helper process itself also has
    // PR_SET_PDEATHSIG as a further safety net).
    atexit(cleanup_all_helpers);

    ma_context_config ctxConfig = ma_context_config_init();
    if (ma_context_init(NULL, 0, &ctxConfig, &g_engine.context) != MA_SUCCESS) {
        return -1;
    }

    // Try to load JACK library for low-latency monitoring.
    // Direct JACK API gives ~42ms round-trip vs PulseAudio's ~68ms.
    // If JACK is unavailable, monitoring falls back to PulseAudio duplex.
    g_engine.jack_available = jack_load();

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
    atomic_store(&g_engine.click_volume, 0.5f);
    atomic_store(&g_engine.click_pan, 0.0f);
    atomic_store(&g_engine.click_samples_len, 0);
    g_engine.click_samples = NULL;
    atomic_store(&g_engine.click_frame_counter, 0L);
    atomic_store(&g_engine.playback_speed, 1.0f);
    g_engine.output_device_index = -1;
    g_engine.active_device_index = -1;
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

    // Free click buffer (owned by native engine)
    atomic_store(&g_engine.click_samples_len, 0);
    // Free click buffer only if native-owned (capacity > 0 means we malloc'd it)
    if (g_engine.click_samples && g_engine.click_samples_capacity > 0) {
        free(g_engine.click_samples);
    }
    g_engine.click_samples = NULL;
    g_engine.click_samples_capacity = 0;

    // Stop and free all recording and monitoring devices
    for (int i = 0; i < MAX_TRACKS; i++) {
        TrackState* tk = &g_engine.tracks[i];
        atomic_store(&tk->monitoring, 0);
        atomic_store(&tk->recording, 0);
        // Clean up JACK monitoring
        if (tk->jack_mon_active && g_jack.lib_handle) {
            g_jack.deactivate(tk->jack_client);
            g_jack.client_close(tk->jack_client);
            tk->jack_client = NULL;
            tk->jack_mon_active = 0;
        }
        // Clean up JACK recording
        if (tk->jack_rec_active && g_jack.lib_handle) {
            g_jack.deactivate(tk->jack_rec_client);
            g_jack.client_close(tk->jack_rec_client);
            tk->jack_rec_client = NULL;
            tk->jack_rec_active = 0;
        }
        // Clean up PulseAudio monitoring fallback
        if (tk->mon_device_active) {
            ma_device_uninit(&tk->mon_device);
            tk->mon_device_active = 0;
        }
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

    // Clean up any remaining custom node helpers (kill processes, restore profiles)
    cleanup_all_helpers();

    // Unload JACK library
    if (g_engine.jack_available) {
        jack_unload();
        g_engine.jack_available = 0;
    }
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

// Get the stable PulseAudio device ID string.
// For PulseAudio backend, this is a stable name like
// "alsa_input.usb-Neural_DSP_Nano_Cortex_NA00AF103-00.pro-input-0".
// Writes into the provided buffer. Returns 0 on success.
EXPORT int tuidaw_get_device_id(int type, int index, char* out_id, int max_len) {
    ma_device_info* infos;
    ma_uint32 count;
    if (type == 0) {
        infos = g_engine.playback_infos;
        count = g_engine.playback_count;
    } else {
        infos = g_engine.capture_infos;
        count = g_engine.capture_count;
    }
    if (index < 0 || (ma_uint32)index >= count || max_len < 1) return -1;
    // The ma_device_id union's pulse member is a char[256] with the stable name
    strncpy(out_id, infos[index].id.pulse, max_len - 1);
    out_id[max_len - 1] = '\0';
    return 0;
}

// Get the native channel count for a device.
// Returns channel count on success, 0 on failure.
EXPORT int tuidaw_get_device_channels(int type, int index) {
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

    // ma_context_get_devices() only returns basic info — nativeDataFormats
    // may not be populated for PulseAudio devices. Do a full device info
    // query to get the actual native channel count.
    ma_device_info detailed;
    ma_device_type devType = (type == 0) ? ma_device_type_playback : ma_device_type_capture;
    if (ma_context_get_device_info(&g_engine.context, devType, &infos[index].id, &detailed) == MA_SUCCESS) {
        if (detailed.nativeDataFormatCount > 0 && detailed.nativeDataFormats[0].channels > 0) {
            return (int)detailed.nativeDataFormats[0].channels;
        }
    }

    // Fallback: try the cached info (may be 0)
    return (int)infos[index].nativeDataFormats[0].channels;
}

// Find a device by its stable PulseAudio ID string.
// Returns the array index, or -1 if not found.
EXPORT int tuidaw_find_device_by_id(int type, const char* device_id) {
    ma_device_info* infos;
    ma_uint32 count;
    if (type == 0) {
        infos = g_engine.playback_infos;
        count = g_engine.playback_count;
    } else {
        infos = g_engine.capture_infos;
        count = g_engine.capture_count;
    }
    for (ma_uint32 i = 0; i < count; i++) {
        if (strcmp(infos[i].id.pulse, device_id) == 0) return (int)i;
    }
    return -1;
}

// Get the name of the audio backend in use (e.g. "ALSA", "PulseAudio", "JACK").
// Writes into the provided buffer. Returns 0 on success.
EXPORT int tuidaw_get_backend_name(char* out_name, int max_len) {
    const char* name = ma_get_backend_name(g_engine.context.backend);
    if (!name) return -1;
    strncpy(out_name, name, max_len - 1);
    out_name[max_len - 1] = '\0';
    return 0;
}

// Set the output device index. -1 = default.
// Takes effect on next tuidaw_start_playback_device() call.
EXPORT void tuidaw_set_output_device(int index) {
    g_engine.output_device_index = index;
}

// Get the currently active output device index (-1 = default).
// This is the device that was used when tuidaw_start_playback_device() last succeeded.
EXPORT int tuidaw_get_active_device_index(void) {
    return g_engine.active_device_index;
}

// ── Playback Device Management ──────────────────────────────────────────────

// Start (or restart) the playback device. Must be called before playing.
// Returns 0 on success.
EXPORT int tuidaw_start_playback_device(void) {
    // If already active, stop first
    if (g_engine.playback_active) {
        ma_device_uninit(&g_engine.playback_device);
        g_engine.playback_active = 0;
        g_engine.active_device_index = -1;
    }

    ma_device_config config = ma_device_config_init(ma_device_type_playback);
    config.playback.format   = ma_format_f32;
    config.playback.channels = 2;
    config.sampleRate        = SAMPLE_RATE;
    config.dataCallback      = playback_callback;
    config.periodSizeInFrames = 128;  // ~2.7ms latency
    config.periods = 2;               // double-buffer (default is 3)

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
    g_engine.active_device_index = g_engine.output_device_index;
    return 0;
}

// Stop the playback device.
EXPORT void tuidaw_stop_playback_device(void) {
    if (g_engine.playback_active) {
        ma_device_uninit(&g_engine.playback_device);
        g_engine.playback_active = 0;
        g_engine.active_device_index = -1;
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
    atomic_store(&tk->monitoring, 0);
    tk->mon_device_active = 0;
    return 0;
}

// Remove a track.
EXPORT void tuidaw_remove_track(int id) {
    TrackState* tk = find_track(id);
    if (!tk) return;

    // Stop monitoring if active (includes custom helper cleanup)
    atomic_store(&tk->monitoring, 0);
    atomic_store(&tk->recording, 0);
    if (tk->jack_mon_active && g_jack.lib_handle) {
        g_jack.deactivate(tk->jack_client);
        g_jack.client_close(tk->jack_client);
        tk->jack_client = NULL;
        tk->jack_mon_active = 0;
    }
    if (tk->jack_rec_active && g_jack.lib_handle) {
        g_jack.deactivate(tk->jack_rec_client);
        g_jack.client_close(tk->jack_rec_client);
        tk->jack_rec_client = NULL;
        tk->jack_rec_active = 0;
    }
    if (tk->mon_device_active) {
        ma_device_uninit(&tk->mon_device);
        tk->mon_device_active = 0;
    }
    if (tk->custom_helper) {
        kill_custom_helper(tk->custom_helper);
        tk->custom_helper = NULL;
    }

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

// Set which channel to capture from a multi-channel input device.
// channel: 0-based channel index, -1 = mono downmix (default).
EXPORT void tuidaw_set_track_input_channel(int id, int channel) {
    TrackState* tk = find_track(id);
    if (!tk) return;
    tk->rec_channel = channel;
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
    // Set click counter to the output-space equivalent of the playhead position.
    // The click buffer has beat tones at absolute positions (beat 0 at sample 0,
    // beat 1 at 60/bpm * sampleRate, etc.). By setting the counter to position/speed,
    // the counter indexes the correct absolute position in the click buffer so that
    // clicks only fire on actual beat positions — NOT at the playhead position.
    // This fixes the bug where pausing and resuming from an off-beat position would
    // cause a click to fire immediately on resume.
    {
        float speed = atomic_load(&g_engine.playback_speed);
        long click_pos = (speed > 0.01f) ? (long)((double)position / (double)speed) : position;
        atomic_store(&g_engine.click_frame_counter, click_pos);
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
    // Set click counter to the output-space equivalent of the new position.
    // Same logic as tuidaw_play: counter = position / speed so the click buffer
    // is indexed at the correct absolute beat-grid position.
    {
        float speed = atomic_load(&g_engine.playback_speed);
        long click_pos = (speed > 0.01f) ? (long)((double)position / (double)speed) : position;
        atomic_store(&g_engine.click_frame_counter, click_pos);
    }
}

// ── Click / Metronome ───────────────────────────────────────────────────────

EXPORT void tuidaw_set_click(int enabled, float bpm) {
    (void)bpm; // BPM is baked into click_samples by tuidaw_generate_click
    atomic_store(&g_engine.click_enabled, enabled);
    // Set click counter to current playhead position in output-space.
    // This ensures the click re-syncs to the beat grid when toggled on/off.
    {
        long pos = atomic_load(&g_engine.playhead_samples);
        float speed = atomic_load(&g_engine.playback_speed);
        long click_pos = (speed > 0.01f) ? (long)((double)pos / (double)speed) : pos;
        atomic_store(&g_engine.click_frame_counter, click_pos);
    }
}

// GCD helper for click buffer generation
static int click_gcd(int a, int b) {
    if (a < 0) a = -a;
    if (b < 0) b = -b;
    while (b) { int t = b; b = a % b; a = t; }
    return a;
}

// Generate and store a click buffer internally.
// Creates a buffer of duration_frames samples containing click tones (960 samples
// of 1kHz sine + 20ms linear decay) placed at GCD-exact integer beat positions.
// The buffer is owned by the native engine (malloc'd) and freed on regenerate/deinit.
//
// Beat positions use GCD-exact integer arithmetic for zero cumulative drift:
//   bpmScaled = round(bpm * 100)
//   totalScaled = SAMPLE_RATE * 60 * 100
//   N = bpmScaled / gcd(bpmScaled, totalScaled)
//   samplesPerN = N * SAMPLE_RATE * 60 / bpm  (exact integer)
//   beat k position = floor(k * samplesPerN / N)
//
// The buffer is NOT looped — the callback reads click_samples[counter] with
// a bounds check. When counter exceeds the buffer length, silence is output.
//
// Returns 0 on success, -1 on failure (allocation error or invalid params).
EXPORT int tuidaw_generate_click(float bpm, int duration_frames) {
    if (bpm <= 0.0f || duration_frames <= 0) return -1;

    // Click tone parameters
    const int tone_len = (int)(SAMPLE_RATE * 0.02f + 0.5f); // 20ms = 960 samples

    // GCD-exact beat position math:
    // We compute beat positions using integer arithmetic so there is zero
    // floating-point drift. The key insight: for N beats, the total samples
    // (N * 60 * SAMPLE_RATE / bpm) is an exact integer when N = bpm_scaled / gcd(bpm_scaled, total_scaled).
    // Within these N beats, beat k starts at floor(k * samples_per_N / N) — pure integer division.
    const int bpm_scaled = (int)(bpm * 100.0f + 0.5f);
    const int total_per_minute = SAMPLE_RATE * 60;
    const long total_scaled = (long)total_per_minute * 100L;
    const int d = click_gcd(bpm_scaled, (int)total_scaled);
    const int N = bpm_scaled / d;
    // samples_per_N = N * total_per_minute / bpm (exact integer by GCD construction)
    const long samples_per_N = (long)N * (long)total_per_minute * 100L / (long)bpm_scaled;

    // Disable click output while we rebuild the buffer (race-safe)
    atomic_store(&g_engine.click_samples_len, 0);

    // Allocate or realloc the buffer
    if (duration_frames > g_engine.click_samples_capacity) {
        float* new_buf = (float*)realloc(g_engine.click_samples, (size_t)duration_frames * sizeof(float));
        if (!new_buf) return -1;
        g_engine.click_samples = new_buf;
        g_engine.click_samples_capacity = duration_frames;
    }

    // Zero the buffer (silence)
    memset(g_engine.click_samples, 0, (size_t)duration_frames * sizeof(float));

    // Fill in click tones at GCD-exact beat positions
    // We iterate through beats until we exceed duration_frames
    for (long beat = 0; ; beat++) {
        // Compute beat position using integer arithmetic:
        // global_beat_group = beat / N, local_beat = beat % N
        // position = global_beat_group * samples_per_N + floor(local_beat * samples_per_N / N)
        long group = beat / N;
        long local = beat % N;
        long beat_start = group * samples_per_N + (local * samples_per_N / N);

        if (beat_start >= duration_frames) break;

        // Write click tone at this position
        for (int i = 0; i < tone_len && (beat_start + i) < duration_frames; i++) {
            float t = (float)i / (float)SAMPLE_RATE;
            float envelope = 1.0f - (float)i / (float)tone_len;
            g_engine.click_samples[beat_start + i] = sinf(2.0f * (float)M_PI * 1000.0f * t) * envelope;
        }
    }

    // Enable the buffer (atomic store of length makes it visible to callback)
    atomic_store(&g_engine.click_samples_len, duration_frames);
    return 0;
}

// Keep tuidaw_set_click_samples for backward compatibility / tests,
// but note that it sets an EXTERNAL buffer (not freed by native engine).
// Prefer tuidaw_generate_click() for production use.
EXPORT void tuidaw_set_click_samples(float* samples, int len) {
    atomic_store(&g_engine.click_samples_len, 0);  // disable first (race-safe)
    // If we had a native-owned buffer, free it before switching to external
    if (g_engine.click_samples && g_engine.click_samples_capacity > 0) {
        free(g_engine.click_samples);
        g_engine.click_samples_capacity = 0;
    }
    g_engine.click_samples = samples;
    atomic_store(&g_engine.click_samples_len, len);
}

EXPORT void tuidaw_set_click_volume(float volume) {
    atomic_store(&g_engine.click_volume, volume);
}

EXPORT void tuidaw_set_click_pan(float pan) {
    if (pan < -1.0f) pan = -1.0f;
    if (pan > 1.0f) pan = 1.0f;
    atomic_store(&g_engine.click_pan, pan);
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

    // Reset diagnostic counter for fresh capture data
    atomic_store(&capture_diag_counter, 0);

    // Allocate recording buffer if needed
    if (!tk->rec_buffer) {
        tk->rec_buffer = (float*)calloc(RECORDING_BUF_LEN, sizeof(float));
        if (!tk->rec_buffer) return -1;
    }
    atomic_store(&tk->rec_write_pos, 0);

    // If JACK monitoring is active on this track, the JACK process callback
    // will handle recording directly (it already receives the capture audio).
    // No need to open a separate PulseAudio capture device — and we can't,
    // because the card profile may be set to "off" for the custom node workaround.
    if (tk->jack_mon_active) {
        // Diagnostic: log JACK-based recording
        {
            FILE* f = fopen("debug/capture.log", "w");
            if (f) {
                fprintf(f, "start_recording: id=%d JACK-based (monitoring active)\n", id);
                fprintf(f, "  rec_buffer=%p rec_buffer_len=%d\n",
                        (void*)tk->rec_buffer, RECORDING_BUF_LEN);
                fclose(f);
            }
        }
        atomic_store(&tk->recording, 1);
        return 0;
    }

    // ── JACK capture-only recording for devices needing custom nodes ────
    // If the device needs custom ALSA nodes (multi-channel USB with corrupted
    // auto-link nodes), PulseAudio capture through the profile-managed nodes
    // produces the same corruption. Use JACK capture via clean custom nodes.
    if (g_engine.jack_available && g_jack.lib_handle &&
        tk->rec_device_index >= 0) {
        char cn[256], ad[32];
        int ch;
        if (device_needs_custom_node(tk->rec_device_index, cn, sizeof(cn),
                                     ad, sizeof(ad), &ch)) {
            // Acquire custom helper (spawns helper if not already running)
            tk->custom_helper = acquire_custom_helper(tk->rec_device_index);
            if (!tk->custom_helper) {
                FILE* f = fopen("debug/capture.log", "w");
                if (f) {
                    fprintf(f, "start_recording: id=%d custom node helper FAILED\n", id);
                    fclose(f);
                }
                // Fall through to PulseAudio (will likely produce corrupt audio)
                goto pulseaudio_recording;
            }

            // Create a JACK client for capture-only recording
            char client_name[64];
            snprintf(client_name, sizeof(client_name), "tuidaw-rec-%d", id);

            jack_status_t jstatus;
            tk->jack_rec_client = g_jack.client_open(client_name, JackNoStartServer, &jstatus);
            if (!tk->jack_rec_client) {
                FILE* f = fopen("debug/capture.log", "w");
                if (f) {
                    fprintf(f, "start_recording: id=%d JACK client_open FAILED\n", id);
                    fclose(f);
                }
                release_custom_helper(tk->custom_helper);
                tk->custom_helper = NULL;
                goto pulseaudio_recording;
            }

            // Register capture-only port
            tk->jack_rec_capture = g_jack.port_register(tk->jack_rec_client, "input",
                JACK_DEFAULT_AUDIO_TYPE, JackPortIsInput, 0);
            if (!tk->jack_rec_capture) {
                g_jack.client_close(tk->jack_rec_client);
                tk->jack_rec_client = NULL;
                release_custom_helper(tk->custom_helper);
                tk->custom_helper = NULL;
                goto pulseaudio_recording;
            }

            // Set process callback
            g_jack.set_process_callback(tk->jack_rec_client, jack_rec_process, tk);

            // Activate client
            if (g_jack.activate(tk->jack_rec_client) != 0) {
                g_jack.client_close(tk->jack_rec_client);
                tk->jack_rec_client = NULL;
                release_custom_helper(tk->custom_helper);
                tk->custom_helper = NULL;
                goto pulseaudio_recording;
            }

            // Find the right capture port from the custom node
            char custom_cap_node[64];
            snprintf(custom_cap_node, sizeof(custom_cap_node),
                     "tuidaw-custom-cap-%d", tk->custom_helper->helper_id);

            const char** all_ports = g_jack.get_ports(tk->jack_rec_client, NULL,
                JACK_DEFAULT_AUDIO_TYPE, 0);

            char selected_cap[256] = {0};
            if (all_ports) {
                const char* cap_matches[16];
                int cap_match_count = 0;
                for (int i = 0; all_ports[i] && cap_match_count < 16; i++) {
                    if (!strstr(all_ports[i], "capture")) continue;
                    const char* colon = strchr(all_ports[i], ':');
                    if (!colon) continue;
                    int node_len = (int)(colon - all_ports[i]);
                    char node[256] = {0};
                    if (node_len > 255) node_len = 255;
                    strncpy(node, all_ports[i], node_len);
                    if (strstr(node, custom_cap_node)) {
                        cap_matches[cap_match_count++] = all_ports[i];
                    }
                }
                // Pick the right channel
                if (cap_match_count > 0) {
                    int idx = 0;
                    if (tk->rec_channel >= 0 && tk->rec_channel < cap_match_count) {
                        idx = tk->rec_channel;
                    }
                    strncpy(selected_cap, cap_matches[idx], sizeof(selected_cap) - 1);
                }
                g_jack.free(all_ports);
            }

            if (selected_cap[0] == 0) {
                // No matching capture port found
                FILE* f = fopen("debug/capture.log", "w");
                if (f) {
                    fprintf(f, "start_recording: id=%d JACK no capture port for '%s'\n",
                            id, custom_cap_node);
                    fclose(f);
                }
                g_jack.deactivate(tk->jack_rec_client);
                g_jack.client_close(tk->jack_rec_client);
                tk->jack_rec_client = NULL;
                release_custom_helper(tk->custom_helper);
                tk->custom_helper = NULL;
                goto pulseaudio_recording;
            }

            // Connect: custom capture node -> our input
            const char* our_input = g_jack.port_name(tk->jack_rec_capture);
            int rc = g_jack.connect(tk->jack_rec_client, selected_cap, our_input);

            // Diagnostic: log JACK recording setup
            {
                FILE* f = fopen("debug/capture.log", "w");
                if (f) {
                    fprintf(f, "start_recording: id=%d JACK capture-only\n", id);
                    fprintf(f, "  custom_helper pid=%d helper_id=%d\n",
                            tk->custom_helper->pid, tk->custom_helper->helper_id);
                    fprintf(f, "  cap_port='%s' -> our_input='%s' rc=%d\n",
                            selected_cap, our_input ? our_input : "(null)", rc);
                    fprintf(f, "  rec_buffer=%p rec_buffer_len=%d\n",
                            (void*)tk->rec_buffer, RECORDING_BUF_LEN);
                    fclose(f);
                }
            }

            tk->jack_rec_active = 1;
            atomic_store(&tk->recording, 1);
            return 0;
        }
    }

pulseaudio_recording:;

    // Determine channel count: if a specific channel is selected on a
    // multi-channel device, open the device in its native channel count
    // so the callback can extract the right channel. Otherwise open mono
    // and let miniaudio handle the downmix.
    int native_channels = 1;
    if (tk->rec_channel >= 0 && tk->rec_device_index >= 0 &&
        (ma_uint32)tk->rec_device_index < g_engine.capture_count) {
        // Do a full device info query — basic enumeration may not populate nativeDataFormats
        int dev_ch = 0;
        ma_device_info detailed;
        if (ma_context_get_device_info(&g_engine.context, ma_device_type_capture,
                &g_engine.capture_infos[tk->rec_device_index].id, &detailed) == MA_SUCCESS) {
            if (detailed.nativeDataFormatCount > 0) {
                dev_ch = (int)detailed.nativeDataFormats[0].channels;
            }
        }
        if (dev_ch <= 0) {
            // Fallback to cached (may be 0 from basic enumeration)
            dev_ch = (int)g_engine.capture_infos[tk->rec_device_index].nativeDataFormats[0].channels;
        }
        if (dev_ch > 1 && tk->rec_channel < dev_ch) {
            native_channels = dev_ch;
        }
    }

    // Diagnostic: log recording setup
    {
        FILE* f = fopen("debug/capture.log", "w");
        if (f) {
            fprintf(f, "start_recording: id=%d rec_device_index=%d rec_channel=%d native_channels=%d\n",
                    id, tk->rec_device_index, tk->rec_channel, native_channels);
            if (tk->rec_device_index >= 0 && (ma_uint32)tk->rec_device_index < g_engine.capture_count) {
                fprintf(f, "  device_name='%s'\n", g_engine.capture_infos[tk->rec_device_index].name);
                fprintf(f, "  device_id.pulse='%s'\n", g_engine.capture_infos[tk->rec_device_index].id.pulse);
            }
            fclose(f);
        }
    }

    // Set up capture device
    ma_device_config config = ma_device_config_init(ma_device_type_capture);
    config.capture.format   = ma_format_f32;
    config.capture.channels = native_channels;
    config.sampleRate       = SAMPLE_RATE;
    config.dataCallback     = capture_callback;
    config.pUserData        = tk;
    config.periodSizeInFrames = 128;  // ~2.7ms for low recording latency
    config.periods = 2;               // double-buffer

    if (tk->rec_device_index >= 0 &&
        (ma_uint32)tk->rec_device_index < g_engine.capture_count) {
        config.capture.pDeviceID = &g_engine.capture_infos[tk->rec_device_index].id;
    }

    if (ma_device_init(&g_engine.context, &config, &tk->rec_device) != MA_SUCCESS) {
        // Diagnostic: log failure
        FILE* f = fopen("debug/capture.log", "a");
        if (f) { fprintf(f, "  ma_device_init FAILED\n"); fclose(f); }
        return -1;
    }

    // Log what miniaudio actually negotiated
    {
        FILE* f = fopen("debug/capture.log", "a");
        if (f) {
            fprintf(f, "  actual_channels=%d actual_format=%d actual_sampleRate=%d\n",
                    (int)tk->rec_device.capture.channels,
                    (int)tk->rec_device.capture.format,
                    (int)tk->rec_device.sampleRate);
            fclose(f);
        }
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

    // Clean up JACK capture-only recording client
    if (tk->jack_rec_active && g_jack.lib_handle) {
        g_jack.deactivate(tk->jack_rec_client);
        g_jack.client_close(tk->jack_rec_client);
        tk->jack_rec_client = NULL;
        tk->jack_rec_capture = NULL;
        tk->jack_rec_active = 0;

        // Release custom helper if monitoring isn't holding it
        if (tk->custom_helper && !tk->jack_mon_active) {
            release_custom_helper(tk->custom_helper);
            tk->custom_helper = NULL;
        }
    }

    if (tk->rec_device_active) {
        ma_device_uninit(&tk->rec_device);
        tk->rec_device_active = 0;
    }

    int total = atomic_load(&tk->rec_write_pos);

    // Diagnostic: log stop info + buffer peak
    {
        FILE* f = fopen("debug/capture.log", "a");
        if (f) {
            float peak = 0.0f;
            if (tk->rec_buffer && total > 0) {
                for (int i = 0; i < total && i < 48000; i++) {
                    float v = tk->rec_buffer[i] < 0 ? -tk->rec_buffer[i] : tk->rec_buffer[i];
                    if (v > peak) peak = v;
                }
            }
            fprintf(f, "stop_recording: id=%d total_samples=%d buffer_peak=%.6f buf_ptr=%p\n",
                    id, total, peak, (void*)tk->rec_buffer);
            fclose(f);
        }
    }

    return total;
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

// ── Input Monitoring ────────────────────────────────────────────────────────
// Low-latency input passthrough. Two strategies:
//
// 1. DIRECT JACK API (preferred, ~58ms round-trip): Bypasses miniaudio entirely.
//    Uses dlopen'd libjack.so.0 to register ports and manually connect to the
//    correct capture/playback ports by name pattern. This avoids miniaudio's
//    JackPortIsPhysical filtering that breaks with PipeWire's split/filter ports.
//    For devices needing custom ALSA nodes (multi-channel USB devices with
//    corrupted auto-link nodes), a helper process creates clean nodes first.
//
// 2. PULSEAUDIO DUPLEX FALLBACK (~68ms round-trip): Uses miniaudio full-duplex
//    device on the main PulseAudio context. Higher latency but works everywhere.

// ── Input Monitoring ────────────────────────────────────────────────────────
EXPORT int tuidaw_start_monitoring(int id) {
    TrackState* tk = find_track(id);
    if (!tk) return -1;
    if (tk->jack_mon_active || tk->mon_device_active) return 0; // already monitoring

    // ── Strategy 1: Direct JACK API ────────────────────────────────────
    if (g_engine.jack_available && !g_engine.use_null_backend) {
        // Diagnostic: log monitoring setup
        {
            FILE* f = fopen("debug/monitor.log", "w");
            if (f) {
                fprintf(f, "start_monitoring: id=%d rec_device_index=%d rec_channel=%d\n",
                        id, tk->rec_device_index, tk->rec_channel);
                fprintf(f, "  output_device_index=%d\n", g_engine.output_device_index);
                if (tk->rec_device_index >= 0 && (ma_uint32)tk->rec_device_index < g_engine.capture_count) {
                    fprintf(f, "  cap_device_name='%s'\n", g_engine.capture_infos[tk->rec_device_index].name);
                    fprintf(f, "  cap_device_id='%s'\n", g_engine.capture_infos[tk->rec_device_index].id.pulse);
                }
                if (g_engine.output_device_index >= 0 && (ma_uint32)g_engine.output_device_index < g_engine.playback_count) {
                    fprintf(f, "  pb_device_name='%s'\n", g_engine.playback_infos[g_engine.output_device_index].name);
                    fprintf(f, "  pb_device_id='%s'\n", g_engine.playback_infos[g_engine.output_device_index].id.pulse);
                }
                fclose(f);
            }
        }

        // ── PipeWire custom node workaround for multi-channel USB devices ──
        // Check if this capture device needs custom ALSA nodes to avoid
        // the auto-link/node-group corruption. If so, spawn the helper
        // process (which sets profile to off and creates clean nodes).
        // If recording already acquired a helper, acquire again (bumps ref_count).
        if (!tk->custom_helper) {
            tk->custom_helper = acquire_custom_helper(tk->rec_device_index);
        } else {
            // Recording already has a helper — acquire again to bump ref_count
            acquire_custom_helper(tk->rec_device_index);
        }
        if (tk->custom_helper) {
            FILE* f = fopen("debug/monitor.log", "a");
            if (f) {
                fprintf(f, "  Using custom node helper (pid=%d) for clean audio\n",
                        tk->custom_helper->pid);
                fclose(f);
            }
        }

        // NOTE: Do NOT set PIPEWIRE_LATENCY — forcing quantum 256 causes
        // PipeWire to deliver stale/duplicated buffers to the JACK client.
        // The custom ALSA nodes have their own node.latency + period-size
        // for ALSA-level buffering. Default PipeWire quantum (1024) works
        // cleanly, as confirmed by the standalone jack_quick_cap test.

        // Create a unique JACK client name per track
        char client_name[64];
        snprintf(client_name, sizeof(client_name), "tuidaw-mon-%d", id);

        jack_status_t status;
        tk->jack_client = g_jack.client_open(client_name, JackNoStartServer, &status);

        if (!tk->jack_client) goto jack_failed;

        // Register our ports
        tk->jack_capture = g_jack.port_register(tk->jack_client, "input",
            JACK_DEFAULT_AUDIO_TYPE, JackPortIsInput, 0);
        tk->jack_playback_L = g_jack.port_register(tk->jack_client, "output_L",
            JACK_DEFAULT_AUDIO_TYPE, JackPortIsOutput, 0);
        tk->jack_playback_R = g_jack.port_register(tk->jack_client, "output_R",
            JACK_DEFAULT_AUDIO_TYPE, JackPortIsOutput, 0);

        if (!tk->jack_capture || !tk->jack_playback_L || !tk->jack_playback_R) {
            g_jack.client_close(tk->jack_client);
            tk->jack_client = NULL;
            goto jack_failed;
        }

        // Set process callback
        g_jack.set_process_callback(tk->jack_client, jack_monitor_process, tk);

        // Activate client (starts the process callback)
        if (g_jack.activate(tk->jack_client) != 0) {
            g_jack.client_close(tk->jack_client);
            tk->jack_client = NULL;
            goto jack_failed;
        }

        // Find and connect to the right ports.
        // We search ALL ports (not just physical) to find PipeWire's split/filter ports
        // like "Scarlett Solo (3rd Gen.) Input 2 Inst/Line:capture_MONO".
        //
        // Port selection uses the track's rec_device_index and the engine's
        // output_device_index to find JACK ports belonging to the correct
        // devices. miniaudio device names (via PulseAudio) correspond to JACK
        // node names (the part before the colon in "node:port"). We extract a
        // keyword from the miniaudio name and match against JACK port names.
        const char** all_ports = g_jack.get_ports(tk->jack_client, NULL,
            JACK_DEFAULT_AUDIO_TYPE, 0);

        if (!all_ports) {
            {
                FILE* f = fopen("debug/monitor.log", "a");
                if (f) { fprintf(f, "  JACK get_ports returned NULL!\n"); fclose(f); }
            }
            g_jack.deactivate(tk->jack_client);
            g_jack.client_close(tk->jack_client);
            tk->jack_client = NULL;
            goto jack_failed;
        }

        // Diagnostic: dump ALL JACK ports
        {
            FILE* f = fopen("debug/monitor.log", "a");
            if (f) {
                fprintf(f, "  ALL JACK PORTS:\n");
                for (int i = 0; all_ports[i]; i++) {
                    fprintf(f, "    [%d] %s\n", i, all_ports[i]);
                }
                fclose(f);
            }
        }

        // Get the miniaudio device name for the track's selected input device.
        // This will be used to find matching JACK capture ports.
        const char* cap_device_name = NULL;
        if (tk->rec_device_index >= 0 &&
            (ma_uint32)tk->rec_device_index < g_engine.capture_count) {
            cap_device_name = g_engine.capture_infos[tk->rec_device_index].name;
        }

        // When using a custom node helper, override the capture device name
        // to match the custom node's JACK port naming (tuidaw-custom-cap-N).
        char custom_cap_node[64] = {0};
        if (tk->custom_helper && tk->custom_helper->pid > 0) {
            snprintf(custom_cap_node, sizeof(custom_cap_node),
                     "tuidaw-custom-cap-%d", tk->custom_helper->helper_id);
            cap_device_name = custom_cap_node;
        }

        // Get the miniaudio device name for the selected output device.
        const char* pb_device_name = NULL;
        if (g_engine.output_device_index >= 0 &&
            (ma_uint32)g_engine.output_device_index < g_engine.playback_count) {
            pb_device_name = g_engine.playback_infos[g_engine.output_device_index].name;
        }

        // Helper: extract a short keyword from a miniaudio device name to match
        // against JACK port names. PulseAudio names are verbose descriptions like
        // "Scarlett Solo (3rd Gen.) Input 2 Inst/Line" while JACK node names are
        // similar but not identical. We extract the first significant word (>3 chars)
        // that isn't generic. If the name contains "Nano" we use that. If it
        // contains "Scarlett" we use that. Otherwise use the first word >=4 chars.
        // This is intentionally simple — we iterate all ports looking for matches
        // and fall back to generic patterns if no match is found.

        char cap_name[256] = {0};
        char pb_L_name[256] = {0};
        char pb_R_name[256] = {0};

        // ── Capture port selection ──
        // Strategy: if we have a device name, find ALL JACK capture ports
        // matching the device, then pick the one at the selected channel index.
        // If no channel selected (rec_channel < 0), pick the first one.
        if (cap_device_name) {
            // Collect matching capture ports (up to 16)
            const char* cap_matches[16];
            int cap_match_count = 0;

            // Try to find capture ports matching the device name.
            // JACK port format: "Node Name:port_name". We check if the device
            // name (or a keyword from it) appears in the port's node part.
            for (int i = 0; all_ports[i] && cap_match_count < 16; i++) {
                if (!strstr(all_ports[i], "capture")) continue;

                // Extract node name (before ':')
                const char* colon = strchr(all_ports[i], ':');
                if (!colon) continue;
                int node_len = (int)(colon - all_ports[i]);
                char node[256] = {0};
                if (node_len > 255) node_len = 255;
                strncpy(node, all_ports[i], node_len);

                // Check if the miniaudio device name appears in the JACK node name
                // or vice versa. PipeWire usually makes them similar.
                if (strstr(node, cap_device_name) || strstr(cap_device_name, node)) {
                    cap_matches[cap_match_count++] = all_ports[i];
                }
            }

            // If exact match failed, try keyword matching. Extract significant
            // words from the device name and try each.
            if (cap_match_count == 0) {
                // Build a list of keywords from the device name (words >=4 chars,
                // skip generic words like "Input", "Output", "Line", "Audio")
                char name_copy[256];
                strncpy(name_copy, cap_device_name, sizeof(name_copy) - 1);
                name_copy[sizeof(name_copy) - 1] = '\0';

                char* keywords[16];
                int kw_count = 0;
                char* tok = strtok(name_copy, " ()-/.,");
                while (tok && kw_count < 16) {
                    if (strlen(tok) >= 4 &&
                        strcasecmp(tok, "Input") != 0 &&
                        strcasecmp(tok, "Output") != 0 &&
                        strcasecmp(tok, "Line") != 0 &&
                        strcasecmp(tok, "Audio") != 0 &&
                        strcasecmp(tok, "Analog") != 0 &&
                        strcasecmp(tok, "Digital") != 0 &&
                        strcasecmp(tok, "Stereo") != 0 &&
                        strcasecmp(tok, "Mono") != 0 &&
                        strcasecmp(tok, "Surround") != 0 &&
                        strcasecmp(tok, "Monitor") != 0) {
                        keywords[kw_count++] = tok;
                    }
                    tok = strtok(NULL, " ()-/.,");
                }

                // Try matching each keyword against capture ports
                for (int k = 0; k < kw_count && cap_match_count == 0; k++) {
                    for (int i = 0; all_ports[i] && cap_match_count < 16; i++) {
                        if (!strstr(all_ports[i], "capture")) continue;
                        if (strstr(all_ports[i], keywords[k])) {
                            cap_matches[cap_match_count++] = all_ports[i];
                        }
                    }
                }
            }

            // Pick the right capture port based on channel selection
            if (cap_match_count > 0) {
                int idx = 0;
                if (tk->rec_channel >= 0 && tk->rec_channel < cap_match_count) {
                    idx = tk->rec_channel;
                }
                strncpy(cap_name, cap_matches[idx], sizeof(cap_name) - 1);
            }

            // Diagnostic: log capture port matching results
            {
                FILE* f = fopen("debug/monitor.log", "a");
                if (f) {
                    fprintf(f, "  cap_match_count=%d (device-matched)\n", cap_match_count);
                    for (int j = 0; j < cap_match_count; j++) {
                        fprintf(f, "    cap_match[%d]='%s'\n", j, cap_matches[j]);
                    }
                    if (cap_name[0]) fprintf(f, "  selected cap_name='%s'\n", cap_name);
                    fclose(f);
                }
            }
        }

        // Fallback: prefer "Inst" capture (instrument input), then any capture
        if (cap_name[0] == 0) {
            for (int i = 0; all_ports[i]; i++) {
                if (strstr(all_ports[i], "Inst") && strstr(all_ports[i], "capture")) {
                    strncpy(cap_name, all_ports[i], sizeof(cap_name) - 1);
                    break;
                }
            }
        }
        if (cap_name[0] == 0) {
            for (int i = 0; all_ports[i]; i++) {
                if (strstr(all_ports[i], "capture")) {
                    strncpy(cap_name, all_ports[i], sizeof(cap_name) - 1);
                    break;
                }
            }
        }

        // ── Playback port selection ──
        // Strategy: if we have an output device name, find JACK playback ports
        // whose node name matches. Need both FL/L and FR/R for stereo output.
        if (pb_device_name) {
            for (int i = 0; all_ports[i]; i++) {
                if (!strstr(all_ports[i], "playback")) continue;

                const char* colon = strchr(all_ports[i], ':');
                if (!colon) continue;
                int node_len = (int)(colon - all_ports[i]);
                char node[256] = {0};
                if (node_len > 255) node_len = 255;
                strncpy(node, all_ports[i], node_len);

                if (!strstr(node, pb_device_name) && !strstr(pb_device_name, node))
                    continue;

                // Match L/FL/AUX0 and R/FR/AUX1 channels
                // Pro Audio profile uses AUX0/AUX1 instead of FL/FR
                const char* port_part = colon + 1;
                if (pb_L_name[0] == 0 &&
                    (strstr(port_part, "FL") || strstr(port_part, "_1") ||
                     strstr(port_part, "_L") || strstr(port_part, "AUX0"))) {
                    strncpy(pb_L_name, all_ports[i], sizeof(pb_L_name) - 1);
                }
                if (pb_R_name[0] == 0 &&
                    (strstr(port_part, "FR") || strstr(port_part, "_2") ||
                     strstr(port_part, "_R") || strstr(port_part, "AUX1"))) {
                    strncpy(pb_R_name, all_ports[i], sizeof(pb_R_name) - 1);
                }
            }

            // Keyword fallback for playback (same as capture)
            if (pb_L_name[0] == 0 || pb_R_name[0] == 0) {
                char name_copy[256];
                strncpy(name_copy, pb_device_name, sizeof(name_copy) - 1);
                name_copy[sizeof(name_copy) - 1] = '\0';

                char* keywords[16];
                int kw_count = 0;
                char* tok = strtok(name_copy, " ()-/.,");
                while (tok && kw_count < 16) {
                    if (strlen(tok) >= 4 &&
                        strcasecmp(tok, "Input") != 0 &&
                        strcasecmp(tok, "Output") != 0 &&
                        strcasecmp(tok, "Line") != 0 &&
                        strcasecmp(tok, "Audio") != 0 &&
                        strcasecmp(tok, "Analog") != 0 &&
                        strcasecmp(tok, "Digital") != 0 &&
                        strcasecmp(tok, "Stereo") != 0 &&
                        strcasecmp(tok, "Mono") != 0 &&
                        strcasecmp(tok, "Surround") != 0 &&
                        strcasecmp(tok, "Monitor") != 0) {
                        keywords[kw_count++] = tok;
                    }
                    tok = strtok(NULL, " ()-/.,");
                }

                for (int k = 0; k < kw_count; k++) {
                    for (int i = 0; all_ports[i]; i++) {
                        if (!strstr(all_ports[i], "playback")) continue;
                        if (!strstr(all_ports[i], keywords[k])) continue;
                        const char* colon2 = strchr(all_ports[i], ':');
                        const char* port_part = colon2 ? colon2 + 1 : all_ports[i];
                        if (pb_L_name[0] == 0 &&
                            (strstr(port_part, "FL") || strstr(port_part, "_1") ||
                             strstr(port_part, "_L") || strstr(port_part, "AUX0"))) {
                            strncpy(pb_L_name, all_ports[i], sizeof(pb_L_name) - 1);
                        }
                        if (pb_R_name[0] == 0 &&
                            (strstr(port_part, "FR") || strstr(port_part, "_2") ||
                             strstr(port_part, "_R") || strstr(port_part, "AUX1"))) {
                            strncpy(pb_R_name, all_ports[i], sizeof(pb_R_name) - 1);
                        }
                    }
                    if (pb_L_name[0] != 0 && pb_R_name[0] != 0) break;
                }
            }
        }

        // Diagnostic: log playback port matching results after device matching
        {
            FILE* f = fopen("debug/monitor.log", "a");
            if (f) {
                fprintf(f, "  pb_L_name (after device match)='%s'\n", pb_L_name[0] ? pb_L_name : "(none)");
                fprintf(f, "  pb_R_name (after device match)='%s'\n", pb_R_name[0] ? pb_R_name : "(none)");
                fclose(f);
            }
        }

        // Fallback: any playback ports with FL/FR, _1/_2, or AUX0/AUX1
        if (pb_L_name[0] == 0 || pb_R_name[0] == 0) {
            for (int i = 0; all_ports[i]; i++) {
                if (!strstr(all_ports[i], "playback")) continue;
                const char* colon2 = strchr(all_ports[i], ':');
                const char* port_part = colon2 ? colon2 + 1 : all_ports[i];
                if (pb_L_name[0] == 0 &&
                    (strstr(port_part, "FL") || strstr(port_part, "_1") ||
                     strstr(port_part, "_L") || strstr(port_part, "AUX0"))) {
                    strncpy(pb_L_name, all_ports[i], sizeof(pb_L_name) - 1);
                }
                if (pb_R_name[0] == 0 &&
                    (strstr(port_part, "FR") || strstr(port_part, "_2") ||
                     strstr(port_part, "_R") || strstr(port_part, "AUX1"))) {
                    strncpy(pb_R_name, all_ports[i], sizeof(pb_R_name) - 1);
                }
            }
        }

        g_jack.free(all_ports);

        // Diagnostic: log final selected ports
        {
            FILE* f = fopen("debug/monitor.log", "a");
            if (f) {
                fprintf(f, "  FINAL cap_name='%s'\n", cap_name[0] ? cap_name : "(none)");
                fprintf(f, "  FINAL pb_L_name='%s'\n", pb_L_name[0] ? pb_L_name : "(none)");
                fprintf(f, "  FINAL pb_R_name='%s'\n", pb_R_name[0] ? pb_R_name : "(none)");
                fclose(f);
            }
        }

        if (cap_name[0] == 0 || pb_L_name[0] == 0 || pb_R_name[0] == 0) {
            // Diagnostic: log failure reason
            {
                FILE* f = fopen("debug/monitor.log", "a");
                if (f) {
                    fprintf(f, "  JACK FAILED: missing ports (cap=%d pb_L=%d pb_R=%d)\n",
                            cap_name[0] != 0, pb_L_name[0] != 0, pb_R_name[0] != 0);
                    fclose(f);
                }
            }
            g_jack.deactivate(tk->jack_client);
            g_jack.client_close(tk->jack_client);
            tk->jack_client = NULL;
            goto jack_failed;
        }

        // Connect: external capture -> our input
        const char* our_input = g_jack.port_name(tk->jack_capture);
        const char* our_out_L = g_jack.port_name(tk->jack_playback_L);
        const char* our_out_R = g_jack.port_name(tk->jack_playback_R);

        int rc1 = g_jack.connect(tk->jack_client, cap_name, our_input);
        int rc2 = g_jack.connect(tk->jack_client, our_out_L, pb_L_name);
        int rc3 = g_jack.connect(tk->jack_client, our_out_R, pb_R_name);

        // Diagnostic: log connection results
        {
            FILE* f = fopen("debug/monitor.log", "a");
            if (f) {
                fprintf(f, "  jack_connect cap->input: rc=%d\n", rc1);
                fprintf(f, "  jack_connect out_L->pb_L: rc=%d\n", rc2);
                fprintf(f, "  jack_connect out_R->pb_R: rc=%d\n", rc3);
                fprintf(f, "  our_input='%s'\n", our_input ? our_input : "(null)");
                fprintf(f, "  our_out_L='%s'\n", our_out_L ? our_out_L : "(null)");
                fprintf(f, "  our_out_R='%s'\n", our_out_R ? our_out_R : "(null)");
                fprintf(f, "  JACK monitoring ACTIVE\n");
                fclose(f);
            }
        }

        tk->jack_mon_active = 1;
        atomic_store(&tk->monitoring, 1);
        return 0;

    jack_failed:;
        // Diagnostic: log fallback
        {
            FILE* f = fopen("debug/monitor.log", "a");
            if (f) { fprintf(f, "  JACK failed, falling back to PulseAudio duplex\n"); fclose(f); }
        }
        // Release custom helper if it was acquired (JACK failed despite custom nodes)
        if (tk->custom_helper) {
            release_custom_helper(tk->custom_helper);
            tk->custom_helper = NULL;
        }
        // Fall through to PulseAudio duplex
    }

    // ── Strategy 2: PulseAudio Duplex Fallback ─────────────────────────
    {
        // Determine capture channel count: if a specific channel is selected,
        // open the device in native channel count so the callback can extract it.
        int mon_cap_channels = 1;
        if (tk->rec_channel >= 0 && tk->rec_device_index >= 0 &&
            (ma_uint32)tk->rec_device_index < g_engine.capture_count) {
            ma_device_info detailed;
            if (ma_context_get_device_info(&g_engine.context, ma_device_type_capture,
                    &g_engine.capture_infos[tk->rec_device_index].id, &detailed) == MA_SUCCESS) {
                if (detailed.nativeDataFormatCount > 0 && (int)detailed.nativeDataFormats[0].channels > 1) {
                    mon_cap_channels = (int)detailed.nativeDataFormats[0].channels;
                }
            }
        }

        ma_device_config config = ma_device_config_init(ma_device_type_duplex);
        config.capture.format    = ma_format_f32;
        config.capture.channels  = mon_cap_channels;
        config.playback.format   = ma_format_f32;
        config.playback.channels = 2;
        config.sampleRate        = SAMPLE_RATE;
        config.dataCallback      = duplex_monitor_callback;
        config.pUserData         = tk;
        config.noFixedSizedCallback = MA_TRUE;
        config.periodSizeInFrames = 128;
        config.periods = 2;

        // Set capture device (track's input device)
        if (tk->rec_device_index >= 0 &&
            (ma_uint32)tk->rec_device_index < g_engine.capture_count) {
            config.capture.pDeviceID = &g_engine.capture_infos[tk->rec_device_index].id;
        }

        // Set playback device (same as main output)
        if (g_engine.output_device_index >= 0 &&
            (ma_uint32)g_engine.output_device_index < g_engine.playback_count) {
            config.playback.pDeviceID = &g_engine.playback_infos[g_engine.output_device_index].id;
        }

        if (ma_device_init(&g_engine.context, &config, &tk->mon_device) != MA_SUCCESS) {
            return -1;
        }

        if (ma_device_start(&tk->mon_device) != MA_SUCCESS) {
            ma_device_uninit(&tk->mon_device);
            return -1;
        }

        tk->mon_device_active = 1;
        atomic_store(&tk->monitoring, 1);
        return 0;
    }
}

// Stop input monitoring on a track. Closes JACK client or duplex device.
EXPORT void tuidaw_stop_monitoring(int id) {
    TrackState* tk = find_track(id);
    if (!tk) return;

    atomic_store(&tk->monitoring, 0);

    if (tk->jack_mon_active && g_jack.lib_handle) {
        g_jack.deactivate(tk->jack_client);
        g_jack.client_close(tk->jack_client);
        tk->jack_client = NULL;
        tk->jack_capture = NULL;
        tk->jack_playback_L = NULL;
        tk->jack_playback_R = NULL;
        tk->jack_mon_active = 0;
    }

    if (tk->mon_device_active) {
        ma_device_uninit(&tk->mon_device);
        tk->mon_device_active = 0;
    }

    // Decrement custom helper ref_count. The helper stays alive (not killed)
    // so it can be reused instantly when monitoring is toggled back on,
    // avoiding the profile-switch race condition. It will be killed when the
    // track is removed or the engine shuts down.
    if (tk->custom_helper) {
        release_custom_helper(tk->custom_helper);
        if (!tk->jack_rec_active) {
            tk->custom_helper = NULL;  // recording still needs the pointer
        }
    }
}

// Check if a track is currently monitoring input.
EXPORT int tuidaw_is_monitoring(int id) {
    TrackState* tk = find_track(id);
    if (!tk) return 0;
    return atomic_load(&tk->monitoring);
}

// Check if JACK backend is available for monitoring.
// Returns 1 if libjack.so was successfully loaded via dlopen, 0 otherwise.
EXPORT int tuidaw_has_jack_monitoring(void) {
    return g_engine.jack_available;
}

// ── Speed / WSOLA control ───────────────────────────────────────────────────

// Set playback speed ratio (1.0 = normal, 0.5 = half speed, 2.0 = double).
// Clamped to [0.25, 2.0]. WSOLA time-stretch is applied when speed != 1.0.
// Always resets WSOLA states to the current playhead so that input_pos stays
// in sync when transitioning between WSOLA/non-WSOLA modes (speed crossing 1.0).
EXPORT void tuidaw_set_speed(float speed) {
    if (speed < 0.25f) speed = 0.25f;
    if (speed > 2.0f)  speed = 2.0f;
    atomic_store(&g_engine.playback_speed, speed);

    // Reset WSOLA states to current playhead position.
    // This is critical when switching between WSOLA and non-WSOLA modes:
    // without this, input_pos would be stale from whenever WSOLA was last
    // active/initialized, causing a playhead jump.
    long current_pos = atomic_load(&g_engine.playhead_samples);
    for (int i = 0; i < MAX_TRACKS; i++) {
        if (g_engine.tracks[i].active) {
            wsola_reset(&g_engine.tracks[i].wsola, (double)current_pos);
        }
    }
    // Also reset click frame counter (speed change means BPM ratio changed,
    // but click timing uses displayed_bpm directly so just reset for clean start)
    // Note: don't reset here — the click should keep ticking smoothly across
    // speed changes. The displayed_bpm is updated by JS when speed changes.
}

// Get current playback speed.
EXPORT float tuidaw_get_speed(void) {
    return atomic_load(&g_engine.playback_speed);
}

// ── Offline Render ──────────────────────────────────────────────────────────
// Render audio directly into a user-provided buffer by calling playback_callback.
// This bypasses the audio device entirely, giving deterministic, sample-exact
// output for automated testing. The engine must be in "playing" state
// (call tuidaw_play first). The buffer is interleaved stereo float (L R L R...).
// Returns the number of frames rendered (== frame_count on success).
EXPORT int tuidaw_render(float* output, int frame_count) {
    if (!output || frame_count <= 0) return 0;
    playback_callback(NULL, output, NULL, (ma_uint32)frame_count);
    return frame_count;
}
