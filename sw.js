/* Alya's Reader service worker: offline app shell + runtime cache.
   Replace 202611130021-13b8353 at deploy time so old caches are cleaned up. */

const CACHE = 'alya-202611130021-13b8353';
const SHELL = ['./', './index.html', './css/app.css', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL).catch(() => {});
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

function cachePut(request, response) {
  if (response && response.ok) {
    caches.open(CACHE).then(cache => cache.put(request, response)).catch(() => {});
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        cachePut(request, response.clone());
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        const shell = await caches.match('./index.html');
        if (shell) return shell;
        throw new Error('offline');
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      cachePut(request, response.clone());
      return response;
    } catch {
      return cached || Response.error();
    }
  })());
});
