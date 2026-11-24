/* global app */
const prefix = 'anonymo-app-shell-';
const cacheName = prefix + app.version;

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) =>
      name.startsWith(prefix) && (!app.enabled || name !== cacheName),
    ).map((name) => caches.delete(name)));
    if (app.enabled) await self.clients.claim();
    else await self.registration.unregister();
  })());
});

// Only the production build's fingerprinted scripts, styles and fonts belong in this cache.
const staticAssets = {
  script: [/^\/_next\/static\/chunks\/[\w-]+-[\w-]{8,}\.js$/, /^(?:text|application)\/(?:javascript|ecmascript)\b/i],
  style: [/^\/_next\/static\/css\/[\w.-]+\.[\w-]{8}\.css$/, /^text\/css\b/i],
  font: [/^\/_next\/static\/media\/[\w.-]+\.[\w-]{8}\.woff2$/, /^font\/woff2\b/i],
};

if (app.enabled) self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search || request.headers.has('Authorization')) return;

  // Chat HTML always comes from the network. The offline page ships inside the worker.
  if (request.mode === 'navigate' && url.pathname === app.start) {
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => new Response(app.offline, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    })));
    return;
  }

  const asset = staticAssets[request.destination];
  if (!asset?.[0].test(url.pathname) || request.headers.has('Range')) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName).catch(() => null);
    const hit = await cache?.match(request).catch(() => null);
    if (hit) return hit;

    const response = await fetch(request, { credentials: 'omit', redirect: 'error' });
    if (cache && response.status === 200 && asset[1].test(response.headers.get('Content-Type') ?? '') &&
        !/\b(?:private|no-store)\b/i.test(response.headers.get('Cache-Control') ?? '')) {
      event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
    }
    return response;
  })());
});
