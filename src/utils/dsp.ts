// Pure DSP utility functions shared between TUI and Web UI

/**
 * Resample audio using linear interpolation.
 * @param samples Source audio samples
 * @param fromRate Source sample rate
 * @param toRate Target sample rate
 * @returns Resampled audio at the target rate
 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
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
