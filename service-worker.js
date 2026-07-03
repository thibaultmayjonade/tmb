const CACHE = 'tmb-golgothes-2026-v13-ux';
const CORE = ['./','index.html','style.css','script.js','data.js','manifest.webmanifest','icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(resp => {
      if (resp && resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy)).catch(()=>{});
      }
      return resp;
    }).catch(() => cached))
  );
});
