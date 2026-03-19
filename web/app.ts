// ============================================================================
// tuidaw Web App — Full-canvas DAW interface
// ============================================================================
// Single <canvas> renders everything: topbar, sidebar, waveforms, statusbar.
// No DOM elements besides the canvas itself (+ hidden file input for import).

import { WebAudioBridge, type WebTrack } from "./audio-bridge"
import { detectBPM, findBeatOffset } from "../src/utils/bpm"
import { resample } from "../src/utils/dsp"
import { parseWav } from "../src/utils/wav"

// ── Tokyo Night Colors ──────────────────────────────────────────────────
const C = {
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

// ── Layout Constants ────────────────────────────────────────────────────
const SIDEBAR_W = 220
const TOPBAR_H = 44
const STATUSBAR_H = 28
const TIMELINE_H = 24
const TRACK_H = 80
const CLICK_ROW_H = 32

// ── App State ───────────────────────────────────────────────────────────
interface AppState {
  tracks: WebTrack[]
  selectedTrackIndex: number
  transportState: "stopped" | "playing" | "recording"
  playheadPosition: number
  scrollOffset: number
  freeScroll: boolean
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
    freeScroll: false,
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

// ── Canvas Setup ────────────────────────────────────────────────────────
const canvas = document.getElementById("app") as HTMLCanvasElement
const ctx = canvas.getContext("2d")!
let dpr = window.devicePixelRatio || 1
let W = 0  // logical width
let H = 0  // logical height

function resize() {
  dpr = window.devicePixelRatio || 1
  W = window.innerWidth
  H = window.innerHeight
  canvas.width = W * dpr
  canvas.height = H * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  render()
}

// ── Audio Engine ────────────────────────────────────────────────────────
const audio = new WebAudioBridge()
const state = createDefaultState()
let animFrameId: number | null = null
let audioInitPromise: Promise<void> | null = null
let audioInitStarted = false

async function ensureAudioReady(): Promise<boolean> {
  if (audio.isReady) return true
  if (audioInitStarted) {
    if (audioInitPromise) await audioInitPromise
    return audio.isReady
  }
  audioInitStarted = true
  audioInitPromise = (async () => {
    try {
      await audio.init()
      for (const track of state.tracks) audio.syncTrack(track)
    } catch (err) {
      console.error("Audio init failed:", err)
      showStatus(`Audio init failed: ${err}`)
    }
  })()
  await audioInitPromise
  return audio.isReady
}

// ── Rendering ───────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, W, H)
  drawTopbar()
  drawSidebar()
  drawTimeline()
  drawWaveformArea()
  drawStatusbar()
}

// ── Topbar ──────────────────────────────────────────────────────────────
function drawTopbar() {
  ctx.fillStyle = C.bgDark
  ctx.fillRect(0, 0, W, TOPBAR_H)

  // Bottom border
  ctx.fillStyle = C.bgHighlight
  ctx.fillRect(0, TOPBAR_H - 1, W, 1)

  const textY = TOPBAR_H / 2 + 5
  let x = 16

  // Play button
  const btnW = 80
  const btnH = 28
  const btnY = (TOPBAR_H - btnH) / 2
  const isPlaying = state.transportState !== "stopped"

  ctx.fillStyle = isPlaying ? C.green : C.bgHighlight
  roundRect(ctx, x, btnY, btnW, btnH, 4)
  ctx.fill()

  ctx.fillStyle = isPlaying ? C.bgDark : C.fg
  ctx.font = "bold 12px monospace"
  ctx.textAlign = "center"
  ctx.fillText(isPlaying ? "|| Pause" : "> Play", x + btnW / 2, textY)
  ctx.textAlign = "left"
  x += btnW + 16

  // BPM
  ctx.fillStyle = C.cyan
  ctx.font = "bold 14px monospace"
  ctx.fillText(`${state.bpm} BPM`, x, textY)
  x += 90

  // Speed
  const speed = state.bpm / state.originalBpm
  if (Math.abs(speed - 1) > 0.001) {
    ctx.fillStyle = C.orange
    ctx.font = "12px monospace"
    ctx.fillText(`${Math.round(speed * 100)}%`, x, textY)
    x += 50
  }

  // Time
  const seconds = state.playheadPosition / SAMPLE_RATE
  const mins = Math.floor(seconds / 60)
  const secs = (seconds % 60).toFixed(1)
  ctx.fillStyle = C.fgDim
  ctx.font = "13px monospace"
  ctx.fillText(`${mins}:${secs.padStart(4, "0")}`, x, textY)

  // Status message (right-aligned)
  if (state.statusMessage) {
    ctx.fillStyle = C.yellow
    ctx.font = "12px monospace"
    ctx.textAlign = "right"
    ctx.fillText(state.statusMessage, W - 16, textY)
    ctx.textAlign = "left"
  }
}

// ── Sidebar ─────────────────────────────────────────────────────────────
function drawSidebar() {
  const sidebarH = H - TOPBAR_H - STATUSBAR_H
  ctx.fillStyle = C.bgDark
  ctx.fillRect(0, TOPBAR_H, SIDEBAR_W, sidebarH)

  // Right border
  ctx.fillStyle = C.bgHighlight
  ctx.fillRect(SIDEBAR_W - 1, TOPBAR_H, 1, sidebarH)

  let y = TOPBAR_H

  // ── Click track row ───────────────────────────────────────────────────
  const isClickSelected = state.selectedTrackIndex === -1

  if (isClickSelected) {
    ctx.fillStyle = C.bgHighlight
    ctx.fillRect(0, y, SIDEBAR_W - 1, CLICK_ROW_H)
    // Selection indicator
    ctx.fillStyle = C.blue
    ctx.fillRect(0, y, 3, CLICK_ROW_H)
  }

  // Bottom border
  ctx.fillStyle = C.bgHighlight
  ctx.fillRect(0, y + CLICK_ROW_H - 1, SIDEBAR_W - 1, 1)

  const clickTextY = y + CLICK_ROW_H / 2 + 4
  const clickColor = state.clickEnabled ? C.cyan : C.fgDim
  const fgColor = state.clickEnabled ? C.fg : C.fgDim

  ctx.font = "12px monospace"
  ctx.fillStyle = clickColor
  ctx.fillText("\u2669", 8, clickTextY)  // ♩ icon

  ctx.fillStyle = fgColor
  ctx.fillText("Click", 22, clickTextY)

  ctx.fillStyle = C.fgDim
  ctx.font = "10px monospace"
  const clickInfo = `V:${Math.round(state.clickVolume * 100)}% ${formatPan(state.clickPan)}`
  ctx.fillText(clickInfo, 70, clickTextY)

  y += CLICK_ROW_H

  // ── Regular tracks ────────────────────────────────────────────────────
  for (let i = 0; i < state.tracks.length; i++) {
    const track = state.tracks[i]
    const isSelected = i === state.selectedTrackIndex

    // Selected background
    if (isSelected) {
      ctx.fillStyle = C.bgHighlight
      ctx.fillRect(0, y, SIDEBAR_W - 1, TRACK_H)
      // Selection indicator
      ctx.fillStyle = C.blue
      ctx.fillRect(0, y, 3, TRACK_H)
    }

    // Bottom border
    ctx.fillStyle = C.bgHighlight
    ctx.fillRect(0, y + TRACK_H - 1, SIDEBAR_W - 1, 1)

    const pad = 8

    // Row 1: color dot + name
    ctx.fillStyle = track.color
    ctx.beginPath()
    ctx.arc(pad + 4, y + 14, 4, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = C.fg
    ctx.font = "bold 12px monospace"
    const maxNameW = SIDEBAR_W - 24
    ctx.save()
    ctx.beginPath()
    ctx.rect(pad + 12, y, maxNameW, 24)
    ctx.clip()
    ctx.fillText(track.name, pad + 12, y + 18)
    ctx.restore()

    // Row 2: M S R buttons
    const btnY = y + 28
    drawSmallButton(ctx, pad, btnY, "M", track.muted, C.orange)
    drawSmallButton(ctx, pad + 26, btnY, "S", track.solo, C.yellow)
    drawSmallButton(ctx, pad + 52, btnY, "R", track.armed, C.red)

    // Row 3: Volume + Pan
    const paramY = y + 52
    ctx.fillStyle = C.fgDim
    ctx.font = "10px monospace"
    ctx.fillText(`V:${Math.round(track.volume * 100)}%`, pad, paramY)
    ctx.fillText(formatPan(track.pan), pad + 60, paramY)

    // Row 4: Duration or (empty)
    const infoY = y + 68
    ctx.fillStyle = C.fgDim
    ctx.font = "10px monospace"
    if (track.samples && track.samples.length > 0) {
      const dur = (track.samples.length / SAMPLE_RATE).toFixed(1)
      ctx.fillText(`${dur}s`, pad, infoY)
    } else {
      ctx.fillText("(empty)", pad, infoY)
    }

    y += TRACK_H
  }
}

function drawSmallButton(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, active: boolean, activeColor: string) {
  const w = 22
  const h = 16

  if (active) {
    ctx.fillStyle = activeColor
    roundRect(ctx, x, y, w, h, 2)
    ctx.fill()
    ctx.fillStyle = C.bgDark
  } else {
    ctx.fillStyle = C.bgHighlight
    roundRect(ctx, x, y, w, h, 2)
    ctx.fill()
    ctx.strokeStyle = C.bgHighlight
    ctx.lineWidth = 1
    roundRect(ctx, x, y, w, h, 2)
    ctx.stroke()
    ctx.fillStyle = C.fgDim
  }

  ctx.font = "bold 10px monospace"
  ctx.textAlign = "center"
  ctx.fillText(label, x + w / 2, y + 12)
  ctx.textAlign = "left"
}

// ── Timeline ────────────────────────────────────────────────────────────
function drawTimeline() {
  const x0 = SIDEBAR_W
  const y0 = TOPBAR_H
  const w = W - SIDEBAR_W
  const h = TIMELINE_H

  ctx.fillStyle = C.bgDark
  ctx.fillRect(x0, y0, w, h)

  // Bottom border
  ctx.fillStyle = C.bgHighlight
  ctx.fillRect(x0, y0 + h - 1, w, 1)

  const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
  const samplesPerCol = getSamplesPerCol(w)

  const startBeat = Math.floor(state.scrollOffset / samplesPerBeat)
  const endSample = state.scrollOffset + w * samplesPerCol
  const endBeat = Math.ceil(endSample / samplesPerBeat)

  for (let beat = startBeat; beat <= endBeat; beat++) {
    const samplePos = beat * samplesPerBeat
    const x = x0 + (samplePos - state.scrollOffset) / samplesPerCol
    if (x < x0 || x >= x0 + w) continue

    const isBar = beat % 4 === 0
    ctx.strokeStyle = isBar ? C.fgDim : C.bgHighlight
    ctx.lineWidth = isBar ? 1 : 0.5
    ctx.beginPath()
    ctx.moveTo(x, y0 + (isBar ? 0 : 8))
    ctx.lineTo(x, y0 + h)
    ctx.stroke()

    if (isBar) {
      ctx.fillStyle = C.fgDim
      ctx.font = "10px monospace"
      ctx.fillText(`${Math.floor(beat / 4) + 1}`, x + 3, y0 + 10)
    }
  }

  // Loop region
  if (state.loopStart !== null && state.loopEnd !== null) {
    const lx1 = x0 + (state.loopStart - state.scrollOffset) / samplesPerCol
    const lx2 = x0 + (state.loopEnd - state.scrollOffset) / samplesPerCol
    ctx.fillStyle = "rgba(122, 162, 247, 0.2)"
    const clampX1 = Math.max(x0, lx1)
    const clampX2 = Math.min(x0 + w, lx2)
    if (clampX2 > clampX1) ctx.fillRect(clampX1, y0, clampX2 - clampX1, h)
  }

  // Playhead
  const playheadX = x0 + (state.playheadPosition - state.scrollOffset) / samplesPerCol
  if (playheadX >= x0 && playheadX <= x0 + w) {
    ctx.strokeStyle = C.green
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(playheadX, y0)
    ctx.lineTo(playheadX, y0 + h)
    ctx.stroke()
  }
}

// ── Waveform Area ───────────────────────────────────────────────────────
function drawWaveformArea() {
  const x0 = SIDEBAR_W
  const y0 = TOPBAR_H + TIMELINE_H
  const w = W - SIDEBAR_W
  const areaH = H - TOPBAR_H - TIMELINE_H - STATUSBAR_H

  ctx.fillStyle = C.bg
  ctx.fillRect(x0, y0, w, areaH)

  if (state.tracks.length === 0) return

  const samplesPerCol = getSamplesPerCol(w)
  const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
  const totalTrackArea = state.tracks.length * TRACK_H
  const gridH = Math.min(totalTrackArea, areaH)

  // Beat grid
  const startBeat = Math.floor(state.scrollOffset / samplesPerBeat)
  const endSample = state.scrollOffset + w * samplesPerCol
  const endBeat = Math.ceil(endSample / samplesPerBeat)

  for (let beat = startBeat; beat <= endBeat; beat++) {
    const samplePos = beat * samplesPerBeat
    const x = x0 + (samplePos - state.scrollOffset) / samplesPerCol
    if (x < x0 || x >= x0 + w) continue

    const isBar = beat % 4 === 0
    ctx.strokeStyle = isBar ? C.bgHighlight : `${C.bgHighlight}80`
    ctx.lineWidth = isBar ? 1 : 0.5
    ctx.beginPath()
    ctx.moveTo(x, y0)
    ctx.lineTo(x, y0 + gridH)
    ctx.stroke()
  }

  // Loop region
  if (state.loopStart !== null && state.loopEnd !== null) {
    const lx1 = x0 + (state.loopStart - state.scrollOffset) / samplesPerCol
    const lx2 = x0 + (state.loopEnd - state.scrollOffset) / samplesPerCol
    ctx.fillStyle = "rgba(122, 162, 247, 0.1)"
    const clampX1 = Math.max(x0, lx1)
    const clampX2 = Math.min(x0 + w, lx2)
    if (clampX2 > clampX1) ctx.fillRect(clampX1, y0, clampX2 - clampX1, gridH)
  }

  // Tracks
  ctx.save()
  ctx.beginPath()
  ctx.rect(x0, y0, w, areaH)
  ctx.clip()

  for (let i = 0; i < state.tracks.length; i++) {
    const track = state.tracks[i]
    const ty = y0 + i * TRACK_H
    const waveH = TRACK_H - 4

    // Track separator
    if (i > 0) {
      ctx.strokeStyle = C.bgHighlight
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x0, ty)
      ctx.lineTo(x0 + w, ty)
      ctx.stroke()
    }

    // Waveform
    if (track.samples && track.samples.length > 0) {
      const color = track.muted ? C.fgDim : track.color
      ctx.fillStyle = color
      ctx.globalAlpha = track.muted ? 0.3 : 0.7

      for (let col = 0; col < w; col++) {
        const startSample = Math.floor(state.scrollOffset + col * samplesPerCol)
        const endSampleIdx = Math.floor(state.scrollOffset + (col + 1) * samplesPerCol)
        if (startSample >= track.samples.length) break
        if (endSampleIdx < 0) continue

        let peak = 0
        const s = Math.max(0, startSample)
        const e = Math.min(track.samples.length, endSampleIdx)
        for (let j = s; j < e; j++) {
          const v = Math.abs(track.samples[j])
          if (v > peak) peak = v
        }

        const barH = peak * waveH * track.volume
        const centerY = ty + 2 + waveH / 2
        ctx.fillRect(x0 + col, centerY - barH / 2, 1, Math.max(1, barH))
      }

      ctx.globalAlpha = 1
    } else {
      ctx.fillStyle = C.fgDim
      ctx.font = "11px monospace"
      ctx.fillText("(empty)", x0 + 8, ty + TRACK_H / 2 + 4)
    }

    // Selected track highlight
    if (i === state.selectedTrackIndex) {
      ctx.strokeStyle = C.blue
      ctx.lineWidth = 2
      ctx.strokeRect(x0, ty + 1, w - 1, TRACK_H - 2)
    }
  }

  ctx.restore()

  // Playhead
  const playheadX = x0 + (state.playheadPosition - state.scrollOffset) / samplesPerCol
  if (playheadX >= x0 && playheadX <= x0 + w) {
    ctx.strokeStyle = C.green
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(playheadX, y0)
    ctx.lineTo(playheadX, y0 + gridH)
    ctx.stroke()
  }
}

// ── Statusbar ───────────────────────────────────────────────────────────
function drawStatusbar() {
  const y = H - STATUSBAR_H

  ctx.fillStyle = C.bgDark
  ctx.fillRect(0, y, W, STATUSBAR_H)

  // Top border
  ctx.fillStyle = C.bgHighlight
  ctx.fillRect(0, y, W, 1)

  ctx.fillStyle = C.fgDim
  ctx.font = "11px monospace"
  const textY = y + STATUSBAR_H / 2 + 4
  const shortcuts = "Space Play  R Arm  M Mute  S Solo  C Click  +/- BPM  hjkl Nav  I Import  A Add  D Del"
  ctx.fillText(shortcuts, 16, textY)
}

// ── Helpers ─────────────────────────────────────────────────────────────
function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.01) return "C"
  if (pan < 0) return `L${Math.round(Math.abs(pan) * 100)}`
  return `R${Math.round(pan * 100)}`
}

function getSamplesPerCol(canvasWidth: number): number {
  return Math.max(1, Math.floor(SAMPLE_RATE / (canvasWidth * 2) * 10) * 2)
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

function showStatus(msg: string) {
  state.statusMessage = msg
  if (state.statusTimeout) clearTimeout(state.statusTimeout)
  state.statusTimeout = setTimeout(() => {
    state.statusMessage = ""
    render()
  }, 3000)
  render()
}

// ── Transport ───────────────────────────────────────────────────────────
async function play() {
  const ready = await ensureAudioReady()
  if (!ready) {
    showStatus("Audio engine not ready")
    return
  }

  state.transportState = "playing"
  state.freeScroll = false

  for (const track of state.tracks) audio.syncTrack(track)

  if (state.clickEnabled) {
    const duration = getClickDuration()
    audio.generateClick(state.bpm, duration)
    audio.setClick(true, state.bpm)
    audio.setClickVolume(state.clickVolume)
    audio.setClickPan(state.clickPan)
  }

  if (state.loopStart !== null && state.loopEnd !== null) {
    audio.setLoop(state.loopStart, state.loopEnd)
  }

  audio.setSpeed(state.bpm / state.originalBpm)
  audio.play(state.playheadPosition)
  startPlayheadPolling()
  render()
}

function stopTransport() {
  state.transportState = "stopped"
  state.freeScroll = false
  audio.stop()

  if (animFrameId) {
    cancelAnimationFrame(animFrameId)
    animFrameId = null
  }
  render()
}

function startPlayheadPolling() {
  function tick() {
    if (state.transportState === "stopped") return
    state.playheadPosition = audio.getPlayhead()
    if (!state.freeScroll) autoScroll()
    render()
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
  const w = W - SIDEBAR_W
  const samplesPerCol = getSamplesPerCol(w)
  const visibleSamples = w * samplesPerCol

  if (state.playheadPosition < state.scrollOffset) {
    state.scrollOffset = Math.max(0, state.playheadPosition - Math.floor(visibleSamples * 0.2))
  } else if (state.playheadPosition > state.scrollOffset + visibleSamples * 0.8) {
    state.scrollOffset = state.playheadPosition - Math.floor(visibleSamples * 0.2)
  }
}

function ensurePlayheadVisible() {
  const w = W - SIDEBAR_W
  const samplesPerCol = getSamplesPerCol(w)
  const visibleSamples = w * samplesPerCol

  if (state.playheadPosition < state.scrollOffset ||
      state.playheadPosition > state.scrollOffset + visibleSamples) {
    state.scrollOffset = Math.max(0, state.playheadPosition - Math.floor(visibleSamples / 2))
  }
}

// ── Hit zones for mouse ─────────────────────────────────────────────────
type Zone = "topbar-play" | "topbar" | "sidebar-click" | "sidebar-track" | "sidebar-btn"
           | "timeline" | "waveform" | "statusbar" | "none"

interface HitResult {
  zone: Zone
  trackIndex: number
  btnAction?: "mute" | "solo" | "arm"
  localX: number
  localY: number
}

function hitTest(cx: number, cy: number): HitResult {
  const result: HitResult = { zone: "none", trackIndex: -1, localX: cx, localY: cy }

  // Topbar
  if (cy < TOPBAR_H) {
    // Play button: x=16, w=80
    if (cx >= 16 && cx <= 96 && cy >= (TOPBAR_H - 28) / 2 && cy <= (TOPBAR_H + 28) / 2) {
      result.zone = "topbar-play"
    } else {
      result.zone = "topbar"
    }
    return result
  }

  // Statusbar
  if (cy >= H - STATUSBAR_H) {
    result.zone = "statusbar"
    return result
  }

  // Sidebar
  if (cx < SIDEBAR_W) {
    const sideY = cy - TOPBAR_H

    // Click track row
    if (sideY < CLICK_ROW_H) {
      result.zone = "sidebar-click"
      result.trackIndex = -1
      return result
    }

    // Regular tracks
    const trackY = sideY - CLICK_ROW_H
    const trackIdx = Math.floor(trackY / TRACK_H)
    if (trackIdx >= 0 && trackIdx < state.tracks.length) {
      result.trackIndex = trackIdx
      const localY = trackY - trackIdx * TRACK_H

      // M/S/R button row (y=28..44, x=8..74)
      if (localY >= 28 && localY < 44 && cx >= 8) {
        if (cx < 30) { result.zone = "sidebar-btn"; result.btnAction = "mute" }
        else if (cx < 56) { result.zone = "sidebar-btn"; result.btnAction = "solo" }
        else if (cx < 82) { result.zone = "sidebar-btn"; result.btnAction = "arm" }
        else { result.zone = "sidebar-track" }
      } else {
        result.zone = "sidebar-track"
      }
    }
    return result
  }

  // Timeline
  if (cy < TOPBAR_H + TIMELINE_H) {
    result.zone = "timeline"
    result.localX = cx - SIDEBAR_W
    return result
  }

  // Waveform area
  result.zone = "waveform"
  result.localX = cx - SIDEBAR_W
  result.localY = cy - TOPBAR_H - TIMELINE_H
  result.trackIndex = Math.floor(result.localY / TRACK_H)
  if (result.trackIndex >= state.tracks.length) result.trackIndex = -1
  return result
}

// ── Mouse Handling ──────────────────────────────────────────────────────
function setupMouse() {
  canvas.addEventListener("click", (e) => {
    const hit = hitTest(e.clientX, e.clientY)

    switch (hit.zone) {
      case "topbar-play":
        if (state.transportState !== "stopped") stopTransport()
        else play()
        break

      case "sidebar-click":
        state.selectedTrackIndex = -1
        render()
        break

      case "sidebar-track":
        if (hit.trackIndex >= 0) {
          state.selectedTrackIndex = hit.trackIndex
          render()
        }
        break

      case "sidebar-btn":
        if (hit.trackIndex >= 0) {
          const track = state.tracks[hit.trackIndex]
          if (track && hit.btnAction === "mute") {
            track.muted = !track.muted
            if (audio.isReady) audio.setTrackMuted(track.id, track.muted)
          } else if (track && hit.btnAction === "solo") {
            track.solo = !track.solo
            if (audio.isReady) audio.setTrackSolo(track.id, track.solo)
          } else if (track && hit.btnAction === "arm") {
            track.armed = !track.armed
          }
          render()
        }
        break

      case "timeline": {
        const w = W - SIDEBAR_W
        const samplesPerCol = getSamplesPerCol(w)
        state.playheadPosition = Math.max(0, Math.floor(state.scrollOffset + hit.localX * samplesPerCol))
        if (state.transportState !== "stopped") {
          audio.setPlayhead(state.playheadPosition)
          state.freeScroll = true
        }
        render()
        break
      }

      case "waveform":
        if (hit.trackIndex >= 0) {
          state.selectedTrackIndex = hit.trackIndex
          render()
        }
        break
    }
  })

  // Scroll
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault()
    const hit = hitTest(e.clientX, e.clientY)

    if (hit.zone === "waveform" || hit.zone === "timeline") {
      const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
      const direction = e.deltaY > 0 ? 1 : -1
      state.scrollOffset = Math.max(0, state.scrollOffset + direction * samplesPerBeat)
      if (state.transportState !== "stopped") state.freeScroll = true
      render()
    } else if (hit.zone === "sidebar-track" && hit.trackIndex >= 0) {
      // Volume scroll on sidebar tracks
      const track = state.tracks[hit.trackIndex]
      if (track) {
        const delta = e.deltaY > 0 ? -0.05 : 0.05
        track.volume = Math.max(0, Math.min(2, track.volume + delta))
        if (audio.isReady) audio.setTrackVolume(track.id, track.volume)
        render()
      }
    } else if (hit.zone === "sidebar-click") {
      // Volume scroll on click track
      const delta = e.deltaY > 0 ? -0.05 : 0.05
      state.clickVolume = Math.max(0, Math.min(2, state.clickVolume + delta))
      if (audio.isReady) audio.setClickVolume(state.clickVolume)
      render()
    }
  }, { passive: false })

  // Cursor style
  canvas.addEventListener("mousemove", (e) => {
    const hit = hitTest(e.clientX, e.clientY)
    if (hit.zone === "topbar-play" || hit.zone === "sidebar-btn" ||
        hit.zone === "sidebar-track" || hit.zone === "sidebar-click" ||
        hit.zone === "timeline") {
      canvas.style.cursor = "pointer"
    } else {
      canvas.style.cursor = "default"
    }
  })
}

// ── Keyboard ────────────────────────────────────────────────────────────
function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return

    switch (e.key) {
      case " ":
        e.preventDefault()
        if (state.transportState !== "stopped") stopTransport()
        else play()
        break

      case "m":
        if (state.selectedTrackIndex === -1) {
          state.clickEnabled = !state.clickEnabled
        } else {
          const track = state.tracks[state.selectedTrackIndex]
          if (track) {
            track.muted = !track.muted
            if (audio.isReady) audio.setTrackMuted(track.id, track.muted)
          }
        }
        render()
        break

      case "s": {
        const track = state.tracks[state.selectedTrackIndex]
        if (track) {
          track.solo = !track.solo
          if (audio.isReady) audio.setTrackSolo(track.id, track.solo)
          render()
        }
        break
      }

      case "r": {
        const track = state.tracks[state.selectedTrackIndex]
        if (track) {
          track.armed = !track.armed
          render()
        }
        break
      }

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
        render()
        break

      case "+":
      case "=":
        state.bpm = Math.min(300, state.bpm + (e.shiftKey ? 10 : 1))
        if (audio.isReady) audio.setSpeed(state.bpm / state.originalBpm)
        render()
        break

      case "-":
        state.bpm = Math.max(20, state.bpm - (e.shiftKey ? 10 : 1))
        if (audio.isReady) audio.setSpeed(state.bpm / state.originalBpm)
        render()
        break

      case "ArrowUp":
      case "k":
        e.preventDefault()
        if (state.selectedTrackIndex > -1) {
          state.selectedTrackIndex--
          render()
        }
        break

      case "ArrowDown":
      case "j":
        e.preventDefault()
        if (state.selectedTrackIndex < state.tracks.length - 1) {
          state.selectedTrackIndex++
          render()
        }
        break

      case "ArrowLeft":
      case "h": {
        const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
        const scrollAmount = e.shiftKey ? samplesPerBeat * 4 : samplesPerBeat
        state.scrollOffset = Math.max(0, state.scrollOffset - scrollAmount)
        if (state.transportState !== "stopped") state.freeScroll = true
        render()
        break
      }

      case "ArrowRight":
      case "l": {
        const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
        const scrollAmount = e.shiftKey ? samplesPerBeat * 4 : samplesPerBeat
        state.scrollOffset += scrollAmount
        if (state.transportState !== "stopped") state.freeScroll = true
        render()
        break
      }

      case "[": {
        const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
        state.playheadPosition = Math.max(0, state.playheadPosition - samplesPerBeat * 4)
        if (state.transportState !== "stopped") audio.setPlayhead(state.playheadPosition)
        ensurePlayheadVisible()
        render()
        break
      }

      case "]": {
        const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
        state.playheadPosition += samplesPerBeat * 4
        if (state.transportState !== "stopped") audio.setPlayhead(state.playheadPosition)
        ensurePlayheadVisible()
        render()
        break
      }

      case "Home":
      case "0":
        state.playheadPosition = 0
        state.scrollOffset = 0
        state.freeScroll = false
        if (state.transportState !== "stopped") audio.setPlayhead(0)
        render()
        break

      case "End": {
        let maxLen = 0
        for (const t of state.tracks) {
          if (t.samples && t.samples.length > maxLen) maxLen = t.samples.length
        }
        state.playheadPosition = maxLen
        if (state.transportState !== "stopped") audio.setPlayhead(maxLen)
        ensurePlayheadVisible()
        render()
        break
      }

      case "a":
        if (state.transportState !== "stopped") {
          showStatus("Stop transport first (Space)")
        } else {
          const newTrack = createTrack(`Track ${nextTrackNum++}`, state.tracks.length)
          state.tracks.push(newTrack)
          if (audio.isReady) audio.syncTrack(newTrack)
          state.selectedTrackIndex = state.tracks.length - 1
          render()
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
            render()
          }
        }
        break

      case "v":
      case "V":
        // Volume adjust via keyboard (future: prompt)
        break

      case "<": {
        if (state.selectedTrackIndex === -1) {
          state.clickPan = Math.max(-1, state.clickPan - 0.1)
          if (audio.isReady) audio.setClickPan(state.clickPan)
        } else {
          const track = state.tracks[state.selectedTrackIndex]
          if (track) {
            track.pan = Math.max(-1, track.pan - 0.1)
            if (audio.isReady) audio.setTrackPan(track.id, track.pan)
          }
        }
        render()
        break
      }

      case ">": {
        if (state.selectedTrackIndex === -1) {
          state.clickPan = Math.min(1, state.clickPan + 0.1)
          if (audio.isReady) audio.setClickPan(state.clickPan)
        } else {
          const track = state.tracks[state.selectedTrackIndex]
          if (track) {
            track.pan = Math.min(1, track.pan + 0.1)
            if (audio.isReady) audio.setTrackPan(track.id, track.pan)
          }
        }
        render()
        break
      }

      case "i":
      case "I":
        importWav()
        break
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
      const parsed = parseWav(new Uint8Array(arrayBuf))

      if (!parsed) {
        showStatus("Failed to parse WAV file!")
        return
      }

      const detectedBPM = detectBPM(parsed.samples, parsed.sampleRate)

      let samples = parsed.sampleRate !== SAMPLE_RATE
        ? resample(parsed.samples, parsed.sampleRate, SAMPLE_RATE)
        : parsed.samples

      if (detectedBPM) {
        const beatOffset = findBeatOffset(samples, SAMPLE_RATE, detectedBPM)
        if (beatOffset > 0 && beatOffset < samples.length) {
          samples = samples.slice(beatOffset)
        }
      }

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
        render()
      }
    } catch (err) {
      showStatus(`Import error: ${err}`)
      console.error("WAV import failed:", err)
    }
  }

  input.click()
}

// ── Init ────────────────────────────────────────────────────────────────
async function init() {
  resize()
  window.addEventListener("resize", resize)

  // Show loading state
  drawLoadingScreen("Loading WASM audio engine...")

  try {
    await loadScript("/wasm/tuidaw_audio.js")
  } catch (err) {
    drawLoadingScreen(`Failed to load WASM: ${err}`)
    console.error("WASM load failed:", err)
    return
  }

  setupMouse()
  setupKeyboard()
  render()
}

function drawLoadingScreen(msg: string) {
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, W, H)

  ctx.fillStyle = C.blue
  ctx.font = "bold 24px monospace"
  ctx.textAlign = "center"
  ctx.fillText("tuidaw", W / 2, H / 2 - 20)

  ctx.fillStyle = C.fgDim
  ctx.font = "14px monospace"
  ctx.fillText(msg, W / 2, H / 2 + 20)
  ctx.textAlign = "left"
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

// ── Start ───────────────────────────────────────────────────────────────
init().catch(console.error)
