// ============================================================================
// Shared WAV parsing and encoding utilities
// ============================================================================
// Pure functions operating on Uint8Array/DataView — works in both Bun and browsers.
// No platform-specific APIs (no Buffer, no Bun.write, no DOM).

/** Parse a WAV file from raw bytes. Supports 16/24-bit PCM and 32-bit IEEE float.
 *  Multi-channel files are downmixed to mono. Handles JUNK/LIST/bext chunks.
 *  Returns decoded Float32 samples at the source sample rate (no resampling). */
export function parseWav(data: Uint8Array): { samples: Float32Array; sampleRate: number } | null {
  if (data.length < 44) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  // Check RIFF header
  if (readAscii(data, 0, 4) !== "RIFF") return null
  if (readAscii(data, 8, 4) !== "WAVE") return null

  // Scan for fmt and data chunks (don't assume fixed offsets — files
  // may have JUNK, LIST, bext, or other chunks before fmt)
  let fmtOffset = -1
  let dataOffset = -1
  let dataSize = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let audioFormat = 0

  let pos = 12
  while (pos < data.length - 8) {
    const chunkId = readAscii(data, pos, 4)
    const chunkSize = view.getUint32(pos + 4, true)

    if (chunkId === "fmt ") {
      fmtOffset = pos + 8
      audioFormat = view.getUint16(fmtOffset, true)
      channels = view.getUint16(fmtOffset + 2, true)
      sampleRate = view.getUint32(fmtOffset + 4, true)
      bitsPerSample = view.getUint16(fmtOffset + 14, true)
    } else if (chunkId === "data") {
      dataOffset = pos + 8
      dataSize = Math.min(chunkSize, data.length - (pos + 8))
    }

    pos += 8 + chunkSize
    // RIFF chunks are 2-byte aligned
    if (pos % 2 !== 0) pos++
  }

  if (fmtOffset < 0 || dataOffset < 0 || sampleRate === 0) return null

  // Decode samples (with inline stereo-to-mono downmix)
  let monoSamples: Float32Array

  if (audioFormat === 1 && bitsPerSample === 16) {
    const totalFrames = Math.floor(dataSize / (2 * channels))
    monoSamples = new Float32Array(totalFrames)
    for (let i = 0; i < totalFrames; i++) {
      let sum = 0
      for (let ch = 0; ch < channels; ch++) {
        const offset = dataOffset + (i * channels + ch) * 2
        sum += view.getInt16(offset, true) / 32768
      }
      monoSamples[i] = sum / channels
    }
  } else if (audioFormat === 1 && bitsPerSample === 24) {
    const totalFrames = Math.floor(dataSize / (3 * channels))
    monoSamples = new Float32Array(totalFrames)
    for (let i = 0; i < totalFrames; i++) {
      let sum = 0
      for (let ch = 0; ch < channels; ch++) {
        const offset = dataOffset + (i * channels + ch) * 3
        let val = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)
        if (val & 0x800000) val |= ~0xFFFFFF // sign extend
        sum += val / 8388608
      }
      monoSamples[i] = sum / channels
    }
  } else if ((audioFormat === 3 || (audioFormat === 1 && bitsPerSample === 32)) && bitsPerSample === 32) {
    // IEEE 32-bit float (audioFormat=3) or 32-bit PCM treated as float
    const totalFrames = Math.floor(dataSize / (4 * channels))
    monoSamples = new Float32Array(totalFrames)
    for (let i = 0; i < totalFrames; i++) {
      let sum = 0
      for (let ch = 0; ch < channels; ch++) {
        const offset = dataOffset + (i * channels + ch) * 4
        sum += view.getFloat32(offset, true)
      }
      monoSamples[i] = sum / channels
    }
  } else {
    return null // unsupported format
  }

  return { samples: monoSamples, sampleRate }
}

/** Convert Float32 samples (-1.0..1.0) to signed 16-bit little-endian PCM bytes. */
export function float32ToPcmS16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, Math.round(clamped * 32767), true)
  }
  return out
}

/** Convert signed 16-bit little-endian PCM bytes to Float32 (-1.0..1.0). */
export function pcmS16ToFloat32(data: Uint8Array): Float32Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const numSamples = Math.floor(data.length / 2)
  const float32 = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768
  }
  return float32
}

/** Build a 44-byte RIFF/WAVE header for PCM audio. */
export function buildWavHeader(sampleRate: number, numChannels: number, bitsPerSample: number, dataSize: number): Uint8Array {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)

  writeAscii(header, 0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(header, 8, "WAVE")
  writeAscii(header, 12, "fmt ")
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true)  // audioFormat = PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAscii(header, 36, "data")
  view.setUint32(40, dataSize, true)

  return header
}

/** Encode mono Float32 samples to a complete WAV file (16-bit PCM, mono).
 *  Returns a Uint8Array containing the full WAV file ready to write/download. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcmData = float32ToPcmS16(samples)
  const header = buildWavHeader(sampleRate, 1, 16, pcmData.length)
  const wav = new Uint8Array(header.length + pcmData.length)
  wav.set(header)
  wav.set(pcmData, header.length)
  return wav
}

/** Encode mono Float32 samples to a stereo WAV file (16-bit PCM) with equal-power pan.
 *  Returns a Uint8Array containing the full WAV file. */
export function encodeWavStereo(samples: Float32Array, sampleRate: number, pan: number = 0): Uint8Array {
  const leftGain = Math.cos(((pan + 1) / 2) * (Math.PI / 2))
  const rightGain = Math.sin(((pan + 1) / 2) * (Math.PI / 2))
  const numChannels = 2

  const pcmData = new Uint8Array(samples.length * numChannels * 2)
  const view = new DataView(pcmData.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    const left = Math.round(s * leftGain * 32767)
    const right = Math.round(s * rightGain * 32767)
    view.setInt16(i * 4, Math.max(-32768, Math.min(32767, left)), true)
    view.setInt16(i * 4 + 2, Math.max(-32768, Math.min(32767, right)), true)
  }

  const header = buildWavHeader(sampleRate, numChannels, 16, pcmData.length)
  const wav = new Uint8Array(header.length + pcmData.length)
  wav.set(header)
  wav.set(pcmData, header.length)
  return wav
}

// ── Internal helpers ────────────────────────────────────────────────────

function readAscii(data: Uint8Array, offset: number, length: number): string {
  let s = ""
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(data[offset + i])
  }
  return s
}

function writeAscii(data: Uint8Array, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    data[offset + i] = str.charCodeAt(i)
  }
}
