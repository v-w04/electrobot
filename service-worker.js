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

const CACHE_VERSION = 'v30';
const CACHE_NAME = 'bot-em-' + CACHE_VERSION;

// Font Awesome (CDN) — se precachea para que los íconos no se rompan
const FA_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css';

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
  './favicon-32.png',
  FA_CSS
];

// ── INSTALL: precachear assets ─────────────────────────────────
self.addEventListener('install', event => {
  const locales = PRECACHE_URLS.filter(u => u !== FA_CSS);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache =>
        // Locales: críticos (deben cachear). FA: best-effort (no aborta si falla).
        cache.addAll(locales).then(() =>
          cache.add(new Request(FA_CSS, { mode: 'cors', credentials: 'omit' })).catch(() => {})
        )
      )
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

  // Recursos de terceros (otro dominio):
  //   - Font Awesome desde cdnjs → cache-first (para que los íconos NUNCA
  //     se rompan, ni con red lenta ni offline).
  //   - Cualquier otro (ej. el Worker del bot) → directo a la red, sin cache.
  if (url.origin !== self.location.origin) {
    if (url.hostname === 'cdnjs.cloudflare.com') {
      event.respondWith(
        caches.match(req).then(cached => {
          if (cached) return cached;
          return fetch(req).then(res => {
            if (res && (res.status === 200 || res.type === 'opaque')) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then(c => c.put(req, copy));
            }
            return res;
          });
        })
      );
    }
    return;
  }

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
