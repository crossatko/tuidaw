<script setup vapor lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import {
  useAppState,
  C,
  SAMPLE_RATE,
  SIDEBAR_W,
  STATUSBAR_H,
  TIMELINE_H,
  TRACK_H,
  NUDGE_BTN_W,
  NUDGE_BTN_H,
  NUDGE_BTN_GAP,
  NUDGE_BTN_PAD
} from '../composables/useAppState'
import {
  setRenderCallback,
  seekTo,
  seekByBars,
  ensurePlayheadVisible,
  syncLoopAfterSeek,
  nudgeTrack
} from '../composables/useTransport'
import { getAudio } from '../composables/useAudio'

const state = useAppState()
const canvasRef = ref<HTMLCanvasElement | null>(null)

let ctx: CanvasRenderingContext2D | null = null
let dpr = 1
let W = 0 // logical width of the canvas
let H = 0 // logical height of the canvas

// ── Render coalescing ───────────────────────────────────────────────────
// Multiple sources can request renders in the same frame (transport polling,
// reactive watch, pointer events). We coalesce them into a single draw call
// using a dirty flag + RAF scheduling.
let renderDirty = false
let renderRafId: number | null = null

function scheduleRender(): void {
  renderDirty = true
  if (renderRafId === null) {
    renderRafId = requestAnimationFrame(() => {
      renderRafId = null
      if (renderDirty) {
        renderDirty = false
        render()
      }
    })
  }
}

// ── Drag state ──────────────────────────────────────────────────────────
interface DragState {
  type: 'timeline' | 'waveform-scroll'
  startValue: number
}

let drag: DragState | null = null

// ── Samples per column (width-dependent zoom) ───────────────────────────
function getSamplesPerCol(): number {
  return Math.max(1, Math.floor((SAMPLE_RATE / (W * 2)) * 10) * 2)
}

// ── Canvas resize ───────────────────────────────────────────────────────
function resize() {
  const canvas = canvasRef.value
  if (!canvas) return

  dpr = window.devicePixelRatio || 1
  // Canvas fills the flex container — read its layout size
  const rect = canvas.getBoundingClientRect()
  W = Math.round(rect.width)
  H = Math.round(rect.height)

  canvas.width = W * dpr
  canvas.height = H * dpr

  ctx = canvas.getContext('2d')
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  render()
}

// ── Drawing ─────────────────────────────────────────────────────────────

// Snapshot of reactive state read once per frame to avoid Proxy overhead
// in hot drawing loops (each state.xxx access goes through Vue's Proxy get
// trap — fine for occasional reads, but ~millions of times per frame in the
// waveform inner loop is measurably expensive).
interface RenderSnapshot {
  scrollOffset: number
  playheadPosition: number
  originalBpm: number
  loopStart: number | null
  loopEnd: number | null
  selectedTrackIndex: number
  transportState: string
  trackScrollY: number
  trackCount: number
}

function takeSnapshot(): RenderSnapshot {
  return {
    scrollOffset: state.scrollOffset,
    playheadPosition: state.playheadPosition,
    originalBpm: state.originalBpm,
    loopStart: state.loopStart,
    loopEnd: state.loopEnd,
    selectedTrackIndex: state.selectedTrackIndex,
    transportState: state.transportState,
    trackScrollY: state.trackScrollY,
    trackCount: state.tracks.length
  }
}

function render() {
  if (!ctx || W === 0 || H === 0) return
  const snap = takeSnapshot()
  ctx.clearRect(0, 0, W, H)
  drawTimeline(snap)
  drawWaveformArea(snap)
}

function drawTimeline(snap: RenderSnapshot) {
  if (!ctx) return
  const w = W
  const h = TIMELINE_H

  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, w, h)

  // Bottom border
  ctx.fillStyle = C.border
  ctx.fillRect(0, h - 1, w, 1)

  const samplesPerBeat = Math.round((60 / snap.originalBpm) * SAMPLE_RATE)
  const samplesPerCol = getSamplesPerCol()
  const scrollOff = snap.scrollOffset

  const startBeat = Math.floor(scrollOff / samplesPerBeat)
  const endSample = scrollOff + w * samplesPerCol
  const endBeat = Math.ceil(endSample / samplesPerBeat)

  for (let beat = startBeat; beat <= endBeat; beat++) {
    const samplePos = beat * samplesPerBeat
    const x = (samplePos - scrollOff) / samplesPerCol
    if (x < 0 || x >= w) continue

    const isBar = beat % 4 === 0
    ctx.strokeStyle = isBar ? C.fgDim : C.border
    ctx.lineWidth = isBar ? 1 : 0.5
    ctx.beginPath()
    ctx.moveTo(x, isBar ? 0 : 10)
    ctx.lineTo(x, h)
    ctx.stroke()

    if (isBar) {
      ctx.fillStyle = C.fgDim
      ctx.font = "10px 'IBM Plex Mono', monospace"
      ctx.fillText(`${Math.floor(beat / 4) + 1}`, x + 3, 11)
    }
  }

  // Loop region
  drawLoopRegionOnTimeline(snap, w, h, samplesPerCol)

  // Playhead
  const playheadX = (snap.playheadPosition - scrollOff) / samplesPerCol
  if (playheadX >= 0 && playheadX <= w) {
    ctx.strokeStyle = C.green
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(playheadX, 0)
    ctx.lineTo(playheadX, h)
    ctx.stroke()
  }
}

function drawLoopRegionOnTimeline(
  snap: RenderSnapshot,
  w: number,
  h: number,
  samplesPerCol: number
) {
  if (!ctx) return
  const scrollOff = snap.scrollOffset

  if (snap.loopStart !== null && snap.loopEnd !== null) {
    const lx1 = (snap.loopStart - scrollOff) / samplesPerCol
    const lx2 = (snap.loopEnd - scrollOff) / samplesPerCol
    ctx.fillStyle = 'rgba(176, 128, 224, 0.25)'
    const clampX1 = Math.max(0, lx1)
    const clampX2 = Math.min(w, lx2)
    if (clampX2 > clampX1) ctx.fillRect(clampX1, 0, clampX2 - clampX1, h)

    // Start marker
    if (lx1 >= 0 && lx1 <= w) {
      ctx.strokeStyle = C.purple
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(lx1, 0)
      ctx.lineTo(lx1, h)
      ctx.stroke()
      ctx.fillStyle = C.purple
      ctx.beginPath()
      ctx.moveTo(lx1, 0)
      ctx.lineTo(lx1 + 6, 0)
      ctx.lineTo(lx1, 8)
      ctx.closePath()
      ctx.fill()
    }

    // End marker
    if (lx2 >= 0 && lx2 <= w) {
      ctx.strokeStyle = C.purple
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(lx2, 0)
      ctx.lineTo(lx2, h)
      ctx.stroke()
      ctx.fillStyle = C.purple
      ctx.beginPath()
      ctx.moveTo(lx2, 0)
      ctx.lineTo(lx2 - 6, 0)
      ctx.lineTo(lx2, 8)
      ctx.closePath()
      ctx.fill()
    }
  }

  // Loop start indicator (dashed, when setting)
  if (snap.loopStart !== null && snap.loopEnd === null) {
    const lx = (snap.loopStart - scrollOff) / samplesPerCol
    if (lx >= 0 && lx <= w) {
      ctx.strokeStyle = C.purple
      ctx.lineWidth = 2
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(lx, 0)
      ctx.lineTo(lx, h)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = C.purple
      ctx.beginPath()
      ctx.moveTo(lx, 0)
      ctx.lineTo(lx + 6, 0)
      ctx.lineTo(lx, 8)
      ctx.closePath()
      ctx.fill()
    }
  }
}

function drawWaveformArea(snap: RenderSnapshot) {
  if (!ctx) return
  const w = W
  const y0 = TIMELINE_H
  const areaH = H - TIMELINE_H
  const scrollOff = snap.scrollOffset

  ctx.fillStyle = C.bg
  ctx.fillRect(0, y0, w, areaH)

  if (snap.trackCount === 0) return

  const samplesPerCol = getSamplesPerCol()
  const samplesPerBeat = Math.round((60 / snap.originalBpm) * SAMPLE_RATE)
  const gridH = areaH

  // Beat grid
  const startBeat = Math.floor(scrollOff / samplesPerBeat)
  const endSample = scrollOff + w * samplesPerCol
  const endBeat = Math.ceil(endSample / samplesPerBeat)

  for (let beat = startBeat; beat <= endBeat; beat++) {
    const samplePos = beat * samplesPerBeat
    const x = (samplePos - scrollOff) / samplesPerCol
    if (x < 0 || x >= w) continue

    const isBar = beat % 4 === 0
    ctx.strokeStyle = isBar ? C.border : `${C.border}80`
    ctx.lineWidth = isBar ? 1 : 0.5
    ctx.beginPath()
    ctx.moveTo(x, y0)
    ctx.lineTo(x, y0 + gridH)
    ctx.stroke()
  }

  // Loop region in waveform area
  if (snap.loopStart !== null && snap.loopEnd !== null) {
    const lx1 = (snap.loopStart - scrollOff) / samplesPerCol
    const lx2 = (snap.loopEnd - scrollOff) / samplesPerCol
    ctx.fillStyle = 'rgba(176, 128, 224, 0.08)'
    const clampX1 = Math.max(0, lx1)
    const clampX2 = Math.min(w, lx2)
    if (clampX2 > clampX1) ctx.fillRect(clampX1, y0, clampX2 - clampX1, gridH)

    if (lx1 >= 0 && lx1 <= w) {
      ctx.strokeStyle = C.purple
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(lx1, y0)
      ctx.lineTo(lx1, y0 + gridH)
      ctx.stroke()
    }
    if (lx2 >= 0 && lx2 <= w) {
      ctx.strokeStyle = C.purple
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(lx2, y0)
      ctx.lineTo(lx2, y0 + gridH)
      ctx.stroke()
    }
  }

  // Loop start indicator (dashed)
  if (snap.loopStart !== null && snap.loopEnd === null) {
    const lx = (snap.loopStart - scrollOff) / samplesPerCol
    if (lx >= 0 && lx <= w) {
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
  ctx.rect(0, y0, w, areaH)
  ctx.clip()

  const scrollY = snap.trackScrollY
  const selectedIdx = snap.selectedTrackIndex
  const isStopped = snap.transportState === 'stopped'

  for (let i = 0; i < snap.trackCount; i++) {
    const track = state.tracks[i]
    const ty = y0 + i * TRACK_H - scrollY
    const waveH = TRACK_H - 4

    // Skip tracks fully outside the visible area
    if (ty + TRACK_H < y0 || ty > y0 + areaH) continue

    // Track separator
    if (i > 0) {
      ctx.strokeStyle = C.border
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, ty)
      ctx.lineTo(w, ty)
      ctx.stroke()
    }

    // Waveform
    const samples = track.samples
    if (samples && samples.length > 0) {
      const color = track.muted ? C.fgDim : track.color
      const volume = track.volume
      ctx.fillStyle = color
      ctx.globalAlpha = track.muted ? 0.3 : 0.7

      const centerY = ty + 2 + waveH / 2

      for (let col = 0; col < w; col++) {
        const startSample = Math.floor(scrollOff + col * samplesPerCol)
        if (startSample >= samples.length) break
        const endSampleIdx = Math.floor(scrollOff + (col + 1) * samplesPerCol)
        if (endSampleIdx < 0) continue

        let peak = 0
        const s = Math.max(0, startSample)
        const e = Math.min(samples.length, endSampleIdx)
        for (let j = s; j < e; j++) {
          const v = Math.abs(samples[j])
          if (v > peak) peak = v
        }

        const barH = peak * waveH * volume
        ctx.fillRect(col, centerY - barH / 2, 1, Math.max(1, barH))
      }

      ctx.globalAlpha = 1
    } else {
      ctx.fillStyle = C.fgDim
      ctx.font = "11px 'IBM Plex Mono', monospace"
      ctx.fillText('(empty)', 8, ty + TRACK_H / 2 + 4)
    }

    // Selected track highlight
    if (i === selectedIdx) {
      ctx.strokeStyle = track.color
      ctx.lineWidth = 2
      ctx.strokeRect(0, ty + 1, w - 1, TRACK_H - 2)

      // Nudge buttons (< >) on right side of selected track
      if (samples && samples.length > 0 && isStopped) {
        const btnY = ty + Math.round(TRACK_H / 2 - NUDGE_BTN_H / 2)
        const rightEdge = w - NUDGE_BTN_PAD
        const rightBtnX = rightEdge - NUDGE_BTN_W
        const leftBtnX = rightBtnX - NUDGE_BTN_GAP - NUDGE_BTN_W

        // Left nudge button
        ctx.fillStyle = C.bgHighlight
        ctx.fillRect(leftBtnX, btnY, NUDGE_BTN_W, NUDGE_BTN_H)
        ctx.strokeStyle = C.fgDim
        ctx.lineWidth = 1
        ctx.strokeRect(leftBtnX, btnY, NUDGE_BTN_W, NUDGE_BTN_H)
        ctx.fillStyle = C.fg
        ctx.font = "bold 16px 'IBM Plex Mono', monospace"
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(
          '\u25C0',
          leftBtnX + NUDGE_BTN_W / 2,
          btnY + NUDGE_BTN_H / 2
        )

        // Right nudge button
        ctx.fillStyle = C.bgHighlight
        ctx.fillRect(rightBtnX, btnY, NUDGE_BTN_W, NUDGE_BTN_H)
        ctx.strokeStyle = C.fgDim
        ctx.lineWidth = 1
        ctx.strokeRect(rightBtnX, btnY, NUDGE_BTN_W, NUDGE_BTN_H)
        ctx.fillStyle = C.fg
        ctx.fillText(
          '\u25B6',
          rightBtnX + NUDGE_BTN_W / 2,
          btnY + NUDGE_BTN_H / 2
        )

        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
      }
    }
  }

  ctx.restore()

  // Playhead
  const playheadX = (snap.playheadPosition - scrollOff) / samplesPerCol
  if (playheadX >= 0 && playheadX <= w) {
    ctx.strokeStyle = C.green
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(playheadX, y0)
    ctx.lineTo(playheadX, y0 + gridH)
    ctx.stroke()
  }
}

// ── Hit testing (canvas-only zones) ─────────────────────────────────────
type Zone = 'timeline' | 'waveform' | 'waveform-nudge' | 'none'

interface HitResult {
  zone: Zone
  trackIndex: number
  localX: number
  localY: number
  btnAction?: 'nudge-left' | 'nudge-right'
}

function hitTest(cx: number, cy: number): HitResult {
  const result: HitResult = {
    zone: 'none',
    trackIndex: -1,
    localX: cx,
    localY: cy
  }

  // Timeline
  if (cy < TIMELINE_H) {
    result.zone = 'timeline'
    result.localX = cx
    return result
  }

  // Waveform area (apply vertical scroll offset)
  result.localX = cx
  result.localY = cy - TIMELINE_H + state.trackScrollY
  result.trackIndex = Math.floor(result.localY / TRACK_H)
  if (result.trackIndex < 0 || result.trackIndex >= state.tracks.length)
    result.trackIndex = -1

  // Nudge buttons on the selected track (only when stopped and track has audio)
  if (
    result.trackIndex >= 0 &&
    result.trackIndex === state.selectedTrackIndex &&
    state.transportState === 'stopped'
  ) {
    const track = state.tracks[result.trackIndex]
    if (track && track.samples && track.samples.length > 0) {
      const trackLocalY = result.localY - result.trackIndex * TRACK_H
      const btnY = Math.round(TRACK_H / 2 - NUDGE_BTN_H / 2)
      if (trackLocalY >= btnY && trackLocalY < btnY + NUDGE_BTN_H) {
        const rightEdge = W - NUDGE_BTN_PAD
        const rightBtnX = rightEdge - NUDGE_BTN_W
        const leftBtnX = rightBtnX - NUDGE_BTN_GAP - NUDGE_BTN_W
        const lx = result.localX
        if (lx >= leftBtnX && lx < leftBtnX + NUDGE_BTN_W) {
          result.zone = 'waveform-nudge'
          result.btnAction = 'nudge-left'
          return result
        }
        if (lx >= rightBtnX && lx < rightBtnX + NUDGE_BTN_W) {
          result.zone = 'waveform-nudge'
          result.btnAction = 'nudge-right'
          return result
        }
      }
    }
  }

  result.zone = 'waveform'
  return result
}

// ── Canvas-relative coordinates ─────────────────────────────────────────
function canvasCoords(e: { clientX: number; clientY: number }): {
  cx: number
  cy: number
} {
  const canvas = canvasRef.value
  if (!canvas) return { cx: 0, cy: 0 }
  const rect = canvas.getBoundingClientRect()
  return {
    cx: e.clientX - rect.left,
    cy: e.clientY - rect.top
  }
}

// ── Pointer / Mouse handlers ────────────────────────────────────────────
function onPointerDown(e: PointerEvent) {
  const { cx, cy } = canvasCoords(e)
  const hit = hitTest(cx, cy)
  const audio = getAudio()

  switch (hit.zone) {
    case 'timeline': {
      const samplesPerCol = getSamplesPerCol()
      state.playheadPosition = Math.max(
        0,
        Math.floor(state.scrollOffset + hit.localX * samplesPerCol)
      )
      if (state.transportState !== 'stopped') {
        audio.setPlayhead(state.playheadPosition)
        syncLoopAfterSeek()
        state.freeScroll = true
      }
      drag = { type: 'timeline', startValue: state.playheadPosition }
      render()
      break
    }

    case 'waveform-nudge':
      if (hit.btnAction === 'nudge-left') nudgeTrack('left')
      else if (hit.btnAction === 'nudge-right') nudgeTrack('right')
      break

    case 'waveform':
      if (hit.trackIndex >= 0) {
        state.selectedTrackIndex = hit.trackIndex
      }
      drag = { type: 'waveform-scroll', startValue: cx }
      render()
      break
  }
}

function onPointerMove(e: PointerEvent) {
  const { cx, cy } = canvasCoords(e)
  const canvas = canvasRef.value
  const audio = getAudio()

  if (!drag) {
    // Cursor style
    if (canvas) {
      const hit = hitTest(cx, cy)
      canvas.style.cursor =
        hit.zone === 'timeline' || hit.zone === 'waveform-nudge'
          ? 'pointer'
          : 'default'
    }
    return
  }

  if (drag.type === 'timeline') {
    const samplesPerCol = getSamplesPerCol()
    state.playheadPosition = Math.max(
      0,
      Math.floor(state.scrollOffset + cx * samplesPerCol)
    )
    if (state.transportState !== 'stopped') {
      audio.setPlayhead(state.playheadPosition)
      syncLoopAfterSeek()
    }
    render()
  } else if (drag.type === 'waveform-scroll') {
    const dx = drag.startValue - cx
    const samplesPerCol = getSamplesPerCol()
    const deltaSamples = dx * samplesPerCol
    state.scrollOffset = Math.max(0, state.scrollOffset + deltaSamples)
    if (state.transportState !== 'stopped') state.freeScroll = true
    drag.startValue = cx
    render()
  }
}

function onPointerUp() {
  drag = null
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const samplesPerBeat = Math.round((60 / state.originalBpm) * SAMPLE_RATE)
  const direction = e.deltaY > 0 ? 1 : -1
  state.scrollOffset = Math.max(
    0,
    state.scrollOffset + direction * samplesPerBeat
  )
  if (state.transportState !== 'stopped') state.freeScroll = true
  render()
}

function onTouchStart(e: TouchEvent) {
  e.preventDefault()
}

function onTouchMove(e: TouchEvent) {
  e.preventDefault()
}

// ── Lifecycle ───────────────────────────────────────────────────────────
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  resize()

  // Register render callback for transport animation loop
  setRenderCallback(render)

  // Use ResizeObserver to track container size changes
  const canvas = canvasRef.value
  if (canvas) {
    resizeObserver = new ResizeObserver(() => resize())
    resizeObserver.observe(canvas)
  }

  // Also handle DPR changes and viewport resize
  window.addEventListener('resize', resize)
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resize)
  }
})

onUnmounted(() => {
  setRenderCallback(() => {})

  // Cancel any pending coalesced render
  if (renderRafId !== null) {
    cancelAnimationFrame(renderRafId)
    renderRafId = null
  }

  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }

  window.removeEventListener('resize', resize)
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', resize)
  }
})

// Watch for reactive state changes that should trigger a re-render
// (only needed for changes from outside the canvas, e.g. sidebar interactions)
watch(
  () => [
    state.selectedTrackIndex,
    state.tracks.length,
    state.clickEnabled,
    state.loopStart,
    state.loopEnd,
    state.bpm,
    state.originalBpm,
    state.trackScrollY,
    state.playheadPosition,
    state.scrollOffset
  ],
  () => scheduleRender()
)
</script>

<template>
  <canvas
    ref="canvasRef"
    class="block min-h-0 min-w-0 flex-1"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointerleave="onPointerUp"
    @wheel.prevent="onWheel"
    @touchstart.prevent="onTouchStart"
    @touchmove.prevent="onTouchMove"
  />
</template>
