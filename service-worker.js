/**
 * Service Worker — Bot Electronics México
 *
 * Estrategia simple:
 *   - Cache de los assets estáticos (HTML, iconos, manifest) → app instalable y
 *     abre instantáneo aunque no haya internet.
 *   - Llamadas a /api/query (al Worker de Cloudflare) NUNCA se cachean → cada
 *     pregunta al bot debe ir directo a la red para traer datos frescos.
 *
 * Cuando subas una versión nueva del index.html, sube el número de CACHE_VERSION
 * para que los navegadores actualicen automáticamente.
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME = 'bot-em-' + CACHE_VERSION;

// Assets que se precachean al instalar
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './favicon-32.png'
];

// ── INSTALL: precachear assets ─────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()) // activa inmediatamente sin esperar
  );
});

// ── ACTIVATE: borrar caches viejos ──────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: estrategia network-first para HTML, cache-first para assets ──
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo manejamos GET — todo lo demás (POST al Worker) pasa directo
  if (req.method !== 'GET') return;

  // Llamadas al Worker (otro dominio) → siempre red, nunca cache
  if (url.origin !== self.location.origin) return;

  // Navegaciones HTML → network-first (para que cambios se vean al recargar
  // con conexión, pero ofrecer cache si está offline)
  if (req.mode === 'navigate' || (req.destination === 'document')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          // Guardar copia fresca en cache
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match('./index.html') || caches.match('./'))
    );
    return;
  }

  // Assets estáticos (iconos, manifest) → cache-first
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        // Cachear si la respuesta es válida
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy));
        }
        return res;
      });
    })
  );
});

// ── MENSAJES desde el cliente ──────────────────────────────────
// Permite que index.html fuerce activación de una versión nueva
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
