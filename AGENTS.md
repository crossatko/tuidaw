# TUIDAW - Agent Context

## Goal

Build a full-featured TUI DAW (Digital Audio Workstation) using OpenTUI and miniaudio (native C library). The app has a left sidebar with tracks, a main window with braille-font waveforms, a playhead, BPM control with click/metronome, live waveform drawing during recording, project save/open, and WAV mixdown export. Mouse wheel controls for scrolling, volume, and pan are implemented. Audio I/O uses a cross-platform native library (miniaudio) via Bun FFI — no PipeWire, no CLI audio tools, no process spawning for audio.

## Workflow preferences

- **Do not print summaries of changes to the user.** Instead, put the summary into the git commit description and commit the changes automatically after each task.
- Commit messages should have a concise title line and a detailed description body listing what was done.
- **Always `git push` after committing.** Never leave commits unpushed.
- **Always update AGENTS.md** when significant changes are made (new features, architecture changes, bug fixes, new discoveries). Keep the Accomplished list, File structure, and Discoveries sections current.

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
- `tuidaw_set_output_device`, `tuidaw_start_playback_device`, `tuidaw_stop_playback_device` — output device
- `tuidaw_add_track`, `tuidaw_remove_track`, `tuidaw_set_track_samples`, `tuidaw_set_track_volume/pan/muted/solo`, `tuidaw_set_track_input_device` — track management
- `tuidaw_play(position)`, `tuidaw_stop`, `tuidaw_get_playhead`, `tuidaw_set_playhead` — transport
- `tuidaw_set_click(enabled, bpm)` — metronome (generated inline in callback)
- `tuidaw_set_loop(start, end)` — loop region (handled sample-accurately in callback)
- `tuidaw_start_recording(id)`, `tuidaw_stop_recording(id)`, `tuidaw_get_recording_buffer(id)`, `tuidaw_get_recording_length(id)` — recording
- `tuidaw_set_speed(speed)`, `tuidaw_get_speed()` — WSOLA time-stretch speed control (0.25x–2.0x)

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
- **+/-** = live BPM change (instant update in native click generator)
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
- **Mouse wheel** on main area = scroll view by 1 beat per tick
- **Home / 0** = jump to beginning, **End** = jump to end of audio — **works during playback**
- **Mouse click** on timeline = set playhead to clicked position — **works during playback**
- **View always recenters** when playhead moves outside the visible area (ensurePlayheadVisible)
- Timeline beat grid renders based on `samplesPerBeat = (60 / bpm) * sampleRate`

### Mouse wheel controls:
- **Main waveform area**: scroll = move view by 1 beat per tick
- **Sidebar volume zone**: scroll on any track row (except pan zone) = adjust volume +/-5% per tick
- **Sidebar pan zone**: scroll on row 1 at x >= 17 = adjust pan +/-0.05 per tick
- Pan keyboard shortcuts: `<` = pan left 0.1, `>` = pan right 0.1

### WAV import features:
- Chunk-scanning parser (handles JUNK, LIST, bext chunks before fmt)
- Supports 16-bit PCM, 24-bit PCM, 32-bit IEEE float
- Stereo-to-mono downmix
- Automatic resampling to 48kHz (linear interpolation) when source sample rate differs
- **Automatic BPM detection** on import (two-pass: onset ACF + sample-level refinement)
  - Sets project BPM when project is empty (all tracks have no audio)
  - Range: 60-300 BPM, iterative octave promotion for high tempos
  - Parabolic interpolation for sub-frame accuracy

### Project file format:
- `.tuidaw` files are gzipped tarballs (`tar czf` / `tar xzf`)
- Contains `project.json` (ProjectDescriptor) + `tracks/*.wav` (individual track WAVs)

### Export mixdown:
- Uses ffmpeg with `volume` and `pan` filters per track (equal-power panning law)
- Single track: volume + pan + aformat
- Multiple tracks: volume + pan per input, then amix with normalize=0, aformat
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
- All 27 exported symbols verified via `nm -D` on the compiled shared library
- **WAV parser pitfalls**: Real-world WAV files often have JUNK/LIST/bext chunks before `fmt` — must scan by iterating RIFF sub-chunks, not assume fixed byte offsets
- **Stereo WAV files** need explicit mono downmix (average channels)
- **Sample rate mismatch**: Native engine runs at 48kHz. Files at other rates (e.g. 44.1kHz) must be resampled on import or they play at wrong speed
- **BPM detection resolution**: At 100 onset frames/sec, ACF lag resolution is too coarse (~3.5 BPM jumps around 145 BPM). Use 200 fps + parabolic interpolation + sample-level refinement for accuracy
- **BPM octave ambiguity**: Must do iterative octave promotion (not single-pass) to handle high tempos like 250 BPM (62.5→125→250)
- **Loop + WSOLA coordinate mismatch**: Loop boundaries are in content-space but the playhead advances at real-time rate. At 0.5x speed, content takes 2x as long to play, so loop boundaries must be scaled by 1/speed in the native callback to prevent early wrapping. The C callback computes `eff_loop_start/end = loop_start/end / speed` when WSOLA is active.
- **miniaudio null backend**: `ma_backend_null` runs the audio callback on a timer thread but produces no sound output. Used for tests via `tuidaw_init_null()` to avoid blasting audio through speakers during `bun test`

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
7. **All keyboard shortcuts**: SPACE, R, A, D, M, S, C, +/-, arrows, Home/End/0, F1-F3, F5, F6, I, E, V, <, >, [, ], Q
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
26. **Native audio engine** (miniaudio-based C library with 27 exported FFI functions)
27. **TypeScript FFI bridge** (bun:ffi dlopen with full native API coverage)
28. **Replaced PipeWire CLI tools** with native miniaudio for cross-platform support
29. **WAV import**: chunk-scanning parser, 16/24/32-bit support, stereo downmix, 48kHz resampling
30. **Automatic BPM detection** on import (two-pass onset ACF + sample-level refinement, 60-300 BPM)
31. **Beat-based timeline**: Left/Right scroll by beats, Shift for bars, mouse wheel by beats
32. **Beat-based playhead scrub**: [ / ] move playhead by 1 bar (4 beats)
33. **Auto-recentering view**: playhead always stays visible, view recenters when playhead leaves screen
34. **WSOLA time-stretch**: pitch-preserving speed control via native C engine (0.25x–2.0x), BPM +/- adjusts speed ratio relative to originalBpm, speed % shown in top bar when != 100%
35. **Waveform speed-scaling**: waveform display stretches/compresses to match WSOLA playback duration (samplesPerSubCol and scrollOffset scaled by speed factor)
36. **Unified TRACK_ROW_HEIGHT=5** for both sidebar and waveform (4 content rows + 1 separator), sidebar has dedicated volume/pan row
37. **Live seeking during playback**: [ / ], Home/End/0, and timeline mouse click all work during transport — native `tuidaw_set_playhead` resets WSOLA states for glitch-free seeking
38. **Null audio backend for tests**: `tuidaw_init_null()` uses `ma_backend_null` so `bun test` runs silently — callback still fires, playhead advances, WSOLA works, no sound output

## File structure

```
/home/kreejzak/code/crossatko/tuidaw/
├── AGENTS.md                 # This file - context for future sessions
├── index.ts                  # Main entry - app init, transport logic, keyboard handling,
│                              # mouse handler setup, punchInTrack/punchOutTrack,
│                              # refreshLivePlayback, shouldTrackPlay,
│                              # ensurePlayheadVisible, autoScroll. ~843 lines.
├── package.json              # scripts: start (bun run index.ts), check (tsc --noEmit), test (bun test)
├── tsconfig.json             # strict mode, noUncheckedIndexedAccess: false
├── bun.lock
├── native/
│   ├── tuidaw_audio.c        # C source for miniaudio-based audio engine (~full implementation)
│   ├── miniaudio.h           # miniaudio single-header library (95,864 lines)
│   ├── build.sh              # Build script using zig cc
│   ├── libtuidaw_audio.so    # Compiled shared library (3.4MB, 28 exported symbols)
│   └── zig-toolchain/        # Downloaded Zig 0.14.0 binary (NOT committed to git)
├── src/
│   ├── types.ts              # Types: Track, ProjectState, AudioDevice, TransportState,
│   │                          # ProjectDescriptor, TrackDescriptor, AudioChunk,
│   │                          # constants (SIDEBAR_WIDTH=22, TOPBAR_HEIGHT=3,
│   │                          # TRACK_ROW_HEIGHT=5), TRACK_COLORS, BRAILLE_BASE,
│   │                          # BRAILLE_DOTS. ~111 lines.
│   ├── audio-engine.ts       # AudioEngine class - bun:ffi + dlopen to native lib.
│   │                          # Device enumeration, recording (poll-based), playback,
│   │                          # instant pan/volume/mute/solo, click, loop, transport.
│   │                          # WAV read/write/parse (16/24/32-bit, stereo downmix,
│   │                          # chunk scanning), resampling (linear interpolation),
│   │                          # BPM detection (two-pass: onset ACF + sample-level),
│   │                          # exportMixdown (ffmpeg), saveProject, openProject.
│   │                          # Also exports zenitySave()/zenityOpen(). ~1141 lines.
│   ├── braille.ts            # Braille waveform renderer (renderBrailleWaveform), level meter
│   │                          # (renderLevelMeter), peak detection (getPeakLevel). ~113 lines.
│   ├── state.ts              # State management - createDefaultState, createTrack,
│   │                          # getSelectedTrack, getArmedTrack, getArmedTracks, formatTime,
│   │                          # formatBeatPosition, getProjectDurationSamples,
│   │                          # getProjectDurationSeconds. ~94 lines.
│   └── ui.ts                 # UIRenderer class - all OpenTUI rendering + mouse handlers.
│                              # setupMouseHandlers(callbacks) for scroll/volume/pan.
│                              # Has Tokyo Night color constants. Renders: top bar, sidebar
│                              # (track list with M/S/R, volume, pan, level meters, input
│                              # device labels), main area (braille waveforms + speed-scaled
│                              # coordinates, beat grid timeline, playhead), status bar,
│                              # help overlay, device selector overlay, file picker overlay.
│                              # ~1103 lines.
├── recordings/               # Auto-created directory for saved WAV files
└── node_modules/
    └── @opentui/core/        # OpenTUI framework (v0.1.88)
```

## Key architecture patterns

### Native audio engine (miniaudio)
The C library (`native/tuidaw_audio.c`) wraps miniaudio and exports a flat C API. The audio callback runs on a separate thread and handles:
- Multi-track mixing with per-track volume and pan (equal-power panning)
- Metronome click generation (inline sine wave synthesis)
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
`UIRenderer.setupMouseHandlers(callbacks)` is called once after `setup()`, attaching `onMouseScroll` handlers to `mainFB` and `sidebarFB`. The handlers compute which track/zone the cursor is over and invoke the appropriate callback. The callbacks live in `index.ts` and have access to `state` and `render()`.

### Playhead visibility
`ensurePlayheadVisible()` recenters the scroll offset when the playhead moves outside the visible area (centers playhead in view). Called after all manual playhead movements ([], End, mouse click). During live playback, `autoScroll()` handles forward-scrolling when playhead nears the right edge (80% threshold).

### WAV import pipeline
1. Parse WAV file (scan RIFF chunks for `fmt` + `data`)
2. Decode samples (16-bit PCM, 24-bit PCM, or 32-bit float)
3. Downmix stereo to mono (if needed)
4. Resample to 48kHz (if source rate differs, using linear interpolation)
5. Detect BPM (two-pass: onset autocorrelation + sample-level refinement)
6. Set project BPM if project is empty

## Sidebar layout per track row (TRACK_ROW_HEIGHT=5)

```
y+0: [sel] [dot] [name............] [input]
y+1: [sel]  M  S  R
y+2: [sel]  V:80%  Pan:C
y+3: [sel] [level meter / input device / "(empty)"]
y+4: [separator line ─────────────────────]
```

- Selection indicator `▌` at x=0 for rows 0-3 when selected
- Color dot `●` at x=1, row 0
- Track name starts at x=3, row 0
- M/S/R buttons at x=1/4/7, row 1
- Volume `V:xx%` at x=1, row 2
- Pan `Pan:C`/`Pan:L##`/`Pan:R##` at x=9, row 2
- Level meter or input device label or "(empty)" at x=1, row 3
- Separator `─` at row 4

Mouse zones for sidebar scroll:
- Row 2, x >= 9 = pan control
- Everything else = volume control
