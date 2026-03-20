<script setup vapor lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import { icons } from '../composables/useIcons'
import Btn from './Btn.vue'
import {
  SAMPLE_RATE,
  useAppState,
  showStatus,
  createTrack,
  getNextTrackNum
} from '../composables/useAppState'
import {
  getAudio,
  updateClickBuffer,
  getClickDuration
} from '../composables/useAudio'
import { play, stopTransport, toggleLoop } from '../composables/useTransport'
import { importWav, saveProject, openProject } from '../composables/useProject'

const state = useAppState()

const isPlaying = computed(() => state.transportState !== 'stopped')
const isRecording = computed(() => state.transportState === 'recording')

const playLabel = computed(() =>
  isRecording.value ? 'Rec' : isPlaying.value ? 'Pause' : 'Play'
)

const playVariant = computed(() =>
  isRecording.value ? 'red' : isPlaying.value ? 'green' : undefined
)

const hasLoop = computed(
  () => state.loopStart !== null && state.loopEnd !== null
)
const settingLoop = computed(
  () => state.loopStart !== null && state.loopEnd === null
)
const loopLabel = computed(() => (settingLoop.value ? 'Loop...' : 'Loop'))

const speed = computed(() => state.bpm / state.originalBpm)
const speedText = computed(() =>
  Math.abs(speed.value - 1) > 0.001 ? `${Math.round(speed.value * 100)}%` : ''
)

const timeText = computed(() => {
  const seconds = state.playheadPosition / SAMPLE_RATE
  const mins = Math.floor(seconds / 60)
  const secs = (seconds % 60).toFixed(1)
  return `${mins}:${secs.padStart(4, '0')}`
})

// ── Handlers ────────────────────────────────────────────────────────
function onPlayClick() {
  if (isPlaying.value) stopTransport()
  else play()
}

function onClickToggle() {
  state.clickEnabled = !state.clickEnabled
  const audio = getAudio()
  if (state.transportState !== 'stopped' && audio.isReady) {
    if (state.clickEnabled) {
      audio.generateClick(state.bpm, getClickDuration())
      audio.setClick(true, state.bpm)
      audio.setClickVolume(state.clickVolume)
      audio.setClickPan(state.clickPan)
    } else {
      audio.setClick(false, 0)
    }
  }
}

function onBpmMinus() {
  state.bpm = Math.max(20, state.bpm - 1)
  const audio = getAudio()
  if (audio.isReady) audio.setSpeed(state.bpm / state.originalBpm)
}

function onBpmPlus() {
  state.bpm = Math.min(300, state.bpm + 1)
  const audio = getAudio()
  if (audio.isReady) audio.setSpeed(state.bpm / state.originalBpm)
}

let bpmLastClick = 0
function onBpmDblClick() {
  const now = performance.now()
  if (now - bpmLastClick < 400) {
    state.bpm = state.originalBpm
    const audio = getAudio()
    if (audio.isReady) audio.setSpeed(1)
    showStatus(`BPM reset to ${state.originalBpm}`)
  }
  bpmLastClick = now
}

function onAddTrack() {
  if (state.transportState !== 'stopped') {
    showStatus('Stop transport first (Space)')
    return
  }
  const newTrack = createTrack(
    `Track ${getNextTrackNum()}`,
    state.tracks.length
  )
  state.tracks.push(newTrack)
  const audio = getAudio()
  if (audio.isReady) audio.syncTrack(newTrack)
  state.selectedTrackIndex = state.tracks.length - 1
}

const emit = defineEmits<{
  'toggle-input-overlay': []
}>()

function onInputClick() {
  emit('toggle-input-overlay')
}
</script>

<template>
  <div
    class="border-border bg-surface flex h-(--topbar-h) shrink-0 items-center gap-2 overflow-hidden border-b px-3 [-webkit-tap-highlight-color:transparent]"
    style="touch-action: none"
  >
    <!-- Play -->
    <Btn :variant="playVariant" @click="onPlayClick">
      <Icon v-if="isRecording" :d="icons.circle" :size="14" />
      <Icon v-else-if="isPlaying" :d="icons.square" :size="14" />
      <Icon v-else :d="icons.play" :size="14" />
      {{ playLabel }}
    </Btn>

    <!-- Loop -->
    <Btn
      :variant="hasLoop ? 'purple' : undefined"
      :outline="settingLoop && !hasLoop ? 'purple' : undefined"
      @click="toggleLoop"
    >
      <Icon :d="icons.repeat" :size="14" />
      {{ loopLabel }}
    </Btn>

    <!-- Click -->
    <Btn
      :variant="state.clickEnabled ? 'cyan' : undefined"
      @click="onClickToggle"
    >
      <Icon :d="icons.metronome" :size="14" />
      Click
    </Btn>

    <!-- Separator -->
    <div class="w-2" />

    <!-- BPM controls -->
    <Btn square @click="onBpmMinus"><Icon :d="icons.minus" :size="14" /></Btn>
    <span
      class="text-accent-cyan cursor-pointer px-1 text-sm font-bold whitespace-nowrap"
      @click="onBpmDblClick"
    >
      {{ state.bpm }} BPM
    </span>
    <Btn square @click="onBpmPlus"><Icon :d="icons.plus" :size="14" /></Btn>

    <!-- Speed -->
    <span v-if="speedText" class="text-accent-orange text-xs whitespace-nowrap">
      {{ speedText }}
    </span>

    <!-- Time -->
    <span class="text-dim text-[13px] whitespace-nowrap">
      {{ timeText }}
    </span>

    <!-- Spacer -->
    <div class="min-w-1 flex-1" />

    <!-- Status message -->
    <span
      v-if="state.statusMessage"
      class="text-accent-yellow min-w-0 shrink truncate text-right text-xs"
    >
      {{ state.statusMessage }}
    </span>

    <!-- File operations -->
    <Btn @click="saveProject"><Icon :d="icons.save" :size="14" /> Save</Btn>
    <Btn @click="openProject"
      ><Icon :d="icons.folderOpen" :size="14" /> Open</Btn
    >
    <Btn @click="importWav"
      ><Icon :d="icons.fileAudio" :size="14" /> Import</Btn
    >
    <Btn @click="showStatus('Export not yet implemented')"
      ><Icon :d="icons.fileOutput" :size="14" /> Export</Btn
    >
    <Btn
      :variant="state.showInputOverlay ? 'orange' : undefined"
      @click="onInputClick"
    >
      <Icon :d="icons.mic" :size="14" /> Input
    </Btn>
    <Btn @click="onAddTrack"
      ><Icon :d="icons.plusCircle" :size="14" /> Track</Btn
    >
  </div>
</template>
