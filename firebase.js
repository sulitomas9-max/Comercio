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

function saveLocalData() {
  try {
    const snapshot = {
      products:     store.products,
      proveedores:  store.proveedores,
      sales:        store.sales,
      cajaHistory:  store.cajaHistory,
      retiros:      store.retiros,
      movimientos:  store.movimientos,
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
  }
}

function loadLocalData() {
  try {
    const raw = localStorage.getItem(OFFLINE_DATA_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (Date.now() - s.savedAt > 7 * 24 * 60 * 60 * 1000) return false;
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
  if (typeof firebase === 'undefined') {
    console.error('Firebase SDK no cargado');
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
  db   = firebase.firestore();
  auth = firebase.auth();

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
function waitForFirebase(callback, tries = 0) {
  if (typeof firebase === 'undefined' || !initFirebase()) {
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
function _ensureAuth(callback) {
  if (auth.currentUser) {
    callback();
    return;
  }
  // 15s en vez de 10s: en conexiones móviles (4G/5G con señal débil) la
  // autenticación anónima puede tardar más de 10s sin que la conexión esté
  // realmente caída, y con el límite viejo eso se mostraba como "sin
  // conexión" antes de tiempo.
  withTimeout(auth.signInAnonymously(), 15000, 'autenticación anónima')
    .then(() => {
      callback();
    })
    .catch(err => {
      console.error('Auth anónima falló:', err);
      // Si falla la auth (ej. sin internet), intentar con caché local
      const hasLocal = loadLocalData();
      if (hasLocal) {
        store._offlineFallbackShown = true;
        toast('Sin conexión. Usando datos guardados localmente.', 'warn');
        updateConnBadge();
        callback();
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
const _SYNC_FULL_EVERY_MS  = 7 * 24 * 60 * 60 * 1000;
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

function _syncTsDesde(ms) {
  return firebase.firestore.Timestamp.fromMillis(Math.max(0, (ms || 0) - _SYNC_MARGEN_MS));
}

function _syncCopiaValida(m) {
  return !!(m && m.v === _SYNC_SCHEMA && m.docs && m.fullAt &&
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

  if (!anterior) {
    // Carga completa
    const snap = await db.collection(col).get();
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
    m = { v: _SYNC_SCHEMA, docs, wm, wmB, fullAt: anterior.fullAt };
    // Sin novedades: no hace falta volver a escribir la copia local entera.
    hayCambios = cambios > 0 || wm !== anterior.wm || wmB !== anterior.wmB;
  }

  ctx.mirrors[col] = m;
  if (hayCambios) _syncIdbPut(col, m).catch(e => console.warn('[BazarHub] No se pudo guardar la copia local de ' + col + ':', e));
  return Object.keys(m.docs).map(id => ({ id, data: m.docs[id].d }));
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

async function loadUsersFromFirebase() {
  if (!db || !auth.currentUser) {
    _loadUsersFromLocalStorage();
    return;
  }
  try {
    const snap = await withTimeout(db.collection('users').get(), 10000, 'cargar usuarios');
    store.users = [];
    snap.forEach(d => store.users.push({ ..._separarSello(d.data()).data, id: d.id }));
    const needsMigration = store.users.some(u => u.pass && !u.passHash);
    if (needsMigration) console.warn('[BazarHub] Hay usuarios con contraseñas en texto plano.');
  } catch(e) {
    console.error('loadUsersFromFirebase error:', e);
    _loadUsersFromLocalStorage();
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
      await withTimeout(loadFn(), 10000, label);
      return;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, 600));
      }
    }
  }
  console.error(`[BazarHub] "${label}" falló tras ${attempts} intentos:`, lastErr);
  throw lastErr;
}

async function loadFromFirebase() {
  if (!db || !navigator.onLine) {
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
  let loadedFresh = false;
  // Una lectura nueva de copias locales + borrados por cada carga.
  _syncCtxPromise = _iniciarSync();
  try {
    // Las ~11 colecciones son independientes entre sí (cada una llena su
    // propia parte de "store" y ninguna necesita el resultado de otra).
    // Antes, con miles de ventas/movimientos ya cargados, cada colección
    // sumaba su propio viaje de ida y vuelta a Firestore en fila (12
    // esperas seguidas), y eso solo -sin ningún problema de conexión- ya
    // tardaba muchos segundos.
    //
    // Se probó pedir las 12 al mismo tiempo (paralelo total), pero en una
    // conexión floja (4G/5G o wifi con señal débil) eso hace que las 12
    // compitan por el mismo ancho de banda a la vez: ninguna llega a tiempo
    // y varias timeoutean juntas (justo lo que mostraba el toast "No se
    // pudo actualizar: proveedores, ventas, pedidos..."). Las únicas que
    // solían salvarse eran las colecciones chicas (productos, usuarios),
    // que por su tamaño responden rápido incluso compitiendo por ancho de
    // banda con las demás.
    //
    // Ahora se piden en TANDAS de a BATCH_SIZE en paralelo (no las 12 juntas,
    // pero tampoco una por una): cada tanda espera a que termine antes de
    // arrancar la siguiente, así nunca hay más de BATCH_SIZE pedidos
    // compitiendo por la conexión al mismo tiempo, pero se sigue
    // aprovechando el paralelismo dentro de cada tanda.
    //
    // Cada colección sigue teniendo su propio reintento (si falla, se
    // prueba una vez más) y se usa Promise.allSettled en vez de Promise.all:
    // una colección que sigue fallando después del reintento no tira abajo
    // a las demás, que ya quedaron cargadas y actualizadas en "store".
    //
    // Sigue protegido además con un único límite de tiempo total: si
    // Firestore se cuelga de verdad (conexión realmente caída, problema
    // general del servicio, etc.), se corta todo y se usan los datos
    // guardados localmente en vez de quedarse en "Cargando datos..." para
    // siempre. Con tandas en vez de todo-junto, el peor caso tarda más
    // (hasta 3 tandas en fila en vez de 1), así que el límite total también
    // se subió de 25s a 45s para darle ese margen.
    const BATCH_SIZE = 4;
    await withTimeout((async () => {
      const tasks = [
        ['productos', _loadProducts],
        ['proveedores', _loadProveedores],
        ['ventas', _loadSales],
        ['pedidos', _loadOrders],
        ['movimientos', _loadMovimientos],
        ['cuenta corriente', _loadCtaCte],
        ['retiros', _loadRetiros],
        ['cajas', _loadCajas],
        ['configuración', _loadConfig],
        ['usuarios', _loadUsers],
        ['devoluciones', _loadDevoluciones],
        ['combos', _loadCombos],
      ];

      const results = [];
      for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
        const batch = tasks.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(([label, fn]) => _loadCollectionWithRetry(fn, label))
        );
        results.push(...batchResults);
      }

      saveLocalData();
      await syncOfflineQueue();

      const failed = results
        .map((r, i) => ({ ok: r.status === 'fulfilled', label: tasks[i][0] }))
        .filter(x => !x.ok)
        .map(x => x.label);
      if (failed.length) {
        console.error('[BazarHub] No se pudieron actualizar estas colecciones (se reintentó y siguió fallando):', failed);
        toast(`No se pudo actualizar: ${failed.join(', ')}. El resto de los datos sí está al día.`, 'warn');
      }
    })(), 45000, 'cargar datos del sistema');
    loadedFresh = true;
  } catch(e) {
    console.error('loadFromFirebase error:', e);
    toast('Error cargando. Usando datos locales.', 'warn');
    loadLocalData();
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
    toast('Reconectado. Datos actualizados.', 'ok');
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
  try {
    const snap = await db.collection('combos').get();
    store.combos = [];
    snap.forEach(d => store.combos.push({ ..._separarSello(d.data()).data, id: d.id }));
  } catch(e) { store.combos = []; }
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
