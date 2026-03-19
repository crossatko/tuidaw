// ============================================================================
// tuidaw - UI Renderer (OpenTUI)
// ============================================================================

import {
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  FrameBufferRenderable,
  RGBA,
  TextAttributes,
  type MouseEvent,
} from "@opentui/core"
import type { ProjectState, Track, AudioDevice } from "./types"
import { SIDEBAR_WIDTH, TOPBAR_HEIGHT, TRACK_ROW_HEIGHT, CLICK_ROW_HEIGHT, SEPARATOR_HEIGHT, CLICK_TRACK_INDEX } from "./types"
import { renderBrailleWaveform, getPeakLevel, renderLevelMeter } from "./braille"
import {
  formatTime,
  formatBeatPosition,
  getProjectDurationSamples,
  getSelectedTrack,
} from "./state"

// Color constants
const BG = RGBA.fromHex("#1a1b26")
const BG_DARKER = RGBA.fromHex("#13141c")
const BG_SIDEBAR = RGBA.fromHex("#1f2335")
const BG_TOPBAR = RGBA.fromHex("#24283b")
const BG_SELECTED = RGBA.fromHex("#292e42")
const BG_ARMED = RGBA.fromHex("#3b2020")
const FG_PRIMARY = RGBA.fromHex("#c0caf5")
const FG_DIM = RGBA.fromHex("#565f89")
const FG_ACCENT = RGBA.fromHex("#7aa2f7")
const FG_GREEN = RGBA.fromHex("#9ece6a")
const FG_RED = RGBA.fromHex("#f7768e")
const FG_YELLOW = RGBA.fromHex("#e0af68")
const FG_ORANGE = RGBA.fromHex("#ff9e64")
const PLAYHEAD_COLOR = RGBA.fromHex("#ff9e64")
const LOOP_COLOR = RGBA.fromHex("#bb9af7") // purple for loop region
const CLICK_COLOR = RGBA.fromHex("#e0af68") // yellow for click track
const GRID_COLOR = RGBA.fromHex("#292e42")
const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)

export class UIRenderer {
  private renderer: CliRenderer
  private rootContainer!: BoxRenderable
  private topBar!: BoxRenderable
  private topBarFB!: FrameBufferRenderable
  private sidebar!: BoxRenderable
  private sidebarFB!: FrameBufferRenderable
  private mainArea!: BoxRenderable
  private mainFB!: FrameBufferRenderable
  private statusBar!: BoxRenderable
  private statusBarFB!: FrameBufferRenderable
  private currentState: ProjectState | null = null  // updated on each render for mouse handlers
  private helpOverlayVisible = false
  private deviceSelectorVisible = false
  private deviceSelectorMode: "input" | "output" = "input"
  private deviceSelectorIndex = 0
  private deviceSelectorDevices: AudioDevice[] = []
  private deviceSelectorCallback: ((device: AudioDevice | null) => void) | null = null
  private filePickerVisible = false
  private filePickerFiles: string[] = []
  private filePickerIndex = 0
  private filePickerCallback: ((file: string | null) => void) | null = null
  private statusMessage: string | null = null
  private statusMessageTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(renderer: CliRenderer) {
    this.renderer = renderer
  }

  setup(): void {
    const w = this.renderer.width
    const h = this.renderer.height

    // Root container - fills terminal
    this.rootContainer = new BoxRenderable(this.renderer, {
      id: "root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: "#1a1b26",
    })

    // Top bar
    this.topBar = new BoxRenderable(this.renderer, {
      id: "topbar",
      width: "100%",
      height: TOPBAR_HEIGHT,
    })

    this.topBarFB = new FrameBufferRenderable(this.renderer, {
      id: "topbar-fb",
      width: w,
      height: TOPBAR_HEIGHT,
    })
    this.topBar.add(this.topBarFB)

    // Middle section (sidebar + main)
    const middleContainer = new BoxRenderable(this.renderer, {
      id: "middle",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
    })

    // Sidebar
    this.sidebar = new BoxRenderable(this.renderer, {
      id: "sidebar",
      width: SIDEBAR_WIDTH,
      height: "100%",
    })

    this.sidebarFB = new FrameBufferRenderable(this.renderer, {
      id: "sidebar-fb",
      width: SIDEBAR_WIDTH,
      height: Math.max(1, h - TOPBAR_HEIGHT - 1),
    })
    this.sidebar.add(this.sidebarFB)

    // Main waveform area
    this.mainArea = new BoxRenderable(this.renderer, {
      id: "main",
      flexGrow: 1,
      height: "100%",
    })

    this.mainFB = new FrameBufferRenderable(this.renderer, {
      id: "main-fb",
      width: Math.max(1, w - SIDEBAR_WIDTH),
      height: Math.max(1, h - TOPBAR_HEIGHT - 1),
    })
    this.mainArea.add(this.mainFB)

    middleContainer.add(this.sidebar)
    middleContainer.add(this.mainArea)

    // Status bar (bottom)
    this.statusBar = new BoxRenderable(this.renderer, {
      id: "statusbar",
      width: "100%",
      height: 1,
    })

    this.statusBarFB = new FrameBufferRenderable(this.renderer, {
      id: "statusbar-fb",
      width: w,
      height: 1,
    })
    this.statusBar.add(this.statusBarFB)

    this.rootContainer.add(this.topBar)
    this.rootContainer.add(middleContainer)
    this.rootContainer.add(this.statusBar)

    this.renderer.root.add(this.rootContainer)
  }

  // =========================================================================
  // MOUSE HANDLERS - Scroll, volume, pan via mouse wheel
  // =========================================================================

  setupMouseHandlers(callbacks: {
    onScrollChange: (deltaSamples: number) => void
    onVolumeChange: (delta: number) => void
    onPanChange: (delta: number) => void
    onTrackClick: (trackIndex: number) => void
    onTimelineClick: (x: number, mainWidth: number) => void
    onClickVolumeChange: (delta: number) => void
    onClickPanChange: (delta: number) => void
  }): void {
    // Debounce scroll events — Ghostty fires ~3 events per physical wheel tick.
    // Accept only the first event in a 10ms window.
    let lastScrollTime = 0
    const scrollDebounce = (): boolean => {
      const now = performance.now()
      if (now - lastScrollTime < 10) return false
      lastScrollTime = now
      return true
    }

    // Main area: mouse wheel scrolls the timeline horizontally
    this.mainFB.onMouseScroll = (event: MouseEvent) => {
      if (!event.scroll) return
      if (!scrollDebounce()) return
      const dir = event.scroll.direction
      // Scroll up/down → scroll timeline left/right (natural mapping for horizontal timeline)
      if (dir === "up" || dir === "left") {
        callbacks.onScrollChange(-1)
      } else if (dir === "down" || dir === "right") {
        callbacks.onScrollChange(1)
      }
    }

    // Sidebar: mouse wheel adjusts volume or pan on the SELECTED track
    // Click track row is always at the top (CLICK_ROW_HEIGHT rows)
    // Pan zone: row 2 (within track), x >= 9 (where "Pan:" label starts)
    // Volume zone: everything else in sidebar
    this.sidebarFB.onMouseScroll = (event: MouseEvent) => {
      if (!event.scroll) return
      if (!scrollDebounce()) return
      const dir = event.scroll.direction
      const delta = (dir === "up" || dir === "left") ? 1 : -1

      // localY within the sidebar content area (below header)
      const localY = event.y - TOPBAR_HEIGHT
      if (localY < 0) return

      // Subtract header row
      const contentY = localY - 1
      if (contentY < 0) return

      // Click track content occupies rows [0, CLICK_ROW_HEIGHT), then SEPARATOR_HEIGHT separator rows
      if (contentY < CLICK_ROW_HEIGHT) {
        // On click track row — pan zone: x >= 9 (where Pan: label is drawn)
        if (event.x >= 9) {
           callbacks.onClickPanChange(delta * 0.05)
        } else {
           callbacks.onClickVolumeChange(delta * 0.05)
        }
        return
      }

      // Regular track area starts after click content + separator
      const trackAreaStart = CLICK_ROW_HEIGHT + SEPARATOR_HEIGHT
      const trackContentY = contentY - trackAreaStart
      if (trackContentY < 0) return // on separator row
      const trackStride = TRACK_ROW_HEIGHT + SEPARATOR_HEIGHT
      const rowInTrack = trackContentY % trackStride

      // Skip separator rows between tracks
      if (rowInTrack >= TRACK_ROW_HEIGHT) return

      // Pan control: row 2, x >= 9 (where pan indicator is drawn)
      if (rowInTrack === 2 && event.x >= 9) {
        callbacks.onPanChange(delta * 0.05)
        return
      }

      // Volume control: everything else within the sidebar
      callbacks.onVolumeChange(delta * 0.05)
    }

    // Sidebar: click to select track
    this.sidebarFB.onMouse = (event: MouseEvent) => {
      if (event.type !== "down") return
      const localY = event.y - TOPBAR_HEIGHT
      if (localY < 0) return

      // Subtract header row
      const contentY = localY - 1
      if (contentY < 0) return

      // Click track content occupies rows [0, CLICK_ROW_HEIGHT)
      if (contentY < CLICK_ROW_HEIGHT) {
        // Click on click track row — select click track (sentinel -1)
        callbacks.onTrackClick(CLICK_TRACK_INDEX)
        return
      }

      // Regular tracks start after click content + separator
      const trackAreaStart = CLICK_ROW_HEIGHT + SEPARATOR_HEIGHT
      const trackContentY = contentY - trackAreaStart
      if (trackContentY < 0) return // on separator row
      const trackStride = TRACK_ROW_HEIGHT + SEPARATOR_HEIGHT
      const trackIndex = Math.floor(trackContentY / trackStride)
      const rowInTrack = trackContentY % trackStride
      // Don't select if clicking on separator row
      if (rowInTrack >= TRACK_ROW_HEIGHT) return
      callbacks.onTrackClick(trackIndex)
    }

    // Main area: click to set playhead (timeline row 0) or select track (waveform rows)
    // Drag on timeline continuously updates playhead position
    let draggingTimeline = false
    this.mainFB.onMouse = (event: MouseEvent) => {
      // event.x/y are screen-absolute; main area starts at (SIDEBAR_WIDTH, TOPBAR_HEIGHT)
      const localX = event.x - SIDEBAR_WIDTH
      const localY = event.y - TOPBAR_HEIGHT

      if (event.type === "down") {
        if (localX < 0 || localY < 0) return
        if (localY === 0) {
          // Timeline row — set playhead position and start drag tracking
          draggingTimeline = true
          callbacks.onTimelineClick(localX, this.mainFB.width)
        } else {
          // Waveform area — select track
          draggingTimeline = false
          // Click track content occupies rows [1, 1 + CLICK_ROW_HEIGHT)
          const waveformY = localY - 1  // subtract timeline row
          if (waveformY < CLICK_ROW_HEIGHT) {
            // Click on click waveform row — select click track
            callbacks.onTrackClick(CLICK_TRACK_INDEX)
            return
          }
          // Regular tracks start after click content + separator
          const trackAreaStart = CLICK_ROW_HEIGHT + SEPARATOR_HEIGHT
          const trackContentY = waveformY - trackAreaStart
          if (trackContentY < 0) return // on separator row
          const trackStride = TRACK_ROW_HEIGHT + SEPARATOR_HEIGHT
          const trackIndex = Math.floor(trackContentY / trackStride)
          const rowInTrack = trackContentY % trackStride
          // Don't select if clicking on separator row
          if (rowInTrack >= TRACK_ROW_HEIGHT) return
          callbacks.onTrackClick(trackIndex)
        }
      } else if (event.type === "drag" && draggingTimeline) {
        // Continue moving playhead while dragging (even if cursor leaves timeline row)
        const clampedX = Math.max(0, Math.min(localX, this.mainFB.width - 1))
        callbacks.onTimelineClick(clampedX, this.mainFB.width)
      } else if (event.type === "up" || event.type === "drag-end") {
        draggingTimeline = false
      }
    }
  }

  resize(): void {
    const w = this.renderer.width
    const h = this.renderer.height

    this.topBarFB.width = w
    this.topBarFB.height = TOPBAR_HEIGHT

    const mainH = Math.max(1, h - TOPBAR_HEIGHT - 1)
    this.sidebarFB.width = SIDEBAR_WIDTH
    this.sidebarFB.height = mainH

    this.mainFB.width = Math.max(1, w - SIDEBAR_WIDTH)
    this.mainFB.height = mainH

    this.statusBarFB.width = w
    this.statusBarFB.height = 1
  }

  render(state: ProjectState): void {
    this.currentState = state
    this.renderTopBar(state)
    this.renderSidebar(state)
    this.renderMainArea(state)
    this.renderStatusBar(state)

    // Overlays (rendered on top of main area)
    if (this.deviceSelectorVisible) {
      this.renderDeviceSelectorOverlay()
    }
    if (this.filePickerVisible) {
      this.renderFilePickerOverlay()
    }
  }

  // =========================================================================
  // TOP BAR - Transport controls, BPM, time display
  // =========================================================================
  private renderTopBar(state: ProjectState): void {
    const fb = this.topBarFB.frameBuffer
    const w = this.topBarFB.width
    const h = TOPBAR_HEIGHT

    fb.fillRect(0, 0, w, h, BG_TOPBAR)

    // Draw top border
    for (let x = 0; x < w; x++) {
      fb.setCell(x, 0, "─", FG_DIM, BG_TOPBAR)
    }

    // Project name
    fb.drawText(` ${state.projectName}`, 0, 0, FG_ACCENT, BG_TOPBAR, TextAttributes.BOLD)

    // Transport state indicator
    let transportIcon: string
    let transportColor: RGBA
    switch (state.transportState) {
      case "stopped":
        transportIcon = "■ STOP"
        transportColor = FG_DIM
        break
      case "playing":
        transportIcon = "▶ PLAY"
        transportColor = FG_GREEN
        break
      case "recording":
        transportIcon = "● REC "
        transportColor = FG_RED
        break
    }
    fb.drawText(` ${transportIcon} `, 1, 1, transportColor, BG_TOPBAR, TextAttributes.BOLD)

    // Time display
    const timeStr = formatTime(state.playheadPosition, state.sampleRate)
    fb.drawText(timeStr, 10, 1, FG_PRIMARY, BG_TOPBAR)

    // Beat position (content-space beats use originalBpm)
    const beatStr = formatBeatPosition(state.playheadPosition, state.sampleRate, state.originalBpm)
    fb.drawText(` [${beatStr}]`, 10 + timeStr.length, 1, FG_DIM, BG_TOPBAR)

    // BPM
    const bpmX = 30
    fb.drawText("BPM:", bpmX, 1, FG_DIM, BG_TOPBAR)
    fb.drawText(` ${state.bpm} `, bpmX + 4, 1, FG_YELLOW, BG_TOPBAR, TextAttributes.BOLD)

    // Speed indicator (show when speed != 1.0x) or BPM lock indicator
    const speed = state.bpm / state.originalBpm
    const speedX = bpmX + 4 + ` ${state.bpm} `.length
    if (state.bpmLocked) {
      fb.drawText(" LOCK ", speedX, 1, RGBA.fromHex("#1a1b26"), RGBA.fromHex("#E5C07B"))
    } else if (speed < 0.99 || speed > 1.01) {
      const pct = Math.round(speed * 100)
      fb.drawText(` ${pct}% `, speedX, 1, RGBA.fromHex("#1a1b26"), RGBA.fromHex("#BB8FCE"))
    }

    // Click indicator
    const clickX = bpmX + 10
    if (state.clickEnabled) {
      fb.drawText(" CLICK ", clickX, 1, RGBA.fromHex("#1a1b26"), FG_YELLOW)
    } else {
      fb.drawText(" click ", clickX, 1, FG_DIM, BG_TOPBAR)
    }

    // Loop indicator
    const loopX = clickX + 8
    if (state.loopStart !== null && state.loopEnd !== null) {
      fb.drawText(" LOOP ", loopX, 1, RGBA.fromHex("#1a1b26"), LOOP_COLOR)
    } else if (state.loopStart !== null) {
      fb.drawText(" loop… ", loopX, 1, LOOP_COLOR, BG_TOPBAR)
    } else {
      fb.drawText("       ", loopX, 1, FG_DIM, BG_TOPBAR)
    }

    // Output device indicator
    const outX = loopX + 8
    if (state.outputDeviceId != null) {
      const dev = state.availableOutputDevices.find((d) => d.id === state.outputDeviceId)
      const outLabel = dev ? dev.description : `ID:${state.outputDeviceId}`
      const truncOut = outLabel.length > 20 ? outLabel.substring(0, 17) + "..." : outLabel
      fb.drawText(`Out:${truncOut}`, outX, 1, FG_DIM, BG_TOPBAR)
    } else {
      fb.drawText("Out:Default", outX, 1, FG_DIM, BG_TOPBAR)
    }

    // Track count
    const trackInfo = `Tracks: ${state.tracks.length}`
    fb.drawText(trackInfo, w - trackInfo.length - 2, 1, FG_DIM, BG_TOPBAR)

    // Bottom border
    for (let x = 0; x < w; x++) {
      fb.setCell(x, h - 1, "─", FG_DIM, BG_TOPBAR)
    }

    // Help hint
    fb.drawText("F1:Help", w - 8, 0, FG_DIM, BG_TOPBAR)
  }

  // =========================================================================
  // SIDEBAR - Track list with mute/solo/arm controls
  // =========================================================================
  private renderSidebar(state: ProjectState): void {
    const fb = this.sidebarFB.frameBuffer
    const w = SIDEBAR_WIDTH
    const h = this.sidebarFB.height

    fb.fillRect(0, 0, w, h, BG_SIDEBAR)

    // Header
    fb.drawText("  TRACKS", 0, 0, FG_ACCENT, BG_SIDEBAR, TextAttributes.BOLD)

    // Right border
    for (let y = 0; y < h; y++) {
      fb.setCell(w - 1, y, "│", FG_DIM, BG_SIDEBAR)
    }

    // Click track row — always shown (CLICK_ROW_HEIGHT=1 content row + SEPARATOR_HEIGHT separator)
    // Single row: ♩ V:xx% Pan:C
    let y = 1
    {
      const isSelected = state.selectedTrackIndex === CLICK_TRACK_INDEX
      const isEnabled = state.clickEnabled
      const bg = isSelected ? BG_SELECTED : BG_SIDEBAR
      const iconColor = isEnabled ? CLICK_COLOR : FG_DIM

      // Background
      fb.fillRect(0, y, w - 1, CLICK_ROW_HEIGHT, bg)

      // Selection indicator
      if (isSelected) {
        fb.setCell(0, y, "▌", CLICK_COLOR, bg)
      }

      // Row 0: ♩ icon + volume + pan
      fb.setCell(1, y, "♩", iconColor, bg)

      const volPct = Math.round(state.clickVolume * 100)
      const volStr = `V:${volPct}%`
      fb.drawText(volStr, 3, y, isEnabled ? CLICK_COLOR : FG_DIM, bg)

      let panStr: string
      if (state.clickPan === 0) {
        panStr = "C"
      } else if (state.clickPan < 0) {
        panStr = `L${Math.round(Math.abs(state.clickPan) * 100)}`
      } else {
        panStr = `R${Math.round(state.clickPan * 100)}`
      }
      fb.drawText(`Pan:${panStr}`, 9, y, isEnabled ? CLICK_COLOR : FG_DIM, bg)

      // Separator rows drawn AFTER content
      for (let sepRow = 0; sepRow < SEPARATOR_HEIGHT; sepRow++) {
        for (let x = 0; x < w - 1; x++) {
          fb.setCell(x, y + CLICK_ROW_HEIGHT + sepRow, "─", RGBA.fromHex("#292e42"), BG_SIDEBAR)
        }
      }

      y += CLICK_ROW_HEIGHT + SEPARATOR_HEIGHT
    }

    // Track list
    for (let i = 0; i < state.tracks.length; i++) {
      if (y + TRACK_ROW_HEIGHT > h) break
      const track = state.tracks[i]
      const isSelected = i === state.selectedTrackIndex
      const trackColor = RGBA.fromHex(track.color)

      // Background
      const bg = track.armed ? BG_ARMED : isSelected ? BG_SELECTED : BG_SIDEBAR

      // Track row background (all content rows)
      for (let row = 0; row < TRACK_ROW_HEIGHT; row++) {
        fb.fillRect(0, y + row, w - 1, 1, bg)
      }

      // Selection indicator across all content rows
      if (isSelected) {
        for (let row = 0; row < TRACK_ROW_HEIGHT; row++) {
          fb.setCell(0, y + row, "▌", trackColor, bg)
        }
      }

      // Row 0: Color dot and name
      fb.setCell(1, y, "●", trackColor, bg)
      const name = track.name.length > w - 5 ? track.name.substring(0, w - 5) : track.name
      fb.drawText(` ${name}`, 2, y, FG_PRIMARY, bg)

      // Input device icon on name row (right side) if set
      if (track.inputDeviceId != null) {
        const dev = state.availableInputDevices.find((d) => d.id === track.inputDeviceId)
        const shortName = dev ? (dev.description.length > 6 ? dev.description.substring(0, 6) : dev.description) : "?"
        const label = `[${shortName}]`
        const labelX = w - 2 - label.length
        if (labelX > 2 + name.length + 1) {
          fb.drawText(label, labelX, y, FG_DIM, bg)
        }
      }

      // Row 1: Mute / Solo / Arm buttons
      const muteColor = track.muted ? FG_RED : FG_DIM
      const soloColor = track.solo ? FG_YELLOW : FG_DIM
      const armColor = track.armed ? FG_RED : FG_DIM

      fb.drawText(" M", 1, y + 1, muteColor, bg, track.muted ? TextAttributes.BOLD : 0)
      fb.drawText(" S", 4, y + 1, soloColor, bg, track.solo ? TextAttributes.BOLD : 0)
      fb.drawText(" R", 7, y + 1, armColor, bg, track.armed ? TextAttributes.BOLD : 0)

      // Row 2: Volume + Pan
      const volStr = `V:${Math.round(track.volume * 100)}%`
      fb.drawText(volStr, 1, y + 2, FG_DIM, bg)

      let panStr: string
      if (track.pan === 0) {
        panStr = "C"
      } else if (track.pan < 0) {
        panStr = `L${Math.round(Math.abs(track.pan) * 100)}`
      } else {
        panStr = `R${Math.round(track.pan * 100)}`
      }
      fb.drawText(`Pan:${panStr}`, 9, y + 2, FG_DIM, bg)

      // Row 3: Level meter (if track has audio) or input device indicator
      if (track.inputDeviceId != null && !(track.samples && track.samples.length > 0)) {
        // Show input device when track is empty
        const dev = state.availableInputDevices.find((d) => d.id === track.inputDeviceId)
        const devLabel = dev ? dev.description : `ID:${track.inputDeviceId}`
        const truncated = devLabel.length > w - 4 ? devLabel.substring(0, w - 7) + "..." : devLabel
        fb.drawText(truncated, 1, y + 3, FG_DIM, bg)
      } else if (track.samples && track.samples.length > 0) {
        const level = getPeakLevel(
          track.samples,
          state.playheadPosition,
          Math.floor(state.sampleRate * 0.05),
        )
        const meterStr = renderLevelMeter(level, w - 3)
        fb.drawText(meterStr, 1, y + 3, trackColor, bg)
      } else {
        fb.drawText("(empty)", 1, y + 3, FG_DIM, bg)
      }

      // Separator rows drawn AFTER content
      if (y + TRACK_ROW_HEIGHT < h) {
        for (let sepRow = 0; sepRow < SEPARATOR_HEIGHT; sepRow++) {
          if (y + TRACK_ROW_HEIGHT + sepRow < h) {
            for (let x = 0; x < w - 1; x++) {
              fb.setCell(x, y + TRACK_ROW_HEIGHT + sepRow, "─", RGBA.fromHex("#292e42"), BG_SIDEBAR)
            }
          }
        }
      }

      y += TRACK_ROW_HEIGHT + SEPARATOR_HEIGHT
    }

    // "Add Track" hint
    if (y + 1 < h) {
      fb.drawText(" + Add Track (A)", 0, y, FG_DIM, BG_SIDEBAR)
    }
  }

  // =========================================================================
  // MAIN AREA - Waveforms with braille rendering + playhead
  // =========================================================================
  private renderMainArea(state: ProjectState): void {
    const fb = this.mainFB.frameBuffer
    const w = this.mainFB.width
    const h = this.mainFB.height

    fb.fillRect(0, 0, w, h, BG)

    // Calculate zoom: how many samples per braille sub-column
    // Each character is 2 sub-columns wide
    // Default: fit ~10 seconds into the view
    // All coordinates (playhead, scrollOffset, loopStart/End) are in
    // content-space (source sample positions), so no speed scaling needed.
    const baseSamplesPerSubCol = Math.max(1, Math.floor(state.sampleRate / (w * 2) * 10))
    const samplesPerSubCol = baseSamplesPerSubCol

    // Timeline header (1 row)
    this.renderTimeline(fb, w, state, samplesPerSubCol)

    // Click track waveform row — always shown above regular tracks (CLICK_ROW_HEIGHT content rows + SEPARATOR_HEIGHT separator)
    // Uses bright CLICK_COLOR when enabled, FG_DIM when disabled.
    // Shows | characters at beat positions (not braille) for a grid-like look.
    let y = 1
    {
      const isEnabled = state.clickEnabled
      const clickH = Math.min(CLICK_ROW_HEIGHT, h - y)
      if (clickH > 0) {
        const isSelected = state.selectedTrackIndex === CLICK_TRACK_INDEX
        const rowBg = isSelected ? BG_SELECTED : BG
        fb.fillRect(0, y, w, clickH, rowBg)

        // Generate beat tick marks using ┊ characters across all content rows
        // Uses originalBpm because coordinates are in content-space
        // Must use the same beat detection logic as renderTimeline for alignment
        const samplesPerBeat = Math.round((60 / state.originalBpm) * state.sampleRate)
        const samplesPerCol = samplesPerSubCol * 2
        const beatColor = isEnabled ? CLICK_COLOR : FG_DIM

        for (let x = 0; x < w; x++) {
          const samplePos = state.scrollOffset + x * samplesPerCol
          const sampleInBeat = samplePos % samplesPerBeat

          if (sampleInBeat < samplesPerCol) {
            for (let row = 0; row < clickH; row++) {
              fb.setCell(x, y + row, "┊", beatColor, rowBg)
            }
          }
        }

        // Separator rows drawn AFTER content
        for (let sepRow = 0; sepRow < SEPARATOR_HEIGHT; sepRow++) {
          if (y + clickH + sepRow < h) {
            for (let x = 0; x < w; x++) {
              fb.setCell(x, y + clickH + sepRow, "─", GRID_COLOR, BG)
            }
          }
        }

        y += clickH + SEPARATOR_HEIGHT
      }
    }

    // Render each track's waveform
    for (let i = 0; i < state.tracks.length; i++) {
      const trackH = Math.min(TRACK_ROW_HEIGHT, h - y)
      if (trackH <= 0) break

      const track = state.tracks[i]
      const isSelected = i === state.selectedTrackIndex
      const trackColor = RGBA.fromHex(track.color)

      // Track background
      const trackBg = isSelected ? BG_SELECTED : BG
      fb.fillRect(0, y, w, trackH, trackBg)

      // Braille waveform uses all content rows
      const brailleH = trackH

      // Draw waveform using braille if track has samples
      if (track.samples && track.samples.length > 0 && !track.muted) {
        // scrollOffset is already in content-space (source sample positions),
        // so use it directly as the waveform read offset
        const braille = renderBrailleWaveform(
          track.samples,
          w,
          brailleH,
          state.scrollOffset,
          samplesPerSubCol,
        )

        for (let row = 0; row < braille.length && row < brailleH; row++) {
          for (let col = 0; col < braille[row].length && col < w; col++) {
            if (braille[row][col] !== String.fromCodePoint(0x2800)) {
              fb.setCell(col, y + row, braille[row][col], trackColor, trackBg)
            }
          }
        }
      } else if (track.muted && track.samples) {
        // Show dimmed waveform for muted tracks
        const braille = renderBrailleWaveform(
          track.samples,
          w,
          brailleH,
          state.scrollOffset,
          samplesPerSubCol,
        )

        for (let row = 0; row < braille.length && row < brailleH; row++) {
          for (let col = 0; col < braille[row].length && col < w; col++) {
            if (braille[row][col] !== String.fromCodePoint(0x2800)) {
              fb.setCell(col, y + row, braille[row][col], FG_DIM, trackBg)
            }
          }
        }
      }

      // Separator rows drawn AFTER content
      for (let sepRow = 0; sepRow < SEPARATOR_HEIGHT; sepRow++) {
        if (y + trackH + sepRow < h) {
          for (let x = 0; x < w; x++) {
            fb.setCell(x, y + trackH + sepRow, "─", GRID_COLOR, BG)
          }
        }
      }

      y += trackH + SEPARATOR_HEIGHT
    }

    // Draw loop region (before playhead so playhead draws on top)
    this.renderLoopRegion(fb, w, h, state, samplesPerSubCol)

    // Draw playhead
    this.renderPlayhead(fb, w, h, state, samplesPerSubCol)

    // If no tracks have audio, show hint
    if (!state.tracks.some((t) => t.samples && t.samples.length > 0)) {
      const hint = "Press R to arm a track, then SPACE to record"
      const hintX = Math.floor((w - hint.length) / 2)
      const hintY = Math.floor(h / 2)
      if (hintX >= 0 && hintY >= 0 && hintY < h) {
        fb.drawText(hint, hintX, hintY, FG_DIM, BG)
      }
    }
  }

  // =========================================================================
  // TIMELINE - Beat grid at top of main area
  // =========================================================================
  private renderTimeline(
    fb: any,
    width: number,
    state: ProjectState,
    samplesPerSubCol: number,
  ): void {
    fb.fillRect(0, 0, width, 1, BG_DARKER)

    // Beat positions are in content-space, so use originalBpm
    // (the actual tempo of the source audio)
    const samplesPerBeat = Math.round((60 / state.originalBpm) * state.sampleRate)
    const samplesPerBar = samplesPerBeat * 4
    const samplesPerCol = samplesPerSubCol * 2

    // Paint loop region on timeline with purple tint
    if (state.loopStart !== null && state.loopEnd !== null) {
      const loopStartCol = Math.floor((state.loopStart - state.scrollOffset) / samplesPerCol)
      const loopEndCol = Math.floor((state.loopEnd - state.scrollOffset) / samplesPerCol)
      const colStart = Math.max(0, loopStartCol)
      const colEnd = Math.min(width, loopEndCol + 1)
      const loopTimelineBg = RGBA.fromHex("#2d2050")
      if (colStart < colEnd) {
        fb.fillRect(colStart, 0, colEnd - colStart, 1, loopTimelineBg)
      }
    }

    for (let x = 0; x < width; x++) {
      const samplePos = state.scrollOffset + x * samplesPerCol
      const beatNum = Math.floor(samplePos / samplesPerBeat)
      const sampleInBeat = samplePos % samplesPerBeat

      // Determine background for this cell (loop region or normal)
      const inLoop = state.loopStart !== null && state.loopEnd !== null &&
        samplePos >= state.loopStart && samplePos < state.loopEnd
      const cellBg = inLoop ? RGBA.fromHex("#2d2050") : BG_DARKER

      // Mark bar boundaries
      if (beatNum % 4 === 0 && sampleInBeat < samplesPerCol) {
        const barNum = Math.floor(beatNum / 4) + 1
        const label = String(barNum)
        if (x + label.length < width) {
          fb.drawText(label, x, 0, FG_ACCENT, cellBg)
        }
      } else if (sampleInBeat < samplesPerCol) {
        fb.setCell(x, 0, "┊", FG_DIM, cellBg)
      }
    }
  }

  // =========================================================================
  // PLAYHEAD - Vertical line showing current position
  // =========================================================================
  private renderPlayhead(
    fb: any,
    width: number,
    height: number,
    state: ProjectState,
    samplesPerSubCol: number,
  ): void {
    const samplesPerCol = samplesPerSubCol * 2
    const playheadCol = Math.floor(
      (state.playheadPosition - state.scrollOffset) / samplesPerCol,
    )

    if (playheadCol >= 0 && playheadCol < width) {
      for (let y = 0; y < height; y++) {
        fb.setCellWithAlphaBlending(playheadCol, y, "│", PLAYHEAD_COLOR, TRANSPARENT)
      }
      // Playhead triangle at top
      fb.setCell(playheadCol, 0, "▼", PLAYHEAD_COLOR, BG_DARKER)
    }
  }

  // =========================================================================
  // LOOP REGION - Highlighted area between loop start and end markers
  // =========================================================================
  private renderLoopRegion(
    fb: any,
    width: number,
    height: number,
    state: ProjectState,
    samplesPerSubCol: number,
  ): void {
    if (state.loopStart === null) return
    const samplesPerCol = samplesPerSubCol * 2

    // Loop start marker (always visible when loopStart is set)
    const startCol = Math.floor((state.loopStart - state.scrollOffset) / samplesPerCol)
    if (startCol >= 0 && startCol < width) {
      for (let y = 0; y < height; y++) {
        fb.setCellWithAlphaBlending(startCol, y, "┃", LOOP_COLOR, TRANSPARENT)
      }
      fb.setCell(startCol, 0, "▸", LOOP_COLOR, BG_DARKER)
    }

    // If no loop end yet, just show the start marker
    if (state.loopEnd === null) return

    // Loop end marker
    const endCol = Math.floor((state.loopEnd - state.scrollOffset) / samplesPerCol)
    if (endCol >= 0 && endCol < width) {
      for (let y = 0; y < height; y++) {
        fb.setCellWithAlphaBlending(endCol, y, "┃", LOOP_COLOR, TRANSPARENT)
      }
      fb.setCell(endCol, 0, "◂", LOOP_COLOR, BG_DARKER)
    }
  }

  // =========================================================================
  // STATUS BAR - Keyboard shortcuts and status info
  // =========================================================================
  private renderStatusBar(state: ProjectState): void {
    const fb = this.statusBarFB.frameBuffer
    const w = this.statusBarFB.width

    fb.fillRect(0, 0, w, 1, BG_TOPBAR)

    // Show temporary status message if present
    if (this.statusMessage) {
      fb.drawText(` ${this.statusMessage}`, 0, 0, FG_YELLOW, BG_TOPBAR, TextAttributes.BOLD)
      return
    }

    const shortcuts = [
      "SPC:Play/Rec/Stop",
      "R:Arm Track",
      "A:Add Track",
      "M:Mute",
      "S:Solo",
      "[/]:Scrub",
      "{/}:Nudge",
      "</>:Pan",
      "P:Loop",
      "B:BPM Lock",
      "F5:Save",
      "F6:Open",
      "I:Import",
      "E:Export",
      "F2:Input",
      "F3:Output",
      "Q:Quit",
    ]

    let x = 1
    for (const shortcut of shortcuts) {
      if (x + shortcut.length + 2 > w) break
      const [key, desc] = shortcut.split(":")
      fb.drawText(key, x, 0, FG_ACCENT, BG_TOPBAR, TextAttributes.BOLD)
      fb.drawText(`:${desc} `, x + key.length, 0, FG_DIM, BG_TOPBAR)
      x += shortcut.length + 2
    }
  }

  // =========================================================================
  // HELP OVERLAY
  // =========================================================================
  renderHelpOverlay(): void {
    const fb = this.mainFB.frameBuffer
    const w = this.mainFB.width
    const h = this.mainFB.height

    const boxW = 50
    const boxH = 26
    const boxX = Math.floor((w - boxW) / 2)
    const boxY = Math.floor((h - boxH) / 2)
    const bgHelp = RGBA.fromHex("#24283b")

    fb.fillRect(boxX, boxY, boxW, boxH, bgHelp)

    // Border
    for (let x = boxX; x < boxX + boxW; x++) {
      fb.setCell(x, boxY, "─", FG_ACCENT, bgHelp)
      fb.setCell(x, boxY + boxH - 1, "─", FG_ACCENT, bgHelp)
    }
    for (let y = boxY; y < boxY + boxH; y++) {
      fb.setCell(boxX, y, "│", FG_ACCENT, bgHelp)
      fb.setCell(boxX + boxW - 1, y, "│", FG_ACCENT, bgHelp)
    }
    fb.setCell(boxX, boxY, "╭", FG_ACCENT, bgHelp)
    fb.setCell(boxX + boxW - 1, boxY, "╮", FG_ACCENT, bgHelp)
    fb.setCell(boxX, boxY + boxH - 1, "╰", FG_ACCENT, bgHelp)
    fb.setCell(boxX + boxW - 1, boxY + boxH - 1, "╯", FG_ACCENT, bgHelp)

    const title = "  TUIDAW - Keyboard Shortcuts  "
    fb.drawText(title, boxX + Math.floor((boxW - title.length) / 2), boxY, FG_ACCENT, bgHelp, TextAttributes.BOLD)

    const lines = [
      ["SPACE", "Play/Record/Stop"],
      ["R", "Arm/disarm selected track"],
      ["A", "Add new track"],
      ["D / DEL", "Delete track (clear if last)"],
      ["↑ / ↓", "Select track"],
      ["← / →", "Scroll waveform view"],
      ["HOME / 0", "Jump to beginning"],
      ["M", "Toggle mute on selected track"],
      ["S", "Toggle solo on selected track"],
      ["+", "Increase BPM (speed up / relabel if locked)"],
      ["-", "Decrease BPM (slow down / relabel if locked)"],
      ["B", "Toggle BPM lock (label-only vs speed change)"],
      ["C", "Toggle metronome click"],
      ["P", "Practice loop (start/end/clear)"],
      ["V", "Volume up on selected track"],
      ["[ / ]", "Scrub playhead left / right"],
      ["{ / }", "Nudge track earlier / later (1/16 beat)"],
      ["< / >", "Pan left / right"],
      ["F2", "Select input device for track"],
      ["F3", "Select output device (global)"],
      ["I", "Import WAV into selected track"],
      ["E", "Export mixdown (WAV)"],
      ["F5", "Save project (.tuidaw)"],
      ["F6", "Open project (.tuidaw)"],
      ["F1", "Toggle this help"],
      ["Q / Ctrl+C", "Quit"],
      ["", "Mouse: wheel on waveform=scroll"],
      ["", "  sidebar vol/pan=adjust"],
    ]

    for (let i = 0; i < lines.length && i + 2 < boxH - 1; i++) {
      const [key, desc] = lines[i]
      fb.drawText(` ${key.padEnd(12)}`, boxX + 2, boxY + 2 + i, FG_YELLOW, bgHelp)
      fb.drawText(desc, boxX + 15, boxY + 2 + i, FG_PRIMARY, bgHelp)
    }
  }

  toggleHelp(): boolean {
    this.helpOverlayVisible = !this.helpOverlayVisible
    return this.helpOverlayVisible
  }

  isHelpVisible(): boolean {
    return this.helpOverlayVisible
  }

  // =========================================================================
  // DEVICE SELECTOR OVERLAY
  // =========================================================================

  // Open device selector overlay
  openDeviceSelector(
    mode: "input" | "output",
    devices: AudioDevice[],
    currentDeviceId: number | null,
    callback: (device: AudioDevice | null) => void,
  ): void {
    this.deviceSelectorVisible = true
    this.deviceSelectorMode = mode
    this.deviceSelectorDevices = devices
    this.deviceSelectorCallback = callback

    // Pre-select the current device, or 0 for "Default"
    if (currentDeviceId != null) {
      const idx = devices.findIndex((d) => d.id === currentDeviceId)
      this.deviceSelectorIndex = idx >= 0 ? idx + 1 : 0 // +1 because 0 is "Default"
    } else {
      this.deviceSelectorIndex = 0
    }
  }

  closeDeviceSelector(): void {
    this.deviceSelectorVisible = false
    this.deviceSelectorCallback = null
  }

  isDeviceSelectorVisible(): boolean {
    return this.deviceSelectorVisible
  }

  deviceSelectorUp(): void {
    if (this.deviceSelectorIndex > 0) {
      this.deviceSelectorIndex--
    }
  }

  deviceSelectorDown(): void {
    // +1 for "Default" entry at top
    if (this.deviceSelectorIndex < this.deviceSelectorDevices.length) {
      this.deviceSelectorIndex++
    }
  }

  deviceSelectorConfirm(): AudioDevice | null {
    if (this.deviceSelectorIndex === 0) {
      // "Default" selected
      if (this.deviceSelectorCallback) this.deviceSelectorCallback(null)
      this.closeDeviceSelector()
      return null
    }
    const device = this.deviceSelectorDevices[this.deviceSelectorIndex - 1]
    if (this.deviceSelectorCallback) this.deviceSelectorCallback(device ?? null)
    this.closeDeviceSelector()
    return device ?? null
  }

  deviceSelectorCancel(): void {
    this.closeDeviceSelector()
  }

  renderDeviceSelectorOverlay(): void {
    const fb = this.mainFB.frameBuffer
    const w = this.mainFB.width
    const h = this.mainFB.height
    const devices = this.deviceSelectorDevices

    const boxW = Math.min(60, w - 4)
    const listCount = devices.length + 1 // +1 for "Default"
    const boxH = Math.min(listCount + 4, h - 2) // title + border + items
    const boxX = Math.floor((w - boxW) / 2)
    const boxY = Math.floor((h - boxH) / 2)
    const bgOverlay = RGBA.fromHex("#1f2335")
    const bgSelected = RGBA.fromHex("#364a82")

    fb.fillRect(boxX, boxY, boxW, boxH, bgOverlay)

    // Border
    for (let x = boxX; x < boxX + boxW; x++) {
      fb.setCell(x, boxY, "─", FG_ACCENT, bgOverlay)
      fb.setCell(x, boxY + boxH - 1, "─", FG_ACCENT, bgOverlay)
    }
    for (let y = boxY; y < boxY + boxH; y++) {
      fb.setCell(boxX, y, "│", FG_ACCENT, bgOverlay)
      fb.setCell(boxX + boxW - 1, y, "│", FG_ACCENT, bgOverlay)
    }
    fb.setCell(boxX, boxY, "╭", FG_ACCENT, bgOverlay)
    fb.setCell(boxX + boxW - 1, boxY, "╮", FG_ACCENT, bgOverlay)
    fb.setCell(boxX, boxY + boxH - 1, "╰", FG_ACCENT, bgOverlay)
    fb.setCell(boxX + boxW - 1, boxY + boxH - 1, "╯", FG_ACCENT, bgOverlay)

    // Title
    const title = this.deviceSelectorMode === "input"
      ? "  Select Input Device  "
      : "  Select Output Device  "
    fb.drawText(
      title,
      boxX + Math.floor((boxW - title.length) / 2),
      boxY,
      FG_ACCENT,
      bgOverlay,
      TextAttributes.BOLD,
    )

    // Instructions
    const instructions = "↑↓:Navigate  Enter:Select  Esc:Cancel"
    fb.drawText(
      instructions,
      boxX + Math.floor((boxW - instructions.length) / 2),
      boxY + boxH - 1,
      FG_DIM,
      bgOverlay,
    )

    // "Default" entry
    const maxVisible = boxH - 3 // rows available for list items
    const scrollStart = Math.max(0, this.deviceSelectorIndex - maxVisible + 1)

    let row = 0
    for (let i = scrollStart; i <= devices.length && row < maxVisible; i++, row++) {
      const y = boxY + 2 + row
      const isSelected = i === this.deviceSelectorIndex
      const bg = isSelected ? bgSelected : bgOverlay
      const fg = isSelected ? FG_PRIMARY : FG_DIM

      fb.fillRect(boxX + 1, y, boxW - 2, 1, bg)

      if (i === 0) {
        // "Default" entry
        const marker = isSelected ? " > " : "   "
        fb.drawText(`${marker}(Default)`, boxX + 2, y, fg, bg, isSelected ? TextAttributes.BOLD : 0)
      } else {
        const device = devices[i - 1]
        const marker = isSelected ? " > " : "   "
        const desc = device.description.length > boxW - 8
          ? device.description.substring(0, boxW - 11) + "..."
          : device.description
        fb.drawText(`${marker}${desc}`, boxX + 2, y, fg, bg, isSelected ? TextAttributes.BOLD : 0)
      }
    }
  }

  // =========================================================================
  // STATUS MESSAGE - Temporary message in status bar
  // =========================================================================

  showStatusMessage(msg: string, durationMs: number = 3000): void {
    this.statusMessage = msg
    if (this.statusMessageTimeout) {
      clearTimeout(this.statusMessageTimeout)
    }
    this.statusMessageTimeout = setTimeout(() => {
      this.statusMessage = null
      this.statusMessageTimeout = null
      // We can't call render() from here since we don't have state,
      // but the next render cycle will clear it. We'll request a render
      // via the renderer directly.
      this.renderer.requestRender()
    }, durationMs)
  }

  // =========================================================================
  // FILE PICKER OVERLAY
  // =========================================================================

  openFilePicker(
    files: string[],
    callback: (file: string | null) => void,
  ): void {
    this.filePickerVisible = true
    this.filePickerFiles = files
    this.filePickerIndex = 0
    this.filePickerCallback = callback
  }

  isFilePickerVisible(): boolean {
    return this.filePickerVisible
  }

  filePickerUp(): void {
    if (this.filePickerIndex > 0) {
      this.filePickerIndex--
    }
  }

  filePickerDown(): void {
    if (this.filePickerIndex < this.filePickerFiles.length - 1) {
      this.filePickerIndex++
    }
  }

  async filePickerConfirm(): Promise<void> {
    const file = this.filePickerFiles[this.filePickerIndex]
    const cb = this.filePickerCallback
    this.filePickerVisible = false
    this.filePickerCallback = null
    if (cb) cb(file ?? null)
  }

  filePickerCancel(): void {
    const cb = this.filePickerCallback
    this.filePickerVisible = false
    this.filePickerCallback = null
    if (cb) cb(null)
  }

  private renderFilePickerOverlay(): void {
    const fb = this.mainFB.frameBuffer
    const w = this.mainFB.width
    const h = this.mainFB.height
    const files = this.filePickerFiles

    const boxW = Math.min(60, w - 4)
    const boxH = Math.min(files.length + 4, h - 2)
    const boxX = Math.floor((w - boxW) / 2)
    const boxY = Math.floor((h - boxH) / 2)
    const bgOverlay = RGBA.fromHex("#1f2335")
    const bgSelected = RGBA.fromHex("#364a82")

    fb.fillRect(boxX, boxY, boxW, boxH, bgOverlay)

    // Border
    for (let x = boxX; x < boxX + boxW; x++) {
      fb.setCell(x, boxY, "─", FG_ACCENT, bgOverlay)
      fb.setCell(x, boxY + boxH - 1, "─", FG_ACCENT, bgOverlay)
    }
    for (let y = boxY; y < boxY + boxH; y++) {
      fb.setCell(boxX, y, "│", FG_ACCENT, bgOverlay)
      fb.setCell(boxX + boxW - 1, y, "│", FG_ACCENT, bgOverlay)
    }
    fb.setCell(boxX, boxY, "╭", FG_ACCENT, bgOverlay)
    fb.setCell(boxX + boxW - 1, boxY, "╮", FG_ACCENT, bgOverlay)
    fb.setCell(boxX, boxY + boxH - 1, "╰", FG_ACCENT, bgOverlay)
    fb.setCell(boxX + boxW - 1, boxY + boxH - 1, "╯", FG_ACCENT, bgOverlay)

    // Title
    const title = "  Open Project  "
    fb.drawText(
      title,
      boxX + Math.floor((boxW - title.length) / 2),
      boxY,
      FG_ACCENT,
      bgOverlay,
      TextAttributes.BOLD,
    )

    // Instructions
    const instructions = "↑↓:Navigate  Enter:Open  Esc:Cancel"
    fb.drawText(
      instructions,
      boxX + Math.floor((boxW - instructions.length) / 2),
      boxY + boxH - 1,
      FG_DIM,
      bgOverlay,
    )

    // File list
    const maxVisible = boxH - 3
    const scrollStart = Math.max(0, this.filePickerIndex - maxVisible + 1)

    let row = 0
    for (let i = scrollStart; i < files.length && row < maxVisible; i++, row++) {
      const y = boxY + 2 + row
      const isSelected = i === this.filePickerIndex
      const bg = isSelected ? bgSelected : bgOverlay
      const fg = isSelected ? FG_PRIMARY : FG_DIM

      fb.fillRect(boxX + 1, y, boxW - 2, 1, bg)

      const marker = isSelected ? " > " : "   "
      const name = files[i].length > boxW - 8
        ? files[i].substring(0, boxW - 11) + "..."
        : files[i]
      fb.drawText(`${marker}${name}`, boxX + 2, y, fg, bg, isSelected ? TextAttributes.BOLD : 0)
    }
  }
}
