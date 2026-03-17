// ============================================================================
// tuidaw - Braille Waveform Renderer
// ============================================================================
// Each braille character is a 2x4 pixel grid.
// We map audio sample amplitudes to vertical dot positions within each
// character cell, giving us sub-character resolution for waveforms.

import { BRAILLE_BASE, BRAILLE_DOTS } from "./types"

/**
 * Render a waveform segment as an array of braille characters.
 *
 * @param samples - Float32 audio samples (-1..1)
 * @param width - Number of braille characters wide
 * @param height - Number of braille characters tall
 * @param offset - Sample offset to start from
 * @param samplesPerColumn - How many samples each sub-column (2 per char) represents
 * @returns 2D array [row][col] of braille character strings
 */
export function renderBrailleWaveform(
  samples: Float32Array,
  width: number,
  height: number,
  offset: number = 0,
  samplesPerColumn: number = 1,
): string[][] {
  // Total vertical resolution in dots
  const totalDotsY = height * 4
  const midY = totalDotsY / 2

  // Initialize grid of braille code points
  const grid: number[][] = []
  for (let row = 0; row < height; row++) {
    grid[row] = new Array(width).fill(BRAILLE_BASE)
  }

  // For each character column, we have 2 sub-columns
  for (let col = 0; col < width; col++) {
    for (let subCol = 0; subCol < 2; subCol++) {
      const sampleStart = offset + (col * 2 + subCol) * samplesPerColumn
      if (sampleStart >= samples.length) continue

      // Get peak amplitude for this sub-column
      let peak = 0
      const end = Math.min(sampleStart + samplesPerColumn, samples.length)
      for (let i = sampleStart; i < end; i++) {
        const abs = Math.abs(samples[i])
        if (abs > peak) peak = abs
      }

      // Also get the actual signed sample for waveform direction
      let avg = 0
      let count = 0
      for (let i = sampleStart; i < end; i++) {
        avg += samples[i]
        count++
      }
      avg = count > 0 ? avg / count : 0

      // Map amplitude to dot positions around center
      // The waveform extends both up and down from center
      const extent = Math.floor(peak * midY)

      // Determine the range of dots to fill
      const dotTop = Math.max(0, Math.floor(midY - extent))
      const dotBottom = Math.min(totalDotsY - 1, Math.floor(midY + extent))

      // If it's a very quiet signal, still show the center line
      const startDot = peak < 0.01 ? Math.floor(midY) : dotTop
      const endDot = peak < 0.01 ? Math.floor(midY) : dotBottom

      for (let dot = startDot; dot <= endDot; dot++) {
        const row = Math.floor(dot / 4)
        const dotInRow = dot % 4
        if (row >= 0 && row < height) {
          grid[row][col] |= BRAILLE_DOTS[subCol][dotInRow]
        }
      }
    }
  }

  // Convert code points to character strings
  const result: string[][] = []
  for (let row = 0; row < height; row++) {
    result[row] = []
    for (let col = 0; col < width; col++) {
      result[row][col] = String.fromCodePoint(grid[row][col])
    }
  }

  return result
}

/**
 * Render a simple amplitude bar for sidebar level meter.
 * Returns a string of braille characters representing the level.
 */
export function renderLevelMeter(level: number, width: number): string {
  const filled = Math.floor(level * width * 2) // sub-char resolution
  let result = ""

  for (let i = 0; i < width; i++) {
    const subFilled = Math.min(2, Math.max(0, filled - i * 2))
    if (subFilled === 2) {
      result += "█"
    } else if (subFilled === 1) {
      result += "▌"
    } else {
      result += "░"
    }
  }

  return result
}

/**
 * Get the peak level of a samples segment for VU meter display.
 */
export function getPeakLevel(samples: Float32Array, start: number, length: number): number {
  let peak = 0
  const end = Math.min(start + length, samples.length)
  for (let i = start; i < end; i++) {
    const abs = Math.abs(samples[i])
    if (abs > peak) peak = abs
  }
  return peak
}
