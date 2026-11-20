/* Dedicated service worker for the FMart Admin PWA.
 * Its narrower scope takes precedence over the FMart Wali/root worker.
 * It owns only caches with the admin-fmart-pwa- prefix.
 */
const FMART_ADMIN_CACHE_PREFIX = 'admin-fmart-pwa-';
const FMART_ADMIN_CACHE = FMART_ADMIN_CACHE_PREFIX + 'shell-v2';
const FMART_ADMIN_SHELL = ['./', './index.html', './install.html', './manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(FMART_ADMIN_CACHE)
      .then(cache => Promise.all(FMART_ADMIN_SHELL.map(asset =>
        cache.add(asset).catch(error => {
          console.warn('FMart Admin shell asset could not be cached:', asset, error);
          return null;
        })
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith(FMART_ADMIN_CACHE_PREFIX) && key !== FMART_ADMIN_CACHE)
        .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);
  if (requestUrl.origin !== scopeUrl.origin || !requestUrl.pathname.startsWith(scopeUrl.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (!response || !response.ok) return response;
        return caches.open(FMART_ADMIN_CACHE)
          .then(cache => cache.put(request, response.clone()).catch(error => {
            console.warn('FMart Admin navigation could not be cached:', error);
          }))
          .then(() => response);
      }).catch(() => caches.match(request).then(cached =>
        cached || caches.match(new URL('./index.html', scopeUrl).href)
      ))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (!response || !response.ok) return response;
        return caches.open(FMART_ADMIN_CACHE)
          .then(cache => cache.put(request, response.clone()).catch(error => {
            console.warn('FMart Admin asset could not be cached:', error);
          }))
          .then(() => response);
      });
    })
  );
});
