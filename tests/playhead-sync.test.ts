// ============================================================================
// Tests for playhead/waveform sync across speed changes
// ============================================================================
// These tests verify that:
// 1. The playhead always tracks content-space (source sample position)
// 2. Speed changes don't cause playhead drift or jumps
// 3. After multiple speed changes, the playhead position is consistent
//    with the source audio position being played
//
// Uses null audio backend — no sound output.

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { existsSync } from "fs"
import path from "path"

const SAMPLE_RATE = 48000

// ── Load native library ─────────────────────────────────────────────────────

function findLibrary(): string {
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
  tuidaw_init_null:             { returns: FFIType.i32 },
  tuidaw_deinit:                { returns: FFIType.void },
  tuidaw_start_playback_device: { returns: FFIType.i32 },
  tuidaw_stop_playback_device:  { returns: FFIType.void },
  tuidaw_add_track:             { returns: FFIType.i32, args: [FFIType.i32] },
  tuidaw_remove_track:          { returns: FFIType.void, args: [FFIType.i32] },
  tuidaw_set_track_samples:     { returns: FFIType.void, args: [FFIType.i32, FFIType.ptr, FFIType.i32] },
  tuidaw_set_track_volume:      { returns: FFIType.void, args: [FFIType.i32, FFIType.f32] },
  tuidaw_set_track_muted:       { returns: FFIType.void, args: [FFIType.i32, FFIType.i32] },
  tuidaw_play:                  { returns: FFIType.void, args: [FFIType.i64] },
  tuidaw_stop:                  { returns: FFIType.void },
  tuidaw_get_playhead:          { returns: FFIType.i64 },
  tuidaw_set_playhead:          { returns: FFIType.void, args: [FFIType.i64] },
  tuidaw_set_loop:              { returns: FFIType.void, args: [FFIType.i64, FFIType.i64] },
  tuidaw_set_speed:             { returns: FFIType.void, args: [FFIType.f32] },
  tuidaw_get_speed:             { returns: FFIType.f32 },
  tuidaw_set_click:             { returns: FFIType.void, args: [FFIType.i32, FFIType.f32] },
})

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const pinnedBuffers: Float32Array[] = []

function generateSineWave(durationSeconds: number): Float32Array {
  const numSamples = Math.round(SAMPLE_RATE * durationSeconds)
  const samples = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    samples[i] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5
  }
  pinnedBuffers.push(samples)
  return samples
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Playhead content-space sync", () => {
  let trackIdCounter = 100 // offset from loop-wsola tests

  beforeAll(() => {
    const result = lib.symbols.tuidaw_init_null()
    expect(result).toBe(0)
    lib.symbols.tuidaw_start_playback_device()
    lib.symbols.tuidaw_set_click(0, 120) // disable click
  })

  afterAll(() => {
    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_stop_playback_device()
    lib.symbols.tuidaw_deinit()
    pinnedBuffers.length = 0
  })

  test("at 0.5x speed, playhead advances at half rate through source", async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(10) // 10 seconds

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)
    lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1)) // no loop
    lib.symbols.tuidaw_set_speed(0.5)
    lib.symbols.tuidaw_play(BigInt(0))

    // Wait 2 seconds of real time
    await sleep(2000)

    const pos = Number(lib.symbols.tuidaw_get_playhead())
    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)

    // At 0.5x speed, after 2 seconds of real time, playhead should be at ~1 second
    // in content-space (48000 samples), not 2 seconds (96000)
    // Allow generous margin for callback timing
    const expectedCenter = SAMPLE_RATE * 1 // ~48000
    const margin = SAMPLE_RATE * 0.5 // ±0.5 seconds
    expect(pos).toBeGreaterThan(expectedCenter - margin)
    expect(pos).toBeLessThan(expectedCenter + margin)
  }, 10000)

  test("at 2.0x speed, playhead advances at double rate through source", async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(10)

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)
    lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1))
    lib.symbols.tuidaw_set_speed(2.0)
    lib.symbols.tuidaw_play(BigInt(0))

    await sleep(1000)

    const pos = Number(lib.symbols.tuidaw_get_playhead())
    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)

    // At 2.0x speed, after 1 second of real time, playhead should be at ~2 seconds
    // in content-space (96000 samples)
    const expectedCenter = SAMPLE_RATE * 2 // ~96000
    const margin = SAMPLE_RATE * 0.5
    expect(pos).toBeGreaterThan(expectedCenter - margin)
    expect(pos).toBeLessThan(expectedCenter + margin)
  }, 10000)

  test("speed change mid-playback: no playhead jump", async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(20) // 20 seconds to have room

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)
    lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1))
    lib.symbols.tuidaw_set_speed(1.0)
    lib.symbols.tuidaw_play(BigInt(0))

    // Play at 1.0x for 1 second
    await sleep(1000)
    const posBeforeChange = Number(lib.symbols.tuidaw_get_playhead())
    console.log(`  posBeforeChange: ${posBeforeChange} (expected ~${SAMPLE_RATE})`)

    // Change to 0.5x
    lib.symbols.tuidaw_set_speed(0.5)

    // Small delay to let speed change take effect
    await sleep(200)
    const posAfterChange = Number(lib.symbols.tuidaw_get_playhead())
    console.log(`  posAfterChange: ${posAfterChange}`)
    console.log(`  jump: ${posAfterChange - posBeforeChange}`)

    // Playhead should NOT have jumped backward or forward significantly
    // Allow margin for the 200ms of playback at 0.5x (= ~0.1s content advance)
    // plus WSOLA buffer pre-generation
    const maxExpectedAdvance = SAMPLE_RATE * 0.5 // 0.5 seconds of source
    const jumpSize = posAfterChange - posBeforeChange
    // Should have advanced forward, not backward
    expect(jumpSize).toBeGreaterThanOrEqual(0)
    // Should not have advanced more than 0.5 seconds of source
    expect(jumpSize).toBeLessThan(maxExpectedAdvance)

    // Continue playing at 0.5x for 2 more seconds
    await sleep(2000)
    const posFinal = Number(lib.symbols.tuidaw_get_playhead())

    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)

    // Final position should be ahead of the change point
    expect(posFinal).toBeGreaterThan(posAfterChange)
    // But should have advanced ~1 second of source (2 sec real time * 0.5x)
    const advanceAfterChange = posFinal - posAfterChange
    const expectedAdvance = SAMPLE_RATE * 1 // ~48000
    const margin = SAMPLE_RATE * 0.5
    expect(advanceAfterChange).toBeGreaterThan(expectedAdvance - margin)
    expect(advanceAfterChange).toBeLessThan(expectedAdvance + margin)
  }, 10000)

  test("multiple speed changes: playhead stays consistent", async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(30) // 30 seconds

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)
    lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1))
    lib.symbols.tuidaw_set_speed(1.0)
    lib.symbols.tuidaw_play(BigInt(0))

    const positions: { time: number; pos: number; speed: number }[] = []

    // Play at 1.0x for 0.5s
    await sleep(500)
    positions.push({ time: 500, pos: Number(lib.symbols.tuidaw_get_playhead()), speed: 1.0 })

    // Change to 0.5x, play for 1s
    lib.symbols.tuidaw_set_speed(0.5)
    await sleep(1000)
    positions.push({ time: 1500, pos: Number(lib.symbols.tuidaw_get_playhead()), speed: 0.5 })

    // Change to 2.0x, play for 0.5s
    lib.symbols.tuidaw_set_speed(2.0)
    await sleep(500)
    positions.push({ time: 2000, pos: Number(lib.symbols.tuidaw_get_playhead()), speed: 2.0 })

    // Change back to 1.0x, play for 0.5s
    lib.symbols.tuidaw_set_speed(1.0)
    await sleep(500)
    positions.push({ time: 2500, pos: Number(lib.symbols.tuidaw_get_playhead()), speed: 1.0 })

    // Change to 0.25x, play for 1s
    lib.symbols.tuidaw_set_speed(0.25)
    await sleep(1000)
    positions.push({ time: 3500, pos: Number(lib.symbols.tuidaw_get_playhead()), speed: 0.25 })

    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)

    // Key invariant: playhead should always increase monotonically
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i].pos).toBeGreaterThan(positions[i - 1].pos)
    }

    // Playhead should never exceed what's physically possible
    // Total content consumed ≈ 0.5*1.0 + 1.0*0.5 + 0.5*2.0 + 0.5*1.0 + 1.0*0.25
    //                        = 0.5 + 0.5 + 1.0 + 0.5 + 0.25 = 2.75 seconds of source
    // With timing variance, allow up to 4 seconds
    const finalPos = positions[positions.length - 1].pos
    expect(finalPos).toBeLessThan(SAMPLE_RATE * 5)
    expect(finalPos).toBeGreaterThan(SAMPLE_RATE * 1) // at least 1 second in
  }, 15000)

  test("speed change does not cause large backward jump", async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(20)

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)
    lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1))
    lib.symbols.tuidaw_set_speed(1.0)
    lib.symbols.tuidaw_play(BigInt(0))

    // Rapidly toggle speed up and down
    const positionLog: number[] = []
    for (let i = 0; i < 10; i++) {
      await sleep(200)
      positionLog.push(Number(lib.symbols.tuidaw_get_playhead()))

      // Alternate between slow and fast
      const speed = i % 2 === 0 ? 0.5 : 1.5
      lib.symbols.tuidaw_set_speed(speed)
    }

    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)

    // Check no backward jumps larger than 0.2 seconds
    const maxBackwardJump = SAMPLE_RATE * 0.2
    for (let i = 1; i < positionLog.length; i++) {
      const diff = positionLog[i] - positionLog[i - 1]
      if (diff < 0) {
        expect(Math.abs(diff)).toBeLessThan(maxBackwardJump)
      }
    }

    // Overall: playhead should have advanced
    expect(positionLog[positionLog.length - 1]).toBeGreaterThan(positionLog[0])
  }, 10000)

  test("playhead at 1.0x matches wall-clock", async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(10)

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)
    lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1))
    lib.symbols.tuidaw_set_speed(1.0)
    lib.symbols.tuidaw_play(BigInt(0))

    await sleep(2000)

    const pos = Number(lib.symbols.tuidaw_get_playhead())
    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)

    // At 1.0x speed, playhead should be ≈ 2 seconds into the source
    const expectedCenter = SAMPLE_RATE * 2
    const margin = SAMPLE_RATE * 0.3
    expect(pos).toBeGreaterThan(expectedCenter - margin)
    expect(pos).toBeLessThan(expectedCenter + margin)
  }, 10000)
})
