/**
 * sw.js — BazarHub
 * Service Worker: cachea la app (HTML/CSS/JS + librerías externas) para que
 * la interfaz siga funcionando sin conexión a internet.
 *
 * Los DATOS (ventas, retiros, caja, etc.) ya tienen su propia lógica offline
 * en firebase.js (cola local + Firestore persistence) — este archivo solo se
 * encarga de que la app en sí (los archivos) cargue sin wifi.
 *
 * A PROPÓSITO la app NUNCA se actualiza sola en una pestaña que ya está
 * abierta: no hay skipWaiting() ni clients.claim() (ver abajo), así que un
 * Service Worker nuevo se queda esperando sin interrumpir a nadie. La
 * próxima vez que esa pestaña se cierre y se abra de nuevo, ahí sí toma la
 * versión más reciente (index.html siempre se pide a la red primero).
 *
 * IMPORTANTE al desplegar un cambio: si se bumpea el "?v=N" de algún .js en
 * index.html, conviene también bumpear CACHE_VERSION acá abajo, para que
 * cuando alguien cierre y vuelva a abrir la app reciba todos los archivos
 * nuevos de una sola vez en vez de ir goteando de a uno.
 */

const CACHE_VERSION = 'bazarhub-shell-v37';

// Archivos propios del sitio (mismo origen) + librerías externas, con las
// mismas versiones/URLs exactas que usa index.html hoy.
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './config.js?v=5',
  './firebase.js?v=34',
  './app.js?v=13',
  './caja.js?v=16',
  './stock.js?v=8',
  './dashboard.js?v=10',
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
  // A propósito NO se llama a self.skipWaiting() acá: así, un Service
  // Worker nuevo se queda "esperando" y no reemplaza al que ya está
  // corriendo en una pestaña abierta -recién pasa a controlarla la
  // próxima vez que esa pestaña se cierre y se vuelva a abrir sola. Esto es
  // intencional: la app nunca se actualiza sola en medio de una venta.
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
  // Tampoco se llama a self.clients.claim() acá, por la misma razón: no
  // queremos que este Service Worker tome control de pestañas que ya
  // estaban abiertas con la versión anterior.
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
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

  // Archivos propios (mismo origen, con "?v=N" de cache-busting): acá SE
  // RESPETA el query string (nada de ignoreSearch) a propósito. Si no fuera
  // así, una pestaña que todavía tiene activo el Service Worker viejo (ver
  // arriba -nunca se lo fuerza a tomar el control-) podía seguir sirviendo
  // "firebase.js?v=17" con el contenido cacheado de "firebase.js?v=16": con
  // ignoreSearch los trataba como "el mismo archivo" y listo, aunque
  // index.html ya pedía la versión nueva. Respetando el query string, un
  // cambio de versión siempre se nota como un archivo nuevo (cache-miss) y
  // se pide a la red apenas se abre una pestaña nueva, sin importar si el
  // Service Worker viejo todavía no terminó de jubilarse.
  //
  // Recursos externos (CDN) siguen con ignoreSearch: no tienen este
  // esquema de versionado propio.
  const sameOrigin = url.origin === self.location.origin;

  event.respondWith(
    caches.match(req, { ignoreSearch: !sameOrigin }).then(cached => {
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
