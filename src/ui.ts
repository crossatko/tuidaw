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
import type { ProjectState, Track, PipeWireDevice } from "./types"
import { SIDEBAR_WIDTH, TOPBAR_HEIGHT, TRACK_ROW_HEIGHT } from "./types"
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
  private helpOverlayVisible = false
  private deviceSelectorVisible = false
  private deviceSelectorMode: "input" | "output" = "input"
  private deviceSelectorIndex = 0
  private deviceSelectorDevices: PipeWireDevice[] = []
  private deviceSelectorCallback: ((device: PipeWireDevice | null) => void) | null = null
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
  }): void {
    // Main area: mouse wheel scrolls the timeline horizontally
    this.mainFB.onMouseScroll = (event: MouseEvent) => {
      if (!event.scroll) return
      const dir = event.scroll.direction
      // Scroll up/down → scroll timeline left/right (natural mapping for horizontal timeline)
      if (dir === "up" || dir === "left") {
        callbacks.onScrollChange(-1)
      } else if (dir === "down" || dir === "right") {
        callbacks.onScrollChange(1)
      }
    }

    // Sidebar: mouse wheel adjusts volume or pan on the SELECTED track
    // Pan zone: row 1 of any track row, x >= 17
    // Volume zone: everything else in sidebar
    this.sidebarFB.onMouseScroll = (event: MouseEvent) => {
      if (!event.scroll) return
      const dir = event.scroll.direction
      const delta = (dir === "up" || dir === "left") ? 1 : -1

      // Determine row within track to distinguish volume vs pan zone
      // event.y is screen-absolute; sidebar starts at y=TOPBAR_HEIGHT
      const localY = event.y - TOPBAR_HEIGHT
      if (localY < 0) return
      const rowInTrack = localY % TRACK_ROW_HEIGHT

      // Pan control: row 1, x >= 17 (where pan indicator is drawn)
      if (rowInTrack === 1 && event.x >= 17) {
        callbacks.onPanChange(delta * 0.05)
        return
      }

      // Volume control: everything else within the sidebar
      callbacks.onVolumeChange(delta * 0.05)
    }

    // Sidebar: click to select track
    this.sidebarFB.onMouse = (event: MouseEvent) => {
      if (event.type !== "down") return
      // event.y is screen-absolute; sidebar starts at y=TOPBAR_HEIGHT
      const localY = event.y - TOPBAR_HEIGHT
      if (localY < 0) return
      const trackIndex = Math.floor(localY / TRACK_ROW_HEIGHT)
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
          // Waveform area — select track (localY=1 is first track row)
          draggingTimeline = false
          const trackIndex = Math.floor((localY - 1) / TRACK_ROW_HEIGHT)
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

    // Beat position
    const beatStr = formatBeatPosition(state.playheadPosition, state.sampleRate, state.bpm)
    fb.drawText(` [${beatStr}]`, 10 + timeStr.length, 1, FG_DIM, BG_TOPBAR)

    // BPM
    const bpmX = 30
    fb.drawText("BPM:", bpmX, 1, FG_DIM, BG_TOPBAR)
    fb.drawText(` ${state.bpm} `, bpmX + 4, 1, FG_YELLOW, BG_TOPBAR, TextAttributes.BOLD)

    // Click indicator
    const clickX = bpmX + 10
    if (state.clickEnabled) {
      fb.drawText(" CLICK ", clickX, 1, RGBA.fromHex("#1a1b26"), FG_YELLOW)
    } else {
      fb.drawText(" click ", clickX, 1, FG_DIM, BG_TOPBAR)
    }

    // Output device indicator
    const outX = clickX + 8
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

    // Track list
    let y = 1
    for (let i = 0; i < state.tracks.length; i++) {
      if (y + TRACK_ROW_HEIGHT > h) break
      const track = state.tracks[i]
      const isSelected = i === state.selectedTrackIndex
      const trackColor = RGBA.fromHex(track.color)

      // Background
      const bg = track.armed ? BG_ARMED : isSelected ? BG_SELECTED : BG_SIDEBAR

      // Track row background
      for (let row = 0; row < TRACK_ROW_HEIGHT; row++) {
        fb.fillRect(0, y + row, w - 1, 1, bg)
      }

      // Selection indicator
      if (isSelected) {
        fb.setCell(0, y, "▌", trackColor, bg)
        fb.setCell(0, y + 1, "▌", trackColor, bg)
        fb.setCell(0, y + 2, "▌", trackColor, bg)
      }

      // Color dot and name
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

      // Mute / Solo / Arm buttons
      const muteColor = track.muted ? FG_RED : FG_DIM
      const soloColor = track.solo ? FG_YELLOW : FG_DIM
      const armColor = track.armed ? FG_RED : FG_DIM

      fb.drawText(" M", 1, y + 1, muteColor, bg, track.muted ? TextAttributes.BOLD : 0)
      fb.drawText(" S", 4, y + 1, soloColor, bg, track.solo ? TextAttributes.BOLD : 0)
      fb.drawText(" R", 7, y + 1, armColor, bg, track.armed ? TextAttributes.BOLD : 0)

      // Volume bar
      const volStr = `V:${Math.round(track.volume * 100)}%`
      fb.drawText(volStr, 11, y + 1, FG_DIM, bg)

      // Pan indicator
      let panStr: string
      if (track.pan === 0) {
        panStr = "C"
      } else if (track.pan < 0) {
        panStr = `L${Math.round(Math.abs(track.pan) * 100)}`
      } else {
        panStr = `R${Math.round(track.pan * 100)}`
      }
      fb.drawText(panStr, 17, y + 1, FG_DIM, bg)

      // Level meter (if track has audio) or input device indicator
      if (track.inputDeviceId != null && !(track.samples && track.samples.length > 0)) {
        // Show input device when track is empty
        const dev = state.availableInputDevices.find((d) => d.id === track.inputDeviceId)
        const devLabel = dev ? dev.description : `ID:${track.inputDeviceId}`
        const truncated = devLabel.length > w - 4 ? devLabel.substring(0, w - 7) + "..." : devLabel
        fb.drawText(truncated, 1, y + 2, FG_DIM, bg)
      } else if (track.samples && track.samples.length > 0) {
        const level = getPeakLevel(
          track.samples,
          state.playheadPosition,
          Math.floor(state.sampleRate * 0.05),
        )
        const meterStr = renderLevelMeter(level, w - 3)
        fb.drawText(meterStr, 1, y + 2, trackColor, bg)
      } else {
        fb.drawText("(empty)", 1, y + 2, FG_DIM, bg)
      }

      // Separator
      for (let x = 0; x < w - 1; x++) {
        fb.setCell(x, y + TRACK_ROW_HEIGHT - 1, "─", RGBA.fromHex("#292e42"), bg)
      }

      y += TRACK_ROW_HEIGHT
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
    const samplesPerSubCol = Math.max(1, Math.floor(state.sampleRate / (w * 2) * 10))

    // Timeline header (1 row)
    this.renderTimeline(fb, w, state, samplesPerSubCol)

    // Render each track's waveform
    let y = 1
    for (let i = 0; i < state.tracks.length; i++) {
      const trackH = Math.min(TRACK_ROW_HEIGHT, h - y)
      if (trackH <= 0) break

      const track = state.tracks[i]
      const isSelected = i === state.selectedTrackIndex
      const trackColor = RGBA.fromHex(track.color)
      const dimTrackColor = RGBA.fromHex(track.color + "88")

      // Track background
      const trackBg = isSelected ? BG_SELECTED : BG
      fb.fillRect(0, y, w, trackH, trackBg)

      // Draw waveform using braille if track has samples
      if (track.samples && track.samples.length > 0 && !track.muted) {
        const braille = renderBrailleWaveform(
          track.samples,
          w,
          trackH,
          state.scrollOffset,
          samplesPerSubCol,
        )

        for (let row = 0; row < braille.length && row < trackH; row++) {
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
          trackH,
          state.scrollOffset,
          samplesPerSubCol,
        )

        for (let row = 0; row < braille.length && row < trackH; row++) {
          for (let col = 0; col < braille[row].length && col < w; col++) {
            if (braille[row][col] !== String.fromCodePoint(0x2800)) {
              fb.setCell(col, y + row, braille[row][col], FG_DIM, trackBg)
            }
          }
        }
      }

      // Center line for the track
      const centerRow = y + Math.floor(trackH / 2)
      if (centerRow < y + trackH) {
        for (let x = 0; x < w; x++) {
          // Only draw center line where there's no waveform data
          fb.setCellWithAlphaBlending(x, centerRow, "·", FG_DIM, TRANSPARENT)
        }
      }

      // Track separator
      if (y + trackH < h) {
        for (let x = 0; x < w; x++) {
          fb.setCell(x, y + trackH - 1, "─", GRID_COLOR, trackBg)
        }
      }

      y += trackH
    }

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

    const samplesPerBeat = Math.round((60 / state.bpm) * state.sampleRate)
    const samplesPerBar = samplesPerBeat * 4
    const samplesPerCol = samplesPerSubCol * 2

    for (let x = 0; x < width; x++) {
      const samplePos = state.scrollOffset + x * samplesPerCol
      const beatNum = Math.floor(samplePos / samplesPerBeat)
      const sampleInBeat = samplePos % samplesPerBeat

      // Mark bar boundaries
      if (beatNum % 4 === 0 && sampleInBeat < samplesPerCol) {
        const barNum = Math.floor(beatNum / 4) + 1
        const label = String(barNum)
        if (x + label.length < width) {
          fb.drawText(label, x, 0, FG_ACCENT, BG_DARKER)
        }
      } else if (sampleInBeat < samplesPerCol) {
        fb.setCell(x, 0, "┊", FG_DIM, BG_DARKER)
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
      "</>:Pan",
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
      ["+", "Increase BPM"],
      ["-", "Decrease BPM"],
      ["C", "Toggle metronome click"],
      ["V", "Volume up on selected track"],
      ["[ / ]", "Scrub playhead left / right"],
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
    devices: PipeWireDevice[],
    currentDeviceId: number | null,
    callback: (device: PipeWireDevice | null) => void,
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

  deviceSelectorConfirm(): PipeWireDevice | null {
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
