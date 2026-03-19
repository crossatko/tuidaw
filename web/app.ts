// ============================================================================
// tuidaw Web App — Full-canvas DAW interface (touch-friendly)
// ============================================================================
// Single <canvas> renders everything: topbar, sidebar, waveforms, statusbar.
// No DOM elements besides the canvas itself (+ hidden file input for import).
// Touch-friendly: larger buttons, visual sliders, all actions via touch.

import { WebAudioBridge, type WebTrack } from "./audio-bridge"
import { detectBPM, findBeatOffset } from "../src/utils/bpm"
import { resample } from "../src/utils/dsp"
import { parseWav, encodeWav } from "../src/utils/wav"
import type { ProjectDescriptor, TrackDescriptor } from "../src/types"

// ── On-screen debug log (defined in index.html, visible when errors occur) ──
declare function _debugLog(msg: string): void
declare function _debugError(msg: string): void
declare function _debugHide(): void

// ── OLED Colors ─────────────────────────────────────────────────────────
const C = {
  bg: "#000000",
  bgDark: "#000000",
  bgHighlight: "#1a1a1a",
  border: "#2a2a2a",
  fg: "#e8e8e8",
  fgDim: "#666666",
  blue: "#5b9cf5",
  cyan: "#56d4f0",
  green: "#6cc644",
  magenta: "#c678dd",
  red: "#f05060",
  orange: "#e89040",
  yellow: "#e0c050",
  purple: "#b080e0",
} as const

const TRACK_COLORS = [
  "#5b9cf5", "#6cc644", "#f05060", "#e89040",
  "#c678dd", "#56d4f0", "#e0c050", "#4ec9a0",
]

const SAMPLE_RATE = 48000

// ── Layout Constants (touch-friendly sizes) ─────────────────────────────
const SIDEBAR_W = 260
const TOPBAR_H = 56
const STATUSBAR_H = 36
const TIMELINE_H = 48   // must match CLICK_ROW_H so sidebar tracks align with waveform tracks
const TRACK_H = 120
const CLICK_ROW_H = TIMELINE_H

// Button sizing
const BTN_H = 36        // topbar button height
const MSR_BTN_W = 32    // mute/solo/arm button width
const MSR_BTN_H = 28    // mute/solo/arm button height

// Slider dimensions
const SLIDER_H = 20      // slider track height
const SLIDER_KNOB_W = 12 // slider knob width
const SLIDER_KNOB_H = 24 // slider knob height (taller than track for easy grab)
const SLIDER_PAD = 8     // left padding for sliders

// ── Default values for double-click reset ───────────────────────────────
const DEFAULT_VOLUME = 0.8
const DEFAULT_PAN = 0
const DEFAULT_CLICK_VOLUME = 0.5
const DEFAULT_CLICK_PAN = 0

// ── App State ───────────────────────────────────────────────────────────
interface AppState {
  projectName: string
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
    projectName: "Untitled",
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

function genId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID()
  // Fallback for insecure contexts / older browsers
  const a = new Uint8Array(16)
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(a)
  else for (let i = 0; i < 16; i++) a[i] = (Math.random() * 256) | 0
  a[6] = (a[6] & 0x0f) | 0x40; a[8] = (a[8] & 0x3f) | 0x80
  const h = Array.from(a, b => b.toString(16).padStart(2, "0")).join("")
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`
}

let nextTrackNum = 2
function createTrack(name: string, colorIndex: number): WebTrack {
  return {
    id: genId(),
    name,
    color: TRACK_COLORS[colorIndex % TRACK_COLORS.length],
    volume: DEFAULT_VOLUME,
    pan: DEFAULT_PAN,
    muted: false,
    solo: false,
    armed: false,
    samples: null,
    sampleRate: SAMPLE_RATE,
  }
}

// ── Canvas Setup ────────────────────────────────────────────────────────
const canvas = document.getElementById("app") as HTMLCanvasElement
if (!canvas) _debugError("Canvas element #app not found")
const _ctx = canvas.getContext("2d")
if (!_ctx) _debugError("Failed to get 2d context from canvas")
const ctx = _ctx!
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
      _debugLog("Initializing WASM audio engine...")
      await audio.init()
      _debugLog("Audio engine ready")
      for (const track of state.tracks) audio.syncTrack(track)
    } catch (err) {
      _debugError(`Audio init failed: ${err}`)
      console.error("Audio init failed:", err)
      showStatus(`Audio init failed: ${err}`)
    }
  })()
  await audioInitPromise
  return audio.isReady
}

// ── Drag State ──────────────────────────────────────────────────────────
interface DragState {
  type: "volume" | "pan" | "click-volume" | "click-pan" | "timeline" | "waveform-scroll"
  trackIndex: number // -1 for click track, -2 for timeline
  startValue: number
}

let drag: DragState | null = null
let lastClickTime = 0
let lastClickZone = ""
let lastClickTrack = -99

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
// Topbar layout: [Play] [Loop] [Click] | [-] BPM [+] | Speed | Time | ... [Import] [Export] [+Track]
function drawTopbar() {
  ctx.fillStyle = C.bgDark
  ctx.fillRect(0, 0, W, TOPBAR_H)

  // Bottom border
  ctx.fillStyle = C.border
  ctx.fillRect(0, TOPBAR_H - 1, W, 1)

  const textY = TOPBAR_H / 2 + 5
  const btnY = (TOPBAR_H - BTN_H) / 2
  let x = 12

  // ── Play button ───────────────────────────────────────────────────
  const playW = 80
  const isPlaying = state.transportState !== "stopped"

  ctx.fillStyle = isPlaying ? C.green : C.bgHighlight
  roundRect(ctx, x, btnY, playW, BTN_H, 4)
  ctx.fill()
  if (!isPlaying) {
    ctx.strokeStyle = C.border
    ctx.lineWidth = 1
    roundRect(ctx, x, btnY, playW, BTN_H, 4)
    ctx.stroke()
  }

  ctx.fillStyle = isPlaying ? "#000000" : C.fg
  ctx.font = "bold 13px monospace"
  ctx.textAlign = "center"
  ctx.fillText(isPlaying ? "|| Pause" : "> Play", x + playW / 2, textY)
  ctx.textAlign = "left"
  x += playW + 8

  // ── Loop button ───────────────────────────────────────────────────
  const loopW = 64
  const hasLoop = state.loopStart !== null && state.loopEnd !== null
  const settingLoop = state.loopStart !== null && state.loopEnd === null

  ctx.fillStyle = hasLoop ? C.purple : C.bgHighlight
  roundRect(ctx, x, btnY, loopW, BTN_H, 4)
  ctx.fill()
  if (!hasLoop) {
    ctx.strokeStyle = settingLoop ? C.purple : C.border
    ctx.lineWidth = 1
    roundRect(ctx, x, btnY, loopW, BTN_H, 4)
    ctx.stroke()
  }

  ctx.fillStyle = hasLoop ? "#000000" : (settingLoop ? C.purple : C.fgDim)
  ctx.font = "bold 12px monospace"
  ctx.textAlign = "center"
  ctx.fillText(settingLoop ? "Loop..." : "Loop", x + loopW / 2, textY)
  ctx.textAlign = "left"
  x += loopW + 8

  // ── Click button ──────────────────────────────────────────────────
  const clickW = 64
  ctx.fillStyle = state.clickEnabled ? C.cyan : C.bgHighlight
  roundRect(ctx, x, btnY, clickW, BTN_H, 4)
  ctx.fill()
  if (!state.clickEnabled) {
    ctx.strokeStyle = C.border
    ctx.lineWidth = 1
    roundRect(ctx, x, btnY, clickW, BTN_H, 4)
    ctx.stroke()
  }

  ctx.fillStyle = state.clickEnabled ? "#000000" : C.fgDim
  ctx.font = "bold 12px monospace"
  ctx.textAlign = "center"
  ctx.fillText("Click", x + clickW / 2, textY)
  ctx.textAlign = "left"
  x += clickW + 16

  // ── BPM: [-] value [+] ───────────────────────────────────────────
  const bpmBtnW = 32
  // Minus button
  ctx.fillStyle = C.bgHighlight
  roundRect(ctx, x, btnY, bpmBtnW, BTN_H, 4)
  ctx.fill()
  ctx.strokeStyle = C.border
  ctx.lineWidth = 1
  roundRect(ctx, x, btnY, bpmBtnW, BTN_H, 4)
  ctx.stroke()
  ctx.fillStyle = C.fg
  ctx.font = "bold 16px monospace"
  ctx.textAlign = "center"
  ctx.fillText("-", x + bpmBtnW / 2, textY + 1)
  x += bpmBtnW + 4

  // BPM value
  ctx.fillStyle = C.cyan
  ctx.font = "bold 14px monospace"
  ctx.textAlign = "center"
  const bpmStr = `${state.bpm} BPM`
  const bpmTextW = ctx.measureText(bpmStr).width + 16
  ctx.fillText(bpmStr, x + bpmTextW / 2, textY)
  x += bpmTextW + 4

  // Plus button
  ctx.fillStyle = C.bgHighlight
  roundRect(ctx, x, btnY, bpmBtnW, BTN_H, 4)
  ctx.fill()
  ctx.strokeStyle = C.border
  ctx.lineWidth = 1
  roundRect(ctx, x, btnY, bpmBtnW, BTN_H, 4)
  ctx.stroke()
  ctx.fillStyle = C.fg
  ctx.font = "bold 16px monospace"
  ctx.textAlign = "center"
  ctx.fillText("+", x + bpmBtnW / 2, textY + 1)
  ctx.textAlign = "left"
  x += bpmBtnW + 12

  // ── Speed % ───────────────────────────────────────────────────────
  const speed = state.bpm / state.originalBpm
  if (Math.abs(speed - 1) > 0.001) {
    ctx.fillStyle = C.orange
    ctx.font = "12px monospace"
    ctx.fillText(`${Math.round(speed * 100)}%`, x, textY)
    x += 50
  }

  // ── Time ──────────────────────────────────────────────────────────
  const seconds = state.playheadPosition / SAMPLE_RATE
  const mins = Math.floor(seconds / 60)
  const secs = (seconds % 60).toFixed(1)
  ctx.fillStyle = C.fgDim
  ctx.font = "13px monospace"
  ctx.fillText(`${mins}:${secs.padStart(4, "0")}`, x, textY)

  // ── Right-aligned buttons: [Save] [Open] [Import] [Export] [+Track] ────
  const rightBtns = [
    { label: "+Track", key: "add-track", w: 72 },
    { label: "Export", key: "export", w: 64 },
    { label: "Import", key: "import", w: 64 },
    { label: "Open", key: "open", w: 56 },
    { label: "Save", key: "save", w: 56 },
  ]
  let rx = W - 12
  for (const btn of rightBtns) {
    rx -= btn.w
    ctx.fillStyle = C.bgHighlight
    roundRect(ctx, rx, btnY, btn.w, BTN_H, 4)
    ctx.fill()
    ctx.strokeStyle = C.border
    ctx.lineWidth = 1
    roundRect(ctx, rx, btnY, btn.w, BTN_H, 4)
    ctx.stroke()
    ctx.fillStyle = C.fgDim
    ctx.font = "bold 11px monospace"
    ctx.textAlign = "center"
    ctx.fillText(btn.label, rx + btn.w / 2, textY)
    ctx.textAlign = "left"
    rx -= 8
  }

  // ── Status message (before right buttons) ─────────────────────────
  if (state.statusMessage) {
    ctx.fillStyle = C.yellow
    ctx.font = "12px monospace"
    ctx.textAlign = "right"
    ctx.fillText(state.statusMessage, rx - 8, textY)
    ctx.textAlign = "left"
  }
}

// ── Compute topbar button positions (must match drawTopbar) ─────────────
function getTopbarLayout() {
  const btnY = (TOPBAR_H - BTN_H) / 2
  let x = 12
  const playW = 80
  const play = { x, y: btnY, w: playW, h: BTN_H }
  x += playW + 8
  const loopW = 64
  const loop = { x, y: btnY, w: loopW, h: BTN_H }
  x += loopW + 8
  const clickW = 64
  const click = { x, y: btnY, w: clickW, h: BTN_H }
  x += clickW + 16
  const bpmBtnW = 32
  const bpmMinus = { x, y: btnY, w: bpmBtnW, h: BTN_H }
  x += bpmBtnW + 4
  // BPM text area
  ctx.font = "bold 14px monospace"
  const bpmStr = `${state.bpm} BPM`
  const bpmTextW = ctx.measureText(bpmStr).width + 16
  const bpmText = { x, y: btnY, w: bpmTextW, h: BTN_H }
  x += bpmTextW + 4
  const bpmPlus = { x, y: btnY, w: bpmBtnW, h: BTN_H }

  // Right-aligned buttons
  let rx = W - 12
  const addTrackW = 72
  const addTrack = { x: rx - addTrackW, y: btnY, w: addTrackW, h: BTN_H }
  rx -= addTrackW + 8
  const exportW = 64
  const exportBtn = { x: rx - exportW, y: btnY, w: exportW, h: BTN_H }
  rx -= exportW + 8
  const importW = 64
  const importBtn = { x: rx - importW, y: btnY, w: importW, h: BTN_H }
  rx -= importW + 8
  const openW = 56
  const openBtn = { x: rx - openW, y: btnY, w: openW, h: BTN_H }
  rx -= openW + 8
  const saveW = 56
  const saveBtn = { x: rx - saveW, y: btnY, w: saveW, h: BTN_H }

  return { play, loop, click, bpmMinus, bpmText, bpmPlus, saveBtn, openBtn, importBtn, exportBtn, addTrack }
}

// ── Sidebar ─────────────────────────────────────────────────────────────
function drawSidebar() {
  const sidebarH = H - TOPBAR_H - STATUSBAR_H
  ctx.fillStyle = C.bgDark
  ctx.fillRect(0, TOPBAR_H, SIDEBAR_W, sidebarH)

  // Right border
  ctx.fillStyle = C.border
  ctx.fillRect(SIDEBAR_W - 1, TOPBAR_H, 1, sidebarH)

  let y = TOPBAR_H

  // ── Click track row ───────────────────────────────────────────────
  drawClickTrackRow(y)
  y += CLICK_ROW_H

  // ── Regular tracks ────────────────────────────────────────────────
  // Clip to sidebar area (prevent tracks from overflowing into statusbar)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, y, SIDEBAR_W, H - STATUSBAR_H - y)
  ctx.clip()

  for (let i = 0; i < state.tracks.length; i++) {
    const track = state.tracks[i]
    drawTrackRow(y, i, track)
    y += TRACK_H
  }

  ctx.restore()
}

function drawClickTrackRow(y: number) {
  const isSelected = state.selectedTrackIndex === -1

  if (isSelected) {
    ctx.fillStyle = C.bgHighlight
    ctx.fillRect(0, y, SIDEBAR_W - 1, CLICK_ROW_H)
    ctx.fillStyle = C.blue
    ctx.fillRect(0, y, 3, CLICK_ROW_H)
  }

  // Bottom border
  ctx.fillStyle = C.border
  ctx.fillRect(0, y + CLICK_ROW_H - 1, SIDEBAR_W - 1, 1)

  const clickColor = state.clickEnabled ? C.cyan : C.fgDim
  const pad = 8

  // Row 1: icon + "Click" label
  ctx.fillStyle = clickColor
  ctx.font = "14px monospace"
  ctx.fillText("\u2669", pad, y + 16)

  ctx.fillStyle = state.clickEnabled ? C.fg : C.fgDim
  ctx.font = "bold 12px monospace"
  ctx.fillText("Click", pad + 18, y + 16)

  // Row 2: Volume slider + Pan slider
  const sliderY = y + 24
  const clickSliderW = (SIDEBAR_W - SLIDER_PAD * 2 - 30) / 2
  drawMiniSlider(SLIDER_PAD, sliderY, "V", state.clickVolume / 2, 0, 2, state.clickEnabled ? C.cyan : C.fgDim)
  drawMiniSlider(SLIDER_PAD + clickSliderW + 16, sliderY, "P", (state.clickPan + 1) / 2, 0, 1, state.clickEnabled ? C.cyan : C.fgDim)
}

function drawTrackRow(y: number, index: number, track: WebTrack) {
  const isSelected = index === state.selectedTrackIndex

  // Selected background
  if (isSelected) {
    ctx.fillStyle = C.bgHighlight
    ctx.fillRect(0, y, SIDEBAR_W - 1, TRACK_H)
    ctx.fillStyle = C.blue
    ctx.fillRect(0, y, 3, TRACK_H)
  }

  // Bottom border
  ctx.fillStyle = C.border
  ctx.fillRect(0, y + TRACK_H - 1, SIDEBAR_W - 1, 1)

  const pad = 8

  // Row 1 (y+4..y+20): color dot + name + delete button
  ctx.fillStyle = track.color
  ctx.beginPath()
  ctx.arc(pad + 5, y + 14, 5, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = C.fg
  ctx.font = "bold 12px monospace"
  const delBtnX = SIDEBAR_W - pad - 28
  const maxNameW = delBtnX - (pad + 14) - 4
  ctx.save()
  ctx.beginPath()
  ctx.rect(pad + 14, y, maxNameW, 24)
  ctx.clip()
  ctx.fillText(track.name, pad + 14, y + 18)
  ctx.restore()

  // Delete button (X) — top right of track row
  const delBtnY = y + 4
  const delBtnW = 28
  const delBtnH = 24
  ctx.fillStyle = C.bgHighlight
  roundRect(ctx, delBtnX, delBtnY, delBtnW, delBtnH, 3)
  ctx.fill()
  ctx.strokeStyle = C.border
  ctx.lineWidth = 1
  roundRect(ctx, delBtnX, delBtnY, delBtnW, delBtnH, 3)
  ctx.stroke()
  ctx.fillStyle = C.fgDim
  ctx.font = "bold 12px monospace"
  ctx.fillText("\u00D7", delBtnX + 9, delBtnY + 17) // × symbol

  // Row 2 (y+26..y+54): M S R buttons (bigger)
  const msrY = y + 28
  drawMSRButton(pad, msrY, "M", track.muted, C.orange)
  drawMSRButton(pad + MSR_BTN_W + 6, msrY, "S", track.solo, C.yellow)
  drawMSRButton(pad + (MSR_BTN_W + 6) * 2, msrY, "R", track.armed, C.red)

  // Duration info (right of MSR buttons)
  ctx.fillStyle = C.fgDim
  ctx.font = "10px monospace"
  if (track.samples && track.samples.length > 0) {
    const dur = (track.samples.length / SAMPLE_RATE).toFixed(1)
    ctx.fillText(`${dur}s`, pad + (MSR_BTN_W + 6) * 3 + 8, msrY + 18)
  } else {
    ctx.fillText("(empty)", pad + (MSR_BTN_W + 6) * 3 + 8, msrY + 18)
  }

  // Row 3 (y+62..y+82): Volume slider
  const volSliderY = y + 62
  drawMiniSlider(SLIDER_PAD, volSliderY, "V", track.volume, 0, 1, track.color)

  // Row 4 (y+88..y+108): Pan slider
  const panSliderY = y + 90
  drawMiniSlider(SLIDER_PAD, panSliderY, "P", (track.pan + 1) / 2, 0, 1, track.color)
}

function drawMSRButton(x: number, y: number, label: string, active: boolean, activeColor: string) {
  if (active) {
    ctx.fillStyle = activeColor
    roundRect(ctx, x, y, MSR_BTN_W, MSR_BTN_H, 3)
    ctx.fill()
    ctx.fillStyle = "#000000"
  } else {
    ctx.fillStyle = C.bgHighlight
    roundRect(ctx, x, y, MSR_BTN_W, MSR_BTN_H, 3)
    ctx.fill()
    ctx.strokeStyle = C.border
    ctx.lineWidth = 1
    roundRect(ctx, x, y, MSR_BTN_W, MSR_BTN_H, 3)
    ctx.stroke()
    ctx.fillStyle = C.fgDim
  }

  ctx.font = "bold 11px monospace"
  ctx.textAlign = "center"
  ctx.fillText(label, x + MSR_BTN_W / 2, y + MSR_BTN_H / 2 + 4)
  ctx.textAlign = "left"
}

// Draw a mini slider with label. `value` is normalized fraction of range [min, max].
function drawMiniSlider(x: number, y: number, label: string, valueFrac: number, _min: number, max: number, accentColor: string) {
  const sliderW = (SIDEBAR_W - SLIDER_PAD * 2 - 30) / 2
  const trackW = sliderW - 24
  const trackH = 6
  const trackX = x + 24
  const trackY = y + (SLIDER_H - trackH) / 2

  // Label
  ctx.fillStyle = C.fgDim
  ctx.font = "10px monospace"
  ctx.fillText(label, x, y + SLIDER_H / 2 + 3)

  // Value text
  let valueText: string
  if (label === "V") {
    valueText = `${Math.round(valueFrac * max * 100)}%`
  } else {
    // Pan: convert frac (0-1) to pan (-1 to +1)
    const pan = valueFrac * 2 - 1
    valueText = formatPan(pan)
  }
  ctx.fillStyle = C.fgDim
  ctx.font = "9px monospace"
  ctx.textAlign = "right"
  ctx.fillText(valueText, x + sliderW, y + SLIDER_H / 2 + 3)
  ctx.textAlign = "left"

  // Track background
  ctx.fillStyle = C.border
  roundRect(ctx, trackX, trackY, trackW, trackH, 3)
  ctx.fill()

  // Filled portion
  const fillW = Math.max(0, Math.min(trackW, valueFrac * trackW))
  if (label === "P") {
    // Pan slider: fill from center
    const centerX = trackX + trackW / 2
    const pan = valueFrac * 2 - 1
    if (Math.abs(pan) > 0.01) {
      ctx.fillStyle = accentColor
      ctx.globalAlpha = 0.6
      if (pan < 0) {
        const pw = Math.abs(pan) * trackW / 2
        roundRect(ctx, centerX - pw, trackY, pw, trackH, 2)
        ctx.fill()
      } else {
        const pw = pan * trackW / 2
        roundRect(ctx, centerX, trackY, pw, trackH, 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1

      // Center notch
      ctx.fillStyle = C.fgDim
      ctx.fillRect(centerX - 0.5, trackY - 1, 1, trackH + 2)
    } else {
      // At center: just show notch
      ctx.fillStyle = C.fgDim
      ctx.fillRect(centerX - 0.5, trackY - 1, 1, trackH + 2)
    }
  } else {
    // Volume slider: fill from left
    if (fillW > 0) {
      ctx.fillStyle = accentColor
      ctx.globalAlpha = 0.6
      roundRect(ctx, trackX, trackY, fillW, trackH, 3)
      ctx.fill()
      ctx.globalAlpha = 1
    }
  }

  // Knob
  const knobX = trackX + (label === "P" ? valueFrac : Math.min(valueFrac, 1)) * trackW - SLIDER_KNOB_W / 2
  const knobY = y + (SLIDER_H - SLIDER_KNOB_H) / 2
  ctx.fillStyle = "#444"
  roundRect(ctx, knobX, knobY, SLIDER_KNOB_W, SLIDER_KNOB_H, 3)
  ctx.fill()
  ctx.fillStyle = C.fg
  ctx.fillRect(knobX + SLIDER_KNOB_W / 2 - 1, knobY + 4, 2, SLIDER_KNOB_H - 8)
}

// Get slider geometry for hit testing (returns { trackX, trackW, sliderY } given the same params as drawMiniSlider)
function getSliderGeometry(sliderX: number): { trackX: number; trackW: number } {
  const sliderW = (SIDEBAR_W - SLIDER_PAD * 2 - 30) / 2
  const trackW = sliderW - 24
  const trackX = sliderX + 24
  return { trackX, trackW }
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
  ctx.fillStyle = C.border
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
    ctx.strokeStyle = isBar ? C.fgDim : C.border
    ctx.lineWidth = isBar ? 1 : 0.5
    ctx.beginPath()
    ctx.moveTo(x, y0 + (isBar ? 0 : 10))
    ctx.lineTo(x, y0 + h)
    ctx.stroke()

    if (isBar) {
      ctx.fillStyle = C.fgDim
      ctx.font = "10px monospace"
      ctx.fillText(`${Math.floor(beat / 4) + 1}`, x + 3, y0 + 11)
    }
  }

  // Loop region
  drawLoopRegionOnTimeline(x0, y0, w, h, samplesPerCol)

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

function drawLoopRegionOnTimeline(x0: number, y0: number, w: number, h: number, samplesPerCol: number) {
  if (state.loopStart !== null && state.loopEnd !== null) {
    const lx1 = x0 + (state.loopStart - state.scrollOffset) / samplesPerCol
    const lx2 = x0 + (state.loopEnd - state.scrollOffset) / samplesPerCol
    ctx.fillStyle = "rgba(176, 128, 224, 0.25)"
    const clampX1 = Math.max(x0, lx1)
    const clampX2 = Math.min(x0 + w, lx2)
    if (clampX2 > clampX1) ctx.fillRect(clampX1, y0, clampX2 - clampX1, h)

    // Start marker
    if (lx1 >= x0 && lx1 <= x0 + w) {
      ctx.strokeStyle = C.purple
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(lx1, y0)
      ctx.lineTo(lx1, y0 + h)
      ctx.stroke()
      ctx.fillStyle = C.purple
      ctx.beginPath()
      ctx.moveTo(lx1, y0)
      ctx.lineTo(lx1 + 6, y0)
      ctx.lineTo(lx1, y0 + 8)
      ctx.closePath()
      ctx.fill()
    }

    // End marker
    if (lx2 >= x0 && lx2 <= x0 + w) {
      ctx.strokeStyle = C.purple
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(lx2, y0)
      ctx.lineTo(lx2, y0 + h)
      ctx.stroke()
      ctx.fillStyle = C.purple
      ctx.beginPath()
      ctx.moveTo(lx2, y0)
      ctx.lineTo(lx2 - 6, y0)
      ctx.lineTo(lx2, y0 + 8)
      ctx.closePath()
      ctx.fill()
    }
  }

  // Loop start indicator (dashed, when setting)
  if (state.loopStart !== null && state.loopEnd === null) {
    const lx = x0 + (state.loopStart - state.scrollOffset) / samplesPerCol
    if (lx >= x0 && lx <= x0 + w) {
      ctx.strokeStyle = C.purple
      ctx.lineWidth = 2
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(lx, y0)
      ctx.lineTo(lx, y0 + h)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = C.purple
      ctx.beginPath()
      ctx.moveTo(lx, y0)
      ctx.lineTo(lx + 6, y0)
      ctx.lineTo(lx, y0 + 8)
      ctx.closePath()
      ctx.fill()
    }
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
    ctx.strokeStyle = isBar ? C.border : `${C.border}80`
    ctx.lineWidth = isBar ? 1 : 0.5
    ctx.beginPath()
    ctx.moveTo(x, y0)
    ctx.lineTo(x, y0 + gridH)
    ctx.stroke()
  }

  // Loop region in waveform area
  if (state.loopStart !== null && state.loopEnd !== null) {
    const lx1 = x0 + (state.loopStart - state.scrollOffset) / samplesPerCol
    const lx2 = x0 + (state.loopEnd - state.scrollOffset) / samplesPerCol
    ctx.fillStyle = "rgba(176, 128, 224, 0.08)"
    const clampX1 = Math.max(x0, lx1)
    const clampX2 = Math.min(x0 + w, lx2)
    if (clampX2 > clampX1) ctx.fillRect(clampX1, y0, clampX2 - clampX1, gridH)

    if (lx1 >= x0 && lx1 <= x0 + w) {
      ctx.strokeStyle = C.purple
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(lx1, y0)
      ctx.lineTo(lx1, y0 + gridH)
      ctx.stroke()
    }
    if (lx2 >= x0 && lx2 <= x0 + w) {
      ctx.strokeStyle = C.purple
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(lx2, y0)
      ctx.lineTo(lx2, y0 + gridH)
      ctx.stroke()
    }
  }

  // Loop start indicator (dashed)
  if (state.loopStart !== null && state.loopEnd === null) {
    const lx = x0 + (state.loopStart - state.scrollOffset) / samplesPerCol
    if (lx >= x0 && lx <= x0 + w) {
      ctx.strokeStyle = C.purple
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(lx, y0)
      ctx.lineTo(lx, y0 + gridH)
      ctx.stroke()
      ctx.setLineDash([])
    }
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
      ctx.strokeStyle = C.border
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
  ctx.fillStyle = C.border
  ctx.fillRect(0, y, W, 1)

  ctx.fillStyle = C.fgDim
  ctx.font = "11px monospace"
  const textY = y + STATUSBAR_H / 2 + 4
  const shortcuts = "Space Play  P Loop  R Arm  M Mute  S Solo  C Click  +/- BPM  I Import  Dbl-click slider = reset"
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

// ── Loop ────────────────────────────────────────────────────────────────
function toggleLoop() {
  if (state.transportState !== "stopped") {
    if (state.loopStart !== null && state.loopEnd !== null) {
      state.loopStart = null
      state.loopEnd = null
      audio.setLoop(null, null)
      showStatus("Loop cleared")
    }
    render()
    return
  }

  if (state.loopStart === null && state.loopEnd === null) {
    state.loopStart = state.playheadPosition
    showStatus("Loop start set — move playhead, press P again for end")
  } else if (state.loopStart !== null && state.loopEnd === null) {
    const a = state.loopStart
    const b = state.playheadPosition
    if (a === b) {
      state.loopStart = null
      showStatus("Loop cancelled (start = end)")
    } else {
      state.loopStart = Math.min(a, b)
      state.loopEnd = Math.max(a, b)
      showStatus("Loop region set — press P to clear")
    }
  } else {
    state.loopStart = null
    state.loopEnd = null
    showStatus("Loop cleared")
  }
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
    if (!audio.generateClick(state.bpm, duration)) {
      showStatus("Click buffer allocation failed (memory limit)")
    }
    audio.setClick(true, state.bpm)
    audio.setClickVolume(state.clickVolume)
    audio.setClickPan(state.clickPan)
  }

  if (state.loopStart !== null && state.loopEnd !== null) {
    if (state.playheadPosition <= state.loopEnd) {
      audio.setLoop(state.loopStart, state.loopEnd)
    } else {
      audio.setLoop(null, null)
    }
  } else {
    audio.setLoop(null, null)
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
  const duration = Math.max(outputDuration + SAMPLE_RATE * 10, SAMPLE_RATE * 30)
  return Math.min(duration, SAMPLE_RATE * 180)
}

// ── Scrolling ───────────────────────────────────────────────────────────
function syncLoopAfterSeek() {
  if (state.loopStart !== null && state.loopEnd !== null) {
    if (state.playheadPosition > state.loopEnd) {
      audio.setLoop(null, null)
    } else {
      audio.setLoop(state.loopStart, state.loopEnd)
    }
  }
}

function autoScroll() {
  const w = W - SIDEBAR_W
  const samplesPerCol = getSamplesPerCol(w)
  const visibleSamples = w * samplesPerCol

  if (state.loopStart !== null && state.loopEnd !== null) {
    const loopLen = state.loopEnd - state.loopStart
    if (loopLen < visibleSamples &&
        state.playheadPosition >= state.loopStart &&
        state.playheadPosition <= state.loopEnd) {
      const loopCenter = state.loopStart + loopLen / 2
      state.scrollOffset = Math.max(0, loopCenter - Math.floor(visibleSamples / 2))
      return
    }
  }

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
type Zone = "topbar-play" | "topbar-loop" | "topbar-click" | "topbar-bpm-minus" | "topbar-bpm-plus" | "topbar-bpm-text"
           | "topbar-save" | "topbar-open"
           | "topbar-import" | "topbar-export" | "topbar-add-track" | "topbar"
           | "sidebar-click" | "sidebar-click-vol" | "sidebar-click-pan"
           | "sidebar-track" | "sidebar-btn" | "sidebar-vol-slider" | "sidebar-pan-slider"
           | "timeline" | "waveform" | "statusbar" | "none"

interface HitResult {
  zone: Zone
  trackIndex: number
  btnAction?: "mute" | "solo" | "arm" | "delete"
  localX: number
  localY: number
  sliderFrac?: number  // 0-1 position within slider
}

function hitTest(cx: number, cy: number): HitResult {
  const result: HitResult = { zone: "none", trackIndex: -1, localX: cx, localY: cy }

  // Topbar
  if (cy < TOPBAR_H) {
    const layout = getTopbarLayout()

    if (inRect(cx, cy, layout.play)) { result.zone = "topbar-play"; return result }
    if (inRect(cx, cy, layout.loop)) { result.zone = "topbar-loop"; return result }
    if (inRect(cx, cy, layout.click)) { result.zone = "topbar-click"; return result }
    if (inRect(cx, cy, layout.bpmMinus)) { result.zone = "topbar-bpm-minus"; return result }
    if (inRect(cx, cy, layout.bpmPlus)) { result.zone = "topbar-bpm-plus"; return result }
    if (inRect(cx, cy, layout.bpmText)) { result.zone = "topbar-bpm-text"; return result }
    if (inRect(cx, cy, layout.importBtn)) { result.zone = "topbar-import"; return result }
    if (inRect(cx, cy, layout.exportBtn)) { result.zone = "topbar-export"; return result }
    if (inRect(cx, cy, layout.addTrack)) { result.zone = "topbar-add-track"; return result }
    if (inRect(cx, cy, layout.saveBtn)) { result.zone = "topbar-save"; return result }
    if (inRect(cx, cy, layout.openBtn)) { result.zone = "topbar-open"; return result }

    result.zone = "topbar"
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
    if (sideY >= 0 && sideY < CLICK_ROW_H) {
      result.trackIndex = -1

      // Check volume slider (row 2)
      const sliderY = 24 // relative to click row top
      const localSliderY = sideY - sliderY
      if (localSliderY >= -4 && localSliderY <= SLIDER_H + 4) {
        // Volume slider
        const volGeo = getSliderGeometry(SLIDER_PAD)
        if (cx >= volGeo.trackX - 8 && cx <= volGeo.trackX + volGeo.trackW + 8) {
          result.zone = "sidebar-click-vol"
          result.sliderFrac = Math.max(0, Math.min(1, (cx - volGeo.trackX) / volGeo.trackW))
          return result
        }
        // Pan slider
        const panX = SLIDER_PAD + (SIDEBAR_W - SLIDER_PAD * 2 - 30) / 2 + 16
        const panGeo = getSliderGeometry(panX)
        if (cx >= panGeo.trackX - 8 && cx <= panGeo.trackX + panGeo.trackW + 8) {
          result.zone = "sidebar-click-pan"
          result.sliderFrac = Math.max(0, Math.min(1, (cx - panGeo.trackX) / panGeo.trackW))
          return result
        }
      }

      result.zone = "sidebar-click"
      return result
    }

    // Regular tracks
    const trackY = sideY - CLICK_ROW_H
    const trackIdx = Math.floor(trackY / TRACK_H)
    if (trackIdx >= 0 && trackIdx < state.tracks.length) {
      result.trackIndex = trackIdx
      const localY = trackY - trackIdx * TRACK_H

      // Delete button (top-right of name row, y+4..y+28)
      const pad = 8
      const delBtnX = SIDEBAR_W - pad - 28
      if (localY >= 4 && localY < 28 && cx >= delBtnX && cx < delBtnX + 28) {
        result.zone = "sidebar-btn"; result.btnAction = "delete"; return result
      }

      // MSR buttons (y+28..y+28+MSR_BTN_H)
      if (localY >= 28 && localY < 28 + MSR_BTN_H) {
        const lx = cx - pad
        if (lx >= 0 && lx < MSR_BTN_W) {
          result.zone = "sidebar-btn"; result.btnAction = "mute"; return result
        } else if (lx >= MSR_BTN_W + 6 && lx < (MSR_BTN_W + 6) * 2) {
          result.zone = "sidebar-btn"; result.btnAction = "solo"; return result
        } else if (lx >= (MSR_BTN_W + 6) * 2 && lx < (MSR_BTN_W + 6) * 3) {
          result.zone = "sidebar-btn"; result.btnAction = "arm"; return result
        }
      }

      // Volume slider (y+62)
      if (localY >= 58 && localY <= 62 + SLIDER_H + 4) {
        const volGeo = getSliderGeometry(SLIDER_PAD)
        if (cx >= volGeo.trackX - 8 && cx <= volGeo.trackX + volGeo.trackW + 8) {
          result.zone = "sidebar-vol-slider"
          result.sliderFrac = Math.max(0, Math.min(1, (cx - volGeo.trackX) / volGeo.trackW))
          return result
        }
      }

      // Pan slider (y+90)
      if (localY >= 86 && localY <= 90 + SLIDER_H + 4) {
        const panGeo = getSliderGeometry(SLIDER_PAD)
        if (cx >= panGeo.trackX - 8 && cx <= panGeo.trackX + panGeo.trackW + 8) {
          result.zone = "sidebar-pan-slider"
          result.sliderFrac = Math.max(0, Math.min(1, (cx - panGeo.trackX) / panGeo.trackW))
          return result
        }
      }

      result.zone = "sidebar-track"
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

function inRect(x: number, y: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

// ── Double-click detection ──────────────────────────────────────────────
function checkDoubleClick(zone: string, trackIndex: number): boolean {
  const now = performance.now()
  const isDouble = (now - lastClickTime < 400) && lastClickZone === zone && lastClickTrack === trackIndex
  lastClickTime = now
  lastClickZone = zone
  lastClickTrack = trackIndex
  return isDouble
}

// ── Mouse Handling ──────────────────────────────────────────────────────
function setupMouse() {
  // Pointer down (for click + drag start)
  canvas.addEventListener("pointerdown", (e) => {
    const hit = hitTest(e.clientX, e.clientY)

    switch (hit.zone) {
      case "topbar-play":
        if (state.transportState !== "stopped") stopTransport()
        else play()
        break

      case "topbar-loop":
        toggleLoop()
        break

      case "topbar-click":
        state.clickEnabled = !state.clickEnabled
        if (state.transportState !== "stopped") {
          if (state.clickEnabled) {
            if (!audio.generateClick(state.bpm, getClickDuration())) {
              showStatus("Click buffer allocation failed")
            }
            audio.setClick(true, state.bpm)
            audio.setClickVolume(state.clickVolume)
            audio.setClickPan(state.clickPan)
          } else {
            audio.setClick(false, 0)
          }
        }
        render()
        break

      case "topbar-bpm-minus":
        state.bpm = Math.max(20, state.bpm - 1)
        if (audio.isReady) audio.setSpeed(state.bpm / state.originalBpm)
        render()
        break

      case "topbar-bpm-plus":
        state.bpm = Math.min(300, state.bpm + 1)
        if (audio.isReady) audio.setSpeed(state.bpm / state.originalBpm)
        render()
        break

      case "topbar-bpm-text":
        // Double-click resets BPM to original
        if (checkDoubleClick("bpm", -1)) {
          state.bpm = state.originalBpm
          if (audio.isReady) audio.setSpeed(1)
          showStatus(`BPM reset to ${state.originalBpm}`)
          render()
        }
        break

      case "topbar-import":
        importWav()
        break

      case "topbar-export":
        showStatus("Export not yet implemented in Web UI")
        break

      case "topbar-save":
        saveProject()
        break

      case "topbar-open":
        openProject()
        break

      case "topbar-add-track":
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

      case "sidebar-click":
        state.selectedTrackIndex = -1
        render()
        break

      case "sidebar-click-vol":
        if (checkDoubleClick("click-vol", -1)) {
          state.clickVolume = DEFAULT_CLICK_VOLUME
          if (audio.isReady) audio.setClickVolume(state.clickVolume)
          showStatus(`Click volume reset to ${Math.round(DEFAULT_CLICK_VOLUME * 100)}%`)
          render()
        } else if (hit.sliderFrac !== undefined) {
          state.clickVolume = hit.sliderFrac * 2 // 0-2 range
          if (audio.isReady) audio.setClickVolume(state.clickVolume)
          state.selectedTrackIndex = -1
          drag = { type: "click-volume", trackIndex: -1, startValue: state.clickVolume }
          render()
        }
        break

      case "sidebar-click-pan":
        if (checkDoubleClick("click-pan", -1)) {
          state.clickPan = DEFAULT_CLICK_PAN
          if (audio.isReady) audio.setClickPan(state.clickPan)
          showStatus("Click pan reset to center")
          render()
        } else if (hit.sliderFrac !== undefined) {
          state.clickPan = hit.sliderFrac * 2 - 1 // -1 to +1
          if (audio.isReady) audio.setClickPan(state.clickPan)
          state.selectedTrackIndex = -1
          drag = { type: "click-pan", trackIndex: -1, startValue: state.clickPan }
          render()
        }
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
          } else if (track && hit.btnAction === "delete") {
            state.selectedTrackIndex = hit.trackIndex
            if (state.transportState !== "stopped") {
              showStatus("Stop transport first (Space)")
            } else if (track.samples && track.samples.length > 0) {
              track.samples = null
              if (audio.isReady) audio.setTrackSamples(track.id, null)
              showStatus(`Cleared "${track.name}"`)
            } else if (state.tracks.length > 1) {
              if (audio.isReady) audio.removeTrack(track.id)
              state.tracks.splice(hit.trackIndex, 1)
              if (state.selectedTrackIndex >= state.tracks.length) {
                state.selectedTrackIndex = state.tracks.length - 1
              }
              showStatus(`Deleted "${track.name}"`)
            } else {
              showStatus("Last track — nothing to delete")
            }
          }
          render()
        }
        break

      case "sidebar-vol-slider":
        if (hit.trackIndex >= 0) {
          const track = state.tracks[hit.trackIndex]
          if (track) {
            if (checkDoubleClick("vol-slider", hit.trackIndex)) {
              track.volume = DEFAULT_VOLUME
              if (audio.isReady) audio.setTrackVolume(track.id, track.volume)
              showStatus(`Volume reset to ${Math.round(DEFAULT_VOLUME * 100)}%`)
            } else if (hit.sliderFrac !== undefined) {
              track.volume = hit.sliderFrac // 0-1 range
              if (audio.isReady) audio.setTrackVolume(track.id, track.volume)
              drag = { type: "volume", trackIndex: hit.trackIndex, startValue: track.volume }
            }
            state.selectedTrackIndex = hit.trackIndex
            render()
          }
        }
        break

      case "sidebar-pan-slider":
        if (hit.trackIndex >= 0) {
          const track = state.tracks[hit.trackIndex]
          if (track) {
            if (checkDoubleClick("pan-slider", hit.trackIndex)) {
              track.pan = DEFAULT_PAN
              if (audio.isReady) audio.setTrackPan(track.id, track.pan)
              showStatus("Pan reset to center")
            } else if (hit.sliderFrac !== undefined) {
              track.pan = hit.sliderFrac * 2 - 1 // -1 to +1
              if (audio.isReady) audio.setTrackPan(track.id, track.pan)
              drag = { type: "pan", trackIndex: hit.trackIndex, startValue: track.pan }
            }
            state.selectedTrackIndex = hit.trackIndex
            render()
          }
        }
        break

      case "timeline": {
        const w = W - SIDEBAR_W
        const samplesPerCol = getSamplesPerCol(w)
        state.playheadPosition = Math.max(0, Math.floor(state.scrollOffset + hit.localX * samplesPerCol))
        if (state.transportState !== "stopped") {
          audio.setPlayhead(state.playheadPosition)
          syncLoopAfterSeek()
          state.freeScroll = true
        }
        drag = { type: "timeline", trackIndex: -2, startValue: state.playheadPosition }
        render()
        break
      }

      case "waveform":
        if (hit.trackIndex >= 0) {
          state.selectedTrackIndex = hit.trackIndex
        }
        drag = { type: "waveform-scroll", trackIndex: -2, startValue: e.clientX }
        render()
        break
    }
  })

  // Pointer move (drag handling)
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) {
      // Cursor style
      const hit = hitTest(e.clientX, e.clientY)
      if (hit.zone !== "none" && hit.zone !== "topbar" && hit.zone !== "statusbar" && hit.zone !== "waveform") {
        canvas.style.cursor = "pointer"
      } else {
        canvas.style.cursor = "default"
      }
      return
    }

    if (drag.type === "volume" && drag.trackIndex >= 0) {
      const track = state.tracks[drag.trackIndex]
      if (track) {
        const geo = getSliderGeometry(SLIDER_PAD)
        const frac = Math.max(0, Math.min(1, (e.clientX - geo.trackX) / geo.trackW))
        track.volume = frac
        if (audio.isReady) audio.setTrackVolume(track.id, track.volume)
        render()
      }
    } else if (drag.type === "pan" && drag.trackIndex >= 0) {
      const track = state.tracks[drag.trackIndex]
      if (track) {
        const geo = getSliderGeometry(SLIDER_PAD)
        const frac = Math.max(0, Math.min(1, (e.clientX - geo.trackX) / geo.trackW))
        track.pan = frac * 2 - 1
        if (audio.isReady) audio.setTrackPan(track.id, track.pan)
        render()
      }
    } else if (drag.type === "click-volume") {
      const geo = getSliderGeometry(SLIDER_PAD)
      const frac = Math.max(0, Math.min(1, (e.clientX - geo.trackX) / geo.trackW))
      state.clickVolume = frac * 2
      if (audio.isReady) audio.setClickVolume(state.clickVolume)
      render()
    } else if (drag.type === "click-pan") {
      const panX = SLIDER_PAD + (SIDEBAR_W - SLIDER_PAD * 2 - 30) / 2 + 16
      const geo = getSliderGeometry(panX)
      const frac = Math.max(0, Math.min(1, (e.clientX - geo.trackX) / geo.trackW))
      state.clickPan = frac * 2 - 1
      if (audio.isReady) audio.setClickPan(state.clickPan)
      render()
    } else if (drag.type === "timeline") {
      const w = W - SIDEBAR_W
      const samplesPerCol = getSamplesPerCol(w)
      const lx = e.clientX - SIDEBAR_W
      state.playheadPosition = Math.max(0, Math.floor(state.scrollOffset + lx * samplesPerCol))
      if (state.transportState !== "stopped") {
        audio.setPlayhead(state.playheadPosition)
        syncLoopAfterSeek()
      }
      render()
    } else if (drag.type === "waveform-scroll") {
      const dx = drag.startValue - e.clientX
      const w = W - SIDEBAR_W
      const samplesPerCol = getSamplesPerCol(w)
      const deltaSamples = dx * samplesPerCol
      state.scrollOffset = Math.max(0, state.scrollOffset + deltaSamples)
      if (state.transportState !== "stopped") state.freeScroll = true
      drag.startValue = e.clientX
      render()
    }
  })

  // Pointer up (end drag)
  canvas.addEventListener("pointerup", () => {
    drag = null
  })

  // Also end drag on pointer leave
  canvas.addEventListener("pointerleave", () => {
    drag = null
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
    } else if ((hit.zone === "sidebar-track" || hit.zone === "sidebar-vol-slider") && hit.trackIndex >= 0) {
      const track = state.tracks[hit.trackIndex]
      if (track) {
        const delta = e.deltaY > 0 ? -0.05 : 0.05
        track.volume = Math.max(0, Math.min(1, track.volume + delta))
        if (audio.isReady) audio.setTrackVolume(track.id, track.volume)
        render()
      }
    } else if (hit.zone === "sidebar-pan-slider" && hit.trackIndex >= 0) {
      const track = state.tracks[hit.trackIndex]
      if (track) {
        const delta = e.deltaY > 0 ? -0.05 : 0.05
        track.pan = Math.max(-1, Math.min(1, track.pan + delta))
        if (audio.isReady) audio.setTrackPan(track.id, track.pan)
        render()
      }
    } else if (hit.zone === "sidebar-click" || hit.zone === "sidebar-click-vol") {
      const delta = e.deltaY > 0 ? -0.05 : 0.05
      state.clickVolume = Math.max(0, Math.min(2, state.clickVolume + delta))
      if (audio.isReady) audio.setClickVolume(state.clickVolume)
      render()
    } else if (hit.zone === "sidebar-click-pan") {
      const delta = e.deltaY > 0 ? -0.05 : 0.05
      state.clickPan = Math.max(-1, Math.min(1, state.clickPan + delta))
      if (audio.isReady) audio.setClickPan(state.clickPan)
      render()
    }
  }, { passive: false })

  // Touch events: prevent default to avoid scrolling/zooming on iPad
  canvas.addEventListener("touchstart", (e) => { e.preventDefault() }, { passive: false })
  canvas.addEventListener("touchmove", (e) => { e.preventDefault() }, { passive: false })
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

      case "p":
        toggleLoop()
        break

      case "m":
        if (state.selectedTrackIndex === -1) {
          state.clickEnabled = !state.clickEnabled
          if (state.transportState !== "stopped") {
            if (state.clickEnabled) {
              if (!audio.generateClick(state.bpm, getClickDuration())) {
                showStatus("Click buffer allocation failed")
              }
              audio.setClick(true, state.bpm)
              audio.setClickVolume(state.clickVolume)
              audio.setClickPan(state.clickPan)
            } else {
              audio.setClick(false, 0)
            }
          }
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
            if (!audio.generateClick(state.bpm, getClickDuration())) {
              showStatus("Click buffer allocation failed")
            }
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
        state.bpm = Math.min(300, state.bpm + 1)
        if (audio.isReady) audio.setSpeed(state.bpm / state.originalBpm)
        render()
        break

      case "-":
        state.bpm = Math.max(20, state.bpm - 1)
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
        if (state.transportState !== "stopped") {
          audio.setPlayhead(state.playheadPosition)
          syncLoopAfterSeek()
        }
        ensurePlayheadVisible()
        render()
        break
      }

      case "]": {
        const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
        state.playheadPosition += samplesPerBeat * 4
        if (state.transportState !== "stopped") {
          audio.setPlayhead(state.playheadPosition)
          syncLoopAfterSeek()
        }
        ensurePlayheadVisible()
        render()
        break
      }

      case "Home":
      case "0":
        state.playheadPosition = 0
        state.scrollOffset = 0
        state.freeScroll = false
        if (state.transportState !== "stopped") {
          audio.setPlayhead(0)
          syncLoopAfterSeek()
        }
        render()
        break

      case "End": {
        let maxLen = 0
        for (const t of state.tracks) {
          if (t.samples && t.samples.length > maxLen) maxLen = t.samples.length
        }
        state.playheadPosition = maxLen
        if (state.transportState !== "stopped") {
          audio.setPlayhead(maxLen)
          syncLoopAfterSeek()
        }
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

// ── Tar utilities (pure JS, browser-compatible) ─────────────────────────
// Minimal tar creator/extractor for .tuidaw project files.
// Uses USTAR format (POSIX). Supports files up to 8GB (octal encoding).

function tarWriteString(buf: Uint8Array, offset: number, str: string, len: number) {
  for (let i = 0; i < len; i++) {
    buf[offset + i] = i < str.length ? str.charCodeAt(i) : 0
  }
}

function tarWriteOctal(buf: Uint8Array, offset: number, value: number, len: number) {
  const s = value.toString(8).padStart(len - 1, "0")
  for (let i = 0; i < len - 1; i++) buf[offset + i] = s.charCodeAt(i)
  buf[offset + len - 1] = 0
}

function tarComputeChecksum(header: Uint8Array): number {
  // Checksum field (offset 148, length 8) is treated as spaces during computation
  let sum = 0
  for (let i = 0; i < 512; i++) {
    sum += (i >= 148 && i < 156) ? 32 : header[i]
  }
  return sum
}

function tarCreateEntry(filename: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512)
  tarWriteString(header, 0, filename, 100)       // name
  tarWriteOctal(header, 100, 0o644, 8)           // mode
  tarWriteOctal(header, 108, 0, 8)               // uid
  tarWriteOctal(header, 116, 0, 8)               // gid
  tarWriteOctal(header, 124, data.length, 12)    // size
  tarWriteOctal(header, 136, Math.floor(Date.now() / 1000), 12) // mtime
  tarWriteString(header, 257, "ustar", 6)        // magic
  tarWriteString(header, 263, "00", 2)            // version

  const checksum = tarComputeChecksum(header)
  tarWriteOctal(header, 148, checksum, 7)
  header[155] = 32 // space after checksum

  // Data blocks (padded to 512-byte boundary)
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
  // Two zero blocks = end of archive
  totalSize += 1024
  const tar = new Uint8Array(totalSize)
  let offset = 0
  for (const entry of entries) {
    tar.set(entry, offset)
    offset += entry.length
  }
  return tar
}

function tarReadOctal(buf: Uint8Array, offset: number, len: number): number {
  let s = ""
  for (let i = 0; i < len; i++) {
    const c = buf[offset + i]
    if (c === 0 || c === 32) break
    s += String.fromCharCode(c)
  }
  return parseInt(s, 8) || 0
}

function tarReadString(buf: Uint8Array, offset: number, len: number): string {
  let s = ""
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
    // Check for zero block (end of archive)
    let allZero = true
    for (let i = 0; i < 512; i++) { if (header[i] !== 0) { allZero = false; break } }
    if (allZero) break

    const name = tarReadString(header, 0, 100)
    const size = tarReadOctal(header, 124, 12)
    const typeFlag = header[156]

    offset += 512
    // typeFlag 0 or ASCII '0' (48) = regular file, also accept missing (NUL)
    if (typeFlag === 0 || typeFlag === 48) {
      const data = tar.slice(offset, offset + size)
      // Strip leading "./" from filenames (TUI saves with -C tmpDir .)
      const cleanName = name.replace(/^\.\//, "")
      if (cleanName) files.push({ name: cleanName, data })
    }
    offset += Math.ceil(size / 512) * 512
  }
  return files
}

async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip")
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
  for (const c of chunks) { result.set(c, off); off += c.length }
  return result
}

async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip")
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
  for (const c of chunks) { result.set(c, off); off += c.length }
  return result
}

// ── Project Save ────────────────────────────────────────────────────────
async function saveProject() {
  if (state.transportState !== "stopped") {
    showStatus("Stop transport first")
    return
  }

  showStatus("Saving project...")

  try {
    const files: { name: string; data: Uint8Array }[] = []
    const trackDescs: TrackDescriptor[] = []

    for (const track of state.tracks) {
      let wavFile: string | null = null
      if (track.samples && track.samples.length > 0) {
        const safeName = track.id.replace(/[^a-zA-Z0-9_-]/g, "_")
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
        wavFile,
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
      tracks: trackDescs,
    }

    const encoder = new TextEncoder()
    files.unshift({ name: "project.json", data: encoder.encode(JSON.stringify(descriptor, null, 2)) })

    const tar = tarCreate(files)
    const gz = await gzipCompress(tar)

    // Trigger browser download
    const blob = new Blob([gz.buffer as ArrayBuffer], { type: "application/gzip" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${state.projectName}.tuidaw`
    a.click()
    URL.revokeObjectURL(url)

    showStatus(`Project saved: ${state.projectName}.tuidaw`)
  } catch (err) {
    showStatus(`Save error: ${err}`)
    console.error("Project save failed:", err)
  }
}

// ── Project Open ────────────────────────────────────────────────────────
async function openProject() {
  if (state.transportState !== "stopped") {
    showStatus("Stop transport first")
    return
  }

  const input = document.createElement("input")
  input.type = "file"
  input.accept = ".tuidaw"

  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return

    showStatus(`Opening: ${file.name}...`)

    try {
      const arrayBuf = await file.arrayBuffer()
      const gz = new Uint8Array(arrayBuf)
      const tar = await gzipDecompress(gz)
      const entries = tarExtract(tar)

      // Find project.json
      const projectEntry = entries.find(e => e.name === "project.json")
      if (!projectEntry) {
        showStatus("Invalid project file: no project.json found")
        return
      }

      const decoder = new TextDecoder()
      const desc = JSON.parse(decoder.decode(projectEntry.data)) as ProjectDescriptor

      // Build track lookup (WAV data by filename)
      const wavMap = new Map<string, Uint8Array>()
      for (const entry of entries) {
        if (entry.name.startsWith("tracks/") && entry.name.endsWith(".wav")) {
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
      state.selectedTrackIndex = Math.min(desc.selectedTrackIndex, newTracks.length - 1)
      state.freeScroll = false

      // Update nextTrackNum
      let maxNum = 0
      for (const t of newTracks) {
        const m = t.name.match(/^Track (\d+)$/)
        if (m) maxNum = Math.max(maxNum, parseInt(m[1]))
      }
      nextTrackNum = maxNum + 1

      // Sync all tracks to audio engine
      if (audio.isReady) {
        for (const track of state.tracks) {
          audio.syncTrack(track)
        }
      }

      const baseName = file.name.replace(/\.tuidaw$/i, "")
      showStatus(`Opened: ${baseName} (${newTracks.length} tracks)`)
      render()
    } catch (err) {
      showStatus(`Open error: ${err}`)
      console.error("Project open failed:", err)
    }
  }

  input.click()
}

// ── Init ────────────────────────────────────────────────────────────────
async function init() {
  _debugLog(`init: ${W}x${H}, dpr=${dpr}`)
  resize()
  window.addEventListener("resize", resize)

  // Show loading state
  drawLoadingScreen("Loading WASM audio engine...")

  try {
    _debugLog("Loading WASM script...")
    await loadScript("/wasm/tuidaw_audio.js")
    _debugLog("WASM script loaded OK")
  } catch (err) {
    _debugError(`WASM load failed: ${err}`)
    drawLoadingScreen(`Failed to load WASM: ${err}`)
    console.error("WASM load failed:", err)
    return
  }

  _debugLog("Setting up mouse + keyboard...")
  setupMouse()
  setupKeyboard()
  _debugLog("Rendering initial frame...")
  render()
  _debugHide()
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
init().catch((err) => {
  _debugError(`init() crashed: ${err?.stack || err}`)
  console.error(err)
})
