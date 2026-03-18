// ============================================================================
// tuidaw - Audio Engine (miniaudio-based native library via Bun FFI)
// ============================================================================
// Cross-platform audio I/O using a native shared library built with miniaudio.
// Replaces the previous PipeWire CLI-based approach for:
//   - Sample-accurate playback and mixing (no process spawn timing hacks)
//   - Instant pan/volume changes (no WAV rewrite + process restart)
//   - True cross-platform support (Linux, macOS, Windows)
//   - Lower latency and no temp file I/O during transport

import { dlopen, FFIType, ptr, toArrayBuffer, toBuffer, type Pointer } from "bun:ffi"
import { spawn, type Subprocess } from "bun"
import { existsSync, mkdirSync, rmSync } from "fs"
import type { Track, ProjectState, AudioDevice, ProjectDescriptor, TrackDescriptor } from "./types"

const SAMPLE_RATE = 48000
const CHANNELS = 1
const BYTES_PER_SAMPLE = 2
const RECORDINGS_DIR = "./recordings"

// ── Load Native Library ─────────────────────────────────────────────────────

function findLibrary(): string {
  const path = require("path")
  const candidates = [
    path.join(__dirname, "..", "native", "libtuidaw_audio.so"),
    path.join(__dirname, "..", "native", "libtuidaw_audio.dylib"),
    path.join(__dirname, "..", "native", "tuidaw_audio.dll"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error("Native audio library not found. Run native/build.sh first.")
}

const lib = dlopen(findLibrary(), {
  tuidaw_init:                 { returns: FFIType.i32 },
  tuidaw_deinit:               { returns: FFIType.void },
  tuidaw_refresh_devices:      { returns: FFIType.i32 },
  tuidaw_get_device_count:     { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_get_device_name:      { returns: FFIType.i32, args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32] },
  tuidaw_is_device_default:    { returns: FFIType.i32, args: [FFIType.i32, FFIType.i32] },
  tuidaw_set_output_device:    { returns: FFIType.void, args: [FFIType.i32] },
  tuidaw_start_playback_device:{ returns: FFIType.i32 },
  tuidaw_stop_playback_device: { returns: FFIType.void },
  tuidaw_add_track:            { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_remove_track:         { returns: FFIType.void, args: [FFIType.i32] },
  tuidaw_set_track_samples:    { returns: FFIType.void, args: [FFIType.i32, FFIType.ptr, FFIType.i32] },
  tuidaw_set_track_volume:     { returns: FFIType.void, args: [FFIType.i32, FFIType.f32] },
  tuidaw_set_track_pan:        { returns: FFIType.void, args: [FFIType.i32, FFIType.f32] },
  tuidaw_set_track_muted:      { returns: FFIType.void, args: [FFIType.i32, FFIType.i32] },
  tuidaw_set_track_solo:       { returns: FFIType.void, args: [FFIType.i32, FFIType.i32] },
  tuidaw_set_track_input_device:{ returns: FFIType.void, args: [FFIType.i32, FFIType.i32] },
  tuidaw_play:                 { returns: FFIType.void, args: [FFIType.i64] },
  tuidaw_stop:                 { returns: FFIType.void },
  tuidaw_get_playhead:         { returns: FFIType.i64 },
  tuidaw_set_playhead:         { returns: FFIType.void, args: [FFIType.i64] },
  tuidaw_set_click:            { returns: FFIType.void, args: [FFIType.i32, FFIType.f32] },
  tuidaw_set_click_samples:    { returns: FFIType.void, args: [FFIType.ptr, FFIType.i32] },
  tuidaw_set_click_volume:     { returns: FFIType.void, args: [FFIType.f32] },
  tuidaw_set_click_pan:        { returns: FFIType.void, args: [FFIType.f32] },
  tuidaw_set_loop:             { returns: FFIType.void, args: [FFIType.i64, FFIType.i64] },
  tuidaw_start_recording:      { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_stop_recording:       { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_get_recording_buffer: { returns: FFIType.ptr, args: [FFIType.i32] },
  tuidaw_get_recording_length: { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_set_speed:            { returns: FFIType.void, args: [FFIType.f32] },
  tuidaw_get_speed:            { returns: FFIType.f32 },
  tuidaw_render:               { returns: FFIType.i32, args: [FFIType.ptr, FFIType.i32] },
})

// ── Zenity File Dialog Helpers ─────────────────────────────────────────────
// Opens native GTK file dialogs via zenity. Returns chosen path or null.

async function zenitySave(title: string, defaultName: string, filters?: string[]): Promise<string | null> {
  const cmd = [
    "zenity", "--file-selection", "--save", "--confirm-overwrite",
    "--title", title,
    "--filename", defaultName,
  ]
  for (const f of filters ?? []) {
    cmd.push("--file-filter", f)
  }
  try {
    const proc = spawn({ cmd, stdout: "pipe", stderr: "pipe" })
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    const stdout = proc.stdout
    if (typeof stdout === "number") return null
    const text = await new Response(stdout as ReadableStream).text()
    return text.trim() || null
  } catch {
    return null
  }
}

async function zenityOpen(title: string, filters?: string[]): Promise<string | null> {
  const cmd = [
    "zenity", "--file-selection",
    "--title", title,
  ]
  for (const f of filters ?? []) {
    cmd.push("--file-filter", f)
  }
  try {
    const proc = spawn({ cmd, stdout: "pipe", stderr: "pipe" })
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    const stdout = proc.stdout
    if (typeof stdout === "number") return null
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
const trackIdMap = new Map<string, number>()     // string -> native int
const reverseIdMap = new Map<number, string>()    // native int -> string

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

  // Pinned buffer for the click track (one beat of 1kHz sine + 20ms decay)
  private pinnedClickBuffer: Float32Array | null = null

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
      throw new Error("Failed to initialize native audio engine")
    }

    // Start the playback device immediately (it sits idle until tuidaw_play)
    const playResult = lib.symbols.tuidaw_start_playback_device()
    if (playResult !== 0) {
      throw new Error("Failed to start playback device")
    }
  }

  // ── Device Enumeration ─────────────────────────────────────────────────

  async enumerateDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
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
      inputs.push({ id: i, name, description: name, type: "input", isDefault })
    }

    // Enumerate playback (output) devices
    const outputCount = lib.symbols.tuidaw_get_device_count(0)
    for (let i = 0; i < outputCount; i++) {
      const name = readName(0, i)
      const isDefault = lib.symbols.tuidaw_is_device_default(0, i) !== 0
      outputs.push({ id: i, name, description: name, type: "output", isDefault })
    }

    return { inputs, outputs }
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
      lib.symbols.tuidaw_set_track_samples(nid, ptr(track.samples), track.samples.length)
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
      lib.symbols.tuidaw_set_track_samples(nid, ptr(track.samples), track.samples.length)
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
    _targetDeviceId?: number | null,
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
  pollRecordingData(trackId: string, onChunk: (samples: Float32Array) => void): void {
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
    const byteOffset = lastLen * 4  // float32 = 4 bytes
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
    return new Float32Array(bytes.slice(0))  // copy to own buffer
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

  // ── Transport ──────────────────────────────────────────────────────────

  // Mark transport start (used by the native engine)
  markTransportStart(): void {
    // No-op in the new engine — tuidaw_play() handles this
  }

  // Play all non-muted tracks simultaneously.
  // In the new engine, this just syncs all tracks and starts the native transport.
  async playAll(state: ProjectState): Promise<void> {
    this.syncAllTracks(state)

    // Set click state — pass originalBpm so beat grid is in content-space.
    // Click timing uses pos % samples_per_beat in the native callback,
    // where pos is the content-space playhead (same coordinate as samples[pos]).
    lib.symbols.tuidaw_set_click(state.clickEnabled ? 1 : 0, state.bpm)
    lib.symbols.tuidaw_set_click_volume(state.clickVolume)
    lib.symbols.tuidaw_set_click_pan(state.clickPan)

    // Set click tone buffer (BPM-independent — just the 20ms click tone).
    // Beat timing is handled in native via click_displayed_bpm.
    this.updateClickBuffer(state.sampleRate)

    // Set loop state — always pass loop region to native engine if it exists.
    // The native callback handles all cases correctly:
    //   - Playhead before loop: plays linearly until reaching loopEnd, then wraps
    //   - Playhead inside loop: wraps at loopEnd back to loopStart
    //   - Playhead after loop (manual seek past region): disabled by syncLoopAfterSeek
    if (state.loopStart !== null && state.loopEnd !== null &&
        state.playheadPosition <= state.loopEnd) {
      lib.symbols.tuidaw_set_loop(BigInt(state.loopStart), BigInt(state.loopEnd))
    } else {
      lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1))
    }

    // Set output device
    lib.symbols.tuidaw_set_output_device(state.outputDeviceId ?? -1)

    // Start transport from current playhead position
    lib.symbols.tuidaw_play(BigInt(state.playheadPosition))
  }

  // Get elapsed samples since play started — now uses the native engine's
  // sample-accurate counter instead of wall-clock time.
  getElapsedSamples(): number {
    return 0  // Not used in new engine — getPlayhead() is authoritative
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
    _targetDeviceId?: number | null,
  ): Promise<void> {
    this.syncTrack(track)
  }

  // These are no longer needed but kept for API compatibility
  async prepareTrackWav(_track: Track, _startSample?: number): Promise<string | null> {
    return null  // No temp files needed
  }
  spawnTrackPlayer(_trackId: string, _wavPath: string, _targetDeviceId?: number | null, _volume?: number): void {
    // No-op — mixing is done in the native callback
  }

  // Restart track for pan change — no longer needed, pan is instant
  async restartTrackForPan(
    track: Track,
    _currentSample: number,
    _targetDeviceId?: number | null,
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
    _loopStart: number,
  ): Promise<{ tracks: { trackId: string; wavPath: string; volume: number }[]; clickWavPath: string | null }> {
    return { tracks: [], clickWavPath: null }
  }

  // Execute loop restart — no longer needed
  executeLoopRestart(
    _preparations: any,
    _targetDeviceId?: number | null,
  ): void {
    // No-op — loop is handled sample-accurately in the native callback
  }

  // ── Click / Metronome ──────────────────────────────────────────────────

  async startClick(bpm: number, _startSample?: number, _targetDeviceId?: number | null): Promise<void> {
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
    return ""
  }
  spawnClickPlayer(_wavPath: string, _targetDeviceId?: number | null): void {}

  // Generate the click TONE: 1kHz sine wave with 20ms linear decay at 48kHz.
  // This is just the tone waveform (960 samples at 48kHz), NOT a full beat.
  // Beat timing is handled in the native engine via click_displayed_bpm +
  // click_frame_counter, so this buffer is BPM-independent.
  generateClickBuffer(sampleRate: number = 48000): Float32Array {
    const clickLen = Math.round(sampleRate * 0.02) // 20ms = 960 samples at 48kHz
    const buf = new Float32Array(clickLen)
    for (let i = 0; i < clickLen; i++) {
      const t = i / sampleRate
      const envelope = 1.0 - i / clickLen
      buf[i] = Math.sin(2 * Math.PI * 1000 * t) * envelope
    }
    return buf
  }

  // Pin the click buffer and pass its pointer to the native engine.
  setClickSamples(buf: Float32Array): void {
    this.pinnedClickBuffer = buf
    lib.symbols.tuidaw_set_click_samples(ptr(buf), buf.length)
  }

  // Regenerate and set the click tone buffer.
  // Call this once (tone is BPM-independent). For BPM changes, just call
  // startClick(bpm) which updates the displayed BPM in the native engine.
  updateClickBuffer(_sampleRate: number = 48000): void {
    const buf = this.generateClickBuffer(_sampleRate)
    this.setClickSamples(buf)
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
    const filePath = `${RECORDINGS_DIR}/${track.name.replace(/\s+/g, "_")}_${Date.now()}.wav`
    await this.writeWav(filePath, track.samples, track.sampleRate)
    track.filePath = filePath
    return filePath
  }

  async loadWavFile(filePath: string): Promise<{ samples: Float32Array; sampleRate: number; detectedBPM: number | null } | null> {
    try {
      const file = Bun.file(filePath)
      const buf = Buffer.from(await file.arrayBuffer())
      const result = this.parseWav(buf)
      if (!result) return null

      // Detect BPM before resampling (use original sample rate for accuracy)
      const detectedBPM = this.detectBPM(result.samples, result.sampleRate)

      // Resample to project sample rate if needed (linear interpolation)
      if (result.sampleRate !== SAMPLE_RATE) {
        result.samples = this.resample(result.samples, result.sampleRate, SAMPLE_RATE)
        result.sampleRate = SAMPLE_RATE
      }

      // Find beat offset and trim audio so first beat sits at sample 0.
      // This aligns the click track with the music's actual beat grid.
      let beatOffset = 0
      if (detectedBPM) {
        beatOffset = this.findBeatOffset(result.samples, result.sampleRate, detectedBPM)
        if (beatOffset > 0 && beatOffset < result.samples.length) {
          result.samples = result.samples.slice(beatOffset)
        }
      }

      return { ...result, detectedBPM }
    } catch {
      return null
    }
  }

  // Detect BPM using two-pass approach:
  //   1. Coarse estimate via onset-based autocorrelation (~2 BPM resolution)
  //   2. Fine refinement via sample-level autocorrelation (0.1 BPM resolution)
  // Returns the most likely BPM in the range [minBPM, maxBPM], or null if detection fails
  detectBPM(samples: Float32Array, sampleRate: number, minBPM: number = 60, maxBPM: number = 300): number | null {
    if (samples.length < sampleRate * 4) return null // need at least 4 seconds

    // ── Pass 1: Coarse onset-based autocorrelation ──────────────────────

    // Use up to 60 seconds from the start for analysis (skip first 0.5s)
    const skipSamples = Math.floor(sampleRate * 0.5)
    const analysisLen = Math.min(samples.length - skipSamples, sampleRate * 60)
    if (analysisLen < sampleRate * 4) return null

    // Compute short-time energy in overlapping frames
    const frameSize = Math.floor(sampleRate * 0.02) // 20ms frames
    const hopSize = Math.floor(frameSize / 4)        // 75% overlap (~200 fps)
    const numFrames = Math.floor((analysisLen - frameSize) / hopSize) + 1
    if (numFrames < 2) return null

    const energy = new Float32Array(numFrames)
    for (let f = 0; f < numFrames; f++) {
      let sum = 0
      const start = skipSamples + f * hopSize
      for (let i = 0; i < frameSize; i++) {
        const s = samples[start + i]
        sum += s * s
      }
      energy[f] = sum / frameSize
    }

    // Onset strength function (half-wave rectified first derivative)
    const onset = new Float32Array(numFrames - 1)
    for (let i = 0; i < onset.length; i++) {
      onset[i] = Math.max(0, energy[i + 1] - energy[i])
    }

    // Normalize onset signal
    let onsetMax = 0
    for (let i = 0; i < onset.length; i++) {
      if (onset[i] > onsetMax) onsetMax = onset[i]
    }
    if (onsetMax > 0) {
      for (let i = 0; i < onset.length; i++) {
        onset[i] /= onsetMax
      }
    }

    // Autocorrelation of onset signal in the BPM range
    const onsetRate = sampleRate / hopSize
    const minLag = Math.floor((60 / maxBPM) * onsetRate)
    const maxLag = Math.ceil((60 / minBPM) * onsetRate)
    if (maxLag >= onset.length) return null

    const acf = new Float32Array(maxLag - minLag + 1)
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0
      const n = onset.length - lag
      for (let i = 0; i < n; i++) {
        sum += onset[i] * onset[i + lag]
      }
      acf[lag - minLag] = sum / n
    }

    // Find peaks with parabolic interpolation
    const parabolicPeakOffset = (left: number, center: number, right: number): number => {
      const denom = 2 * (2 * center - left - right)
      if (Math.abs(denom) < 1e-10) return 0
      return (left - right) / denom
    }

    const peaks: { lag: number; strength: number }[] = []
    for (let i = 1; i < acf.length - 1; i++) {
      if (acf[i] > acf[i - 1] && acf[i] > acf[i + 1] && acf[i] > 0) {
        const offset = parabolicPeakOffset(acf[i - 1], acf[i], acf[i + 1])
        peaks.push({ lag: i + minLag + offset, strength: acf[i] })
      }
    }

    if (peaks.length === 0) {
      // No peaks found, use the maximum with interpolation
      let bestIdx = 0
      for (let i = 1; i < acf.length; i++) {
        if (acf[i] > acf[bestIdx]) bestIdx = i
      }
      if (acf[bestIdx] <= 0) return null
      let bestLag = bestIdx + minLag
      if (bestIdx > 0 && bestIdx < acf.length - 1) {
        bestLag += parabolicPeakOffset(acf[bestIdx - 1], acf[bestIdx], acf[bestIdx + 1])
      }
      const coarseBPM = (60 * onsetRate) / bestLag
      return this.refineBPM(samples, sampleRate, coarseBPM, minBPM, maxBPM)
    }

    // Sort by strength descending
    peaks.sort((a, b) => b.strength - a.strength)

    // Iterative octave promotion: keep promoting to double-time if a harmonic
    // peak exists with strength >= 80% of current best. This chains through
    // multiple octaves (e.g. 62.5 → 125 → 250 BPM).
    let bestPeak = peaks[0]
    let promoted = true
    while (promoted) {
      promoted = false
      for (const p of peaks) {
        const ratio = bestPeak.lag / p.lag
        if (ratio > 1.8 && ratio < 2.2 && p.strength > bestPeak.strength * 0.8) {
          bestPeak = p
          promoted = true
          break
        }
      }
    }

    // Collect candidate BPMs: the promoted best peak + any strong ACF peaks
    // that might be the true tempo. Only consider peaks at BPM values BETWEEN
    // the pre-promotion and post-promotion BPM, since the promoted result may
    // have overshot (e.g. 124→230 when real is 185).
    // Exclude candidates that are simple harmonic ratios (3:2, 4:3, 5:3, etc.)
    // of the promoted BPM — those are sub-harmonics, not overshoot corrections.
    const promotedBPM = (60 * onsetRate) / bestPeak.lag
    const prePromotionBPM = (60 * onsetRate) / peaks[0].lag
    const candidates: number[] = [promotedBPM]
    const strengthThreshold = peaks[0].strength * 0.9
    // Exclude candidates that are 3:2 sub-harmonics of the promoted BPM,
    // as these are rhythmic subdivisions, not real tempo alternatives.
    const harmonicRatios = [3/2]
    for (const p of peaks) {
      const bpm = (60 * onsetRate) / p.lag
      if (p.strength >= strengthThreshold && bpm > prePromotionBPM && bpm < promotedBPM) {
        // Skip if this BPM is a simple harmonic sub-division of the promoted BPM
        const ratio = promotedBPM / bpm
        const isHarmonic = harmonicRatios.some(hr => Math.abs(ratio - hr) < 0.1)
        if (isHarmonic) continue
        const isDuplicate = candidates.some(c => Math.abs(c - bpm) < 5)
        if (!isDuplicate) candidates.push(bpm)
      }
    }

    // ── Pass 2: Fine sample-level refinement ────────────────────────────
    // Refine each candidate and pick the one with the best correlation
    return this.refineBPMMulti(samples, sampleRate, candidates, minBPM, maxBPM)
  }

  // Refine multiple BPM candidates and return the one with the best correlation.
  // When candidates are in an octave relationship, apply a bias toward the higher
  // BPM since sample-level autocorrelation is inherently higher at lower frequencies
  // (longer periods have more self-similarity).
  private refineBPMMulti(samples: Float32Array, sampleRate: number, candidates: number[], minBPM: number, maxBPM: number): number {
    const searchRadius = 3 // ±3 BPM per candidate
    const step = 0.1
    const refineStart = Math.floor(sampleRate * 1) // skip first 1s
    const refineLen = Math.min(samples.length - refineStart, sampleRate * 30)

    if (refineLen < sampleRate * 2) {
      return Math.max(minBPM, Math.min(maxBPM, Math.round(candidates[0])))
    }

    // Refine each candidate independently
    const refined: { bpm: number; corr: number }[] = []
    for (const coarseBPM of candidates) {
      let bestBPM = coarseBPM
      let bestCorr = -Infinity
      for (let bpm = coarseBPM - searchRadius; bpm <= coarseBPM + searchRadius; bpm += step) {
        if (bpm < minBPM || bpm > maxBPM) continue
        const period = Math.round((sampleRate * 60) / bpm)
        if (period >= refineLen) continue

        let sum = 0, norm1 = 0, norm2 = 0
        const n = refineLen - period
        for (let i = 0; i < n; i += 10) {
          const s1 = samples[refineStart + i]
          const s2 = samples[refineStart + i + period]
          sum += s1 * s2
          norm1 += s1 * s1
          norm2 += s2 * s2
        }
        const corr = sum / Math.sqrt(norm1 * norm2 + 1e-20)
        if (corr > bestCorr) { bestCorr = corr; bestBPM = bpm }
      }
      refined.push({ bpm: bestBPM, corr: bestCorr })
    }

    // Pick the winner: prefer the promoted (first) candidate unless another
    // candidate has significantly higher correlation (> 5% absolute improvement).
    // This counteracts the inherent bias of sample-level autocorrelation toward
    // lower BPM (longer periods = more self-similarity).
    let winner = refined[0]
    for (let i = 1; i < refined.length; i++) {
      if (refined[i].corr > winner.corr + 0.05) {
        winner = refined[i]
      }
    }

    return Math.max(minBPM, Math.min(maxBPM, Math.round(winner.bpm)))
  }

  // Refine a coarse BPM estimate using sample-level autocorrelation
  // Searches ±3 BPM in 0.1 BPM steps, picking the lag with highest normalized correlation
  private refineBPM(samples: Float32Array, sampleRate: number, coarseBPM: number, minBPM: number, maxBPM: number): number {
    const searchRadius = 3 // ±3 BPM
    const step = 0.1
    const refineStart = Math.floor(sampleRate * 1) // skip first 1s
    const refineLen = Math.min(samples.length - refineStart, sampleRate * 30)

    if (refineLen < sampleRate * 2) {
      // Not enough audio for refinement, return coarse result
      return Math.max(minBPM, Math.min(maxBPM, Math.round(coarseBPM)))
    }

    let bestBPM = coarseBPM
    let bestCorr = -Infinity

    for (let bpm = coarseBPM - searchRadius; bpm <= coarseBPM + searchRadius; bpm += step) {
      if (bpm < minBPM || bpm > maxBPM) continue
      const period = Math.round((sampleRate * 60) / bpm)
      if (period >= refineLen) continue

      // Normalized autocorrelation at this lag (subsample every 10th for speed)
      let sum = 0
      let norm1 = 0
      let norm2 = 0
      const n = refineLen - period
      for (let i = 0; i < n; i += 10) {
        const s1 = samples[refineStart + i]
        const s2 = samples[refineStart + i + period]
        sum += s1 * s2
        norm1 += s1 * s1
        norm2 += s2 * s2
      }
      const corr = sum / Math.sqrt(norm1 * norm2 + 1e-20)

      if (corr > bestCorr) {
        bestCorr = corr
        bestBPM = bpm
      }
    }

    return Math.max(minBPM, Math.min(maxBPM, Math.round(bestBPM)))
  }

  // Find the sample offset where the beat grid best aligns with the audio's
  // rhythmic structure. Returns the number of samples to trim from the start
  // so that the first beat sits at sample 0.
  //
  // Robust approach — handles intros with non-matching percussion, guitar
  // slides, count-ins, and other non-rhythmic transients:
  //
  // 1. Compute onset strength at ~5ms resolution across the full track
  // 2. Divide audio into overlapping analysis windows (each ~8 bars long)
  // 3. For each window, sweep phase offsets and score using beat-vs-offbeat
  //    contrast (not just raw onset strength). This rejects one-off transients
  //    like guitar slides since they don't repeat periodically.
  // 4. Weight later windows more heavily (intros often have non-matching
  //    patterns; the "real" beat is established after the first few bars)
  // 5. Aggregate scores across all windows — the phase that consistently
  //    scores highest across multiple windows wins
  // 6. Refine the coarse winner at sample level using median onset strength
  //    (robust to outliers) rather than mean
  findBeatOffset(samples: Float32Array, sampleRate: number, bpm: number): number {
    const samplesPerBeat = Math.round((60 / bpm) * sampleRate)
    if (samplesPerBeat <= 0 || samples.length < samplesPerBeat * 4) return 0

    // ── Step 1: Compute onset strength ──────────────────────────────────
    const frameSize = Math.floor(sampleRate * 0.005) // 5ms frames
    const hopSize = frameSize
    const numFrames = Math.floor(samples.length / hopSize) - 1
    if (numFrames < 2) return 0

    // Short-time energy per frame
    const energy = new Float32Array(numFrames)
    for (let f = 0; f < numFrames; f++) {
      let sum = 0
      const start = f * hopSize
      for (let i = 0; i < frameSize; i++) {
        const s = samples[start + i]
        sum += s * s
      }
      energy[f] = sum / frameSize
    }

    // Onset strength = half-wave rectified energy derivative
    const onset = new Float32Array(numFrames - 1)
    for (let i = 0; i < onset.length; i++) {
      onset[i] = Math.max(0, energy[i + 1] - energy[i])
    }

    // ── Step 2: Phase search parameters ─────────────────────────────────
    const stepsPerBeat = Math.round(samplesPerBeat / hopSize)
    if (stepsPerBeat <= 0) return 0

    // Window size: ~8 bars (32 beats). Overlap by 50%.
    const beatsPerWindow = 32
    const windowFrames = beatsPerWindow * stepsPerBeat
    const windowHop = Math.floor(windowFrames / 2) // 50% overlap
    const numWindows = Math.max(1, Math.floor((onset.length - windowFrames) / windowHop) + 1)

    // Accumulate phase scores across all windows
    const phaseScores = new Float64Array(stepsPerBeat)

    for (let w = 0; w < numWindows; w++) {
      const winStart = w * windowHop
      const winEnd = Math.min(winStart + windowFrames, onset.length)
      const winLen = winEnd - winStart
      if (winLen < stepsPerBeat * 4) continue

      // Weight: later windows get more weight. First window gets 0.5,
      // last gets 1.5. Linear ramp. This de-emphasizes intros.
      const t = numWindows > 1 ? w / (numWindows - 1) : 1
      const weight = 0.5 + t * 1.0

      // Compute mean onset strength across this window for normalization
      let winMean = 0
      for (let i = winStart; i < winEnd; i++) winMean += onset[i]
      winMean /= winLen
      if (winMean < 1e-12) continue // silent window, skip

      for (let phase = 0; phase < stepsPerBeat; phase++) {
        // Collect on-beat onset strengths
        let onBeatSum = 0
        let onBeatCount = 0
        // Collect off-beat onset strengths (midpoints between beats)
        let offBeatSum = 0
        let offBeatCount = 0

        const halfStep = Math.floor(stepsPerBeat / 2)

        for (let beatIdx = phase; beatIdx < winLen; beatIdx += stepsPerBeat) {
          const globalIdx = winStart + beatIdx
          if (globalIdx >= onset.length) break
          onBeatSum += onset[globalIdx]
          onBeatCount++

          // Off-beat = halfway between this beat and the next
          const offIdx = globalIdx + halfStep
          if (offIdx < onset.length && offIdx < winEnd) {
            offBeatSum += onset[offIdx]
            offBeatCount++
          }
        }

        if (onBeatCount < 2) continue

        const onBeatMean = onBeatSum / onBeatCount
        const offBeatMean = offBeatCount > 0 ? offBeatSum / offBeatCount : 0

        // Score = contrast between on-beat and off-beat onset strength.
        // High contrast means rhythmic periodicity at this phase.
        // Normalize by window mean so loud windows don't dominate.
        // Add a small on-beat term to break ties (prefer phases with
        // actual onset energy, not just "both sides are zero").
        const contrast = (onBeatMean - offBeatMean) / (winMean + 1e-12)
        const magnitude = onBeatMean / (winMean + 1e-12)
        const score = contrast * 0.7 + magnitude * 0.3

        phaseScores[phase] += score * weight
      }
    }

    // ── Step 3: Find the best coarse phase ──────────────────────────────
    let bestPhase = 0
    let bestScore = -Infinity
    for (let phase = 0; phase < stepsPerBeat; phase++) {
      if (phaseScores[phase] > bestScore) {
        bestScore = phaseScores[phase]
        bestPhase = phase
      }
    }

    const coarseOffset = bestPhase * hopSize

    // ── Step 4: Refine at sample level using median onset strength ──────
    // Search ±5ms around the coarse winner. For each candidate offset,
    // collect onset strengths at all beat positions and use median instead
    // of mean — this is robust to one-off outliers (guitar slides, etc.)
    const refineRadius = Math.floor(sampleRate * 0.005) // ±5ms
    const refineStart = Math.max(0, coarseOffset - refineRadius)
    const refineEnd = Math.min(samplesPerBeat, coarseOffset + refineRadius)

    // Use the later portion of audio for refinement (skip first 10s or 25%
    // of audio, whichever is less, to avoid intro artifacts)
    const skipSamples = Math.min(
      Math.floor(sampleRate * 10),
      Math.floor(samples.length * 0.25)
    )
    const refineEndSample = Math.min(samples.length - 1, skipSamples + Math.floor(sampleRate * 30))

    let bestFineOffset = coarseOffset
    let bestFineScore = -Infinity

    // Pre-allocate array for median computation
    const maxBeats = Math.ceil((refineEndSample - skipSamples) / samplesPerBeat)
    const beatStrengths = new Float32Array(maxBeats)

    for (let off = refineStart; off < refineEnd; off++) {
      let count = 0
      // Find first beat position >= skipSamples aligned with phase 'off'
      const firstBeat = off + Math.ceil((skipSamples - off) / samplesPerBeat) * samplesPerBeat
      // Collect onset/transient strength at each beat position
      for (let pos = firstBeat;
           pos < refineEndSample - 1 && count < maxBeats;
           pos += samplesPerBeat) {
        // Short-window energy spike: sum abs differences in a ~1ms window
        let spike = 0
        const windowLen = Math.min(Math.floor(sampleRate * 0.001), 48) // ~1ms
        for (let j = 0; j < windowLen && pos + j + 1 < samples.length; j++) {
          spike += Math.abs(samples[pos + j + 1] - samples[pos + j])
        }
        beatStrengths[count++] = spike / windowLen
      }

      if (count < 4) continue

      // Median of beat-position onset strengths (robust to outliers)
      const sorted = beatStrengths.slice(0, count).sort()
      const median = count % 2 === 0
        ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
        : sorted[Math.floor(count / 2)]

      // Also compute the inter-quartile mean (average of middle 50%)
      // for a balance between robustness and sensitivity
      const q1 = Math.floor(count * 0.25)
      const q3 = Math.ceil(count * 0.75)
      let iqm = 0
      for (let i = q1; i < q3; i++) iqm += sorted[i]
      iqm /= (q3 - q1) || 1

      const score = median * 0.4 + iqm * 0.6

      if (score > bestFineScore) {
        bestFineScore = score
        bestFineOffset = off
      }
    }

    return bestFineOffset
  }

  // Resample audio using linear interpolation
  private resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return samples
    const ratio = fromRate / toRate
    const outLen = Math.ceil(samples.length / ratio)
    const out = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio
      const idx = Math.floor(srcPos)
      const frac = srcPos - idx
      const s0 = samples[idx] ?? 0
      const s1 = samples[Math.min(idx + 1, samples.length - 1)] ?? 0
      out[i] = s0 + frac * (s1 - s0)
    }
    return out
  }

  // Convert Float32 (-1.0 to 1.0) to signed 16-bit PCM
  private float32ToPcmS16(samples: Float32Array): Buffer {
    const buffer = Buffer.alloc(samples.length * BYTES_PER_SAMPLE)
    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]))
      const intSample = Math.round(clamped * 32767)
      buffer.writeInt16LE(intSample, i * BYTES_PER_SAMPLE)
    }
    return buffer
  }

  // Convert signed 16-bit PCM to Float32 (-1.0 to 1.0)
  private pcmS16ToFloat32(buffer: Buffer): Float32Array {
    const numSamples = Math.floor(buffer.length / BYTES_PER_SAMPLE)
    const float32 = new Float32Array(numSamples)
    for (let i = 0; i < numSamples; i++) {
      const sample = buffer.readInt16LE(i * BYTES_PER_SAMPLE)
      float32[i] = sample / 32768
    }
    return float32
  }

  // Write a WAV file from Float32 samples (mono, s16)
  async writeWav(filePath: string, samples: Float32Array, sampleRate: number): Promise<void> {
    const pcmData = this.float32ToPcmS16(samples)
    const numChannels = CHANNELS
    const bitsPerSample = 16
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
    const blockAlign = numChannels * (bitsPerSample / 8)
    const dataSize = pcmData.length

    const header = Buffer.alloc(44)
    header.write("RIFF", 0)
    header.writeUInt32LE(36 + dataSize, 4)
    header.write("WAVE", 8)
    header.write("fmt ", 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(numChannels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    header.write("data", 36)
    header.writeUInt32LE(dataSize, 40)

    const wavBuffer = Buffer.concat([header, pcmData])
    await Bun.write(filePath, wavBuffer)
  }

  // Write a stereo WAV file from mono Float32 samples with pan applied.
  // Used for export mixdown temp files (ffmpeg still handles the final mix).
  async writeStereoWav(filePath: string, samples: Float32Array, sampleRate: number, pan: number = 0): Promise<void> {
    const leftGain = Math.cos(((pan + 1) / 2) * (Math.PI / 2))
    const rightGain = Math.sin(((pan + 1) / 2) * (Math.PI / 2))

    const numChannels = 2
    const bitsPerSample = 16
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
    const blockAlign = numChannels * (bitsPerSample / 8)

    const pcmData = Buffer.alloc(samples.length * numChannels * BYTES_PER_SAMPLE)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      const left = Math.round(s * leftGain * 32767)
      const right = Math.round(s * rightGain * 32767)
      pcmData.writeInt16LE(Math.max(-32768, Math.min(32767, left)), i * 4)
      pcmData.writeInt16LE(Math.max(-32768, Math.min(32767, right)), i * 4 + 2)
    }

    const dataSize = pcmData.length
    const header = Buffer.alloc(44)
    header.write("RIFF", 0)
    header.writeUInt32LE(36 + dataSize, 4)
    header.write("WAVE", 8)
    header.write("fmt ", 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(numChannels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    header.write("data", 36)
    header.writeUInt32LE(dataSize, 40)

    const wavBuffer = Buffer.concat([header, pcmData])
    await Bun.write(filePath, wavBuffer)
  }

  // Parse a WAV file — handles JUNK/LIST/other chunks before fmt,
  // stereo files (downmixed to mono), 16-bit and 32-bit float formats.
  parseWav(buf: Buffer): { samples: Float32Array; sampleRate: number } | null {
    if (buf.toString("ascii", 0, 4) !== "RIFF") return null
    if (buf.toString("ascii", 8, 12) !== "WAVE") return null

    // Scan for fmt and data chunks (don't assume fixed offsets — files
    // may have JUNK, LIST, bext, or other chunks before fmt)
    let sampleRate = 0
    let numChannels = 1
    let bitsPerSample = 16
    let fmtFound = false
    let dataBuf: Buffer | null = null

    let offset = 12
    while (offset < buf.length - 8) {
      const chunkId = buf.toString("ascii", offset, offset + 4)
      const chunkSize = buf.readUInt32LE(offset + 4)

      if (chunkId === "fmt ") {
        numChannels = buf.readUInt16LE(offset + 10)
        sampleRate = buf.readUInt32LE(offset + 12)
        bitsPerSample = buf.readUInt16LE(offset + 22)
        fmtFound = true
      } else if (chunkId === "data") {
        const dataStart = offset + 8
        const dataEnd = Math.min(dataStart + chunkSize, buf.length)
        dataBuf = buf.subarray(dataStart, dataEnd)
      }

      offset += 8 + chunkSize
      if (chunkSize % 2 !== 0) offset++ // RIFF chunks are 2-byte aligned
    }

    if (!fmtFound || !dataBuf || sampleRate === 0) return null

    // Decode PCM data
    let rawSamples: Float32Array

    if (bitsPerSample === 16) {
      rawSamples = this.pcmS16ToFloat32(dataBuf)
    } else if (bitsPerSample === 32) {
      rawSamples = new Float32Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.length / 4)
      rawSamples = new Float32Array(rawSamples) // copy to own buffer
    } else if (bitsPerSample === 24) {
      // 24-bit signed PCM
      const numSamples = Math.floor(dataBuf.length / 3)
      rawSamples = new Float32Array(numSamples)
      for (let i = 0; i < numSamples; i++) {
        const b0 = dataBuf[i * 3]
        const b1 = dataBuf[i * 3 + 1]
        const b2 = dataBuf[i * 3 + 2]
        // Sign-extend from 24-bit
        let sample = (b0 | (b1 << 8) | (b2 << 16))
        if (sample & 0x800000) sample |= ~0xFFFFFF // sign extend
        rawSamples[i] = sample / 8388608 // 2^23
      }
    } else {
      return null // unsupported format
    }

    // Downmix to mono if stereo (or more channels)
    if (numChannels > 1) {
      const monoLen = Math.floor(rawSamples.length / numChannels)
      const mono = new Float32Array(monoLen)
      for (let i = 0; i < monoLen; i++) {
        let sum = 0
        for (let ch = 0; ch < numChannels; ch++) {
          sum += rawSamples[i * numChannels + ch]
        }
        mono[i] = sum / numChannels
      }
      return { samples: mono, sampleRate }
    }

    return { samples: rawSamples, sampleRate }
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

  async exportMixdown(state: ProjectState, outputPath: string): Promise<boolean> {
    const tracksToMix: { track: Track; tempPath: string }[] = []
    const hasSolo = state.tracks.some((t) => t.solo)
    const speed = state.bpm / state.originalBpm

    for (const track of state.tracks) {
      if (!track.samples || track.samples.length === 0) continue
      if (track.muted) continue
      if (hasSolo && !track.solo) continue

      // Apply WSOLA time-stretch when speed != 1.0 so the exported audio
      // plays at the adjusted BPM while preserving pitch
      const exportSamples = (Math.abs(speed - 1.0) > 0.001)
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
          const stretched = (Math.abs(speed - 1.0) > 0.001)
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
          id: "__click__",
          name: "Click",
          color: "#e0af68",
          muted: false,
          solo: false,
          armed: false,
          volume: state.clickVolume,
          pan: state.clickPan,
          samples: clickSamples,
          sampleRate: state.sampleRate,
          filePath: null,
          inputDeviceId: null,
        },
        tempPath: clickTempPath,
      })
    }

    if (tracksToMix.length === 0) return false

    const cmd: string[] = ["ffmpeg", "-y"]
    for (const { tempPath } of tracksToMix) {
      cmd.push("-i", tempPath)
    }

    if (tracksToMix.length === 1) {
      const vol = tracksToMix[0].track.volume
      const pan = tracksToMix[0].track.pan
      const leftGain = Math.cos(((pan + 1) / 2) * (Math.PI / 2))
      const rightGain = Math.sin(((pan + 1) / 2) * (Math.PI / 2))
      cmd.push(
        "-filter_complex",
        `[0:a]volume=${vol},pan=stereo|c0=${leftGain.toFixed(4)}*c0|c1=${rightGain.toFixed(4)}*c0,aformat=sample_rates=${state.sampleRate}[out]`,
        "-map", "[out]",
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
        filters.push(`[${i}:a]volume=${vol},pan=stereo|c0=${leftGain.toFixed(4)}*c0|c1=${rightGain.toFixed(4)}*c0[${label}]`)
        mixInputs.push(`[${label}]`)
      }

      filters.push(
        `${mixInputs.join("")}amix=inputs=${tracksToMix.length}:duration=longest:normalize=0,aformat=sample_rates=${state.sampleRate}[out]`,
      )

      cmd.push("-filter_complex", filters.join(";"), "-map", "[out]")
    }

    cmd.push("-c:a", "pcm_s16le", outputPath)

    try {
      const proc = spawn({ cmd, stdout: "pipe", stderr: "pipe" })
      await proc.exited

      for (const { tempPath } of tracksToMix) {
        try { rmSync(tempPath) } catch {}
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
          const safeName = track.id.replace(/[^a-zA-Z0-9_-]/g, "_")
          wavFile = `tracks/${safeName}.wav`
          await this.writeWav(`${tmpDir}/${wavFile}`, track.samples, track.sampleRate)
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
          wavFile,
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
        tracks: trackDescs,
      }

      await Bun.write(
        `${tmpDir}/project.json`,
        JSON.stringify(descriptor, null, 2),
      )

      const proc = spawn({
        cmd: ["tar", "czf", outputPath, "-C", tmpDir, "."],
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited

      rmSync(tmpDir, { recursive: true, force: true })

      return proc.exitCode === 0
    } catch {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
      return false
    }
  }

  // ── Open Project ───────────────────────────────────────────────────────

  async openProject(filePath: string): Promise<ProjectState | null> {
    const tmpDir = `/tmp/tuidaw_open_${Date.now()}`

    try {
      mkdirSync(tmpDir, { recursive: true })

      const proc = spawn({
        cmd: ["tar", "xzf", filePath, "-C", tmpDir],
        stdout: "pipe",
        stderr: "pipe",
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
            const wavBuf = Buffer.from(await Bun.file(wavPath).arrayBuffer())
            const parsed = this.parseWav(wavBuf)
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
          volume: td.volume,
          pan: td.pan,
          samples,
          sampleRate: td.sampleRate,
          filePath: null,
          inputDeviceId: td.inputDeviceId,
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
        transportState: "stopped",
        playheadPosition: desc.playheadPosition,
        scrollOffset: desc.scrollOffset,
        freeScroll: false,
        loopStart: desc.loopStart,
        loopEnd: desc.loopEnd,
        projectName: desc.projectName,
        outputDeviceId: desc.outputDeviceId,
        availableInputDevices: [],
        availableOutputDevices: [],
      }
    } catch {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
      return null
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  destroy(): void {
    lib.symbols.tuidaw_deinit()
  }
}
