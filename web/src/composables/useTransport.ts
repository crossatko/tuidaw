// ============================================================================
// useTransport — Play/stop/record/loop/seek transport controls
// ============================================================================

import type { WebTrack } from '../../audio-bridge'
import { useAppState, showStatus, SAMPLE_RATE } from './useAppState'
import {
  getAudio,
  ensureAudioReady,
  updateClickBuffer,
  getClickDuration
} from './useAudio'

// ── Recording bookkeeping ───────────────────────────────────────────────
const trackRecordStartPositions = new Map<string, number>()
const trackRecordedSamples = new Map<string, Float32Array[]>()

let animFrameId: number | null = null

// ── Render callback (set by App.vue) ────────────────────────────────────
let _renderFn: (() => void) | null = null

export function setRenderCallback(fn: () => void): void {
  _renderFn = fn
}

export function requestRender(): void {
  _renderFn?.()
}

// ── Transport common setup ──────────────────────────────────────────────
function startTransportCommon(): void {
  const state = useAppState()
  const audio = getAudio()

  // Sync all tracks to WASM engine
  for (const track of state.tracks) {
    audio.syncTrack(track)
  }

  // Click setup
  if (state.clickEnabled) {
    const dur = getClickDuration()
    updateClickBuffer(state.bpm, dur)
    audio.setClick(true, state.bpm)
  } else {
    audio.setClick(false, state.bpm)
  }
  audio.setClickVolume(state.clickVolume)
  audio.setClickPan(state.clickPan)

  // Loop
  if (state.loopStart !== null && state.loopEnd !== null) {
    audio.setLoop(state.loopStart, state.loopEnd)
  } else {
    audio.setLoop(-1, -1)
  }

  // Speed
  const speed = state.bpm / state.originalBpm
  audio.setSpeed(speed)

  // Play
  audio.play(state.playheadPosition)
}

// ── Play ────────────────────────────────────────────────────────────────
export async function play(): Promise<void> {
  const state = useAppState()
  if (state.transportState !== 'stopped') return

  const ready = await ensureAudioReady()
  if (!ready) return

  state.freeScroll = false

  const armedTracks = state.tracks.filter((t) => t.armed)
  if (armedTracks.length > 0) {
    await startRecording(armedTracks)
  } else {
    state.transportState = 'playing'
    startTransportCommon()
    startPlayheadPolling()
  }
}

// ── Record ──────────────────────────────────────────────────────────────
async function startRecording(armedTracks: WebTrack[]): Promise<void> {
  const state = useAppState()
  const audio = getAudio()

  state.transportState = 'recording'

  trackRecordStartPositions.clear()
  trackRecordedSamples.clear()

  startTransportCommon()

  for (const track of armedTracks) {
    const startPos = state.playheadPosition
    trackRecordStartPositions.set(track.id, startPos)
    trackRecordedSamples.set(track.id, [])
    audio.setTrackMuted(track.id, true) // mute own playback during recording
    await audio.startRecording(
      track.id,
      track.inputDeviceId,
      track.inputChannel
    )
  }

  startPlayheadPolling()
}

// ── Punch in/out ────────────────────────────────────────────────────────
export async function punchInTrack(
  track: WebTrack,
  startPosition: number
): Promise<void> {
  const audio = getAudio()
  trackRecordStartPositions.set(track.id, startPosition)
  trackRecordedSamples.set(track.id, [])
  audio.setTrackMuted(track.id, true)
  await audio.startRecording(track.id, track.inputDeviceId, track.inputChannel)
}

export function punchOutTrack(track: WebTrack): void {
  const audio = getAudio()

  // Stop recording
  audio.stopRecording(track.id)

  // Poll final data
  const finalData = audio.pollRecording(track.id)
  const chunks = trackRecordedSamples.get(track.id) || []
  if (finalData && finalData.length > 0) chunks.push(finalData)

  // Merge chunks
  const startPos = trackRecordStartPositions.get(track.id) || 0
  const totalRecorded = chunks.reduce((sum, c) => sum + c.length, 0)

  if (totalRecorded > 0) {
    const endPos = startPos + totalRecorded
    const totalLen = Math.max(track.samples?.length || 0, endPos)
    const merged = new Float32Array(totalLen)

    // Copy existing audio
    if (track.samples) merged.set(track.samples)

    // Overlay recorded audio
    let offset = startPos
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    track.samples = merged
    track.sampleRate = SAMPLE_RATE
    audio.setTrackSamples(track.id, merged)
  }

  // Unmute
  audio.setTrackMuted(track.id, track.muted)
  trackRecordStartPositions.delete(track.id)
  trackRecordedSamples.delete(track.id)
}

// ── Stop ────────────────────────────────────────────────────────────────
export async function stopTransport(): Promise<void> {
  const state = useAppState()
  const audio = getAudio()

  const wasRecording = state.transportState === 'recording'

  // Finalize all recordings
  for (const [trackId] of trackRecordStartPositions) {
    const track = state.tracks.find((t) => t.id === trackId)
    if (track) punchOutTrack(track)
  }

  // Auto-disarm after recording
  if (wasRecording) {
    for (const track of state.tracks) {
      track.armed = false
    }
  }

  state.transportState = 'stopped'
  state.freeScroll = false
  audio.stop()

  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId)
    animFrameId = null
  }

  requestRender()
}

// ── Toggle loop ─────────────────────────────────────────────────────────
export function toggleLoop(): void {
  const state = useAppState()
  const audio = getAudio()

  if (state.transportState !== 'stopped') {
    // During transport, only clear
    if (state.loopStart !== null || state.loopEnd !== null) {
      state.loopStart = null
      state.loopEnd = null
      if (audio.isReady) audio.setLoop(-1, -1)
      showStatus('Loop cleared')
    }
    return
  }

  if (state.loopStart === null) {
    // Step 1: set start
    state.loopStart = state.playheadPosition
    showStatus('Loop start set — press again to set end')
  } else if (state.loopEnd === null) {
    // Step 2: set end
    const end = state.playheadPosition
    if (end <= state.loopStart) {
      showStatus('Loop end must be after start')
      return
    }
    state.loopEnd = end
    if (audio.isReady) audio.setLoop(state.loopStart, state.loopEnd)
    showStatus('Loop region set')
  } else {
    // Step 3: clear
    state.loopStart = null
    state.loopEnd = null
    if (audio.isReady) audio.setLoop(-1, -1)
    showStatus('Loop cleared')
  }
}

// ── Seek helpers ────────────────────────────────────────────────────────
export function syncLoopAfterSeek(): void {
  const state = useAppState()
  const audio = getAudio()

  if (
    state.loopStart !== null &&
    state.loopEnd !== null &&
    state.playheadPosition > state.loopEnd
  ) {
    if (audio.isReady) audio.setLoop(-1, -1)
  }
}

export function seekTo(position: number): void {
  const state = useAppState()
  const audio = getAudio()

  state.playheadPosition = Math.max(0, position)
  if (audio.isReady) audio.setPlayhead(state.playheadPosition)
  syncLoopAfterSeek()
  ensurePlayheadVisible()
  requestRender()
}

export function seekByBars(bars: number): void {
  const state = useAppState()
  const samplesPerBeat = (60 / state.originalBpm) * SAMPLE_RATE
  seekTo(state.playheadPosition + bars * 4 * samplesPerBeat)
}

// ── Scroll / Visibility ─────────────────────────────────────────────────
export function ensurePlayheadVisible(): void {
  const state = useAppState()
  const waveformW = window.innerWidth - SIDEBAR_W
  const samplesPerCol = getSamplesPerCol(waveformW)
  const visibleSamples = waveformW * samplesPerCol

  if (
    state.playheadPosition < state.scrollOffset ||
    state.playheadPosition > state.scrollOffset + visibleSamples
  ) {
    state.scrollOffset = Math.max(
      0,
      state.playheadPosition - visibleSamples / 2
    )
  }
}

function getSamplesPerCol(canvasWidth: number): number {
  return Math.max(1, Math.round(SAMPLE_RATE * 0.005))
}

export function autoScroll(): void {
  const state = useAppState()
  if (state.freeScroll) return

  const waveformW = window.innerWidth - SIDEBAR_W
  const samplesPerCol = getSamplesPerCol(waveformW)
  const visibleSamples = waveformW * samplesPerCol

  // If loop region fits in view, center on it
  if (
    state.loopStart !== null &&
    state.loopEnd !== null &&
    state.playheadPosition >= state.loopStart &&
    state.playheadPosition <= state.loopEnd
  ) {
    const loopLen = state.loopEnd - state.loopStart
    if (loopLen <= visibleSamples) {
      state.scrollOffset = Math.max(
        0,
        state.loopStart - (visibleSamples - loopLen) / 2
      )
      return
    }
  }

  // 20/80% threshold scrolling
  const leftThreshold = state.scrollOffset + visibleSamples * 0.2
  const rightThreshold = state.scrollOffset + visibleSamples * 0.8

  if (state.playheadPosition > rightThreshold) {
    state.scrollOffset = state.playheadPosition - visibleSamples * 0.2
  } else if (state.playheadPosition < leftThreshold) {
    state.scrollOffset = Math.max(
      0,
      state.playheadPosition - visibleSamples * 0.8
    )
  }
}

// ── Nudge track ─────────────────────────────────────────────────────────
export function nudgeTrack(direction: 'left' | 'right'): void {
  const state = useAppState()
  const audio = getAudio()

  if (state.transportState !== 'stopped') return
  if (state.selectedTrackIndex < 0) return

  const track = state.tracks[state.selectedTrackIndex]
  if (!track?.samples) return

  const samplesPerBeat = (60 / state.originalBpm) * SAMPLE_RATE
  const nudgeAmount = Math.round(samplesPerBeat / 16)

  if (direction === 'left') {
    // Trim from start
    if (track.samples.length <= nudgeAmount) return
    track.samples = track.samples.slice(nudgeAmount)
  } else {
    // Prepend silence
    const padded = new Float32Array(track.samples.length + nudgeAmount)
    padded.set(track.samples, nudgeAmount)
    track.samples = padded
  }

  audio.setTrackSamples(track.id, track.samples)
  showStatus(`Track nudged ${direction}`)
  requestRender()
}

// ── Playhead polling (animation frame loop) ─────────────────────────────
function startPlayheadPolling(): void {
  const state = useAppState()
  const audio = getAudio()

  function poll() {
    if (state.transportState === 'stopped') return

    // Update playhead
    state.playheadPosition = audio.getPlayhead()

    // Poll recording data
    for (const [trackId] of trackRecordStartPositions) {
      const data = audio.pollRecording(trackId)
      if (data && data.length > 0) {
        const chunks = trackRecordedSamples.get(trackId)
        if (chunks) chunks.push(data)

        // Live merge for waveform display
        const track = state.tracks.find((t) => t.id === trackId)
        if (track) {
          const startPos = trackRecordStartPositions.get(trackId) || 0
          const totalRecorded = chunks
            ? chunks.reduce((sum, c) => sum + c.length, 0)
            : 0
          const endPos = startPos + totalRecorded
          const totalLen = Math.max(track.samples?.length || 0, endPos)
          const merged = new Float32Array(totalLen)
          if (track.samples) merged.set(track.samples)
          let offset = startPos
          if (chunks) {
            for (const chunk of chunks) {
              merged.set(chunk, offset)
              offset += chunk.length
            }
          }
          track.samples = merged
          track.sampleRate = SAMPLE_RATE
          audio.setTrackSamples(track.id, merged)
        }
      }
    }

    autoScroll()
    requestRender()
    animFrameId = requestAnimationFrame(poll)
  }

  animFrameId = requestAnimationFrame(poll)
}

// ── Import convenience for sidebar ──────────────────────────────────────
import { SIDEBAR_W } from './useAppState'
