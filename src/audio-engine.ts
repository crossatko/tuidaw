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
  tuidaw_set_loop:             { returns: FFIType.void, args: [FFIType.i64, FFIType.i64] },
  tuidaw_start_recording:      { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_stop_recording:       { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_get_recording_buffer: { returns: FFIType.ptr, args: [FFIType.i32] },
  tuidaw_get_recording_length: { returns: FFIType.i32, args: [FFIType.i32] },
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
    const nameBuf = new Uint8Array(256)
    const namePtr = ptr(nameBuf)

    // Enumerate capture (input) devices
    const inputCount = lib.symbols.tuidaw_get_device_count(1)
    for (let i = 0; i < inputCount; i++) {
      lib.symbols.tuidaw_get_device_name(1, i, namePtr, 256)
      const name = new TextDecoder().decode(nameBuf.subarray(0, nameBuf.indexOf(0)))
      const isDefault = lib.symbols.tuidaw_is_device_default(1, i) !== 0
      inputs.push({
        id: i,
        name,
        description: name,
        type: "input",
        isDefault,
      })
    }

    // Enumerate playback (output) devices
    const outputCount = lib.symbols.tuidaw_get_device_count(0)
    for (let i = 0; i < outputCount; i++) {
      lib.symbols.tuidaw_get_device_name(0, i, namePtr, 256)
      const name = new TextDecoder().decode(nameBuf.subarray(0, nameBuf.indexOf(0)))
      const isDefault = lib.symbols.tuidaw_is_device_default(0, i) !== 0
      outputs.push({
        id: i,
        name,
        description: name,
        type: "output",
        isDefault,
      })
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

    // Set click state
    lib.symbols.tuidaw_set_click(state.clickEnabled ? 1 : 0, state.bpm)

    // Set loop state
    if (state.loopStart !== null && state.loopEnd !== null) {
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
    lib.symbols.tuidaw_set_click(1, bpm)
  }

  stopClick(): void {
    lib.symbols.tuidaw_set_click(0, 0)
  }

  // Click WAV helpers — no longer needed (click is generated in native callback)
  async prepareClickWav(_bpm: number, _startSample?: number): Promise<string> {
    return ""
  }
  spawnClickPlayer(_wavPath: string, _targetDeviceId?: number | null): void {}

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

  async loadWavFile(filePath: string): Promise<{ samples: Float32Array; sampleRate: number } | null> {
    try {
      const file = Bun.file(filePath)
      const buf = Buffer.from(await file.arrayBuffer())
      const result = this.parseWav(buf)
      if (!result) return null

      // Resample to project sample rate if needed (linear interpolation)
      if (result.sampleRate !== SAMPLE_RATE) {
        result.samples = this.resample(result.samples, result.sampleRate, SAMPLE_RATE)
        result.sampleRate = SAMPLE_RATE
      }

      return result
    } catch {
      return null
    }
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

  // ── Export Mixdown ─────────────────────────────────────────────────────
  // Still uses ffmpeg for the final mix (non-realtime, not performance-critical)

  async exportMixdown(state: ProjectState, outputPath: string): Promise<boolean> {
    const tracksToMix: { track: Track; tempPath: string }[] = []
    const hasSolo = state.tracks.some((t) => t.solo)

    for (const track of state.tracks) {
      if (!track.samples || track.samples.length === 0) continue
      if (track.muted) continue
      if (hasSolo && !track.solo) continue

      const tempPath = `/tmp/tuidaw_mix_${track.id}.wav`
      await this.writeWav(tempPath, track.samples, track.sampleRate)
      tracksToMix.push({ track, tempPath })
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
        clickEnabled: state.clickEnabled,
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
        clickEnabled: desc.clickEnabled,
        sampleRate: desc.sampleRate,
        tracks,
        selectedTrackIndex: desc.selectedTrackIndex,
        transportState: "stopped",
        playheadPosition: desc.playheadPosition,
        scrollOffset: desc.scrollOffset,
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
