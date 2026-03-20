// ============================================================================
// useProject — Save/Open/Import project operations
// ============================================================================

import type { WebTrack } from '../../audio-bridge'
import type { ProjectDescriptor, TrackDescriptor } from '@shared/types'
import { parseWav, encodeWav } from '@shared/utils/wav'
import { detectBPM, findBeatOffset } from '@shared/utils/bpm'
import { resample } from '@shared/utils/dsp'
import {
  useAppState,
  showStatus,
  createTrack,
  setNextTrackNum,
  clampTrackScroll,
  SAMPLE_RATE,
  TRACK_COLORS
} from './useAppState'
import { getAudio } from './useAudio'

// ── Tar utilities (pure JS, browser-compatible, USTAR format) ───────────

function tarWriteString(
  buf: Uint8Array,
  offset: number,
  str: string,
  len: number
) {
  for (let i = 0; i < len; i++) {
    buf[offset + i] = i < str.length ? str.charCodeAt(i) : 0
  }
}

function tarWriteOctal(
  buf: Uint8Array,
  offset: number,
  value: number,
  len: number
) {
  const s = value.toString(8).padStart(len - 1, '0')
  for (let i = 0; i < len - 1; i++) buf[offset + i] = s.charCodeAt(i)
  buf[offset + len - 1] = 0
}

function tarComputeChecksum(header: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 32 : header[i]
  }
  return sum
}

function tarCreateEntry(filename: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512)
  tarWriteString(header, 0, filename, 100)
  tarWriteOctal(header, 100, 0o644, 8)
  tarWriteOctal(header, 108, 0, 8)
  tarWriteOctal(header, 116, 0, 8)
  tarWriteOctal(header, 124, data.length, 12)
  tarWriteOctal(header, 136, Math.floor(Date.now() / 1000), 12)
  tarWriteString(header, 257, 'ustar', 6)
  tarWriteString(header, 263, '00', 2)

  const checksum = tarComputeChecksum(header)
  tarWriteOctal(header, 148, checksum, 7)
  header[155] = 32

  const dataBlocks = Math.ceil(data.length / 512) * 512
  const entry = new Uint8Array(512 + dataBlocks)
  entry.set(header)
  entry.set(data, 512)
  return entry
}

function tarCreate(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const entries: Uint8Array[] = []
  let totalSize = 0
  for (const f of files) {
    const entry = tarCreateEntry(f.name, f.data)
    entries.push(entry)
    totalSize += entry.length
  }
  totalSize += 1024 // two zero blocks = end of archive
  const tar = new Uint8Array(totalSize)
  let offset = 0
  for (const entry of entries) {
    tar.set(entry, offset)
    offset += entry.length
  }
  return tar
}

function tarReadOctal(buf: Uint8Array, offset: number, len: number): number {
  let s = ''
  for (let i = 0; i < len; i++) {
    const c = buf[offset + i]
    if (c === 0 || c === 32) break
    s += String.fromCharCode(c)
  }
  return parseInt(s, 8) || 0
}

function tarReadString(buf: Uint8Array, offset: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) {
    const c = buf[offset + i]
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

function tarExtract(tar: Uint8Array): { name: string; data: Uint8Array }[] {
  const files: { name: string; data: Uint8Array }[] = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    let allZero = true
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break

    const name = tarReadString(header, 0, 100)
    const size = tarReadOctal(header, 124, 12)
    const typeFlag = header[156]

    offset += 512
    if (typeFlag === 0 || typeFlag === 48) {
      const data = tar.slice(offset, offset + size)
      const cleanName = name.replace(/^\.\//, '')
      if (cleanName) files.push({ name: cleanName, data })
    }
    offset += Math.ceil(size / 512) * 512
  }
  return files
}

async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  writer.write(data as unknown as BufferSource)
  writer.close()
  const chunks: Uint8Array[] = []
  const reader = cs.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  let totalLen = 0
  for (const c of chunks) totalLen += c.length
  const result = new Uint8Array(totalLen)
  let off = 0
  for (const c of chunks) {
    result.set(c, off)
    off += c.length
  }
  return result
}

async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  writer.write(data as unknown as BufferSource)
  writer.close()
  const chunks: Uint8Array[] = []
  const reader = ds.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  let totalLen = 0
  for (const c of chunks) totalLen += c.length
  const result = new Uint8Array(totalLen)
  let off = 0
  for (const c of chunks) {
    result.set(c, off)
    off += c.length
  }
  return result
}

// ── Import WAV ──────────────────────────────────────────────────────────
// MUST be synchronous entry — Safari blocks programmatic .click() on file
// inputs unless it occurs in the synchronous call stack of a user gesture.

export function importWav(): void {
  const state = useAppState()
  const audio = getAudio()

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.wav,audio/wav,audio/x-wav,audio/*'
  input.style.display = 'none'
  document.body.appendChild(input)

  const cleanup = () => {
    if (input.parentNode) input.parentNode.removeChild(input)
  }

  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    cleanup()
    if (!file) return

    showStatus(`Importing: ${file.name}...`)

    try {
      const arrayBuf = await file.arrayBuffer()
      const parsed = parseWav(new Uint8Array(arrayBuf))

      if (!parsed) {
        showStatus('Failed to parse WAV file!')
        return
      }

      const detectedBPM = detectBPM(parsed.samples, parsed.sampleRate)

      let samples =
        parsed.sampleRate !== SAMPLE_RATE
          ? resample(parsed.samples, parsed.sampleRate, SAMPLE_RATE)
          : parsed.samples

      if (detectedBPM) {
        const beatOffset = findBeatOffset(samples, SAMPLE_RATE, detectedBPM)
        if (beatOffset > 0 && beatOffset < samples.length) {
          samples = samples.slice(beatOffset)
        }
      }

      if (detectedBPM) {
        const projectEmpty = state.tracks.every(
          (t) => !t.samples || t.samples.length === 0
        )
        if (projectEmpty) {
          state.bpm = detectedBPM
          state.originalBpm = detectedBPM
        }
      }

      const track = state.tracks[state.selectedTrackIndex]
      if (track) {
        track.samples = samples
        track.sampleRate = SAMPLE_RATE
        track.name = file.name.replace(/\.wav$/i, '')
        if (audio.isReady) audio.setTrackSamples(track.id, samples)
        const bpmInfo = detectedBPM ? ` | ${detectedBPM} BPM` : ''
        showStatus(
          `Imported: ${file.name} (${(samples.length / SAMPLE_RATE).toFixed(1)}s${bpmInfo})`
        )
      }
    } catch (err) {
      showStatus(`Import error: ${err}`)
      console.error('WAV import failed:', err)
    }
  })

  input.click()
}

// ── Save Project ────────────────────────────────────────────────────────

export async function saveProject(): Promise<void> {
  const state = useAppState()
  if (state.transportState !== 'stopped') {
    showStatus('Stop transport first')
    return
  }

  showStatus('Saving project...')

  try {
    const files: { name: string; data: Uint8Array }[] = []
    const trackDescs: TrackDescriptor[] = []

    for (const track of state.tracks) {
      let wavFile: string | null = null
      if (track.samples && track.samples.length > 0) {
        const safeName = track.id.replace(/[^a-zA-Z0-9_-]/g, '_')
        wavFile = `tracks/${safeName}.wav`
        const wavData = encodeWav(track.samples, track.sampleRate)
        files.push({ name: wavFile, data: wavData })
      }
      trackDescs.push({
        id: track.id,
        name: track.name,
        color: track.color,
        muted: track.muted,
        solo: track.solo,
        armed: track.armed,
        volume: track.volume,
        pan: track.pan,
        sampleRate: track.sampleRate,
        inputDeviceId: null,
        wavFile
      })
    }

    const descriptor: ProjectDescriptor = {
      version: 1,
      projectName: state.projectName,
      bpm: state.bpm,
      originalBpm: state.originalBpm,
      clickEnabled: state.clickEnabled,
      clickVolume: state.clickVolume,
      clickPan: state.clickPan,
      sampleRate: state.sampleRate,
      playheadPosition: state.playheadPosition,
      scrollOffset: state.scrollOffset,
      loopStart: state.loopStart,
      loopEnd: state.loopEnd,
      outputDeviceId: null,
      selectedTrackIndex: state.selectedTrackIndex,
      tracks: trackDescs
    }

    const encoder = new TextEncoder()
    files.unshift({
      name: 'project.json',
      data: encoder.encode(JSON.stringify(descriptor, null, 2))
    })

    const tar = tarCreate(files)
    const gz = await gzipCompress(tar)

    const blob = new Blob([gz.buffer as ArrayBuffer], {
      type: 'application/gzip'
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${state.projectName}.tuidaw`
    a.click()
    URL.revokeObjectURL(url)

    showStatus(`Project saved: ${state.projectName}.tuidaw`)
  } catch (err) {
    showStatus(`Save error: ${err}`)
    console.error('Project save failed:', err)
  }
}

// ── Open Project ────────────────────────────────────────────────────────

export function openProject(): void {
  const state = useAppState()
  const audio = getAudio()

  if (state.transportState !== 'stopped') {
    showStatus('Stop transport first')
    return
  }

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.tuidaw'
  input.style.display = 'none'
  document.body.appendChild(input)

  const cleanup = () => {
    if (input.parentNode) input.parentNode.removeChild(input)
  }

  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    cleanup()
    if (!file) return

    showStatus(`Opening: ${file.name}...`)

    try {
      const arrayBuf = await file.arrayBuffer()
      const gz = new Uint8Array(arrayBuf)
      const tar = await gzipDecompress(gz)
      const entries = tarExtract(tar)

      const projectEntry = entries.find((e) => e.name === 'project.json')
      if (!projectEntry) {
        showStatus('Invalid project file: no project.json found')
        return
      }

      const decoder = new TextDecoder()
      const desc = JSON.parse(
        decoder.decode(projectEntry.data)
      ) as ProjectDescriptor

      const wavMap = new Map<string, Uint8Array>()
      for (const entry of entries) {
        if (entry.name.startsWith('tracks/') && entry.name.endsWith('.wav')) {
          wavMap.set(entry.name, entry.data)
        }
      }

      // Remove old tracks from audio engine
      if (audio.isReady) {
        for (const track of state.tracks) {
          audio.removeTrack(track.id)
        }
      }

      // Rebuild tracks
      const newTracks: WebTrack[] = []
      for (const td of desc.tracks) {
        let samples: Float32Array | null = null
        if (td.wavFile) {
          const wavData = wavMap.get(td.wavFile)
          if (wavData) {
            const parsed = parseWav(wavData)
            if (parsed) samples = parsed.samples
          }
        }
        newTracks.push({
          id: td.id,
          name: td.name,
          color: td.color,
          volume: td.volume,
          pan: td.pan,
          muted: td.muted,
          solo: td.solo,
          armed: td.armed,
          samples,
          sampleRate: td.sampleRate,
          inputDeviceId: null,
          inputChannel: 0
        })
      }

      // Restore state
      state.projectName = desc.projectName
      state.tracks = newTracks
      state.bpm = desc.bpm
      state.originalBpm = desc.originalBpm ?? desc.bpm
      state.clickEnabled = desc.clickEnabled
      state.clickVolume = desc.clickVolume ?? 0.5
      state.clickPan = desc.clickPan ?? 0
      state.sampleRate = desc.sampleRate
      state.playheadPosition = desc.playheadPosition
      state.scrollOffset = desc.scrollOffset
      state.loopStart = desc.loopStart
      state.loopEnd = desc.loopEnd
      state.selectedTrackIndex = Math.min(
        desc.selectedTrackIndex,
        newTracks.length - 1
      )
      state.freeScroll = false
      state.trackScrollY = 0
      clampTrackScroll()

      // Update nextTrackNum
      let maxNum = 0
      for (const t of newTracks) {
        const m = t.name.match(/^Track (\d+)$/)
        if (m) maxNum = Math.max(maxNum, parseInt(m[1]))
      }
      setNextTrackNum(maxNum + 1)

      // Sync all tracks to audio engine
      if (audio.isReady) {
        for (const track of state.tracks) {
          audio.syncTrack(track)
        }
      }

      const baseName = file.name.replace(/\.tuidaw$/i, '')
      showStatus(`Opened: ${baseName} (${newTracks.length} tracks)`)
    } catch (err) {
      showStatus(`Open error: ${err}`)
      console.error('Project open failed:', err)
    }
  })

  input.click()
}
