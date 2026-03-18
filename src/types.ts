// ============================================================================
// tuidaw - Types & Interfaces
// ============================================================================

export interface AudioDevice {
  id: number         // Device index in miniaudio enumeration
  name: string       // Human-readable name
  description: string // Display name
  type: "input" | "output" // Capture or playback device
  isDefault: boolean // Whether this is the system default device
}

export interface Track {
  id: string
  name: string
  color: string
  muted: boolean
  solo: boolean
  armed: boolean // armed for recording
  volume: number // 0.0 - 1.0
  pan: number // -1.0 (L) to 1.0 (R)
  samples: Float32Array | null // raw PCM samples (mono, 48kHz)
  sampleRate: number
  filePath: string | null
  inputDeviceId: number | null // Input device index for recording (null = default)
}

export type TransportState = "stopped" | "playing" | "recording"

export interface ProjectState {
  bpm: number
  originalBpm: number // The "true" BPM of the imported audio (for speed ratio calculation)
  clickEnabled: boolean
  sampleRate: number
  tracks: Track[]
  selectedTrackIndex: number
  transportState: TransportState
  playheadPosition: number // in samples
  scrollOffset: number // horizontal scroll in samples
  loopStart: number | null
  loopEnd: number | null
  projectName: string
  outputDeviceId: number | null // Global output device index for playback (null = default)
  availableInputDevices: AudioDevice[]
  availableOutputDevices: AudioDevice[]
}

export interface AudioChunk {
  samples: Float32Array
  trackId: string
}

// JSON descriptor stored inside .tuidaw project files
export interface ProjectDescriptor {
  version: 1
  projectName: string
  bpm: number
  originalBpm: number
  clickEnabled: boolean
  sampleRate: number
  playheadPosition: number
  scrollOffset: number
  loopStart: number | null
  loopEnd: number | null
  outputDeviceId: number | null
  selectedTrackIndex: number
  tracks: TrackDescriptor[]
}

export interface TrackDescriptor {
  id: string
  name: string
  color: string
  muted: boolean
  solo: boolean
  armed: boolean
  volume: number
  pan: number
  sampleRate: number
  inputDeviceId: number | null
  // Relative path to the WAV file inside the tarball (e.g. "tracks/track_1.wav")
  wavFile: string | null
}

export const BRAILLE_BASE = 0x2800

// Braille dot mapping for 2x4 grid:
// (0,0)=0x01  (1,0)=0x08
// (0,1)=0x02  (1,1)=0x10
// (0,2)=0x04  (1,2)=0x20
// (0,3)=0x40  (1,3)=0x80
export const BRAILLE_DOTS = [
  [0x01, 0x02, 0x04, 0x40], // left column
  [0x08, 0x10, 0x20, 0x80], // right column
]

export const TRACK_COLORS = [
  "#FF6B6B", // red
  "#4ECDC4", // teal
  "#45B7D1", // blue
  "#96CEB4", // green
  "#FFEAA7", // yellow
  "#DDA0DD", // plum
  "#98D8C8", // mint
  "#F7DC6F", // gold
  "#BB8FCE", // purple
  "#85C1E9", // sky
]

export const SIDEBAR_WIDTH = 22
export const TOPBAR_HEIGHT = 3
export const TRACK_ROW_HEIGHT = 4 // rows per track in the sidebar
export const WAVEFORM_ROW_HEIGHT = 5 // rows per track in the main waveform view (braille, +1 for separator)
