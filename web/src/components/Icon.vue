<script setup vapor lang="ts">
defineProps<{
  /** Raw SVG inner content (path/rect/circle elements) */
  d: string
  size?: number
}>()
</script>

<template>
  <svg
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="shrink-0"
    v-html="d"
  />
</template>
