// ============================================================================
// tuidaw Web Audio Bridge — TypeScript wrapper around WASM tuidaw_* exports
// ============================================================================
// This module loads the Emscripten-compiled WASM module and provides a
// typed interface matching the native AudioEngine API.

/** The Emscripten Module type for our WASM build */
interface TuidawWasmModule {
  _tuidaw_init(): number
  _tuidaw_init_null(): number
  _tuidaw_deinit(): void
  _tuidaw_refresh_devices(): void
  _tuidaw_get_device_count(type: number): number
  _tuidaw_get_device_name(type: number, index: number): number // returns char*
  _tuidaw_is_device_default(type: number, index: number): number
  _tuidaw_set_output_device(index: number): void
  _tuidaw_get_active_device_index(): number
  _tuidaw_start_playback_device(): number
  _tuidaw_stop_playback_device(): void
  _tuidaw_add_track(id: number): void
  _tuidaw_remove_track(id: number): void
  _tuidaw_set_track_samples(id: number, ptr: number, len: number): void
  _tuidaw_set_track_volume(id: number, volume: number): void
  _tuidaw_set_track_gain(id: number, gain: number): void
  _tuidaw_set_track_pan(id: number, pan: number): void
  _tuidaw_set_track_muted(id: number, muted: number): void
  _tuidaw_set_track_solo(id: number, solo: number): void
  _tuidaw_set_track_input_device(id: number, deviceIndex: number): void
  _tuidaw_play(position: number): void
  _tuidaw_stop(): void
  _tuidaw_get_playhead(): number
  _tuidaw_set_playhead(position: number): void
  _tuidaw_set_click(enabled: number, bpm: number): void
  _tuidaw_generate_click(bpm: number, durationFrames: number): number
  _tuidaw_set_click_samples(ptr: number, len: number): void
  _tuidaw_set_click_volume(volume: number): void
  _tuidaw_set_click_pan(pan: number): void
  _tuidaw_set_loop(start: number, end: number): void
  _tuidaw_start_recording(id: number): void
  _tuidaw_stop_recording(id: number): void
  _tuidaw_get_recording_buffer(id: number): number // returns float*
  _tuidaw_get_recording_length(id: number): number
  _tuidaw_set_speed(speed: number): void
  _tuidaw_get_speed(): number
  _tuidaw_render(outputPtr: number, frameCount: number): void
  _malloc(size: number): number
  _free(ptr: number): void

  // Emscripten runtime methods
  UTF8ToString(ptr: number): string
  stringToUTF8(str: string, outPtr: number, maxBytes: number): void
  setValue(ptr: number, value: number, type: string): void
  getValue(ptr: number, type: string): number
  HEAPF32: Float32Array
  HEAP32: Int32Array
}

// Global factory function injected by Emscripten glue
declare function TuidawAudio(config?: object): Promise<TuidawWasmModule>

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) {
    const t = b
    b = a % b
    a = t
  }
  return a
}

export interface WebAudioDevice {
  id: string
  description: string
  isDefault: boolean
}

/** Input device info with channel count */
export interface InputDeviceInfo {
  deviceId: string
  label: string
  channelCount: number // discovered after opening the device; 0 = unknown
}

export class WebAudioBridge {
  private module: TuidawWasmModule | null = null
  private trackIdMap: Map<string, number> = new Map()
  private nextTrackId = 1
  private allocatedBuffers: Map<number, number> = new Map() // trackNativeId -> wasmPtr
  private clickBufferPtr: number = 0 // WASM pointer for click buffer
  private clickBufferLen: number = 0 // current click buffer length

  /** Initialize the WASM audio engine. Call once before any other method. */
  async init(): Promise<void> {
    // Load the Emscripten JS glue which defines the TuidawAudio factory
    if (!(window as any).TuidawAudio) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = '/wasm/tuidaw_audio.js'
        script.onload = () => resolve()
        script.onerror = () =>
          reject(new Error('Failed to load WASM glue script'))
        document.head.appendChild(script)
      })
    }
    const mod = await (window as any).TuidawAudio({
      locateFile: (path: string) => `/wasm/${path}`
    })
    this.module = mod

    // Initialize miniaudio engine (uses Web Audio / AudioWorklet backend)
    // With ASYNCIFY, _tuidaw_init may return a Promise (AudioWorklet init calls emscripten_sleep)
    const result = await mod._tuidaw_init()
    if (result !== 0) {
      throw new Error(`tuidaw_init failed with code ${result}`)
    }

    // Start the playback device (may also be async with AudioWorklet)
    await mod._tuidaw_start_playback_device()
  }

  get isReady(): boolean {
    return this.module !== null
  }

  private get m(): TuidawWasmModule {
    if (!this.module) throw new Error('WebAudioBridge not initialized')
    return this.module
  }

  // ── Track management ──────────────────────────────────────────────────

  addTrack(trackId: string): number {
    const nativeId = this.nextTrackId++
    this.trackIdMap.set(trackId, nativeId)
    this.m._tuidaw_add_track(nativeId)
    return nativeId
  }

  removeTrack(trackId: string): void {
    const nativeId = this.trackIdMap.get(trackId)
    if (nativeId === undefined) return
    this.m._tuidaw_remove_track(nativeId)
    this.trackIdMap.delete(trackId)
    // Free any allocated buffer
    const ptr = this.allocatedBuffers.get(nativeId)
    if (ptr) {
      this.m._free(ptr)
      this.allocatedBuffers.delete(nativeId)
    }
  }

  /** Upload Float32Array samples into WASM memory and set on native track */
  setTrackSamples(trackId: string, samples: Float32Array | null): void {
    const nativeId = this.trackIdMap.get(trackId)
    if (nativeId === undefined) return

    // Free previous buffer
    const oldPtr = this.allocatedBuffers.get(nativeId)
    if (oldPtr) {
      this.m._free(oldPtr)
      this.allocatedBuffers.delete(nativeId)
    }

    if (!samples || samples.length === 0) {
      this.m._tuidaw_set_track_samples(nativeId, 0, 0)
      return
    }

    // Allocate WASM memory and copy samples
    const byteLen = samples.length * 4
    const ptr = this.m._malloc(byteLen)
    if (!ptr) throw new Error('WASM malloc failed')
    this.m.HEAPF32.set(samples, ptr / 4)
    this.m._tuidaw_set_track_samples(nativeId, ptr, samples.length)
    this.allocatedBuffers.set(nativeId, ptr)
  }

  setTrackVolume(trackId: string, volume: number): void {
    const nativeId = this.trackIdMap.get(trackId)
    if (nativeId !== undefined)
      this.m._tuidaw_set_track_volume(nativeId, volume)
  }

  setTrackGain(trackId: string, gain: number): void {
    const nativeId = this.trackIdMap.get(trackId)
    if (nativeId !== undefined && this.m._tuidaw_set_track_gain)
      this.m._tuidaw_set_track_gain(nativeId, Math.max(0, Math.min(4, gain)))
  }

  setTrackPan(trackId: string, pan: number): void {
    const nativeId = this.trackIdMap.get(trackId)
    if (nativeId !== undefined) this.m._tuidaw_set_track_pan(nativeId, pan)
  }

  setTrackMuted(trackId: string, muted: boolean): void {
    const nativeId = this.trackIdMap.get(trackId)
    if (nativeId !== undefined)
      this.m._tuidaw_set_track_muted(nativeId, muted ? 1 : 0)
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    const nativeId = this.trackIdMap.get(trackId)
    if (nativeId !== undefined)
      this.m._tuidaw_set_track_solo(nativeId, solo ? 1 : 0)
  }

  // ── Transport ─────────────────────────────────────────────────────────

  play(position: number): void {
    this.m._tuidaw_play(position)
  }

  stop(): void {
    this.m._tuidaw_stop()
  }

  getPlayhead(): number {
    return this.m._tuidaw_get_playhead()
  }

  setPlayhead(position: number): void {
    this.m._tuidaw_set_playhead(position)
  }

  // ── Click / Metronome ─────────────────────────────────────────────────

  setClick(enabled: boolean, bpm: number): void {
    this.m._tuidaw_set_click(enabled ? 1 : 0, bpm)
  }

  /** Generate click buffer in JS and upload to WASM via set_click_samples.
   *  Avoids C realloc which causes OOB crashes in WASM with large buffers.
   *  Uses the same GCD-exact beat positioning algorithm as the native C version. */
  generateClick(bpm: number, durationFrames: number): boolean {
    if (bpm <= 0 || durationFrames <= 0) return false

    try {
      // Generate click buffer in JS
      const buffer = new Float32Array(durationFrames)

      // Click tone: 960 samples of 1kHz sine + 20ms linear decay (matches native engine)
      const SAMPLE_RATE = 48000
      const toneLen = Math.round(SAMPLE_RATE * 0.02) // 960 samples

      // GCD-exact beat position math (same algorithm as C tuidaw_generate_click)
      const bpmScaled = Math.round(bpm * 100)
      const totalPerMinute = SAMPLE_RATE * 60
      const totalScaled = totalPerMinute * 100
      const d = gcd(bpmScaled, totalScaled)
      const N = bpmScaled / d
      const samplesPerN = Math.round((N * totalPerMinute * 100) / bpmScaled)

      for (let beat = 0; ; beat++) {
        const group = Math.floor(beat / N)
        const local = beat % N
        const beatStart =
          group * samplesPerN + Math.floor((local * samplesPerN) / N)

        if (beatStart >= durationFrames) break

        for (let i = 0; i < toneLen && beatStart + i < durationFrames; i++) {
          const t = i / SAMPLE_RATE
          const envelope = 1.0 - i / toneLen
          buffer[beatStart + i] = Math.sin(2 * Math.PI * 1000 * t) * envelope
        }
      }

      // Free previous click buffer in WASM
      if (this.clickBufferPtr) {
        this.m._free(this.clickBufferPtr)
        this.clickBufferPtr = 0
        this.clickBufferLen = 0
      }

      // Allocate in WASM heap and copy
      const byteLen = durationFrames * 4
      const ptr = this.m._malloc(byteLen)
      if (!ptr) {
        console.error('generateClick: WASM malloc failed for', byteLen, 'bytes')
        return false
      }

      this.m.HEAPF32.set(buffer, ptr / 4)
      this.m._tuidaw_set_click_samples(ptr, durationFrames)
      this.clickBufferPtr = ptr
      this.clickBufferLen = durationFrames
      return true
    } catch (e) {
      console.error(
        'generateClick failed:',
        e,
        `(bpm=${bpm}, frames=${durationFrames})`
      )
      return false
    }
  }

  setClickVolume(volume: number): void {
    this.m._tuidaw_set_click_volume(volume)
  }

  setClickPan(pan: number): void {
    this.m._tuidaw_set_click_pan(pan)
  }

  // ── Loop ──────────────────────────────────────────────────────────────

  setLoop(start: number | null, end: number | null): void {
    if (start === null || end === null) {
      this.m._tuidaw_set_loop(-1, -1)
    } else {
      this.m._tuidaw_set_loop(start, end)
    }
  }

  // ── Speed / WSOLA ─────────────────────────────────────────────────────

  setSpeed(speed: number): void {
    this.m._tuidaw_set_speed(speed)
  }

  getSpeed(): number {
    return this.m._tuidaw_get_speed()
  }

  // ── Offline Render ────────────────────────────────────────────────────

  /** Render `frameCount` frames of audio offline into an interleaved stereo
   *  Float32Array (L R L R...). The native playback callback is called directly,
   *  bypassing the audio device. Set up transport state (playhead, speed, click,
   *  loop) before calling. Returns a Float32Array of length frameCount * 2. */
  render(frameCount: number): Float32Array {
    const byteLen = frameCount * 2 * 4 // stereo, 4 bytes per float
    const ptr = this.m._malloc(byteLen)
    if (!ptr) throw new Error('WASM malloc failed for render buffer')

    try {
      // Zero the buffer before render (native callback does this too, but be safe)
      const floatOffset = ptr / 4
      this.m.HEAPF32.fill(0, floatOffset, floatOffset + frameCount * 2)

      this.m._tuidaw_render(ptr, frameCount)

      // Copy out before freeing
      const result = new Float32Array(frameCount * 2)
      result.set(
        this.m.HEAPF32.subarray(floatOffset, floatOffset + frameCount * 2)
      )
      return result
    } finally {
      this.m._free(ptr)
    }
  }

  // ── Recording (getUserMedia + ChannelSplitter + ScriptProcessorNode) ────
  // One shared MediaStream per unique input device. Each armed track selects
  // a specific channel (or mono mix) via ChannelSplitterNode routing.

  /** Per-device shared capture state */
  private deviceCaptures: Map<
    string,
    {
      stream: MediaStream
      ctx: AudioContext
      source: MediaStreamAudioSourceNode
      splitter: ChannelSplitterNode
      channelCount: number
      refCount: number // number of tracks using this device capture
    }
  > = new Map()

  /** Per-track recording state */
  private recTracks: Map<
    string,
    {
      deviceId: string
      processor: ScriptProcessorNode
      merger?: ChannelMergerNode // used for mono-mix mode
    }
  > = new Map()
  private recBuffers: Map<string, Float32Array[]> = new Map()
  private recLengths: Map<string, number> = new Map()

  /** Cached list of input devices */
  private _inputDevices: InputDeviceInfo[] = []
  private _deviceChangeListeners: (() => void)[] = []

  /** Enumerate available audio input devices. Returns device list.
   *  Call after requestMicAccess() for full labels. */
  async enumerateInputDevices(): Promise<InputDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    this._inputDevices = devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || `Mic ${d.deviceId.slice(0, 8)}`,
        channelCount: 0 // discovered when device is opened
      }))
    return this._inputDevices
  }

  /** Get cached input device list */
  get inputDevices(): InputDeviceInfo[] {
    return this._inputDevices
  }

  /** Register a callback for device list changes */
  onDeviceChange(cb: () => void): void {
    this._deviceChangeListeners.push(cb)
    if (this._deviceChangeListeners.length === 1) {
      navigator.mediaDevices.addEventListener('devicechange', async () => {
        await this.enumerateInputDevices()
        for (const listener of this._deviceChangeListeners) listener()
      })
    }
  }

  /** Request microphone access. Call early (on user gesture) to prime the permission.
   *  Returns true if permission was granted. */
  async requestMicAccess(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      })
      // Stop tracks immediately — we just wanted the permission
      for (const t of stream.getTracks()) t.stop()
      // Enumerate devices now that we have permission (labels are available)
      await this.enumerateInputDevices()
      return true
    } catch {
      return false
    }
  }

  /** Get or create a shared capture for a device. Returns the capture state. */
  private async getOrCreateDeviceCapture(deviceId: string | null): Promise<{
    stream: MediaStream
    ctx: AudioContext
    source: MediaStreamAudioSourceNode
    splitter: ChannelSplitterNode
    channelCount: number
    refCount: number
    resolvedDeviceId: string
  }> {
    // Resolve null to "default" key
    const key = deviceId || 'default'

    const existing = this.deviceCaptures.get(key)
    if (existing) {
      existing.refCount++
      return { ...existing, resolvedDeviceId: key }
    }

    // Open stream with max channels
    const constraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        // Request max channels — browser may cap at what the device supports
        channelCount: { ideal: 32 }
      }
    }

    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    const audioTrack = stream.getAudioTracks()[0]
    const settings = audioTrack.getSettings()
    const channelCount = settings.channelCount ?? 1

    // Create AudioContext and splitter
    const ctx = new AudioContext({ sampleRate: 48000 })
    const source = ctx.createMediaStreamSource(stream)
    const splitter = ctx.createChannelSplitter(channelCount)
    source.connect(splitter)

    const capture = { stream, ctx, source, splitter, channelCount, refCount: 1 }
    this.deviceCaptures.set(key, capture)

    // Update the device info with discovered channel count
    const devInfo = this._inputDevices.find((d) => d.deviceId === deviceId)
    if (devInfo) devInfo.channelCount = channelCount

    return { ...capture, resolvedDeviceId: key }
  }

  /** Release a reference to a device capture. Closes when refCount hits 0. */
  private releaseDeviceCapture(deviceKey: string) {
    const capture = this.deviceCaptures.get(deviceKey)
    if (!capture) return
    capture.refCount--
    if (capture.refCount <= 0) {
      capture.splitter.disconnect()
      capture.source.disconnect()
      capture.ctx.close().catch(() => {})
      for (const t of capture.stream.getTracks()) t.stop()
      this.deviceCaptures.delete(deviceKey)
    }
  }

  /** Start recording on a track. Uses the track's inputDeviceId and inputChannel.
   *  inputChannel: 0 = mono mix of all channels, 1..N = specific channel (1-indexed). */
  async startRecording(
    trackId: string,
    inputDeviceId: string | null = null,
    inputChannel: number = 0
  ): Promise<void> {
    const { ctx, splitter, channelCount, resolvedDeviceId } =
      await this.getOrCreateDeviceCapture(inputDeviceId)

    const chunks: Float32Array[] = []
    this.recBuffers.set(trackId, chunks)
    this.recLengths.set(trackId, 0)

    // Create a ScriptProcessorNode to capture audio
    // Buffer size 4096 = ~85ms at 48kHz — good balance of latency vs overhead
    const processor = ctx.createScriptProcessor(4096, 1, 1)

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      const copy = new Float32Array(input.length)
      copy.set(input)
      chunks.push(copy)
      this.recLengths.set(
        trackId,
        (this.recLengths.get(trackId) ?? 0) + copy.length
      )
    }

    let merger: ChannelMergerNode | undefined

    if (inputChannel === 0) {
      // Mono mix: sum all channels into one
      // Create a merger that combines all splitter outputs into mono
      if (channelCount === 1) {
        // Only one channel — connect directly
        splitter.connect(processor, 0, 0)
      } else {
        // Mix all channels: use a GainNode to sum
        const mixGain = ctx.createGain()
        mixGain.gain.value = 1 / channelCount // normalize
        for (let ch = 0; ch < channelCount; ch++) {
          splitter.connect(mixGain, ch, 0)
        }
        mixGain.connect(processor, 0, 0)
      }
    } else {
      // Specific channel (1-indexed)
      const chIdx = Math.min(inputChannel - 1, channelCount - 1)
      splitter.connect(processor, chIdx, 0)
    }

    processor.connect(ctx.destination) // ScriptProcessorNode requires output connection

    this.recTracks.set(trackId, {
      deviceId: resolvedDeviceId,
      processor,
      merger
    })
  }

  /** Poll new recording samples since last poll. Returns new samples or null. */
  pollRecording(trackId: string): Float32Array | null {
    const chunks = this.recBuffers.get(trackId)
    if (!chunks || chunks.length === 0) return null

    // Drain all chunks into a single buffer
    let totalLen = 0
    for (const c of chunks) totalLen += c.length
    if (totalLen === 0) return null

    const merged = new Float32Array(totalLen)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.length
    }
    // Clear chunks (they've been consumed)
    chunks.length = 0
    return merged
  }

  /** Stop recording on a track. Returns total recorded samples or null. */
  stopRecording(trackId: string): Float32Array | null {
    // Drain remaining chunks
    const remaining = this.pollRecording(trackId)

    // Close per-track audio nodes
    const recTrack = this.recTracks.get(trackId)
    if (recTrack) {
      recTrack.processor.disconnect()
      if (recTrack.merger) recTrack.merger.disconnect()
      this.releaseDeviceCapture(recTrack.deviceId)
      this.recTracks.delete(trackId)
    }

    this.recBuffers.delete(trackId)
    this.recLengths.delete(trackId)

    return remaining
  }

  /** Check if any tracks are currently recording */
  get isRecording(): boolean {
    return this.recTracks.size > 0
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  destroy(): void {
    if (!this.module) return

    // Stop all recordings
    for (const trackId of [...this.recTracks.keys()]) {
      this.stopRecording(trackId)
    }

    // Free all allocated buffers
    for (const ptr of this.allocatedBuffers.values()) {
      this.m._free(ptr)
    }
    this.allocatedBuffers.clear()
    // Free click buffer
    if (this.clickBufferPtr) {
      this.m._free(this.clickBufferPtr)
      this.clickBufferPtr = 0
      this.clickBufferLen = 0
    }
    this.m._tuidaw_stop_playback_device()
    this.m._tuidaw_deinit()
    this.module = null
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Ensure a track exists in native engine; returns its native ID */
  ensureTrack(trackId: string): number {
    let nativeId = this.trackIdMap.get(trackId)
    if (nativeId === undefined) {
      nativeId = this.addTrack(trackId)
    }
    return nativeId
  }

  /** Sync all track state to native engine */
  syncTrack(track: WebTrack): void {
    this.ensureTrack(track.id)
    this.setTrackSamples(track.id, track.samples)
    this.setTrackVolume(track.id, track.volume)
    this.setTrackGain(track.id, track.gain)
    this.setTrackPan(track.id, track.pan)
    this.setTrackMuted(track.id, track.muted)
    this.setTrackSolo(track.id, track.solo)
  }
}

// Minimal track interface for the web UI (subset of TUI Track type)
export interface WebTrack {
  id: string
  name: string
  color: string
  volume: number
  gain: number // 0.0 - 4.0 (pre-fader input gain, 1.0 = 0dB, 4.0 = +12dB)
  pan: number
  muted: boolean
  solo: boolean
  armed: boolean
  samples: Float32Array | null
  sampleRate: number
  inputDeviceId: string | null // selected input device ID (null = system default)
  inputChannel: number // 0 = mono mix, 1..N = specific channel
}
