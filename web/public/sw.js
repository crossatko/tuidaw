// tuidaw Service Worker — offline PWA support
// Cache version: bump this to force update on all clients
const CACHE_VERSION = 'v4'
const CACHE_NAME = `tuidaw-${CACHE_VERSION}`

// Assets to pre-cache on install for offline use
const PRECACHE_URLS = [
  '/',
  '/index.html',
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

// Fetch: network-first with cache fallback
// Always serve fresh content when online — cache is only for offline use
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Only handle same-origin GET requests
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return
  }

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Update cache with fresh response
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone()
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache)
          })
        }
        return networkResponse
      })
      .catch(() => {
        // Network failed — fall back to cache (offline mode)
        return caches.match(event.request)
      })
  )
})
