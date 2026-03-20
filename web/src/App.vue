<script setup vapor lang="ts">
import TopBar from './components/TopBar.vue'
import SideBar from './components/SideBar.vue'
import StatusBar from './components/StatusBar.vue'
import InputOverlay from './components/InputOverlay.vue'
import WaveformCanvas from './components/WaveformCanvas.vue'
import { useAppState } from './composables/useAppState'
import { useKeyboard } from './composables/useKeyboard'
import { ensureAudioReady, getAudio } from './composables/useAudio'

const state = useAppState()

// Install global keyboard shortcuts
useKeyboard()

function toggleInputOverlay() {
  state.showInputOverlay = !state.showInputOverlay
  if (state.showInputOverlay) {
    ensureAudioReady().then((ready) => {
      if (ready) {
        const audio = getAudio()
        audio.requestMicAccess().then(() => {
          state.inputDevices = audio.inputDevices
        })
      }
    })
  }
}

function closeInputOverlay() {
  state.showInputOverlay = false
}
</script>

<template>
  <div class="bg-surface text-fg flex h-screen flex-col font-mono">
    <!-- Top Bar -->
    <TopBar @toggle-input-overlay="toggleInputOverlay" />

    <!-- Main content area -->
    <div class="flex min-h-0 flex-1">
      <!-- Sidebar -->
      <SideBar />

      <!-- Waveform / timeline area -->
      <WaveformCanvas />
    </div>

    <!-- Status Bar -->
    <StatusBar />

    <!-- Input device overlay -->
    <InputOverlay v-if="state.showInputOverlay" @close="closeInputOverlay" />
  </div>
</template>
