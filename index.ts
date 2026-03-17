// ============================================================================
// tuidaw - Terminal DAW powered by OpenTUI + PipeWire
// ============================================================================
// A full-featured Digital Audio Workstation in your terminal.
//
// Features:
//   - Multi-track recording via PipeWire
//   - Braille-character waveform display
//   - Playhead with beat grid
//   - BPM control with metronome click
//   - Live waveform drawing during recording
//   - Mute / Solo / Arm per track
//   - WAV import/export
//
// Requirements: Arch Linux, PipeWire, Bun
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
} from "./src/state"
import type { ProjectState, Track } from "./src/types"

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
      // Scroll ~0.5 seconds per wheel tick
      const scrollAmount = Math.floor(state.sampleRate * 0.5)
      state.scrollOffset = Math.max(0, state.scrollOffset + direction * scrollAmount)
      render()
    },
    onVolumeChange: async (delta: number) => {
      const track = getSelectedTrack(state)
      if (!track) return
      track.volume = Math.max(0, Math.min(1, track.volume + delta))
      if (state.transportState !== "stopped" && audioEngine.isTrackPlaying(track.id)) {
        audioEngine.setTrackVolume(track.id, track.volume)
      }
      render()
    },
    onPanChange: async (delta: number) => {
      const track = getSelectedTrack(state)
      if (!track) return
      track.pan = Math.max(-1, Math.min(1, Math.round((track.pan + delta) * 100) / 100))
      if (state.transportState !== "stopped" && audioEngine.isTrackPlaying(track.id)) {
        const currentPos = transportStartPosition + audioEngine.getElapsedSamples()
        await audioEngine.restartTrackForPan(track, currentPos, state.outputDeviceId)
      }
      render()
    },
    onTrackClick: (trackIndex: number) => {
      if (trackIndex >= 0 && trackIndex < state.tracks.length) {
        state.selectedTrackIndex = trackIndex
        render()
      }
    },
    onTimelineClick: (x: number, mainWidth: number) => {
      if (state.transportState !== "stopped") return
      // Same formula as ui.ts renderMainArea/renderTimeline
      const samplesPerSubCol = Math.max(1, Math.floor(state.sampleRate / (mainWidth * 2) * 10))
      const samplesPerCol = samplesPerSubCol * 2
      const samplePos = state.scrollOffset + x * samplesPerCol
      state.playheadPosition = Math.max(0, samplePos)
      render()
    },
  })

  // Enumerate PipeWire devices at startup
  const devices = await audioEngine.enumerateDevices()
  state.availableInputDevices = devices.inputs
  state.availableOutputDevices = devices.outputs

  // Per-track live recording buffers (trackId -> chunks)
  const liveRecordingBuffers: Map<string, Float32Array[]> = new Map()

  // The playhead position when transport started (play or record)
  let transportStartPosition = 0

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

  // Helper: compute auto-scroll values
  function autoScroll() {
    const mainWidth = renderer.width - 22 // SIDEBAR_WIDTH
    const samplesPerSubCol = Math.max(1, Math.floor(state.sampleRate / (mainWidth * 2) * 10))
    const samplesPerCol = samplesPerSubCol * 2
    const visibleSamples = mainWidth * samplesPerCol
    if (state.playheadPosition > state.scrollOffset + visibleSamples * 0.8) {
      state.scrollOffset = state.playheadPosition - Math.floor(visibleSamples * 0.2)
    }
  }

  // Play (no armed tracks) – just plays back existing audio
  async function play() {
    state.transportState = "playing"
    transportStartPosition = state.playheadPosition

    await audioEngine.playAll(state)

    // Update playhead position based on elapsed time
    renderer.requestLive()
    playheadInterval = setInterval(() => {
      const elapsed = audioEngine.getElapsedSamples()
      state.playheadPosition = transportStartPosition + elapsed
      autoScroll()
      render()
    }, 33) // ~30fps
  }

  // Record – starts pw-record on each armed track while also playing back
  // non-armed tracks. New audio is written from the current playhead position
  // forward; existing audio before the playhead is preserved.
  //
  // Two-phase approach to minimize timing skew between record and playback:
  //   Phase 1: prepare all WAV files and set up recording state (slow I/O)
  //   Phase 2: spawn all processes back-to-back (fast, no awaits)
  async function startRecording() {
    const armedTracks = getArmedTracks(state)
    if (armedTracks.length === 0) return

    state.transportState = "recording"
    transportStartPosition = state.playheadPosition
    liveRecordingBuffers.clear()
    trackRecordStartPositions.clear()

    renderer.requestLive()

    // Phase 1: prepare — write all playback WAV files and click WAV to disk,
    // and set up recording buffers. All I/O happens here.
    const playbackPreps: { trackId: string; wavPath: string }[] = []
    const prepPromises: Promise<void>[] = []

    // Prepare playback tracks
    for (const track of state.tracks) {
      if (track.armed) continue
      if (track.muted) continue
      if (!track.samples || track.samples.length === 0) continue
      const hasSolo = state.tracks.some((t) => t.solo)
      if (hasSolo && !track.solo) continue

      prepPromises.push(
        audioEngine.prepareTrackWav(track, transportStartPosition).then((path) => {
          if (path) playbackPreps.push({ trackId: track.id, wavPath: path })
        }),
      )
    }

    // Prepare click WAV
    let clickWavPath: string | null = null
    if (state.clickEnabled) {
      prepPromises.push(
        audioEngine.prepareClickWav(state.bpm, transportStartPosition).then((path) => {
          clickWavPath = path
        }),
      )
    }

    // Set up recording buffers for armed tracks
    for (const track of armedTracks) {
      liveRecordingBuffers.set(track.id, [])
      trackRecordStartPositions.set(track.id, transportStartPosition)
    }

    await Promise.all(prepPromises)

    // Phase 2: spawn all processes back-to-back with no awaits between them.
    // This ensures pw-record and pw-play/click start at nearly the same instant.
    audioEngine.markTransportStart()

    // Spawn pw-record for each armed track
    for (const track of armedTracks) {
      spawnRecordingForTrack(track)
    }

    // Spawn pw-play for playback tracks
    for (const { trackId, wavPath } of playbackPreps) {
      audioEngine.spawnTrackPlayer(trackId, wavPath, state.outputDeviceId)
    }

    // Spawn click
    if (clickWavPath) {
      audioEngine.spawnClickPlayer(clickWavPath, state.outputDeviceId)
    }

    // Start playhead update interval
    playheadInterval = setInterval(() => {
      const elapsed = audioEngine.getElapsedSamples()
      const timeBasedPos = transportStartPosition + elapsed
      if (timeBasedPos > state.playheadPosition) {
        state.playheadPosition = timeBasedPos
      }
      autoScroll()
      render()
    }, 33)

    render()
  }

  // Spawn pw-record for a single track (synchronous — no awaits).
  // Sets up the recording stream reader in the background.
  function spawnRecordingForTrack(track: Track): void {
    audioEngine.startRecording(
      track.id,
      (chunk: Float32Array) => {
        const chunks = liveRecordingBuffers.get(track.id)
        if (!chunks) return

        chunks.push(new Float32Array(chunk))

        // Concatenate all new chunks so far
        const totalNewLen = chunks.reduce((sum, c) => sum + c.length, 0)
        const newAudio = new Float32Array(totalNewLen)
        let off = 0
        for (const c of chunks) {
          newAudio.set(c, off)
          off += c.length
        }

        const recStart = trackRecordStartPositions.get(track.id) ?? transportStartPosition

        // Merge with existing audio: preserve [0..recStart],
        // write new audio at [recStart..]
        const totalLen = recStart + newAudio.length
        const existing = track.samples
        const merged = new Float32Array(Math.max(totalLen, existing ? existing.length : 0))

        // Copy pre-existing audio
        if (existing) {
          merged.set(existing.subarray(0, Math.min(existing.length, recStart)), 0)
          // Preserve tail beyond new recording if existing is longer
          if (existing.length > totalLen) {
            merged.set(existing.subarray(totalLen), totalLen)
          }
        }

        // Write new recorded audio at recStart
        merged.set(newAudio, recStart)

        track.samples = merged
        track.sampleRate = state.sampleRate

        // Move playhead to the end of the new recording
        state.playheadPosition = recStart + newAudio.length
        autoScroll()
        render()
      },
      track.inputDeviceId,
    )
  }

  // Punch-in: start recording on a single track at the given position.
  // Used for live R-key punch-in during playback.
  async function punchInTrack(track: Track, startPosition: number): Promise<void> {
    liveRecordingBuffers.set(track.id, [])
    trackRecordStartPositions.set(track.id, startPosition)
    spawnRecordingForTrack(track)
  }

  // Punch-out: stop recording on a single track and finalize its audio
  async function punchOutTrack(track: Track): Promise<void> {
    const samples = await audioEngine.stopTrackRecording(track.id)
    if (samples) {
      const recStart = trackRecordStartPositions.get(track.id) ?? transportStartPosition

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

      await audioEngine.saveTrackToFile(track)
    }

    liveRecordingBuffers.delete(track.id)
    trackRecordStartPositions.delete(track.id)
  }

  // Helper: determine if a track should currently be audible for playback
  // (respects mute, solo, and armed-during-recording rules)
  function shouldTrackPlay(track: Track): boolean {
    if (track.muted) return false
    if (!track.samples || track.samples.length === 0) return false
    // During recording, armed tracks have their own pw-record, not pw-play
    if (state.transportState === "recording" && track.armed) return false
    const hasSolo = state.tracks.some((t) => t.solo)
    if (hasSolo && !track.solo) return false
    return true
  }

  // Live re-evaluate which tracks should be playing.
  // Called when mute/solo changes during playback/recording.
  async function refreshLivePlayback(): Promise<void> {
    const currentPos = transportStartPosition + audioEngine.getElapsedSamples()

    for (const track of state.tracks) {
      const isPlaying = audioEngine.isTrackPlaying(track.id)
      const shouldPlay = shouldTrackPlay(track)

      if (isPlaying && !shouldPlay) {
        // Track is playing but should be silent → kill it
        audioEngine.stopTrackPlayback(track.id)
      } else if (!isPlaying && shouldPlay) {
        // Track should be playing but isn't → start from current position
        await audioEngine.playTrack(track, currentPos, state.outputDeviceId)
      }
    }
  }

  // Stop everything (playback + recording)
  async function stop() {
    const wasRecording = state.transportState === "recording"
    state.transportState = "stopped"

    // Stop all playback
    await audioEngine.stopAll()

    // Stop all recordings and finalize track audio
    if (wasRecording) {
      const recordingTrackIds = [...liveRecordingBuffers.keys()]
      for (const trackId of recordingTrackIds) {
        const track = state.tracks.find((t) => t.id === trackId)
        if (track) {
          await punchOutTrack(track)
        }
      }

      liveRecordingBuffers.clear()
      trackRecordStartPositions.clear()
    }

    if (playheadInterval) {
      clearInterval(playheadInterval)
      playheadInterval = null
    }
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
          const currentPos = transportStartPosition + audioEngine.getElapsedSamples()

          if (track.armed) {
            // Punch-in: start recording on this track at current playhead
            // Stop playback for this track (it will be recording instead)
            audioEngine.stopTrackPlayback(track.id)

            // If we were just "playing", transition to "recording"
            if (state.transportState === "playing") {
              state.transportState = "recording"
            }

            await punchInTrack(track, currentPos)
          } else {
            // Punch-out: stop recording on this track, finalize audio
            if (liveRecordingBuffers.has(track.id)) {
              await punchOutTrack(track)

              // If the track isn't muted and should be audible, start playback
              if (shouldTrackPlay(track)) {
                await audioEngine.playTrack(track, currentPos, state.outputDeviceId)
              }
            }

            // If no tracks are still recording, transition back to "playing"
            const stillRecording = state.tracks.some(
              (t) => t.armed && liveRecordingBuffers.has(t.id),
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

    // A - Add track (blocked during transport to avoid pw-play/record confusion)
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
          ui.showStatusMessage(`Cleared "${track.name}" — press D again to delete track`)
        } else if (state.tracks.length > 1) {
          // Track is empty → delete it
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

    // Up/Down - Select track
    if (key.name === "up" || key.name === "k") {
      if (state.selectedTrackIndex > 0) {
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

    // Left/Right - Scroll
    if (key.name === "left" || key.name === "h") {
      const scrollAmount = Math.floor(state.sampleRate * (key.shift ? 5 : 1))
      state.scrollOffset = Math.max(0, state.scrollOffset - scrollAmount)
      render()
      return
    }
    if (key.name === "right" || key.name === "l") {
      const scrollAmount = Math.floor(state.sampleRate * (key.shift ? 5 : 1))
      state.scrollOffset += scrollAmount
      render()
      return
    }

    // Home or 0 - Jump to beginning
    if (key.name === "home" || key.sequence === "0") {
      state.playheadPosition = 0
      state.scrollOffset = 0
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
      render()
      return
    }

    // M - Mute (live: kills or starts pw-play for the affected track)
    if (key.name === "m") {
      const track = getSelectedTrack(state)
      if (track) {
        track.muted = !track.muted
        if (state.transportState !== "stopped") {
          await refreshLivePlayback()
        }
        render()
      }
      return
    }

    // S - Solo (live: re-evaluates all tracks' playback)
    if (key.name === "s") {
      const track = getSelectedTrack(state)
      if (track) {
        track.solo = !track.solo
        if (state.transportState !== "stopped") {
          await refreshLivePlayback()
        }
        render()
      }
      return
    }

    // + / = - Increase BPM (live: restarts click with new BPM)
    if (key.sequence === "+" || key.sequence === "=") {
      state.bpm = Math.min(300, state.bpm + (key.shift ? 10 : 1))
      if (state.transportState !== "stopped" && state.clickEnabled) {
        await audioEngine.startClick(state.bpm, state.playheadPosition, state.outputDeviceId)
      }
      render()
      return
    }

    // - - Decrease BPM (live: restarts click with new BPM)
    if (key.sequence === "-") {
      state.bpm = Math.max(20, state.bpm - (key.shift ? 10 : 1))
      if (state.transportState !== "stopped" && state.clickEnabled) {
        await audioEngine.startClick(state.bpm, state.playheadPosition, state.outputDeviceId)
      }
      render()
      return
    }

    // C - Toggle click (live: starts or stops the click process)
    if (key.name === "c") {
      state.clickEnabled = !state.clickEnabled
      if (state.transportState !== "stopped") {
        if (state.clickEnabled) {
          // Start click from current playhead position, phase-aligned
          await audioEngine.startClick(state.bpm, state.playheadPosition, state.outputDeviceId)
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
            ui.showStatusMessage(`Imported: ${filePath}`)
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

    // V - Volume up
    if (key.name === "v" && !key.shift) {
      const track = getSelectedTrack(state)
      if (track) {
        track.volume = Math.min(1, track.volume + 0.05)
        if (state.transportState !== "stopped" && audioEngine.isTrackPlaying(track.id)) {
          audioEngine.setTrackVolume(track.id, track.volume)
        }
        render()
      }
      return
    }

    // [ - Scrub playhead left (1 second, 5 seconds with shift — but shift+[ is { so just 1s)
    if (key.sequence === "[") {
      if (state.transportState !== "stopped") return
      state.playheadPosition = Math.max(0, state.playheadPosition - state.sampleRate)
      render()
      return
    }

    // ] - Scrub playhead right
    if (key.sequence === "]") {
      if (state.transportState !== "stopped") return
      state.playheadPosition += state.sampleRate
      render()
      return
    }

    // < (shift+,) - Pan left
    if (key.sequence === "<") {
      const track = getSelectedTrack(state)
      if (track) {
        track.pan = Math.max(-1, Math.round((track.pan - 0.1) * 100) / 100)
        if (state.transportState !== "stopped" && audioEngine.isTrackPlaying(track.id)) {
          const currentPos = transportStartPosition + audioEngine.getElapsedSamples()
          await audioEngine.restartTrackForPan(track, currentPos, state.outputDeviceId)
        }
        render()
      }
      return
    }

    // > (shift+.) - Pan right
    if (key.sequence === ">") {
      const track = getSelectedTrack(state)
      if (track) {
        track.pan = Math.min(1, Math.round((track.pan + 0.1) * 100) / 100)
        if (state.transportState !== "stopped" && audioEngine.isTrackPlaying(track.id)) {
          const currentPos = transportStartPosition + audioEngine.getElapsedSamples()
          await audioEngine.restartTrackForPan(track, currentPos, state.outputDeviceId)
        }
        render()
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
