// ============================================================================
// tuidaw - Audio Engine (miniaudio-based native library via Bun FFI)
// ============================================================================
// Cross-platform audio I/O using a native shared library built with miniaudio.
// Replaces the previous PipeWire CLI-based approach for:
//   - Sample-accurate playback and mixing (no process spawn timing hacks)
//   - Instant pan/volume changes (no WAV rewrite + process restart)
//   - True cross-platform support (Linux, macOS, Windows)
//   - Lower latency and no temp file I/O during transport

import {
  dlopen,
  FFIType,
  ptr,
  toArrayBuffer,
  toBuffer,
  type Pointer
} from 'bun:ffi'
import { spawn, type Subprocess } from 'bun'
import { existsSync, mkdirSync, rmSync } from 'fs'
import type {
  Track,
  ProjectState,
  AudioDevice,
  ProjectDescriptor,
  TrackDescriptor
} from './types'
import { resample } from './utils/dsp'
import { detectBPM, findBeatOffset } from './utils/bpm'
import { parseWav, encodeWav, encodeWavStereo } from './utils/wav'

const SAMPLE_RATE = 48000
const RECORDINGS_DIR = './recordings'

// ── Load Native Library ─────────────────────────────────────────────────────

function findLibrary(): string {
  const path = require('path')
  const candidates = [
    path.join(__dirname, '..', 'native', 'libtuidaw_audio.so'),
    path.join(__dirname, '..', 'native', 'libtuidaw_audio.dylib'),
    path.join(__dirname, '..', 'native', 'tuidaw_audio.dll')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error('Native audio library not found. Run native/build.sh first.')
}

const lib = dlopen(findLibrary(), {
  tuidaw_init: { returns: FFIType.i32 },
  tuidaw_deinit: { returns: FFIType.void },
  tuidaw_refresh_devices: { returns: FFIType.i32 },
  tuidaw_get_device_count: { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_get_device_name: {
    returns: FFIType.i32,
    args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32]
  },
  tuidaw_is_device_default: {
    returns: FFIType.i32,
    args: [FFIType.i32, FFIType.i32]
  },
  tuidaw_set_output_device: { returns: FFIType.void, args: [FFIType.i32] },
  tuidaw_get_active_device_index: { returns: FFIType.i32 },
  tuidaw_start_playback_device: { returns: FFIType.i32 },
  tuidaw_stop_playback_device: { returns: FFIType.void },
  tuidaw_add_track: { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_remove_track: { returns: FFIType.void, args: [FFIType.i32] },
  tuidaw_set_track_samples: {
    returns: FFIType.void,
    args: [FFIType.i32, FFIType.ptr, FFIType.i32]
  },
  tuidaw_set_track_volume: {
    returns: FFIType.void,
    args: [FFIType.i32, FFIType.f32]
  },
  tuidaw_set_track_pan: {
    returns: FFIType.void,
    args: [FFIType.i32, FFIType.f32]
  },
  tuidaw_set_track_muted: {
    returns: FFIType.void,
    args: [FFIType.i32, FFIType.i32]
  },
  tuidaw_set_track_solo: {
    returns: FFIType.void,
    args: [FFIType.i32, FFIType.i32]
  },
  tuidaw_set_track_input_device: {
    returns: FFIType.void,
    args: [FFIType.i32, FFIType.i32]
  },
  tuidaw_play: { returns: FFIType.void, args: [FFIType.i64] },
  tuidaw_stop: { returns: FFIType.void },
  tuidaw_get_playhead: { returns: FFIType.i64 },
  tuidaw_set_playhead: { returns: FFIType.void, args: [FFIType.i64] },
  tuidaw_set_click: { returns: FFIType.void, args: [FFIType.i32, FFIType.f32] },
  tuidaw_set_click_samples: {
    returns: FFIType.void,
    args: [FFIType.ptr, FFIType.i32]
  },
  tuidaw_generate_click: {
    returns: FFIType.i32,
    args: [FFIType.f32, FFIType.i32]
  },
  tuidaw_set_click_volume: { returns: FFIType.void, args: [FFIType.f32] },
  tuidaw_set_click_pan: { returns: FFIType.void, args: [FFIType.f32] },
  tuidaw_set_loop: { returns: FFIType.void, args: [FFIType.i64, FFIType.i64] },
  tuidaw_start_recording: { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_stop_recording: { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_get_recording_buffer: { returns: FFIType.ptr, args: [FFIType.i32] },
  tuidaw_get_recording_length: { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_set_speed: { returns: FFIType.void, args: [FFIType.f32] },
  tuidaw_get_speed: { returns: FFIType.f32 },
  tuidaw_render: { returns: FFIType.i32, args: [FFIType.ptr, FFIType.i32] },
  tuidaw_start_monitoring: { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_stop_monitoring: { returns: FFIType.void, args: [FFIType.i32] },
  tuidaw_is_monitoring: { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_has_jack_monitoring: { returns: FFIType.i32, args: [] },
  tuidaw_get_backend_name: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.i32]
  }
})

// ── Zenity File Dialog Helpers ─────────────────────────────────────────────
// Opens native GTK file dialogs via zenity. Returns chosen path or null.

async function zenitySave(
  title: string,
  defaultName: string,
  filters?: string[]
): Promise<string | null> {
  const cmd = [
    'zenity',
    '--file-selection',
    '--save',
    '--confirm-overwrite',
    '--title',
    title,
    '--filename',
    defaultName
  ]
  for (const f of filters ?? []) {
    cmd.push('--file-filter', f)
  }
  try {
    const proc = spawn({ cmd, stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    const stdout = proc.stdout
    if (typeof stdout === 'number') return null
    const text = await new Response(stdout as ReadableStream).text()
    return text.trim() || null
  } catch {
    return null
  }
}

async function zenityOpen(
  title: string,
  filters?: string[]
): Promise<string | null> {
  const cmd = ['zenity', '--file-selection', '--title', title]
  for (const f of filters ?? []) {
    cmd.push('--file-filter', f)
  }
  try {
    const proc = spawn({ cmd, stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    const stdout = proc.stdout
    if (typeof stdout === 'number') return null
    const text = await new Response(stdout as ReadableStream).text()
    return text.trim() || null
  } catch {
    return null
  }
}

export { zenitySave, zenityOpen }

// ── Track ID mapping ────────────────────────────────────────────────────────
// The native library uses integer IDs. We map string track IDs to ints.

let nextNativeId = 1
const trackIdMap = new Map<string, number>() // string -> native int
const reverseIdMap = new Map<number, string>() // native int -> string

function getNativeId(trackId: string): number {
  let nid = trackIdMap.get(trackId)
  if (nid === undefined) {
    nid = nextNativeId++
    trackIdMap.set(trackId, nid)
    reverseIdMap.set(nid, trackId)
  }
  return nid
}

function removeNativeId(trackId: string): void {
  const nid = trackIdMap.get(trackId)
  if (nid !== undefined) {
    trackIdMap.delete(trackId)
    reverseIdMap.delete(nid)
  }
}

// ── AudioEngine ─────────────────────────────────────────────────────────────

export class AudioEngine {
  // Track the Float32Array references so they don't get GC'd while native
  // code holds pointers to them.
  private pinnedBuffers: Map<string, Float32Array> = new Map()

  // Track recording state for each track
  private recordingTracks: Set<string> = new Set()

  // Track recording start positions (for merging)
  private recStartPositions: Map<string, number> = new Map()

  // Last known recording length per track (for polling)
  private lastRecLengths: Map<string, number> = new Map()

  constructor() {
    if (!existsSync(RECORDINGS_DIR)) {
      mkdirSync(RECORDINGS_DIR, { recursive: true })
    }

    const result = lib.symbols.tuidaw_init()
    if (result !== 0) {
      throw new Error('Failed to initialize native audio engine')
    }

    // Start the playback device immediately (it sits idle until tuidaw_play)
    const playResult = lib.symbols.tuidaw_start_playback_device()
    if (playResult !== 0) {
      throw new Error('Failed to start playback device')
    }
  }

  // ── Device Enumeration ─────────────────────────────────────────────────

  async enumerateDevices(): Promise<{
    inputs: AudioDevice[]
    outputs: AudioDevice[]
  }> {
    lib.symbols.tuidaw_refresh_devices()

    const inputs: AudioDevice[] = []
    const outputs: AudioDevice[] = []

    // IMPORTANT: Bun FFI ptr() is only reliable for a single call when reusing
    // the same buffer — subsequent calls with the same namePtr do not reliably
    // reflect updated bytes in the Uint8Array view. Allocate a fresh buffer (and
    // thus a fresh ptr()) for each tuidaw_get_device_name call.
    const readName = (type: number, index: number): string => {
      const buf = new Uint8Array(256)
      lib.symbols.tuidaw_get_device_name(type, index, ptr(buf), 256)
      return new TextDecoder().decode(buf.subarray(0, buf.indexOf(0)))
    }

    // Enumerate capture (input) devices
    const inputCount = lib.symbols.tuidaw_get_device_count(1)
    for (let i = 0; i < inputCount; i++) {
      const name = readName(1, i)
      const isDefault = lib.symbols.tuidaw_is_device_default(1, i) !== 0
      inputs.push({ id: i, name, description: name, type: 'input', isDefault })
    }

    // Enumerate playback (output) devices
    const outputCount = lib.symbols.tuidaw_get_device_count(0)
    for (let i = 0; i < outputCount; i++) {
      const name = readName(0, i)
      const isDefault = lib.symbols.tuidaw_is_device_default(0, i) !== 0
      outputs.push({
        id: i,
        name,
        description: name,
        type: 'output',
        isDefault
      })
    }

    return { inputs, outputs }
  }

  // ── Output Device ────────────────────────────────────────────────────

  // Switch the playback device. Only restarts the device if the requested
  // device differs from the currently active one (avoids unnecessary
  // stop+start which can confuse PipeWire/PulseAudio routing policies).
  setOutputDevice(deviceId: number | null): void {
    const nativeIdx = deviceId ?? -1
    const activeIdx = lib.symbols.tuidaw_get_active_device_index()
    if (nativeIdx === activeIdx) {
      // Device already active — no restart needed
      return
    }
    lib.symbols.tuidaw_set_output_device(nativeIdx)
    lib.symbols.tuidaw_stop_playback_device()
    const result = lib.symbols.tuidaw_start_playback_device()
    if (result !== 0) {
      throw new Error('Failed to restart playback device with new output')
    }
  }

  // Force-restart the playback device with the current output_device_index,
  // even if it hasn't changed. Used for the initial device switch in the
  // F3 callback where we want to guarantee the device actually gets
  // re-initialized with the chosen output.
  forceRestartOutputDevice(deviceId: number | null): void {
    const nativeIdx = deviceId ?? -1
    lib.symbols.tuidaw_set_output_device(nativeIdx)
    lib.symbols.tuidaw_stop_playback_device()
    const result = lib.symbols.tuidaw_start_playback_device()
    if (result !== 0) {
      throw new Error('Failed to restart playback device with new output')
    }
  }

  // ── Track Management (sync native state with JS state) ─────────────────

  // Ensure a track exists in the native engine and sync its current state.
  syncTrack(track: Track): void {
    const nid = getNativeId(track.id)
    lib.symbols.tuidaw_add_track(nid)

    // Sync parameters (these are all instant atomic updates in native code)
    lib.symbols.tuidaw_set_track_volume(nid, track.volume)
    lib.symbols.tuidaw_set_track_pan(nid, track.pan)
    lib.symbols.tuidaw_set_track_muted(nid, track.muted ? 1 : 0)
    lib.symbols.tuidaw_set_track_solo(nid, track.solo ? 1 : 0)

    // Sync input device
    const inputIdx = track.inputDeviceId ?? -1
    lib.symbols.tuidaw_set_track_input_device(nid, inputIdx)

    // Sync sample buffer
    if (track.samples && track.samples.length > 0) {
      this.pinnedBuffers.set(track.id, track.samples)
      lib.symbols.tuidaw_set_track_samples(
        nid,
        ptr(track.samples),
        track.samples.length
      )
    } else {
      this.pinnedBuffers.delete(track.id)
      lib.symbols.tuidaw_set_track_samples(nid, null as any, 0)
    }
  }

  // Sync ALL tracks to native engine (call before playAll)
  syncAllTracks(state: ProjectState): void {
    for (const track of state.tracks) {
      this.syncTrack(track)
    }
  }

  removeTrack(trackId: string): void {
    const nid = trackIdMap.get(trackId)
    if (nid !== undefined) {
      lib.symbols.tuidaw_remove_track(nid)
    }
    this.pinnedBuffers.delete(trackId)
    removeNativeId(trackId)
  }

  // ── Live Parameter Changes (instant, glitch-free) ──────────────────────

  setTrackVolume(trackId: string, volume: number): void {
    const nid = trackIdMap.get(trackId)
    if (nid === undefined) return
    lib.symbols.tuidaw_set_track_volume(nid, Math.max(0, Math.min(1, volume)))
  }

  setTrackPan(trackId: string, pan: number): void {
    const nid = trackIdMap.get(trackId)
    if (nid === undefined) return
    lib.symbols.tuidaw_set_track_pan(nid, Math.max(-1, Math.min(1, pan)))
  }

  setTrackMuted(trackId: string, muted: boolean): void {
    const nid = trackIdMap.get(trackId)
    if (nid === undefined) return
    lib.symbols.tuidaw_set_track_muted(nid, muted ? 1 : 0)
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    const nid = trackIdMap.get(trackId)
    if (nid === undefined) return
    lib.symbols.tuidaw_set_track_solo(nid, solo ? 1 : 0)
  }

  // Update track samples pointer in native engine (after recording merges new audio)
  updateTrackSamples(track: Track): void {
    const nid = trackIdMap.get(track.id)
    if (nid === undefined) return
    if (track.samples && track.samples.length > 0) {
      this.pinnedBuffers.set(track.id, track.samples)
      lib.symbols.tuidaw_set_track_samples(
        nid,
        ptr(track.samples),
        track.samples.length
      )
    } else {
      this.pinnedBuffers.delete(track.id)
      lib.symbols.tuidaw_set_track_samples(nid, null as any, 0)
    }
  }

  // ── Recording ──────────────────────────────────────────────────────────

  // Start recording on a single track
  async startRecording(
    trackId: string,
    _onChunk: (samples: Float32Array) => void,
    _targetDeviceId?: number | null
  ): Promise<void> {
    const nid = getNativeId(trackId)
    const result = lib.symbols.tuidaw_start_recording(nid)
    if (result !== 0) {
      throw new Error(`Failed to start recording on track ${trackId}`)
    }
    this.recordingTracks.add(trackId)
    this.lastRecLengths.set(trackId, 0)
  }

  // Poll for new recording data and invoke the callback with new samples.
  // Called from the playhead update interval in index.ts.
  pollRecordingData(
    trackId: string,
    onChunk: (samples: Float32Array) => void
  ): void {
    const nid = trackIdMap.get(trackId)
    if (nid === undefined) return

    const currentLen = lib.symbols.tuidaw_get_recording_length(nid)
    const lastLen = this.lastRecLengths.get(trackId) ?? 0

    if (currentLen <= lastLen) return

    // Get pointer to the recording buffer
    const bufPtr = lib.symbols.tuidaw_get_recording_buffer(nid) as Pointer
    if (!bufPtr) return

    // Read only the new samples
    const newSampleCount = currentLen - lastLen
    const byteOffset = lastLen * 4 // float32 = 4 bytes
    const newBytes = toArrayBuffer(bufPtr, byteOffset, newSampleCount * 4)
    const newSamples = new Float32Array(newBytes)

    this.lastRecLengths.set(trackId, currentLen)
    onChunk(newSamples)
  }

  // Stop recording on a single track and return its full buffer
  async stopTrackRecording(trackId: string): Promise<Float32Array | null> {
    const nid = trackIdMap.get(trackId)
    if (nid === undefined) return null

    const totalLen = lib.symbols.tuidaw_stop_recording(nid)
    this.recordingTracks.delete(trackId)
    this.lastRecLengths.delete(trackId)

    if (totalLen <= 0) return null

    // Copy the recording buffer out
    const bufPtr = lib.symbols.tuidaw_get_recording_buffer(nid) as Pointer
    if (!bufPtr) return null

    const bytes = toArrayBuffer(bufPtr, 0, totalLen * 4)
    return new Float32Array(bytes.slice(0)) // copy to own buffer
  }

  // Stop ALL active recordings and return map of trackId -> samples
  async stopAllRecordings(): Promise<Map<string, Float32Array>> {
    const results = new Map<string, Float32Array>()
    const trackIds = [...this.recordingTracks]
    for (const trackId of trackIds) {
      const samples = await this.stopTrackRecording(trackId)
      if (samples) {
        results.set(trackId, samples)
      }
    }
    return results
  }

  get isRecording(): boolean {
    return this.recordingTracks.size > 0
  }

  // ── Input Monitoring ──────────────────────────────────────────────────
  // Low-latency input passthrough using a full-duplex device. When JACK is
  // available (via PipeWire), uses a dedicated JACK context for ~2-5ms
  // round-trip latency. Falls back to PulseAudio otherwise.

  startMonitoring(trackId: string): boolean {
    const nid = getNativeId(trackId)
    const result = lib.symbols.tuidaw_start_monitoring(nid)
    return result === 0
  }

  stopMonitoring(trackId: string): void {
    const nid = trackIdMap.get(trackId)
    if (nid === undefined) return
    lib.symbols.tuidaw_stop_monitoring(nid)
  }

  isMonitoring(trackId: string): boolean {
    const nid = trackIdMap.get(trackId)
    if (nid === undefined) return false
    return lib.symbols.tuidaw_is_monitoring(nid) !== 0
  }

  hasJackMonitoring(): boolean {
    return lib.symbols.tuidaw_has_jack_monitoring() !== 0
  }

  getBackendName(): string {
    const buf = new Uint8Array(256)
    lib.symbols.tuidaw_get_backend_name(ptr(buf), 256)
    const nullIdx = buf.indexOf(0)
    return new TextDecoder().decode(
      buf.subarray(0, nullIdx > 0 ? nullIdx : 256)
    )
  }

  // ── Transport ──────────────────────────────────────────────────────────

  // Mark transport start (used by the native engine)
  markTransportStart(): void {
    // No-op in the new engine — tuidaw_play() handles this
  }

  // Play all non-muted tracks simultaneously.
  // In the new engine, this just syncs all tracks and starts the native transport.
  async playAll(state: ProjectState): Promise<void> {
    this.syncAllTracks(state)

    // Set click state — native just stores enabled flag.
    // BPM is baked into the click buffer beat positions.
    lib.symbols.tuidaw_set_click(state.clickEnabled ? 1 : 0, state.bpm)
    lib.symbols.tuidaw_set_click_volume(state.clickVolume)
    lib.symbols.tuidaw_set_click_pan(state.clickPan)

    // Generate click buffer in OUTPUT-SPACE at display BPM.
    // The native callback indexes the click buffer by output-space counter
    // (click_frame_counter). Duration is in output frames: projectDuration / speed.
    // On loop wrap, the counter is reset to align with the loop start position.
    const projectDuration = state.tracks.reduce(
      (max, t) => Math.max(max, t.samples?.length ?? 0),
      0
    )
    const speed = state.bpm / state.originalBpm
    const outputDuration =
      speed > 0 ? Math.ceil(projectDuration / speed) : projectDuration
    const clickDuration = Math.max(
      outputDuration + SAMPLE_RATE * 60,
      SAMPLE_RATE * 600
    )
    this.updateClickBuffer(state.bpm, clickDuration)

    // Set loop state — always pass loop region to native engine if it exists.
    // The native callback handles all cases correctly:
    //   - Playhead before loop: plays linearly until reaching loopEnd, then wraps
    //   - Playhead inside loop: wraps at loopEnd back to loopStart
    //   - Playhead after loop (manual seek past region): disabled by syncLoopAfterSeek
    if (
      state.loopStart !== null &&
      state.loopEnd !== null &&
      state.playheadPosition <= state.loopEnd
    ) {
      lib.symbols.tuidaw_set_loop(
        BigInt(state.loopStart),
        BigInt(state.loopEnd)
      )
    } else {
      lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1))
    }

    // Switch output device (stops + restarts playback device if needed)
    this.setOutputDevice(state.outputDeviceId)

    // Start transport from current playhead position
    lib.symbols.tuidaw_play(BigInt(state.playheadPosition))
  }

  // Get elapsed samples since play started — now uses the native engine's
  // sample-accurate counter instead of wall-clock time.
  getElapsedSamples(): number {
    return 0 // Not used in new engine — getPlayhead() is authoritative
  }

  // Get current playhead position (sample-accurate from the audio thread)
  getPlayhead(): number {
    return Number(lib.symbols.tuidaw_get_playhead())
  }

  // Set playhead position (works during playback — resets WSOLA states in native engine)
  setPlayhead(position: number): void {
    lib.symbols.tuidaw_set_playhead(BigInt(position))
  }

  // Get current playback position (compatibility with old API)
  getCurrentPlaybackPosition(_startPosition: number): number {
    return this.getPlayhead()
  }

  // Stop all playback (but NOT recordings)
  stopAllPlayback(): void {
    lib.symbols.tuidaw_stop()
  }

  // Check if a track is currently playing (in the native mixer sense)
  isTrackPlaying(trackId: string): boolean {
    // In the native engine, all non-muted/non-recording tracks are "playing"
    // when the transport is running. This method is now only used for
    // mute/solo refresh logic.
    const nid = trackIdMap.get(trackId)
    return nid !== undefined
  }

  // Stop playback for a single track (by muting it in the native engine)
  stopTrackPlayback(trackId: string): void {
    // In the new engine, we mute the track instead of killing a process
    this.setTrackMuted(trackId, true)
  }

  // Play a track (unmute it in the native engine)
  async playTrack(
    track: Track,
    _startSample: number = 0,
    _targetDeviceId?: number | null
  ): Promise<void> {
    this.syncTrack(track)
  }

  // These are no longer needed but kept for API compatibility
  async prepareTrackWav(
    _track: Track,
    _startSample?: number
  ): Promise<string | null> {
    return null // No temp files needed
  }
  spawnTrackPlayer(
    _trackId: string,
    _wavPath: string,
    _targetDeviceId?: number | null,
    _volume?: number
  ): void {
    // No-op — mixing is done in the native callback
  }

  // Restart track for pan change — no longer needed, pan is instant
  async restartTrackForPan(
    track: Track,
    _currentSample: number,
    _targetDeviceId?: number | null
  ): Promise<void> {
    // Pan changes are now instant (atomic update in native engine)
    this.setTrackPan(track.id, track.pan)
  }

  // ── Loop ───────────────────────────────────────────────────────────────

  // Set loop region (handled sample-accurately in native callback)
  setLoop(start: number | null, end: number | null): void {
    if (start !== null && end !== null) {
      lib.symbols.tuidaw_set_loop(BigInt(start), BigInt(end))
    } else {
      lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1))
    }
  }

  // Pre-prepare loop restart — no longer needed (loop is handled in native callback)
  async prepareLoopRestart(
    _state: ProjectState,
    _loopStart: number
  ): Promise<{
    tracks: { trackId: string; wavPath: string; volume: number }[]
    clickWavPath: string | null
  }> {
    return { tracks: [], clickWavPath: null }
  }

  // Execute loop restart — no longer needed
  executeLoopRestart(
    _preparations: any,
    _targetDeviceId?: number | null
  ): void {
    // No-op — loop is handled sample-accurately in the native callback
  }

  // ── Click / Metronome ──────────────────────────────────────────────────

  async startClick(
    bpm: number,
    _startSample?: number,
    _targetDeviceId?: number | null
  ): Promise<void> {
    // bpm here is the DISPLAYED BPM — used for output-space click timing
    lib.symbols.tuidaw_set_click(1, bpm)
  }

  stopClick(): void {
    lib.symbols.tuidaw_set_click(0, 0)
  }

  setClickVolume(volume: number): void {
    lib.symbols.tuidaw_set_click_volume(Math.max(0, Math.min(2.0, volume)))
  }

  setClickPan(pan: number): void {
    lib.symbols.tuidaw_set_click_pan(Math.max(-1, Math.min(1, pan)))
  }

  // Click WAV helpers — no longer needed (click is generated in native callback)
  async prepareClickWav(_bpm: number, _startSample?: number): Promise<string> {
    return ''
  }
  spawnClickPlayer(_wavPath: string, _targetDeviceId?: number | null): void {}

  // Generate click buffer in native engine.
  // The C code allocates and fills a buffer with click tones at GCD-exact
  // beat positions. The buffer is long enough for duration_frames of audio.
  // No JS-side buffer allocation or pinning needed.
  generateClick(bpm: number, durationFrames: number): void {
    if (bpm <= 0 || durationFrames <= 0) return
    lib.symbols.tuidaw_generate_click(bpm, durationFrames)
  }

  // Regenerate the click buffer for a given BPM and project duration.
  // Default duration: 10 minutes at 48kHz = 28,800,000 frames.
  // Must be called whenever BPM changes (buffer beat positions depend on BPM).
  updateClickBuffer(
    bpm: number,
    durationFrames: number = SAMPLE_RATE * 600
  ): void {
    if (bpm <= 0) return
    this.generateClick(bpm, durationFrames)
  }

  // ── Speed / WSOLA ─────────────────────────────────────────────────────

  // Set playback speed (1.0 = normal). WSOLA time-stretch is used when != 1.0.
  // Clamped to [0.25, 2.0] in the native engine.
  setSpeed(speed: number): void {
    lib.symbols.tuidaw_set_speed(Math.max(0.25, Math.min(2.0, speed)))
  }

  getSpeed(): number {
    return lib.symbols.tuidaw_get_speed()
  }

  // ── Offline Render ──────────────────────────────────────────────────────
  // Render audio directly into a buffer by calling playback_callback.
  // The engine must be in "playing" state (call play() first).
  // Returns interleaved stereo float buffer (L R L R...).
  render(frameCount: number): Float32Array {
    const buf = new Float32Array(frameCount * 2)
    lib.symbols.tuidaw_render(ptr(buf), frameCount)
    return buf
  }

  // ── Stop All ───────────────────────────────────────────────────────────

  async stopAll(): Promise<void> {
    lib.symbols.tuidaw_stop()
  }

  // ── WAV File I/O ───────────────────────────────────────────────────────
  // These remain in TypeScript since they're not performance-critical

  async saveTrackToFile(track: Track): Promise<string | null> {
    if (!track.samples) return null
    const filePath = `${RECORDINGS_DIR}/${track.name.replace(/\s+/g, '_')}_${Date.now()}.wav`
    await this.writeWav(filePath, track.samples, track.sampleRate)
    track.filePath = filePath
    return filePath
  }

  async loadWavFile(filePath: string): Promise<{
    samples: Float32Array
    sampleRate: number
    detectedBPM: number | null
  } | null> {
    try {
      const file = Bun.file(filePath)
      const buf = new Uint8Array(await file.arrayBuffer())
      const result = parseWav(buf)
      if (!result) return null

      // Detect BPM before resampling (use original sample rate for accuracy)
      const detectedBPM = detectBPM(result.samples, result.sampleRate)

      // Resample to project sample rate if needed (linear interpolation)
      if (result.sampleRate !== SAMPLE_RATE) {
        result.samples = resample(
          result.samples,
          result.sampleRate,
          SAMPLE_RATE
        )
        result.sampleRate = SAMPLE_RATE
      }

      // Find beat offset and trim audio so first beat sits at sample 0.
      // This aligns the click track with the music's actual beat grid.
      let beatOffset = 0
      if (detectedBPM) {
        beatOffset = findBeatOffset(
          result.samples,
          result.sampleRate,
          detectedBPM
        )
        if (beatOffset > 0 && beatOffset < result.samples.length) {
          result.samples = result.samples.slice(beatOffset)
        }
      }

      return { ...result, detectedBPM }
    } catch {
      return null
    }
  }

  // Write a WAV file from Float32 samples (mono, s16)
  async writeWav(
    filePath: string,
    samples: Float32Array,
    sampleRate: number
  ): Promise<void> {
    const wavData = encodeWav(samples, sampleRate)
    await Bun.write(filePath, wavData)
  }

  // Write a stereo WAV file from mono Float32 samples with pan applied.
  async writeStereoWav(
    filePath: string,
    samples: Float32Array,
    sampleRate: number,
    pan: number = 0
  ): Promise<void> {
    const wavData = encodeWavStereo(samples, sampleRate, pan)
    await Bun.write(filePath, wavData)
  }

  // ── Offline WSOLA Time-Stretch ───────────────────────────────────────
  // Pitch-preserving time stretch matching the native engine's algorithm.
  // Parameters match native: window=1024, hop=512, search=±256.
  // speed < 1: output is longer (slower playback), speed > 1: shorter (faster).
  private wsolaStretch(samples: Float32Array, speed: number): Float32Array {
    const WINDOW = 1024
    const HOP = 512
    const SEARCH = 256
    const len = samples.length
    // Output length: input_length / speed (slower = more output samples)
    const outLen = Math.ceil(len / speed)
    const output = new Float32Array(outLen)

    // Hann window
    const hann = new Float32Array(WINDOW)
    for (let i = 0; i < WINDOW; i++) {
      hann[i] = 0.5 * (1.0 - Math.cos((2 * Math.PI * i) / (WINDOW - 1)))
    }

    const safeRead = (pos: number): number => {
      if (pos < 0 || pos >= len) return 0
      return samples[pos]!
    }

    let inputPos = 0.0
    let outPos = 0
    const prevWindow = new Float32Array(WINDOW) // previous windowed segment

    while (outPos < outLen) {
      const targetInput = Math.round(inputPos)

      // Past end of audio — fill remaining with silence
      if (targetInput >= len) {
        break
      }

      // Find best alignment by cross-correlating previous window tail
      // with candidate positions
      let bestOffset = 0
      if (outPos > 0) {
        let bestCorr = -1e30
        for (let offset = -SEARCH; offset <= SEARCH; offset++) {
          const pos = targetInput + offset
          let corr = 0
          let norm1 = 0
          let norm2 = 0
          for (let i = 0; i < HOP; i += 4) {
            const s1 = prevWindow[HOP + i]!
            const s2 = safeRead(pos + i)
            corr += s1 * s2
            norm1 += s1 * s1
            norm2 += s2 * s2
          }
          const denom = Math.sqrt(norm1 * norm2 + 1e-20)
          const normalized = corr / denom
          if (normalized > bestCorr) {
            bestCorr = normalized
            bestOffset = offset
          }
        }
      }

      const alignedPos = targetInput + bestOffset

      // Extract and window the new segment
      const newWindow = new Float32Array(WINDOW)
      for (let i = 0; i < WINDOW; i++) {
        newWindow[i] = safeRead(alignedPos + i) * hann[i]!
      }

      // Overlap-add: blend previous tail with start of new window
      const remaining = outLen - outPos
      const hopOut = Math.min(HOP, remaining)
      for (let i = 0; i < hopOut; i++) {
        output[outPos + i] = prevWindow[HOP + i]! + newWindow[i]!
      }
      outPos += hopOut

      // Store new window for next iteration
      prevWindow.set(newWindow)

      // Advance input position
      inputPos += HOP * speed
    }

    return output.subarray(0, outPos)
  }

  // ── Export Mixdown ─────────────────────────────────────────────────────
  // Still uses ffmpeg for the final mix (non-realtime, not performance-critical)

  async exportMixdown(
    state: ProjectState,
    outputPath: string
  ): Promise<boolean> {
    const tracksToMix: { track: Track; tempPath: string }[] = []
    const hasSolo = state.tracks.some((t) => t.solo)
    const speed = state.bpm / state.originalBpm

    for (const track of state.tracks) {
      if (!track.samples || track.samples.length === 0) continue
      if (track.muted) continue
      if (hasSolo && !track.solo) continue

      // Apply WSOLA time-stretch when speed != 1.0 so the exported audio
      // plays at the adjusted BPM while preserving pitch
      const exportSamples =
        Math.abs(speed - 1.0) > 0.001
          ? this.wsolaStretch(track.samples, speed)
          : track.samples

      const tempPath = `/tmp/tuidaw_mix_${track.id}.wav`
      await this.writeWav(tempPath, exportSamples, track.sampleRate)
      tracksToMix.push({ track, tempPath })
    }

    // Generate click track WAV if click is enabled
    let clickTempPath: string | null = null
    if (state.clickEnabled) {
      // Determine total duration from the longest track AFTER time-stretching
      // (at speed 0.5x, the stretched audio is 2x longer)
      let totalSamples = 0
      for (const track of state.tracks) {
        if (track.samples && track.samples.length > 0) {
          const stretched =
            Math.abs(speed - 1.0) > 0.001
              ? Math.ceil(track.samples.length / speed)
              : track.samples.length
          if (stretched > totalSamples) totalSamples = stretched
        }
      }
      if (totalSamples === 0) {
        // At least 4 bars of click
        const samplesPerBeat = Math.round((60 / state.bpm) * state.sampleRate)
        totalSamples = samplesPerBeat * 16
      }

      // Generate click waveform: 1kHz sine with 20ms linear decay at each beat
      const clickSamples = new Float32Array(totalSamples)
      const samplesPerBeat = Math.round((60 / state.bpm) * state.sampleRate)
      const clickLen = Math.round(state.sampleRate * 0.02) // 20ms

      for (let pos = 0; pos < totalSamples; pos++) {
        const beatPos = pos % samplesPerBeat
        if (beatPos < clickLen) {
          const t = beatPos / state.sampleRate
          const envelope = 1.0 - beatPos / clickLen
          clickSamples[pos] = Math.sin(2 * Math.PI * 1000 * t) * envelope
        }
      }

      clickTempPath = `/tmp/tuidaw_mix_click.wav`
      await this.writeWav(clickTempPath, clickSamples, state.sampleRate)
      // Treat click as a pseudo-track with its own volume and pan
      tracksToMix.push({
        track: {
          id: '__click__',
          name: 'Click',
          color: '#e0af68',
          muted: false,
          solo: false,
          armed: false,
          monitoring: false,
          volume: state.clickVolume,
          pan: state.clickPan,
          samples: clickSamples,
          sampleRate: state.sampleRate,
          filePath: null,
          inputDeviceId: null
        },
        tempPath: clickTempPath
      })
    }

    if (tracksToMix.length === 0) return false

    const cmd: string[] = ['ffmpeg', '-y']
    for (const { tempPath } of tracksToMix) {
      cmd.push('-i', tempPath)
    }

    if (tracksToMix.length === 1) {
      const vol = tracksToMix[0].track.volume
      const pan = tracksToMix[0].track.pan
      const leftGain = Math.cos(((pan + 1) / 2) * (Math.PI / 2))
      const rightGain = Math.sin(((pan + 1) / 2) * (Math.PI / 2))
      cmd.push(
        '-filter_complex',
        `[0:a]volume=${vol},pan=stereo|c0=${leftGain.toFixed(4)}*c0|c1=${rightGain.toFixed(4)}*c0,aformat=sample_rates=${state.sampleRate}[out]`,
        '-map',
        '[out]'
      )
    } else {
      const filters: string[] = []
      const mixInputs: string[] = []

      for (let i = 0; i < tracksToMix.length; i++) {
        const vol = tracksToMix[i].track.volume
        const pan = tracksToMix[i].track.pan
        const leftGain = Math.cos(((pan + 1) / 2) * (Math.PI / 2))
        const rightGain = Math.sin(((pan + 1) / 2) * (Math.PI / 2))
        const label = `a${i}`
        filters.push(
          `[${i}:a]volume=${vol},pan=stereo|c0=${leftGain.toFixed(4)}*c0|c1=${rightGain.toFixed(4)}*c0[${label}]`
        )
        mixInputs.push(`[${label}]`)
      }

      filters.push(
        `${mixInputs.join('')}amix=inputs=${tracksToMix.length}:duration=longest:normalize=0,aformat=sample_rates=${state.sampleRate}[out]`
      )

      cmd.push('-filter_complex', filters.join(';'), '-map', '[out]')
    }

    cmd.push('-c:a', 'pcm_s16le', outputPath)

    try {
      const proc = spawn({ cmd, stdout: 'pipe', stderr: 'pipe' })
      await proc.exited

      for (const { tempPath } of tracksToMix) {
        try {
          rmSync(tempPath)
        } catch {}
      }

      return proc.exitCode === 0
    } catch {
      return false
    }
  }

  // ── Save Project ───────────────────────────────────────────────────────

  async saveProject(state: ProjectState, outputPath: string): Promise<boolean> {
    const tmpDir = `/tmp/tuidaw_project_${Date.now()}`
    const tracksDir = `${tmpDir}/tracks`

    try {
      mkdirSync(tracksDir, { recursive: true })

      const trackDescs: TrackDescriptor[] = []

      for (const track of state.tracks) {
        let wavFile: string | null = null

        if (track.samples && track.samples.length > 0) {
          const safeName = track.id.replace(/[^a-zA-Z0-9_-]/g, '_')
          wavFile = `tracks/${safeName}.wav`
          await this.writeWav(
            `${tmpDir}/${wavFile}`,
            track.samples,
            track.sampleRate
          )
        }

        trackDescs.push({
          id: track.id,
          name: track.name,
          color: track.color,
          muted: track.muted,
          solo: track.solo,
          armed: track.armed,
          volume: track.volume,
          pan: track.pan,
          sampleRate: track.sampleRate,
          inputDeviceId: track.inputDeviceId,
          wavFile
        })
      }

      const descriptor: ProjectDescriptor = {
        version: 1,
        projectName: state.projectName,
        bpm: state.bpm,
        originalBpm: state.originalBpm,
        clickEnabled: state.clickEnabled,
        clickVolume: state.clickVolume,
        clickPan: state.clickPan,
        sampleRate: state.sampleRate,
        playheadPosition: state.playheadPosition,
        scrollOffset: state.scrollOffset,
        loopStart: state.loopStart,
        loopEnd: state.loopEnd,
        outputDeviceId: state.outputDeviceId,
        selectedTrackIndex: state.selectedTrackIndex,
        tracks: trackDescs
      }

      await Bun.write(
        `${tmpDir}/project.json`,
        JSON.stringify(descriptor, null, 2)
      )

      const proc = spawn({
        cmd: ['tar', 'czf', outputPath, '-C', tmpDir, '.'],
        stdout: 'pipe',
        stderr: 'pipe'
      })
      await proc.exited

      rmSync(tmpDir, { recursive: true, force: true })

      return proc.exitCode === 0
    } catch {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {}
      return false
    }
  }

  // ── Open Project ───────────────────────────────────────────────────────

  async openProject(filePath: string): Promise<ProjectState | null> {
    const tmpDir = `/tmp/tuidaw_open_${Date.now()}`

    try {
      mkdirSync(tmpDir, { recursive: true })

      const proc = spawn({
        cmd: ['tar', 'xzf', filePath, '-C', tmpDir],
        stdout: 'pipe',
        stderr: 'pipe'
      })
      await proc.exited
      if (proc.exitCode !== 0) return null

      const descFile = Bun.file(`${tmpDir}/project.json`)
      const descJson = await descFile.text()
      const desc = JSON.parse(descJson) as ProjectDescriptor

      const tracks: Track[] = []
      for (const td of desc.tracks) {
        let samples: Float32Array | null = null

        if (td.wavFile) {
          const wavPath = `${tmpDir}/${td.wavFile}`
          if (existsSync(wavPath)) {
            const wavBuf = new Uint8Array(await Bun.file(wavPath).arrayBuffer())
            const parsed = parseWav(wavBuf)
            if (parsed) {
              samples = parsed.samples
            }
          }
        }

        tracks.push({
          id: td.id,
          name: td.name,
          color: td.color,
          muted: td.muted,
          solo: td.solo,
          armed: td.armed,
          monitoring: false,
          volume: td.volume,
          pan: td.pan,
          samples,
          sampleRate: td.sampleRate,
          filePath: null,
          inputDeviceId: td.inputDeviceId
        })
      }

      rmSync(tmpDir, { recursive: true, force: true })

      return {
        bpm: desc.bpm,
        originalBpm: desc.originalBpm ?? desc.bpm,
        bpmLocked: false,
        clickEnabled: desc.clickEnabled,
        clickVolume: desc.clickVolume ?? 0.5,
        clickPan: desc.clickPan ?? 0,
        sampleRate: desc.sampleRate,
        tracks,
        selectedTrackIndex: desc.selectedTrackIndex,
        transportState: 'stopped',
        playheadPosition: desc.playheadPosition,
        scrollOffset: desc.scrollOffset,
        freeScroll: false,
        loopStart: desc.loopStart,
        loopEnd: desc.loopEnd,
        projectName: desc.projectName,
        outputDeviceId: desc.outputDeviceId,
        availableInputDevices: [],
        availableOutputDevices: []
      }
    } catch {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {}
      return null
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  destroy(): void {
    lib.symbols.tuidaw_deinit()
  }
}
