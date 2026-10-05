/**
 * firebase.js — BazarHub
 * Con soporte offline + autenticación anónima (Firestore protegido)
 */

let db   = null;
let auth = null;

// ===== COLA OFFLINE =====
const OFFLINE_QUEUE_KEY = 'bazarhub_offline_queue';
const OFFLINE_DATA_KEY  = 'bazarhub_offline_data';

function getOfflineQueue() {
  try { return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function saveOfflineQueue(queue) {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
}

function addToOfflineQueue(operation) {
  const queue = getOfflineQueue();
  queue.push({ ...operation, ts: Date.now() });
  saveOfflineQueue(queue);
  updateConnBadge();
}

// Ejecuta una promesa con un límite de tiempo: si no termina dentro de "ms"
// se rechaza, para no dejar la app colgada para siempre esperando algo que
// nunca va a resolver (ver initFirebase/_ensureAuth/loadUsersFromFirebase).
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms)),
  ]);
}

// Borra, una única vez por dispositivo, cualquier caché vieja de Firestore
// en IndexedDB que haya quedado de versiones anteriores de la app (cuando
// se usaba db.enablePersistence). Esa caché podía corromperse con el uso
// -sobre todo en Safari/iOS en modo "app" desde el ícono de pantalla de
// inicio- y una vez corrompida TODAS las lecturas a Firestore se quedaban
// colgadas para siempre sin ningún error, lo que impedía iniciar sesión
// hasta entrar en modo privado (que arranca con un IndexedDB limpio).
function _cleanupOldFirestoreCache() {
  try {
    if (localStorage.getItem('bazarhub_idb_cleaned_v1')) return;
    localStorage.setItem('bazarhub_idb_cleaned_v1', '1');
    if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
      indexedDB.databases().then(dbs => {
        dbs.forEach(d => {
          if (d.name && d.name.indexOf('firestore/') === 0) {
            indexedDB.deleteDatabase(d.name);
          }
        });
      }).catch(() => {});
    }
  } catch (e) {}
}

// Copia de respaldo en localStorage para poder seguir trabajando sin
// internet. El navegador da ~5 MB para esto y la base completa ya pesa más
// (solo los movimientos son ~3 MB): desde el 25/9 la copia completa no
// entraba, el guardado fallaba en silencio y quedaba una copia vieja que la
// app mostraba cuando no lograba conectarse (la caja de Dani del 25/9).
// Ahora se guarda solo lo necesario para trabajar sin conexión: productos,
// cajas, usuarios, etc. y las ventas recientes (no todo el historial ni los
// movimientos, que igual están en Firebase y en la copia de IndexedDB).
const _LOCAL_VENTAS_DIAS = 3;

function _ventasParaCopiaLocal() {
  const desde = Date.now() - _LOCAL_VENTAS_DIAS * 24 * 60 * 60 * 1000;
  const cajaId = store.cajaAbierta ? store.cajaAbierta.id : null;
  return (store.sales || []).filter(s => (s.ts && s.ts >= desde) || (cajaId && s.cajaId === cajaId));
}

function saveLocalData() {
  try {
    const snapshot = {
      products:     store.products,
      proveedores:  store.proveedores,
      sales:        _ventasParaCopiaLocal(),
      cajaHistory:  store.cajaHistory,
      retiros:      store.retiros,
      movimientos:  [],
      ctacteMovs:   store.ctacteMovs,
      orders:       store.orders,
      combos:       store.combos,
      devoluciones: store.devoluciones || [],
      users:        store.users.map(u => ({ ...u, pass: undefined })),
      nextProdId:    store.nextProdId,
      nextProvId:    store.nextProvId,
      nextOCId:      store.nextOCId,
      nextUserId:    store.nextUserId,
      nextCCId:      store.nextCCId,
      nextRetiroId:  store.nextRetiroId,
      saldoAnterior: store.saldoAnterior,
      cajaAbierta:   store.cajaAbierta,
      savedAt:       Date.now(),
    };
    localStorage.setItem(OFFLINE_DATA_KEY, JSON.stringify(snapshot));
  } catch(e) {
    console.warn('No se pudo guardar datos locales:', e);
    // Mejor no tener copia que tener una vieja: si no se pudo actualizar, se
    // borra la anterior para que la app nunca muestre datos de otro día.
    try { localStorage.removeItem(OFFLINE_DATA_KEY); } catch (e2) {}
  }
}

function loadLocalData() {
  try {
    const raw = localStorage.getItem(OFFLINE_DATA_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    // Una copia de hace más de 2 días ya no sirve para vender (caja, stock
    // y precios pueden haber cambiado): mejor avisar que no hay conexión.
    if (Date.now() - s.savedAt > 2 * 24 * 60 * 60 * 1000) return false;
    store.products     = s.products     || [];
    store.proveedores  = s.proveedores  || [];
    store.sales        = s.sales        || [];
    store.cajaHistory  = (s.cajaHistory || []).map(c => ({
      ...c,
      cajeroNombre: c.cajeroNombre || '—',
      inicio:       c.inicio       || '—',
    }));
    store.retiros      = s.retiros      || [];
    store.movimientos  = s.movimientos  || [];
    store.ctacteMovs   = s.ctacteMovs   || [];
    store.orders       = s.orders       || [];
    store.combos       = s.combos       || [];
    store.devoluciones = s.devoluciones || [];
    store.users        = s.users        || [];
    store.nextProdId    = s.nextProdId   || 8;
    store.nextProvId    = s.nextProvId   || 5;
    store.nextOCId      = s.nextOCId     || 1;
    store.nextUserId    = s.nextUserId   || 10;
    store.nextCCId      = s.nextCCId     || 1;
    store.nextRetiroId  = s.nextRetiroId || 1;
    store.saldoAnterior = s.saldoAnterior || 0;
    store.cajaAbierta   = s.cajaAbierta   || null;
    if (store.cajaAbierta) {
      store.cajaAbierta.cajeroNombre = store.cajaAbierta.cajeroNombre || '—';
      store.cajaAbierta.inicio       = store.cajaAbierta.inicio       || '—';
    }
    return true;
  } catch(e) {
    console.warn('Error cargando datos locales:', e);
    return false;
  }
}

// ===== BADGE DE CONEXIÓN =====

function updateConnBadge() {
  const badge = document.getElementById('conn-badge');
  if (!badge) return;
  const queue  = getOfflineQueue();
  const online = navigator.onLine;
  badge.onclick = abrirDiagnosticoConexion;
  badge.style.cursor = 'pointer';
  if (online && typeof store !== 'undefined' && store._offlineFallbackShown) {
    // Hay internet pero no se pudo cargar de Firebase: se están mostrando
    // datos guardados en este dispositivo. Antes el cartel decía "Online"
    // igual, y eso confundía (parecía que los datos eran los de ahora).
    badge.className = 'conn-badge offline';
    badge.innerHTML = '⚠ Datos guardados' + (queue.length ? ` · ${queue.length} pendiente${queue.length > 1 ? 's' : ''}` : '');
    badge.title = 'No se pudo cargar de Firebase: se muestran datos guardados en este dispositivo. Tocá para ver qué pasó y repararlo.';
    return;
  }
  if (!online) {
    badge.className = 'conn-badge offline';
    badge.innerHTML = '● Sin WiFi' + (queue.length ? ` · ${queue.length} pendiente${queue.length > 1 ? 's' : ''}` : '');
    badge.title = 'Sin conexión. Las ventas se guardan localmente.';
  } else if (queue.length > 0) {
    badge.className = 'conn-badge syncing';
    badge.innerHTML = '↑ Sincronizando...';
    badge.title = `Sincronizando ${queue.length} operación(es)`;
  } else {
    badge.className = 'conn-badge online';
    badge.innerHTML = '● Online';
    badge.title = 'Conectado a Firebase';
  }
}

// ===== SINCRONIZACIÓN AUTOMÁTICA =====

// Si una operación en cola para guardar una venta ('sales') apunta a un
// N° que mientras tanto ya fue usado por OTRA venta -por ejemplo, esta
// quedó en la cola porque falló la conexión justo al cobrar, y en el
// medio otro dispositivo ya usó ese mismo número-, sincronizarla tal cual
// pisaría (borraría sin dejar rastro) la venta ajena: el mismo problema de
// fondo que llevó a hacer el guardado de ventas a prueba de colisiones
// más arriba (ver saveSale). Acá se hace el mismo chequeo antes de
// escribir, para esta otra puerta de entrada a Firebase.
async function _resolverColisionVentaEnCola(item) {
  if (item.col !== 'sales') return item;
  const ref = db.collection('sales').doc(String(item.id));
  const snap = await withTimeout(ref.get(), 8000, 'chequear venta en cola');
  if (!snap.exists) return item;
  const existente = snap.data();
  // Si el documento que ya está en Firebase es la MISMA venta (coincide
  // fecha/hora y cajero), no es una colisión real: es un reintento de una
  // sincronización anterior que se cortó a mitad de camino, y está bien
  // volver a escribirla igual.
  if (existente && existente.ts === item.data.ts && existente.userName === item.data.userName) {
    return item;
  }
  const nuevoId = await getNextSaleId();
  return { ...item, id: nuevoId, data: { ...item.data, id: nuevoId } };
}

async function syncOfflineQueue() {
  const queue = getOfflineQueue();
  if (!queue.length || !navigator.onLine || !db) return;
  updateConnBadge();
  const failed = [];
  for (const op of queue) {
    try {
      if (op.type === 'set') {
        const item = await _resolverColisionVentaEnCola(op);
        await withTimeout(db.collection(item.col).doc(String(item.id)).set(item.data), 10000, 'sincronizar ' + item.col);
      } else if (op.type === 'delete') {
        await withTimeout(db.collection(op.col).doc(String(op.id)).delete(), 10000, 'sincronizar ' + op.col);
      } else if (op.type === 'batch') {
        const items = [];
        for (const item of op.items) {
          items.push(item.type === 'set' ? await _resolverColisionVentaEnCola(item) : item);
        }
        const batch = db.batch();
        for (const item of items) {
          if (item.type === 'set')
            batch.set(db.collection(item.col).doc(String(item.id)), item.data);
          else if (item.type === 'delete')
            batch.delete(db.collection(item.col).doc(String(item.id)));
        }
        await withTimeout(batch.commit(), 10000, 'sincronizar cambios pendientes');
      }
    } catch(e) {
      console.error('Sync error:', op, e);
      failed.push(op);
    }
  }
  saveOfflineQueue(failed);
  updateConnBadge();
  if (failed.length === 0 && queue.length > 0) {
    toast('✓ Sincronizado con Firebase', 'ok');
    saveLocalData();
  } else if (failed.length > 0) {
    toast(`${failed.length} operación(es) pendiente(s)`, 'warn');
  }
}

window.addEventListener('online',  () => { updateConnBadge(); syncOfflineQueue(); });
window.addEventListener('offline', () => { updateConnBadge(); });

// ===== FIREBASE INIT + AUTH ANÓNIMA =====

function initFirebase() {
  if (typeof firebase === 'undefined' || !firebase.initializeApp || !firebase.firestore || !firebase.auth) {
    // Falta el SDK (o parte): pasa si el celular no logró bajar alguno de los
    // 3 archivos de Google al abrir. waitForFirebase intenta bajarlos de nuevo.
    console.error('Firebase SDK no cargado (completo)');
    return false;
  }
  if (db) return true;
  const config = window.FIREBASE_CONFIG;
  if (!config) {
    console.error('window.FIREBASE_CONFIG no definido.');
    return false;
  }
  if (!firebase.apps.length) {
    firebase.initializeApp(config);
  }
  _instalarSellos();
  _instalarContador();
  db   = firebase.firestore();
  auth = firebase.auth();
  _diagAuthIniciar();

  // Nota: acá antes se activaba db.enablePersistence(), pero se sacó
  // porque su caché en IndexedDB se podía corromper con el uso y colgaba
  // el login (ver _cleanupOldFirestoreCache). BazarHub ya tiene su propio
  // caché offline manual con localStorage (arriba en este archivo), así
  // que no hace falta la persistencia propia de Firestore.
  _cleanupOldFirestoreCache();

  return true;
}

/**
 * Espera a que Firebase esté listo Y el usuario esté autenticado anónimamente.
 * Solo después llama al callback.
 */
// Si al abrir la app no se bajó alguno de los 3 archivos del SDK de Firebase
// (señal floja de celular), antes la app quedaba muerta hasta recargar a mano.
// Ahora se vuelven a pedir solos, de a uno, con otro parámetro para saltear
// cualquier respuesta rota que haya quedado guardada.
let _sdkReintentando = false;
function _cargarSdkFaltante() {
  if (_sdkReintentando) return;
  _sdkReintentando = true;
  const base = 'https://www.gstatic.com/firebasejs/9.23.0/';
  const pasos = [
    ['firebase-app-compat.js',       () => typeof firebase !== 'undefined' && !!firebase.initializeApp],
    ['firebase-firestore-compat.js', () => typeof firebase !== 'undefined' && !!firebase.firestore],
    ['firebase-auth-compat.js',      () => typeof firebase !== 'undefined' && !!firebase.auth],
  ];
  _diagRegistrar('SDK de Firebase', 'faltaba, se pidió de nuevo');
  (async () => {
    for (const [archivo, estaOk] of pasos) {
      if (estaOk()) continue;
      await new Promise(res => {
        const sc = document.createElement('script');
        sc.src = base + archivo + '?r=' + Date.now();
        sc.onload = sc.onerror = () => res();
        document.head.appendChild(sc);
        setTimeout(res, 15000);
      });
    }
  })().then(() => { _sdkReintentando = false; }, () => { _sdkReintentando = false; });
}

function waitForFirebase(callback, tries = 0) {
  if (!_reparacionLista) { setTimeout(() => waitForFirebase(callback, tries), 100); return; }
  if (typeof firebase === 'undefined' || !initFirebase()) {
    if (tries === 25 || (tries > 25 && tries % 20 === 0)) _cargarSdkFaltante();
    if (tries === 34) {
      // A los ~10s sin conexión: si hay datos guardados en este dispositivo
      // los usamos para no dejar a la persona colgada, pero seguimos
      // intentando conectar de fondo (más espaciado) — antes, cuando no
      // había caché local, se dejaba de intentar para siempre y hacía
      // falta recargar la página a mano apenas volvía la señal. Antes se
      // avisaba a los ~6s: muy poco para 4G/5G con señal débil, donde el
      // celular puede tardar más en levantar el SDK de Firebase sin que
      // eso signifique que la conexión esté realmente caída.
      const hasLocal = loadLocalData();
      if (hasLocal) {
        store._offlineFallbackShown = true;
        toast('Sin conexión. Usando datos guardados localmente.', 'warn');
        updateConnBadge();
        callback();
      }
    }
    if (tries < 150) {
      setTimeout(() => waitForFirebase(callback, tries + 1), tries < 30 ? 200 : 1000);
      return;
    }
    // ~126s intentando: recién acá nos damos por vencidos de verdad.
    if (!loadLocalData()) {
      toast('No se pudo conectar a Firebase y no hay datos locales.', 'err');
      showLoadingOverlay(false);
    }
    return;
  }

  // Firebase disponible: asegurar sesión anónima antes de continuar
  _ensureAuth(callback);
}

/**
 * Si ya hay sesión activa, llama al callback directo.
 * Si no, hace signInAnonymously y espera.
 */
function _ensureAuth(callback, intento = 0) {
  if (auth.currentUser) {
    _diagAuthLog('ya había sesión al conectar (' + String(auth.currentUser.uid).slice(0, 6) + ')');
    callback();
    return;
  }
  const _tAuth = Date.now();
  _diagAuthLog('no hay sesión: se pide una anónima (intento ' + (intento + 1) + ')');
  // 15s en vez de 10s: en conexiones móviles (4G/5G con señal débil) la
  // autenticación anónima puede tardar más de 10s sin que la conexión esté
  // realmente caída, y con el límite viejo eso se mostraba como "sin
  // conexión" antes de tiempo.
  const _pAuth = auth.signInAnonymously();
  // Respuesta REAL de Firebase (aunque llegue después del límite de 15 s).
  try {
    _pAuth.then(
      () => _diagAuthLog('Firebase respondió: sesión anónima OK a los ' + (Date.now() - _tAuth) + ' ms'),
      e => _diagAuthLog('Firebase respondió con ERROR a los ' + (Date.now() - _tAuth) + ' ms: ' + _diagErrTxt(e))
    );
  } catch (e) {}
  withTimeout(_pAuth, 15000, 'autenticación anónima')
    .then(() => {
      callback();
    })
    .catch(err => {
      console.error('Auth anónima falló:', err);
      _diagAuthLog('el inicio de sesión no terminó (' + (Date.now() - _tAuth) + ' ms): ' + _diagErrTxt(err));
      _diagSondear();
      _diagRegistrar('autenticación', err);
      // Si falla la auth (ej. sin internet), intentar con caché local
      const hasLocal = loadLocalData();
      if (hasLocal) {
        store._offlineFallbackShown = true;
        toast('Sin conexión. Usando datos guardados localmente.', 'warn');
        updateConnBadge();
        callback();
      } else if (intento < 12) {
        // Sin copia local reciente no hay con qué trabajar: antes se mostraba
        // el error UNA vez y la app quedaba muerta hasta recargar a mano, aunque
        // la señal volviera a los 5 segundos. Ahora se reintenta sola.
        if (intento === 0) toast('Conectando con el servidor… un momento.', 'warn');
        setTimeout(() => _ensureAuth(callback, intento + 1), intento < 3 ? 3000 : 8000);
      } else {
        toast('Error de autenticación con Firebase.', 'err');
        showLoadingOverlay(false);
      }
    });
}

// ===== CRUD GENÉRICO CON SOPORTE OFFLINE =====

async function saveDoc(col, id, data) {
  saveLocalData();
  if (!navigator.onLine || !db) {
    addToOfflineQueue({ type: 'set', col, id: String(id), data });
    return;
  }
  try {
    await withTimeout(db.collection(col).doc(String(id)).set(data), 10000, 'guardar ' + col);
  } catch(e) {
    console.error('saveDoc error:', col, id, e);
    addToOfflineQueue({ type: 'set', col, id: String(id), data });
  }
}

async function deleteDoc(col, id) {
  saveLocalData();
  if (!navigator.onLine || !db) {
    addToOfflineQueue({ type: 'delete', col, id: String(id) });
    return;
  }
  try {
    await withTimeout(db.collection(col).doc(String(id)).delete(), 10000, 'eliminar ' + col);
  } catch(e) {
    console.error('deleteDoc error:', col, id, e);
    addToOfflineQueue({ type: 'delete', col, id: String(id) });
  }
}

async function getCollection(col) {
  const snap = await db.collection(col).get();
  const docs = [];
  snap.forEach(d => docs.push({ ...d.data(), id: d.id }));
  return docs;
}

// ===== CARGA INCREMENTAL (para no bajar toda la base cada vez) =====
//
// Antes, cada vez que se abría la app se bajaban TODAS las ventas, TODOS
// los movimientos, TODOS los productos, etc. Firebase cobra (y en el plan
// gratis limita a 50.000 por día) cada documento leído, así que cada
// apertura costaba decenas de miles de lecturas y el número crecía todos
// los días junto con la base. Así se llegó a agotar la cuota diaria y
// Firebase empezó a rechazar TODO, incluso guardar ventas.
//
// Ahora:
//  1. Cada vez que la app escribe un documento le agrega un sello "_mt" con
//     la hora del servidor de Firebase (se hace en un solo lugar, abajo en
//     _instalarSellos, así no se escapa ninguna escritura). Cada vez que se
//     borra algo se deja una marca en la colección "_borrados".
//  2. Este dispositivo guarda una copia de lo que ya bajó (en IndexedDB, que
//     aguanta mucho más que localStorage y no le quita lugar a la cola de
//     ventas pendientes).
//  3. Al abrir la app solo se piden a Firebase los documentos con sello
//     posterior a lo que ya se tenía, más las marcas de borrado nuevas.
//  4. Cada 7 días (o si la copia local falta o falla) se hace una carga
//     completa, como red de seguridad.
//  5. Las ventas de hoy y de ayer se piden SIEMPRE completas (son pocas),
//     para que la caja nunca dependa de la copia local.

const _SYNC_DB_NAME        = 'bazarhub_sync';
const _SYNC_STORE          = 'cols';
const _SYNC_SCHEMA         = 1;
const _SYNC_BORRADOS_COL   = '_borrados';
// Recarga completa de seguridad cada 30 días por dispositivo (antes 7). Desde
// que todos los dispositivos usan el código nuevo, toda escritura lleva sello,
// así que la carga incremental ya no se pierde cambios; esta recarga queda solo
// como red de seguridad y cada una cuesta ~20.000 lecturas por dispositivo.
const _SYNC_FULL_EVERY_MS  = 30 * 24 * 60 * 60 * 1000;
const _SYNC_MARGEN_MS      = 2 * 60 * 1000;
// Hasta esta fecha se sigue haciendo carga completa: da tiempo a que todos
// los dispositivos se cierren y se vuelvan a abrir con esta versión (una
// pestaña vieja todavía abierta escribiría sin sello y la carga incremental
// no vería esos cambios). La primera apertura después de esta fecha hace
// una carga completa más y recién ahí empieza a ser incremental.
const _SYNC_INCREMENTAL_DESDE = Date.parse('2026-09-30T07:00:00Z'); // 30/9 4:00 AM (Argentina)
// Colecciones que se cargan de forma incremental. Las chicas (usuarios,
// configuración, combos) se siguen bajando completas: son pocos documentos.
const _SYNC_COLS = ['products', 'proveedores', 'sales', 'orders', 'movimientos',
                    'ctacte', 'retiros', 'cajas', 'devoluciones'];

// ===== v27: AHORRO DE LECTURAS =====
// 1) Movimientos: en una carga COMPLETA (dispositivo nuevo, ventana de
//    incógnito, Reparar, cada 30 días) solo se bajan los de los últimos
//    _MOV_DIAS_RECIENTES días; los anteriores se piden recién cuando hacen
//    falta (pantalla Movimientos / exportar CSV). Los dispositivos que ya
//    tienen la copia local completa no cambian en nada.
// 2) Panel de administración: ver dashboard.js (usa las ventas ya cargadas).
// 3) Contador aproximado de lecturas (se ve en la pantalla de diagnóstico).
//
// INTERRUPTOR para volver al comportamiento de v26 en UN dispositivo sin
// publicar nada: en la consola del navegador,
//   localStorage.setItem('bazarhub_v27_off','1')   y recargar.
// (Para volver a activarlo: localStorage.removeItem('bazarhub_v27_off').)
const _MOV_DIAS_RECIENTES = 30;   // no bajar de 30: la alerta "sin movimiento en 30 días" del panel los necesita
const _MOV_PAGINA         = 500;
const _SYNC_SCHEMA_PARCIAL = 2; // copia local de movimientos "parcial" (v26 no la acepta: se ignora, no se confunde)

function _v27Activo() {
  try { return !localStorage.getItem('bazarhub_v27_off'); } catch (e) { return true; }
}

// --- Contador aproximado de lecturas ---
// Cuenta los documentos que devuelven las consultas (get) y los cambios que
// llegan por el oyente del panel. No incluye lecturas dentro de transacciones
// (~2 por venta) ni las de otros dispositivos. Es una estimación para
// comparar antes/después, no la factura.
const _LECT_KEY     = 'bazarhub_lecturas';
const _LECT_BUCKETS = ['carga', 'movimientos', 'ventas', 'panel', 'otras'];
const _LECT_NOMBRES = { carga: 'carga inicial', movimientos: 'movimientos', ventas: 'ventas', panel: 'panel', otras: 'otras consultas' };
let _lectSesion   = { carga: 0, movimientos: 0, ventas: 0, panel: 0, otras: 0 };
let _lectPend     = { carga: 0, movimientos: 0, ventas: 0, panel: 0, otras: 0 };
let _lectTimer    = null;
let _lectForzado  = null;   // categoría forzada para la consulta que se está armando ahora
let _cargaEnCurso = false;  // true mientras loadFromFirebase() está bajando datos

function _lectDia() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function _lectLeerHoy() {
  try {
    const j = JSON.parse(localStorage.getItem(_LECT_KEY) || 'null');
    if (j && j.dia === _lectDia() && j.b) return j;
  } catch (e) {}
  return { dia: _lectDia(), b: { carga: 0, movimientos: 0, ventas: 0, panel: 0, otras: 0 } };
}

function _lectGuardar() {
  _lectTimer = null;
  try {
    const hoy = _lectLeerHoy();   // se vuelve a leer: si hay otra pestaña, no se pisan
    _LECT_BUCKETS.forEach(k => { hoy.b[k] = (hoy.b[k] || 0) + (_lectPend[k] || 0); _lectPend[k] = 0; });
    localStorage.setItem(_LECT_KEY, JSON.stringify(hoy));
  } catch (e) {}
}

function _contarLecturas(categoria, n) {
  if (!(n > 0)) return;
  const k = _LECT_BUCKETS.indexOf(categoria) >= 0 ? categoria : 'otras';
  _lectSesion[k] += n;
  _lectPend[k]   += n;
  if (!_lectTimer) _lectTimer = setTimeout(_lectGuardar, 2000);
}

// Ejecuta fn (que debe hacer la consulta de forma SINCRÓNICA) marcándola con
// una categoría fija.
function _conCategoria(categoria, fn) {
  const prev = _lectForzado;
  _lectForzado = categoria;
  try { return fn(); } finally { _lectForzado = prev; }
}

function _categoriaDeSnap(snap, forzada) {
  if (forzada) return forzada;
  try {
    if (snap.docs && snap.docs.length) {
      const c = snap.docs[0].ref.parent.id;
      if (c === 'movimientos') return 'movimientos';
      if (c === 'sales') return 'ventas';
    }
  } catch (e) {}
  return _cargaEnCurso ? 'carga' : 'otras';
}

function _instalarContador() {
  const fs = firebase.firestore;
  if (fs.__bazarhubContador) return;
  try {
    const Q = fs.Query.prototype, D = fs.DocumentReference.prototype;
    const qGet = Q.get, dGet = D.get;
    Q.get = function (...a) {
      const forz = _lectForzado;
      return qGet.apply(this, a).then(snap => {
        try { if (!(snap.metadata && snap.metadata.fromCache)) _contarLecturas(_categoriaDeSnap(snap, forz), Math.max(1, snap.size)); } catch (e) {}
        return snap;
      });
    };
    D.get = function (...a) {
      const forz = _lectForzado;
      return dGet.apply(this, a).then(snap => {
        try { if (!(snap.metadata && snap.metadata.fromCache)) _contarLecturas(forz || (_cargaEnCurso ? 'carga' : 'otras'), 1); } catch (e) {}
        return snap;
      });
    };
    fs.__bazarhubContador = true;
  } catch (e) {
    console.warn('[BazarHub] No se pudo instalar el contador de lecturas:', e);
  }
}

function _lectLinea(b) {
  const total = _LECT_BUCKETS.reduce((t, k) => t + (b[k] || 0), 0);
  return _LECT_BUCKETS.map(k => _LECT_NOMBRES[k] + ' ' + (b[k] || 0)).join(' · ') + '  =  ' + total;
}

function _lecturasTexto() {
  const hoy = _lectLeerHoy();
  _LECT_BUCKETS.forEach(k => { hoy.b[k] = (hoy.b[k] || 0) + (_lectPend[k] || 0); });
  const L = [];
  L.push('Lecturas aprox. de Firebase (solo este dispositivo):');
  L.push('  Desde que abriste la app: ' + _lectLinea(_lectSesion));
  L.push('  Hoy (total del dispositivo): ' + _lectLinea(hoy.b));
  L.push('  Movimientos: ' + (store.movimientosDesdeId === undefined ? 'todavía sin cargar' : store.movimientosDesdeId != null ? 'solo últimos ' + _MOV_DIAS_RECIENTES + ' días cargados' : 'historial completo') + (_v27Activo() ? '' : ' [v27 apagada]'));
  return L.join('\n');
}

// --- 1. Sellos en cada escritura ---

function _sellar(ref, data) {
  if (!ref || !ref.parent || ref.parent.id === _SYNC_BORRADOS_COL) return data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  return { ...data, _mt: firebase.firestore.FieldValue.serverTimestamp() };
}

function _refMarcaBorrado(ref) {
  // Solo colecciones de primer nivel (la app no usa subcolecciones).
  if (!ref || !ref.parent || ref.parent.parent) return null;
  if (ref.parent.id === _SYNC_BORRADOS_COL) return null;
  return ref.firestore.collection(_SYNC_BORRADOS_COL).doc(ref.parent.id + '__' + ref.id);
}

function _instalarSellos() {
  const fs = firebase.firestore;
  if (fs.__bazarhubSellos) return;
  const DR = fs.DocumentReference && fs.DocumentReference.prototype;
  const WB = fs.WriteBatch && fs.WriteBatch.prototype;
  const TX = fs.Transaction && fs.Transaction.prototype;
  if (!DR || !WB || !TX) {
    console.warn('[BazarHub] No se pudieron instalar los sellos de sincronización');
    return;
  }
  fs.__bazarhubSellos = true;
  const origDRset = DR.set, origWBset = WB.set, origWBdel = WB.delete;
  const origTXset = TX.set, origTXdel = TX.delete;

  DR.set = function (data, options) {
    return options === undefined ? origDRset.call(this, _sellar(this, data))
                                 : origDRset.call(this, _sellar(this, data), options);
  };
  WB.set = function (ref, data, options) {
    return options === undefined ? origWBset.call(this, ref, _sellar(ref, data))
                                 : origWBset.call(this, ref, _sellar(ref, data), options);
  };
  TX.set = function (ref, data, options) {
    return options === undefined ? origTXset.call(this, ref, _sellar(ref, data))
                                 : origTXset.call(this, ref, _sellar(ref, data), options);
  };
  WB.delete = function (ref) {
    const r = origWBdel.call(this, ref);
    const marca = _refMarcaBorrado(ref);
    if (marca) origWBset.call(this, marca, { col: ref.parent.id, id: ref.id, _mt: fs.FieldValue.serverTimestamp() });
    return r;
  };
  TX.delete = function (ref) {
    const r = origTXdel.call(this, ref);
    const marca = _refMarcaBorrado(ref);
    if (marca) origTXset.call(this, marca, { col: ref.parent.id, id: ref.id, _mt: fs.FieldValue.serverTimestamp() });
    return r;
  };
  // Un borrado suelto pasa a ser un lote chico: borrar + dejar la marca,
  // todo junto (o las dos cosas o ninguna).
  DR.delete = function () {
    const b = this.firestore.batch();
    b.delete(this);
    return b.commit();
  };
}

function _separarSello(raw) {
  const data = { ...raw };
  const mt = data._mt;
  delete data._mt;
  const t = (mt && typeof mt.toMillis === 'function') ? mt.toMillis() : 0;
  return { data, t };
}

// --- 2. Copia local en IndexedDB ---

let _syncDbPromise = null;
// Última marca (_mt, en ms) hasta la que cada colección está al día en este
// dispositivo. La usa el panel para escuchar solo lo que cambió desde entonces.
const _syncMarca = {};

function _syncDb() {
  if (_syncDbPromise) return _syncDbPromise;
  _syncDbPromise = withTimeout(new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Sin IndexedDB')); return; }
    const req = indexedDB.open(_SYNC_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(_SYNC_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloqueada'));
  }), 4000, 'abrir copia local').catch(e => { _syncDbPromise = null; throw e; });
  return _syncDbPromise;
}

async function _syncIdbGet(key) {
  const idb = await _syncDb();
  return withTimeout(new Promise((resolve, reject) => {
    const req = idb.transaction(_SYNC_STORE, 'readonly').objectStore(_SYNC_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  }), 5000, 'leer copia local');
}

async function _syncIdbPut(key, value) {
  const idb = await _syncDb();
  return withTimeout(new Promise((resolve, reject) => {
    const tx = idb.transaction(_SYNC_STORE, 'readwrite');
    tx.objectStore(_SYNC_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error || new Error('abortado'));
  }), 10000, 'guardar copia local');
}

// --- 3. Sincronización ---

let _syncCtxPromise = null;

// Cuando Firestore NO logra comunicarse con el servidor, una consulta .get()
// no da error: devuelve una lista VACÍA "de caché" (metadata.fromCache). Si la
// app la tomara por buena, mostraría todo vacío (por ejemplo "Caja cerrada"),
// guardaría esa lista vacía como copia válida y pisaría la copia local buena.
// Por eso, una respuesta que no viene del servidor se trata como un error.
function _exigirServidor(snap, etiqueta) {
  if (snap && snap.metadata && snap.metadata.fromCache) {
    throw new Error('Sin respuesta del servidor (' + etiqueta + ')');
  }
  return snap;
}

function _syncTsDesde(ms) {
  return firebase.firestore.Timestamp.fromMillis(Math.max(0, (ms || 0) - _SYNC_MARGEN_MS));
}

function _syncCopiaValida(m) {
  if (m && m.parcial && !_v27Activo()) return false;   // interruptor v27 apagado: se ignora la copia parcial
  return !!(m && (m.v === _SYNC_SCHEMA || m.v === _SYNC_SCHEMA_PARCIAL) && m.docs && m.fullAt &&
            m.fullAt >= _SYNC_INCREMENTAL_DESDE &&
            Date.now() - m.fullAt < _SYNC_FULL_EVERY_MS);
}

// Lee las copias locales de todas las colecciones y las marcas de borrado
// nuevas. Si algo de esto falla, se sigue igual pero con carga completa
// (lo mismo que hacía la app antes), nunca con datos a medias.
async function _iniciarSync() {
  const mirrors = {};
  _SYNC_COLS.forEach(c => { mirrors[c] = null; });
  let borrados = [];
  try {
    await Promise.all(_SYNC_COLS.map(async c => {
      try {
        const m = await _syncIdbGet(c);
        mirrors[c] = _syncCopiaValida(m) ? m : null;
      } catch (e) {
        mirrors[c] = null;
      }
    }));
    const conCopia = _SYNC_COLS.filter(c => mirrors[c]);
    if (conCopia.length) {
      const desde = Math.min(...conCopia.map(c => mirrors[c].wmB || 0));
      const snap = await withTimeout(
        db.collection(_SYNC_BORRADOS_COL).where('_mt', '>', _syncTsDesde(desde)).get(),
        10000, 'cargar borrados'
      );
      _exigirServidor(snap, 'borrados');
      snap.forEach(d => {
        const v = d.data();
        const t = (v._mt && typeof v._mt.toMillis === 'function') ? v._mt.toMillis() : 0;
        if (v.col && v.id != null) borrados.push({ col: v.col, id: String(v.id), t });
      });
    }
  } catch (e) {
    console.warn('[BazarHub] No se pudo usar la copia local, se hace carga completa:', e);
    _SYNC_COLS.forEach(c => { mirrors[c] = null; });
    borrados = [];
  }
  return { mirrors, borrados };
}

function _fechaStrDe(d) {
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

// Devuelve [{ id, data }] con el estado actual de la colección, pidiéndole a
// Firebase solo lo que cambió desde la última vez (o todo, si hace falta).
async function _syncCol(col) {
  if (!_syncCtxPromise) _syncCtxPromise = _iniciarSync();
  const ctx = await _syncCtxPromise;
  const maxBorrado = ctx.borrados.reduce((mx, b) => Math.max(mx, b.t), 0);
  const anterior = ctx.mirrors[col];
  let m;
  let hayCambios = true;

  let reciente = null;
  if (!anterior && col === 'movimientos' && _v27Activo() && _MOV_DIAS_RECIENTES > 0) {
    // v27: carga completa SOLO de los movimientos recientes (ver arriba). Si
    // algo falla (índice, datos raros, red), se hace la carga completa de siempre.
    try { reciente = await _cargarMovimientosRecientes(); }
    catch (e) { console.warn('[BazarHub] Movimientos recientes: se hace carga completa:', e); _diagRegistrar('movimientos recientes', e); }
  }
  if (reciente) {
    m = { v: reciente.completo ? _SYNC_SCHEMA : _SYNC_SCHEMA_PARCIAL, docs: reciente.docs, wm: reciente.wm, wmB: maxBorrado, fullAt: Date.now() };
    if (!reciente.completo) m.parcial = { desdeId: reciente.desdeId, dias: _MOV_DIAS_RECIENTES };
  } else if (!anterior) {
    // Carga completa
    const snap = _exigirServidor(await db.collection(col).get(), col);
    const docs = {};
    let wm = 0;
    snap.forEach(d => {
      const { data, t } = _separarSello(d.data());
      docs[d.id] = { d: data, t };
      if (t > wm) wm = t;
    });
    m = { v: _SYNC_SCHEMA, docs, wm, wmB: maxBorrado, fullAt: Date.now() };
  } else {
    // Solo lo nuevo o modificado
    const consultas = [db.collection(col).where('_mt', '>', _syncTsDesde(anterior.wm)).get()];
    if (col === 'sales') {
      const hoy  = new Date();
      const ayer = new Date(hoy.getTime() - 24 * 60 * 60 * 1000);
      consultas.push(db.collection('sales').where('date', 'in', [_fechaStrDe(hoy), _fechaStrDe(ayer)]).get());
    }
    const snaps = await Promise.all(consultas);
    snaps.forEach(sn => _exigirServidor(sn, col));
    const docs = { ...anterior.docs };
    let wm = anterior.wm || 0;
    let cambios = 0;
    snaps.forEach(snap => snap.forEach(d => {
      cambios++;
      const { data, t } = _separarSello(d.data());
      docs[d.id] = { d: data, t };
      if (t > wm) wm = t;
    }));
    ctx.borrados.forEach(b => {
      if (b.col !== col) return;
      const cur = docs[b.id];
      if (cur && (cur.t || 0) <= b.t) { delete docs[b.id]; cambios++; }
    });
    const wmB = Math.max(anterior.wmB || 0, maxBorrado);
    m = { v: anterior.v || _SYNC_SCHEMA, docs, wm, wmB, fullAt: anterior.fullAt };
    if (anterior.parcial) m.parcial = anterior.parcial;
    // Sin novedades: no hace falta volver a escribir la copia local entera.
    hayCambios = cambios > 0 || wm !== anterior.wm || wmB !== anterior.wmB;
  }

  ctx.mirrors[col] = m;
  _syncMarca[col] = m.wm || 0;
  if (hayCambios) _syncIdbPut(col, m).catch(e => console.warn('[BazarHub] No se pudo guardar la copia local de ' + col + ':', e));
  return Object.keys(m.docs).map(id => ({ id, data: m.docs[id].d }));
}

// ===== v27: MOVIMIENTOS RECIENTES / ANTERIORES =====

// Fecha ("d/m/aaaa, hh:mm:ss") de un movimiento -> ms, o null si no se entiende.
function _fechaMovMs(f) {
  if (!f) return null;
  const p = String(f).split(/[\/, ]+/);
  const d = parseInt(p[0], 10), mo = parseInt(p[1], 10), y = parseInt(p[2], 10);
  if (!d || !mo || !y || y < 2000 || y > 2100) return null;
  return new Date(y, mo - 1, d).getTime();
}

// Baja los movimientos del más nuevo al más viejo (por N°), de a páginas, y
// corta cuando la última página llega más atrás del límite de días. Solo se
// cobran las páginas leídas. Si algo no cuadra (documentos sin N° numérico),
// vuelve a la carga completa de siempre.
async function _cargarMovimientosRecientes() {
  const corte = Date.now() - _MOV_DIAS_RECIENTES * 24 * 60 * 60 * 1000;
  const docs = {};
  let wm = 0, ultimo = null, completo = false, menorId = null;
  for (let pag = 0; pag < 60; pag++) {
    let q = db.collection('movimientos').orderBy('id', 'desc').limit(_MOV_PAGINA);
    if (ultimo) q = q.startAfter(ultimo);
    const snap = _exigirServidor(await q.get(), 'movimientos');
    if (snap.empty) { completo = true; break; }
    snap.forEach(d => {
      const { data, t } = _separarSello(d.data());
      if (typeof data.id !== 'number' || String(data.id) !== d.id) throw new Error('movimiento sin N° numérico coherente (' + d.id + ')');
      docs[d.id] = { d: data, t };
      if (t > wm) wm = t;
      if (menorId === null || data.id < menorId) menorId = data.id;
    });
    ultimo = snap.docs[snap.docs.length - 1];
    if (snap.size < _MOV_PAGINA) { completo = true; break; }
    const f = _fechaMovMs(ultimo.data().fecha);
    if (f !== null && f < corte) break;
  }
  return { docs, wm, completo, desdeId: menorId };
}

let _movAntCargando = false;

// Baja movimientos anteriores a los ya cargados. modo 'mas' = ~90 días más;
// 'todo' = todo el historial. Actualiza la lista en pantalla y la copia local.
async function cargarMovimientosAnteriores(modo) {
  if (_movAntCargando) return { cargados: 0, completo: store.movimientosDesdeId == null };
  if (store.movimientosDesdeId == null) return { cargados: 0, completo: true };
  if (!db || !navigator.onLine) throw new Error('Sin conexión');
  _movAntCargando = true;
  try {
    let desdeId = store.movimientosDesdeId;
    // Referencia: la fecha del movimiento MÁS VIEJO por N° (no la fecha mínima:
    // un movimiento cargado a mano con una fecha rara correría el límite).
    const refMs = store.movimientos.length ? _fechaMovMs(store.movimientos[0].fecha) : null;
    const corte = (refMs !== null ? refMs : Date.now()) - 90 * 24 * 60 * 60 * 1000;
    const nuevos = {};
    let completo = false, cargados = 0;
    for (let pag = 0; pag < 60; pag++) {
      const snap = _exigirServidor(await db.collection('movimientos').where('id', '<', desdeId).orderBy('id', 'desc').limit(_MOV_PAGINA).get(), 'movimientos');
      if (snap.empty) { completo = true; break; }
      snap.forEach(d => {
        const { data, t } = _separarSello(d.data());
        nuevos[d.id] = { d: data, t };
        cargados++;
        if (typeof data.id === 'number' && data.id < desdeId) desdeId = data.id;
      });
      const ultimo = snap.docs[snap.docs.length - 1];
      if (snap.size < _MOV_PAGINA) { completo = true; break; }
      if (modo !== 'todo') {
        const f = _fechaMovMs(ultimo.data().fecha);
        if (f !== null && f < corte) break;
      }
    }
    const yaCargados = new Set(store.movimientos.map(m => m.id));
    Object.keys(nuevos).forEach(id => {
      if (!yaCargados.has(parseInt(id))) store.movimientos.push({ ...nuevos[id].d, id: parseInt(id) });
    });
    store.movimientos.sort((a, b) => a.id - b.id);
    store.movimientosDesdeId = completo ? null : desdeId;
    // Copia local: se suman los documentos nuevos (si la lectura de la copia
    // falló no pasa nada: la próxima carga completa lo resuelve).
    try {
      const ctx = await _syncCtxPromise;
      const mir = ctx && ctx.mirrors && ctx.mirrors.movimientos;
      if (mir) {
        const docs = { ...mir.docs, ...nuevos };
        const m2 = { ...mir, docs };
        if (completo) { delete m2.parcial; m2.v = _SYNC_SCHEMA; } else { m2.parcial = { desdeId, dias: (mir.parcial && mir.parcial.dias) || _MOV_DIAS_RECIENTES }; }
        ctx.mirrors.movimientos = m2;
        await _syncIdbPut('movimientos', m2);
      }
    } catch (e) { console.warn('[BazarHub] No se pudo actualizar la copia local de movimientos:', e); }
    return { cargados, completo };
  } finally {
    _movAntCargando = false;
  }
}

// ===== CARGA DE USUARIOS (antes del login) =====

function _loadUsersFromLocalStorage() {
  try {
    const raw = localStorage.getItem(OFFLINE_DATA_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s.users && s.users.length) store.users = s.users;
    }
  } catch(e) {}
}

// Devuelve true solo si la lista de usuarios vino REALMENTE del servidor.
async function loadUsersFromFirebase() {
  if (!db || !auth.currentUser) {
    _loadUsersFromLocalStorage();
    return false;
  }
  try {
    const snap = _exigirServidor(await withTimeout(_conCategoria('carga', () => db.collection('users').get()), 10000, 'cargar usuarios'), 'usuarios');
    store.users = [];
    snap.forEach(d => store.users.push({ ..._separarSello(d.data()).data, id: d.id }));
    const needsMigration = store.users.some(u => u.pass && !u.passHash);
    if (needsMigration) console.warn('[BazarHub] Hay usuarios con contraseñas en texto plano.');
    return true;
  } catch(e) {
    console.error('loadUsersFromFirebase error:', e);
    _diagRegistrar('usuarios', e);
    _loadUsersFromLocalStorage();
    return false;
  }
}

// ===== CARGA INICIAL (post-login BazarHub) =====

// Ejecuta un _load*() con un límite de tiempo por intento y un reintento
// si falla (timeout o error real de Firestore). Pensado para que un
// tropiezo puntual de UNA colección (más probable en 4G/5G con señal
// débil, al pedir las 12 a la vez) no tire abajo toda la carga: ver el
// comentario grande en loadFromFirebase().
async function _loadCollectionWithRetry(loadFn, label, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      // 30s por intento (antes 10s): con ~14.500 movimientos, bajar esa
      // colección completa ya tarda ~10s incluso con buena conexión, así que
      // con 10s fallaba siempre en las compus más lentas y la app terminaba
      // mostrando la copia local (vieja). Desde que la carga es incremental
      // esto casi nunca se usa, pero la carga completa semanal lo necesita.
      await withTimeout(loadFn(), 30000, label);
      return;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, 600));
      }
    }
  }
  console.error(`[BazarHub] "${label}" falló tras ${attempts} intentos:`, lastErr);
  _diagRegistrar(label, lastErr);
  throw lastErr;
}

// ===== DIAGNÓSTICO DE CARGA + REPARACIÓN =====
// Cuando la app no logra traer los datos de Firebase (se ve el cartel rojo
// "Datos guardados"), tocar el cartel abre una ventana con el motivo exacto
// y un botón para reparar. Reparar borra SOLO lo que se guarda en este
// dispositivo para acelerar la carga (copia de datos, sesión anónima de
// Firebase, caché de archivos); nunca toca las ventas pendientes de subir,
// la copia de respaldo para trabajar sin conexión ni la sesión del usuario.

// ===== DIAGNÓSTICO TEMPORAL DE LA SESIÓN (v27.4) =====
// SOLO REGISTRA: no borra la sesión, la copia local ni nada, y no cambia el
// comportamiento de la app. Guarda un historial corto (se conserva aunque se
// vuelva a cargar) con el error REAL de Firebase Auth (code + message), cuándo
// cambia la sesión y, cuando falla el inicio de sesión, unas pruebas aparte
// (almacenamiento del navegador y red hacia Google) para saber el motivo.
// Se ve en la ventana de diagnóstico (tocar el cartel de conexión).
const _DIAG_AUTH_KEY = 'bazarhub_diag_auth';
const _DIAG_AUTH_MAX = 50;
const _diagT0 = Date.now();   // momento en que se cargó la página
let _diagAuthMem = [];
let _diagSondeoTs = 0;

function _diagHora() {
  const d = new Date();
  const z = n => String(n).padStart(2, '0');
  return z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
}

function _diagErrTxt(e) {
  try {
    if (!e) return 'error desconocido';
    const code = (e.code && typeof e.code === 'string') ? '[' + e.code + '] ' : '';
    const name = (e.name && e.name !== 'Error' && typeof e.code !== 'string') ? e.name + ': ' : '';
    return (code + name + String(e.message || e)).slice(0, 200);
  } catch (x) { return 'error'; }
}

function _diagAuthLog(msg) {
  try {
    const linea = _diagHora() + ' ' + String(msg).slice(0, 260);
    _diagAuthMem.push(linea);
    if (_diagAuthMem.length > _DIAG_AUTH_MAX) _diagAuthMem.shift();
    try {
      let prev = [];
      try { prev = JSON.parse(localStorage.getItem(_DIAG_AUTH_KEY) || '[]'); } catch (e) { prev = []; }
      if (!Array.isArray(prev)) prev = [];
      prev.push(linea);
      while (prev.length > _DIAG_AUTH_MAX) prev.shift();
      localStorage.setItem(_DIAG_AUTH_KEY, JSON.stringify(prev));
    } catch (e) {}
    console.log('[BazarHub sesión] ' + linea);
  } catch (e) {}
}

function _diagAuthLineas(max) {
  let l = [];
  try { l = JSON.parse(localStorage.getItem(_DIAG_AUTH_KEY) || '[]'); } catch (e) {}
  if (!Array.isArray(l) || !l.length) l = _diagAuthMem.slice();
  return l.slice(-max);
}

function _diagAuthTexto(max) {
  const l = _diagAuthLineas(max);
  if (!l.length) return 'Detalle de sesión: (sin eventos registrados)';
  return 'Detalle de sesión (últimos ' + l.length + '):\n' + l.map(x => '  ' + x).join('\n');
}

function _diagAuthIniciar() {
  try {
    const app = (navigator.standalone === true) || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    const nav = (navigator.userAgent.match(/(CriOS|FxiOS|EdgiOS|Version|Chrome)\/[\d.]+/) || [''])[0];
    _diagAuthLog('--- se abrió la app · internet=' + (navigator.onLine ? 'sí' : 'NO') + ' · modo app=' + (app ? 'sí' : 'no') + ' · ' + nav);
    let visto = false;
    auth.onAuthStateChanged(
      u => { visto = true; _diagAuthLog('Auth terminó de arrancar a los ' + (Date.now() - _diagT0) + ' ms de abrir · estado de sesión: ' + (u ? 'CON sesión (' + String(u.uid).slice(0, 6) + ')' : 'SIN sesión')); },
      e => { visto = true; _diagAuthLog('error al leer el estado de sesión: ' + _diagErrTxt(e)); }
    );
    // Errores de Firebase Auth que nadie atrapa (solo se anotan).
    window.addEventListener('unhandledrejection', ev => {
      try {
        const r = ev && ev.reason;
        const txt = _diagErrTxt(r);
        if ((r && r.code && String(r.code).indexOf('auth/') === 0) || /firebase|auth\//i.test(txt)) _diagAuthLog('error no atrapado de Firebase: ' + txt);
      } catch (e) {}
    });
    // iOS pausa las pestañas en segundo plano: se anota cuándo pasa, para saber
    // si un "no pasó nada" fue porque la pestaña estaba dormida.
    document.addEventListener('visibilitychange', () => {
      try { _diagAuthLog('la pestaña pasó a ' + (document.visibilityState === 'hidden' ? 'SEGUNDO PLANO' : 'primer plano')); } catch (e) {}
    });
    // En cada apertura se anota (solo lectura) el estado de la sesión guardada y
    // su vencimiento, para ver si las fallas coinciden con una sesión vencida.
    setTimeout(() => {
      try { if (!localStorage.getItem('bazarhub_diag_off')) _diagLeerBaseSesion(); } catch (e) {}
    }, 2500);
    setTimeout(() => { if (!visto) { _diagAuthLog('Firebase Auth NO informó el estado de la sesión en 8 s'); _diagSondear(); } }, 8000);
  } catch (e) {}
}

// Describe la sesión guardada SIN mostrar su contenido: nunca se anota el
// token, solo cuándo vence y si existe.
function _diagDescribirSesion(v) {
  try {
    const t = (v && v.stsTokenManager) ? v.stsTokenManager : {};
    const ahora = Date.now();
    const venc = Number(t.expirationTime);
    const creada = Number(v && v.createdAt);
    const ultimo = Number(v && v.lastLoginAt);
    const tiempo = ms => { const m = Math.round(Math.abs(ms) / 60000); return m < 120 ? m + ' min' : (Math.round(m / 6) / 10) + ' h'; };
    const partes = [];
    partes.push('usuario ' + String((v && v.uid) || '?').slice(0, 6) + (v && v.isAnonymous ? ' (anónimo)' : ''));
    partes.push(isFinite(venc) && venc > 0 ? (venc > ahora ? 'el token vence en ' + tiempo(venc - ahora) : 'el token VENCIÓ hace ' + tiempo(ahora - venc)) : 'vencimiento desconocido');
    partes.push('tiene clave de renovación: ' + (t.refreshToken ? 'sí' : 'NO'));
    if (isFinite(creada) && creada > 0) partes.push('creada hace ' + tiempo(ahora - creada));
    if (isFinite(ultimo) && ultimo > 0) partes.push('último ingreso hace ' + tiempo(ahora - ultimo));
    _diagAuthLog('sesión guardada: ' + partes.join(' · '));
  } catch (e) { _diagAuthLog('sesión guardada: no se pudo interpretar (' + _diagErrTxt(e) + ')'); }
}

// Lectura SOLA (no se escribe ni se borra nada) de la base donde Firebase Auth
// guarda la sesión, para ver si es esa la que se cuelga. Se abre sin número de
// versión (abre la que existe, sin cambiarla); si no existiera, se cancela la
// creación para no dejar una base vacía que confunda a Firebase.
function _diagLeerBaseSesion(nombre) {
  nombre = nombre || 'firebaseLocalStorageDb';
  return new Promise(res => {
    const t0 = Date.now();
    let fin = false, timer = null;
    const listo = m => {
      if (fin) return;
      fin = true; clearTimeout(timer);
      _diagAuthLog('base de sesión de Firebase (solo lectura): ' + m);
      res();
    };
    const limite = m => { clearTimeout(timer); timer = setTimeout(() => listo(m), 6000); };
    limite('SIN RESPUESTA al abrirla en 6 s (colgada)');
    try {
      const r = indexedDB.open(nombre);
      r.onupgradeneeded = () => { try { r.transaction.abort(); } catch (e) {} listo('no existe (no se creó)'); };
      r.onerror = () => listo('ERROR al abrirla: ' + _diagErrTxt(r.error));
      r.onblocked = () => listo('bloqueada por otra pestaña');
      r.onsuccess = () => {
        const d = r.result;
        const cerrar = () => { try { d.close(); } catch (e) {} };
        if (fin) { cerrar(); _diagAuthLog('(tarde) la base de sesión de Firebase abrió recién a los ' + (Date.now() - t0) + ' ms'); return; }
        const tAbre = Date.now() - t0;
        try {
          if (!d.objectStoreNames.contains('firebaseLocalStorage')) { cerrar(); listo('abre en ' + tAbre + ' ms (v' + d.version + ') pero sin la tabla de sesión'); return; }
          limite('abre en ' + tAbre + ' ms pero la LECTURA no responde en 6 s (colgada)');
          const tx = d.transaction('firebaseLocalStorage', 'readonly');
          const rq = tx.objectStore('firebaseLocalStorage').getAll();
          rq.onsuccess = () => {
            const filas = rq.result || [];
            cerrar();
            let ses = null;
            try { ses = filas.find(f => f && String(f.fbase_key || '').indexOf('firebase:authUser:') === 0) || null; } catch (e) {}
            listo('abre en ' + tAbre + ' ms (v' + d.version + '), lee en ' + (Date.now() - t0 - tAbre) + ' ms · registros: ' + filas.length + ' · sesión guardada: ' + (ses ? 'sí' : 'no'));
            if (ses) _diagDescribirSesion(ses.value);
          };
          rq.onerror = () => { cerrar(); listo('abre pero la lectura da ERROR ' + _diagErrTxt(rq.error)); };
          tx.onabort = () => { cerrar(); listo('lectura abortada ' + _diagErrTxt(tx.error)); };
        } catch (e) { cerrar(); listo('ERROR al leer: ' + _diagErrTxt(e)); }
      };
    } catch (e) { listo('ERROR: ' + _diagErrTxt(e)); }
  });
}

// Prueba de si una base de IndexedDB deja EMPEZAR una transacción. Con modo
// 'readwrite' se pide permiso de escritura pero se hace una sola lectura de una
// clave inexistente: NO se escribe, NO se borra y NO se cambia nada. Si algo
// la tiene trabada (otra pestaña, un bug de iOS), la transacción no arranca y
// a los 6 s se cancela (abort) para no dejar nada en cola. Solo se usa cuando
// el inicio de sesión ya falló.
function _diagProbarEscritura(etiqueta, nombre, tabla, modo) {
  return new Promise(res => {
    const t0 = Date.now();
    let fin = false, tx = null, d = null;
    const cerrar = () => { try { if (d) d.close(); } catch (e) {} };
    const listo = m => {
      if (fin) return;
      fin = true; clearTimeout(timer);
      _diagAuthLog('prueba de ' + (modo === 'readwrite' ? 'permiso de escritura' : 'lectura') + ' en ' + etiqueta + ': ' + m);
      res();
    };
    const timer = setTimeout(() => {
      try { if (tx) tx.abort(); } catch (e) {}
      cerrar();
      listo(tx ? 'SIN RESPUESTA en 6 s: la transacción no pudo empezar (base TRABADA)' : 'SIN RESPUESTA al abrir la base en 6 s (colgada)');
    }, 6000);
    try {
      const r = indexedDB.open(nombre);
      r.onupgradeneeded = () => { try { r.transaction.abort(); } catch (e) {} listo('la base no existe (no se creó)'); };
      r.onerror = () => listo('ERROR al abrir: ' + _diagErrTxt(r.error));
      r.onblocked = () => listo('bloqueada por otra pestaña');
      r.onsuccess = () => {
        d = r.result;
        if (fin) { cerrar(); return; }
        const tAbre = Date.now() - t0;
        try {
          if (!d.objectStoreNames.contains(tabla)) { cerrar(); listo('abre en ' + tAbre + ' ms pero no tiene la tabla ' + tabla); return; }
          tx = d.transaction(tabla, modo);
          const rq = tx.objectStore(tabla).get('__bazarhub_sin_clave__');
          rq.onsuccess = () => { listo('abre en ' + tAbre + ' ms, la transacción empezó en ' + (Date.now() - t0 - tAbre) + ' ms · OK'); };
          rq.onerror = () => listo('la lectura dio ERROR ' + _diagErrTxt(rq.error));
          tx.oncomplete = () => cerrar();
          tx.onabort = () => { cerrar(); listo('transacción abortada ' + _diagErrTxt(tx.error)); };
        } catch (e) { cerrar(); listo('ERROR: ' + _diagErrTxt(e)); }
      };
    } catch (e) { listo('ERROR: ' + _diagErrTxt(e)); }
  });
}

// Pruebas aparte (una vez por minuto como mucho), solo cuando falla el inicio
// de sesión. No tocan las bases de Firebase ni los datos: usan una base de
// prueba que se borra sola y piden páginas públicas de Google sin datos.
async function _diagSondear() {
  try { if (localStorage.getItem('bazarhub_diag_off')) return; } catch (e) {}   // interruptor: apaga las pruebas en este dispositivo
  if (Date.now() - _diagSondeoTs < 60000) return;
  _diagSondeoTs = Date.now();
  try {
    try {
      localStorage.setItem('__bh_p', '1');
      const ok = localStorage.getItem('__bh_p') === '1';
      localStorage.removeItem('__bh_p');
      _diagAuthLog('prueba localStorage: ' + (ok ? 'funciona' : 'NO devuelve lo escrito'));
    } catch (e) { _diagAuthLog('prueba localStorage: ERROR ' + _diagErrTxt(e)); }

    try {
      _diagAuthLog('service worker: ' + (navigator.serviceWorker ? (navigator.serviceWorker.controller ? 'controla esta pestaña' : 'no controla esta pestaña') : 'no disponible'));
    } catch (e) {}

    await new Promise(res => {
      const t0 = Date.now();
      let fin = false;
      const listo = m => { if (fin) return; fin = true; _diagAuthLog('prueba IndexedDB: ' + m); res(); };
      setTimeout(() => listo('SIN RESPUESTA en 5 s (colgado)'), 5000);
      try {
        const r = indexedDB.open('bazarhub_probe', 1);
        r.onupgradeneeded = () => { try { r.result.createObjectStore('s'); } catch (e) {} };
        r.onsuccess = () => {
          try { r.result.close(); indexedDB.deleteDatabase('bazarhub_probe'); } catch (e) {}
          listo('abre bien en ' + (Date.now() - t0) + ' ms');
        };
        r.onerror = () => listo('ERROR ' + _diagErrTxt(r.error));
        r.onblocked = () => listo('bloqueada');
      } catch (e) { listo('ERROR al abrir: ' + _diagErrTxt(e)); }
    });

    try {
      if (indexedDB && indexedDB.databases) {
        const l = await Promise.race([indexedDB.databases(), new Promise(r => setTimeout(() => r(null), 3000))]);
        if (!l) _diagAuthLog('lista de bases IndexedDB: SIN RESPUESTA en 3 s');
        else _diagAuthLog('bases IndexedDB: ' + (l.map(d => d.name + ' v' + d.version).filter(n => /firebase|bazarhub/i.test(n)).join(', ') || '(ninguna de Firebase/BazarHub)'));
      } else { _diagAuthLog('indexedDB.databases() no disponible en este navegador'); }
    } catch (e) { _diagAuthLog('lista de bases IndexedDB: ERROR ' + _diagErrTxt(e)); }

    await _diagLeerBaseSesion();

    // v27.4: ¿las bases aceptan que se empiece a ESCRIBIR en ellas? (no se escribe
    // ningún dato). Firebase escribe en su base al arrancar; si esa escritura
    // queda trabada, Auth se cuelga sin dar error. Se prueba la base de sesión de
    // Firebase, la de "latidos" de Firebase y, de control, la propia de BazarHub.
    await _diagProbarEscritura('base de sesión de Firebase', 'firebaseLocalStorageDb', 'firebaseLocalStorage', 'readwrite');
    await _diagProbarEscritura('base de latidos de Firebase', 'firebase-heartbeat-database', 'firebase-heartbeat-store', 'readonly');
    await _diagProbarEscritura('base propia de BazarHub (control)', 'bazarhub_sync', 'cols', 'readwrite');

    // Pedidos del MISMO TIPO que hace Firebase Auth al arrancar con una sesión
    // guardada (renovar y validar), pero con datos falsos: no tocan la sesión
    // real ni la renuevan; solo se mide si Google contesta (lo esperado es un
    // error rápido tipo 400) o si el pedido se cuelga.
    try {
      let apiKey = '';
      try { apiKey = firebase.app().options.apiKey; } catch (e) { apiKey = (window.FIREBASE_CONFIG || {}).apiKey || ''; }
      const pedido = async (url, cuerpo, tipo, nombre) => {
        const t0 = Date.now();
        const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const to = setTimeout(() => { try { if (ac) ac.abort(); } catch (e) {} }, 10000);
        try {
          const r = await fetch(url + '?key=' + encodeURIComponent(apiKey), {
            method: 'POST',
            headers: { 'Content-Type': tipo, 'X-Client-Version': 'Chrome/JsCore/9.23.0/FirebaseCore-web' },
            body: cuerpo, cache: 'no-store', signal: ac ? ac.signal : undefined,
          });
          let msg = '';
          try { const j = await r.json(); msg = (j && j.error && j.error.message) || ''; } catch (e) {}
          _diagAuthLog('pedido de prueba tipo Auth (' + nombre + '): respuesta ' + r.status + (msg ? ' ' + String(msg).slice(0, 60) : '') + ' en ' + (Date.now() - t0) + ' ms');
        } catch (e) {
          _diagAuthLog('pedido de prueba tipo Auth (' + nombre + '): FALLÓ tras ' + (Date.now() - t0) + ' ms (' + _diagErrTxt(e) + ')');
        } finally { clearTimeout(to); }
      };
      if (apiKey) {
        await Promise.all([
          pedido('https://securetoken.googleapis.com/v1/token', 'grant_type=refresh_token&refresh_token=diagnostico-invalido', 'application/x-www-form-urlencoded', 'renovar sesión'),
          pedido('https://identitytoolkit.googleapis.com/v1/accounts:lookup', JSON.stringify({ idToken: 'diagnostico-invalido' }), 'application/json', 'validar sesión'),
        ]);
      } else { _diagAuthLog('pedido de prueba tipo Auth: sin clave de configuración, no se hizo'); }
    } catch (e) { _diagAuthLog('pedido de prueba tipo Auth: ERROR ' + _diagErrTxt(e)); }

    const sonda = async (url, nombre) => {
      const t0 = Date.now();
      const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const to = setTimeout(() => { try { if (ac) ac.abort(); } catch (e) {} }, 8000);
      try {
        await fetch(url + '?_p=' + Date.now(), { mode: 'no-cors', cache: 'no-store', signal: ac ? ac.signal : undefined });
        _diagAuthLog('red hacia ' + nombre + ': responde en ' + (Date.now() - t0) + ' ms');
      } catch (e) {
        _diagAuthLog('red hacia ' + nombre + ': NO responde tras ' + (Date.now() - t0) + ' ms (' + _diagErrTxt(e) + ')');
      } finally { clearTimeout(to); }
    };
    await Promise.all([
      sonda('https://identitytoolkit.googleapis.com/', 'inicio de sesión'),
      sonda('https://securetoken.googleapis.com/', 'renovar sesión'),
      sonda('https://firestore.googleapis.com/', 'base de datos'),
    ]);
  } catch (e) { _diagAuthLog('pruebas: ERROR ' + _diagErrTxt(e)); }
}

function _diagRegistrar(etiqueta, err) {
  try {
    store._diagCarga = store._diagCarga || {};
    store._diagCarga[etiqueta] = (err && err.code ? '[' + err.code + '] ' : '') + String((err && err.message) || err || 'error').slice(0, 160);
  } catch (e) {}
}

// Una línea con el motivo más probable de que no conecte (para el login).
function _diagResumen() {
  try {
    const e = store._diagCarga || {};
    const k = ['SDK de Firebase', 'autenticación', 'usuarios'].find(x => e[x]);
    if (!navigator.onLine) return 'el dispositivo no tiene internet';
    if (k) return k + ': ' + e[k];
  } catch (x) {}
  return 'sin respuesta del servidor';
}

function _diagEscapar(t) {
  return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function _diagTexto(full) {
  const L = [];
  const errores = store._diagCarga || {};
  const ok = store._diagCargadas ? Array.from(store._diagCargadas) : [];
  L.push('Internet del dispositivo: ' + (navigator.onLine ? 'sí' : 'NO'));
  L.push('Firebase iniciado: ' + (db ? 'sí' : 'NO'));
  try { L.push('Sesión Firebase: ' + (auth && auth.currentUser ? 'sí (' + String(auth.currentUser.uid).slice(0, 6) + ')' : 'NO')); } catch (e) {}
  try { L.push(_diagAuthTexto(full ? _DIAG_AUTH_MAX : 12)); } catch (e) {}
  if (ok.length) L.push('Cargado bien: ' + ok.join(', '));
  const fallas = Object.keys(errores);
  if (fallas.length) fallas.forEach(k => L.push('Falló ' + k + ': ' + errores[k]));
  else if (store._offlineFallbackShown) L.push('Sin detalle de error (la carga no terminó).');
  try { if (navigator.connection) L.push('Red: ' + (navigator.connection.effectiveType || '?')); } catch (e) {}
  try { L.push(_lecturasTexto()); } catch (e) {}
  L.push('Archivos: firebase.js v27.4 (diag. sesión) · ' + (navigator.userAgent.match(/(iPhone|iPad|Android|Windows|Macintosh|Linux)/) || ['?'])[0]);
  return L.join('\n');
}

function abrirDiagnosticoConexion() {
  let m = document.getElementById('modal-diag');
  if (!m) {
    m = document.createElement('div');
    m.className = 'modal-bg';
    m.id = 'modal-diag';
    document.body.appendChild(m);
  }
  const cola = getOfflineQueue().length;
  const mal = !!store._offlineFallbackShown;
  m.innerHTML =
    '<div class="modal">' +
      '<div class="modal-title">' + (mal ? '⚠ No se pudieron cargar los datos' : '● Estado de la conexión') + '</div>' +
      '<div style="font-size:13px;color:var(--txt2);margin-bottom:12px;line-height:1.45">' +
        (mal
          ? 'Se están mostrando datos guardados en este dispositivo, que pueden estar desactualizados. No abras ni cierres la caja hasta que se actualice.'
          : 'Los datos están al día.') +
        (cola ? '<br><b>Hay ' + cola + ' operación(es) pendiente(s) de subir</b> (no se borran al reparar).' : '') +
      '</div>' +
      '<pre style="font-size:11px;white-space:pre-wrap;word-break:break-word;background:var(--bg3);border-radius:8px;padding:10px;margin:0 0 12px;max-height:35vh;overflow:auto">' +
        _diagEscapar(_diagTexto()) + '</pre>' +
      '<div style="font-size:12px;color:var(--txt2);margin-bottom:4px"><b>Reparar</b> borra la copia guardada en este dispositivo y la vuelve a bajar de Firebase (la primera carga puede tardar). Las ventas pendientes de subir no se borran.</div>' +
      '<div class="macts" style="flex-wrap:wrap">' +
        '<button class="btn" id="diag-cerrar">Cerrar</button>' +
        '<button class="btn" id="diag-copiar">Copiar</button>' +
        '<button class="btn" id="diag-reintentar">Reintentar</button>' +
        '<button class="btn red" id="diag-reparar">Reparar</button>' +
      '</div>' +
    '</div>';
  m.classList.add('on');
  document.getElementById('diag-cerrar').onclick = () => m.classList.remove('on');
  document.getElementById('diag-copiar').onclick = () => {
    const txt = _diagTexto(true);
    const ok = () => toast('Diagnóstico copiado', 'ok');
    const mal = () => toast('No se pudo copiar: sacá una captura', 'warn');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(ok, mal);
      else mal();
    } catch (e) { mal(); }
  };
  document.getElementById('diag-reintentar').onclick = () => {
    m.classList.remove('on');
    loadFromFirebase().then(() => _rerenderPaginaActual()).catch(() => {});
  };
  document.getElementById('diag-reparar').onclick = () => repararDatosLocales();
}

// Reparar = dejar una marca y recargar. Al arrancar de nuevo, ANTES de que
// Firebase abra sus bases en IndexedDB, se borran (borrarlas con la app ya
// andando puede quedar bloqueado por las conexiones abiertas).
const _REPARAR_FLAG = 'bazarhub_reparar_pendiente';
let _reparacionLista = true;

function _ejecutarReparacionPendiente() {
  try {
    if (!localStorage.getItem(_REPARAR_FLAG)) return;
    localStorage.removeItem(_REPARAR_FLAG);
  } catch (e) { return; }
  _reparacionLista = false;
  const terminar = () => { _reparacionLista = true; };
  (async () => {
    const nombres = new Set([_SYNC_DB_NAME, 'firebaseLocalStorageDb']);
    try {
      if (indexedDB.databases) {
        (await indexedDB.databases()).forEach(d => {
          if (d.name && (d.name.indexOf('firestore/') === 0 || d.name.indexOf('firebase') === 0)) nombres.add(d.name);
        });
      }
    } catch (e) {}
    await Promise.all(Array.from(nombres).map(n => new Promise(res => {
      try {
        const r = indexedDB.deleteDatabase(n);
        r.onsuccess = r.onerror = r.onblocked = () => res();
      } catch (e) { res(); }
      setTimeout(res, 4000);
    })));
  })().then(terminar, terminar);
  setTimeout(terminar, 8000);
}
_ejecutarReparacionPendiente();

async function repararDatosLocales(completo = true) {
  const btn = document.getElementById('diag-reparar');
  if (btn) { btn.disabled = true; btn.textContent = 'Reparando…'; }
  const paso = async (fn) => { try { await withTimeout(Promise.resolve().then(fn), 4000, 'reparar'); } catch (e) {} };

  try { localStorage.setItem(_REPARAR_FLAG, '1'); } catch (e) {}
  // Service worker y caché de archivos (se vuelven a bajar de la red). La
  // reparación automática de primer intento los deja, para no perder la app
  // si justo falla la conexión.
  if (completo) {
    await paso(async () => {
      if ('serviceWorker' in navigator) (await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
    });
    await paso(async () => {
      if (window.caches) (await caches.keys()).forEach(k => caches.delete(k));
    });
  }
  try { localStorage.removeItem('bazarhub_idb_cleaned_v1'); } catch (e) {}
  // NO se tocan: cola de operaciones pendientes, copia de respaldo sin
  // conexión (OFFLINE_DATA_KEY) ni la sesión del usuario.
  location.reload();
}

async function loadFromFirebase() {
  store._diagCarga = {};
  if (!db || !navigator.onLine) {
    _diagRegistrar('inicio', !db ? 'Firebase no inicializado' : 'Sin conexión a internet');
    const hasLocal = loadLocalData();
    if (hasLocal) {
      store._offlineFallbackShown = true;
      showLoadingOverlay(false);
      updateConnBadge();
      toast('Sin conexión · Usando datos locales', 'warn');
      return;
    }
    toast('Sin datos locales disponibles', 'err');
    showLoadingOverlay(false);
    return;
  }

  showLoadingOverlay(true);
  // Una lectura nueva de copias locales + borrados por cada carga.
  _syncCtxPromise = _iniciarSync();

  // Orden de carga: primero lo imprescindible para vender (caja, productos,
  // usuarios...), que son pocos documentos y llegan rápido; después el
  // historial (ventas, movimientos...), que la PRIMERA vez en un dispositivo
  // son ~20.000 documentos y en un celular puede tardar más de un minuto.
  // Antes todo iba mezclado y, si se pasaba del tiempo límite, la app tiraba
  // lo que ya había llegado y mostraba la copia local (vieja): así aparecía
  // "Caja cerrada" en el celular aunque hubiera una caja abierta.
  const BATCH_SIZE = 4;
  const tasks = [
    ['cajas', _loadCajas],
    ['configuración', _loadConfig],
    ['usuarios', _loadUsers],
    ['productos', _loadProducts],
    ['combos', _loadCombos],
    ['proveedores', _loadProveedores],
    ['ventas', _loadSales],
    ['devoluciones', _loadDevoluciones],
    ['cuenta corriente', _loadCtaCte],
    ['retiros', _loadRetiros],
    ['pedidos', _loadOrders],
    ['movimientos', _loadMovimientos],
  ];
  const cargadas = new Set();
  store._diagCargadas = cargadas;
  store._historialPendiente = true;

  _cargaEnCurso = true;
  const todo = (async () => {
    const results = [];
    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(([label, fn]) => _loadCollectionWithRetry(fn, label).then(() => { cargadas.add(label); }))
      );
      results.push(...batchResults);
    }
    store._historialPendiente = false;
    _cargaEnCurso = false;
    const failed = results
      .map((r, i) => ({ ok: r.status === 'fulfilled', label: tasks[i][0] }))
      .filter(x => !x.ok)
      .map(x => x.label);
    // Solo se actualiza la copia local si TODO llegó bien: con una carga
    // incompleta se pisaría la copia buena con listas vacías.
    if (!failed.length) saveLocalData();
    await syncOfflineQueue();
    if (failed.length) {
      console.error('[BazarHub] No se pudieron actualizar estas colecciones (se reintentó y siguió fallando):', failed);
      toast(`No se pudo actualizar: ${failed.join(', ')}. El resto de los datos sí está al día.`, 'warn');
    }
    return failed;
  })();

  let loadedFresh = false;
  let tardo = false;
  try {
    // Hasta 40s esperando todo junto (en uso normal, con la carga
    // incremental, tarda un par de segundos).
    await withTimeout(todo, 40000, 'cargar datos del sistema');
  } catch (e) {
    tardo = true;
    console.warn('[BazarHub] La carga se pasó de 40s:', e);
    _diagRegistrar('tiempo', 'la carga superó los 40 segundos');
  }
  const esencialesOk = cargadas.has('cajas') && cargadas.has('productos') && cargadas.has('usuarios');

  if (esencialesOk && !tardo) {
    loadedFresh = true;
  } else if (esencialesOk) {
    // Lo imprescindible ya llegó de Firebase: se puede usar la app. El
    // historial sigue bajando en segundo plano y al terminar se refresca
    // la pantalla (y mientras tanto no se deja cerrar la caja).
    toast('Terminando de cargar el historial… ya podés vender.', 'warn');
    if (store._offlineFallbackShown) { store._offlineFallbackShown = false; updateConnBadge(); }
    todo.then(() => {
      toast('Datos actualizados', 'ok');
      _rerenderPaginaActual();
    }).catch(() => {});
  } else {
    // No llegó ni lo imprescindible (la caja, los productos o los
    // usuarios): no se puede saber el estado real de la caja. Se muestran
    // los datos guardados, avisando bien claro, y sin dejar cerrar la caja.
    console.error('[BazarHub] No se pudieron cargar los datos esenciales de Firebase');
    store._historialPendiente = true;
    store._offlineFallbackShown = true;
    const hasLocal = loadLocalData();
    toast(hasLocal
      ? 'No se pudo conectar con Firebase. Se muestran datos guardados: NO abras ni cierres la caja hasta que diga "Datos actualizados". Tocá el cartel rojo de arriba para ver qué pasó y repararlo.'
      : 'No se pudo conectar con Firebase.', 'err');
    // Si la conexión termina respondiendo, se vuelve a cargar todo (ya
    // incremental, rápido) para reemplazar los datos guardados. Solo si
    // esta vez sí llegó todo: si Firebase sigue sin responder no se
    // reintenta en bucle; se vuelve a probar al reabrir la app.
    todo.then(failed => {
      if (failed && failed.length) { store._historialPendiente = true; return; }
      return loadFromFirebase().then(() => {
        toast('Datos actualizados', 'ok');
        _rerenderPaginaActual();
      });
    }).catch(() => {});
  }

  showLoadingOverlay(false);
  updateConnBadge();
  // Si veníamos mostrando el aviso de "sin conexión, usando datos locales"
  // (SDK de Firebase tardando en levantar o autenticación anónima
  // demorada) y ahora sí se pudo traer todo de Firebase, avisamos que ya
  // está al día — así no queda la duda de si se reconectó de verdad o
  // se sigue viendo información vieja.
  if (loadedFresh && store._offlineFallbackShown) {
    store._offlineFallbackShown = false;
    updateConnBadge();
    toast('Reconectado. Datos actualizados.', 'ok');
  }
}

// Vuelve a dibujar la página en la que está parado el usuario (después de
// que terminan de llegar datos en segundo plano).
function _rerenderPaginaActual() {
  try {
    if (!store.currentUser || typeof go !== 'function') return;
    const act = document.querySelector('.page.act');
    if (act && act.id && act.id.indexOf('page-') === 0) go(act.id.slice(5));
  } catch (e) {
    console.warn('No se pudo refrescar la pantalla:', e);
  }
}

async function _loadProducts() {
  const docs = await _syncCol('products');
  store.products = [];
  if (docs.length > 0) {
    docs.forEach(d => store.products.push({ ...d.data, id: parseInt(d.id) }));
    store.nextProdId = Math.max(...store.products.map(p => p.id), 7) + 1;
  }
}

async function _loadProveedores() {
  const docs = await _syncCol('proveedores');
  store.proveedores = [];
  if (docs.length > 0) {
    docs.forEach(d => store.proveedores.push({ ...d.data, id: parseInt(d.id) }));
    store.nextProvId = Math.max(...store.proveedores.map(p => p.id), 4) + 1;
  }
}

async function _loadSales() {
  const docs = await _syncCol('sales');
  store.sales = [];
  docs.forEach(d => store.sales.push({ ...d.data, id: parseInt(d.id) }));
  store.sales.sort((a, b) => a.id - b.id);
}

async function _loadOrders() {
  const docs = await _syncCol('orders');
  store.orders = [];
  docs.forEach(d => store.orders.push({ ...d.data, id: parseInt(d.id) }));
  store.nextOCId = store.orders.length ? Math.max(...store.orders.map(o => o.id), 0) + 1 : 1;
}

async function _loadMovimientos() {
  const docs = await _syncCol('movimientos');
  store.movimientos = [];
  docs.forEach(d => store.movimientos.push({ ...d.data, id: parseInt(d.id) }));
  store.movimientos.sort((a, b) => a.id - b.id);
  // null = historial completo; un número = solo hay movimientos con N° >= ese.
  try {
    const ctx = await _syncCtxPromise;
    const mir = ctx && ctx.mirrors && ctx.mirrors.movimientos;
    store.movimientosDesdeId = (mir && mir.parcial) ? mir.parcial.desdeId : null;
  } catch (e) { store.movimientosDesdeId = null; }
}

async function _loadCtaCte() {
  const docs = await _syncCol('ctacte');
  store.ctacteMovs = [];
  docs.forEach(d => store.ctacteMovs.push({ ...d.data, id: parseInt(d.id) }));
  store.nextCCId = store.ctacteMovs.length ? Math.max(...store.ctacteMovs.map(c => c.id), 0) + 1 : 1;
}

async function _loadRetiros() {
  const docs = await _syncCol('retiros');
  store.retiros = [];
  docs.forEach(d => store.retiros.push({ ...d.data, id: parseInt(d.id) }));
  store.nextRetiroId = store.retiros.length ? Math.max(...store.retiros.map(r => r.id), 0) + 1 : 1;
}

// FIX: _loadCajas restaura correctamente la caja abierta desde Firebase
async function _loadCajas() {
  const docs = await _syncCol('cajas');
  store.cajaHistory = [];
  docs.forEach(d => {
    // FIX: JSON.parse/stringify elimina undefined antes de guardar en el store
    const raw = d.data;
    const data = {
      id:           parseInt(d.id),
      cajeroId:     raw.cajeroId     || '',
      cajeroNombre: raw.cajeroNombre || '—',
      inicio:       raw.inicio       || '—',
      inicial:      raw.inicial      || 0,
      abierta:      raw.abierta      === true,
      nota:         raw.nota         || '',
      // Campos de cierre (solo presentes en cajas cerradas)
      ...(raw.abierta === false ? {
        ventasEf:     raw.ventasEf     || 0,
        totalRetiros: raw.totalRetiros || 0,
        esperado:     raw.esperado     || 0,
        contado:      raw.contado      || 0,
        diferencia:   raw.diferencia   || 0,
        cierre:       raw.cierre       || '—',
      } : {}),
    };
    store.cajaHistory.push(data);
  });
  store.cajaHistory.sort((a, b) => a.id - b.id);

  // FIX: restaurar caja abierta desde Firebase (fuente de verdad)
  const cajaAbiertaEnFirebase = store.cajaHistory.find(c => c.abierta === true);
  store.cajaAbierta = cajaAbiertaEnFirebase || null;
}

async function _loadConfig() {
  try {
    const doc = await db.collection('config').doc('saldo').get();
    if (doc.exists) store.saldoAnterior = doc.data().valor || 0;
  } catch(e) {
    console.warn('_loadConfig error:', e);
  }
}

async function _loadUsers() {
  await loadUsersFromFirebase();
  if (store.users.length) {
    store.nextUserId = Math.max(...store.users.map(u => parseInt(u.id.replace(/\D/g, '')) || 0), 9) + 1;
  }
}

async function _loadCombos() {
  let snap;
  try { snap = await db.collection('combos').get(); }
  catch(e) { store.combos = []; return; }
  _exigirServidor(snap, 'combos');
  store.combos = [];
  snap.forEach(d => store.combos.push({ ..._separarSello(d.data()).data, id: d.id }));
}

async function _loadDevoluciones() {
  try {
    const docs = await _syncCol('devoluciones');
    store.devoluciones = [];
    docs.forEach(d => store.devoluciones.push({ ...d.data, id: parseInt(d.id) }));
    store.nextDevId = store.devoluciones.length
      ? Math.max(...store.devoluciones.map(d => d.id), 0) + 1 : 1;
  } catch(e) { store.devoluciones = []; store.nextDevId = 1; }
}

// ===== OPERACIONES DE NEGOCIO =====

async function saveProduct(product)  { await saveDoc('products', product.id, product); }
async function removeProduct(id)     { await deleteDoc('products', id); }

// ===== ID DE VENTA A PRUEBA DE COLISIONES =====
// En vez de calcular el N° de venta con datos locales, se le pide un
// número a Firebase mediante una transacción atómica: garantiza que dos
// cajas pidiendo un número al mismo tiempo NUNCA reciban el mismo,
// sin importar qué tan vieja esté la pestaña de cada una.
//
// Todo en UN solo viaje de red (antes eran dos: una lectura suelta del
// contador + la transacción) para que pasar una venta no se sienta lento.
async function getNextSaleId() {
  if (!navigator.onLine || !db) {
    return store.sales.length ? Math.max(...store.sales.map(s => s.id)) + 1 : 1;
  }

  // Se guarda dentro de la colección 'config' (la misma que ya usa
  // saveSaldoConfig) en vez de una colección nueva '_counters', porque las
  // reglas de seguridad de Firestore solo permiten las colecciones que la
  // app ya usaba -una colección nueva quedaba bloqueada silenciosamente y
  // el código caia siempre al cálculo local (el mismo bug de antes).
  const counterRef = db.collection('config').doc('salesCounter');

  // Piso de seguridad: si el contador quedara atrasado respecto a las
  // ventas que ya existen en Firebase (por ejemplo, si algún dispositivo
  // viejo guardó ventas calculando el número por su cuenta en vez de pedirlo
  // acá -pasó una vez, ver el bug de los N° pisados-), usarlo tal cual
  // generaría números ya ocupados: cada uno chocaría en saveSale() y
  // obligaría a pedir uno nuevo, con un viaje de red de más por cada
  // choque. Usando como piso el máximo de venta que YA tenemos cargado en
  // este dispositivo, el contador se pone al día solo en este mismo viaje
  // de red, sin necesidad de ir chocando de a uno.
  const maxLocalConocido = store.sales.length ? Math.max(...store.sales.map(s => s.id)) : 0;

  try {
    return await withTimeout(db.runTransaction(async (tx) => {
      const snap = await tx.get(counterRef);
      const actual = snap.exists ? (snap.data().value || 0) : 0;
      const next = Math.max(actual, maxLocalConocido) + 1;
      tx.set(counterRef, { value: next });
      return next;
    }), 6000, 'obtener N° de venta');
  } catch (e) {
    console.warn('No se pudo usar el contador atómico de ventas, se usa el cálculo local:', e);
    return store.sales.length ? Math.max(...store.sales.map(s => s.id)) + 1 : 1;
  }
}

async function saveSale(sale, updatedProducts, newMovimientos) {
  saveLocalData();
  if (!navigator.onLine || !db) {
    addToOfflineQueue({ type: 'batch', items: [
      { type: 'set', col: 'sales',       id: String(sale.id), data: sale },
      ...updatedProducts.map(p => ({ type: 'set', col: 'products',    id: String(p.id), data: p })),
      ...newMovimientos.map(m => ({ type: 'set', col: 'movimientos',  id: String(m.id), data: m })),
    ]});
    return;
  }

  // Guarda todo (venta + productos + movimientos) en UNA sola transacción,
  // que de paso comprueba que el N° de venta esté realmente libre antes de
  // escribir -así no hace falta un viaje de red aparte solo para chequear.
  // Esta es la segunda red de seguridad además de getNextSaleId(): si por
  // lo que sea (una pestaña con el código viejo, una falla de red que hizo
  // caer al cálculo local, etc.) dos ventas llegan a calcular el mismo
  // número, ACÁ se corta en vez de pisar (destruir) la venta que ya
  // existía: se le asigna uno nuevo a ESTA venta y se reintenta. Así una
  // venta real nunca vuelve a desaparecer en silencio.
  for (let intento = 1; intento <= 5; intento++) {
    try {
      await withTimeout(db.runTransaction(async (tx) => {
        const saleRef  = db.collection('sales').doc(String(sale.id));
        const yaExiste = await tx.get(saleRef);
        if (yaExiste.exists) {
          const err = new Error('sale-id-taken');
          err.colision = true;
          throw err;
        }
        tx.set(saleRef, sale);
        updatedProducts.forEach(p => tx.set(db.collection('products').doc(String(p.id)), p));
        newMovimientos.forEach(m => tx.set(db.collection('movimientos').doc(String(m.id)), m));
      }), 8000, 'guardar venta');
      saveLocalData();
      return;
    } catch(e) {
      if (e && e.colision) {
        console.warn(`N° de venta #${sale.id} ya estaba usado, se pide uno nuevo (intento ${intento})`);
        sale.id = await getNextSaleId();
        continue;
      }
      console.error('saveSale error:', e);
      addToOfflineQueue({ type: 'batch', items: [
        { type: 'set', col: 'sales',      id: String(sale.id), data: sale },
        ...updatedProducts.map(p => ({ type: 'set', col: 'products',   id: String(p.id), data: p })),
        ...newMovimientos.map(m => ({ type: 'set', col: 'movimientos', id: String(m.id), data: m })),
      ]});
      return;
    }
  }

  // Si después de varios intentos seguimos chocando, algo más raro está
  // pasando (ej. muchísimas cajas vendiendo a la vez): igual guardamos la
  // venta con el último número que conseguimos, en vez de perderla por
  // completo, y lo dejamos anotado en la consola para poder revisarlo.
  console.error(`saveSale: no se consiguió un N° de venta libre después de varios intentos, se guarda igual con #${sale.id}`);
  addToOfflineQueue({ type: 'batch', items: [
    { type: 'set', col: 'sales',      id: String(sale.id), data: sale },
    ...updatedProducts.map(p => ({ type: 'set', col: 'products',   id: String(p.id), data: p })),
    ...newMovimientos.map(m => ({ type: 'set', col: 'movimientos', id: String(m.id), data: m })),
  ]});
}

async function saveStockAdjustment(product, movimiento) {
  await saveDoc('products',    product.id,    product);
  await saveDoc('movimientos', movimiento.id, movimiento);
}

async function saveProveedor(proveedor) { await saveDoc('proveedores', proveedor.id, proveedor); }

async function removeProveedor(id, affectedProducts) {
  saveLocalData();
  if (!navigator.onLine || !db) {
    addToOfflineQueue({ type: 'batch', items: [
      { type: 'delete', col: 'proveedores', id: String(id) },
      ...affectedProducts.map(p => ({ type: 'set', col: 'products', id: String(p.id), data: p })),
    ]});
    return;
  }
  try {
    const batch = db.batch();
    batch.delete(db.collection('proveedores').doc(String(id)));
    affectedProducts.forEach(p => batch.set(db.collection('products').doc(String(p.id)), p));
    await withTimeout(batch.commit(), 10000, 'eliminar proveedor');
  } catch(e) {
    addToOfflineQueue({ type: 'batch', items: [
      { type: 'delete', col: 'proveedores', id: String(id) },
      ...affectedProducts.map(p => ({ type: 'set', col: 'products', id: String(p.id), data: p })),
    ]});
  }
}

async function saveOrder(order, ctaMov) {
  await saveDoc('orders', order.id, order);
  await saveDoc('ctacte', ctaMov.id, ctaMov);
}

async function updateOrder(order, updatedProducts, newMovimientos) {
  saveLocalData();
  if (!navigator.onLine || !db) {
    addToOfflineQueue({ type: 'batch', items: [
      { type: 'set', col: 'orders', id: String(order.id), data: order },
      ...updatedProducts.map(p => ({ type: 'set', col: 'products',   id: String(p.id), data: p })),
      ...newMovimientos.map(m => ({ type: 'set', col: 'movimientos', id: String(m.id), data: m })),
    ]});
    return;
  }
  try {
    const batch = db.batch();
    batch.set(db.collection('orders').doc(String(order.id)), order);
    updatedProducts.forEach(p => batch.set(db.collection('products').doc(String(p.id)), p));
    newMovimientos.forEach(m => batch.set(db.collection('movimientos').doc(String(m.id)), m));
    await withTimeout(batch.commit(), 10000, 'guardar pedido');
  } catch(e) {
    addToOfflineQueue({ type: 'batch', items: [
      { type: 'set', col: 'orders', id: String(order.id), data: order },
      ...updatedProducts.map(p => ({ type: 'set', col: 'products',   id: String(p.id), data: p })),
      ...newMovimientos.map(m => ({ type: 'set', col: 'movimientos', id: String(m.id), data: m })),
    ]});
  }
}

async function cancelOrderInDB(order)  { await saveDoc('orders', order.id, order); }
async function savePagoCtaCte(pago)    { await saveDoc('ctacte', pago.id, pago); }

// FIX: saveCaja elimina campos undefined antes de guardar en Firestore
async function saveCaja(caja) {
  // JSON.parse/stringify elimina undefined → Firestore no los rechaza
  const safe = JSON.parse(JSON.stringify(caja));
  await saveDoc('cajas', safe.id, safe);
  saveLocalData();
}

async function saveSaldoConfig(valor)  { await saveDoc('config', 'saldo', { valor }); }
async function saveRetiroDoc(retiro)   { await saveDoc('retiros', retiro.id, retiro); saveLocalData(); }

async function saveUser(user) {
  const safeUser = { ...user };
  delete safeUser.pass;
  await saveDoc('users', safeUser.id, safeUser);
}

async function removeUser(id)          { await deleteDoc('users', id); }
async function saveMovimiento(m)       { await saveDoc('movimientos', m.id, m); }
async function removeMovimiento(id)    { await deleteDoc('movimientos', id); }
