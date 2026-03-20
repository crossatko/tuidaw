# TUIDAW - Agent Context

## Goal

Full-featured DAW with two UIs sharing the same native miniaudio audio engine:

1. **TUI** (`bun run start`): OpenTUI terminal UI with braille waveforms, keyboard/mouse
2. **Web** (`bun run start --host`): Vue 3.6 Vapor + Tailwind 4 + Canvas 2D on port 3666

Features: sidebar with tracks, waveform display, playhead, BPM/click, recording, loop region, project save/open, WAV import (with BPM detection + beat-phase alignment), export mixdown, WSOLA time-stretch, per-track input device selection, low-latency input monitoring.

## Workflow

- **Auto-commit + push** after each task. Concise title + detailed description body.
- **Update AGENTS.md** on significant changes.
- **Never commit real filesystem paths** (e.g. `/home/user/...`) — `.gitignore` such files.
- **Never reveal internal infrastructure** in commits, AGENTS.md, or any committed file. This includes: deployment strategies, server setup, hosting providers, domain routing, tunnels, local network config, machine names, IP addresses, or any operational details. Only public-facing URLs (e.g. in README) are acceptable.
- **Run `bun run check`** after changes (runs prettier + tsc + vue-tsc).

## Tech Stack & Rules

- **TUI**: OpenTUI (`@opentui/core` v0.1.88), Bun runtime, `bun:ffi` (`dlopen`) to native `.so`
- **Web**: Vue 3.6.0-beta.8 (Vapor Mode), Vite, Tailwind 4, WASM via Emscripten
- **Audio**: Native C library wrapping miniaudio — **no PipeWire/pw-play/pw-record/wpctl**
- **Export**: ffmpeg for TUI mixdown; WASM `tuidaw_render()` for web export (no ffmpeg needed)
- `tsconfig.json` has `noUncheckedIndexedAccess: false`

### OpenTUI specifics

- Imperative API: `FrameBufferRenderable` for custom drawing (setCell, fillRect, drawText)
- Yoga flexbox layout. Keyboard: `renderer.keyInput.on("keypress", ...)`. Mouse: `renderable.onMouseScroll = ...`
- `createCliRenderer({ useMouse: true })` enables mouse
- **Must call `renderer.requestRender()`** after drawing to FBs (no-op during live mode)
- `requestLive()`/`dropLive()` for continuous rendering
- **Ctrl+key shortcuts DON'T WORK** — framework intercepts them

### Vue/Web UI specifics

- **Vapor Mode**: `<script setup vapor lang="ts">` on child SFCs. `App.vue` must NOT have `vapor` (root must be VDOM for `createApp()`).
- **VDOM components crash inside Vapor** — no `lucide-vue-next`. Custom `Icon.vue` + `useIcons.ts` using base `lucide` package.
- Runtime alias: `vue` → `vue.runtime-with-vapor.esm-browser.js` in Vite config
- **Composables with singleton pattern** (no Pinia): useAppState, useAudio, useTransport, useProject, useKeyboard, useIcons
- **Tailwind everywhere** — no inline CSS or `<style>` blocks. `:style` only for dynamic values.
- Theme colors via `@theme` in `main.css` (Catppuccin Mocha + OLED black). `C` object only in composable logic / canvas code.
- Object notation for conditional `:class`. Avoid `watch` (use callbacks/events). No rounding except color dot.
- **Prettier**: single quotes, no semi, no trailing comma, tailwind plugin. `bun run format` to fix.
- **IBM Plex Mono** self-hosted in `web/public/fonts/`
- **Canvas render perf**: `RenderSnapshot` pattern reads reactive state once per frame. `scheduleRender()` coalesces. Off-screen track culling.

## Native Audio Engine

C shared library (`native/tuidaw_audio.c`, ~1362 lines) wrapping miniaudio. Built with `zig cc` (Zig 0.14.0 in `native/zig-toolchain/`). WASM built with `native/build-wasm.sh` (Emscripten SDK at `native/emsdk/`, gitignored). Two `ma_context` instances: main (PulseAudio) for playback/recording, optional JACK context for low-latency monitoring.

### API surface (all `EXPORT`ed):

| Category  | Functions                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle | `tuidaw_init`, `tuidaw_deinit`, `tuidaw_init_null` (silent backend for tests)                                                                                             |
| Devices   | `tuidaw_refresh_devices`, `tuidaw_get_device_count`, `tuidaw_get_device_name`, `tuidaw_is_device_default`, `tuidaw_get_backend_name`                                      |
| Output    | `tuidaw_set_output_device`, `tuidaw_get_active_device_index`, `tuidaw_start_playback_device`, `tuidaw_stop_playback_device`                                               |
| Tracks    | `tuidaw_add_track`, `tuidaw_remove_track`, `tuidaw_set_track_samples`, `tuidaw_set_track_volume/pan/muted/solo`, `tuidaw_set_track_input_device`                          |
| Transport | `tuidaw_play(pos)`, `tuidaw_stop`, `tuidaw_get_playhead`, `tuidaw_set_playhead`                                                                                           |
| Click     | `tuidaw_set_click(enabled, bpm)`, `tuidaw_set_click_volume`, `tuidaw_set_click_pan`, `tuidaw_generate_click(bpm, duration_frames)`, `tuidaw_set_click_samples(ptr, len)`  |
| Loop      | `tuidaw_set_loop(start, end)` — sample-accurate boundary detection                                                                                                        |
| Recording | `tuidaw_start_recording(id)`, `tuidaw_stop_recording(id)`, `tuidaw_get_recording_buffer/length`                                                                           |
| Speed     | `tuidaw_set_speed(speed)`, `tuidaw_get_speed()` — WSOLA 0.25x–2.0x                                                                                                        |
| Monitor   | `tuidaw_start_monitoring(id)`, `tuidaw_stop_monitoring(id)`, `tuidaw_is_monitoring(id)`, `tuidaw_has_jack_monitoring()` — full-duplex passthrough via JACK when available |
| Render    | `tuidaw_render(output, frame_count)` — offline render for tests/export                                                                                                    |

### Key behaviors

- **Audio callback** handles mixing, pan, volume, click, loop, WSOLA — all sample-accurately
- **WSOLA time-stretch**: per-track, window=1024, hop=512, search=±256
- **All param changes are instant** atomic updates (no WAV rewrite / process restart)
- **Playhead** from `wsola.input_pos` when WSOLA active, atomic counter otherwise
- **Content-space coordinates**: ALL coords (playhead, scroll, loop, beat grid) are in source-sample space. UI does NOT apply speed scaling. Beat grid uses `originalBpm`.
- **Click**: long pre-rendered buffer generated by `tuidaw_generate_click()` in C. GCD-exact beat positions, output-space `click_frame_counter`, counter-based loop wrap. Buffer is C-owned (malloc/realloc).
- **Recording**: per-track capture devices with ring buffers, polled from JS via `pollRecordingData()`. Web uses getUserMedia + ScriptProcessorNode (WASM capture unreliable).
- **`tuidaw_set_speed` resets WSOLA** for all active tracks (prevents stale `input_pos` jumps)
- **Output device switch** requires `stop_playback_device` + `start_playback_device` after `set_output_device`

## Keyboard Shortcuts (TUI)

| Key        | Action                                        | During transport? |
| ---------- | --------------------------------------------- | ----------------- |
| SPACE      | Play/stop (record if armed)                   | Yes (stop)        |
| R          | Arm/disarm (punch in/out during transport)    | Yes               |
| M/S        | Mute/solo toggle                              | Yes               |
| O          | Toggle input monitoring (full-duplex)         | Yes               |
| C          | Click toggle                                  | Yes               |
| +/-        | BPM change (WSOLA speed if BPM unlocked)      | Yes               |
| B          | Toggle BPM lock                               | -                 |
| A/D        | Add/delete track (blocked during transport)   | No                |
| D          | Two-step: 1st=clear content, 2nd=delete track | -                 |
| Up/Down    | Track selection                               | Yes               |
| Left/Right | Scroll view 1 beat (Shift: 1 bar)             | -                 |
| [ / ]      | Scrub playhead ±1 bar                         | Yes               |
| { / }      | Nudge track ±1/16 beat                        | -                 |
| Home/0/End | Jump to start/end                             | Yes               |
| V          | Volume adjust                                 | -                 |
| < / >      | Pan ±0.1                                      | -                 |
| F1         | Help overlay                                  | -                 |
| F2/F3      | Input/output device selector                  | -                 |
| F5/F6      | Save/open project (.tuidaw)                   | -                 |
| I/E        | Import WAV / export mixdown                   | -                 |
| Q          | Quit                                          | -                 |

File operations use **zenity** (GTK native dialogs). Ctrl+key shortcuts don't work in OpenTUI.

## WAV Import Pipeline

1. Parse (chunk-scanning, handles JUNK/LIST/bext)
2. Decode (16-bit PCM, 24-bit PCM, 32-bit float)
3. Stereo→mono downmix
4. Resample to 48kHz (linear interpolation)
5. BPM detection (two-pass onset ACF + multi-candidate sample-level refinement, 60-300 BPM, iterative octave promotion with demotion for >200 BPM)
6. Beat-phase alignment (`findBeatOffset` — multi-window contrast scoring, later windows weighted higher, median/IQR refinement)
7. Set project BPM if empty

## Project Format

`.tuidaw` = gzipped tarball containing `project.json` (ProjectDescriptor) + `tracks/*.wav`

## Discoveries (gotchas for future sessions)

- **`Bun.write()` returns a Promise** — must be awaited
- miniaudio.h too large for Zig `@cImport` — use plain C with `zig cc`
- No system Zig / no `sudo` — Zig binary downloaded to `native/zig-toolchain/`
- WAV files often have JUNK/LIST/bext chunks before `fmt` — must scan by iterating RIFF sub-chunks
- BPM octave ambiguity: iterative promotion (not single-pass). 3:2 sub-harmonic filtering. Promoted candidate gets +0.05 correlation advantage.
- Loop boundaries in content-space, WSOLA `input_pos` also content-space — no speed scaling for loop bounds
- `ma_backend_null` for tests via `tuidaw_init_null()` — callback fires, no sound
- Click loop wrap via counter self-wrap (not playhead comparison) — avoids WSOLA look-ahead offset
- BPM on empty project: +/- changes `originalBpm` directly, keeping speed 1.0x
- Output device: `set_output_device` stores index but doesn't restart device. Must stop+start.
- **Safari user activation**: file dialog `.click()` must be in synchronous trusted gesture stack. Fix: topbar is real DOM buttons.
- **Safari canvas sizing**: `100vh` ≠ `innerHeight` on iOS. Fix: programmatic `style.width/height` + `visualViewport` resize listener.
- **Flex min-width: auto**: canvas needs `min-width: 0; min-height: 0`
- **WASM requires COOP/COEP headers** — configured in Vite dev server + `web/public/_headers` for static hosting
- **Vue Vapor**: root component must be VDOM. VDOM components crash inside Vapor (no `lucide-vue-next`).
- **Tailwind v4 cascade**: conflicting `bg-*` in static `class` vs dynamic `:class` — winner depends on stylesheet order, not HTML class order. Put conflicting base in conditional too.
- **Canvas render perf**: Vue Proxy `get` traps add overhead in hot loops. `RenderSnapshot` pattern reads state once per frame.
- **Full-duplex monitoring**: Ring buffer approach (capture→ringbuf→playback callback) had ~100ms+ latency via PulseAudio. Fix: `ma_device_type_duplex` gives input+output in same callback, eliminating inter-thread hop.
- **JACK backend for low-latency monitoring**: Separate `ma_context` with `ma_backend_jack` for monitoring duplex devices gives ~2-5ms round-trip vs ~40-50ms via PulseAudio. PipeWire exposes a JACK interface that respects low quantum values. JACK only supports default devices (no `pDeviceID`). Falls back to main PulseAudio context if JACK unavailable. `noFixedSizedCallback = MA_TRUE` avoids miniaudio's internal fixed-size buffering.
- **PipeWire quantum must be forced low**: Even with JACK backend, PipeWire's default quantum (1024 frames = ~21ms) applies to all clients. JACK's `periodSizeInFrames` hint is ignored. Fix: `pw-metadata -n settings 0 clock.force-quantum 256` forces 256-frame (~5.3ms) quantum for the entire graph. Set when first monitor starts, restored to 0 when last monitor stops.
- **Monitoring stays active during recording**: PulseAudio/PipeWire handles multiple clients on the same capture device fine — no need to pause monitoring.
- **ALSA backend rejected**: Raw ALSA device enumeration shows dozens of unusable hw:/plughw:/dmix/dsnoop entries. PipeWire holds hardware, so ALSA "unable to open slave" errors. Must stay on default (PulseAudio/PipeWire) context.
- **Debug fprintf in audio callbacks corrupts TUI**: Even with stderr redirect, audio-thread fprintf breaks terminal. Remove all debug prints from callbacks.

## File Structure

```
./
├── AGENTS.md, LICENSE, README.md, setup.sh
├── index.ts              # Entry dispatcher: --host → web/server.ts, else → tui.ts
├── tui.ts                # TUI mode (~1232 lines)
├── package.json, tsconfig.json, .prettierrc, bun.lock
├── .github/workflows/build.yml  # CI: multi-arch native lib build on tag push
├── native/
│   ├── tuidaw_audio.c    # C audio engine (~1362 lines, 36+ exported symbols)
│   ├── miniaudio.h       # miniaudio single-header (committed)
│   ├── build.sh          # Native .so build (zig cc)
│   ├── build-wasm.sh     # WASM build (emcc)
│   ├── libtuidaw_audio.so
│   ├── emsdk/            # Emscripten SDK (gitignored)
│   └── zig-toolchain/    # Zig 0.14.0 (gitignored)
├── src/
│   ├── types.ts          # Track, ProjectState, constants (TRACK_ROW_HEIGHT=4, etc.)
│   ├── audio-engine.ts   # AudioEngine: bun:ffi bridge (~1285 lines)
│   ├── braille.ts        # Braille waveform + level meter (~113 lines)
│   ├── state.ts          # State helpers (createTrack, formatTime, etc.)
│   ├── ui.ts             # UIRenderer: OpenTUI rendering + mouse (~1399 lines)
│   └── utils/
│       ├── bpm.ts        # BPM detection (shared TUI+Web, ~310 lines)
│       ├── dsp.ts        # resample() (~25 lines)
│       └── wav.ts        # WAV parse/encode (Uint8Array/DataView, ~192 lines)
├── web/
│   ├── server.ts         # Bun HTTPS server — serves Vite-built dist/ with COOP/COEP
│   ├── index.html        # HTML shell + debug overlay + SW registration
│   ├── vite.config.ts    # Vite config (Vue, Tailwind, COOP/COEP, vapor runtime alias)
│   ├── tsconfig.json     # Vue-specific (DOM libs, paths)
│   ├── env.d.ts          # Vite + Vue SFC type shims
│   ├── audio-bridge.ts   # WASM wrapper (~540 lines): track ID mapping, recording
│   ├── src/
│   │   ├── main.ts, main.css, App.vue
│   │   ├── composables/  # useAppState, useAudio, useTransport, useProject, useKeyboard, useIcons
│   │   └── components/   # TopBar, SideBar, TrackRow, ClickTrackRow, WaveformCanvas,
│   │                     # Btn, MiniSlider, StatusBar, InputOverlay, Icon
│   └── public/           # Static: _headers, sw.js, manifest.json, icons, fonts/, wasm/
├── tests/                # click-precision, loop-wsola, loop-playhead, playhead-sync (30 tests)
└── recordings/           # Auto-created for saved WAVs
```

## Architecture Patterns

### Native engine: C → miniaudio → flat API → FFI/WASM

Audio callback on separate thread: mixing + pan + volume + click + loop + WSOLA. All params atomic.

### FFI bridge (`audio-engine.ts`)

String↔int track ID mapping. Pinned Float32Array refs (prevent GC while native holds pointers). Poll-based recording.

### Recording

TUI: native capture devices with ring buffers, polled every ~33ms. Web: getUserMedia + ScriptProcessorNode per armed track, shared DeviceCapture per device (ref-counted). Punch-in/out during transport.

### UI rendering

TUI: `UIRenderer.render(state)` redraws 4 frame buffers every frame. `setupMouseHandlers(callbacks)` for zone-based mouse handling. Web: Vue composables + Canvas for waveforms.

### Playhead visibility

`ensurePlayheadVisible()` recenters on manual moves. `autoScroll()` at 80% threshold during playback. Free-scroll mode on manual scroll — re-engages when playhead enters visible area.

## TUI Sidebar Layout (TRACK_ROW_HEIGHT=4)

```
y+0: [▌] [●] [name............] [input]
y+1: [▌]  M  S  R
y+2: [▌]  V:80%  Pan:C
y+3: [▌] [level meter / input device / "(empty)"]
─── separator (SEPARATOR_HEIGHT=1) ───
```

Click track (CLICK_ROW_HEIGHT=1, row 0 of sidebar): `[▌] ♩ V:xx%  Pan:C`
Timeline row in main area doubles as click track visualization (beat ticks use CLICK_COLOR when enabled).

## TODO

(none)
