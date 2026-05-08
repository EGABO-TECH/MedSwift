const CACHE_NAME = 'medswift-cache-v1';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/fda.js',
  './js/map.js',
  './js/scanner.js',
  './js/state.js',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest',
  'https://unpkg.com/dexie@3.2.4/dist/dexie.js',
  'https://unpkg.com/@zxing/library@latest',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Stale-while-revalidate strategy
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request).then((networkResponse) => {
        // Don't cache API calls in SW (handled by Dexie fdaCache)
        if (e.request.url.includes('api.fda.gov')) return networkResponse;
        
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, networkResponse.clone());
        });
        return networkResponse;
      }).catch(() => {});
      return cached || fetchPromise;
    })
  );
});

self.addEventListener('sync', (e) => {
  if (e.tag === 'medswift-sync') {
    e.waitUntil(syncPendingData());
  }
});

async function syncPendingData() {
  // Logic to process syncQueue from IndexedDB when online
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'SYNC_COMPLETE' }));
}
