<script setup vapor lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import { icons } from '../composables/useIcons'
import MiniSlider from './MiniSlider.vue'
import type { WebTrack } from '../../audio-bridge'
import {
  SAMPLE_RATE,
  DEFAULT_VOLUME,
  DEFAULT_PAN,
  DEFAULT_GAIN,
  useAppState,
  showStatus
} from '../composables/useAppState'
import { getAudio } from '../composables/useAudio'

const props = defineProps<{
  track: WebTrack
  index: number
}>()

const emit = defineEmits<{
  select: [index: number]
  delete: [index: number]
}>()

const state = useAppState()

const isSelected = computed(() => state.selectedTrackIndex === props.index)

// ── MSR Button handlers ─────────────────────────────────────────────
function toggleMute() {
  props.track.muted = !props.track.muted
  const audio = getAudio()
  if (audio.isReady) audio.setTrackMuted(props.track.id, props.track.muted)
}

function toggleSolo() {
  props.track.solo = !props.track.solo
  const audio = getAudio()
  if (audio.isReady) {
    for (const t of state.tracks) {
      audio.setTrackSolo(t.id, t.solo)
    }
  }
}

function toggleArm() {
  if (state.transportState !== 'stopped') {
    showStatus('Stop transport to toggle arm')
    return
  }
  props.track.armed = !props.track.armed
}

// ── Volume/Pan ──────────────────────────────────────────────────────
const volFrac = computed(() => props.track.volume)
function setVolFrac(frac: number) {
  props.track.volume = Math.max(0, Math.min(1, frac))
  const audio = getAudio()
  if (audio.isReady) audio.setTrackVolume(props.track.id, props.track.volume)
}
function resetVol() {
  setVolFrac(DEFAULT_VOLUME)
}

const panFrac = computed(() => (props.track.pan + 1) / 2)
function setPanFrac(frac: number) {
  props.track.pan = Math.max(-1, Math.min(1, frac * 2 - 1))
  const audio = getAudio()
  if (audio.isReady) audio.setTrackPan(props.track.id, props.track.pan)
}
function resetPan() {
  props.track.pan = DEFAULT_PAN
  const audio = getAudio()
  if (audio.isReady) audio.setTrackPan(props.track.id, props.track.pan)
}

// ── Gain ────────────────────────────────────────────────────────────
const gainFrac = computed(() => props.track.gain / 4)
function setGainFrac(frac: number) {
  props.track.gain = Math.max(0, Math.min(4, frac * 4))
  const audio = getAudio()
  if (audio.isReady) audio.setTrackGain(props.track.id, props.track.gain)
}
function resetGain() {
  props.track.gain = DEFAULT_GAIN
  const audio = getAudio()
  if (audio.isReady) audio.setTrackGain(props.track.id, props.track.gain)
}

// ── Input device info ───────────────────────────────────────────────
function getChannelLabel(ch: number): string {
  return ch === 0 ? 'Mix' : `Ch ${ch}`
}

function cycleChannel() {
  const maxCh = getDeviceChannelCount()
  props.track.inputChannel = (props.track.inputChannel + 1) % (maxCh + 1)
}

function getDeviceChannelCount(): number {
  const deviceId = props.track.inputDeviceId
  if (!deviceId) {
    const def = state.inputDevices.find((d) => d.channelCount > 0)
    return def ? def.channelCount : 1
  }
  const dev = state.inputDevices.find((d) => d.deviceId === deviceId)
  return dev && dev.channelCount > 0 ? dev.channelCount : 1
}

function getDeviceLabel(): string {
  const deviceId = props.track.inputDeviceId
  if (!deviceId) return 'Default'
  const dev = state.inputDevices.find((d) => d.deviceId === deviceId)
  return dev ? dev.label : 'Unknown'
}

const durationText = computed(() => {
  if (!props.track.samples || props.track.samples.length === 0) return '(empty)'
  return `${(props.track.samples.length / SAMPLE_RATE).toFixed(1)}s`
})
</script>

<template>
  <div
    class="border-border relative flex h-(--track-h) cursor-pointer flex-col border-b"
    :class="{
      'bg-white/10': isSelected,
      'bg-transparent': !isSelected
    }"
    @click="emit('select', index)"
  >
    <!-- Selection indicator -->
    <div
      v-if="isSelected"
      class="absolute top-0 left-0 h-full w-[3px]"
      :style="{ backgroundColor: track.color }"
    />

    <!-- Row 1: Color dot + Name + Delete button -->
    <div class="flex items-center gap-2 px-2 pt-1">
      <div
        class="h-2.5 w-2.5 shrink-0 rounded-full"
        :style="{ backgroundColor: track.color }"
      />
      <span class="text-fg flex-1 truncate text-xs font-bold">
        {{ track.name }}
      </span>
      <button
        class="bg-surface text-dim flex h-6 w-7 shrink-0 items-center justify-center border border-white/20 text-xs font-bold active:opacity-70"
        @click.stop="emit('delete', index)"
      >
        <Icon :d="icons.x" :size="12" />
      </button>
    </div>

    <!-- Row 2: M S R buttons + Input info -->
    <div class="flex items-center gap-1.5 px-2 pt-1">
      <!-- Mute -->
      <button
        class="flex h-7 w-7 items-center justify-center border text-[11px] font-bold active:opacity-70"
        :class="{
          'bg-accent-orange text-surface border-accent-orange/50': track.muted,
          'bg-surface text-dim border-white/20': !track.muted
        }"
        @click.stop="toggleMute"
      >
        M
      </button>
      <!-- Solo -->
      <button
        class="flex h-7 w-7 items-center justify-center border text-[11px] font-bold active:opacity-70"
        :class="{
          'bg-accent-yellow text-surface border-accent-yellow/50': track.solo,
          'bg-surface text-dim border-white/20': !track.solo
        }"
        @click.stop="toggleSolo"
      >
        S
      </button>
      <!-- Record -->
      <button
        class="flex h-7 w-7 items-center justify-center border text-[11px] font-bold active:opacity-70"
        :class="{
          'bg-accent-red text-surface border-accent-red/50': track.armed,
          'bg-surface text-dim border-white/20': !track.armed
        }"
        @click.stop="toggleArm"
      >
        R
      </button>

      <!-- Input device info / duration (right of MSR) -->
      <div class="ml-2 flex flex-1 items-center gap-4 overflow-hidden">
        <template v-if="track.armed || isSelected">
          <!-- Channel badge (tappable) -->
          <button
            class="bg-surface shrink-0 border px-1.5 py-0.5 text-[10px] font-bold"
            :class="{
              'border-accent-red text-accent-red': track.armed,
              'border-accent-cyan text-accent-cyan': !track.armed
            }"
            @click.stop="cycleChannel"
          >
            {{ getChannelLabel(track.inputChannel) }}
          </button>
          <!-- Device label -->
          <span class="text-dim truncate text-[9px]">
            {{ getDeviceLabel() }}
          </span>
        </template>
        <template v-else>
          <span class="text-dim text-[10px]">
            {{ durationText }}
          </span>
        </template>
      </div>
    </div>

    <!-- Row 3: Volume slider (full width) -->
    <div class="px-2 pt-1">
      <MiniSlider
        label="V"
        :model-value="volFrac"
        :color="track.color"
        @update:model-value="setVolFrac"
        @dblclick="resetVol"
      />
    </div>

    <!-- Row 4: Pan slider (full width) -->
    <div class="px-2">
      <MiniSlider
        label="P"
        :model-value="panFrac"
        :color="track.color"
        @update:model-value="setPanFrac"
        @dblclick="resetPan"
      />
    </div>

    <!-- Gain slider hidden until WASM is rebuilt with _tuidaw_set_track_gain -->
  </div>
</template>
