/**
 * Pre-rendered SVG inner HTML for each icon used in the app.
 * Generated from lucide icon node data — Vapor-compatible (no VDOM components).
 */
import {
  Play,
  Square,
  Circle,
  Repeat,
  Metronome,
  Minus,
  Plus,
  Save,
  FolderOpen,
  FileAudio,
  FileOutput,
  Mic,
  PlusCircle,
  X,
  VolumeX,
  Volume2,
  CircleDot,
  Check
} from 'lucide'
import type { IconNode } from 'lucide'

function toSvg(node: IconNode): string {
  return node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ')
      return `<${tag} ${a}/>`
    })
    .join('')
}

export const icons = {
  play: toSvg(Play),
  square: toSvg(Square),
  circle: toSvg(Circle),
  repeat: toSvg(Repeat),
  metronome: toSvg(Metronome),
  minus: toSvg(Minus),
  plus: toSvg(Plus),
  save: toSvg(Save),
  folderOpen: toSvg(FolderOpen),
  fileAudio: toSvg(FileAudio),
  fileOutput: toSvg(FileOutput),
  mic: toSvg(Mic),
  plusCircle: toSvg(PlusCircle),
  x: toSvg(X),
  volumeX: toSvg(VolumeX),
  volume2: toSvg(Volume2),
  circleDot: toSvg(CircleDot),
  check: toSvg(Check)
} as const

export type IconName = keyof typeof icons
