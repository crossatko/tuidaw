// ============================================================================
// tuidaw - Terminal DAW powered by OpenTUI + miniaudio
// ============================================================================
// A full-featured Digital Audio Workstation in your terminal.
//
// Features:
//   - Multi-track recording via miniaudio native library
//   - Braille-character waveform display
//   - Playhead with beat grid
//   - BPM control with metronome click
//   - Live waveform drawing during recording
//   - Mute / Solo / Arm per track
//   - WAV import/export
//
// Requirements: Bun, native/libtuidaw_audio.so (built via native/build.sh)
// Usage: bun run index.ts
// ============================================================================

import { createCliRenderer, type KeyEvent } from "@opentui/core"
import { AudioEngine, zenitySave, zenityOpen } from "./src/audio-engine"
import { UIRenderer } from "./src/ui"
import {
  createDefaultState,
  createTrack,
  getSelectedTrack,
  getArmedTracks,
  getProjectDurationSamples,
} from "./src/state"
import type { ProjectState, Track } from "./src/types"
import { CLICK_TRACK_INDEX } from "./src/types"

async function main() {
  // ── Initialize ──────────────────────────────────────────────────────────
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    useMouse: true,
  })

  const state: ProjectState = createDefaultState()
  const audioEngine = new AudioEngine()
  const ui = new UIRenderer(renderer)

  ui.setup()

  // Set up mouse wheel handlers for scroll, volume, and pan
  ui.setupMouseHandlers({
    onScrollChange: (direction: number) => {
      // Scroll by 1 beat per wheel tick (content-space beats use originalBpm)
      const samplesPerBeat = Math.round((60 / state.originalBpm) * state.sampleRate)
      state.scrollOffset = Math.max(0, state.scrollOffset + direction * samplesPerBeat)
      // Enter free-scroll mode during playback so autoScroll doesn't snap back
      if (state.transportState !== "stopped") {
        state.freeScroll = true
      }
      render()
    },
    onVolumeChange: (delta: number) => {
      const track = getSelectedTrack(state)
      if (!track) return
      track.volume = Math.max(0, Math.min(1, track.volume + delta))
      // Instant volume change in native engine — no restart needed
      audioEngine.setTrackVolume(track.id, track.volume)
      render()
    },
    onPanChange: (delta: number) => {
      const track = getSelectedTrack(state)
      if (!track) return
      track.pan = Math.max(-1, Math.min(1, Math.round((track.pan + delta) * 100) / 100))
      // Instant pan change in native engine — no restart needed
      audioEngine.setTrackPan(track.id, track.pan)
      render()
    },
    onTrackClick: (trackIndex: number) => {
      if (trackIndex === CLICK_TRACK_INDEX) {
        state.selectedTrackIndex = CLICK_TRACK_INDEX
        render()
      } else if (trackIndex >= 0 && trackIndex < state.tracks.length) {
        state.selectedTrackIndex = trackIndex
        render()
      }
    },
    onTimelineClick: (x: number, mainWidth: number) => {
      // Same formula as ui.ts renderMainArea — content-space, no speed scaling
      const baseSamplesPerSubCol = Math.max(1, Math.floor(state.sampleRate / (mainWidth * 2) * 10))
      const samplesPerCol = baseSamplesPerSubCol * 2
      const samplePos = state.scrollOffset + x * samplesPerCol
      state.playheadPosition = Math.max(0, samplePos)
      if (state.transportState !== "stopped") {
        audioEngine.setPlayhead(state.playheadPosition)
        syncLoopAfterSeek()
      }
      ensurePlayheadVisible()
      render()
    },
    onClickVolumeChange: (delta: number) => {
      state.clickVolume = Math.max(0, Math.min(2, Math.round((state.clickVolume + delta) * 100) / 100))
      audioEngine.setClickVolume(state.clickVolume)
      render()
    },
    onClickPanChange: (delta: number) => {
      state.clickPan = Math.max(-1, Math.min(1, Math.round((state.clickPan + delta) * 100) / 100))
      audioEngine.setClickPan(state.clickPan)
      render()
    },
  })

  // Enumerate audio devices at startup
  const devices = await audioEngine.enumerateDevices()
  state.availableInputDevices = devices.inputs
  state.availableOutputDevices = devices.outputs

  // Per-track: the playhead position when that track's recording began (for punch-in)
  const trackRecordStartPositions: Map<string, number> = new Map()

  // Playhead update interval
  let playheadInterval: ReturnType<typeof setInterval> | null = null

  // ── Render ──────────────────────────────────────────────────────────────
  function render() {
    ui.render(state)
    if (ui.isHelpVisible()) {
      ui.renderHelpOverlay()
    }
    // Tell OpenTUI to flush frame buffer changes to the terminal.
    // During live mode (play/record) this is a no-op since the continuous
    // render loop is already running. In idle/stopped state this schedules
    // a single repaint frame so the screen actually updates.
    renderer.requestRender()
  }

  // ── Transport Controls ──────────────────────────────────────────────────

  // Helper: compute visible sample range in content-space
  // Must match ui.ts renderMainArea zoom calculation
  function getVisibleSamples() {
    const mainWidth = renderer.width - 22 // SIDEBAR_WIDTH
    const baseSamplesPerSubCol = Math.max(1, Math.floor(state.sampleRate / (mainWidth * 2) * 10))
    const samplesPerCol = baseSamplesPerSubCol * 2
    return mainWidth * samplesPerCol
  }

  // Helper: auto-scroll during live playback.
  // If freeScroll is true, the user has manually scrolled away from the playhead.
  // In that mode, we don't move the view — but if the playhead naturally enters
  // the visible area again, we re-engage tracking.
  // If a loop region is active and fits on screen, center the loop region
  // once and keep the view locked — no jumping around.
  // Otherwise, scroll forward when playhead nears the right edge, and
  // recenter when playhead jumps backward (e.g. loop wrap).
  function autoScroll() {
    const visibleSamples = getVisibleSamples()

    if (state.freeScroll) {
      // Check if the playhead has naturally entered the visible area
      const playheadVisible = state.playheadPosition >= state.scrollOffset &&
                              state.playheadPosition <= state.scrollOffset + visibleSamples
      if (playheadVisible) {
        // Re-engage tracking
        state.freeScroll = false
      } else {
        // Still free-roaming, don't touch scrollOffset
        return
      }
    }

    // If loop fits on screen, center the loop region and stay put
    if (state.loopStart !== null && state.loopEnd !== null) {
      const loopLen = state.loopEnd - state.loopStart
      if (loopLen <= visibleSamples) {
        const loopCenter = state.loopStart + loopLen / 2
        const idealOffset = Math.max(0, Math.floor(loopCenter - visibleSamples / 2))
        // Only reposition if the loop isn't already fully visible
        if (state.loopStart < state.scrollOffset ||
            state.loopEnd > state.scrollOffset + visibleSamples) {
          state.scrollOffset = idealOffset
        }
        return
      }
    }

    // No loop or loop is wider than the view — normal auto-scroll
    if (state.playheadPosition < state.scrollOffset) {
      // Playhead is left of view (loop wrap) — recenter
      state.scrollOffset = Math.max(0, state.playheadPosition - Math.floor(visibleSamples * 0.2))
    } else if (state.playheadPosition > state.scrollOffset + visibleSamples * 0.8) {
      state.scrollOffset = state.playheadPosition - Math.floor(visibleSamples * 0.2)
    }
  }

  // Helper: ensure playhead is visible, recentering view if it's outside the visible area.
  // Also clears freeScroll since the user explicitly moved the playhead.
  function ensurePlayheadVisible() {
    state.freeScroll = false
    const visibleSamples = getVisibleSamples()
    if (state.playheadPosition < state.scrollOffset ||
        state.playheadPosition > state.scrollOffset + visibleSamples) {
      // Center playhead in view
      state.scrollOffset = Math.max(0, state.playheadPosition - Math.floor(visibleSamples / 2))
    }
  }

  // Helper: sync native loop state after a manual playhead move.
  // If the playhead is moved past the loop region, disable the native loop
  // so playback continues linearly. If the playhead is before or inside the
  // loop, keep the native loop active — the native callback will play linearly
  // until reaching loopEnd, then wrap back to loopStart.
  function syncLoopAfterSeek() {
    if (state.loopStart === null || state.loopEnd === null) return
    if (state.playheadPosition > state.loopEnd) {
      // Past the loop — disable native loop enforcement
      audioEngine.setLoop(null, null)
    } else {
      // Before or inside loop — keep native loop active
      audioEngine.setLoop(state.loopStart, state.loopEnd)
    }
  }

  // Play (no armed tracks) – just plays back existing audio via native engine
  async function play() {
    state.transportState = "playing"

    // Sync all tracks and start native transport from current playhead
    await audioEngine.playAll(state)

    renderer.requestLive()

    // Playhead update interval — reads sample-accurate position from native engine
    playheadInterval = setInterval(() => {
      state.playheadPosition = audioEngine.getPlayhead()

      // Loop region handling is done natively in the audio callback,
      // but we need to read back the looped position for UI updates.

      autoScroll()
      render()
    }, 33) // ~30fps
  }

  // Record – starts native recording on each armed track while also playing
  // back non-armed tracks. New audio is written from the current playhead
  // position forward; existing audio before the playhead is preserved.
  async function startRecording() {
    const armedTracks = getArmedTracks(state)
    if (armedTracks.length === 0) return

    state.transportState = "recording"
    trackRecordStartPositions.clear()

    renderer.requestLive()

    // Remember the start position for each armed track
    for (const track of armedTracks) {
      trackRecordStartPositions.set(track.id, state.playheadPosition)
    }

    // Sync all tracks and start native transport (plays non-muted tracks)
    await audioEngine.playAll(state)

    // Start recording on each armed track
    for (const track of armedTracks) {
      await audioEngine.startRecording(track.id, () => {}, track.inputDeviceId)
    }

    // Playhead update interval — polls recording data and merges into tracks
    playheadInterval = setInterval(() => {
      state.playheadPosition = audioEngine.getPlayhead()

      // Poll recording data for each armed track
      for (const track of state.tracks) {
        if (!track.armed) continue
        if (!trackRecordStartPositions.has(track.id)) continue

        audioEngine.pollRecordingData(track.id, (newSamples: Float32Array) => {
          const recStart = trackRecordStartPositions.get(track.id) ?? 0

          // Get current total recorded length from native engine
          // (pollRecordingData gives us only the NEW chunk since last poll)
          const existingRecLen = track.samples
            ? Math.max(0, (track.samples.length - recStart))
            : 0

          // Merge: preserve [0..recStart], append new audio after existing recorded data
          const writeOffset = recStart + existingRecLen
          const totalLen = writeOffset + newSamples.length
          const existing = track.samples
          const merged = new Float32Array(Math.max(totalLen, existing ? existing.length : 0))

          // Copy all existing audio
          if (existing) {
            merged.set(existing.subarray(0, Math.min(existing.length, merged.length)), 0)
          }

          // Write new recorded audio at the write offset
          merged.set(newSamples, writeOffset)

          track.samples = merged
          track.sampleRate = state.sampleRate

          // Update native engine's track buffer so playback reflects new audio
          audioEngine.updateTrackSamples(track)
        })
      }

      autoScroll()
      render()
    }, 33)

    render()
  }

  // Punch-in: start recording on a single track at the given position.
  // Used for live R-key punch-in during playback.
  async function punchInTrack(track: Track, startPosition: number): Promise<void> {
    trackRecordStartPositions.set(track.id, startPosition)
    await audioEngine.startRecording(track.id, () => {}, track.inputDeviceId)
  }

  // Punch-out: stop recording on a single track and finalize its audio
  async function punchOutTrack(track: Track): Promise<void> {
    const samples = await audioEngine.stopTrackRecording(track.id)
    if (samples) {
      const recStart = trackRecordStartPositions.get(track.id) ?? 0

      const totalLen = recStart + samples.length
      const existing = track.samples
      const merged = new Float32Array(Math.max(totalLen, existing ? existing.length : 0))

      if (existing) {
        merged.set(existing.subarray(0, Math.min(existing.length, recStart)), 0)
        if (existing.length > totalLen) {
          merged.set(existing.subarray(totalLen), totalLen)
        }
      }
      merged.set(samples, recStart)

      track.samples = merged
      track.sampleRate = state.sampleRate

      // Update native engine's track buffer
      audioEngine.updateTrackSamples(track)

      await audioEngine.saveTrackToFile(track)
    }

    trackRecordStartPositions.delete(track.id)
  }

  // Helper: determine if a track should currently be audible for playback
  // (respects mute, solo, and armed-during-recording rules)
  function shouldTrackPlay(track: Track): boolean {
    if (track.muted) return false
    if (!track.samples || track.samples.length === 0) return false
    // During recording, armed tracks have their own capture device, not playback
    if (state.transportState === "recording" && track.armed) return false
    const hasSolo = state.tracks.some((t) => t.solo)
    if (hasSolo && !track.solo) return false
    return true
  }

  // Live re-evaluate which tracks should be playing.
  // Called when mute/solo changes during playback/recording.
  // In the native engine, this just updates mute/solo flags — the native
  // mixer handles the rest sample-accurately.
  function refreshLivePlayback(): void {
    for (const track of state.tracks) {
      audioEngine.setTrackMuted(track.id, track.muted)
      audioEngine.setTrackSolo(track.id, track.solo)
    }
  }

  // Stop everything (playback + recording)
  async function stop() {
    const wasRecording = state.transportState === "recording"
    state.transportState = "stopped"

    // Stop all active recordings and finalize track audio
    if (wasRecording) {
      const recordingTrackIds = [...trackRecordStartPositions.keys()]
      for (const trackId of recordingTrackIds) {
        const track = state.tracks.find((t) => t.id === trackId)
        if (track) {
          await punchOutTrack(track)
        }
      }
      trackRecordStartPositions.clear()
    }

    // Stop native transport (stops playback + click)
    await audioEngine.stopAll()

    if (playheadInterval) {
      clearInterval(playheadInterval)
      playheadInterval = null
    }
    state.freeScroll = false
    renderer.dropLive()
    render()
  }

  // ── Keyboard Handling ───────────────────────────────────────────────────
  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    // Quit
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      if (state.transportState !== "stopped") {
        await stop()
      }
      audioEngine.destroy()
      renderer.destroy()
      process.exit(0)
    }

    // Help
    if (key.name === "f1") {
      ui.toggleHelp()
      render()
      return
    }

    // If help is visible, any key closes it (except F1 handled above)
    if (ui.isHelpVisible()) {
      ui.toggleHelp()
      render()
      return
    }

    // Device selector overlay - intercept navigation keys
    if (ui.isDeviceSelectorVisible()) {
      if (key.name === "up" || key.name === "k") {
        ui.deviceSelectorUp()
        render()
        return
      }
      if (key.name === "down" || key.name === "j") {
        ui.deviceSelectorDown()
        render()
        return
      }
      if (key.name === "return") {
        ui.deviceSelectorConfirm()
        render()
        return
      }
      if (key.name === "escape") {
        ui.deviceSelectorCancel()
        render()
        return
      }
      // Ignore other keys while device selector is open
      return
    }

    // Space - Play/Stop toggle (records if any tracks are armed)
    if (key.name === "space") {
      if (state.transportState !== "stopped") {
        await stop()
      } else {
        const armed = getArmedTracks(state)
        if (armed.length > 0) {
          await startRecording()
        } else {
          await play()
        }
      }
      return
    }

    // R - Toggle arm on selected track
    // When transport is running: punch-in (arm) or punch-out (disarm) recording
    // on the fly without stopping playback.
    if (key.name === "r" && !key.ctrl) {
      const track = getSelectedTrack(state)
      if (track) {
        track.armed = !track.armed

        if (state.transportState !== "stopped") {
          const currentPos = audioEngine.getPlayhead()

          if (track.armed) {
            // Punch-in: start recording on this track at current playhead
            // Mute playback for this track while recording
            audioEngine.setTrackMuted(track.id, true)

            // If we were just "playing", transition to "recording"
            if (state.transportState === "playing") {
              state.transportState = "recording"
            }

            await punchInTrack(track, currentPos)
          } else {
            // Punch-out: stop recording on this track, finalize audio
            if (trackRecordStartPositions.has(track.id)) {
              await punchOutTrack(track)

              // Unmute the track if it should be audible
              if (shouldTrackPlay(track)) {
                audioEngine.setTrackMuted(track.id, false)
              }
            }

            // If no tracks are still recording, transition back to "playing"
            const stillRecording = state.tracks.some(
              (t) => t.armed && trackRecordStartPositions.has(t.id),
            )
            if (!stillRecording && state.transportState === "recording") {
              state.transportState = "playing"
            }
          }
        }

        render()
      }
      return
    }

    // A - Add track (blocked during transport)
    if (key.name === "a") {
      if (state.transportState !== "stopped") {
        ui.showStatusMessage("Stop transport first (SPACE)")
        render()
        return
      }
      const newTrack = createTrack()
      state.tracks.push(newTrack)
      state.selectedTrackIndex = state.tracks.length - 1
      render()
      return
    }

    // D or Delete - First press clears track content, second press deletes track
    // (blocked during transport)
    if (key.name === "d" || key.name === "delete") {
      if (state.transportState !== "stopped") {
        ui.showStatusMessage("Stop transport first (SPACE)")
        render()
        return
      }
      const track = getSelectedTrack(state)
      if (track) {
        if (track.samples && track.samples.length > 0) {
          // Track has content → clear it first
          track.samples = null
          track.filePath = null
          audioEngine.updateTrackSamples(track)
          ui.showStatusMessage(`Cleared "${track.name}" — press D again to delete track`)
        } else if (state.tracks.length > 1) {
          // Track is empty → delete it
          audioEngine.removeTrack(track.id)
          state.tracks.splice(state.selectedTrackIndex, 1)
          if (state.selectedTrackIndex >= state.tracks.length) {
            state.selectedTrackIndex = state.tracks.length - 1
          }
        } else {
          // Last track and already empty → reset its state
          track.armed = false
          track.muted = false
          track.solo = false
        }
      }
      render()
      return
    }

    // Up/Down - Select track (up from 0 goes to click track at index -1)
    if (key.name === "up" || key.name === "k") {
      if (state.selectedTrackIndex > CLICK_TRACK_INDEX) {
        state.selectedTrackIndex--
        render()
      }
      return
    }
    if (key.name === "down" || key.name === "j") {
      if (state.selectedTrackIndex < state.tracks.length - 1) {
        state.selectedTrackIndex++
        render()
      }
      return
    }

    // Left/Right - Scrub by beats (shift: by bars) — content-space beats
    if (key.name === "left" || key.name === "h") {
      const samplesPerBeat = Math.round((60 / state.originalBpm) * state.sampleRate)
      const scrollAmount = key.shift ? samplesPerBeat * 4 : samplesPerBeat
      state.scrollOffset = Math.max(0, state.scrollOffset - scrollAmount)
      if (state.transportState !== "stopped") {
        state.freeScroll = true
      }
      render()
      return
    }
    if (key.name === "right" || key.name === "l") {
      const samplesPerBeat = Math.round((60 / state.originalBpm) * state.sampleRate)
      const scrollAmount = key.shift ? samplesPerBeat * 4 : samplesPerBeat
      state.scrollOffset += scrollAmount
      if (state.transportState !== "stopped") {
        state.freeScroll = true
      }
      render()
      return
    }

    // Home or 0 - Jump to beginning
    if (key.name === "home" || key.sequence === "0") {
      state.playheadPosition = 0
      state.scrollOffset = 0
      state.freeScroll = false
      if (state.transportState !== "stopped") {
        audioEngine.setPlayhead(0)
        syncLoopAfterSeek()
      }
      render()
      return
    }

    // End - Jump to end
    if (key.name === "end") {
      let maxLen = 0
      for (const t of state.tracks) {
        if (t.samples && t.samples.length > maxLen) maxLen = t.samples.length
      }
      state.playheadPosition = maxLen
      if (state.transportState !== "stopped") {
        audioEngine.setPlayhead(state.playheadPosition)
        syncLoopAfterSeek()
      }
      ensurePlayheadVisible()
      render()
      return
    }

    // P - Practice loop: 3-step cycle
    //   1st press: set loop start at playhead
    //   2nd press: set loop end at playhead (swaps if before start)
    //   3rd press: clear loop region
    if (key.name === "p") {
      if (state.transportState !== "stopped") {
        // During transport, P clears the loop
        if (state.loopStart !== null && state.loopEnd !== null) {
          state.loopStart = null
          state.loopEnd = null
          // Update native engine loop state
          audioEngine.setLoop(null, null)
          ui.showStatusMessage("Loop cleared")
        }
        render()
        return
      }
      if (state.loopStart === null && state.loopEnd === null) {
        // Step 1: set loop start
        state.loopStart = state.playheadPosition
        ui.showStatusMessage("Loop start set — move playhead, press P again for end")
      } else if (state.loopStart !== null && state.loopEnd === null) {
        // Step 2: set loop end
        const a = state.loopStart
        const b = state.playheadPosition
        if (a === b) {
          // Same position — cancel
          state.loopStart = null
          ui.showStatusMessage("Loop cancelled (start = end)")
        } else {
          state.loopStart = Math.min(a, b)
          state.loopEnd = Math.max(a, b)
          ui.showStatusMessage("Loop region set — press P to clear")
        }
      } else {
        // Step 3: clear loop
        state.loopStart = null
        state.loopEnd = null
        ui.showStatusMessage("Loop cleared")
      }
      render()
      return
    }

    // M - Mute (instant in native engine — no process restart)
    // When click track is selected: toggle clickEnabled (same as C)
    if (key.name === "m") {
      if (state.selectedTrackIndex === CLICK_TRACK_INDEX) {
        // Toggle click enable/disable (same as C key)
        state.clickEnabled = !state.clickEnabled
        if (state.transportState !== "stopped") {
          if (state.clickEnabled) {
            audioEngine.updateClickBuffer(state.originalBpm, state.sampleRate)
            await audioEngine.startClick(state.originalBpm)
          } else {
            audioEngine.stopClick()
          }
        }
        render()
      } else {
        const track = getSelectedTrack(state)
        if (track) {
          track.muted = !track.muted
          if (state.transportState !== "stopped") {
            refreshLivePlayback()
          }
          render()
        }
      }
      return
    }

    // S - Solo (instant in native engine — re-evaluates all tracks)
    if (key.name === "s") {
      const track = getSelectedTrack(state)
      if (track) {
        track.solo = !track.solo
        if (state.transportState !== "stopped") {
          refreshLivePlayback()
        }
        render()
      }
      return
    }

    // + / = - Increase BPM (instant click update in native engine + WSOLA speed)
    if (key.sequence === "+" || key.sequence === "=") {
      state.bpm = Math.min(300, state.bpm + (key.shift ? 10 : 1))
      // On empty project, change the base tempo (no speed change needed)
      if (getProjectDurationSamples(state) === 0) {
        state.originalBpm = state.bpm
      }
      // Update WSOLA playback speed based on ratio to original BPM
      const speed = state.bpm / state.originalBpm
      audioEngine.setSpeed(speed)
      // Always regenerate click buffer when BPM changes (originalBpm may have changed)
      audioEngine.updateClickBuffer(state.originalBpm, state.sampleRate)
      if (state.transportState !== "stopped" && state.clickEnabled) {
        await audioEngine.startClick(state.originalBpm)
      }
      render()
      return
    }

    // - - Decrease BPM (instant click update in native engine + WSOLA speed)
    if (key.sequence === "-") {
      state.bpm = Math.max(20, state.bpm - (key.shift ? 10 : 1))
      // On empty project, change the base tempo (no speed change needed)
      if (getProjectDurationSamples(state) === 0) {
        state.originalBpm = state.bpm
      }
      // Update WSOLA playback speed based on ratio to original BPM
      const speed = state.bpm / state.originalBpm
      audioEngine.setSpeed(speed)
      // Always regenerate click buffer when BPM changes (originalBpm may have changed)
      audioEngine.updateClickBuffer(state.originalBpm, state.sampleRate)
      if (state.transportState !== "stopped" && state.clickEnabled) {
        await audioEngine.startClick(state.originalBpm)
      }
      render()
      return
    }

    // C - Toggle click (instant in native engine)
    if (key.name === "c") {
      state.clickEnabled = !state.clickEnabled
      if (state.transportState !== "stopped") {
        if (state.clickEnabled) {
          audioEngine.updateClickBuffer(state.originalBpm, state.sampleRate)
          await audioEngine.startClick(state.originalBpm)
        } else {
          audioEngine.stopClick()
        }
      }
      render()
      return
    }

    // F2 - Select input device for selected track
    if (key.name === "f2") {
      // Refresh device list
      const devs = await audioEngine.enumerateDevices()
      state.availableInputDevices = devs.inputs
      state.availableOutputDevices = devs.outputs

      const track = getSelectedTrack(state)
      if (track) {
        ui.openDeviceSelector("input", state.availableInputDevices, track.inputDeviceId, (device) => {
          track.inputDeviceId = device ? device.id : null
        })
        render()
      }
      return
    }

    // F3 - Select output device (global)
    if (key.name === "f3") {
      // Refresh device list
      const devs = await audioEngine.enumerateDevices()
      state.availableInputDevices = devs.inputs
      state.availableOutputDevices = devs.outputs

      ui.openDeviceSelector("output", state.availableOutputDevices, state.outputDeviceId, (device) => {
        state.outputDeviceId = device ? device.id : null
      })
      render()
      return
    }

    // I - Import WAV (zenity open dialog)
    if (key.name === "i") {
      const track = getSelectedTrack(state)
      if (track) {
        const filePath = await zenityOpen("Import WAV", ["WAV files | *.wav *.WAV", "All files | *"])
        if (filePath) {
          const result = await audioEngine.loadWavFile(filePath)
          if (result) {
            track.samples = result.samples
            track.sampleRate = result.sampleRate
            audioEngine.updateTrackSamples(track)

            // Auto-detect BPM when importing to an empty project (no tracks have audio)
            const projectIsEmpty = state.tracks.every((t) => t === track || !t.samples)
            if (projectIsEmpty && result.detectedBPM) {
              state.bpm = result.detectedBPM
              state.originalBpm = result.detectedBPM
              audioEngine.setSpeed(1.0) // reset speed since bpm == originalBpm
              audioEngine.startClick(state.originalBpm) // sync click generator
              ui.showStatusMessage(`Imported: ${filePath} (detected ${result.detectedBPM} BPM)`)
            } else {
              ui.showStatusMessage(`Imported: ${filePath}`)
            }
          } else {
            ui.showStatusMessage("Failed to import WAV!")
          }
          render()
        }
      }
      return
    }

    // F5 - Save project (.tuidaw tarball via zenity save dialog)
    if (key.name === "f5") {
      const defaultName = `${state.projectName.replace(/\s+/g, "_")}.tuidaw`
      const filePath = await zenitySave("Save Project", defaultName, ["tuidaw files | *.tuidaw", "All files | *"])
      if (filePath) {
        ui.showStatusMessage("Saving...")
        render()
        const ok = await audioEngine.saveProject(state, filePath)
        ui.showStatusMessage(ok ? `Saved: ${filePath}` : "Save failed!")
      }
      render()
      return
    }

    // F6 - Open project (.tuidaw tarball via zenity open dialog)
    if (key.name === "f6") {
      const filePath = await zenityOpen("Open Project", ["tuidaw files | *.tuidaw", "All files | *"])
      if (filePath) {
        const loaded = await audioEngine.openProject(filePath)
        if (loaded) {
          Object.assign(state, loaded)
          // Sync all loaded tracks to the native engine
          audioEngine.syncAllTracks(state)
          // Restore WSOLA speed from saved bpm/originalBpm ratio
          audioEngine.setSpeed(state.bpm / state.originalBpm)
          const devs = await audioEngine.enumerateDevices()
          state.availableInputDevices = devs.inputs
          state.availableOutputDevices = devs.outputs
          ui.showStatusMessage(`Opened: ${filePath}`)
        } else {
          ui.showStatusMessage("Failed to open project!")
        }
      }
      render()
      return
    }

    // E - Export mixdown WAV (zenity save dialog)
    if (key.name === "e") {
      const defaultName = `${state.projectName.replace(/\s+/g, "_")}_mix.wav`
      const filePath = await zenitySave("Export Mixdown", defaultName, ["WAV files | *.wav", "All files | *"])
      if (filePath) {
        ui.showStatusMessage("Exporting mixdown...")
        render()
        const ok = await audioEngine.exportMixdown(state, filePath)
        ui.showStatusMessage(ok ? `Exported: ${filePath}` : "Export failed!")
      }
      render()
      return
    }

    // V - Volume up (instant in native engine)
    // When click track is selected: increase click volume
    if (key.name === "v" && !key.shift) {
      if (state.selectedTrackIndex === CLICK_TRACK_INDEX) {
        state.clickVolume = Math.min(2, Math.round((state.clickVolume + 0.05) * 100) / 100)
        audioEngine.setClickVolume(state.clickVolume)
        render()
      } else {
        const track = getSelectedTrack(state)
        if (track) {
          track.volume = Math.min(1, track.volume + 0.05)
          audioEngine.setTrackVolume(track.id, track.volume)
          render()
        }
      }
      return
    }

    // [ - Scrub playhead left by 1 bar (4 beats) — works during playback
    if (key.sequence === "[") {
      const samplesPerBeat = Math.round((60 / state.originalBpm) * state.sampleRate)
      const samplesPerBar = samplesPerBeat * 4
      state.playheadPosition = Math.max(0, state.playheadPosition - samplesPerBar)
      if (state.transportState !== "stopped") {
        audioEngine.setPlayhead(state.playheadPosition)
        syncLoopAfterSeek()
      }
      ensurePlayheadVisible()
      render()
      return
    }

    // ] - Scrub playhead right by 1 bar (4 beats) — works during playback
    if (key.sequence === "]") {
      const samplesPerBeat = Math.round((60 / state.originalBpm) * state.sampleRate)
      const samplesPerBar = samplesPerBeat * 4
      state.playheadPosition += samplesPerBar
      if (state.transportState !== "stopped") {
        audioEngine.setPlayhead(state.playheadPosition)
        syncLoopAfterSeek()
      }
      ensurePlayheadVisible()
      render()
      return
    }

    // < (shift+,) - Pan left (instant in native engine)
    // When click track is selected: pan click left
    if (key.sequence === "<") {
      if (state.selectedTrackIndex === CLICK_TRACK_INDEX) {
        state.clickPan = Math.max(-1, Math.round((state.clickPan - 0.1) * 100) / 100)
        audioEngine.setClickPan(state.clickPan)
        render()
      } else {
        const track = getSelectedTrack(state)
        if (track) {
          track.pan = Math.max(-1, Math.round((track.pan - 0.1) * 100) / 100)
          audioEngine.setTrackPan(track.id, track.pan)
          render()
        }
      }
      return
    }

    // > (shift+.) - Pan right (instant in native engine)
    // When click track is selected: pan click right
    if (key.sequence === ">") {
      if (state.selectedTrackIndex === CLICK_TRACK_INDEX) {
        state.clickPan = Math.min(1, Math.round((state.clickPan + 0.1) * 100) / 100)
        audioEngine.setClickPan(state.clickPan)
        render()
      } else {
        const track = getSelectedTrack(state)
        if (track) {
          track.pan = Math.min(1, Math.round((track.pan + 0.1) * 100) / 100)
          audioEngine.setTrackPan(track.id, track.pan)
          render()
        }
      }
      return
    }
  })

  // ── Window Resize ───────────────────────────────────────────────────────
  renderer.on("resize", () => {
    ui.resize()
    render()
  })

  // ── Initial Render ──────────────────────────────────────────────────────
  render()
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
