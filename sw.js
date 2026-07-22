// sw.js — service worker: caches the app shell so REWMitch installs as a PWA
// and runs offline. Bump CACHE when you change any app file (forces a refresh).
const CACHE = 'rewmitch-v10';
const ASSETS = [
  './', './index.html', './styles.css',
  './app.js', './audio.js', './cal.js', './dsp.js',
  './export.js', './fft.js', './plot.js',
  './session.js', './safety.js', './glossary.js', './svg.js', './wizard.js',
  './manifest.json', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache-first for our own GET assets; fall back to network for anything else.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
