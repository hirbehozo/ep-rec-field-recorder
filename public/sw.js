const CACHE_NAME = 'ep-rec-shell-v1'
const APP_SHELL = [
  '/',
  '/diagnostics',
  '/manifest.webmanifest',
  '/rec-worklet.js',
  '/writer-worker.js',
  '/icon-192.png',
  '/icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

// Network first so a deployed update is always preferred while online;
// every successful same-origin GET is cached along the way, so a cold
// start with no network still has something to serve.
self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone()
        caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(req, copy))
          .catch(() => {})
        return res
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/'))),
  )
})
