// ============================================================================
// tuidaw — Terminal DAW powered by OpenTUI + miniaudio
// ============================================================================
// Entry point dispatcher:
//   bun run index.ts          → TUI mode (terminal interface)
//   bun run index.ts --host   → Web UI mode (browser on port 3666)
// ============================================================================

if (Bun.argv.includes('--host')) {
  const { startWebServer } = await import('./web/server')
  await startWebServer()
} else {
  const { default: startTui } = await import('./tui')
  await startTui()
}
