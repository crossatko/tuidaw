<script setup vapor lang="ts">
import { computed } from 'vue'
import { useAppState } from '../composables/useAppState'

const state = useAppState()

const emit = defineEmits<{
  close: []
}>()

const selectedTrack = computed(() =>
  state.selectedTrackIndex >= 0 ? state.tracks[state.selectedTrackIndex] : null
)

interface DeviceEntry {
  deviceId: string | null
  label: string
  channels: number
}

const deviceList = computed<DeviceEntry[]>(() => [
  { deviceId: null, label: 'Default', channels: 0 },
  ...state.inputDevices.map((d) => ({
    deviceId: d.deviceId,
    label: d.label,
    channels: d.channelCount
  }))
])

const currentDeviceId = computed(
  () => selectedTrack.value?.inputDeviceId ?? null
)

function selectDevice(deviceId: string | null) {
  const track = selectedTrack.value
  if (track) {
    track.inputDeviceId = deviceId
    track.inputChannel = 0 // reset channel on device change
  }
  emit('close')
}

function onBackdropClick(e: MouseEvent) {
  if ((e.target as HTMLElement).dataset.backdrop !== undefined) {
    emit('close')
  }
}
</script>

<template>
  <div
    data-backdrop
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/75"
    @click="onBackdropClick"
    @keydown.escape="emit('close')"
  >
    <div
      class="border-border w-full max-w-[400px] overflow-hidden rounded-lg border bg-[#111111]"
    >
      <!-- Header -->
      <div class="flex items-center gap-2 px-4 py-3">
        <span class="text-fg text-sm font-bold">Select Input Device</span>
        <span v-if="selectedTrack" class="text-dim text-[10px]">
          for "{{ selectedTrack.name }}"
        </span>
      </div>

      <!-- Device list -->
      <div class="max-h-[60vh] overflow-y-auto px-1 pb-4">
        <button
          v-for="dev in deviceList"
          :key="dev.deviceId ?? 'default'"
          class="flex w-full items-center rounded border px-3 py-2.5"
          :class="
            dev.deviceId === currentDeviceId
              ? 'border-accent-cyan bg-surface-highlight'
              : 'border-transparent bg-transparent'
          "
          @click="selectDevice(dev.deviceId)"
        >
          <div class="flex flex-1 flex-col items-start">
            <span
              class="text-xs"
              :class="
                dev.deviceId === currentDeviceId
                  ? 'text-accent-cyan font-bold'
                  : 'text-fg'
              "
            >
              {{ dev.label }}
            </span>
            <span v-if="dev.channels > 0" class="text-dim text-[10px]">
              {{ dev.channels }}ch
            </span>
          </div>

          <!-- Check mark for active -->
          <span
            v-if="dev.deviceId === currentDeviceId"
            class="text-accent-cyan text-sm font-bold"
          >
            ✓
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
