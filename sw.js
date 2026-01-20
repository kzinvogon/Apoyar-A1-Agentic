// ServiFlow Service Worker - DISABLED
// This service worker clears all caches and does nothing else

// On install, skip waiting and activate immediately
self.addEventListener('install', (event) => {
  console.log('[ServiceWorker] Install - clearing caches and disabling');
  self.skipWaiting();
});

// On activate, clear all caches and claim all clients
self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activate - clearing ALL caches');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          console.log('[ServiceWorker] Deleting cache:', cacheName);
          return caches.delete(cacheName);
        })
      );
    }).then(() => {
      console.log('[ServiceWorker] All caches cleared, claiming clients');
      return self.clients.claim();
    })
  );
});

// On fetch, ALWAYS go to network - no caching
self.addEventListener('fetch', (event) => {
  // Let all requests pass through to network normally
  // Do not intercept or cache anything
});
