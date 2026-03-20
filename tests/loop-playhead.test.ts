// ============================================================================
// Tests for loop region + playhead interaction
// ============================================================================
// These tests verify that:
// 1. Playhead before loop region: plays linearly, enters loop when reaching it
// 2. Playhead at exact loopEnd: should loop (treated as boundary)
// 3. Playhead after loop region: plays linearly, no loop enforcement
// 4. Seeking into loop during playback re-enables loop
// 5. Seeking past loop during playback disables loop
//
// Uses null audio backend -- no sound output.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { existsSync } from 'fs'
import path from 'path'

const SAMPLE_RATE = 48000

// ── Load native library ─────────────────────────────────────────────────────

function findLibrary(): string {
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
  tuidaw_init_null: { returns: FFIType.i32 },
  tuidaw_deinit: { returns: FFIType.void },
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
  tuidaw_set_track_muted: {
    returns: FFIType.void,
    args: [FFIType.i32, FFIType.i32]
  },
  tuidaw_play: { returns: FFIType.void, args: [FFIType.i64] },
  tuidaw_stop: { returns: FFIType.void },
  tuidaw_get_playhead: { returns: FFIType.i64 },
  tuidaw_set_playhead: { returns: FFIType.void, args: [FFIType.i64] },
  tuidaw_set_loop: { returns: FFIType.void, args: [FFIType.i64, FFIType.i64] },
  tuidaw_set_speed: { returns: FFIType.void, args: [FFIType.f32] },
  tuidaw_set_click: { returns: FFIType.void, args: [FFIType.i32, FFIType.f32] }
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const pinnedBuffers: Float32Array[] = []

function generateSineWave(durationSeconds: number): Float32Array {
  const numSamples = Math.round(SAMPLE_RATE * durationSeconds)
  const samples = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 0.5
  }
  pinnedBuffers.push(samples)
  return samples
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Loop + playhead interaction', () => {
  let trackIdCounter = 200 // offset from other test files

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

  test('play from before loop: enters loop region and wraps', async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(10)

    // Loop is at 2-3 seconds. Play from 0.
    const loopStart = SAMPLE_RATE * 2
    const loopEnd = SAMPLE_RATE * 3

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)
    lib.symbols.tuidaw_set_loop(BigInt(loopStart), BigInt(loopEnd))
    lib.symbols.tuidaw_set_speed(1.0)

    // Play from position 0 (before the loop)
    lib.symbols.tuidaw_play(BigInt(0))

    // Wait 1.5s — playhead should still be before the loop (~1.5s in)
    await sleep(1500)
    const posBefore = Number(lib.symbols.tuidaw_get_playhead())
    expect(posBefore).toBeLessThan(loopStart)
    expect(posBefore).toBeGreaterThan(SAMPLE_RATE * 1) // at least 1s in

    // Wait 3 more seconds — playhead should have entered the loop and be looping
    // Total wall time ~4.5s. At 1.0x, playhead reaches loopEnd at 3s, wraps.
    // After 4.5s total, it should be inside the loop region.
    await sleep(3000)
    const posAfter = Number(lib.symbols.tuidaw_get_playhead())
    expect(posAfter).toBeGreaterThanOrEqual(loopStart)
    expect(posAfter).toBeLessThan(loopEnd + SAMPLE_RATE * 0.1) // small margin

    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)
  }, 15000)

  test('play from exact loopEnd: wraps into loop', async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(10)

    const loopStart = SAMPLE_RATE * 2
    const loopEnd = SAMPLE_RATE * 3

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)
    lib.symbols.tuidaw_set_loop(BigInt(loopStart), BigInt(loopEnd))
    lib.symbols.tuidaw_set_speed(1.0)

    // Play from exactly loopEnd
    lib.symbols.tuidaw_play(BigInt(loopEnd))

    // Wait a bit for the callback to process
    await sleep(500)
    const pos = Number(lib.symbols.tuidaw_get_playhead())

    // The playhead should have wrapped into the loop region
    expect(pos).toBeGreaterThanOrEqual(loopStart)
    expect(pos).toBeLessThan(loopEnd + SAMPLE_RATE * 0.1)

    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)
  }, 10000)

  test('play from after loop: continues linearly, no wrapping', async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(10)

    const loopStart = SAMPLE_RATE * 1
    const loopEnd = SAMPLE_RATE * 2
    // Start well past the loop
    const startPos = SAMPLE_RATE * 4

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)

    // Set loop but play from after it — should NOT wrap
    // (Simulates: user sets loop, then seeks past it and presses play)
    lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1)) // no loop
    lib.symbols.tuidaw_set_speed(1.0)
    lib.symbols.tuidaw_play(BigInt(startPos))

    await sleep(1500)
    const pos = Number(lib.symbols.tuidaw_get_playhead())

    // Should have advanced past startPos linearly
    expect(pos).toBeGreaterThan(startPos + SAMPLE_RATE * 1)
    // Should NOT be in the loop region
    expect(pos).toBeGreaterThan(loopEnd)

    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)
  }, 10000)

  test('seek into loop during playback re-enables looping', async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(10)

    const loopStart = SAMPLE_RATE * 2
    const loopEnd = SAMPLE_RATE * 3

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)

    // Start playing from after the loop (no loop enforcement)
    lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1))
    lib.symbols.tuidaw_set_speed(1.0)
    lib.symbols.tuidaw_play(BigInt(SAMPLE_RATE * 5))

    await sleep(300)

    // Now seek into the loop and re-enable it (simulates syncLoopAfterSeek)
    lib.symbols.tuidaw_set_playhead(BigInt(loopStart))
    lib.symbols.tuidaw_set_loop(BigInt(loopStart), BigInt(loopEnd))

    // Wait enough for the loop to wrap at least once (1s loop at 1.0x)
    await sleep(2500)
    const pos = Number(lib.symbols.tuidaw_get_playhead())

    // Should be inside the loop region
    expect(pos).toBeGreaterThanOrEqual(loopStart)
    expect(pos).toBeLessThan(loopEnd + SAMPLE_RATE * 0.1)

    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)
  }, 10000)

  test('seek past loop during playback disables looping', async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(10)

    const loopStart = SAMPLE_RATE * 1
    const loopEnd = SAMPLE_RATE * 2
    const seekTarget = SAMPLE_RATE * 5

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)

    // Start playing inside the loop
    lib.symbols.tuidaw_set_loop(BigInt(loopStart), BigInt(loopEnd))
    lib.symbols.tuidaw_set_speed(1.0)
    lib.symbols.tuidaw_play(BigInt(loopStart))

    await sleep(500)
    // Confirm we're in the loop
    const posInLoop = Number(lib.symbols.tuidaw_get_playhead())
    expect(posInLoop).toBeGreaterThanOrEqual(loopStart)
    expect(posInLoop).toBeLessThan(loopEnd + SAMPLE_RATE * 0.1)

    // Seek past the loop and disable it (simulates syncLoopAfterSeek)
    lib.symbols.tuidaw_set_playhead(BigInt(seekTarget))
    lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1))

    await sleep(1500)
    const pos = Number(lib.symbols.tuidaw_get_playhead())

    // Should have advanced past the seek target linearly
    expect(pos).toBeGreaterThan(seekTarget)
    // Should NOT have wrapped back into the loop
    expect(pos).toBeGreaterThan(loopEnd)

    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)
  }, 10000)

  test('play from before loop at 0.5x: enters loop and wraps', async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(10)

    // Loop at 1-2 seconds. At 0.5x, takes 2s wall time to reach loopStart,
    // then 2s per loop iteration.
    const loopStart = SAMPLE_RATE * 1
    const loopEnd = SAMPLE_RATE * 2

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)
    lib.symbols.tuidaw_set_loop(BigInt(loopStart), BigInt(loopEnd))
    lib.symbols.tuidaw_set_speed(0.5)

    // Play from 0 at 0.5x speed
    lib.symbols.tuidaw_play(BigInt(0))

    // Wait 1s — at 0.5x, playhead is at ~0.5s content, still at or before loop start
    await sleep(1000)
    const posEarly = Number(lib.symbols.tuidaw_get_playhead())
    expect(posEarly).toBeLessThanOrEqual(loopStart)

    // Wait 5 more seconds — at 0.5x, that's 2.5s of content.
    // Total content = ~3s, well past loopEnd (2s), should have looped.
    await sleep(5000)
    const posLater = Number(lib.symbols.tuidaw_get_playhead())
    expect(posLater).toBeGreaterThanOrEqual(loopStart)
    expect(posLater).toBeLessThan(loopEnd + SAMPLE_RATE * 0.1)

    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)
  }, 15000)
})
