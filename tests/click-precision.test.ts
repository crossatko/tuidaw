// ============================================================================
// Tests for click timing precision using offline render
// ============================================================================
// These tests verify that click pulses have zero cumulative drift, using
// tuidaw_render() to bypass the audio device for deterministic output.
//
// Architecture: the click buffer is generated natively by tuidaw_generate_click()
// which fills a long pre-rendered buffer with click tones at GCD-exact beat
// positions. The native callback indexes the buffer by output-space counter
// (click_frame_counter). On loop wrap, the counter is reset to align with
// the loop start position. No modulo, no floating-point BPM math, no fmod.
//
// Uses null audio backend — no sound output.

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
  tuidaw_get_speed: { returns: FFIType.f32 },
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
  tuidaw_render: { returns: FFIType.i32, args: [FFIType.ptr, FFIType.i32] }
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
function findClickOnsets(
  stereo: Float32Array,
  threshold: number = 0.1
): number[] {
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
      console.log(
        `${label} Beat ${i} (beat#${beatNum}): ideal ${idealPos.toFixed(2)}, got ${absolutePos}, error ${error.toFixed(2)} samples (${((error / SAMPLE_RATE) * 1000).toFixed(3)}ms)`
      )
    }
    expect(error).toBeLessThanOrEqual(maxError)

    maxFoundError = Math.max(maxFoundError, error)
    totalAbsError += error
  }

  const avgError = onsets.length > 0 ? totalAbsError / onsets.length : 0
  console.log(
    `${label}: ${onsets.length} onsets, max error ${maxFoundError.toFixed(2)} samples (${((maxFoundError / SAMPLE_RATE) * 1000).toFixed(3)}ms), avg ${avgError.toFixed(2)}`
  )
}

// ── Keep pinned references alive (for track samples) ────────────────────────
const pinnedBuffers: Float32Array[] = []

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Click precision (offline render)', () => {
  beforeAll(() => {
    const result = lib.symbols.tuidaw_init_null()
    expect(result).toBe(0)
  })

  afterAll(() => {
    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_deinit()
  })

  test('120 BPM, single large render (20 beats)', () => {
    const spbExact = setupClick(120)
    const numBeats = 20
    // Render exactly numBeats beats (no extra margin to avoid an extra onset)
    const totalFrames = Math.ceil(spbExact * numBeats) - 10

    lib.symbols.tuidaw_play(0)
    const output = render(totalFrames)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    expect(onsets.length).toBe(numBeats)
    verifyPrecision(onsets, spbExact, '120BPM-single')
  })

  test('155 BPM, single large render (30 beats, fractional spb)', () => {
    const spbExact = setupClick(155) // 18580.6451...
    const numBeats = 30
    const totalFrames = Math.ceil(spbExact * numBeats) + 1000

    lib.symbols.tuidaw_play(0)
    const output = render(totalFrames)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    expect(onsets.length).toBeGreaterThanOrEqual(numBeats)
    verifyPrecision(onsets, spbExact, '155BPM-single')
  })

  test('120 BPM, chunked rendering (256 frames)', () => {
    const spbExact = setupClick(120)
    const numBeats = 10
    const totalFrames = Math.ceil(spbExact * numBeats)

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 256)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    expect(onsets.length).toBe(numBeats)
    verifyPrecision(onsets, spbExact, '120BPM-chunk256')
  })

  test('145 BPM, chunked rendering (97 frames, prime chunk)', () => {
    const spbExact = setupClick(145) // 19862.0689...
    const numBeats = 15
    // Subtract margin to avoid catching beat numBeats+1 at the buffer boundary
    const totalFrames = Math.ceil(spbExact * numBeats) - 10

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 97)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    expect(onsets.length).toBe(numBeats)
    verifyPrecision(onsets, spbExact, '145BPM-chunk97')
  })

  test('120 BPM with track playing simultaneously', () => {
    const spbExact = setupClick(120)
    const numBeats = 10
    const totalFrames = Math.ceil(spbExact * numBeats)

    const trackSamples = new Float32Array(totalFrames)
    for (let i = 0; i < totalFrames; i++) {
      trackSamples[i] = (Math.random() - 0.5) * 0.01
    }
    pinnedBuffers.push(trackSamples)

    lib.symbols.tuidaw_add_track(99)
    lib.symbols.tuidaw_set_track_samples(
      99,
      ptr(trackSamples),
      trackSamples.length
    )
    lib.symbols.tuidaw_set_track_volume(99, 0.5)
    lib.symbols.tuidaw_set_track_muted(99, 0)

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 256)
    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_remove_track(99)

    const onsets = findClickOnsets(output, 0.15)
    expect(onsets.length).toBe(numBeats)
    verifyPrecision(onsets, spbExact, '120BPM-withTrack')
  })

  test('120 BPM starting from non-zero position', () => {
    const spbExact = setupClick(120) // 24000
    const startPos = 5000
    const numBeats = 10
    const totalFrames = Math.ceil(spbExact * numBeats)

    lib.symbols.tuidaw_play(startPos)
    const output = render(totalFrames)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    // Click counter is set to startPos/speed on play, so clicks align to the
    // absolute beat grid. The first click appears at output frame
    // (nextBeat - startPos) = (24000 - 5000) = 19000, then every 24000 frames.
    // Use startPos to verify against absolute beat positions.
    expect(onsets.length).toBeGreaterThanOrEqual(8)
    verifyPrecision(onsets, spbExact, '120BPM-nonzero', startPos)
  })

  test('155 BPM, 5 minutes of playback — zero cumulative drift', () => {
    // Key test: 155 BPM has fractional spb = 18580.6451... per beat.
    // The native generator uses GCD-exact integer math for beat positions.
    // Max error should be < 2 samples at any point (rounding + onset detection).
    const bpm = 155
    const durationSeconds = 300 // 5 minutes
    const numBeats = Math.floor((durationSeconds * bpm) / 60)
    const spbExact = setupClick(bpm, durationSeconds + 10) // extra margin
    const totalFrames = Math.ceil(spbExact * numBeats) + 1000

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 256)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    expect(onsets.length).toBeGreaterThanOrEqual(numBeats - 1)

    // Verify zero cumulative drift — every single onset must be within 2 samples
    // of its ideal position, even after hundreds of beats
    verifyPrecision(onsets, spbExact, '155BPM-5min')

    // Extra check: compare last onset to ideal position
    if (onsets.length > 0) {
      const lastOnset = onsets[onsets.length - 1]!
      const lastBeatNum = Math.round(lastOnset / spbExact)
      const idealLast = lastBeatNum * spbExact
      const driftAtEnd = Math.abs(lastOnset - idealLast)
      console.log(
        `Last onset at frame ${lastOnset}, beat #${lastBeatNum}, drift ${driftAtEnd.toFixed(2)} samples (${((driftAtEnd / SAMPLE_RATE) * 1000).toFixed(3)}ms)`
      )
      expect(driftAtEnd).toBeLessThanOrEqual(2)
    }
  })

  test('212 BPM, 3 minutes — high BPM stress test', () => {
    const bpm = 212
    const durationSeconds = 180
    const numBeats = Math.floor((durationSeconds * bpm) / 60)
    const spbExact = setupClick(bpm, durationSeconds + 10) // extra margin
    const totalFrames = Math.ceil(spbExact * numBeats) + 1000

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 256)
    lib.symbols.tuidaw_stop()

    const onsets = findClickOnsets(output, 0.05)
    expect(onsets.length).toBeGreaterThanOrEqual(numBeats - 1)
    verifyPrecision(onsets, spbExact, '212BPM-3min')
  })

  test('120 BPM, loop region — click plays on every loop iteration', () => {
    // Bug reproduction: click plays on first entry into loop region but
    // goes silent on subsequent iterations.
    //
    // Setup: 120 BPM (spb = 24000), loop from beat 2 to beat 6 (4 beats per loop).
    // Play from position 0. The loop region is [48000, 144000).
    // After 6 beats of playback (reaching beat 6), loop wraps to beat 2.
    // We render enough for ~3 full loop iterations (12 beats in loop + 2 lead-in = 14 beats total output).
    const bpm = 120
    const spbExact = (60 / bpm) * SAMPLE_RATE // 24000 exactly
    const loopStartBeat = 2
    const loopEndBeat = 6
    const loopStart = loopStartBeat * spbExact // 48000
    const loopEnd = loopEndBeat * spbExact // 144000
    const loopLenBeats = loopEndBeat - loopStartBeat // 4 beats per iteration

    // Total output: 2 beats lead-in + 3 full loop iterations (12 beats) = 14 beats
    const totalOutputBeats = loopStartBeat + loopLenBeats * 3
    const totalFrames = Math.ceil(spbExact * totalOutputBeats) - 10

    const durationFrames = Math.ceil(spbExact * (totalOutputBeats + 2)) // buffer margin
    lib.symbols.tuidaw_generate_click(bpm, durationFrames)
    lib.symbols.tuidaw_set_click(1, bpm)
    lib.symbols.tuidaw_set_click_volume(1.0)
    lib.symbols.tuidaw_set_click_pan(0.0)
    lib.symbols.tuidaw_set_loop(loopStart, loopEnd)
    lib.symbols.tuidaw_set_speed(1.0)

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 256)
    lib.symbols.tuidaw_stop()

    // Reset loop for other tests
    lib.symbols.tuidaw_set_loop(-1, -1)

    const onsets = findClickOnsets(output, 0.05)

    // Expected: 14 clicks total (2 lead-in + 4 per iteration × 3 iterations)
    // Each click should align with a beat position in the output.
    console.log(
      `Loop click test: found ${onsets.length} onsets (expected ${totalOutputBeats})`
    )
    for (let i = 0; i < onsets.length; i++) {
      console.log(
        `  onset ${i}: frame ${onsets[i]} (${(onsets[i]! / spbExact).toFixed(3)} beats)`
      )
    }

    expect(onsets.length).toBe(totalOutputBeats)

    // Verify that clicks are evenly spaced at spbExact intervals.
    // After the lead-in (beats 0,1), we enter the loop. Each iteration should
    // have 4 clicks. The output-space beat spacing should be constant (spbExact).
    for (let i = 1; i < onsets.length; i++) {
      const gap = onsets[i]! - onsets[i - 1]!
      const error = Math.abs(gap - spbExact)
      if (error > 2) {
        console.log(
          `  Gap ${i - 1}→${i}: ${gap} samples (expected ${spbExact}), error ${error.toFixed(2)}`
        )
      }
      expect(error).toBeLessThanOrEqual(2)
    }
  })

  test('155 BPM, loop region — click on every iteration (fractional spb)', () => {
    // Same test with fractional samples-per-beat to stress GCD math + loop reset.
    const bpm = 155
    const spbExact = (60 / bpm) * SAMPLE_RATE // 18580.6451...
    const loopStartBeat = 4
    const loopEndBeat = 8
    const loopStart = Math.round(loopStartBeat * spbExact)
    const loopEnd = Math.round(loopEndBeat * spbExact)
    const loopLenBeats = loopEndBeat - loopStartBeat

    // 4 lead-in beats + 3 full loop iterations (12 beats) = 16 beats output
    const totalOutputBeats = loopStartBeat + loopLenBeats * 3
    const totalFrames = Math.ceil(spbExact * totalOutputBeats) - 10

    const durationFrames = Math.ceil(spbExact * (totalOutputBeats + 4))
    lib.symbols.tuidaw_generate_click(bpm, durationFrames)
    lib.symbols.tuidaw_set_click(1, bpm)
    lib.symbols.tuidaw_set_click_volume(1.0)
    lib.symbols.tuidaw_set_click_pan(0.0)
    lib.symbols.tuidaw_set_loop(loopStart, loopEnd)
    lib.symbols.tuidaw_set_speed(1.0)

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 256)
    lib.symbols.tuidaw_stop()

    lib.symbols.tuidaw_set_loop(-1, -1)

    const onsets = findClickOnsets(output, 0.05)

    console.log(
      `Loop click 155 BPM: found ${onsets.length} onsets (expected ${totalOutputBeats})`
    )
    for (let i = 0; i < onsets.length; i++) {
      console.log(
        `  onset ${i}: frame ${onsets[i]} (${(onsets[i]! / spbExact).toFixed(3)} beats)`
      )
    }

    expect(onsets.length).toBe(totalOutputBeats)

    // Verify even spacing
    for (let i = 1; i < onsets.length; i++) {
      const gap = onsets[i]! - onsets[i - 1]!
      const error = Math.abs(gap - spbExact)
      if (error > 2) {
        console.log(
          `  Gap ${i - 1}→${i}: ${gap} samples (expected ${spbExact}), error ${error.toFixed(2)}`
        )
      }
      expect(error).toBeLessThanOrEqual(2)
    }
  })

  test('120 BPM at 0.75x speed, loop region — click on every iteration', () => {
    // Test loop + non-1.0 speed. Display BPM = 120 * 0.75 = 90 BPM.
    // The click buffer is generated at display BPM (90). Content advances at 0.75x.
    // Loop region is in content-space.
    const originalBpm = 120
    const speed = 0.75
    const displayBpm = originalBpm * speed // 90
    const spbDisplay = (60 / displayBpm) * SAMPLE_RATE // output-space beat interval at 90 BPM = 32000

    const spbContent = (60 / originalBpm) * SAMPLE_RATE // 24000 content-space
    const loopStartBeat = 2
    const loopEndBeat = 6
    const loopStart = loopStartBeat * spbContent // 48000 (content-space)
    const loopEnd = loopEndBeat * spbContent // 144000 (content-space)
    const loopLenBeats = loopEndBeat - loopStartBeat // 4 content beats per iteration

    // At 0.75x speed, each content beat takes spbDisplay output frames.
    // Lead-in: 2 content beats = 2 output beats. Loop: 3 iterations × 4 beats = 12.
    // Total output beats: 14.
    const totalOutputBeats = loopStartBeat + loopLenBeats * 3
    const totalOutputFrames = Math.ceil(spbDisplay * totalOutputBeats) - 10

    const durationFrames = Math.ceil(spbDisplay * (totalOutputBeats + 4))
    lib.symbols.tuidaw_generate_click(displayBpm, durationFrames)
    lib.symbols.tuidaw_set_click(1, displayBpm)
    lib.symbols.tuidaw_set_click_volume(1.0)
    lib.symbols.tuidaw_set_click_pan(0.0)
    lib.symbols.tuidaw_set_loop(loopStart, loopEnd)
    lib.symbols.tuidaw_set_speed(speed)

    // Need a track with audio for WSOLA to work (otherwise playhead just advances at 1x)
    const trackLen = Math.ceil(loopEnd + spbContent * 2) // enough content
    const trackSamples = new Float32Array(trackLen)
    for (let i = 0; i < trackLen; i++) trackSamples[i] = 0.001 // quiet
    pinnedBuffers.push(trackSamples)
    lib.symbols.tuidaw_add_track(200)
    lib.symbols.tuidaw_set_track_samples(
      200,
      ptr(trackSamples),
      trackSamples.length
    )
    lib.symbols.tuidaw_set_track_volume(200, 0.01)
    lib.symbols.tuidaw_set_track_muted(200, 0)

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalOutputFrames, 256)
    lib.symbols.tuidaw_stop()

    lib.symbols.tuidaw_set_loop(-1, -1)
    lib.symbols.tuidaw_set_speed(1.0)
    lib.symbols.tuidaw_remove_track(200)

    const onsets = findClickOnsets(output, 0.05)

    console.log(
      `Loop click 0.75x: found ${onsets.length} onsets (expected ${totalOutputBeats})`
    )
    for (let i = 0; i < onsets.length; i++) {
      console.log(
        `  onset ${i}: frame ${onsets[i]} (${(onsets[i]! / spbDisplay).toFixed(3)} output beats)`
      )
    }

    expect(onsets.length).toBe(totalOutputBeats)

    // Verify even spacing at display BPM rate
    for (let i = 1; i < onsets.length; i++) {
      const gap = onsets[i]! - onsets[i - 1]!
      const error = Math.abs(gap - spbDisplay)
      if (error > 2) {
        console.log(
          `  Gap ${i - 1}→${i}: ${gap} samples (expected ${spbDisplay}), error ${error.toFixed(2)}`
        )
      }
      expect(error).toBeLessThanOrEqual(2)
    }
  })

  test('120 BPM, off-beat loop — click stays on beat grid across iterations', () => {
    // Loop boundaries NOT on beat boundaries. The click must still fire
    // at beat-grid positions inside the loop, and the pattern must repeat
    // identically on each loop iteration.
    //
    // 120 BPM, spb = 24000. Loop from sample 10000 to 58000 (off-beat).
    // Beat grid: 0, 24000, 48000, 72000...
    // Beats inside loop: 24000 and 48000 → 2 clicks per iteration.
    // Lead-in: beat 0 at frame 0 (before loop). Then playhead enters loop at 10000.
    // First iteration: beats at 24000, 48000 (output = content at 1.0x).
    // Second iteration: content wraps to 10000. Beats at 24000, 48000 again.
    //   Output-space: these are at 10000+14000=24000 from wrap... no, the click
    //   counter wraps too, so counter goes back to (10000/1.0)=10000.
    //   Next beat in buffer at 24000 → 14000 frames after wrap. Output frame = 48000+14000=62000? No...
    //
    // Actually: counter wraps to output_start = 10000. Click buffer has beats at
    // 0, 24000, 48000, 72000... Counter at 10000 → next beat at 24000 in buffer
    // is 14000 frames away. The gap from last click (at 48000 in buffer, i.e.
    // output frame 48000) to next click is: wrap happens at output_end = 58000,
    // counter resets to 10000, then 14000 more → beat at output 58000+14000 = 72000?
    // No, the counter IS the index into the buffer. After wrap, counter=10000,
    // advances normally. Next beat in buffer at 24000 is 14000 frames away.
    //
    // So output frames: beat0=0, beat24000=24000, beat48000=48000,
    // then wrap at 58000 (counter→10000), beat24000 again at counter=24000
    // which is 58000+(24000-10000) = 72000 output frame.
    // Then beat48000 at counter=48000, output 58000+(48000-10000) = 96000.
    // Then wrap at counter=58000 again, output 58000+48000 = 106000... wait.
    //
    // Let me just verify with the test output.
    const bpm = 120
    const spbExact = (60 / bpm) * SAMPLE_RATE // 24000
    const loopStart = 10000 // off-beat
    const loopEnd = 58000 // off-beat
    const loopLen = loopEnd - loopStart // 48000 = exactly 2 beats (by coincidence)

    // Render: lead-in + 4 loop iterations
    // Lead-in: 0 to 10000 (not a full beat, but beat 0 fires at frame 0)
    // Actually at speed 1.0, playhead reaches loopEnd at output frame 58000.
    // Then loops. Each iteration is 48000 output frames.
    // Total: lead-in to loopEnd (58000) + 3 more iterations (3*48000=144000) = 202000
    const totalFrames = 58000 + 48000 * 3 - 10 // ~4 iterations

    const durationFrames = totalFrames + SAMPLE_RATE
    lib.symbols.tuidaw_generate_click(bpm, durationFrames)
    lib.symbols.tuidaw_set_click(1, bpm)
    lib.symbols.tuidaw_set_click_volume(1.0)
    lib.symbols.tuidaw_set_click_pan(0.0)
    lib.symbols.tuidaw_set_loop(loopStart, loopEnd)
    lib.symbols.tuidaw_set_speed(1.0)

    lib.symbols.tuidaw_play(0)
    const output = renderChunked(totalFrames, 256)
    lib.symbols.tuidaw_stop()
    lib.symbols.tuidaw_set_loop(-1, -1)

    const onsets = findClickOnsets(output, 0.05)

    console.log(`Off-beat loop: found ${onsets.length} onsets`)
    for (let i = 0; i < onsets.length; i++) {
      console.log(
        `  onset ${i}: frame ${onsets[i]} (${(onsets[i]! / spbExact).toFixed(3)} beats)`
      )
    }

    // Expected pattern: beat 0 at frame 0, then beats at 24000 and 48000 in each
    // loop iteration. The loop is 48000 frames = 2 beats.
    // Iteration 1 (first pass): beats at 0, 24000, 48000 (3 clicks)
    // Then wrap at 58000. Counter resets to 10000.
    // Iteration 2: counter at 10000, next beats at 24000 (+14000), 48000 (+38000)
    //   Output: 58000+14000=72000, 58000+38000=96000
    // Iteration 3: wrap at 58000 again (counter). Output: 72000+48000=...
    // Actually, each loop iteration adds 48000 output frames and has 2 beats inside.
    // Plus 1 beat at frame 0 before the loop. Total = 1 + 2*4 = 9 clicks.
    // But the 4th iteration is cut short by 10 frames, might lose the last beat.
    // Let's just verify all onsets are on the beat grid.
    expect(onsets.length).toBeGreaterThanOrEqual(7) // at least 1 + 2*3

    // Every onset must land on a multiple of spbExact (beat grid position)
    for (let i = 0; i < onsets.length; i++) {
      const frame = onsets[i]!
      const beatNum = Math.round(frame / spbExact)
      const idealPos = beatNum * spbExact
      const error = Math.abs(frame - idealPos)
      if (error > 2) {
        console.log(
          `  Off-beat: onset ${i} at ${frame}, nearest beat ${beatNum} at ${idealPos}, error ${error}`
        )
      }
      expect(error).toBeLessThanOrEqual(2)
    }
  })
})
