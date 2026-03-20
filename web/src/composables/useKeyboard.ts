// ============================================================================
// useKeyboard — Global keyboard shortcuts
// ============================================================================

import { onMounted, onUnmounted } from 'vue'
import {
  useAppState,
  showStatus,
  createTrack,
  getNextTrackNum,
  clampTrackScroll,
  ensureTrackVisible,
  SAMPLE_RATE
} from './useAppState'
import {
  getAudio,
  ensureAudioReady,
  updateClickBuffer,
  getClickDuration
} from './useAudio'
import {
  play,
  stopTransport,
  punchInTrack,
  punchOutTrack,
  toggleLoop,
  seekTo,
  seekByBars,
  ensurePlayheadVisible,
  syncLoopAfterSeek,
  nudgeTrack,
  requestRender
} from './useTransport'
import { importWav, exportMixdown } from './useProject'

export function useKeyboard(): void {
  function onKeyDown(e: KeyboardEvent) {
    // Skip when typing in a text input (but not range sliders or buttons)
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT') {
      const inputType = (e.target as HTMLInputElement).type
      if (inputType !== 'range') return
    }

    const state = useAppState()

    // Dismiss input overlay on Escape
    if (state.showInputOverlay) {
      if (e.key === 'Escape') {
        state.showInputOverlay = false
      }
      return // Block all other keys while overlay is open
    }

    const audio = getAudio()

    switch (e.key) {
      case ' ':
        e.preventDefault()
        if (state.transportState !== 'stopped') stopTransport()
        else play()
        break

      case 'p':
        toggleLoop()
        break

      case 'm':
        if (state.selectedTrackIndex === -1) {
          state.clickEnabled = !state.clickEnabled
          if (state.transportState !== 'stopped') {
            if (state.clickEnabled) {
              const dur = getClickDuration()
              updateClickBuffer(state.bpm, dur)
              audio.setClick(true, state.bpm)
              audio.setClickVolume(state.clickVolume)
              audio.setClickPan(state.clickPan)
            } else {
              audio.setClick(false, 0)
            }
          }
        } else {
          const track = state.tracks[state.selectedTrackIndex]
          if (track) {
            track.muted = !track.muted
            if (audio.isReady) audio.setTrackMuted(track.id, track.muted)
            requestRender()
          }
        }
        break

      case 's': {
        const track = state.tracks[state.selectedTrackIndex]
        if (track) {
          track.solo = !track.solo
          if (audio.isReady) audio.setTrackSolo(track.id, track.solo)
          requestRender()
        }
        break
      }

      case 'r': {
        const track = state.tracks[state.selectedTrackIndex]
        if (track) {
          track.armed = !track.armed

          if (state.transportState !== 'stopped') {
            const currentPos = audio.getPlayhead()

            if (track.armed) {
              // Punch-in
              if (state.transportState === 'playing') {
                state.transportState = 'recording'
              }
              punchInTrack(track, currentPos)
            } else {
              // Punch-out
              punchOutTrack(track)

              // If no tracks are still recording, transition back to "playing"
              const stillRecording = state.tracks.some(
                (t) => t.armed && t.id !== track.id
              )
              if (!stillRecording && state.transportState === 'recording') {
                state.transportState = 'playing'
              }
            }
          }
        }
        break
      }

      case 'c':
        state.clickEnabled = !state.clickEnabled
        if (state.transportState !== 'stopped') {
          if (state.clickEnabled) {
            const dur = getClickDuration()
            updateClickBuffer(state.bpm, dur)
            audio.setClick(true, state.bpm)
            audio.setClickVolume(state.clickVolume)
            audio.setClickPan(state.clickPan)
          } else {
            audio.setClick(false, 0)
          }
        }
        break

      case '+':
      case '=':
        state.bpm = Math.min(300, state.bpm + 1)
        if (audio.isReady) audio.setSpeed(state.bpm / state.originalBpm)
        break

      case '-':
        state.bpm = Math.max(20, state.bpm - 1)
        if (audio.isReady) audio.setSpeed(state.bpm / state.originalBpm)
        break

      case 'ArrowUp':
      case 'k':
        e.preventDefault()
        if (state.selectedTrackIndex > -1) {
          state.selectedTrackIndex--
          ensureTrackVisible(state.selectedTrackIndex)
        }
        break

      case 'ArrowDown':
      case 'j':
        e.preventDefault()
        if (state.selectedTrackIndex < state.tracks.length - 1) {
          state.selectedTrackIndex++
          ensureTrackVisible(state.selectedTrackIndex)
        }
        break

      case 'ArrowLeft':
      case 'h': {
        const samplesPerBeat = Math.round(
          (60 / state.originalBpm) * SAMPLE_RATE
        )
        const scrollAmount = e.shiftKey ? samplesPerBeat * 4 : samplesPerBeat
        state.scrollOffset = Math.max(0, state.scrollOffset - scrollAmount)
        if (state.transportState !== 'stopped') state.freeScroll = true
        break
      }

      case 'ArrowRight':
      case 'l': {
        const samplesPerBeat = Math.round(
          (60 / state.originalBpm) * SAMPLE_RATE
        )
        const scrollAmount = e.shiftKey ? samplesPerBeat * 4 : samplesPerBeat
        state.scrollOffset += scrollAmount
        if (state.transportState !== 'stopped') state.freeScroll = true
        break
      }

      case '[': {
        const samplesPerBeat = Math.round(
          (60 / state.originalBpm) * SAMPLE_RATE
        )
        state.playheadPosition = Math.max(
          0,
          state.playheadPosition - samplesPerBeat
        )
        if (state.transportState !== 'stopped') {
          audio.setPlayhead(state.playheadPosition)
          syncLoopAfterSeek()
        }
        ensurePlayheadVisible()
        break
      }

      case ']': {
        const samplesPerBeat = Math.round(
          (60 / state.originalBpm) * SAMPLE_RATE
        )
        state.playheadPosition += samplesPerBeat
        if (state.transportState !== 'stopped') {
          audio.setPlayhead(state.playheadPosition)
          syncLoopAfterSeek()
        }
        ensurePlayheadVisible()
        break
      }

      case 'Home':
      case '0':
        state.playheadPosition = 0
        state.scrollOffset = 0
        state.freeScroll = false
        if (state.transportState !== 'stopped') {
          audio.setPlayhead(0)
          syncLoopAfterSeek()
        }
        break

      case 'End': {
        let maxLen = 0
        for (const t of state.tracks) {
          if (t.samples && t.samples.length > maxLen) maxLen = t.samples.length
        }
        state.playheadPosition = maxLen
        if (state.transportState !== 'stopped') {
          audio.setPlayhead(maxLen)
          syncLoopAfterSeek()
        }
        ensurePlayheadVisible()
        break
      }

      case 'a':
        if (state.transportState !== 'stopped') {
          showStatus('Stop transport first (Space)')
        } else {
          const newTrack = createTrack(
            `Track ${getNextTrackNum()}`,
            state.tracks.length
          )
          state.tracks.push(newTrack)
          if (audio.isReady) audio.syncTrack(newTrack)
          state.selectedTrackIndex = state.tracks.length - 1
          ensureTrackVisible(state.selectedTrackIndex)
        }
        break

      case 'd':
      case 'Delete':
        if (state.transportState !== 'stopped') {
          showStatus('Stop transport first (Space)')
        } else {
          const track = state.tracks[state.selectedTrackIndex]
          if (track) {
            if (track.samples && track.samples.length > 0) {
              track.samples = null
              if (audio.isReady) audio.setTrackSamples(track.id, null)
              requestRender()
              showStatus(`Cleared "${track.name}"`)
            } else if (state.tracks.length > 1) {
              if (audio.isReady) audio.removeTrack(track.id)
              state.tracks.splice(state.selectedTrackIndex, 1)
              if (state.selectedTrackIndex >= state.tracks.length) {
                state.selectedTrackIndex = state.tracks.length - 1
              }
              clampTrackScroll()
            }
          }
        }
        break

      case '<': {
        if (state.selectedTrackIndex === -1) {
          state.clickPan = Math.max(-1, state.clickPan - 0.1)
          if (audio.isReady) audio.setClickPan(state.clickPan)
        } else {
          const track = state.tracks[state.selectedTrackIndex]
          if (track) {
            track.pan = Math.max(-1, track.pan - 0.1)
            if (audio.isReady) audio.setTrackPan(track.id, track.pan)
          }
        }
        break
      }

      case '>': {
        if (state.selectedTrackIndex === -1) {
          state.clickPan = Math.min(1, state.clickPan + 0.1)
          if (audio.isReady) audio.setClickPan(state.clickPan)
        } else {
          const track = state.tracks[state.selectedTrackIndex]
          if (track) {
            track.pan = Math.min(1, track.pan + 0.1)
            if (audio.isReady) audio.setTrackPan(track.id, track.pan)
          }
        }
        break
      }

      case '{':
        nudgeTrack('left')
        break

      case '}':
        nudgeTrack('right')
        break

      case 'i':
      case 'I':
        importWav()
        break

      case 'e':
      case 'E':
        exportMixdown()
        break

      default:
        return // Don't prevent default for unhandled keys
    }
  }

  onMounted(() => {
    document.addEventListener('keydown', onKeyDown)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', onKeyDown)
  })
}
