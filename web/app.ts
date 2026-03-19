// ============================================================================
// tuidaw Web App — Canvas 2D DAW interface
// ============================================================================
// Entry point for the browser. Loaded as a bundled ES module.
// Uses Canvas 2D for waveform rendering and the WASM audio engine.

import { WebAudioBridge, type WebTrack } from "./audio-bridge"
import { detectBPM, findBeatOffset } from "../src/utils/bpm"
import { resample } from "../src/utils/dsp"

// ── Tokyo Night Colors ──────────────────────────────────────────────────
const Colors = {
  bg: "#1a1b26",
  bgDark: "#16161e",
  bgHighlight: "#292e42",
  fg: "#c0caf5",
  fgDim: "#565f89",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  green: "#9ece6a",
  magenta: "#bb9af7",
  red: "#f7768e",
  orange: "#ff9e64",
  yellow: "#e0af68",
} as const

const TRACK_COLORS = [
  "#7aa2f7", "#9ece6a", "#f7768e", "#ff9e64",
  "#bb9af7", "#7dcfff", "#e0af68", "#73daca",
]

const SAMPLE_RATE = 48000

// ── App State ───────────────────────────────────────────────────────────
interface AppState {
  tracks: WebTrack[]
  selectedTrackIndex: number
  transportState: "stopped" | "playing" | "recording"
  playheadPosition: number
  scrollOffset: number
  bpm: number
  originalBpm: number
  clickEnabled: boolean
  clickVolume: number
  clickPan: number
  loopStart: number | null
  loopEnd: number | null
  sampleRate: number
  statusMessage: string
  statusTimeout: ReturnType<typeof setTimeout> | null
}

function createDefaultState(): AppState {
  return {
    tracks: [createTrack("Track 1", 0)],
    selectedTrackIndex: 0,
    transportState: "stopped",
    playheadPosition: 0,
    scrollOffset: 0,
    bpm: 120,
    originalBpm: 120,
    clickEnabled: false,
    clickVolume: 0.5,
    clickPan: 0,
    loopStart: null,
    loopEnd: null,
    sampleRate: SAMPLE_RATE,
    statusMessage: "",
    statusTimeout: null,
  }
}

let nextTrackNum = 2
function createTrack(name: string, colorIndex: number): WebTrack {
  return {
    id: crypto.randomUUID(),
    name,
    color: TRACK_COLORS[colorIndex % TRACK_COLORS.length],
    volume: 0.8,
    pan: 0,
    muted: false,
    solo: false,
    armed: false,
    samples: null,
    sampleRate: SAMPLE_RATE,
  }
}

// ── DOM Elements ────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!
const loadingEl = $("loading") as HTMLDivElement
const loadingStatus = $("loading-status") as HTMLParagraphElement
const btnPlay = $("btn-play") as HTMLButtonElement
const bpmDisplay = $("bpm-display") as HTMLDivElement
const speedDisplay = $("speed-display") as HTMLDivElement
const timeDisplay = $("time-display") as HTMLDivElement
const statusMessage = $("status-message") as HTMLDivElement
const sidebar = $("sidebar") as HTMLDivElement
const timelineCanvas = $("timeline-canvas") as HTMLCanvasElement
const waveformCanvas = $("waveform-canvas") as HTMLCanvasElement
const timelineCtx = timelineCanvas.getContext("2d")!
const waveformCtx = waveformCanvas.getContext("2d")!

// ── Initialize ──────────────────────────────────────────────────────────
const audio = new WebAudioBridge()
const state = createDefaultState()
let playheadInterval: ReturnType<typeof setInterval> | null = null
let animFrameId: number | null = null
let audioInitPromise: Promise<void> | null = null
let audioInitStarted = false

async function init() {
  loadingStatus.textContent = "Loading WASM audio engine..."

  try {
    // Load the Emscripten glue script (defines TuidawAudio global)
    await loadScript("/wasm/tuidaw_audio.js")
    loadingStatus.textContent = "Ready — press any key or click to start"
  } catch (err) {
    loadingStatus.textContent = `Failed to load WASM: ${err}`
    console.error("WASM load failed:", err)
  }

  // Hide loading overlay
  setTimeout(() => loadingEl.classList.add("hidden"), 300)

  // Setup UI
  resizeCanvases()
  window.addEventListener("resize", resizeCanvases)
  setupTransportButtons()
  setupKeyboard()
  setupCanvasMouse()
  renderSidebar()
  renderFrame()
}

/** Initialize audio on first user gesture (required by browsers) */
async function ensureAudioReady(): Promise<boolean> {
  if (audio.isReady) return true

  if (audioInitStarted) {
    // Already initializing — wait for it
    if (audioInitPromise) await audioInitPromise
    return audio.isReady
  }

  audioInitStarted = true
  audioInitPromise = (async () => {
    try {
      await audio.init()
      // Sync initial tracks to native engine
      for (const track of state.tracks) {
        audio.syncTrack(track)
      }
    } catch (err) {
      console.error("Audio init failed:", err)
      showStatus(`Audio init failed: ${err}`)
    }
  })()

  await audioInitPromise
  return audio.isReady
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(script)
  })
}

// ── Canvas Sizing ───────────────────────────────────────────────────────
function resizeCanvases() {
  const container = $("canvas-container")
  const rect = container.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1

  timelineCanvas.width = rect.width * dpr
  timelineCanvas.height = 24 * dpr
  timelineCanvas.style.width = `${rect.width}px`
  timelineCanvas.style.height = "24px"
  timelineCtx.scale(dpr, dpr)

  waveformCanvas.width = rect.width * dpr
  waveformCanvas.height = (rect.height - 24) * dpr
  waveformCanvas.style.width = `${rect.width}px`
  waveformCanvas.style.height = `${rect.height - 24}px`
  waveformCtx.scale(dpr, dpr)

  renderFrame()
}

// ── Sidebar Rendering ───────────────────────────────────────────────────
function renderSidebar() {
  sidebar.innerHTML = ""

  // Click track row
  const clickRow = document.createElement("div")
  clickRow.className = `track-row click-track${state.selectedTrackIndex === -1 ? " selected" : ""}`
  clickRow.innerHTML = `
    <div class="track-name">
      <span style="color: ${state.clickEnabled ? Colors.cyan : Colors.fgDim}">&#9833;</span>
      <span style="color: ${state.clickEnabled ? Colors.fg : Colors.fgDim}">Click</span>
      <span class="track-params" style="margin-left: auto">
        V:${Math.round(state.clickVolume * 100)}%
        ${formatPan(state.clickPan)}
      </span>
    </div>
  `
  clickRow.onclick = () => {
    state.selectedTrackIndex = -1
    renderSidebar()
    renderFrame()
  }
  sidebar.appendChild(clickRow)

  // Regular tracks
  for (let i = 0; i < state.tracks.length; i++) {
    const track = state.tracks[i]
    const row = document.createElement("div")
    row.className = `track-row${i === state.selectedTrackIndex ? " selected" : ""}`
    row.innerHTML = `
      <div class="track-name">
        <span class="track-color-dot" style="background: ${track.color}"></span>
        <span>${track.name}</span>
      </div>
      <div class="track-controls">
        <button class="track-btn${track.muted ? " muted" : ""}" data-action="mute" data-idx="${i}">M</button>
        <button class="track-btn${track.solo ? " solo" : ""}" data-action="solo" data-idx="${i}">S</button>
        <button class="track-btn${track.armed ? " armed" : ""}" data-action="arm" data-idx="${i}">R</button>
      </div>
      <div class="track-params">
        V:${Math.round(track.volume * 100)}%
        ${formatPan(track.pan)}
        ${track.samples ? `${(track.samples.length / SAMPLE_RATE).toFixed(1)}s` : "(empty)"}
      </div>
    `
    row.onclick = (e) => {
      // Don't select if clicking a button
      if ((e.target as HTMLElement).tagName === "BUTTON") return
      state.selectedTrackIndex = i
      renderSidebar()
      renderFrame()
    }
    sidebar.appendChild(row)
  }

  // Wire up M/S/R buttons
  sidebar.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const el = e.currentTarget as HTMLElement
      const action = el.dataset.action
      const idx = parseInt(el.dataset.idx!, 10)
      const track = state.tracks[idx]
      if (!track) return

      if (action === "mute") {
        track.muted = !track.muted
        if (audio.isReady) audio.setTrackMuted(track.id, track.muted)
      } else if (action === "solo") {
        track.solo = !track.solo
        if (audio.isReady) audio.setTrackSolo(track.id, track.solo)
      } else if (action === "arm") {
        track.armed = !track.armed
      }
      renderSidebar()
    })
  })
}

function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.01) return "C"
  if (pan < 0) return `L${Math.round(Math.abs(pan) * 100)}`
  return `R${Math.round(pan * 100)}`
}

// ── Canvas Rendering ────────────────────────────────────────────────────
function renderFrame() {
  renderTimeline()
  renderWaveforms()
  updateTopBar()
}

function renderTimeline() {
  const w = timelineCanvas.width / (window.devicePixelRatio || 1)
  const h = 24
  const ctx = timelineCtx

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = Colors.bgDark
  ctx.fillRect(0, 0, w, h)

  const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
  const samplesPerCol = getSamplesPerCol(w)

  // Draw beat markers
  const startBeat = Math.floor(state.scrollOffset / samplesPerBeat)
  const endSample = state.scrollOffset + w * samplesPerCol
  const endBeat = Math.ceil(endSample / samplesPerBeat)

  for (let beat = startBeat; beat <= endBeat; beat++) {
    const samplePos = beat * samplesPerBeat
    const x = (samplePos - state.scrollOffset) / samplesPerCol
    if (x < 0 || x >= w) continue

    const isBar = beat % 4 === 0
    ctx.strokeStyle = isBar ? Colors.fgDim : Colors.bgHighlight
    ctx.lineWidth = isBar ? 1 : 0.5
    ctx.beginPath()
    ctx.moveTo(x, isBar ? 0 : 8)
    ctx.lineTo(x, h)
    ctx.stroke()

    if (isBar) {
      ctx.fillStyle = Colors.fgDim
      ctx.font = "10px monospace"
      ctx.fillText(`${Math.floor(beat / 4) + 1}`, x + 3, 10)
    }
  }

  // Draw loop region
  if (state.loopStart !== null && state.loopEnd !== null) {
    const x1 = (state.loopStart - state.scrollOffset) / samplesPerCol
    const x2 = (state.loopEnd - state.scrollOffset) / samplesPerCol
    ctx.fillStyle = "rgba(122, 162, 247, 0.2)"
    ctx.fillRect(Math.max(0, x1), 0, Math.min(w, x2) - Math.max(0, x1), h)
  }

  // Draw playhead
  const playheadX = (state.playheadPosition - state.scrollOffset) / samplesPerCol
  if (playheadX >= 0 && playheadX <= w) {
    ctx.strokeStyle = Colors.green
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(playheadX, 0)
    ctx.lineTo(playheadX, h)
    ctx.stroke()
  }
}

function renderWaveforms() {
  const dpr = window.devicePixelRatio || 1
  const w = waveformCanvas.width / dpr
  const h = waveformCanvas.height / dpr
  const ctx = waveformCtx

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = Colors.bg
  ctx.fillRect(0, 0, w, h)

  if (state.tracks.length === 0) return

  // Fixed track height matching sidebar (CSS --track-height is 80px)
  const trackHeight = 80
  const samplesPerCol = getSamplesPerCol(w)
  const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
  const totalTrackArea = state.tracks.length * trackHeight

  // Draw beat grid (only within track area)
  const startBeat = Math.floor(state.scrollOffset / samplesPerBeat)
  const endSample = state.scrollOffset + w * samplesPerCol
  const endBeat = Math.ceil(endSample / samplesPerBeat)
  const gridH = Math.min(totalTrackArea, h)

  for (let beat = startBeat; beat <= endBeat; beat++) {
    const samplePos = beat * samplesPerBeat
    const x = (samplePos - state.scrollOffset) / samplesPerCol
    if (x < 0 || x >= w) continue

    const isBar = beat % 4 === 0
    ctx.strokeStyle = isBar ? Colors.bgHighlight : `${Colors.bgHighlight}80`
    ctx.lineWidth = isBar ? 1 : 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, gridH)
    ctx.stroke()
  }

  // Draw loop region (only within track area)
  if (state.loopStart !== null && state.loopEnd !== null) {
    const x1 = (state.loopStart - state.scrollOffset) / samplesPerCol
    const x2 = (state.loopEnd - state.scrollOffset) / samplesPerCol
    ctx.fillStyle = "rgba(122, 162, 247, 0.1)"
    ctx.fillRect(Math.max(0, x1), 0, Math.min(w, x2) - Math.max(0, x1), gridH)
  }

  // Draw each track's waveform
  for (let i = 0; i < state.tracks.length; i++) {
    const track = state.tracks[i]
    const y = i * trackHeight
    const waveH = trackHeight - 4 // 2px padding top/bottom

    // Track separator
    if (i > 0) {
      ctx.strokeStyle = Colors.bgHighlight
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }

    // Waveform
    if (track.samples && track.samples.length > 0) {
      const color = track.muted ? Colors.fgDim : track.color
      ctx.fillStyle = color
      ctx.globalAlpha = track.muted ? 0.3 : 0.7

      for (let col = 0; col < w; col++) {
        const startSample = Math.floor(state.scrollOffset + col * samplesPerCol)
        const endSampleIdx = Math.floor(state.scrollOffset + (col + 1) * samplesPerCol)

        if (startSample >= track.samples.length) break
        if (endSampleIdx < 0) continue

        // Find peak amplitude in this column's sample range
        let peak = 0
        const s = Math.max(0, startSample)
        const e = Math.min(track.samples.length, endSampleIdx)
        for (let j = s; j < e; j++) {
          const v = Math.abs(track.samples[j])
          if (v > peak) peak = v
        }

        // Draw as a bar from center
        const barH = peak * waveH * track.volume
        const centerY = y + 2 + waveH / 2
        ctx.fillRect(col, centerY - barH / 2, 1, Math.max(1, barH))
      }

      ctx.globalAlpha = 1
    } else {
      // Empty track label
      ctx.fillStyle = Colors.fgDim
      ctx.font = "11px monospace"
      ctx.fillText("(empty)", 8, y + trackHeight / 2 + 4)
    }

    // Selected track highlight
    if (i === state.selectedTrackIndex) {
      ctx.strokeStyle = Colors.blue
      ctx.lineWidth = 2
      ctx.strokeRect(0, y + 1, w - 1, trackHeight - 2)
    }
  }

  // Draw playhead (only within track area)
  const playheadX = (state.playheadPosition - state.scrollOffset) / samplesPerCol
  if (playheadX >= 0 && playheadX <= w) {
    ctx.strokeStyle = Colors.green
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(playheadX, 0)
    ctx.lineTo(playheadX, gridH)
    ctx.stroke()
  }
}

function getSamplesPerCol(canvasWidth: number): number {
  // Roughly 10 seconds visible at default zoom
  return Math.max(1, Math.floor(SAMPLE_RATE / (canvasWidth * 2) * 10) * 2)
}

// ── Top Bar Updates ─────────────────────────────────────────────────────
function updateTopBar() {
  bpmDisplay.textContent = `${state.bpm} BPM`

  const speed = state.bpm / state.originalBpm
  if (Math.abs(speed - 1) > 0.001) {
    speedDisplay.textContent = `${Math.round(speed * 100)}%`
  } else {
    speedDisplay.textContent = ""
  }

  const totalSamples = state.playheadPosition
  const seconds = totalSamples / SAMPLE_RATE
  const mins = Math.floor(seconds / 60)
  const secs = (seconds % 60).toFixed(1)
  timeDisplay.textContent = `${mins}:${secs.padStart(4, "0")}`

  // Transport button state
  if (state.transportState !== "stopped") {
    btnPlay.classList.add("active")
    btnPlay.innerHTML = "&#10074;&#10074; Pause"
  } else {
    btnPlay.classList.remove("active")
    btnPlay.innerHTML = "&#9654; Play"
  }
}

function showStatus(msg: string) {
  statusMessage.textContent = msg
  statusMessage.style.opacity = "1"
  if (state.statusTimeout) clearTimeout(state.statusTimeout)
  state.statusTimeout = setTimeout(() => {
    statusMessage.style.opacity = "0"
  }, 3000)
}

// ── Transport ───────────────────────────────────────────────────────────
async function play() {
  const ready = await ensureAudioReady()
  if (!ready) {
    showStatus("Audio engine not ready")
    return
  }

  state.transportState = "playing"

  // Sync all tracks before playing
  for (const track of state.tracks) {
    audio.syncTrack(track)
  }

  // Set up click if enabled
  if (state.clickEnabled) {
    const duration = getClickDuration()
    audio.generateClick(state.bpm, duration)
    audio.setClick(true, state.bpm)
    audio.setClickVolume(state.clickVolume)
    audio.setClickPan(state.clickPan)
  }

  // Set loop if active
  if (state.loopStart !== null && state.loopEnd !== null) {
    audio.setLoop(state.loopStart, state.loopEnd)
  }

  // Set speed
  audio.setSpeed(state.bpm / state.originalBpm)

  // Start playback
  audio.play(state.playheadPosition)

  // Start playhead polling
  startPlayheadPolling()
  renderSidebar()
  renderFrame()
}

function stopTransport() {
  state.transportState = "stopped"
  audio.stop()

  if (playheadInterval) {
    clearInterval(playheadInterval)
    playheadInterval = null
  }
  if (animFrameId) {
    cancelAnimationFrame(animFrameId)
    animFrameId = null
  }

  renderSidebar()
  renderFrame()
}

function startPlayheadPolling() {
  // Use requestAnimationFrame for smooth visual updates
  function tick() {
    if (state.transportState === "stopped") return
    state.playheadPosition = audio.getPlayhead()
    autoScroll()
    renderFrame()
    animFrameId = requestAnimationFrame(tick)
  }
  animFrameId = requestAnimationFrame(tick)
}

function getClickDuration(): number {
  let maxLen = 0
  for (const t of state.tracks) {
    if (t.samples) maxLen = Math.max(maxLen, t.samples.length)
  }
  const speed = state.bpm / state.originalBpm
  const outputDuration = speed > 0 ? Math.ceil(maxLen / speed) : maxLen
  return Math.max(outputDuration + SAMPLE_RATE * 60, SAMPLE_RATE * 600)
}

// ── Scrolling ───────────────────────────────────────────────────────────
function autoScroll() {
  const dpr = window.devicePixelRatio || 1
  const w = waveformCanvas.width / dpr
  const samplesPerCol = getSamplesPerCol(w)
  const visibleSamples = w * samplesPerCol

  if (state.playheadPosition < state.scrollOffset) {
    state.scrollOffset = Math.max(0, state.playheadPosition - Math.floor(visibleSamples * 0.2))
  } else if (state.playheadPosition > state.scrollOffset + visibleSamples * 0.8) {
    state.scrollOffset = state.playheadPosition - Math.floor(visibleSamples * 0.2)
  }
}

function ensurePlayheadVisible() {
  const dpr = window.devicePixelRatio || 1
  const w = waveformCanvas.width / dpr
  const samplesPerCol = getSamplesPerCol(w)
  const visibleSamples = w * samplesPerCol

  if (state.playheadPosition < state.scrollOffset ||
      state.playheadPosition > state.scrollOffset + visibleSamples) {
    state.scrollOffset = Math.max(0, state.playheadPosition - Math.floor(visibleSamples / 2))
  }
}

// ── Transport Buttons ───────────────────────────────────────────────────
function setupTransportButtons() {
  btnPlay.onclick = () => {
    if (state.transportState !== "stopped") {
      stopTransport()
    } else {
      play()
    }
  }
}

// ── Keyboard Shortcuts ──────────────────────────────────────────────────
function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    // Don't handle if typing in an input
    if ((e.target as HTMLElement).tagName === "INPUT") return

    switch (e.key) {
      case " ":
        e.preventDefault()
        if (state.transportState !== "stopped") {
          stopTransport()
        } else {
          play()
        }
        break

      case "m":
        if (state.selectedTrackIndex === -1) {
          state.clickEnabled = !state.clickEnabled
          renderSidebar()
        } else {
          const track = state.tracks[state.selectedTrackIndex]
          if (track) {
            track.muted = !track.muted
            if (audio.isReady) audio.setTrackMuted(track.id, track.muted)
            renderSidebar()
          }
        }
        break

      case "s":
        {
          const track = state.tracks[state.selectedTrackIndex]
          if (track) {
            track.solo = !track.solo
            if (audio.isReady) audio.setTrackSolo(track.id, track.solo)
            renderSidebar()
          }
        }
        break

      case "r":
        {
          const track = state.tracks[state.selectedTrackIndex]
          if (track) {
            track.armed = !track.armed
            renderSidebar()
          }
        }
        break

      case "c":
        state.clickEnabled = !state.clickEnabled
        if (state.transportState !== "stopped") {
          if (state.clickEnabled) {
            audio.generateClick(state.bpm, getClickDuration())
            audio.setClick(true, state.bpm)
            audio.setClickVolume(state.clickVolume)
            audio.setClickPan(state.clickPan)
          } else {
            audio.setClick(false, 0)
          }
        }
        renderSidebar()
        break

      case "+":
      case "=":
        state.bpm = Math.min(300, state.bpm + (e.shiftKey ? 10 : 1))
        if (audio.isReady) audio.setSpeed(state.bpm / state.originalBpm)
        renderFrame()
        break

      case "-":
        state.bpm = Math.max(20, state.bpm - (e.shiftKey ? 10 : 1))
        if (audio.isReady) audio.setSpeed(state.bpm / state.originalBpm)
        renderFrame()
        break

      case "ArrowUp":
      case "k":
        e.preventDefault()
        if (state.selectedTrackIndex > -1) {
          state.selectedTrackIndex--
          renderSidebar()
          renderFrame()
        }
        break

      case "ArrowDown":
      case "j":
        e.preventDefault()
        if (state.selectedTrackIndex < state.tracks.length - 1) {
          state.selectedTrackIndex++
          renderSidebar()
          renderFrame()
        }
        break

      case "ArrowLeft":
      case "h":
        {
          const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
          const scrollAmount = e.shiftKey ? samplesPerBeat * 4 : samplesPerBeat
          state.scrollOffset = Math.max(0, state.scrollOffset - scrollAmount)
          renderFrame()
        }
        break

      case "ArrowRight":
      case "l":
        {
          const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
          const scrollAmount = e.shiftKey ? samplesPerBeat * 4 : samplesPerBeat
          state.scrollOffset += scrollAmount
          renderFrame()
        }
        break

      case "Home":
      case "0":
        state.playheadPosition = 0
        state.scrollOffset = 0
        if (state.transportState !== "stopped") {
          audio.setPlayhead(0)
        }
        renderFrame()
        break

      case "End":
        {
          let maxLen = 0
          for (const t of state.tracks) {
            if (t.samples && t.samples.length > maxLen) maxLen = t.samples.length
          }
          state.playheadPosition = maxLen
          if (state.transportState !== "stopped") {
            audio.setPlayhead(maxLen)
          }
          ensurePlayheadVisible()
          renderFrame()
        }
        break

      case "a":
        if (state.transportState !== "stopped") {
          showStatus("Stop transport first (Space)")
        } else {
          const newTrack = createTrack(`Track ${nextTrackNum++}`, state.tracks.length)
          state.tracks.push(newTrack)
          if (audio.isReady) audio.syncTrack(newTrack)
          state.selectedTrackIndex = state.tracks.length - 1
          renderSidebar()
          renderFrame()
        }
        break

      case "d":
      case "Delete":
        if (state.transportState !== "stopped") {
          showStatus("Stop transport first (Space)")
        } else {
          const track = state.tracks[state.selectedTrackIndex]
          if (track) {
            if (track.samples && track.samples.length > 0) {
              track.samples = null
              if (audio.isReady) audio.setTrackSamples(track.id, null)
              showStatus(`Cleared "${track.name}"`)
            } else if (state.tracks.length > 1) {
              if (audio.isReady) audio.removeTrack(track.id)
              state.tracks.splice(state.selectedTrackIndex, 1)
              if (state.selectedTrackIndex >= state.tracks.length) {
                state.selectedTrackIndex = state.tracks.length - 1
              }
            }
            renderSidebar()
            renderFrame()
          }
        }
        break

      case "i":
      case "I":
        importWav()
        break
    }
  })
}

// ── Canvas Mouse ────────────────────────────────────────────────────────
function setupCanvasMouse() {
  // Scroll to navigate timeline
  waveformCanvas.addEventListener("wheel", (e) => {
    e.preventDefault()
    const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
    const direction = e.deltaY > 0 ? 1 : -1
    state.scrollOffset = Math.max(0, state.scrollOffset + direction * samplesPerBeat)
    renderFrame()
  }, { passive: false })

  timelineCanvas.addEventListener("wheel", (e) => {
    e.preventDefault()
    const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
    const direction = e.deltaY > 0 ? 1 : -1
    state.scrollOffset = Math.max(0, state.scrollOffset + direction * samplesPerBeat)
    renderFrame()
  }, { passive: false })

  // Click on timeline to set playhead
  timelineCanvas.addEventListener("click", (e) => {
    const rect = timelineCanvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const w = rect.width
    const samplesPerCol = getSamplesPerCol(w)
    state.playheadPosition = Math.max(0, Math.floor(state.scrollOffset + x * samplesPerCol))
    if (state.transportState !== "stopped") {
      audio.setPlayhead(state.playheadPosition)
    }
    renderFrame()
  })

  // Click on waveform area to select track
  waveformCanvas.addEventListener("click", (e) => {
    const rect = waveformCanvas.getBoundingClientRect()
    const y = e.clientY - rect.top
    const trackHeight = 80
    const trackIdx = Math.floor(y / trackHeight)
    if (trackIdx >= 0 && trackIdx < state.tracks.length) {
      state.selectedTrackIndex = trackIdx
      renderSidebar()
      renderFrame()
    }
  })
}

// ── WAV Import ──────────────────────────────────────────────────────────
async function importWav() {
  const input = document.createElement("input")
  input.type = "file"
  input.accept = ".wav,audio/wav"

  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return

    showStatus(`Importing: ${file.name}...`)

    try {
      const arrayBuf = await file.arrayBuffer()
      const parsed = parseWavFile(new Uint8Array(arrayBuf))

      if (!parsed) {
        showStatus("Failed to parse WAV file!")
        return
      }

      // Detect BPM before resampling (use original sample rate for accuracy)
      const detectedBPM = detectBPM(parsed.samples, parsed.sampleRate)

      // Resample to project sample rate if needed
      let samples = parsed.sampleRate !== SAMPLE_RATE
        ? resample(parsed.samples, parsed.sampleRate, SAMPLE_RATE)
        : parsed.samples

      // Find beat offset and trim audio so first beat sits at sample 0
      if (detectedBPM) {
        const beatOffset = findBeatOffset(samples, SAMPLE_RATE, detectedBPM)
        if (beatOffset > 0 && beatOffset < samples.length) {
          samples = samples.slice(beatOffset)
        }
      }

      // Set project BPM if project is empty (all tracks have no audio)
      if (detectedBPM) {
        const projectEmpty = state.tracks.every(t => !t.samples || t.samples.length === 0)
        if (projectEmpty) {
          state.bpm = detectedBPM
          state.originalBpm = detectedBPM
        }
      }

      const track = state.tracks[state.selectedTrackIndex]
      if (track) {
        track.samples = samples
        track.sampleRate = SAMPLE_RATE
        track.name = file.name.replace(/\.wav$/i, "")
        if (audio.isReady) audio.setTrackSamples(track.id, samples)
        const bpmInfo = detectedBPM ? ` | ${detectedBPM} BPM` : ""
        showStatus(`Imported: ${file.name} (${(samples.length / SAMPLE_RATE).toFixed(1)}s${bpmInfo})`)
        renderSidebar()
        renderFrame()
      }
    } catch (err) {
      showStatus(`Import error: ${err}`)
      console.error("WAV import failed:", err)
    }
  }

  input.click()
}

/** Minimal WAV parser — 16/24-bit PCM, 32-bit float, mono/stereo, any sample rate.
 *  Returns raw decoded samples at the source sample rate (no resampling). */
function parseWavFile(data: Uint8Array): { samples: Float32Array; sampleRate: number } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  // Check RIFF header
  if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== "RIFF") return null
  if (String.fromCharCode(data[8], data[9], data[10], data[11]) !== "WAVE") return null

  // Scan for fmt and data chunks
  let fmtOffset = -1
  let dataOffset = -1
  let dataSize = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let audioFormat = 0

  let pos = 12
  while (pos < data.length - 8) {
    const chunkId = String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3])
    const chunkSize = view.getUint32(pos + 4, true)

    if (chunkId === "fmt ") {
      fmtOffset = pos + 8
      audioFormat = view.getUint16(fmtOffset, true)
      channels = view.getUint16(fmtOffset + 2, true)
      sampleRate = view.getUint32(fmtOffset + 4, true)
      bitsPerSample = view.getUint16(fmtOffset + 14, true)
    } else if (chunkId === "data") {
      dataOffset = pos + 8
      dataSize = chunkSize
      break
    }

    pos += 8 + chunkSize
    // Align to even boundary
    if (pos % 2 !== 0) pos++
  }

  if (fmtOffset < 0 || dataOffset < 0) return null

  // Decode samples
  let monoSamples: Float32Array

  if (audioFormat === 1 && bitsPerSample === 16) {
    // PCM 16-bit
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
    // PCM 24-bit
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
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    // IEEE 32-bit float
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
    console.error(`Unsupported WAV format: audioFormat=${audioFormat}, bits=${bitsPerSample}`)
    return null
  }

  return { samples: monoSamples, sampleRate }
}

// ── Start ───────────────────────────────────────────────────────────────
init().catch(console.error)
