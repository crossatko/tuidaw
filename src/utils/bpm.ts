// Pure BPM detection and beat-phase alignment functions
// Shared between TUI and Web UI — no FFI or DOM dependencies

/**
 * Refine a coarse BPM estimate using sample-level autocorrelation.
 * Searches ±3 BPM in 0.1 BPM steps, picking the lag with highest normalized correlation.
 */
export function refineBPM(
  samples: Float32Array,
  sampleRate: number,
  coarseBPM: number,
  minBPM: number,
  maxBPM: number
): number {
  const searchRadius = 3 // ±3 BPM
  const step = 0.1
  const refineStart = Math.floor(sampleRate * 1) // skip first 1s
  const refineLen = Math.min(samples.length - refineStart, sampleRate * 30)

  if (refineLen < sampleRate * 2) {
    // Not enough audio for refinement, return coarse result
    return Math.max(minBPM, Math.min(maxBPM, Math.round(coarseBPM)))
  }

  let bestBPM = coarseBPM
  let bestCorr = -Infinity

  for (
    let bpm = coarseBPM - searchRadius;
    bpm <= coarseBPM + searchRadius;
    bpm += step
  ) {
    if (bpm < minBPM || bpm > maxBPM) continue
    const period = Math.round((sampleRate * 60) / bpm)
    if (period >= refineLen) continue

    // Normalized autocorrelation at this lag (subsample every 10th for speed)
    let sum = 0
    let norm1 = 0
    let norm2 = 0
    const n = refineLen - period
    for (let i = 0; i < n; i += 10) {
      const s1 = samples[refineStart + i]
      const s2 = samples[refineStart + i + period]
      sum += s1 * s2
      norm1 += s1 * s1
      norm2 += s2 * s2
    }
    const corr = sum / Math.sqrt(norm1 * norm2 + 1e-20)

    if (corr > bestCorr) {
      bestCorr = corr
      bestBPM = bpm
    }
  }

  return Math.max(minBPM, Math.min(maxBPM, Math.round(bestBPM)))
}

/**
 * Refine multiple BPM candidates and return the one with the best correlation.
 * When candidates are in an octave relationship, applies a bias toward the higher
 * BPM since sample-level autocorrelation is inherently higher at lower frequencies
 * (longer periods have more self-similarity).
 */
export function refineBPMMulti(
  samples: Float32Array,
  sampleRate: number,
  candidates: number[],
  minBPM: number,
  maxBPM: number
): number {
  const searchRadius = 3 // ±3 BPM per candidate
  const step = 0.1
  const refineStart = Math.floor(sampleRate * 1) // skip first 1s
  const refineLen = Math.min(samples.length - refineStart, sampleRate * 30)

  if (refineLen < sampleRate * 2) {
    return Math.max(minBPM, Math.min(maxBPM, Math.round(candidates[0])))
  }

  // Refine each candidate independently
  const refined: { bpm: number; corr: number }[] = []
  for (const coarseBPM of candidates) {
    let bestBPM = coarseBPM
    let bestCorr = -Infinity
    for (
      let bpm = coarseBPM - searchRadius;
      bpm <= coarseBPM + searchRadius;
      bpm += step
    ) {
      if (bpm < minBPM || bpm > maxBPM) continue
      const period = Math.round((sampleRate * 60) / bpm)
      if (period >= refineLen) continue

      let sum = 0,
        norm1 = 0,
        norm2 = 0
      const n = refineLen - period
      for (let i = 0; i < n; i += 10) {
        const s1 = samples[refineStart + i]
        const s2 = samples[refineStart + i + period]
        sum += s1 * s2
        norm1 += s1 * s1
        norm2 += s2 * s2
      }
      const corr = sum / Math.sqrt(norm1 * norm2 + 1e-20)
      if (corr > bestCorr) {
        bestCorr = corr
        bestBPM = bpm
      }
    }
    refined.push({ bpm: bestBPM, corr: bestCorr })
  }

  // Pick the winner: prefer the promoted (first) candidate unless another
  // candidate has significantly higher correlation (> 5% absolute improvement).
  // This counteracts the inherent bias of sample-level autocorrelation toward
  // lower BPM (longer periods = more self-similarity).
  let winner = refined[0]
  for (let i = 1; i < refined.length; i++) {
    if (refined[i].corr > winner.corr + 0.05) {
      winner = refined[i]
    }
  }

  return Math.max(minBPM, Math.min(maxBPM, Math.round(winner.bpm)))
}

/**
 * Detect BPM using two-pass approach:
 *   1. Coarse estimate via onset-based autocorrelation (~2 BPM resolution)
 *   2. Fine refinement via sample-level autocorrelation (0.1 BPM resolution)
 * Returns the most likely BPM in the range [minBPM, maxBPM], or null if detection fails.
 */
export function detectBPM(
  samples: Float32Array,
  sampleRate: number,
  minBPM: number = 60,
  maxBPM: number = 300
): number | null {
  if (samples.length < sampleRate * 4) return null // need at least 4 seconds

  // ── Pass 1: Coarse onset-based autocorrelation ──────────────────────

  // Use up to 60 seconds from the start for analysis (skip first 0.5s)
  const skipSamples = Math.floor(sampleRate * 0.5)
  const analysisLen = Math.min(samples.length - skipSamples, sampleRate * 60)
  if (analysisLen < sampleRate * 4) return null

  // Compute short-time energy in overlapping frames
  const frameSize = Math.floor(sampleRate * 0.02) // 20ms frames
  const hopSize = Math.floor(frameSize / 4) // 75% overlap (~200 fps)
  const numFrames = Math.floor((analysisLen - frameSize) / hopSize) + 1
  if (numFrames < 2) return null

  const energy = new Float32Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    let sum = 0
    const start = skipSamples + f * hopSize
    for (let i = 0; i < frameSize; i++) {
      const s = samples[start + i]
      sum += s * s
    }
    energy[f] = sum / frameSize
  }

  // Onset strength function (half-wave rectified first derivative)
  const onset = new Float32Array(numFrames - 1)
  for (let i = 0; i < onset.length; i++) {
    onset[i] = Math.max(0, energy[i + 1] - energy[i])
  }

  // Normalize onset signal
  let onsetMax = 0
  for (let i = 0; i < onset.length; i++) {
    if (onset[i] > onsetMax) onsetMax = onset[i]
  }
  if (onsetMax > 0) {
    for (let i = 0; i < onset.length; i++) {
      onset[i] /= onsetMax
    }
  }

  // Autocorrelation of onset signal in the BPM range
  const onsetRate = sampleRate / hopSize
  const minLag = Math.floor((60 / maxBPM) * onsetRate)
  const maxLag = Math.ceil((60 / minBPM) * onsetRate)
  if (maxLag >= onset.length) return null

  const acf = new Float32Array(maxLag - minLag + 1)
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    const n = onset.length - lag
    for (let i = 0; i < n; i++) {
      sum += onset[i] * onset[i + lag]
    }
    acf[lag - minLag] = sum / n
  }

  // Find peaks with parabolic interpolation
  const parabolicPeakOffset = (
    left: number,
    center: number,
    right: number
  ): number => {
    const denom = 2 * (2 * center - left - right)
    if (Math.abs(denom) < 1e-10) return 0
    return (left - right) / denom
  }

  const peaks: { lag: number; strength: number }[] = []
  for (let i = 1; i < acf.length - 1; i++) {
    if (acf[i] > acf[i - 1] && acf[i] > acf[i + 1] && acf[i] > 0) {
      const offset = parabolicPeakOffset(acf[i - 1], acf[i], acf[i + 1])
      peaks.push({ lag: i + minLag + offset, strength: acf[i] })
    }
  }

  if (peaks.length === 0) {
    // No peaks found, use the maximum with interpolation
    let bestIdx = 0
    for (let i = 1; i < acf.length; i++) {
      if (acf[i] > acf[bestIdx]) bestIdx = i
    }
    if (acf[bestIdx] <= 0) return null
    let bestLag = bestIdx + minLag
    if (bestIdx > 0 && bestIdx < acf.length - 1) {
      bestLag += parabolicPeakOffset(
        acf[bestIdx - 1],
        acf[bestIdx],
        acf[bestIdx + 1]
      )
    }
    const coarseBPM = (60 * onsetRate) / bestLag
    return refineBPM(samples, sampleRate, coarseBPM, minBPM, maxBPM)
  }

  // Sort by strength descending
  peaks.sort((a, b) => b.strength - a.strength)

  // Iterative octave promotion: keep promoting to double-time if a harmonic
  // peak exists with strength >= 80% of current best. This chains through
  // multiple octaves (e.g. 62.5 → 125 → 250 BPM).
  let bestPeak = peaks[0]
  let promoted = true
  while (promoted) {
    promoted = false
    for (const p of peaks) {
      const ratio = bestPeak.lag / p.lag
      if (ratio > 1.8 && ratio < 2.2 && p.strength > bestPeak.strength * 0.8) {
        bestPeak = p
        promoted = true
        break
      }
    }
  }

  // Collect candidate BPMs: the promoted best peak + any strong ACF peaks
  // that might be the true tempo. Only consider peaks at BPM values BETWEEN
  // the pre-promotion and post-promotion BPM, since the promoted result may
  // have overshot (e.g. 124→230 when real is 185).
  // Exclude candidates that are simple harmonic ratios (3:2, 4:3, 5:3, etc.)
  // of the promoted BPM — those are sub-harmonics, not overshoot corrections.
  const promotedBPM = (60 * onsetRate) / bestPeak.lag
  const prePromotionBPM = (60 * onsetRate) / peaks[0].lag
  const candidates: number[] = [promotedBPM]
  const strengthThreshold = peaks[0].strength * 0.9
  // Exclude candidates that are 3:2 sub-harmonics of the promoted BPM,
  // as these are rhythmic subdivisions, not real tempo alternatives.
  const harmonicRatios = [3 / 2]
  for (const p of peaks) {
    const bpm = (60 * onsetRate) / p.lag
    if (
      p.strength >= strengthThreshold &&
      bpm > prePromotionBPM &&
      bpm < promotedBPM
    ) {
      // Skip if this BPM is a simple harmonic sub-division of the promoted BPM
      const ratio = promotedBPM / bpm
      const isHarmonic = harmonicRatios.some((hr) => Math.abs(ratio - hr) < 0.1)
      if (isHarmonic) continue
      const isDuplicate = candidates.some((c) => Math.abs(c - bpm) < 5)
      if (!isDuplicate) candidates.push(bpm)
    }
  }

  // ── Pass 2: Fine sample-level refinement ────────────────────────────
  // Refine each candidate and pick the one with the best correlation
  return refineBPMMulti(samples, sampleRate, candidates, minBPM, maxBPM)
}

/**
 * Find the sample offset where the beat grid best aligns with the audio's
 * rhythmic structure. Returns the number of samples to trim from the start
 * so that the first beat sits at sample 0.
 *
 * Robust approach — handles intros with non-matching percussion, guitar
 * slides, count-ins, and other non-rhythmic transients:
 *
 * 1. Compute onset strength at ~5ms resolution across the full track
 * 2. Divide audio into overlapping analysis windows (each ~8 bars long)
 * 3. For each window, sweep phase offsets and score using beat-vs-offbeat
 *    contrast (not just raw onset strength). This rejects one-off transients
 *    like guitar slides since they don't repeat periodically.
 * 4. Weight later windows more heavily (intros often have non-matching
 *    patterns; the "real" beat is established after the first few bars)
 * 5. Aggregate scores across all windows — the phase that consistently
 *    scores highest across multiple windows wins
 * 6. Refine the coarse winner at sample level using median onset strength
 *    (robust to outliers) rather than mean
 */
export function findBeatOffset(
  samples: Float32Array,
  sampleRate: number,
  bpm: number
): number {
  const samplesPerBeat = Math.round((60 / bpm) * sampleRate)
  if (samplesPerBeat <= 0 || samples.length < samplesPerBeat * 4) return 0

  // ── Step 1: Compute onset strength ──────────────────────────────────
  const frameSize = Math.floor(sampleRate * 0.005) // 5ms frames
  const hopSize = frameSize
  const numFrames = Math.floor(samples.length / hopSize) - 1
  if (numFrames < 2) return 0

  // Short-time energy per frame
  const energy = new Float32Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    let sum = 0
    const start = f * hopSize
    for (let i = 0; i < frameSize; i++) {
      const s = samples[start + i]
      sum += s * s
    }
    energy[f] = sum / frameSize
  }

  // Onset strength = half-wave rectified energy derivative
  const onset = new Float32Array(numFrames - 1)
  for (let i = 0; i < onset.length; i++) {
    onset[i] = Math.max(0, energy[i + 1] - energy[i])
  }

  // ── Step 2: Phase search parameters ─────────────────────────────────
  const stepsPerBeat = Math.round(samplesPerBeat / hopSize)
  if (stepsPerBeat <= 0) return 0

  // Window size: ~8 bars (32 beats). Overlap by 50%.
  const beatsPerWindow = 32
  const windowFrames = beatsPerWindow * stepsPerBeat
  const windowHop = Math.floor(windowFrames / 2) // 50% overlap
  const numWindows = Math.max(
    1,
    Math.floor((onset.length - windowFrames) / windowHop) + 1
  )

  // Accumulate phase scores across all windows
  const phaseScores = new Float64Array(stepsPerBeat)

  for (let w = 0; w < numWindows; w++) {
    const winStart = w * windowHop
    const winEnd = Math.min(winStart + windowFrames, onset.length)
    const winLen = winEnd - winStart
    if (winLen < stepsPerBeat * 4) continue

    // Weight: later windows get more weight. First window gets 0.5,
    // last gets 1.5. Linear ramp. This de-emphasizes intros.
    const t = numWindows > 1 ? w / (numWindows - 1) : 1
    const weight = 0.5 + t * 1.0

    // Compute mean onset strength across this window for normalization
    let winMean = 0
    for (let i = winStart; i < winEnd; i++) winMean += onset[i]
    winMean /= winLen
    if (winMean < 1e-12) continue // silent window, skip

    for (let phase = 0; phase < stepsPerBeat; phase++) {
      // Collect on-beat onset strengths
      let onBeatSum = 0
      let onBeatCount = 0
      // Collect off-beat onset strengths (midpoints between beats)
      let offBeatSum = 0
      let offBeatCount = 0

      const halfStep = Math.floor(stepsPerBeat / 2)

      for (let beatIdx = phase; beatIdx < winLen; beatIdx += stepsPerBeat) {
        const globalIdx = winStart + beatIdx
        if (globalIdx >= onset.length) break
        onBeatSum += onset[globalIdx]
        onBeatCount++

        // Off-beat = halfway between this beat and the next
        const offIdx = globalIdx + halfStep
        if (offIdx < onset.length && offIdx < winEnd) {
          offBeatSum += onset[offIdx]
          offBeatCount++
        }
      }

      if (onBeatCount < 2) continue

      const onBeatMean = onBeatSum / onBeatCount
      const offBeatMean = offBeatCount > 0 ? offBeatSum / offBeatCount : 0

      // Score = contrast between on-beat and off-beat onset strength.
      // High contrast means rhythmic periodicity at this phase.
      // Normalize by window mean so loud windows don't dominate.
      // Add a small on-beat term to break ties (prefer phases with
      // actual onset energy, not just "both sides are zero").
      const contrast = (onBeatMean - offBeatMean) / (winMean + 1e-12)
      const magnitude = onBeatMean / (winMean + 1e-12)
      const score = contrast * 0.7 + magnitude * 0.3

      phaseScores[phase] += score * weight
    }
  }

  // ── Step 3: Find the best coarse phase ──────────────────────────────
  let bestPhase = 0
  let bestScore = -Infinity
  for (let phase = 0; phase < stepsPerBeat; phase++) {
    if (phaseScores[phase] > bestScore) {
      bestScore = phaseScores[phase]
      bestPhase = phase
    }
  }

  const coarseOffset = bestPhase * hopSize

  // ── Step 4: Refine at sample level using median onset strength ──────
  // Search ±5ms around the coarse winner. For each candidate offset,
  // collect onset strengths at all beat positions and use median instead
  // of mean — this is robust to one-off outliers (guitar slides, etc.)
  const refineRadius = Math.floor(sampleRate * 0.005) // ±5ms
  const refineStart = Math.max(0, coarseOffset - refineRadius)
  const refineEnd = Math.min(samplesPerBeat, coarseOffset + refineRadius)

  // Use the later portion of audio for refinement (skip first 10s or 25%
  // of audio, whichever is less, to avoid intro artifacts)
  const skipSamples = Math.min(
    Math.floor(sampleRate * 10),
    Math.floor(samples.length * 0.25)
  )
  const refineEndSample = Math.min(
    samples.length - 1,
    skipSamples + Math.floor(sampleRate * 30)
  )

  let bestFineOffset = coarseOffset
  let bestFineScore = -Infinity

  // Pre-allocate array for median computation
  const maxBeats = Math.ceil((refineEndSample - skipSamples) / samplesPerBeat)
  const beatStrengths = new Float32Array(maxBeats)

  for (let off = refineStart; off < refineEnd; off++) {
    let count = 0
    // Find first beat position >= skipSamples aligned with phase 'off'
    const firstBeat =
      off + Math.ceil((skipSamples - off) / samplesPerBeat) * samplesPerBeat
    // Collect onset/transient strength at each beat position
    for (
      let pos = firstBeat;
      pos < refineEndSample - 1 && count < maxBeats;
      pos += samplesPerBeat
    ) {
      // Short-window energy spike: sum abs differences in a ~1ms window
      let spike = 0
      const windowLen = Math.min(Math.floor(sampleRate * 0.001), 48) // ~1ms
      for (let j = 0; j < windowLen && pos + j + 1 < samples.length; j++) {
        spike += Math.abs(samples[pos + j + 1] - samples[pos + j])
      }
      beatStrengths[count++] = spike / windowLen
    }

    if (count < 4) continue

    // Median of beat-position onset strengths (robust to outliers)
    const sorted = beatStrengths.slice(0, count).sort()
    const median =
      count % 2 === 0
        ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
        : sorted[Math.floor(count / 2)]

    // Also compute the inter-quartile mean (average of middle 50%)
    // for a balance between robustness and sensitivity
    const q1 = Math.floor(count * 0.25)
    const q3 = Math.ceil(count * 0.75)
    let iqm = 0
    for (let i = q1; i < q3; i++) iqm += sorted[i]
    iqm /= q3 - q1 || 1

    const score = median * 0.4 + iqm * 0.6

    if (score > bestFineScore) {
      bestFineScore = score
      bestFineOffset = off
    }
  }

  return bestFineOffset
}
