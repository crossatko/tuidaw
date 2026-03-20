<script setup vapor lang="ts">
import { computed } from 'vue'
import { formatPan } from '../composables/useAppState'

const props = defineProps<{
  label: string // 'V' for volume, 'P' for pan
  /** Normalized fraction 0..1 representing the visual position */
  modelValue: number
  /** Max raw value — used only for display text (e.g. 2 for click volume = 200%) */
  max?: number
  /** Accent color for the filled portion */
  color: string
  /** Whether to dim the whole slider (e.g. click disabled) */
  dimmed?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: number]
  dblclick: []
}>()

const displayText = computed(() => {
  if (props.label === 'V') {
    const rawMax = props.max ?? 1
    return `${Math.round(props.modelValue * rawMax * 100)}%`
  }
  // Pan: frac 0..1 → pan -1..+1
  const pan = props.modelValue * 2 - 1
  return formatPan(pan)
})

function onInput(e: Event) {
  const val = parseFloat((e.target as HTMLInputElement).value)
  emit('update:modelValue', val)
}
</script>

<template>
  <div
    class="flex h-5 items-center gap-1"
    :class="dimmed ? 'opacity-50' : ''"
    @dblclick="emit('dblclick')"
  >
    <!-- Label -->
    <span class="text-dim w-4 shrink-0 text-[10px]">
      {{ label }}
    </span>

    <!-- Native range input -->
    <input
      type="range"
      min="0"
      max="1"
      step="0.005"
      :value="modelValue"
      class="h-1.5 flex-1 cursor-pointer appearance-auto"
      :style="{ accentColor: color }"
      @input="onInput"
    />

    <!-- Value text -->
    <span class="text-fg w-10 shrink-0 text-right text-[11px] font-bold">
      {{ displayText }}
    </span>
  </div>
</template>
