let FMART_ONESIGNAL_SW_READY=false;
try {
  importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
  FMART_ONESIGNAL_SW_READY=true;
} catch (error) {
  // Push notifications may be unavailable temporarily, but the PWA shell must still install.
  console.warn('FMart OneSignal service worker SDK could not be loaded:', error);
}

const FMART_CACHE_PREFIX = 'fmart-';
const CACHE = 'fmart-shell-v16';
const SHELL = ['./', './index.html', './adminFMart16720/', './adminFMart16720/index.html', './adminFMart16720/manifest.webmanifest', './manifest.webmanifest', './config.js', './icons/fmart-180.png', './icons/fmart-192.png', './icons/fmart-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(SHELL.map(asset => cache.add(asset).catch(error => {
        console.warn('FMart shell asset could not be cached:', asset, error);
        return null;
      }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith(FMART_CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    const isAdminRoute = /\/adminFMart16720\/?$/i.test(url.pathname);
    event.respondWith(
      fetch(request).then(response => {
        if (!response || !response.ok) return response;
        return caches.open(CACHE).then(cache => cache.put(request, response.clone()).catch(error => {
          console.warn('FMart navigation response could not be cached:', error);
        })).then(() => response);
      }).catch(() => caches.match(request).then(cached => {
        return cached || caches.match(isAdminRoute ? './adminFMart16720/' : './index.html');
      }))
    );
    return;
  }

  // Konfigurasi deployment harus selalu diperbarui dari jaringan saat online.
  if (/\/config\.js$/i.test(url.pathname)) {
    event.respondWith(
      fetch(request).then(response => {
        if (!response || !response.ok) return response;
        return caches.open(CACHE).then(cache => cache.put(request, response.clone()).catch(error => {
          console.warn('FMart config could not be cached:', error);
        })).then(() => response);
      }).catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first untuk aset yang sudah ada; aset same-origin yang pertama kali diminta
  // juga disimpan setelah berhasil diambil agar kunjungan berikutnya dapat offline.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (!response || !response.ok) return response;
        return caches.open(CACHE).then(cache => cache.put(request, response.clone()).catch(error => {
          console.warn('FMart static asset could not be cached:', error);
        })).then(() => response);
      });
    })
  );
});
