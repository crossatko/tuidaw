// BPM detection test: test all WAV files in a directory across different regions
import { AudioEngine } from "./src/audio-engine"

const engine = new AudioEngine()

const wavFiles = [
  "/home/kreejzak/Downloads/s1/2.wav",
  "/home/kreejzak/Downloads/s1/1 - SEVERED1 master 04 - 48_24.wav",
  "/home/kreejzak/Downloads/s1/1 - SEVERED1 master 06 - 48_24.wav",
  "/home/kreejzak/Downloads/s1/2 - SEVERED1 master 04 - 48_24.wav",
  "/home/kreejzak/Downloads/s1/2 - SEVERED1 master 06 - 48_24.wav",
]

for (const filePath of wavFiles) {
  console.log(`\n${"=".repeat(70)}`)
  console.log(`File: ${filePath.split("/").pop()}`)
  console.log("=".repeat(70))

  const result = await engine.loadWavFile(filePath)
  if (!result) {
    console.log("  Failed to load WAV file")
    continue
  }

  const { samples, sampleRate } = result
  const duration = samples.length / sampleRate
  console.log(`  Duration: ${duration.toFixed(1)}s, Rate: ${sampleRate}, Samples: ${samples.length}`)

  // Full file
  const bpmFull = engine.detectBPM(samples, sampleRate)
  console.log(`  Full file BPM: ${bpmFull}`)

  // Quarters
  for (let q = 0; q < 4; q++) {
    const qStart = Math.floor(samples.length * q / 4)
    const qEnd = Math.floor(samples.length * (q + 1) / 4)
    const qSamples = samples.slice(qStart, qEnd)
    const bpm = engine.detectBPM(qSamples, sampleRate)
    console.log(`  Q${q+1} (${(qStart/sampleRate).toFixed(0)}s-${(qEnd/sampleRate).toFixed(0)}s): ${bpm}`)
  }

  // Middle 60s
  const midStart = Math.max(0, Math.floor(samples.length / 2 - sampleRate * 30))
  const midEnd = Math.min(samples.length, Math.floor(samples.length / 2 + sampleRate * 30))
  const midBpm = engine.detectBPM(samples.slice(midStart, midEnd), sampleRate)
  console.log(`  Middle 60s: ${midBpm}`)
}

process.exit(0)
