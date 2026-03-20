<script setup lang="ts"></script>

<template>
  <div class="flex h-screen flex-col bg-black font-mono text-white">
    <!-- TopBar placeholder -->
    <header
      class="flex h-14 shrink-0 items-center border-b border-neutral-800 px-4"
    >
      <span class="text-lg font-bold tracking-wide">tuidaw</span>
    </header>

    <!-- Main content area -->
    <div class="flex min-h-0 flex-1">
      <!-- Sidebar placeholder -->
      <aside class="w-65 shrink-0 overflow-y-auto border-r border-neutral-800">
        <div class="p-3 text-sm text-neutral-500">Tracks will go here</div>
      </aside>

      <!-- Waveform / timeline area placeholder -->
      <main class="flex min-w-0 flex-1 items-center justify-center">
        <span class="text-neutral-600">Waveform canvas will go here</span>
      </main>
    </div>

    <!-- StatusBar placeholder -->
    <footer
      class="flex h-9 shrink-0 items-center border-t border-neutral-800 px-4 text-xs text-neutral-500"
    >
      tuidaw — Vue migration in progress
    </footer>
  </div>
</template>
