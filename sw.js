const CACHE = 'vice-city-files-v5';
const ASSETS = ['./', './index.html', './style.css', './app.js', './ai-worker.js', './manifest.webmanifest', './sw.js'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith('vice-city-files-') && key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then(response => response || fetch(event.request).catch(() => caches.match('./index.html'))));
});
