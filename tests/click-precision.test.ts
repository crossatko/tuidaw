// ============================================================================
// Tests for click timing precision using offline render
// ============================================================================
// These tests verify that click pulses have zero cumulative drift, using
// tuidaw_render() to bypass the audio device for deterministic output.
//
// Architecture: the click buffer is generated natively by tuidaw_generate_click()
// which fills a long pre-rendered buffer with click tones at GCD-exact beat
// positions. The native callback reads click_samples[counter] with a simple
// bounds check. No modulo, no floating-point BPM math, no fmod.
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
  tuidaw_set_click_samples:     { returns: FFIType.void, args: [FFIType.ptr, FFIType.i32] },
  tuidaw_generate_click:        { returns: FFIType.i32, args: [FFIType.f32, FFIType.i32] },
  tuidaw_set_click_volume:      { returns: FFIType.void, args: [FFIType.f32] },
  tuidaw_set_click_pan:         { returns: FFIType.void, args: [FFIType.f32] },
  tuidaw_render:                { returns: FFIType.i32, args: [FFIType.ptr, FFIType.i32] },
})

// ── Helpers ─────────────────────────────────────────────────────────────────

// Render audio offline: returns interleaved stereo buffer
function render(frameCount: number): Float32Array {
  const buf = new Float32Array(frameCount * 2)
  lib.symbols.tuidaw_render(ptr(buf), frameCount)
  return buf
}

// Render audio offline in chunks
function renderChunked(totalFrames: number, chunkSize: number): Float32Array {
  const allOutput = new Float32Array(totalFrames * 2)
  let offset = 0
  let framesLeft = totalFrames
  while (framesLeft > 0) {
    const frames = Math.min(chunkSize, framesLeft)
    const chunk = render(frames)
    allOutput.set(chunk, offset)
    offset += frames * 2
    framesLeft -= frames
  }
  return allOutput
}

// Find click onset positions in stereo audio.
// Returns frame indices where click pulses start.
function findClickOnsets(stereo: Float32Array, threshold: number = 0.1): number[] {
  const onsets: number[] = []
  const frameCount = stereo.length / 2
  const clickDuration = Math.round(SAMPLE_RATE * 0.025) // 25ms dead-time

  let frame = 0
  while (frame < frameCount) {
    const left = Math.abs(stereo[frame * 2]!)
    const right = Math.abs(stereo[frame * 2 + 1]!)
    const amp = Math.max(left, right)

    if (amp > threshold) {
      onsets.push(frame)
      frame += clickDuration
    } else {
      frame++
    }
  }

  return onsets
}

// Set up click playback at a given BPM using the native click generator.
// Generates a buffer long enough for the test duration, starts from position 0.
// Returns the exact (fractional) samples-per-beat.
function setupClick(bpm: number, durationSeconds: number = 60): number {
  const durationFrames = Math.ceil(durationSeconds * SAMPLE_RATE) + SAMPLE_RATE // + 1s margin
  lib.symbols.tuidaw_generate_click(bpm, durationFrames)
  lib.symbols.tuidaw_set_click(1, bpm)
  lib.symbols.tuidaw_set_click_volume(1.0)
  lib.symbols.tuidaw_set_click_pan(0.0)
  lib.symbols.tuidaw_set_loop(-1, -1)
  lib.symbols.tuidaw_set_speed(1.0)
  return (60 / bpm) * SAMPLE_RATE
}

// Verify click precision: each onset should be within maxError samples
// of its ideal position (n * spb_exact), and no cumulative drift.
function verifyPrecision(
  onsets: number[],
  spbExact: number,
  label: string,
  startPos: number = 0,
  maxError: number = 2
): void {
  let maxFoundError = 0
  let totalAbsError = 0

  for (let i = 0; i < onsets.length; i++) {
    const outputFrame = onsets[i]!
    const absolutePos = outputFrame + startPos

    // Find the nearest beat boundary
    const beatNum = Math.round(absolutePos / spbExact)
    const idealPos = beatNum * spbExact
    const error = Math.abs(absolutePos - idealPos)

    if (error > maxError) {
      console.log(`${label} Beat ${i} (beat#${beatNum}): ideal ${idealPos.toFixed(2)}, got ${absolutePos}, error ${error.toFixed(2)} samples (${(error / SAMPLE_RATE * 1000).toFixed(3)}ms)`)
    }
    expect(error).toBeLessThanOrEqual(maxError)

    maxFoundError = Math.max(maxFoundError, error)
    totalAbsError += error
  }

  const avgError = onsets.length > 0 ? totalAbsError / onsets.length : 0
  console.log(`${label}: ${onsets.length} onsets, max error ${maxFoundError.toFixed(2)} samples (${(maxFoundError / SAMPLE_RATE * 1000).toFixed(3)}ms), avg ${avgError.toFixed(2)}`)
}

// ── Keep pinned references alive (for track samples) ────────────────────────
const pinnedBuffers: Float32Array[] = []

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Click precision (offline render)", () => {
  beforeAll(() => {
    const result = lib.symbols.tuidaw_init_null()
    expect(result).toBe(0)
  })

  afterAll(() => {
    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_deinit()
  })

  test("120 BPM, single large render (20 beats)", () => {
    const spbExact = setupClick(120)
    const numBeats = 20
    // Render exactly numBeats beats (no extra margin to avoid an extra onset)
    const totalFrames = Math.ceil(spbExact * numBeats) - 10

    lib.symbols.tuidaw_play(0)
    const output = render(totalFrames)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    expect(onsets.length).toBe(numBeats)
    verifyPrecision(onsets, spbExact, "120BPM-single")
  })

  test("155 BPM, single large render (30 beats, fractional spb)", () => {
    const spbExact = setupClick(155)  // 18580.6451...
    const numBeats = 30
    const totalFrames = Math.ceil(spbExact * numBeats) + 1000

    lib.symbols.tuidaw_play(0)
    const output = render(totalFrames)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    expect(onsets.length).toBeGreaterThanOrEqual(numBeats)
    verifyPrecision(onsets, spbExact, "155BPM-single")
  })

  test("120 BPM, chunked rendering (256 frames)", () => {
    const spbExact = setupClick(120)
    const numBeats = 10
    const totalFrames = Math.ceil(spbExact * numBeats)

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 256)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    expect(onsets.length).toBe(numBeats)
    verifyPrecision(onsets, spbExact, "120BPM-chunk256")
  })

  test("145 BPM, chunked rendering (97 frames, prime chunk)", () => {
    const spbExact = setupClick(145)  // 19862.0689...
    const numBeats = 15
    // Subtract margin to avoid catching beat numBeats+1 at the buffer boundary
    const totalFrames = Math.ceil(spbExact * numBeats) - 10

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 97)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    expect(onsets.length).toBe(numBeats)
    verifyPrecision(onsets, spbExact, "145BPM-chunk97")
  })

  test("120 BPM with track playing simultaneously", () => {
    const spbExact = setupClick(120)
    const numBeats = 10
    const totalFrames = Math.ceil(spbExact * numBeats)

    const trackSamples = new Float32Array(totalFrames)
    for (let i = 0; i < totalFrames; i++) {
      trackSamples[i] = (Math.random() - 0.5) * 0.01
    }
    pinnedBuffers.push(trackSamples)

    lib.symbols.tuidaw_add_track(99)
    lib.symbols.tuidaw_set_track_samples(99, ptr(trackSamples), trackSamples.length)
    lib.symbols.tuidaw_set_track_volume(99, 0.5)
    lib.symbols.tuidaw_set_track_muted(99, 0)

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 256)
    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(99)

    const onsets = findClickOnsets(output, 0.15)
    expect(onsets.length).toBe(numBeats)
    verifyPrecision(onsets, spbExact, "120BPM-withTrack")
  })

  test("120 BPM starting from non-zero position", () => {
    const spbExact = setupClick(120) // 24000
    const startPos = 5000
    const numBeats = 10
    const totalFrames = Math.ceil(spbExact * numBeats)

    lib.symbols.tuidaw_play(startPos)
    const output = render(totalFrames)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    // Click frame counter resets to 0 on play, so clicks start from output
    // frame 0 regardless of content-space start position. This means the
    // first click is at output frame 0 (not offset by startPos).
    expect(onsets.length).toBeGreaterThanOrEqual(8)
    // Verify against output-space positions (startPos=0 since counter resets)
    verifyPrecision(onsets, spbExact, "120BPM-nonzero", 0)
  })

  test("155 BPM, 5 minutes of playback — zero cumulative drift", () => {
    // Key test: 155 BPM has fractional spb = 18580.6451... per beat.
    // The native generator uses GCD-exact integer math for beat positions.
    // Max error should be < 2 samples at any point (rounding + onset detection).
    const bpm = 155
    const durationSeconds = 300 // 5 minutes
    const numBeats = Math.floor(durationSeconds * bpm / 60)
    const spbExact = setupClick(bpm, durationSeconds + 10) // extra margin
    const totalFrames = Math.ceil(spbExact * numBeats) + 1000

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 256)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    expect(onsets.length).toBeGreaterThanOrEqual(numBeats - 1)

    // Verify zero cumulative drift — every single onset must be within 2 samples
    // of its ideal position, even after hundreds of beats
    verifyPrecision(onsets, spbExact, "155BPM-5min")

    // Extra check: compare last onset to ideal position
    if (onsets.length > 0) {
      const lastOnset = onsets[onsets.length - 1]!
      const lastBeatNum = Math.round(lastOnset / spbExact)
      const idealLast = lastBeatNum * spbExact
      const driftAtEnd = Math.abs(lastOnset - idealLast)
      console.log(`Last onset at frame ${lastOnset}, beat #${lastBeatNum}, drift ${driftAtEnd.toFixed(2)} samples (${(driftAtEnd / SAMPLE_RATE * 1000).toFixed(3)}ms)`)
      expect(driftAtEnd).toBeLessThanOrEqual(2)
    }
  })

  test("212 BPM, 3 minutes — high BPM stress test", () => {
    const bpm = 212
    const durationSeconds = 180
    const numBeats = Math.floor(durationSeconds * bpm / 60)
    const spbExact = setupClick(bpm, durationSeconds + 10) // extra margin
    const totalFrames = Math.ceil(spbExact * numBeats) + 1000

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 256)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    expect(onsets.length).toBeGreaterThanOrEqual(numBeats - 1)
    verifyPrecision(onsets, spbExact, "212BPM-3min")
  })
})
