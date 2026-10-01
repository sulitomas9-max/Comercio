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
  if (!_reparacionLista) { setTimeout(() => waitForFirebase(callback, tries), 100); return; }
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
      _diagRegistrar('autenticación', err);
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

  if (!anterior) {
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
    const snap = _exigirServidor(await withTimeout(db.collection('users').get(), 10000, 'cargar usuarios'), 'usuarios');
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

function _diagRegistrar(etiqueta, err) {
  try {
    store._diagCarga = store._diagCarga || {};
    store._diagCarga[etiqueta] = String((err && err.message) || err || 'error').slice(0, 160);
  } catch (e) {}
}

function _diagEscapar(t) {
  return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function _diagTexto() {
  const L = [];
  const errores = store._diagCarga || {};
  const ok = store._diagCargadas ? Array.from(store._diagCargadas) : [];
  L.push('Internet del dispositivo: ' + (navigator.onLine ? 'sí' : 'NO'));
  L.push('Firebase iniciado: ' + (db ? 'sí' : 'NO'));
  try { L.push('Sesión Firebase: ' + (auth && auth.currentUser ? 'sí (' + String(auth.currentUser.uid).slice(0, 6) + ')' : 'NO')); } catch (e) {}
  if (ok.length) L.push('Cargado bien: ' + ok.join(', '));
  const fallas = Object.keys(errores);
  if (fallas.length) fallas.forEach(k => L.push('Falló ' + k + ': ' + errores[k]));
  else if (store._offlineFallbackShown) L.push('Sin detalle de error (la carga no terminó).');
  try { if (navigator.connection) L.push('Red: ' + (navigator.connection.effectiveType || '?')); } catch (e) {}
  L.push('Archivos: firebase.js v23 · ' + (navigator.userAgent.match(/(iPhone|iPad|Android|Windows|Macintosh|Linux)/) || ['?'])[0]);
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
        '<button class="btn" id="diag-reintentar">Reintentar</button>' +
        '<button class="btn red" id="diag-reparar">Reparar</button>' +
      '</div>' +
    '</div>';
  m.classList.add('on');
  document.getElementById('diag-cerrar').onclick = () => m.classList.remove('on');
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

async function repararDatosLocales() {
  const btn = document.getElementById('diag-reparar');
  if (btn) { btn.disabled = true; btn.textContent = 'Reparando…'; }
  const paso = async (fn) => { try { await withTimeout(Promise.resolve().then(fn), 4000, 'reparar'); } catch (e) {} };

  try { localStorage.setItem(_REPARAR_FLAG, '1'); } catch (e) {}
  // Service worker y caché de archivos (se vuelven a bajar de la red).
  await paso(async () => {
    if ('serviceWorker' in navigator) (await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
  });
  await paso(async () => {
    if (window.caches) (await caches.keys()).forEach(k => caches.delete(k));
  });
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
