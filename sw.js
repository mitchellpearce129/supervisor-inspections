/* ============================================================================
 * sw.js — minimal offline shell cache.
 * Caches the app shell so the UI loads with no connectivity. It deliberately
 * NEVER caches ClickHome API responses — those must always be live.
 * ==========================================================================*/
var CACHE = 'supervisor-inspections-v8';
var SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/config.js',
  './js/store.js',
  './js/docgen.js',
  './js/pdfgen.js',
  './js/api.js',
  './js/app.js',
  './manifest.json',
  './icons/icon.svg',
  './assets/logo-hg.png',
  './assets/logo-bph.jpg',
  './data/pci-seed.json',
  './data/house-plans.json'
];

// ClickHome API hosts — never cache-serve these; they must always be live.
var API_HOSTS = ['clickhome.homegroup.com.au', 'chvic.homegroup.com.au', 'clickhome.blueprinthomes.com.au'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  // Never intercept API traffic — always go to network.
  if (API_HOSTS.indexOf(url.hostname) !== -1) return;
  if (e.request.method !== 'GET') return;

  // App shell: cache-first, fall back to network.
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        return res;
      }).catch(function () { return caches.match('./index.html'); });
    })
  );
});
