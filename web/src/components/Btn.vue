<script setup vapor lang="ts">
defineProps<{
  /** Active variant color — when set, button gets filled background */
  variant?: 'green' | 'red' | 'purple' | 'cyan' | 'orange' | 'yellow'
  /** Outline-only active state (e.g. loop "setting" state) */
  outline?: 'purple'
  /** Compact square button (BPM +/-) */
  square?: boolean
}>()
</script>

<template>
  <button
    class="border-border bg-surface-highlight text-dim shrink-0 cursor-pointer touch-manipulation rounded border font-mono text-xs font-bold [-webkit-tap-highlight-color:transparent] active:opacity-70"
    :class="[
      square ? 'text-fg w-9 px-0 text-base' : 'px-3',
      variant === 'green' && 'border-accent-green bg-accent-green text-surface',
      variant === 'red' && 'border-accent-red bg-accent-red text-surface',
      variant === 'purple' &&
        'border-accent-purple bg-accent-purple text-surface',
      variant === 'cyan' && 'border-accent-cyan bg-accent-cyan text-surface',
      variant === 'orange' &&
        'border-accent-orange bg-accent-orange text-surface',
      variant === 'yellow' &&
        'border-accent-yellow bg-accent-yellow text-surface',
      outline === 'purple' &&
        !variant &&
        'border-accent-purple text-accent-purple'
    ]"
    style="height: 36px"
  >
    <slot />
  </button>
</template>
