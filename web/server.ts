// ============================================================================
// tuidaw Web Server — serves the web UI on port 3666
// ============================================================================
// Launched via: bun run index.ts --host
//
// Required headers for SharedArrayBuffer (WASM pthreads):
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp

import { join, extname } from "path"

const PORT = 3666
const WEB_DIR = join(import.meta.dir, "../web")
const WASM_DIR = join(WEB_DIR, "wasm")

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".ts": "application/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
}

// Headers required for SharedArrayBuffer (Emscripten pthreads)
const COOP_COEP_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
}

export async function startWebServer() {
  // Build web/app.ts on the fly using Bun.build (bundles for browser)
  const buildResult = await Bun.build({
    entrypoints: [join(WEB_DIR, "app.ts")],
    outdir: join(WEB_DIR, "dist"),
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "inline",
  })

  if (!buildResult.success) {
    console.error("Web build failed:")
    for (const log of buildResult.logs) {
      console.error(log)
    }
    process.exit(1)
  }

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url)
      let pathname = url.pathname

      // Route "/" to index.html
      if (pathname === "/") {
        pathname = "/index.html"
      }

      // Serve bundled app.js
      if (pathname === "/app.js") {
        const file = Bun.file(join(WEB_DIR, "dist", "app.js"))
        if (await file.exists()) {
          return new Response(file, {
            headers: {
              "Content-Type": "application/javascript",
              ...COOP_COEP_HEADERS,
            },
          })
        }
      }

      // Serve WASM files from web/wasm/
      if (pathname.startsWith("/wasm/")) {
        const file = Bun.file(join(WASM_DIR, pathname.slice(6)))
        if (await file.exists()) {
          const ext = extname(pathname)
          return new Response(file, {
            headers: {
              "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
              ...COOP_COEP_HEADERS,
            },
          })
        }
      }

      // Serve static files from web/
      const filePath = join(WEB_DIR, pathname.slice(1))
      const file = Bun.file(filePath)
      if (await file.exists()) {
        const ext = extname(pathname)
        return new Response(file, {
          headers: {
            "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
            ...COOP_COEP_HEADERS,
          },
        })
      }

      return new Response("Not Found", {
        status: 404,
        headers: COOP_COEP_HEADERS,
      })
    },
  })

  console.log(`tuidaw web UI running at http://localhost:${server.port}`)
  console.log(`Press Ctrl+C to stop`)
}
