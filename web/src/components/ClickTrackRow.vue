<script setup vapor lang="ts">
import { computed } from 'vue'
import MiniSlider from './MiniSlider.vue'
import {
  DEFAULT_CLICK_VOLUME,
  DEFAULT_CLICK_PAN,
  useAppState
} from '../composables/useAppState'
import { getAudio } from '../composables/useAudio'

const state = useAppState()

const isSelected = computed(() => state.selectedTrackIndex === -1)

function select() {
  state.selectedTrackIndex = -1
}

function toggleClick() {
  state.clickEnabled = !state.clickEnabled
  const audio = getAudio()
  if (audio.isReady) {
    if (state.clickEnabled) {
      audio.setClick(true, state.bpm)
      audio.setClickVolume(state.clickVolume)
      audio.setClickPan(state.clickPan)
    } else {
      audio.setClick(false, 0)
    }
  }
}

// Click volume: raw range 0-2, frac = value/2
const clickVolFrac = computed(() => state.clickVolume / 2)
function setClickVolFrac(frac: number) {
  state.clickVolume = Math.max(0, Math.min(2, frac * 2))
  const audio = getAudio()
  if (audio.isReady) audio.setClickVolume(state.clickVolume)
}
function resetClickVol() {
  state.clickVolume = DEFAULT_CLICK_VOLUME
  const audio = getAudio()
  if (audio.isReady) audio.setClickVolume(state.clickVolume)
}

// Click pan: raw range -1..+1, frac = (pan+1)/2
const clickPanFrac = computed(() => (state.clickPan + 1) / 2)
function setClickPanFrac(frac: number) {
  state.clickPan = Math.max(-1, Math.min(1, frac * 2 - 1))
  const audio = getAudio()
  if (audio.isReady) audio.setClickPan(state.clickPan)
}
function resetClickPan() {
  state.clickPan = DEFAULT_CLICK_PAN
  const audio = getAudio()
  if (audio.isReady) audio.setClickPan(state.clickPan)
}
</script>

<template>
  <div
    class="border-border relative flex h-(--click-row-h) cursor-pointer flex-col justify-center border-b px-2"
    :class="{
      'bg-surface-highlight': isSelected,
      'bg-transparent': !isSelected
    }"
    @click="select"
  >
    <!-- Selection indicator -->
    <div
      v-if="isSelected"
      class="bg-accent-blue absolute top-0 left-0 h-full w-[3px]"
    />

    <!-- Row 1: Click icon + label -->
    <div class="flex items-center gap-2">
      <span
        class="cursor-pointer text-sm"
        :class="{
          'text-accent-cyan': state.clickEnabled,
          'text-dim': !state.clickEnabled
        }"
        @click.stop="toggleClick"
      >
        ♩
      </span>
      <span
        class="cursor-pointer text-xs font-bold"
        :class="{
          'text-fg': state.clickEnabled,
          'text-dim': !state.clickEnabled
        }"
        @click.stop="toggleClick"
      >
        Click
      </span>
    </div>

    <!-- Row 2: Volume + Pan sliders (side-by-side, half-width each) -->
    <div class="flex gap-2 overflow-hidden">
      <MiniSlider
        class="flex-1"
        label="V"
        :model-value="clickVolFrac"
        :max="2"
        :color="
          state.clickEnabled ? 'var(--color-accent-cyan)' : 'var(--color-dim)'
        "
        :dimmed="!state.clickEnabled"
        @update:model-value="setClickVolFrac"
        @dblclick="resetClickVol"
      />
      <MiniSlider
        class="flex-1"
        label="P"
        :model-value="clickPanFrac"
        :color="
          state.clickEnabled ? 'var(--color-accent-cyan)' : 'var(--color-dim)'
        "
        :dimmed="!state.clickEnabled"
        @update:model-value="setClickPanFrac"
        @dblclick="resetClickPan"
      />
    </div>
  </div>
</template>
