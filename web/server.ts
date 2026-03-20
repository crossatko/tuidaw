// ============================================================================
// tuidaw Web Server — serves the web UI on port 3666 (HTTPS)
// ============================================================================
// Launched via: bun run index.ts --host
//
// Serves over HTTPS with a self-signed cert so that crossOriginIsolated = true
// on mobile devices over LAN (required for SharedArrayBuffer / WASM pthreads).
// Browser will show a security warning — accept it once.
//
// Required headers for SharedArrayBuffer (WASM pthreads):
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp

import { join, extname } from 'path'
import { tmpdir } from 'os'
import { existsSync } from 'fs'

const PORT = 3666
const CERT_DIR = join(tmpdir(), 'tuidaw-certs')
const WEB_DIR = join(import.meta.dir, '../web')
const WASM_DIR = join(WEB_DIR, 'wasm')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.ts': 'application/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav'
}

// Headers required for SharedArrayBuffer (Emscripten pthreads)
const COOP_COEP_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp'
}

export async function startWebServer() {
  // Generate self-signed TLS cert (needed for crossOriginIsolated on mobile LAN)
  const certFile = join(CERT_DIR, 'cert.pem')
  const keyFile = join(CERT_DIR, 'key.pem')
  if (!existsSync(certFile) || !existsSync(keyFile)) {
    const { mkdirSync } = await import('fs')
    mkdirSync(CERT_DIR, { recursive: true })
    const proc = Bun.spawn(
      [
        'openssl',
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-days',
        '365',
        '-subj',
        '/CN=tuidaw',
        '-addext',
        'subjectAltName=IP:0.0.0.0,IP:127.0.0.1'
      ],
      { stderr: 'pipe' }
    )
    await proc.exited
    if (proc.exitCode !== 0) {
      console.error(
        'Warning: failed to generate TLS cert, falling back to HTTP'
      )
      console.error(
        '  SharedArrayBuffer may not work on mobile devices over LAN'
      )
    }
  }
  const hasTLS = existsSync(certFile) && existsSync(keyFile)

  // Build web/app.ts on the fly using Bun.build (bundles for browser)
  const buildResult = await Bun.build({
    entrypoints: [join(WEB_DIR, 'app.ts')],
    outdir: join(WEB_DIR, 'dist'),
    target: 'browser',
    format: 'esm',
    minify: false,
    sourcemap: 'inline'
  })

  if (!buildResult.success) {
    console.error('Web build failed:')
    for (const log of buildResult.logs) {
      console.error(log)
    }
    process.exit(1)
  }

  const server = Bun.serve({
    port: PORT,
    ...(hasTLS
      ? {
          tls: {
            cert: Bun.file(certFile),
            key: Bun.file(keyFile)
          }
        }
      : {}),
    async fetch(req) {
      const url = new URL(req.url)
      let pathname = url.pathname

      // Route "/" to index.html
      if (pathname === '/') {
        pathname = '/index.html'
      }

      // Serve bundled app.js
      if (pathname === '/app.js') {
        const file = Bun.file(join(WEB_DIR, 'dist', 'app.js'))
        if (await file.exists()) {
          return new Response(file, {
            headers: {
              'Content-Type': 'application/javascript',
              ...COOP_COEP_HEADERS
            }
          })
        }
      }

      // Serve WASM files from web/wasm/
      if (pathname.startsWith('/wasm/')) {
        const file = Bun.file(join(WASM_DIR, pathname.slice(6)))
        if (await file.exists()) {
          const ext = extname(pathname)
          return new Response(file, {
            headers: {
              'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
              ...COOP_COEP_HEADERS
            }
          })
        }
      }

      // Serve static files from web/
      const filePath = join(WEB_DIR, pathname.slice(1))
      const file = Bun.file(filePath)
      if (await file.exists()) {
        const ext = extname(pathname)
        const headers: Record<string, string> = {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          ...COOP_COEP_HEADERS
        }
        // Service worker must not be cached — browsers check for updates
        if (pathname === '/sw.js') {
          headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        }
        return new Response(file, { headers })
      }

      return new Response('Not Found', {
        status: 404,
        headers: COOP_COEP_HEADERS
      })
    }
  })

  const proto = hasTLS ? 'https' : 'http'
  console.log(`tuidaw web UI running at ${proto}://localhost:${server.port}`)

  // Show LAN addresses for mobile access
  const { networkInterfaces } = await import('os')
  const nets = networkInterfaces()
  for (const name in nets) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  LAN: ${proto}://${net.address}:${server.port}`)
      }
    }
  }
  if (hasTLS) {
    console.log(
      `  (accept the self-signed certificate warning in your browser)`
    )
  }
  console.log(`Press Ctrl+C to stop`)
}
