<script setup vapor lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import ClickTrackRow from './ClickTrackRow.vue'
import TrackRow from './TrackRow.vue'
import {
  useAppState,
  showStatus,
  registerTrackListScroller,
  unregisterTrackListScroller
} from '../composables/useAppState'
import { getAudio } from '../composables/useAudio'

const state = useAppState()
const trackListRef = ref<HTMLElement | null>(null)

// Sidebar native scroll → state.trackScrollY (drives canvas waveform offset)
function onTrackListScroll(e: Event) {
  const el = e.target as HTMLElement
  state.trackScrollY = el.scrollTop
}

onMounted(() => {
  registerTrackListScroller((y: number) => {
    const el = trackListRef.value
    if (el) el.scrollTop = y
  })
})

onUnmounted(() => {
  unregisterTrackListScroller()
})

function selectTrack(index: number) {
  state.selectedTrackIndex = index
}

function deleteTrack(index: number) {
  if (state.transportState !== 'stopped') {
    showStatus('Stop transport first')
    return
  }

  const track = state.tracks[index]
  if (!track) return

  // Two-step delete: first clear content, then remove track
  if (track.samples && track.samples.length > 0) {
    track.samples = null
    const audio = getAudio()
    if (audio.isReady) audio.setTrackSamples(track.id, new Float32Array(0))
    showStatus(`Cleared "${track.name}"`)
    return
  }

  // Remove track (but keep at least 1)
  if (state.tracks.length <= 1) {
    showStatus('Last track — nothing to delete')
    return
  }

  const audio = getAudio()
  if (audio.isReady) audio.removeTrack(track.id)
  state.tracks.splice(index, 1)
  state.selectedTrackIndex = Math.min(
    state.selectedTrackIndex,
    state.tracks.length - 1
  )
  showStatus(`Deleted "${track.name}"`)
}
</script>

<template>
  <div
    class="border-border bg-surface flex w-(--sidebar-w) shrink-0 flex-col overflow-hidden border-r"
  >
    <!-- Click track row (pinned at top) -->
    <ClickTrackRow />

    <!-- Scrollable track list -->
    <div
      ref="trackListRef"
      class="flex-1 overflow-y-auto [scrollbar-width:thin]"
      @scroll="onTrackListScroll"
    >
      <TrackRow
        v-for="(track, i) in state.tracks"
        :key="track.id"
        :track="track"
        :index="i"
        @select="selectTrack"
        @delete="deleteTrack"
      />
    </div>
  </div>
</template>
