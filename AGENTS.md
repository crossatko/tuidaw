# TUIDAW - Agent Context

## Goal

Build a full-featured DAW (Digital Audio Workstation) with two UIs:

1. **TUI mode** (`bun run start`): Terminal interface using OpenTUI with braille waveforms, keyboard/mouse controls
2. **Web UI mode** (`bun run start --host`): Browser interface on port 3666 using Canvas 2D rendering

Both UIs share the same native miniaudio audio engine. The TUI uses `bun:ffi` (`dlopen`) to call the native `.so` library. The Web UI uses the same C source compiled to WebAssembly via Emscripten — miniaudio auto-selects its Web Audio backend when compiled with `emcc`.

The app has a left sidebar with tracks, a main window with waveforms (braille in TUI, Canvas 2D in web), a playhead, BPM control with click/metronome, live waveform drawing during recording, project save/open, and WAV mixdown export. Mouse wheel controls for scrolling, volume, and pan are implemented. Audio I/O uses the native miniaudio engine in both modes — no PipeWire, no CLI audio tools, no process spawning for audio.

## Workflow preferences

- **Do not print summaries of changes to the user.** Instead, put the summary into the git commit description and commit the changes automatically after each task.
- Commit messages should have a concise title line and a detailed description body listing what was done.
- **Always `git push` after committing.** Never leave commits unpushed.
- **Always update AGENTS.md** when significant changes are made (new features, architecture changes, bug fixes, new discoveries). Keep the Accomplished list, File structure, and Discoveries sections current.
- **Never commit files containing the user's real filesystem paths** (e.g. `/home/kreejzak/...`). Such files (test scripts, debug scripts) must be `.gitignore`d. If a file with real paths was previously tracked, `git rm --cached` it before committing.

## Instructions

- Use OpenTUI (`@opentui/core`) for the terminal UI framework - it's a Zig-native TUI core with TypeScript bindings, uses Bun runtime
- Audio I/O via native C library (`native/libtuidaw_audio.so`) wrapping miniaudio, called from TypeScript via `bun:ffi` (`dlopen`)
- **No PipeWire, no pw-play/pw-record/pw-dump/wpctl** — all audio goes through the native miniaudio engine
- Can use `ffmpeg` for export mixdown (non-realtime, not performance-critical)
- Braille characters (Unicode 0x2800 range, 2x4 dot grid per char) for waveform rendering in FrameBuffer
- OpenTUI uses an imperative API with `FrameBufferRenderable` for custom drawing (setCell, fillRect, drawText, setCellWithAlphaBlending)
- Layout uses Yoga flexbox engine (flexDirection, flexGrow, etc.)
- Keyboard input via `renderer.keyInput.on("keypress", (key: KeyEvent) => ...)`
- Mouse input via `renderable.onMouseScroll = (event: MouseEvent) => ...` (and onMouseDown, onMouseUp, onMouseMove, onMouseDrag, onMouseOver, onMouseOut)
- Mouse enabled via `createCliRenderer({ useMouse: true })`
- `MouseEvent` has: `type`, `button`, `x`, `y` (relative to renderable), `modifiers: { shift, alt, ctrl }`, `scroll?: { direction: "up"|"down"|"left"|"right", delta: number }`, `target`, `stopPropagation()`, `preventDefault()`
- Renderer has `requestLive()`/`dropLive()` for continuous rendering mode (animations/recording)
- **Must call `renderer.requestRender()` after drawing to frame buffers** for changes to flush to terminal in idle/stopped state (it's a no-op during live mode)
- Bun is at `/usr/sbin/bun` (in PATH)
- `tsconfig.json` has `noUncheckedIndexedAccess: false`
- **Run `bun run check` after changes to verify type-correctness**

### Native audio engine architecture:

- C shared library wraps miniaudio, exports flat C API, called from TypeScript via `bun:ffi` (`dlopen`)
- The native audio callback handles mixing, pan, volume, click generation, loop regions, and WSOLA time-stretch sample-accurately — no temp files, no process spawning
- **WSOLA time-stretch**: per-track Waveform Similarity Overlap-Add for pitch-preserving speed changes (window=1024, hop=512, search=±256)
- Recording uses per-track miniaudio capture devices with ring buffers polled from JS via `pollRecordingData()`
- Pan/volume changes are instant (atomic updates in native engine) — no WAV rewrite or process restart
- Playhead position is sample-accurate from the audio thread via `tuidaw_get_playhead()`
- Built with `zig cc` (Zig 0.14.0 downloaded to `native/zig-toolchain/`)

### Native API surface (all implemented in C, exported as `EXPORT`):

- `tuidaw_init/deinit` — engine lifecycle
- `tuidaw_init_null` — engine lifecycle with null (silent) backend for tests
- `tuidaw_refresh_devices`, `tuidaw_get_device_count`, `tuidaw_get_device_name`, `tuidaw_is_device_default` — device enumeration
- `tuidaw_set_output_device`, `tuidaw_get_active_device_index`, `tuidaw_start_playback_device`, `tuidaw_stop_playback_device` — output device
- `tuidaw_add_track`, `tuidaw_remove_track`, `tuidaw_set_track_samples`, `tuidaw_set_track_volume/pan/muted/solo`, `tuidaw_set_track_input_device` — track management
- `tuidaw_play(position)`, `tuidaw_stop`, `tuidaw_get_playhead`, `tuidaw_set_playhead` — transport
- `tuidaw_set_click(enabled, bpm)` — metronome enable/disable (bpm param is legacy/unused — BPM is baked into click_samples buffer length)
- `tuidaw_set_click_volume(volume)` — click volume (0.0–2.0+, allows above 100%)
- `tuidaw_set_click_pan(pan)` — click panning (-1.0 L to 1.0 R)
- `tuidaw_generate_click(bpm, duration_frames)` — generate long pre-rendered click buffer in C (GCD-exact beat positions, malloc'd, realloc'd for efficiency)
- `tuidaw_set_click_samples(ptr, len)` — set external click buffer (backward compat / tests; frees native-owned buffer first)
- `tuidaw_set_loop(start, end)` — loop region (handled sample-accurately in callback)
- `tuidaw_start_recording(id)`, `tuidaw_stop_recording(id)`, `tuidaw_get_recording_buffer(id)`, `tuidaw_get_recording_length(id)` — recording
- `tuidaw_set_speed(speed)`, `tuidaw_get_speed()` — WSOLA time-stretch speed control (0.25x–2.0x)
- `tuidaw_render(output, frame_count)` — offline render: calls playback_callback into a user-provided buffer (bypasses audio device, deterministic output for tests)

### Recording behavior:

- **`R` key toggles arm state** on the selected track -- during transport, it also punches in/out recording live
- **Multiple tracks can be armed simultaneously**, each with different input devices
- **SPACE starts recording if any tracks are armed**, otherwise just plays
- **Recording writes from the playhead position forward** -- audio before the playhead is preserved, new audio overwrites from playhead onward
- **Multi-track simultaneous recording**: one native capture device per armed track
- Non-armed, non-muted tracks play back during recording

### Live controls during transport (all implemented):

- **M** = live mute/unmute (instant atomic update in native engine)
- **S** = live solo toggle (re-evaluates all tracks via native engine)
- **C** = live click toggle (enables/disables click in native callback)
- **R** = live punch-in/out (starts/stops native recording without stopping transport)
- **+/-** = live BPM change (instant update in native click generator; when BPM locked, changes base tempo without speed change)
- **B** = toggle BPM lock (locked: +/- relabels tempo without speed change; unlocked: +/- changes WSOLA speed)
- **Up/Down** = track selection during playback
- **A/D** blocked during transport with status message

### D key behavior (two-step):

- First press: if track has audio content, clears the content (nulls samples)
- Second press: if track is empty, deletes the track (or resets state if last track)

### File operations use zenity (GTK native dialogs):

- **F5** = Save project, **F6** = Open project, **I** = Import WAV, **E** = Export mixdown
- Ctrl+key shortcuts do NOT work in OpenTUI (intercepted internally)

### Timeline and playhead navigation (beat-based):

- **Left/Right arrows** = scroll view by 1 beat (Shift: 1 bar / 4 beats)
- **[ / ]** = scrub playhead left/right by 1 bar (4 beats) — **works during playback** (seeks native engine + resets WSOLA)
- **{ / }** = nudge selected track earlier/later by 1/16 beat — trims from start or prepends silence, syncs to native engine instantly
- **Mouse wheel** on main area = scroll view by 1 beat per tick
- **Home / 0** = jump to beginning, **End** = jump to end of audio — **works during playback**
- **Mouse click** on timeline = set playhead to clicked position — **works during playback**
- **View always recenters** when playhead moves outside the visible area (ensurePlayheadVisible)
- Timeline beat grid renders based on `samplesPerBeat = (60 / originalBpm) * sampleRate`

### Mouse wheel controls:

- **Main waveform area**: scroll = move view by 1 beat per tick
- **Sidebar volume zone**: scroll on any track row (except pan zone) = adjust volume +/-5% per tick
- **Sidebar pan zone**: scroll on row 1 at x >= 17 = adjust pan +/-0.05 per tick
- **Sidebar click row**: scroll adjusts click volume (x<13) or click pan (x≥13) +/-0.05 per tick
- Pan keyboard shortcuts: `<` = pan left 0.1, `>` = pan right 0.1

### WAV import features:

- Chunk-scanning parser (handles JUNK, LIST, bext chunks before fmt)
- Supports 16-bit PCM, 24-bit PCM, 32-bit IEEE float
- Stereo-to-mono downmix
- Automatic resampling to 48kHz (linear interpolation) when source sample rate differs
- **Automatic BPM detection** on import (two-pass: onset ACF + sample-level refinement)
  - Sets project BPM when project is empty (all tracks have no audio)
  - Range: 60-300 BPM, iterative octave promotion for high tempos
  - **Octave demotion** for BPM > 200: halves result if a sub-harmonic peak exists with >= 50% strength (catches fast hi-hat/subdivision dominance)
  - Parabolic interpolation for sub-frame accuracy
- **Automatic beat-phase alignment** on import (`findBeatOffset`)
  - Trims audio from the start so beat 1 sits at sample 0 (click track aligns with music)
  - Robust multi-window analysis: divides audio into overlapping 8-bar windows, scores each phase offset using on-beat vs off-beat contrast (not raw onset amplitude)
  - Later windows weighted more heavily (de-emphasizes intros with guitar slides, non-matching percussion, count-ins)
  - Contrast-based scoring: rejects one-off loud transients (guitar slides, cymbal crashes) since they don't repeat periodically — only consistent rhythmic onsets at beat positions score high
  - Coarse search at 5ms resolution, refined to sample level using median/IQR onset strength (robust to outliers)
  - Refinement uses audio from 10s+ in (or 25% into track), skipping intro artifacts entirely
  - **Validated against click.wav ground truth**: average beat error **0.01ms**, max 0.5ms over 60 beats — error is pure click-export jitter, not algorithm error.

### Project file format:

- `.tuidaw` files are gzipped tarballs (`tar czf` / `tar xzf`)
- Contains `project.json` (ProjectDescriptor) + `tracks/*.wav` (individual track WAVs)

### Export mixdown:

- Uses ffmpeg with `volume` and `pan` filters per track (equal-power panning law)
- **WSOLA time-stretch applied offline** when speed != 1.0: each track's samples are pitch-preserving time-stretched in TypeScript before writing to temp WAV (matching native engine's window=1024, hop=512, search=±256 algorithm)
- Single track: volume + pan + aformat
- Multiple tracks: volume + pan per input, then amix with normalize=0, aformat
- When clickEnabled: generates synthetic click WAV (1kHz sine, 20ms decay, 48kHz) at adjusted BPM, duration matched to stretched track length, includes as additional ffmpeg input with click's volume and pan
- Output: pcm_s16le WAV, stereo

## Discoveries

- OpenTUI is at `@opentui/core` (v0.1.88), repo at `github.com/anomalyco/opentui`, docs at `opentui.com`
- OpenTUI ships prebuilt native binaries - no Zig installation needed
- **Critical OpenTUI discovery**: `renderer.requestRender()` must be called after writing to FrameBuffers for screen to update in non-live mode
- **Ctrl+key shortcuts DON'T WORK in OpenTUI** -- framework intercepts Ctrl+S/O/P internally
- User's audio hardware: Focusrite Scarlett Solo (3rd Gen.) with 2 inputs, Logitech G535 headset
- User's terminal: Ghostty (supports Kitty keyboard protocol), Hyprland desktop
- **`Bun.write()` returns a Promise** -- must be awaited
- miniaudio.h is 95,864 lines — too large for Zig's `@cImport`, so native code is plain C compiled with `zig cc`
- Zig is not installed system-wide and `sudo` is not available — downloaded Zig 0.14.0 binary to `native/zig-toolchain/`
- All 32 exported symbols verified via `nm -D` on the compiled shared library
- **WAV parser pitfalls**: Real-world WAV files often have JUNK/LIST/bext chunks before `fmt` — must scan by iterating RIFF sub-chunks, not assume fixed byte offsets
- **Stereo WAV files** need explicit mono downmix (average channels)
- **Sample rate mismatch**: Native engine runs at 48kHz. Files at other rates (e.g. 44.1kHz) must be resampled on import or they play at wrong speed
- **BPM detection resolution**: At 100 onset frames/sec, ACF lag resolution is too coarse (~3.5 BPM jumps around 145 BPM). Use 200 fps + parabolic interpolation + sample-level refinement for accuracy
- **BPM octave ambiguity**: Must do iterative octave promotion (not single-pass) to handle high tempos like 250 BPM (62.5→125→250). Multi-candidate refinement handles promotion overshoot (e.g. 185 BPM where promotion goes 61→124→230, and 185 is collected as a candidate between pre- and post-promotion values). 3:2 sub-harmonic candidates are filtered out (e.g. 103 is 2/3 of 155). Sample-level autocorrelation is biased toward lower BPM, so the promoted candidate gets a +0.05 correlation advantage over alternatives.
- **Loop + WSOLA coordinate mismatch**: Loop boundaries are in content-space and WSOLA's `input_pos` also operates in content-space, so `wsola_generate` wraps `input_pos` at `loop_end` back to `loop_start` directly (no speed scaling needed for loop bounds).
- **miniaudio null backend**: `ma_backend_null` runs the audio callback on a timer thread but produces no sound output. Used for tests via `tuidaw_init_null()` to avoid blasting audio through speakers during `bun test`
- **Content-space coordinate system**: ALL coordinates (playhead, scrollOffset, loopStart, loopEnd, beat grid) are in source-sample space. When WSOLA is active, the native playhead is derived from `wsola.input_pos` (which advances at `speed * hop` per output hop). The UI does NOT apply speed scaling to `samplesPerSubCol` or `scrollOffset` — those are zoom/scroll in content-space. Beat grid uses `originalBpm` (the original tempo of the source audio).
- **`tuidaw_set_speed` must reset WSOLA states**: When speed changes (especially crossing the 1.0 threshold), WSOLA `input_pos` can be stale from whenever WSOLA was last active. Without resetting, switching from 1.0x to 0.5x causes a massive playhead backward jump (e.g. 47616 → 5120) because `input_pos` was still at position 0 from when `tuidaw_play` initially called `wsola_reset`. Fixed by always calling `wsola_reset(current_playhead)` for all active tracks in `tuidaw_set_speed`.
- **WSOLA initialization vs reset distinction**: `tuidaw_play()`, `tuidaw_set_playhead()`, and `tuidaw_set_speed()` all reset WSOLA states. The callback's `if (!tk->wsola.initialized)` check is a safety net but should rarely trigger since these three functions cover all transitions.
- **Click timing model (final)**: Click uses a **long pre-rendered buffer in OUTPUT-SPACE** generated natively in C by `tuidaw_generate_click(displayBpm, duration_frames)`. The buffer contains click tones at GCD-exact beat positions using the display BPM. The native callback indexes the buffer by `click_frame_counter` (ABSOLUTE output-space counter = content_position / speed). On play/seek, the counter is set to `position / speed` so clicks align to the absolute beat grid — NOT reset to 0 (which would cause clicks to fire immediately regardless of beat position). On loop, the counter wraps when it reaches `loop_end / speed`, resetting to `loop_start / speed` (absolute output-space positions, no `transport_start_pos` offset needed). Buffer is C-owned (malloc/realloc), regenerated on every BPM change. Click tone is 960 samples of 1kHz sine + 20ms decay, BPM-independent. GCD math (in C): `bpm_scaled = round(bpm*100)`, `total_scaled = SAMPLE_RATE*60*100`, `N = bpm_scaled / gcd(bpm_scaled, total_scaled)`. Beat k position: `group * samples_per_N + (local * samples_per_N / N)` where `group = k/N`, `local = k%N`. Buffer duration: `max(projectDuration/speed + 60s, 10min)` (output-space). Verified drift-free: 776 beats over 5 minutes at 155 BPM with max error 1.00 samples (0.021ms). `tuidaw_set_click_samples` kept for backward compatibility / tests (frees native-owned buffer first).
- **Click loop wrap via counter-based detection**: The click counter wraps based on its OWN value reaching the output-space loop boundary — NOT based on playhead comparison (`new_playhead < playhead`). This avoids the WSOLA look-ahead problem where `wsola.input_pos` wraps 1-2 hops before the output actually reaches the loop point. The counter-based approach correctly handles on-beat and off-beat loop regions at all speeds. Verified with 4 tests: on-beat 120 BPM, fractional 155 BPM, 0.75x speed, and off-beat loop boundaries.
- **BPM on empty project**: When `getProjectDurationSamples() === 0`, BPM +/- should change `originalBpm` (base tempo) along with `bpm`, keeping speed at 1.0x. Otherwise you get nonsensical speed ratios when there's no audio to stretch.
- **Export click generation**: For mixdown export, a synthetic click WAV is generated in TypeScript (matching native engine's 1kHz sine / 20ms linear decay / 48kHz) and fed to ffmpeg as an additional input with click's volume and pan filters.
- **Click content-space playback**: Click tone is a BPM-independent 960-sample buffer (1kHz sine + 20ms decay). The native engine uses a long pre-rendered buffer generated by `tuidaw_generate_click()` with click tones at GCD-exact beat positions, indexed by output-space `click_frame_counter` — no WSOLA, no pitch shifting, no floating-point BPM math. Loop wrapping handled by counter self-wrap (counter reaches output-space loop boundary, resets to loop start position).
- **`tuidaw_set_click_samples(float*, int len)`**: Sets external buffer (backward compat / tests). Frees any native-owned buffer first. Race-safe (sets len=0 before pointer update).
- **`tuidaw_generate_click(float bpm, int duration_frames)`**: Generates click buffer in C using malloc/realloc. GCD-exact integer arithmetic for beat positions. Buffer is C-owned (`click_samples_capacity > 0`). Called from JS via `updateClickBuffer(bpm, durationFrames)`.
- **Click track is always visible**: CLICK_ROW_HEIGHT=2 content rows, click track row always rendered in sidebar and main area. Uses dim colors when disabled, bright when enabled or selected. SEPARATOR_HEIGHT controls the gap between track rows (default 1, supports 0 for no separator or 2+ for wider gaps).
- **`CLICK_TRACK_INDEX = -1`**: Sentinel for click track selected. Up arrow from track 0 navigates to click track. Down arrow from click track navigates to track 0.
- **Click track navigation**: V key adjusts click volume, `<`/`>` adjust click pan, M key toggles clickEnabled — all when click track is selected (index -1).
- **Mouse click on click row**: Clicking click track row in sidebar or main area sets `selectedTrackIndex = -1`.
- **`updateClickBuffer` called on C toggle**: Ensures click tone buffer is set. Tone is BPM-independent (960 samples). BPM changes are handled by `startClick(bpm)` which updates `click_displayed_bpm` in native.
- **`updateClickBuffer(bpm, durationFrames)` calls native `tuidaw_generate_click`**: Called on BPM change, C toggle, M toggle (click track), WAV import, and transport start. Duration is `max(projectDuration/speed + 60s, 10min)` (output-space). Buffer is C-owned (no JS pinning needed).

- **Output device selection was broken**: `tuidaw_set_output_device()` only stores the device index — it does NOT restart the playback device. The playback device is created once in the constructor and never restarted. To switch devices, must call `tuidaw_stop_playback_device()` + `tuidaw_start_playback_device()` after setting the index. Input devices worked because each recording creates a new `ma_device`.

### Web UI architecture:

- **Dual-mode entry point**: `index.ts` is a 15-line dispatcher — `--host` flag dynamically imports `web/server.ts`, no flag imports `tui.ts`
- **WASM audio engine**: Same `tuidaw_audio.c` compiled to WASM via Emscripten (`native/build-wasm.sh`). miniaudio auto-selects Web Audio backend. SharedArrayBuffer required (COOP/COEP headers).
- **Emscripten SDK**: Installed at `native/emsdk/` (v5.0.3, gitignored, ~400MB). Build with `-sUSE_PTHREADS=1 -sAUDIO_WORKLET=1 -sWASM_WORKERS=1 -sMODULARIZE=1`
- **AudioBridge**: Typed wrapper around WASM exports with string→numeric track ID mapping and WASM heap memory management
- **Bun HTTP server**: `web/server.ts` bundles `web/app.ts` via `Bun.build` at startup, serves static files from `web/` with COOP/COEP headers
- **Separate tsconfigs**: Root tsconfig excludes browser files (`web/app.ts`, `web/audio-bridge.ts`); `web/tsconfig.json` extends root with DOM libs, includes only browser files
- **Canvas 2D rendering**: Waveforms, beat grid, playhead, track sidebar all rendered via Canvas 2D API
- **WAV import**: Built-in parser in browser (16/24-bit PCM, 32-bit float, stereo downmix, auto-resample to 48kHz) — no server round-trip needed
- **BPM detection on import (Web UI)**: Full shared pipeline — detectBPM → resample → findBeatOffset → trim. Auto-sets project BPM when project is empty. Track renamed from filename.
- **WAV parsing unification**: TUI version used Node `Buffer` API (`readUInt32LE`, `readInt16LE`), Web version used `DataView`/`Uint8Array`. Shared implementation in `src/utils/wav.ts` uses `Uint8Array`/`DataView` which works in both Bun (`Buffer extends Uint8Array`) and browser. Both had identical algorithm: chunk-scanning RIFF/WAVE parser.
- **Full-canvas conversion**: Previous web UI used HTML DOM (topbar div, sidebar div with innerHTML-rebuilt track rows, statusbar div, 2 canvases). Track heights didn't align between DOM sidebar rows and canvas waveform rows due to HTML margins/padding/borders. Converted to single `<canvas id="app">` filling viewport — all rendering via Canvas 2D. Mouse handling uses zone-based hit testing (`hitTest()` returns zone type + track index + button action).

### OpenTUI Mouse Event API:

- Mouse enabled via `createCliRenderer({ useMouse: true })`
- `onMouseScroll` handler on any Renderable: `(event: MouseEvent) => void`
- `event.scroll?.direction` is `"up" | "down" | "left" | "right"`, `event.scroll?.delta` is numeric
- `event.x`, `event.y` give position within the renderable
- Can attach via constructor options (`onMouseScroll: ...`) or property setters (`renderable.onMouseScroll = ...`)
- `FrameBufferRenderable` and `BoxRenderable` both inherit mouse handlers from `Renderable`
- Other handlers: `onMouseDown`, `onMouseUp`, `onMouseMove`, `onMouseDrag`, `onMouseDragEnd`, `onMouseDrop`, `onMouseOver`, `onMouseOut`, `onMouse`

## Accomplished

**All completed and working (type-checks pass):**

1. **Project initialized** with Bun + `@opentui/core`
2. **Full project structure** with 5 source files + index.ts + native C library
3. **Braille waveform renderer** (2x4 dot grid, bottom-up envelope display — absolute amplitude fills from bottom, no mirroring)
4. **Track manager** with add/remove/select, mute/solo/arm, volume/pan, color assignment
5. **Full UI**: top bar (transport/BPM/time/output device indicator), left sidebar (track list with M/S/R controls + level meters + input device labels + volume + pan), main area (braille waveforms + beat grid timeline + playhead), status bar (shortcuts)
6. **Transport controls**: play, stop, record with live waveform drawing
7. **All keyboard shortcuts**: SPACE, R, A, D, M, S, C, +/-, arrows, Home/End/0, F1-F3, F5, F6, I, E, V, <, >, [, ], {, }, Q
8. **D key two-step**: first press clears content, second press deletes track
9. **Audio device selection**: F2 (input per track), F3 (global output), device selector overlay
10. **Multi-track recording** via native miniaudio capture devices
11. **Live transport controls**: M/S/C/R/+/- all work during playback/recording with instant native engine updates
12. **Punch-in/out**: R key during transport starts/stops recording on individual tracks
13. **`refreshLivePlayback()`**: syncs mute/solo state to native engine for all tracks
14. **Metronome click**: generated sample-accurately in native audio callback
15. **Loop region**: handled sample-accurately in native audio callback
16. **Zenity file dialogs**: F5 save, F6 open, I import, E export
17. **Project save/open** (.tuidaw gzipped tarball)
18. **Export mixdown** (ffmpeg amix filter with per-track volume + equal-power pan)
19. **Status messages**: temporary 3-second auto-dismiss
20. **Help overlay** (F1) with all shortcuts + mouse hints
21. **Mouse wheel scroll** on main waveform area (beat-based timeline scroll)
22. **Mouse wheel volume** on sidebar track rows
23. **Mouse wheel pan** on sidebar pan zone (row 1, x >= 17)
24. **Pan display** in sidebar (C/L##/R## format)
25. **Pan keyboard shortcuts** (< and >)
26. **Native audio engine** (miniaudio-based C library with 32 exported FFI functions)
27. **TypeScript FFI bridge** (bun:ffi dlopen with full native API coverage)
28. **Replaced PipeWire CLI tools** with native miniaudio for cross-platform support
29. **WAV import**: chunk-scanning parser, 16/24/32-bit support, stereo downmix, 48kHz resampling
30. **Automatic BPM detection** on import (two-pass onset ACF + multi-candidate sample-level refinement, 60-300 BPM, iterative octave promotion with overshoot correction)
31. **Beat-based timeline**: Left/Right scroll by beats, Shift for bars, mouse wheel by beats
32. **Beat-based playhead scrub**: [ / ] move playhead by 1 bar (4 beats)
33. **Auto-recentering view**: playhead always stays visible, view recenters when playhead leaves screen
34. **Free-scroll mode**: during playback, manual scroll (mouse wheel, arrows) enters free-roam mode — view stays where user scrolled. Auto-scroll re-engages when playhead naturally enters the visible area. Cleared on stop, seeks, and playhead jumps. Timeline clicks during playback also enter free-roam mode (view stays at the clicked area). Loop-centering in `autoScroll()` only activates when playhead is inside the loop region — seeking past the loop disables both native loop and loop-centering.
35. **WSOLA time-stretch**: pitch-preserving speed control via native C engine (0.25x–2.0x), BPM +/- adjusts speed ratio relative to originalBpm, speed % shown in top bar when != 100%
36. **Content-space coordinate unification**: ALL coordinates (playhead, scrollOffset, loopStart, loopEnd, beat grid, waveform rendering) use source-sample space. UI does NOT apply speed scaling — `samplesPerSubCol` is pure zoom, `scrollOffset` is pure content position. Beat grid uses `originalBpm`. Playhead in native engine is derived from `wsola.input_pos` when WSOLA is active.
37. **Unified TRACK_ROW_HEIGHT=4** for both sidebar and waveform (pure content rows, no separator), sidebar has dedicated volume/pan row
38. **Live seeking during playback**: [ / ], Home/End/0, and timeline mouse click all work during transport — native `tuidaw_set_playhead` resets WSOLA states for glitch-free seeking
39. **Null audio backend for tests**: `tuidaw_init_null()` uses `ma_backend_null` so `bun test` runs silently — callback still fires, playhead advances, WSOLA works, no sound output
40. **Playhead-sync tests**: 6 tests verifying content-space playhead consistency across speed changes (0.5x, 2.0x, mid-playback speed change, multiple speed changes, rapid toggling, 1.0x wall-clock match). All pass with null audio backend.
41. **WSOLA reset on speed change**: `tuidaw_set_speed()` resets WSOLA states for all active tracks with the current playhead, preventing stale `input_pos` jumps when crossing the WSOLA/non-WSOLA threshold
42. **Loop-playhead interaction**: Loop is enforced when playhead is at or before loopEnd; disabled only when manually seeking past the loop. Playback from before the loop enters it naturally. `autoScroll()` centers the loop region on screen when it fits the view. 6 tests verify all scenarios.
43. **Click track volume control**: Native `tuidaw_set_click_volume(float)` with atomic float, range 0.0–2.0+ (allows above 100%), applied as amplitude multiplier in audio callback
44. **Click track pan control**: Native `tuidaw_set_click_pan(float)` with equal-power panning (-1.0 L to 1.0 R), same cosine/sine law as track panning
45. **Click track braille waveform**: 1-row braille beat pattern (⣿ spikes at beat positions) in main area above regular track waveforms when clickEnabled
46. **Click track sidebar row**: Compact 1-row (CLICK_ROW_HEIGHT=1) click track row at top of sidebar. Shows ♩ icon, volume%, pan indicator. CLICK_COLOR when enabled, FG_DIM when disabled.
47. **Click track braille waveform**: 1-row braille beat pattern (⣿ spikes at beat positions) in main area above regular track waveforms when clickEnabled
48. **Mouse wheel click controls**: Scroll on click row in sidebar adjusts volume (x<13) or pan (x≥13) with ±0.05 per tick
49. **BPM on empty project**: When no tracks have audio, +/- changes `originalBpm` (base tempo) instead of creating a speed ratio, so speed stays 1.0x
50. **Export mixdown with click**: When clickEnabled, generates synthetic click WAV (1kHz/20ms/decay matching native engine) and includes in ffmpeg mixdown with click's volume and pan
51. **Click volume/pan persistence**: `clickVolume` and `clickPan` saved/loaded in .tuidaw project files with backward-compatible defaults (0.5 / 0)
52. **Click volume/pan sync on transport**: `playAll()` syncs click volume and pan to native engine before starting playback
53. **Click WSOLA via pre-generated buffer**: Native click engine replaced with WSOLA-based buffer playback. `generateClickBuffer(originalBpm)` generates one beat of 1kHz sine + 20ms decay; passed to native via `tuidaw_set_click_samples`. Pitch-preserving at all speeds. Click buffer regenerated on BPM change and C toggle.
54. **Click track always visible**: CLICK_ROW_HEIGHT=1 (compact single row). Click track row shown in sidebar and main area at all times (not gated on `clickEnabled`). Dim colors when disabled, bright/selected colors when enabled or selected.
55. **Click track as first-class navigable track**: `CLICK_TRACK_INDEX = -1` sentinel. Up from track 0 selects click track. Down from click track goes to track 0. V, `<`, `>`, M keys all work on click track when selected.
56. **Click track mouse selection**: Clicking click row in sidebar or main area sets `selectedTrackIndex = -1`.
57. **Click waveform uses `┊` chars**: Beat positions shown as `┊` dotted vertical bars (same as timeline beat markers) spanning all content rows.
58. **Automatic beat-phase alignment on import**: `findBeatOffset()` trims audio so beat 1 sits at sample 0. Uses multi-window contrast scoring (8-bar overlapping windows, later windows weighted higher) + median/IQR sample-level refinement. Handles intros with guitar slides, non-matching percussion, count-ins.
59. **Pre-baked click buffer (GCD-exact, native C generation)**: Click buffer generated natively by `tuidaw_generate_click(bpm, duration_frames)` in C. Long buffer (10min+ project duration) with click tones at GCD-exact beat positions. Native callback indexes buffer by `click_frame_counter` (output-space wall-clock counter). On loop, counter wraps when it reaches the output-space position of `loop_end`, resetting to `loop_start`'s output-space position — independent of WSOLA look-ahead. Buffer is C-owned (malloc/realloc). JS-side `generateClickBuffer`, `setClickSamples`, `pinnedClickBuffer`, `gcd()` removed. `updateClickBuffer(bpm, durationFrames)` calls native. Duration computed as `max(projectDuration/speed + 60s, 10min)` (output-space). Verified drift-free: 776 beats over 5 minutes at 155 BPM with max error 1.00 samples (0.021ms). 12 click precision tests pass (120/145/155/212 BPM, single/chunked render, with-track, non-zero start, 5-min drift, 3-min stress, loop on-beat/off-beat/fractional/speed).
60. **Fix output device selection (F3)**: F3 device selection now actually switches the audio output device. Native engine tracks `active_device_index` (the device that was used when `tuidaw_start_playback_device()` last succeeded) separately from `output_device_index` (requested). `AudioEngine.setOutputDevice()` compares requested vs active index and only restarts the device when they differ — avoids unnecessary stop+start that can confuse PipeWire/PulseAudio routing policies. `AudioEngine.forceRestartOutputDevice()` always restarts (used by F3 callback). F3 callback has try-catch + status message. `playAll()` uses smart `setOutputDevice()` (skip if same). New native export: `tuidaw_get_active_device_index()`.
61. **Fix input device selection (F2)**: F2 callback now immediately syncs input device to native engine via `audioEngine.syncTrack()` so the input device is ready for recording right after selection (previously only synced on `playAll()`). Shows status message with selected device name.
62. **Output device applied on project open (F6)**: When opening a saved project, the restored `outputDeviceId` is immediately applied via `setOutputDevice()` instead of waiting for the next play.
63. **Web UI foundation (feature/webui branch)**: Dual-mode entry point (`index.ts` dispatcher), Bun HTTP server on port 3666 with COOP/COEP headers for SharedArrayBuffer, Canvas 2D waveform rendering, beat grid, playhead animation, track sidebar, transport controls (Space/M/S/R/C/+/-), keyboard shortcuts, mouse interaction, WAV file import with built-in parser (16/24-bit PCM, 32-bit float, auto-resample to 48kHz).
64. **WASM audio engine**: Same `tuidaw_audio.c` compiled to WebAssembly via Emscripten. miniaudio auto-selects Web Audio backend. Typed `AudioBridge` wrapper maps string track IDs to numeric IDs, manages WASM heap memory for sample buffers. All 37 `tuidaw_*` exports available.
65. **TUI refactoring**: `index.ts` (was 1043 lines) split into 15-line dispatcher + `tui.ts` (1048 lines). TUI functionality preserved.
66. **Extract BPM detection + DSP to shared utils**: `detectBPM`, `refineBPM`, `refineBPMMulti`, `findBeatOffset` extracted from `AudioEngine` class methods to standalone functions in `src/utils/bpm.ts` (~310 lines). `resample` extracted to `src/utils/dsp.ts` (~25 lines). Both used by TUI (`src/audio-engine.ts`) and Web UI (`web/app.ts`). Web UI import pipeline now runs full BPM detection → resample → beat offset trim → auto-set project BPM → rename track from filename.
67. **Extract WAV parsing to shared utils**: `parseWav`, `float32ToPcmS16`, `pcmS16ToFloat32`, `buildWavHeader`, `encodeWav` (mono), `encodeWavStereo` (stereo with equal-power pan) extracted to `src/utils/wav.ts` (~192 lines). Uses `Uint8Array`/`DataView` only (works in both Bun and browser). TUI's `AudioEngine` removed 6 WAV methods (~170 lines), now imports from shared utils. Web UI removed local `parseWavFile` (~90 lines), imports `parseWav` from shared utils.
68. **Full-canvas Web UI**: Rewrote Web UI from DOM-based (HTML divs + dual canvas) to single `<canvas>` rendering entire app via Canvas 2D. Eliminates HTML margin/padding height misalignment between sidebar and waveform tracks. Zone-based hit testing (`hitTest()` returns zone type + track index + button). `index.html` reduced from 306 to 26 lines. `app.ts` fully rewritten (~1208 lines). Layout constants: `SIDEBAR_W=220`, `TOPBAR_H=44`, `STATUSBAR_H=28`, `TIMELINE_H=24`, `TRACK_H=80`, `CLICK_ROW_H=32`.
69. **OLED theme for Web UI**: Replaced Tokyo Night color palette with OLED-optimized theme. True black (`#000000`) background, white/near-white (`#e8e8e8`) foreground, subtle gray borders (`#2a2a2a`). Color accents only for active UI states: green for playing, red for armed, orange for mute active, yellow for solo active, cyan for click active. Inactive buttons use dark fill (`#1a1a1a`) with border outlines. Active button text is black for maximum contrast. Track waveform colors adjusted for OLED visibility.
70. **Loop region UI in Web UI**: Full loop region support matching TUI behavior. P key 3-step cycle (set start → set end → clear). Touch-friendly Loop button in topbar (64px wide, 28px tall) for iPad usage. Purple (`#b080e0`) visual rendering: tinted overlay on timeline and waveform area, solid start/end markers with triangle indicators on timeline, vertical lines on waveform area, dashed line while setting loop start. Loop-aware auto-scroll centers loop region on screen during playback when it fits. `syncLoopAfterSeek()` disables native loop when playhead seeks past loopEnd (linear continuation). Audio bridge fixed to pass -1 (not 0) for no-loop sentinel matching native C engine.

## File structure

```
./
├── AGENTS.md                 # This file - context for future sessions
├── LICENSE                   # MIT License
├── README.md                 # Full setup instructions, feature list, shortcuts
├── setup.sh                  # Bootstrap: downloads Zig, bun install, builds native lib
├── index.ts                  # Entry point dispatcher (~15 lines):
│                              #   --host flag → web/server.ts (Web UI on port 3666)
│                              #   no flag    → tui.ts (Terminal UI)
├── tui.ts                    # TUI mode — all OpenTUI terminal logic (~1048 lines).
│                              # Transport, keyboard handling, mouse handlers,
│                              # punchInTrack/punchOutTrack, refreshLivePlayback,
│                              # shouldTrackPlay, ensurePlayheadVisible, autoScroll.
├── package.json              # scripts: start (bun run index.ts), check (tsc --noEmit && tsc --noEmit -p web/tsconfig.json), test (bun test)
├── tsconfig.json             # strict mode, noUncheckedIndexedAccess: false, excludes native/emsdk/** and web browser files
├── bun.lock
├── .github/
│   └── workflows/
│       └── build.yml         # CI: multi-arch native lib build on tag push
├── native/
│   ├── tuidaw_audio.c        # C source for miniaudio-based audio engine (~1151 lines)
│   ├── miniaudio.h           # miniaudio single-header library (95,864 lines, committed)
│   ├── build.sh              # Build script using zig cc (native .so)
│   ├── build-wasm.sh         # Build script using emcc (WASM for web UI)
│   ├── libtuidaw_audio.so    # Pre-built shared library (x86_64 Linux, 32 exported symbols)
│   ├── emsdk/                # Emscripten SDK v5.0.3 (NOT committed, ~400MB)
│   └── zig-toolchain/        # Downloaded Zig 0.14.0 binary (NOT committed to git)
├── src/
│   ├── types.ts              # Types: Track, ProjectState, AudioDevice, TransportState,
│   │                          # ProjectDescriptor, TrackDescriptor, AudioChunk,
│   │                          # constants (SIDEBAR_WIDTH=22, TOPBAR_HEIGHT=3,
│   │                          # TRACK_ROW_HEIGHT=4, CLICK_ROW_HEIGHT=2,
│   │                          # SEPARATOR_HEIGHT=1), TRACK_COLORS, BRAILLE_BASE,
│   │                          # BRAILLE_DOTS. ~119 lines.
│   ├── audio-engine.ts       # AudioEngine class - bun:ffi + dlopen to native lib.
│   │                          # Device enumeration, recording (poll-based), playback,
│   │                          # instant pan/volume/mute/solo, click, loop, transport.
│   │                          # WAV read/write (thin wrappers over src/utils/wav.ts),
│   │                          # exportMixdown (ffmpeg), saveProject, openProject.
│   │                          # Imports BPM/DSP/WAV from src/utils/.
│   │                          # Also exports zenitySave()/zenityOpen(). ~1060 lines.
│   ├── braille.ts            # Braille waveform renderer (renderBrailleWaveform), level meter
│   │                          # (renderLevelMeter), peak detection (getPeakLevel). ~113 lines.
│   ├── state.ts              # State management - createDefaultState, createTrack,
│   │                          # getSelectedTrack, getArmedTrack, getArmedTracks, formatTime,
│   │                          # formatBeatPosition, getProjectDurationSamples,
│   │                          # getProjectDurationSeconds. ~97 lines.
│   ├── utils/
│   │   ├── bpm.ts            # BPM detection (shared TUI + Web). detectBPM, refineBPM,
│   │   │                      # refineBPMMulti, findBeatOffset. Two-pass onset ACF +
│   │   │                      # multi-candidate sample-level refinement. ~310 lines.
│   │   ├── dsp.ts            # DSP utilities (shared TUI + Web). resample (linear
│   │   │                      # interpolation to target sample rate). ~25 lines.
│   │   └── wav.ts            # WAV parsing + encoding (shared TUI + Web). parseWav,
│   │                          # float32ToPcmS16, pcmS16ToFloat32, buildWavHeader,
│   │                          # encodeWav (mono), encodeWavStereo (stereo with
│   │                          # equal-power pan). Uses Uint8Array/DataView only.
│   │                          # ~192 lines.
│   └── ui.ts                 # UIRenderer class - all OpenTUI rendering + mouse handlers.
│                              # setupMouseHandlers(callbacks) for scroll/volume/pan.
│                              # Has Tokyo Night color constants. Renders: top bar, sidebar
│                              # (track list with M/S/R, volume, pan, level meters, input
│                              # device labels, click track row), main area (braille waveforms
│                              # + click braille beat pattern + content-space coordinates,
│                              # beat grid timeline, playhead), status bar, help overlay,
│                              # device selector overlay, file picker overlay.
│                              # ~1218 lines.
├── web/
│   ├── server.ts             # Bun HTTP server on port 3666 (~115 lines).
│   │                          # Bundles app.ts via Bun.build for browser.
│   │                          # Serves static files with COOP/COEP headers
│   │                          # (required for SharedArrayBuffer / WASM pthreads).
│   ├── index.html            # Minimal HTML shell — single <canvas id="app"> + script tag
│   │                          # + 15 lines CSS. Full app rendered via Canvas 2D. ~26 lines.
│   ├── app.ts                # Main browser app (~1420 lines): Full-canvas Canvas 2D rendering
│   │                          # of entire UI (topbar, sidebar, timeline, waveforms, statusbar).
│   │                          # OLED theme (true black bg, white fg, color accents for active states).
│   │                          # Zone-based hit testing, transport controls, keyboard shortcuts
│   │                          # (Space/M/S/R/C/+/-/hjkl/arrows/[]/</>/Home/End), mouse
│   │                          # interaction, WAV import with shared parser + BPM detection.
│   │                          # Layout: SIDEBAR_W=220, TOPBAR_H=44, TRACK_H=80, CLICK_ROW_H=32.
│   ├── audio-bridge.ts       # Typed wrapper (~270 lines) around WASM tuidaw_* exports.
│   │                          # Track ID mapping (string→numeric), WASM heap memory
│   │                          # management for sample buffers, transport/click/loop/speed.
│   ├── tsconfig.json         # Extends root, adds DOM/DOM.Iterable libs. Includes only
│   │                          # app.ts and audio-bridge.ts (browser files).
│   ├── wasm/                 # WASM build output (gitignored):
│   │   ├── tuidaw_audio.js   #   Emscripten JS glue (~43KB)
│   │   └── tuidaw_audio.wasm #   Compiled WASM module (~108KB)
│   └── dist/                 # Bun.build output (gitignored):
│       └── app.js            #   Bundled browser JS (created at server start)
├── recordings/               # Auto-created directory for saved WAV files
├── tests/
│   ├── click-precision.test.ts # 8 tests for click timing precision (all pass)
│   ├── loop-wsola.test.ts    # 6 tests for loop+WSOLA behavior (all pass)
│   ├── loop-playhead.test.ts # 6 tests for loop+playhead interaction (all pass)
│   └── playhead-sync.test.ts # 6 tests for playhead content-space sync (all pass)
└── node_modules/
    └── @opentui/core/        # OpenTUI framework (v0.1.88)
```

## Key architecture patterns

### Native audio engine (miniaudio)

The C library (`native/tuidaw_audio.c`) wraps miniaudio and exports a flat C API. The audio callback runs on a separate thread and handles:

- Multi-track mixing with per-track volume and pan (equal-power panning)
- Metronome click generation (long pre-rendered buffer with GCD-exact beat positions, bounds-check read — zero floating-point BPM math)
- Loop region handling (sample-accurate boundary detection)
- Playhead tracking (atomic counter incremented per frame)

All parameter changes (volume, pan, mute, solo, BPM) are instant atomic updates — no WAV rewriting or process restarting needed.

### TypeScript FFI bridge

`AudioEngine` class in `audio-engine.ts` uses `bun:ffi` `dlopen` to call the native library. It maintains:

- Track ID mapping (string IDs ↔ native integer IDs)
- Pinned buffer references (preventing GC of Float32Arrays while native code holds pointers)
- Recording state tracking (which tracks are recording, start positions)

### Recording via polling

During recording, the native engine captures audio into ring buffers. TypeScript polls these buffers every ~33ms via `pollRecordingData()`, which returns only new samples since the last poll. These are merged into the track's `samples` Float32Array at the correct offset.

### Live playback refresh

When mute/solo changes during transport, `refreshLivePlayback()` syncs all tracks' mute/solo state to the native engine via `setTrackMuted()` / `setTrackSolo()`. The native mixer handles the rest sample-accurately.

### Punch-in/out

`punchInTrack(track, position)` starts a native capture device mid-transport. `punchOutTrack(track)` stops recording, retrieves the full buffer, merges audio, and saves to file.

### UI rendering model

`UIRenderer.render(state)` redraws all four frame buffers (topbar, sidebar, main, statusbar) every frame. Overlays (help, device selector, file picker) are drawn on top of the main area FB. After rendering, `renderer.requestRender()` is called to flush changes to terminal.

### Mouse handler architecture

`UIRenderer.setupMouseHandlers(callbacks)` is called once after `setup()`, attaching `onMouseScroll` handlers to `mainFB` and `sidebarFB`. The handlers compute which track/zone the cursor is over and invoke the appropriate callback. The callbacks live in `tui.ts` and have access to `state` and `render()`.

### Playhead visibility

`ensurePlayheadVisible()` recenters the scroll offset when the playhead moves outside the visible area (centers playhead in view). Called after all manual playhead movements ([], End, mouse click). During live playback, `autoScroll()` handles forward-scrolling when playhead nears the right edge (80% threshold).

### WAV import pipeline

1. Parse WAV file (scan RIFF chunks for `fmt` + `data`)
2. Decode samples (16-bit PCM, 24-bit PCM, or 32-bit float)
3. Downmix stereo to mono (if needed)
4. Resample to 48kHz (if source rate differs, using linear interpolation)
5. Detect BPM (two-pass: onset autocorrelation + sample-level refinement)
6. Set project BPM if project is empty

## Sidebar layout per track row (TRACK_ROW_HEIGHT=4)

```
y+0: [sel] [dot] [name............] [input]
y+1: [sel]  M  S  R
y+2: [sel]  V:80%  Pan:C
y+3: [sel] [level meter / input device / "(empty)"]
(separator drawn between tracks, SEPARATOR_HEIGHT rows of ─)
```

- Selection indicator `▌` at x=0 for rows 0-3 when selected
- Color dot `●` at x=1, row 0
- Track name starts at x=3, row 0
- M/S/R buttons at x=1/4/7, row 1
- Volume `V:xx%` at x=1, row 2
- Pan `Pan:C`/`Pan:L##`/`Pan:R##` at x=9, row 2
- Level meter or input device label or "(empty)" at x=1, row 3
- Separator drawn AFTER content (SEPARATOR_HEIGHT rows), not part of TRACK_ROW_HEIGHT

## Sidebar click track row (CLICK_ROW_HEIGHT=1, always shown at top)

```
y+0: [sel] ♩ V:xx%  Pan:C
(separator drawn between click and first track, SEPARATOR_HEIGHT rows of ─)
```

- Always visible regardless of clickEnabled
- Selection indicator `▌` at x=0 when `selectedTrackIndex === CLICK_TRACK_INDEX (-1)`
- ♩ icon at x=1, volume at x=3, pan at x=9
- CLICK_COLOR when enabled, FG_DIM when disabled
- Separator drawn AFTER content (SEPARATOR_HEIGHT rows), not part of CLICK_ROW_HEIGHT

Mouse zones for sidebar scroll:

- Click row (y < CLICK_ROW_HEIGHT, always): x<9 = click volume, x≥9 = click pan
- Row 2, x >= 9 = pan control
- Everything else = volume control

## TODO:

- Web recording support
- Project save/load in web UI
- Volume/pan sliders in web UI
