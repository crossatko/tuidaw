// ============================================================================
// tuidaw - Audio Engine (PipeWire-based)
// ============================================================================

import { spawn, type Subprocess } from "bun"
import { existsSync, mkdirSync, rmSync } from "fs"
import type { Track, ProjectState, PipeWireDevice, ProjectDescriptor, TrackDescriptor } from "./types"

const SAMPLE_RATE = 48000
const CHANNELS = 1
const FORMAT = "s16" // signed 16-bit
const BYTES_PER_SAMPLE = 2
const RECORDINGS_DIR = "./recordings"
const LATENCY = "256" // 256 samples @ 48kHz ≈ 5.3ms
const CLICK_DURATION_SEC = 300 // 5 minutes of pre-generated click track

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

export class AudioEngine {
  // Multi-track recording: one pw-record process per armed track
  private activeRecordings: Map<string, {
    process: Subprocess
    chunks: Buffer[]
    onChunk: (samples: Float32Array) => void
  }> = new Map()

  private playProcesses: Map<string, Subprocess> = new Map()
  private clickProcess: Subprocess | null = null
  private playStartTime: number = 0
  private isPlaying: boolean = false

  constructor() {
    if (!existsSync(RECORDINGS_DIR)) {
      mkdirSync(RECORDINGS_DIR, { recursive: true })
    }
  }

  // ── Device Enumeration ─────────────────────────────────────────────────
  // Query PipeWire for available audio sources and sinks using pw-dump (JSON)
  async enumerateDevices(): Promise<{ inputs: PipeWireDevice[]; outputs: PipeWireDevice[] }> {
    const inputs: PipeWireDevice[] = []
    const outputs: PipeWireDevice[] = []

    try {
      const proc = spawn({
        cmd: ["pw-dump"],
        stdout: "pipe",
        stderr: "pipe",
      })

      const stdout = proc.stdout
      if (typeof stdout === "number") return { inputs, outputs }

      const reader = (stdout as ReadableStream<Uint8Array>).getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }

      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0)
      const combined = new Uint8Array(totalLen)
      let offset = 0
      for (const c of chunks) {
        combined.set(c, offset)
        offset += c.length
      }

      const json = new TextDecoder().decode(combined)
      const objects = JSON.parse(json) as Array<{
        id: number
        info?: {
          props?: Record<string, string>
        }
      }>

      for (const obj of objects) {
        const props = obj.info?.props
        if (!props) continue
        const mediaClass = props["media.class"] || ""
        const nodeName = props["node.name"] || ""
        const nodeDesc = props["node.description"] || nodeName
        const nodeNick = props["node.nick"] || ""

        if (mediaClass === "Audio/Source") {
          inputs.push({
            id: obj.id,
            name: nodeName,
            description: nodeDesc || nodeNick || nodeName,
            mediaClass,
          })
        } else if (mediaClass === "Audio/Sink") {
          outputs.push({
            id: obj.id,
            name: nodeName,
            description: nodeDesc || nodeNick || nodeName,
            mediaClass,
          })
        }
      }
    } catch {
      // pw-dump not available or failed - return empty lists
    }

    return { inputs, outputs }
  }

  // Start recording on a single track (can be called multiple times for multi-track)
  async startRecording(
    trackId: string,
    onChunk: (samples: Float32Array) => void,
    targetDeviceId?: number | null,
  ): Promise<void> {
    // If this track is already recording, stop it first
    if (this.activeRecordings.has(trackId)) {
      await this.stopTrackRecording(trackId)
    }

    const cmd = [
      "pw-record",
      "--format", FORMAT,
      "--rate", String(SAMPLE_RATE),
      "--channels", String(CHANNELS),
      "--latency", LATENCY,
    ]

    if (targetDeviceId != null) {
      cmd.push("--target", String(targetDeviceId))
    }

    cmd.push("-")

    const proc = spawn({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
    })

    const recording = {
      process: proc,
      chunks: [] as Buffer[],
      onChunk,
    }

    this.activeRecordings.set(trackId, recording)

    // Read audio data in chunks from stdout
    this.readRecordingStream(trackId, recording)
  }

  private async readRecordingStream(
    trackId: string,
    recording: {
      process: Subprocess
      chunks: Buffer[]
      onChunk: (samples: Float32Array) => void
    },
  ): Promise<void> {
    const stdout = recording.process.stdout
    if (!stdout || typeof stdout === "number") return

    const reader = (stdout as ReadableStream<Uint8Array>).getReader()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const buf = Buffer.from(value)
        recording.chunks.push(buf)

        // Convert s16 PCM to Float32
        const floatSamples = this.pcmS16ToFloat32(buf)
        recording.onChunk(floatSamples)
      }
    } catch {
      // stream closed
    }
  }

  // Stop recording on a single track and return its full buffer
  async stopTrackRecording(trackId: string): Promise<Float32Array | null> {
    const recording = this.activeRecordings.get(trackId)
    if (!recording) return null

    recording.process.kill("SIGINT")
    await new Promise((r) => setTimeout(r, 200))
    this.activeRecordings.delete(trackId)

    if (recording.chunks.length === 0) return null

    const totalBuf = Buffer.concat(recording.chunks)
    return this.pcmS16ToFloat32(totalBuf)
  }

  // Stop ALL active recordings and return map of trackId -> samples
  async stopAllRecordings(): Promise<Map<string, Float32Array>> {
    const results = new Map<string, Float32Array>()

    const trackIds = [...this.activeRecordings.keys()]
    for (const trackId of trackIds) {
      const samples = await this.stopTrackRecording(trackId)
      if (samples) {
        results.set(trackId, samples)
      }
    }

    return results
  }

  // Check if any recording is currently active
  get isRecording(): boolean {
    return this.activeRecordings.size > 0
  }

  // Prepare a track's temp WAV file for playback (write to disk).
  // Writes a stereo WAV with pan baked in (equal-power panning law).
  // Returns the temp path, or null if the track has nothing to play.
  async prepareTrackWav(
    track: Track,
    startSample: number = 0,
  ): Promise<string | null> {
    if (!track.samples || track.muted) return null
    const tempPath = `/tmp/tuidaw_play_${track.id}.wav`
    const offsetSamples = track.samples.subarray(startSample)
    if (offsetSamples.length === 0) return null
    await this.writeStereoWav(tempPath, offsetSamples, track.sampleRate, track.pan)
    return tempPath
  }

  // Spawn pw-play for an already-prepared WAV file.
  // This is deliberately sync (no awaits) so multiple spawns happen back-to-back.
  spawnTrackPlayer(
    trackId: string,
    wavPath: string,
    targetDeviceId?: number | null,
    volume: number = 1,
  ): void {
    const cmd = [
      "pw-play",
      "--latency", LATENCY,
      "--volume", String(Math.max(0, Math.min(1, volume)).toFixed(3)),
    ]
    if (targetDeviceId != null) {
      cmd.push("--target", String(targetDeviceId))
    }
    cmd.push(wavPath)

    const proc = spawn({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
    })
    this.playProcesses.set(trackId, proc)
  }

  // Play a track's audio using pw-play (optionally targeting a specific sink).
  // Convenience wrapper: prepares WAV (with pan) + spawns player (with volume).
  async playTrack(
    track: Track,
    startSample: number = 0,
    targetDeviceId?: number | null,
  ): Promise<void> {
    const wavPath = await this.prepareTrackWav(track, startSample)
    if (!wavPath) return
    this.spawnTrackPlayer(track.id, wavPath, targetDeviceId, track.volume)
  }

  // Restart a single track's playback with updated volume/pan.
  // Kills the current pw-play, rewrites the WAV with new pan, respawns with new volume.
  async restartTrackPlayback(
    track: Track,
    currentSample: number,
    targetDeviceId?: number | null,
  ): Promise<void> {
    this.stopTrackPlayback(track.id)
    await this.playTrack(track, currentSample, targetDeviceId)
  }

  // Mark the engine as "playing" and record the wall-clock start time.
  // Called at the start of both playback and recording so that
  // getElapsedSamples() works in either mode.
  markTransportStart(): void {
    this.isPlaying = true
    this.playStartTime = Date.now()
  }

  // Play all non-muted tracks simultaneously.
  // Two-phase approach: first write all WAV files to disk (slow I/O),
  // then spawn all pw-play processes back-to-back (fast) so they start
  // at nearly the same instant.
  async playAll(state: ProjectState): Promise<void> {
    // Phase 1: prepare all WAV files in parallel
    const hasSolo = state.tracks.some((t) => t.solo)
    const preparations: { trackId: string; wavPath: string; volume: number }[] = []

    const prepPromises: Promise<void>[] = []
    for (const track of state.tracks) {
      if (track.muted || !track.samples || track.samples.length === 0) continue
      if (hasSolo && !track.solo) continue

      const trackVolume = track.volume
      prepPromises.push(
        this.prepareTrackWav(track, state.playheadPosition).then((path) => {
          if (path) preparations.push({ trackId: track.id, wavPath: path, volume: trackVolume })
        }),
      )
    }

    let clickWavPath: string | null = null
    if (state.clickEnabled) {
      prepPromises.push(
        this.prepareClickWav(state.bpm, state.playheadPosition).then((path) => {
          clickWavPath = path
        }),
      )
    }

    await Promise.all(prepPromises)

    // Phase 2: spawn all processes back-to-back (no awaits between spawns)
    this.markTransportStart()

    for (const { trackId, wavPath, volume } of preparations) {
      this.spawnTrackPlayer(trackId, wavPath, state.outputDeviceId, volume)
    }

    if (clickWavPath) {
      this.spawnClickPlayer(clickWavPath, state.outputDeviceId)
    }
  }

  // Stop playback for a single track (live mute)
  stopTrackPlayback(trackId: string): void {
    const proc = this.playProcesses.get(trackId)
    if (proc) {
      proc.kill("SIGINT")
      this.playProcesses.delete(trackId)
    }
  }

  // Check if a track's pw-play process is currently running
  isTrackPlaying(trackId: string): boolean {
    return this.playProcesses.has(trackId)
  }

  // Get the current playback position in samples (from playStartTime)
  // Used by live mute/solo/punch-in to know where in the timeline we are
  getCurrentPlaybackPosition(startPosition: number): number {
    return startPosition + this.getElapsedSamples()
  }

  // Stop all playback
  async stopAll(): Promise<void> {
    this.isPlaying = false

    for (const [id, proc] of this.playProcesses) {
      proc.kill("SIGINT")
    }
    this.playProcesses.clear()
    this.stopClick()
  }

  // Prepare the click track WAV file on disk.
  // Returns the file path.
  async prepareClickWav(bpm: number, startSample: number = 0): Promise<string> {
    const intervalSamples = Math.round((60 / bpm) * SAMPLE_RATE)
    const totalSamples = SAMPLE_RATE * CLICK_DURATION_SEC
    const clickSamples = new Float32Array(totalSamples)

    // Generate a short sine wave click at 1000Hz (20ms)
    const clickLen = Math.floor(SAMPLE_RATE * 0.02)

    // Calculate the offset into the first beat: how many samples until
    // the next beat boundary from the startSample position.
    const phase = startSample % intervalSamples
    const firstClickOffset = phase === 0 ? 0 : intervalSamples - phase

    for (let pos = firstClickOffset; pos < totalSamples; pos += intervalSamples) {
      for (let i = 0; i < clickLen && pos + i < totalSamples; i++) {
        const t = i / SAMPLE_RATE
        const envelope = 1.0 - i / clickLen
        clickSamples[pos + i] = Math.sin(2 * Math.PI * 1000 * t) * envelope * 0.5
      }
    }

    const clickPath = "/tmp/tuidaw_click.wav"
    await this.writeWav(clickPath, clickSamples, SAMPLE_RATE)
    return clickPath
  }

  // Spawn the click player for an already-prepared WAV file.
  spawnClickPlayer(wavPath: string, targetDeviceId?: number | null): void {
    const cmd = [
      "pw-play",
      "--latency", LATENCY,
    ]
    if (targetDeviceId != null) {
      cmd.push("--target", String(targetDeviceId))
    }
    cmd.push(wavPath)

    this.clickProcess = spawn({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
    })
  }

  // Generate and play a metronome click as a single continuous audio stream.
  // Pre-renders all clicks into one WAV file to avoid per-beat process spawning
  // and setInterval jitter. This gives sample-accurate click timing.
  // startSample: the playhead position where playback begins — the click track
  // is phase-aligned so clicks land on beat boundaries relative to sample 0.
  async startClick(bpm: number, startSample: number = 0, targetDeviceId?: number | null): Promise<void> {
    // Stop any existing click first
    this.stopClick()

    const wavPath = await this.prepareClickWav(bpm, startSample)
    this.spawnClickPlayer(wavPath, targetDeviceId)
  }

  stopClick(): void {
    if (this.clickProcess) {
      this.clickProcess.kill("SIGINT")
      this.clickProcess = null
    }
  }

  // Get elapsed samples since play started
  getElapsedSamples(): number {
    if (!this.isPlaying) return 0
    const elapsedMs = Date.now() - this.playStartTime
    return Math.floor((elapsedMs / 1000) * SAMPLE_RATE)
  }

  // Save track samples to WAV file
  async saveTrackToFile(track: Track): Promise<string | null> {
    if (!track.samples) return null
    const filePath = `${RECORDINGS_DIR}/${track.name.replace(/\s+/g, "_")}_${Date.now()}.wav`
    await this.writeWav(filePath, track.samples, track.sampleRate)
    track.filePath = filePath
    return filePath
  }

  // Load a WAV file into a track
  async loadWavFile(filePath: string): Promise<{ samples: Float32Array; sampleRate: number } | null> {
    try {
      const file = Bun.file(filePath)
      const buf = Buffer.from(await file.arrayBuffer())
      return this.parseWav(buf)
    } catch {
      return null
    }
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

  // Write a WAV file from Float32 samples (mono, s16)
  async writeWav(filePath: string, samples: Float32Array, sampleRate: number): Promise<void> {
    const pcmData = this.float32ToPcmS16(samples)
    const numChannels = CHANNELS
    const bitsPerSample = 16
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
    const blockAlign = numChannels * (bitsPerSample / 8)
    const dataSize = pcmData.length

    const header = Buffer.alloc(44)
    // RIFF header
    header.write("RIFF", 0)
    header.writeUInt32LE(36 + dataSize, 4)
    header.write("WAVE", 8)
    // fmt chunk
    header.write("fmt ", 12)
    header.writeUInt32LE(16, 16) // chunk size
    header.writeUInt16LE(1, 20) // PCM format
    header.writeUInt16LE(numChannels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    // data chunk
    header.write("data", 36)
    header.writeUInt32LE(dataSize, 40)

    const wavBuffer = Buffer.concat([header, pcmData])
    await Bun.write(filePath, wavBuffer)
  }

  // Write a stereo WAV file from mono Float32 samples with pan applied.
  // Uses equal-power panning law: pan=-1 → full left, pan=0 → center, pan=1 → full right
  async writeStereoWav(filePath: string, samples: Float32Array, sampleRate: number, pan: number = 0): Promise<void> {
    const leftGain = Math.cos(((pan + 1) / 2) * (Math.PI / 2))
    const rightGain = Math.sin(((pan + 1) / 2) * (Math.PI / 2))

    const numChannels = 2
    const bitsPerSample = 16
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
    const blockAlign = numChannels * (bitsPerSample / 8)

    // Interleave stereo samples: L, R, L, R, ...
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
    header.writeUInt16LE(1, 20) // PCM format
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

  // Parse a WAV file
  parseWav(buf: Buffer): { samples: Float32Array; sampleRate: number } | null {
    if (buf.toString("ascii", 0, 4) !== "RIFF") return null
    if (buf.toString("ascii", 8, 12) !== "WAVE") return null

    const sampleRate = buf.readUInt32LE(24)
    const bitsPerSample = buf.readUInt16LE(34)

    // Find data chunk
    let offset = 12
    while (offset < buf.length - 8) {
      const chunkId = buf.toString("ascii", offset, offset + 4)
      const chunkSize = buf.readUInt32LE(offset + 4)
      if (chunkId === "data") {
        const dataStart = offset + 8
        const dataEnd = dataStart + chunkSize
        const dataBuf = buf.subarray(dataStart, dataEnd)

        if (bitsPerSample === 16) {
          return { samples: this.pcmS16ToFloat32(dataBuf), sampleRate }
        }
        // 32-bit float
        if (bitsPerSample === 32) {
          const float32 = new Float32Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.length / 4)
          return { samples: new Float32Array(float32), sampleRate }
        }
        return null
      }
      offset += 8 + chunkSize
      if (chunkSize % 2 !== 0) offset++ // padding byte
    }
    return null
  }

  // ── Export Mixdown ─────────────────────────────────────────────────────
  // Mix all non-muted tracks (respecting solo/volume) into a single stereo
  // WAV file using ffmpeg. Each track is written to a temp WAV, then ffmpeg
  // amerge + pan filters produce the final file.
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

    // Build ffmpeg command with amix filter
    // Each input gets a volume filter, then they're all mixed together
    const cmd: string[] = ["ffmpeg", "-y"]

    for (const { tempPath } of tracksToMix) {
      cmd.push("-i", tempPath)
    }

    if (tracksToMix.length === 1) {
      // Single track — apply volume and pan, convert to stereo
      const vol = tracksToMix[0].track.volume
      const pan = tracksToMix[0].track.pan
      // Pan law: equal-power panning
      // pan=-1 → full left, pan=0 → center, pan=1 → full right
      const leftGain = Math.cos(((pan + 1) / 2) * (Math.PI / 2))
      const rightGain = Math.sin(((pan + 1) / 2) * (Math.PI / 2))
      cmd.push(
        "-filter_complex",
        `[0:a]volume=${vol},pan=stereo|c0=${leftGain.toFixed(4)}*c0|c1=${rightGain.toFixed(4)}*c0,aformat=sample_rates=${state.sampleRate}[out]`,
        "-map", "[out]",
      )
    } else {
      // Multiple tracks — volume + pan per input, then amix
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

      // Clean up temp files
      for (const { tempPath } of tracksToMix) {
        try { rmSync(tempPath) } catch {}
      }

      return proc.exitCode === 0
    } catch {
      return false
    }
  }

  // ── Save Project ───────────────────────────────────────────────────────
  // Creates a .tuidaw file (gzipped tarball) containing:
  //   project.json   — descriptor with track metadata, BPM, etc.
  //   tracks/*.wav    — individual track audio files
  async saveProject(state: ProjectState, outputPath: string): Promise<boolean> {
    const tmpDir = `/tmp/tuidaw_project_${Date.now()}`
    const tracksDir = `${tmpDir}/tracks`

    try {
      mkdirSync(tracksDir, { recursive: true })

      // Build descriptor and write track WAVs
      const trackDescs: TrackDescriptor[] = []

      for (const track of state.tracks) {
        let wavFile: string | null = null

        if (track.samples && track.samples.length > 0) {
          // Sanitize name for filesystem
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

      // Create gzipped tarball
      const proc = spawn({
        cmd: ["tar", "czf", outputPath, "-C", tmpDir, "."],
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited

      // Cleanup temp dir
      rmSync(tmpDir, { recursive: true, force: true })

      return proc.exitCode === 0
    } catch {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
      return false
    }
  }

  // ── Open Project ───────────────────────────────────────────────────────
  // Extracts a .tuidaw tarball and restores the full project state.
  // Returns the new ProjectState, or null on failure.
  async openProject(filePath: string): Promise<ProjectState | null> {
    const tmpDir = `/tmp/tuidaw_open_${Date.now()}`

    try {
      mkdirSync(tmpDir, { recursive: true })

      // Extract tarball
      const proc = spawn({
        cmd: ["tar", "xzf", filePath, "-C", tmpDir],
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited
      if (proc.exitCode !== 0) return null

      // Read descriptor
      const descFile = Bun.file(`${tmpDir}/project.json`)
      const descJson = await descFile.text()
      const desc = JSON.parse(descJson) as ProjectDescriptor

      // Rebuild tracks with audio
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

      // Cleanup temp dir
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
}
