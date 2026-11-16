const CACHE = 'fmart-shell-v6';
const SHELL = ['./', './index.html', './adminFMart16720/', './adminFMart16720/index.html', './adminFMart16720/manifest.webmanifest', './manifest.webmanifest', './config.js', './icons/fmart-180.png', './icons/fmart-192.png', './icons/fmart-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => {
      const isAdminRoute = /\/adminFMart16720\/?$/i.test(url.pathname);
      return caches.match(request).then(cached => cached || caches.match(isAdminRoute ? './adminFMart16720/' : './index.html'));
    }));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
