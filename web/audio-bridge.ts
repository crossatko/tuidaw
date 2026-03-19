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

export interface WebAudioDevice {
  id: string
  description: string
  isDefault: boolean
}

export class WebAudioBridge {
  private module: TuidawWasmModule | null = null
  private trackIdMap: Map<string, number> = new Map()
  private nextTrackId = 1
  private allocatedBuffers: Map<number, number> = new Map() // trackNativeId -> wasmPtr

  /** Initialize the WASM audio engine. Call once before any other method. */
  async init(): Promise<void> {
    // Load the Emscripten JS glue which defines the TuidawAudio factory
    // The glue is loaded as a script tag and defines TuidawAudio globally
    const mod = await (window as any).TuidawAudio({
      locateFile: (path: string) => `/wasm/${path}`,
    })
    this.module = mod

    // Initialize miniaudio engine (uses Web Audio backend automatically)
    const result = mod._tuidaw_init()
    if (result !== 0) {
      throw new Error(`tuidaw_init failed with code ${result}`)
    }

    // Start the playback device
    mod._tuidaw_start_playback_device()
  }

  get isReady(): boolean {
    return this.module !== null
  }

  private get m(): TuidawWasmModule {
    if (!this.module) throw new Error("WebAudioBridge not initialized")
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
    if (!ptr) throw new Error("WASM malloc failed")
    this.m.HEAPF32.set(samples, ptr / 4)
    this.m._tuidaw_set_track_samples(nativeId, ptr, samples.length)
    this.allocatedBuffers.set(nativeId, ptr)
  }

  setTrackVolume(trackId: string, volume: number): void {
    const nativeId = this.trackIdMap.get(trackId)
    if (nativeId !== undefined) this.m._tuidaw_set_track_volume(nativeId, volume)
  }

  setTrackPan(trackId: string, pan: number): void {
    const nativeId = this.trackIdMap.get(trackId)
    if (nativeId !== undefined) this.m._tuidaw_set_track_pan(nativeId, pan)
  }

  setTrackMuted(trackId: string, muted: boolean): void {
    const nativeId = this.trackIdMap.get(trackId)
    if (nativeId !== undefined) this.m._tuidaw_set_track_muted(nativeId, muted ? 1 : 0)
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    const nativeId = this.trackIdMap.get(trackId)
    if (nativeId !== undefined) this.m._tuidaw_set_track_solo(nativeId, solo ? 1 : 0)
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

  generateClick(bpm: number, durationFrames: number): boolean {
    try {
      const result = this.m._tuidaw_generate_click(bpm, durationFrames)
      return result === 0
    } catch (e) {
      console.error("generateClick failed:", e, `(bpm=${bpm}, frames=${durationFrames})`)
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
      this.m._tuidaw_set_loop(0, 0)
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

  // ── Cleanup ───────────────────────────────────────────────────────────

  destroy(): void {
    if (!this.module) return
    // Free all allocated buffers
    for (const ptr of this.allocatedBuffers.values()) {
      this.m._free(ptr)
    }
    this.allocatedBuffers.clear()
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
  pan: number
  muted: boolean
  solo: boolean
  armed: boolean
  samples: Float32Array | null
  sampleRate: number
}
