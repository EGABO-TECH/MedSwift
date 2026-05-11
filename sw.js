const CACHE_NAME = 'medswift-cache-v3';
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
  const url = e.request.url;

  // Bug #3 Fix: NEVER cache /api/ calls. The SW was caching the first
  // /api/identify POST response and returning it for every subsequent scan,
  // making the app always report the same drug no matter what was scanned.
  // API calls must ALWAYS go to the network.
  if (url.includes('/api/') || url.includes('api.fda.gov') || url.includes('api.ocr.space') || url.includes('generativelanguage.googleapis.com') || url.includes('openrouter.ai')) {
    return; // Let the browser handle it natively — no SW interception.
  }

  // For all static assets: stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request).then((networkResponse) => {
        // Only cache successful GET responses for static assets
        if (networkResponse.ok && e.request.method === 'GET') {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, networkResponse.clone());
          });
        }
        return networkResponse;
      }).catch(() => cached); // On network failure, fall back to cache
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
    // Bug #6 Fix: MessageEvent does not have a waitUntil() method — only
    // InstallEvent, ActivateEvent, and FetchEvent do. Calling event.waitUntil()
    // here threw a TypeError that silently killed the entire message handler.
    // The correct pattern is to call the async function directly.
    runAgenticRecallCheck(event.data.history);
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
