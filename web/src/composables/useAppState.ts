// ============================================================================
// useAppState — Reactive DAW application state
// ============================================================================

import { reactive } from 'vue'
import type { WebTrack, InputDeviceInfo } from '../../audio-bridge'

// ── OLED Color Palette ──────────────────────────────────────────────────
export const C = {
  bg: '#000000',
  bgHighlight: '#1a1a1a',
  border: '#2a2a2a',
  fg: '#e8e8e8',
  fgDim: '#666666',
  blue: '#5b9cf5',
  cyan: '#56d4f0',
  green: '#6cc644',
  magenta: '#c678dd',
  red: '#f05060',
  orange: '#e89040',
  yellow: '#e0c050',
  purple: '#b080e0'
} as const

export const TRACK_COLORS = [
  '#5b9cf5',
  '#6cc644',
  '#f05060',
  '#e89040',
  '#c678dd',
  '#56d4f0',
  '#e0c050',
  '#4ec9a0'
]

// ── Layout Constants ────────────────────────────────────────────────────
export const SAMPLE_RATE = 48000
export const SIDEBAR_W = 260
export const TOPBAR_H = 56
export const STATUSBAR_H = 36
export const TIMELINE_H = 48
export const TRACK_H = 120
export const CLICK_ROW_H = TIMELINE_H // must match so sidebar aligns with waveform

// Button sizing
export const MSR_BTN_W = 32
export const MSR_BTN_H = 28

// Slider dimensions
export const SLIDER_H = 20
export const SLIDER_KNOB_W = 12
export const SLIDER_KNOB_H = 24
export const SLIDER_PAD = 8
export const FULL_SLIDER_W = SIDEBAR_W - SLIDER_PAD * 2

// Nudge button dimensions
export const NUDGE_BTN_W = 36
export const NUDGE_BTN_H = 36
export const NUDGE_BTN_GAP = 4
export const NUDGE_BTN_PAD = 8

// Default values for double-click reset
export const DEFAULT_VOLUME = 0.8
export const DEFAULT_PAN = 0
export const DEFAULT_CLICK_VOLUME = 0.5
export const DEFAULT_CLICK_PAN = 0

// ── Types ───────────────────────────────────────────────────────────────
export type TransportState = 'stopped' | 'playing' | 'recording'

export interface AppState {
  projectName: string
  tracks: WebTrack[]
  selectedTrackIndex: number // -1 = click track selected
  transportState: TransportState
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
  trackScrollY: number
  // UI overlay state
  showInputOverlay: boolean
  inputDevices: InputDeviceInfo[]
}

// ── Helpers ─────────────────────────────────────────────────────────────
let _nextTrackNum = 2

export function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID)
    return crypto.randomUUID()
  const a = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues)
    crypto.getRandomValues(a)
  else for (let i = 0; i < 16; i++) a[i] = (Math.random() * 256) | 0
  a[6] = (a[6] & 0x0f) | 0x40
  a[8] = (a[8] & 0x3f) | 0x80
  const h = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function createTrack(name: string, colorIndex: number): WebTrack {
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
    inputDeviceId: null,
    inputChannel: 0
  }
}

export function getNextTrackNum(): number {
  return _nextTrackNum++
}

export function setNextTrackNum(n: number): void {
  _nextTrackNum = n
}

export function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.01) return 'C'
  const pct = Math.round(Math.abs(pan) * 100)
  return pan < 0 ? `L${pct}` : `R${pct}`
}

export function formatTime(
  positionSamples: number,
  sampleRate: number
): string {
  const totalSeconds = Math.max(0, positionSamples / sampleRate)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
}

export function getSamplesPerCol(canvasWidth: number): number {
  return Math.max(1, Math.round(SAMPLE_RATE * 0.005))
}

// ── Singleton State ─────────────────────────────────────────────────────
let _state: AppState | null = null

export function useAppState(): AppState {
  if (!_state) {
    _state = reactive<AppState>({
      projectName: 'Untitled',
      tracks: [createTrack('Track 1', 0)],
      selectedTrackIndex: 0,
      transportState: 'stopped',
      playheadPosition: 0,
      scrollOffset: 0,
      freeScroll: false,
      bpm: 120,
      originalBpm: 120,
      clickEnabled: false,
      clickVolume: DEFAULT_CLICK_VOLUME,
      clickPan: DEFAULT_CLICK_PAN,
      loopStart: null,
      loopEnd: null,
      sampleRate: SAMPLE_RATE,
      statusMessage: '',
      statusTimeout: null,
      trackScrollY: 0,
      showInputOverlay: false,
      inputDevices: []
    })
  }
  return _state
}

// ── Status Message ──────────────────────────────────────────────────────
export function showStatus(msg: string): void {
  const s = useAppState()
  if (s.statusTimeout) clearTimeout(s.statusTimeout)
  s.statusMessage = msg
  s.statusTimeout = setTimeout(() => {
    s.statusMessage = ''
    s.statusTimeout = null
  }, 3000)
}

// ── Track Scroll ────────────────────────────────────────────────────────
/** Compute the maximum trackScrollY value (0 if all tracks fit on screen) */
export function getMaxTrackScroll(): number {
  const s = useAppState()
  const availableH = window.innerHeight - TOPBAR_H - STATUSBAR_H - CLICK_ROW_H
  const totalTrackH = s.tracks.length * TRACK_H
  return Math.max(0, totalTrackH - availableH)
}

/** Clamp trackScrollY to valid range */
export function clampTrackScroll(): void {
  const s = useAppState()
  s.trackScrollY = Math.max(0, Math.min(getMaxTrackScroll(), s.trackScrollY))
}

/** Ensure the selected track (by index) is visible in the scrolled sidebar */
export function ensureTrackVisible(trackIdx: number): void {
  if (trackIdx < 0) return // click track is always visible
  const s = useAppState()
  const trackTop = trackIdx * TRACK_H
  const trackBottom = trackTop + TRACK_H
  const availableH = window.innerHeight - TOPBAR_H - STATUSBAR_H - CLICK_ROW_H
  if (trackTop < s.trackScrollY) {
    s.trackScrollY = trackTop
  } else if (trackBottom > s.trackScrollY + availableH) {
    s.trackScrollY = trackBottom - availableH
  }
  clampTrackScroll()
}
