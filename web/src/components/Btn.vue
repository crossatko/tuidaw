<script setup vapor lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  /** Active variant color — when set, button gets filled background */
  variant?: 'green' | 'red' | 'purple' | 'cyan' | 'orange' | 'yellow'
  /** Outline-only active state (e.g. loop "setting" state) */
  outline?: 'purple'
  /** Compact square button (BPM +/-) */
  square?: boolean
}>()

const VARIANT_COLORS: Record<string, string> = {
  green: 'var(--color-accent-green)',
  red: 'var(--color-accent-red)',
  purple: 'var(--color-accent-purple)',
  cyan: 'var(--color-accent-cyan)',
  orange: 'var(--color-accent-orange)',
  yellow: 'var(--color-accent-yellow)'
}

const btnStyle = computed(() => {
  const s: Record<string, string> = { height: '36px' }
  if (props.variant) {
    const c = VARIANT_COLORS[props.variant]
    s['--btn-color'] = c
    s['--btn-border'] = `color-mix(in srgb, ${c} 50%, black)`
  } else if (props.outline) {
    s['--btn-outline'] = VARIANT_COLORS[props.outline]
  }
  return s
})
</script>

<template>
  <button
    class="inline-flex shrink-0 cursor-pointer touch-manipulation items-center gap-1 border font-mono text-xs font-bold [-webkit-tap-highlight-color:transparent] active:opacity-70"
    :class="{
      'text-fg w-9 justify-center px-0 text-base': square,
      'px-3': !square,
      'text-surface border-(--btn-border) bg-(--btn-color)': !!variant,
      'bg-surface border-(--btn-outline) text-(--btn-outline)':
        !!outline && !variant,
      'bg-surface text-dim border-white/20': !variant && !outline
    }"
    :style="btnStyle"
  >
    <slot />
  </button>
</template>
