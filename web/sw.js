// tuidaw Service Worker — offline PWA support
// Cache version: bump this to force update on all clients
const CACHE_VERSION = 'v2'
const CACHE_NAME = `tuidaw-${CACHE_VERSION}`

// Assets to pre-cache on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/app.js',
  '/wasm/tuidaw_audio.js',
  '/wasm/tuidaw_audio.wasm',
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg',
  '/fonts/ibm-plex-mono-400-latin.woff2',
  '/fonts/ibm-plex-mono-400-latin-ext.woff2',
  '/fonts/ibm-plex-mono-700-latin.woff2',
  '/fonts/ibm-plex-mono-700-latin-ext.woff2',
  '/fonts/ibm-plex-mono-400i-latin.woff2',
  '/fonts/ibm-plex-mono-400i-latin-ext.woff2'
]

// Install: pre-cache all app assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(PRECACHE_URLS)
      })
      .then(() => {
        // Activate immediately — don't wait for old tabs to close
        return self.skipWaiting()
      })
  )
})

// Activate: delete old caches, claim all clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        return Promise.all(
          keys
            .filter((key) => key.startsWith('tuidaw-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      })
      .then(() => {
        // Take control of all open tabs immediately
        return self.clients.claim()
      })
  )
})

// Fetch: cache-first with network fallback + background update
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Only handle same-origin GET requests
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Return cached response immediately, but also fetch fresh copy in background
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          // Update cache with fresh response (if valid)
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone()
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache)
            })
          }
          return networkResponse
        })
        .catch(() => {
          // Network failed — cached response was already returned (or will 404)
          return cached
        })

      // If we have a cached version, return it immediately (stale-while-revalidate)
      // If not, wait for network
      return cached || fetchPromise
    })
  )
})
