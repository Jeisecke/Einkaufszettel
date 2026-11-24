/* Einkaufszettel – Service Worker
 * App-Shell: stale-while-revalidate (sofort aus dem Cache, im Hintergrund aktualisieren)
 * API (api.php): nie cachen – die App hält die Daten selbst offline vor (localStorage + Warteschlange).
 * Bei Änderungen an den Dateien VERSION erhöhen.
 */
const VERSION = 'ekz-v5.0.3';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './img/icon.svg',
  './img/favicon-32.png',
  './img/icon-192.png',
  './img/icon-512.png',
  './img/icon-maskable-192.png',
  './img/icon-maskable-512.png',
  './img/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/api.php')) return; // Netzwerk direkt

  // Navigationen (Start der App) -> immer die gecachte index.html als Basis
  if (req.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(event, new Request('./index.html'), req));
    return;
  }
  event.respondWith(staleWhileRevalidate(event, req, req));
});

async function staleWhileRevalidate(event, cacheKey, networkReq) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(cacheKey, { ignoreSearch: true });

  const network = fetch(networkReq)
    .then((res) => {
      if (res && res.ok && res.type === 'basic') {
        cache.put(cacheKey, res.clone());
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const res = await network;
  if (res) return res;
  return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
