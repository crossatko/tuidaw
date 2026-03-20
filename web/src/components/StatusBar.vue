<script setup vapor lang="ts">
import { useAppState } from '../composables/useAppState'

const state = useAppState()
</script>

<template>
  <div
    class="border-border bg-surface text-dim flex h-(--statusbar-h) items-center border-t px-4 font-mono text-[11px]"
  >
    <span v-if="state.statusMessage" class="text-fg">
      {{ state.statusMessage }}
    </span>
    <span v-else>
      Space Play &nbsp; P Loop &nbsp; R Arm &nbsp; M Mute &nbsp; S Solo &nbsp; C
      Click &nbsp; +/- BPM &nbsp; I Import &nbsp; E Export &nbsp; Dbl-click
      slider = reset
    </span>
  </div>
</template>
