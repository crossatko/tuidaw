// ============================================================================
// tuidaw - Application State Manager
// ============================================================================

import type { ProjectState, Track, TransportState } from './types'
import { TRACK_COLORS } from './types'

let trackCounter = 0

export function createDefaultState(): ProjectState {
  return {
    bpm: 120,
    originalBpm: 120,
    bpmLocked: false,
    clickEnabled: false,
    clickVolume: 0.5,
    clickPan: 0,
    sampleRate: 48000,
    tracks: [createTrack('Track 1')],
    selectedTrackIndex: 0,
    transportState: 'stopped',
    playheadPosition: 0,
    scrollOffset: 0,
    freeScroll: false,
    loopStart: null,
    loopEnd: null,
    projectName: 'Untitled',
    outputDeviceId: null,
    availableInputDevices: [],
    availableOutputDevices: []
  }
}

export function createTrack(name?: string): Track {
  const id = `track_${++trackCounter}_${Date.now()}`
  const index = trackCounter - 1
  return {
    id,
    name: name || `Track ${trackCounter}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    muted: false,
    solo: false,
    armed: false,
    monitoring: false,
    volume: 0.8,
    pan: 0,
    samples: null,
    sampleRate: 48000,
    filePath: null,
    inputDeviceId: null,
    inputChannel: -1
  }
}

export function getSelectedTrack(state: ProjectState): Track | null {
  if (
    state.selectedTrackIndex >= 0 &&
    state.selectedTrackIndex < state.tracks.length
  ) {
    return state.tracks[state.selectedTrackIndex]
  }
  return null
}

export function getArmedTrack(state: ProjectState): Track | null {
  return state.tracks.find((t) => t.armed) || null
}

export function getArmedTracks(state: ProjectState): Track[] {
  return state.tracks.filter((t) => t.armed)
}

// Get the total duration in samples (longest track)
export function getProjectDurationSamples(state: ProjectState): number {
  let maxLen = 0
  for (const track of state.tracks) {
    if (track.samples && track.samples.length > maxLen) {
      maxLen = track.samples.length
    }
  }
  return maxLen
}

// Get duration in seconds
export function getProjectDurationSeconds(state: ProjectState): number {
  return getProjectDurationSamples(state) / state.sampleRate
}

// Format time as MM:SS.mmm
export function formatTime(samples: number, sampleRate: number): string {
  const totalSeconds = samples / sampleRate
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const ms = Math.floor((totalSeconds % 1) * 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

// Format BPM with beat position
export function formatBeatPosition(
  samples: number,
  sampleRate: number,
  bpm: number
): string {
  const totalBeats = (samples / sampleRate) * (bpm / 60)
  const bar = Math.floor(totalBeats / 4) + 1
  const beat = Math.floor(totalBeats % 4) + 1
  return `${bar}:${beat}`
}
