// Service worker de Eintes Robot: permite instalar la app y abrirla sin conexión.
// Los datos de mercado nunca se guardan en caché.
const VERSION = 'eintes-2.5.0';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'chart.js', 'robot.js', 'robot-avatar.jpg', 'binance.js', 'indicators.js', 'tendencia.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== VERSION).map((x) => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return res; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
