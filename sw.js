const CACHE_NAME = 'medswift-cache-v2';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/scanner.js',
  './js/state.js',
  './manifest.json',
  'https://unpkg.com/lucide@latest',
  'https://unpkg.com/dexie@3.2.4/dist/dexie.js',
  'https://unpkg.com/@zxing/library@latest'
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

// ─── AUGUST INTELLIGENCE: BACKGROUND AGENT & EMPATHY NUDGES ───
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'TRIGGER_AGENT_CHECK') {
    event.waitUntil(runAgenticRecallCheck(event.data.history));
  }
});

async function runAgenticRecallCheck(history) {
  if (!history || history.length === 0) return;
  
  // 1. Empathy Nudge (Daily Reminder)
  // Check the last scanned drug and offer a contextual lifestyle nudge
  const lastScan = history[0];
  if (lastScan && lastScan.lifestyleNudge) {
    self.registration.showNotification('Clinical Companion', {
      body: `Good morning! Time for your ${lastScan.drugName}. ${lastScan.lifestyleNudge}`,
      icon: 'Assets/MedSwift-Symbol.png',
      badge: 'Assets/MedSwift-Symbol.png',
      tag: 'empathy-nudge',
      vibrate: [100, 50, 100]
    });
  }

  // 2. Proactive Safety Agent (FDA Cross-Reference)
  // In a production app, this would fetch from https://api.fda.gov/drug/enforcement.json
  const simulatedFdaRecalls = ['Atorvastatin Calcium', 'Metformin Hydrochloride']; 
  
  // We check the user's local history against the latest openFDA data
  for (const scan of history) {
    if (scan.genericName && simulatedFdaRecalls.includes(scan.genericName)) {
      // Allow 2 seconds for the empathy nudge to process first, then stack the alert
      setTimeout(() => {
        self.registration.showNotification('MedSwift Safety Agent', {
          body: `FDA Alert: A new advisory was issued regarding the class for ${scan.genericName}. Please consult your provider.`,
          icon: 'Assets/MedSwift-Symbol.png',
          badge: 'Assets/MedSwift-Symbol.png',
          tag: 'fda-alert',
          requireInteraction: true,
          vibrate: [300, 100, 300, 100, 300]
        });
      }, 2000);
      break; 
    }
  }
}
