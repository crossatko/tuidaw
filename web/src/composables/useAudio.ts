// ============================================================================
// useAudio — Reactive wrapper around WebAudioBridge (WASM audio engine)
// ============================================================================

import { WebAudioBridge, type WebTrack } from '../../audio-bridge'
import { useAppState, showStatus, SAMPLE_RATE } from './useAppState'

// ── Singleton ───────────────────────────────────────────────────────────
let _audio: WebAudioBridge | null = null
let _initStarted = false
let _initPromise: Promise<void> | null = null

// On-screen debug helpers (defined in index.html)
declare function _debugLog(msg: string): void
declare function _debugError(msg: string): void
declare function _debugHide(): void

export function getAudio(): WebAudioBridge {
  if (!_audio) _audio = new WebAudioBridge()
  return _audio
}

export async function ensureAudioReady(): Promise<boolean> {
  const audio = getAudio()
  const state = useAppState()

  if (audio.isReady) return true
  if (_initStarted) {
    if (_initPromise) await _initPromise
    return audio.isReady
  }

  _initStarted = true
  _initPromise = (async () => {
    try {
      _debugLog('Initializing WASM audio engine...')
      await audio.init()
      _debugLog('Audio engine ready')

      // Sync existing tracks to WASM
      for (const track of state.tracks) {
        audio.syncTrack(track)
      }

      // Set up device change listener (enumerate without mic permission —
      // labels may be limited, but the list updates when permission is later
      // granted via the input overlay or recording)
      audio.onDeviceChange(() => {
        state.inputDevices = audio.inputDevices
      })

      _debugHide()
    } catch (err) {
      _debugError(`Audio init failed: ${err}`)
      showStatus('Audio init failed — check console')
    }
  })()

  await _initPromise
  return audio.isReady
}

// ── Convenience wrappers (thin pass-through) ────────────────────────────

export function syncTrackToEngine(track: WebTrack): void {
  const audio = getAudio()
  if (audio.isReady) audio.syncTrack(track)
}

export function updateClickBuffer(bpm: number, durationFrames: number): void {
  const audio = getAudio()
  if (!audio.isReady) return
  audio.generateClick(bpm, durationFrames)
}

export function getClickDuration(): number {
  const state = useAppState()
  let maxDuration = 0
  for (const t of state.tracks) {
    if (t.samples) maxDuration = Math.max(maxDuration, t.samples.length)
  }
  const speed = state.bpm / state.originalBpm
  // output-space: content / speed + 60s padding, min 10 minutes
  const dur = Math.max(
    Math.ceil(maxDuration / speed) + 60 * SAMPLE_RATE,
    10 * 60 * SAMPLE_RATE
  )
  return dur
}
