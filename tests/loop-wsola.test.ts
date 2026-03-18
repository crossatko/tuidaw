// ============================================================================
// Tests for loop region behavior with WSOLA time-stretch
// ============================================================================
// These tests verify that:
// 1. The playhead stays within loop bounds at all speeds
// 2. Loop region works correctly at 1.0x, 0.5x, and 2.0x speed
// 3. The playhead wraps back to loop_start when reaching loop_end
//
// NOTE: These tests use the null audio backend (tuidaw_init_null) so no sound
// is played. The audio callback still runs on a timer thread, so playhead
// tracking and WSOLA work identically to the real backend.

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
  tuidaw_init:                  { returns: FFIType.i32 },
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

// Keep pinned so GC doesn't collect sample buffers while native code holds pointers
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

// Poll playhead and collect positions over time
async function collectPlayheadPositions(durationMs: number, intervalMs: number = 10): Promise<number[]> {
  const positions: number[] = []
  const start = Date.now()
  while (Date.now() - start < durationMs) {
    positions.push(Number(lib.symbols.tuidaw_get_playhead()))
    await sleep(intervalMs)
  }
  return positions
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Loop + WSOLA", () => {
  let trackIdCounter = 0

  beforeAll(() => {
    // Use null backend — no audio output, but callback still fires
    const result = lib.symbols.tuidaw_init_null()
    expect(result).toBe(0)
    lib.symbols.tuidaw_start_playback_device()
    lib.symbols.tuidaw_set_click(0, 120)
  })

  afterAll(() => {
    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_stop_playback_device()
    lib.symbols.tuidaw_deinit()
    pinnedBuffers.length = 0
  })

  // Helper: set up a track, loop, speed, play, collect positions, verify, clean up
  async function runLoopTest(opts: {
    speed: number
    loopStartSec: number
    loopEndSec: number
    playDurationMs: number
    expectWrap: boolean
    label: string
  }) {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(4) // 4 seconds of audio

    const loopStart = Math.round(SAMPLE_RATE * opts.loopStartSec)
    const loopEnd = Math.round(SAMPLE_RATE * opts.loopEndSec)

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)

    lib.symbols.tuidaw_set_loop(BigInt(loopStart), BigInt(loopEnd))
    lib.symbols.tuidaw_set_speed(opts.speed)
    lib.symbols.tuidaw_play(BigInt(loopStart))

    const positions = await collectPlayheadPositions(opts.playDurationMs)

    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)

    // Margin: audio callback processes up to 1024 frames at a time,
    // and WSOLA has a window of 1024 samples. Allow generous margin.
    const margin = SAMPLE_RATE * 0.1 // 100ms margin

    // Check all positions are within bounds (with margin)
    let outOfBounds = 0
    for (const pos of positions) {
      if (pos < loopStart - margin || pos >= loopEnd + margin) {
        outOfBounds++
      }
    }
    expect(outOfBounds).toBe(0)

    // Check that most positions are strictly in bounds (without margin)
    let strictlyInBounds = 0
    for (const pos of positions) {
      if (pos >= loopStart && pos < loopEnd) {
        strictlyInBounds++
      }
    }
    // At least 90% of samples should be strictly in bounds
    const ratio = strictlyInBounds / positions.length
    expect(ratio).toBeGreaterThan(0.9)

    // Check for wrap: detect backward jumps
    if (opts.expectWrap) {
      let wrapped = false
      for (let i = 1; i < positions.length; i++) {
        // A wrap = position decreased by more than half the loop length
        const loopLen = loopEnd - loopStart
        if (positions[i] < positions[i - 1] - loopLen * 0.3) {
          wrapped = true
          break
        }
      }
      expect(wrapped).toBe(true)
    }

    return positions
  }

  test("1.0x speed: playhead loops within bounds", async () => {
    await runLoopTest({
      speed: 1.0,
      loopStartSec: 1.0,
      loopEndSec: 2.0,
      playDurationMs: 2500, // 2.5 sec = at least 2 loops of 1s content
      expectWrap: true,
      label: "1.0x",
    })
  }, 10000)

  test("0.5x speed: playhead loops within bounds", async () => {
    await runLoopTest({
      speed: 0.5,
      loopStartSec: 1.0,
      loopEndSec: 2.0,
      playDurationMs: 5000, // 5 sec = at least 2 loops (1s content at 0.5x = 2s per loop)
      expectWrap: true,
      label: "0.5x",
    })
  }, 10000)

  test("2.0x speed: playhead loops within bounds", async () => {
    await runLoopTest({
      speed: 2.0,
      loopStartSec: 1.0,
      loopEndSec: 2.0,
      playDurationMs: 2000, // 2 sec = at least 3 loops (1s content at 2x = 0.5s per loop)
      expectWrap: true,
      label: "2.0x",
    })
  }, 10000)

  test("0.25x speed: playhead loops within bounds", async () => {
    await runLoopTest({
      speed: 0.25,
      loopStartSec: 0.5,
      loopEndSec: 1.0,
      playDurationMs: 5000, // 5 sec (0.5s content at 0.25x = 2s per loop)
      expectWrap: true,
      label: "0.25x",
    })
  }, 10000)

  test("speed change during loop: playhead stays in bounds", async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(4)
    const loopStart = SAMPLE_RATE
    const loopEnd = SAMPLE_RATE * 2

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)

    lib.symbols.tuidaw_set_loop(BigInt(loopStart), BigInt(loopEnd))
    lib.symbols.tuidaw_set_speed(1.0)
    lib.symbols.tuidaw_play(BigInt(loopStart))

    // Play at 1.0x for 0.5 seconds
    await sleep(500)

    // Change to 0.5x speed
    lib.symbols.tuidaw_set_speed(0.5)

    // Collect positions for 3 more seconds
    const positions = await collectPlayheadPositions(3000)

    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)

    const margin = SAMPLE_RATE * 0.1
    let outOfBounds = 0
    for (const pos of positions) {
      if (pos < loopStart - margin || pos >= loopEnd + margin) {
        outOfBounds++
      }
    }
    expect(outOfBounds).toBe(0)
  }, 10000)

  test("no loop: playhead moves past loop region", async () => {
    const trackId = ++trackIdCounter
    const samples = generateSineWave(4)

    lib.symbols.tuidaw_add_track(trackId)
    lib.symbols.tuidaw_set_track_samples(trackId, ptr(samples), samples.length)
    lib.symbols.tuidaw_set_track_volume(trackId, 0.5)
    lib.symbols.tuidaw_set_track_muted(trackId, 0)

    // No loop
    lib.symbols.tuidaw_set_loop(BigInt(-1), BigInt(-1))
    lib.symbols.tuidaw_set_speed(1.0)
    lib.symbols.tuidaw_play(BigInt(0))

    await sleep(2500)

    const pos = Number(lib.symbols.tuidaw_get_playhead())
    // Should have moved past 2 seconds (no loop to constrain it)
    expect(pos).toBeGreaterThan(SAMPLE_RATE * 2)

    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(trackId)
  }, 10000)
})
