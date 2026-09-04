/**
 * sw.js — BazarHub
 * Service Worker: cachea la app (HTML/CSS/JS + librerías externas) para que
 * la interfaz siga funcionando sin conexión a internet.
 *
 * Los DATOS (ventas, retiros, caja, etc.) ya tienen su propia lógica offline
 * en firebase.js (cola local + Firestore persistence) — este archivo solo se
 * encarga de que la app en sí (los archivos) cargue sin wifi.
 *
 * IMPORTANTE al desplegar un cambio: si se bumpea el "?v=N" de algún .js en
 * index.html, conviene también bumpear CACHE_VERSION acá abajo para forzar
 * a los usuarios a bajar la versión nueva (si no, igual la reciben apenas
 * haya conexión gracias a la estrategia network-first/stale-while-revalidate,
 * pero bumpear la versión asegura una limpieza total de la caché vieja).
 */

const CACHE_VERSION = 'bazarhub-shell-v8';

// Archivos propios del sitio (mismo origen) + librerías externas, con las
// mismas versiones/URLs exactas que usa index.html hoy.
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './config.js?v=5',
  './firebase.js?v=12',
  './app.js?v=8',
  './caja.js?v=12',
  './stock.js?v=6',
  './dashboard.js?v=6',
  './importar.js?v=5',
  './gastos.js?v=2',
];

// Recursos externos (CDN). Se cachean "mejor esfuerzo": si alguno no se
// puede bajar (por red bloqueada, CORS, etc.) no debe romper la instalación
// del resto.
const EXTERNAL_ASSETS = [
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&family=DM+Mono:wght@400;500&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/JsBarcode/3.11.5/JsBarcode.all.min.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      const same = Promise.all(
        CORE_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] No se pudo cachear', url, err))
        )
      );
      const ext = Promise.all(
        EXTERNAL_ASSETS.map(url =>
          cache.add(new Request(url, { mode: 'no-cors' })).catch(err =>
            console.warn('[SW] No se pudo cachear (externo)', url, err)
          )
        )
      );
      return Promise.all([same, ext]);
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // No interceptar llamadas a Firebase/Firestore/Auth: esas ya tienen su
  // propia lógica de offline (SDK de Firestore + cola manual en firebase.js).
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('identitytoolkit')
  ) {
    return;
  }

  // Navegación (carga de la página principal): red primero, y si falla,
  // servir el index.html cacheado para que la app siempre pueda abrir.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const resClone = res.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put('./index.html', resClone));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Resto de los archivos propios y externos: stale-while-revalidate.
  // Se sirve lo cacheado al instante si existe (ignorando query strings,
  // como el "?v=N" de cache-busting) y en paralelo se actualiza la caché
  // en segundo plano para la próxima vez.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cached => {
      const fetchAndCache = fetch(req)
        .then(res => {
          if (res && (res.ok || res.type === 'opaque')) {
            const resClone = res.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => null);

      if (cached) {
        // No bloquear la respuesta esperando la actualización en segundo plano.
        fetchAndCache;
        return cached;
      }
      return fetchAndCache.then(res => res || Response.error());
    })
  );
});
