# TUIDAW - Agent Context

## Goal

Build a full-featured TUI DAW (Digital Audio Workstation) using OpenTUI and PipeWire on Arch Linux. The app has a left sidebar with tracks, a main window with braille-font waveforms, a playhead, BPM control with click/metronome, live waveform drawing during recording, project save/open, and WAV mixdown export. Mouse wheel controls for scrolling, volume, and pan are implemented.

## Workflow preferences

- **Do not print summaries of changes to the user.** Instead, put the summary into the git commit description and commit the changes automatically after each task.
- Commit messages should have a concise title line and a detailed description body listing what was done.

## Instructions

- Use OpenTUI (`@opentui/core`) for the terminal UI framework - it's a Zig-native TUI core with TypeScript bindings, uses Bun runtime
- Use PipeWire CLI tools (`pw-record`, `pw-play`, `pw-cat`) for audio I/O since user is on Arch with PipeWire
- Can use `ffmpeg` for anything useful (currently used for mixdown export)
- Braille characters (Unicode 0x2800 range, 2x4 dot grid per char) for waveform rendering in FrameBuffer
- OpenTUI uses an imperative API with `FrameBufferRenderable` for custom drawing (setCell, fillRect, drawText, setCellWithAlphaBlending)
- Layout uses Yoga flexbox engine (flexDirection, flexGrow, etc.)
- Keyboard input via `renderer.keyInput.on("keypress", (key: KeyEvent) => ...)`
- Mouse input via `renderable.onMouseScroll = (event: MouseEvent) => ...` (and onMouseDown, onMouseUp, onMouseMove, onMouseDrag, onMouseOver, onMouseOut)
- Mouse enabled via `createCliRenderer({ useMouse: true })`
- `MouseEvent` has: `type`, `button`, `x`, `y` (relative to renderable), `modifiers: { shift, alt, ctrl }`, `scroll?: { direction: "up"|"down"|"left"|"right", delta: number }`, `target`, `stopPropagation()`, `preventDefault()`
- Renderer has `requestLive()`/`dropLive()` for continuous rendering mode (animations/recording)
- **Must call `renderer.requestRender()` after drawing to frame buffers** for changes to flush to terminal in idle/stopped state (it's a no-op during live mode)
- Bun is located at `~/.bun/bin/bun` (not in PATH for shell commands)
- `tsconfig.json` has `noUncheckedIndexedAccess: false`
- **Run `~/.bun/bin/bun run check` after changes to verify type-correctness**

### Recording behavior (user's explicit requirements):
- **`R` key toggles arm state** on the selected track -- during transport, it also punches in/out recording live
- **Multiple tracks can be armed simultaneously**, each with different input devices
- **SPACE starts recording if any tracks are armed**, otherwise just plays
- **Recording writes from the playhead position forward** -- audio before the playhead is preserved, new audio overwrites from playhead onward
- **Multi-track simultaneous recording**: one `pw-record` process spawns per armed track with its own `--target` device
- Non-armed, non-muted tracks play back during recording

### Live controls during transport (all implemented):
- **M** = live mute/unmute (kills/starts pw-play for affected track)
- **S** = live solo toggle (re-evaluates all tracks' playback)
- **C** = live click toggle (starts/stops click process)
- **R** = live punch-in/out (starts/stops pw-record without stopping transport)
- **+/-** = live BPM change (restarts click with new BPM)
- **Up/Down** = track selection during playback
- **A/D** blocked during transport with status message

### D key behavior (two-step):
- First press: if track has audio content, clears the content (nulls samples)
- Second press: if track is empty, deletes the track (or resets state if last track)

### File operations use zenity (GTK native dialogs):
- **F5** = Save project, **F6** = Open project, **I** = Import WAV, **E** = Export mixdown
- Ctrl+key shortcuts do NOT work in OpenTUI (intercepted internally)

### Mouse wheel controls (implemented):
- **Main waveform area**: scroll up/left = scroll timeline left, scroll down/right = scroll timeline right (~0.5s per tick)
- **Sidebar volume zone**: scroll on any track row (except pan zone) = adjust volume +/-5% per tick
- **Sidebar pan zone**: scroll on row 1 at x >= 17 = adjust pan +/-0.05 per tick
- Pan keyboard shortcuts: `[` = pan left 0.1, `]` = pan right 0.1

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
- Bun `Subprocess.stdout` can be `number | ReadableStream` - need to type-guard before calling `.getReader()`
- `pw-record --format s16 --rate 48000 --channels 1 -` streams raw PCM to stdout
- `pw-record` and `pw-play` both support `--target <serial_or_name>` for device routing
- `pw-dump` outputs JSON - filter for `media.class === "Audio/Source"` (inputs) and `"Audio/Sink"` (outputs)
- **Critical OpenTUI discovery**: `renderer.requestRender()` must be called after writing to FrameBuffers for screen to update in non-live mode
- **Ctrl+key shortcuts DON'T WORK in OpenTUI** -- framework intercepts Ctrl+S/O/P internally
- User's audio hardware: Focusrite Scarlett Solo (3rd Gen.) with 2 inputs, Logitech G535 headset
- User's terminal: Ghostty (supports Kitty keyboard protocol), Hyprland desktop
- **PipeWire default latency is 100ms**; we use `--latency 256` (~5.3ms)
- **`Bun.write()` returns a Promise** -- must be awaited
- **Recording latency compensation was WRONG and removed**: The `firstChunkTime - spawnTime` measurement captured JS process/pipe overhead, not audio timing offset. Both `pw-play` and `pw-record` connect to PipeWire graph at similar times and are already in sync. The compensation was creating timing offset, not fixing it.
- **Sequential process spawning caused real timing skew**: spawning pw-record, then pw-play for each track, then click sequentially meant by the time click started, pw-record had been capturing for hundreds of ms. Fixed with two-phase approach.
- **Two-phase spawn approach**: Phase 1: write all WAV files to disk in parallel (`Promise.all`). Phase 2: spawn all processes (pw-record, pw-play, click) back-to-back with zero awaits between spawns. This ensures near-simultaneous start.
- **AudioEngine split methods**: `playTrack()` split into `prepareTrackWav()` (async, writes WAV) + `spawnTrackPlayer()` (sync, spawns process). Similarly `startClick()` split into `prepareClickWav()` + `spawnClickPlayer()`. Allows pre-writing all files then spawning everything at once.

### OpenTUI Mouse Event API (implemented):
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
2. **Full project structure** with 5 source files + index.ts
3. **Braille waveform renderer** (2x4 dot grid mapping amplitude to vertical dot positions)
4. **Track manager** with add/remove/select, mute/solo/arm, volume/pan, color assignment
5. **Full UI**: top bar (transport/BPM/time/output device indicator), left sidebar (track list with M/S/R controls + level meters + input device labels + volume + pan), main area (braille waveforms + beat grid timeline + playhead), status bar (shortcuts)
6. **Transport controls**: play, stop, record with live waveform drawing
7. **All keyboard shortcuts**: SPACE, R, A, D, M, S, C, +/-, arrows, Home/End/0, F1-F3, F5, F6, I, E, V, [, ], Q
8. **D key two-step**: first press clears content, second press deletes track
9. **PipeWire device selection**: F2 (input per track), F3 (global output), device selector overlay
10. **Multi-track recording** with two-phase spawn (pre-write WAVs, then spawn all processes simultaneously)
11. **Live transport controls**: M/S/C/R/+/- all work during playback/recording with real audio side-effects
12. **Punch-in/out**: R key during transport starts/stops recording on individual tracks
13. **`refreshLivePlayback()`**: re-evaluates which tracks should have pw-play running when mute/solo changes
14. **Metronome click**: pre-rendered continuous WAV with phase-aligned clicks
15. **Recording timing fixed**: removed bogus latency compensation, implemented two-phase spawn
16. **Zenity file dialogs**: F5 save, F6 open, I import, E export
17. **Project save/open** (.tuidaw gzipped tarball)
18. **Export mixdown** (ffmpeg amix filter with per-track volume + equal-power pan)
19. **Status messages**: temporary 3-second auto-dismiss
20. **Help overlay** (F1) with all shortcuts + mouse hints
21. **Mouse wheel scroll** on main waveform area (horizontal timeline scroll)
22. **Mouse wheel volume** on sidebar track rows
23. **Mouse wheel pan** on sidebar pan zone (row 1, x >= 17)
24. **Pan display** in sidebar (C/L##/R## format)
25. **Pan keyboard shortcuts** ([ and ])

## File structure

```
/home/kreejzak/code/crossatko/tuidaw/
├── agents.md                 # This file - context for future sessions
├── index.ts                  # Main entry - app init, transport logic, keyboard handling,
│                              # mouse handler setup, punchInTrack/punchOutTrack/
│                              # spawnRecordingForTrack, refreshLivePlayback,
│                              # shouldTrackPlay. ~776 lines.
├── package.json              # scripts: start (bun run index.ts), check (tsc --noEmit)
├── tsconfig.json             # strict mode, noUncheckedIndexedAccess: false
├── bun.lock
├── src/
│   ├── types.ts              # Types: Track (has pan field), ProjectState, PipeWireDevice,
│   │                          # TransportState, ProjectDescriptor, TrackDescriptor (has pan),
│   │                          # AudioChunk, constants (SIDEBAR_WIDTH=22, TOPBAR_HEIGHT=3,
│   │                          # TRACK_ROW_HEIGHT=4), TRACK_COLORS array, BRAILLE_BASE,
│   │                          # BRAILLE_DOTS. ~109 lines.
│   ├── audio-engine.ts       # AudioEngine class - PipeWire device enumeration, recording,
│   │                          # playback (split: prepareTrackWav + spawnTrackPlayer),
│   │                          # click (split: prepareClickWav + spawnClickPlayer),
│   │                          # markTransportStart, stopTrackPlayback, isTrackPlaying,
│   │                          # WAV read/write/parse, exportMixdown (with pan), saveProject,
│   │                          # openProject. Also exports zenitySave()/zenityOpen(). ~812 lines.
│   ├── braille.ts            # Braille waveform renderer (renderBrailleWaveform), level meter
│   │                          # (renderLevelMeter), peak detection (getPeakLevel). ~127 lines.
│   ├── state.ts              # State management - createDefaultState, createTrack,
│   │                          # getSelectedTrack, getArmedTrack, getArmedTracks, formatTime,
│   │                          # formatBeatPosition, getProjectDurationSamples,
│   │                          # getProjectDurationSeconds. ~94 lines.
│   └── ui.ts                 # UIRenderer class - all OpenTUI rendering + mouse handlers.
│                              # setupMouseHandlers(callbacks) for scroll/volume/pan.
│                              # Has Tokyo Night color constants. Renders: top bar, sidebar
│                              # (track list with M/S/R, volume, pan, level meters, input
│                              # device labels), main area (braille waveforms, beat grid
│                              # timeline, playhead), status bar, help overlay, device selector
│                              # overlay, file picker overlay. ~995 lines.
├── recordings/               # Auto-created directory for saved WAV files
└── node_modules/
    └── @opentui/core/        # OpenTUI framework (v0.1.88)
        ├── lib/RGBA.d.ts     # RGBA.fromHex(), RGBA.fromValues(), RGBA.fromInts()
        ├── renderer.d.ts     # MouseEvent class, MouseButton enum, CliRenderer
        ├── Renderable.d.ts   # onMouseScroll and other mouse handler setters
        └── renderables/
            ├── FrameBuffer.d.ts  # FrameBufferRenderable (inherits mouse from Renderable)
            └── Box.d.ts          # BoxRenderable (inherits mouse from Renderable)
```

## Key architecture patterns

### Two-phase transport start
All transport start operations (play/record) use a two-phase approach:
1. **Phase 1 (async)**: Write all WAV files to disk in parallel using `Promise.all`
2. **Phase 2 (sync)**: Spawn all pw-record/pw-play/click processes back-to-back with zero awaits

This minimizes timing skew between processes.

### AudioEngine split methods
- `playTrack()` = convenience wrapper: `prepareTrackWav()` + `spawnTrackPlayer()`
- `startClick()` = convenience wrapper: `prepareClickWav()` + `spawnClickPlayer()`
- The split allows pre-writing all files, then spawning everything at once in Phase 2.

### Live playback refresh
When mute/solo changes during transport, `refreshLivePlayback()` iterates all tracks, compares `isTrackPlaying()` vs `shouldTrackPlay()`, and starts/stops pw-play processes accordingly.

### Punch-in/out
`punchInTrack(track, position)` starts a new pw-record process mid-transport. `punchOutTrack(track)` stops the recording, merges audio, and saves to file. The track transitions between recording and playback seamlessly.

### UI rendering model
`UIRenderer.render(state)` redraws all four frame buffers (topbar, sidebar, main, statusbar) every frame. Overlays (help, device selector, file picker) are drawn on top of the main area FB. After rendering, `renderer.requestRender()` is called to flush changes to terminal.

### Mouse handler architecture
`UIRenderer.setupMouseHandlers(callbacks)` is called once after `setup()`, attaching `onMouseScroll` handlers to `mainFB` and `sidebarFB`. The handlers compute which track/zone the cursor is over and invoke the appropriate callback. The callbacks live in `index.ts` and have access to `state` and `render()`.

## Sidebar layout per track row (TRACK_ROW_HEIGHT=4)

```
y+0: [sel] [dot] [name............] [input]
y+1: [sel]  M  S  R  V:80%  C       <- volume at x=11, pan at x=17
y+2: [sel] [level meter / input device / "(empty)"]
y+3: [separator line ─────────────────────]
```

- Selection indicator `▌` at x=0 for rows 0-2 when selected
- Color dot `●` at x=1, row 0
- Track name starts at x=3, row 0
- M/S/R buttons at x=1/4/7, row 1
- Volume `V:xx%` at x=11, row 1
- Pan `C`/`L##`/`R##` at x=17, row 1
- Level meter or input device label or "(empty)" at x=1, row 2
- Separator `─` at row 3

Mouse zones for sidebar scroll:
- Row 1, x >= 17 = pan control
- Everything else = volume control
