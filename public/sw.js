/**
 * Keeps the site usable when the connection is not.
 *
 * Map tiles and case files that have already been fetched are kept, so a demonstration carries on
 * over a dropped link: whatever has been looked at once stays available. Nothing is pre-downloaded,
 * and API calls are never cached — the record always comes from the server.
 */
const TILES = 'oceanspill-tiles-v1';
const DATA = 'oceanspill-data-v1';
const APP = 'oceanspill-app-v1';
const KEEP = [TILES, DATA, APP];

// Roughly a week of map browsing at the sizes this app uses.
const TILE_LIMIT = 3000;
const DATA_LIMIT = 200;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('oceanspill-') && !KEEP.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

/** Oldest entries go first once a cache passes its limit. */
async function trim(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - limit; i++) await cache.delete(keys[i]);
}

async function cacheFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    void trim(cacheName, limit);
  }
  return response;
}

async function networkFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      void trim(cacheName, limit);
    }
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Anything the server decides — sign-in, state, documents — must not come from a cache.
  if (url.pathname.startsWith('/api/')) return;

  // Basemap tiles: cheap to keep, and the map is the first thing to break offline.
  if (/arcgisonline\.com|openmaptiles\.org/.test(url.hostname)) {
    event.respondWith(cacheFirst(request, TILES, TILE_LIMIT));
    return;
  }

  // Case artifacts: a rebuilt file should win, so try the network first.
  if (url.origin === self.location.origin && url.pathname.startsWith('/data/')) {
    event.respondWith(networkFirst(request, DATA, DATA_LIMIT));
    return;
  }

  // The app itself, so a reload works without a connection.
  if (url.origin === self.location.origin && (request.mode === 'navigate' || /\.(js|css|woff2?)$/.test(url.pathname))) {
    event.respondWith(networkFirst(request, APP, 60));
  }
});
