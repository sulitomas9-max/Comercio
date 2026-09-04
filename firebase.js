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

async function syncOfflineQueue() {
  const queue = getOfflineQueue();
  if (!queue.length || !navigator.onLine || !db) return;
  updateConnBadge();
  const failed = [];
  for (const op of queue) {
    try {
      if (op.type === 'set') {
        await withTimeout(db.collection(op.col).doc(String(op.id)).set(op.data), 10000, 'sincronizar ' + op.col);
      } else if (op.type === 'delete') {
        await withTimeout(db.collection(op.col).doc(String(op.id)).delete(), 10000, 'sincronizar ' + op.col);
      } else if (op.type === 'batch') {
        const batch = db.batch();
        for (const item of op.items) {
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
    snap.forEach(d => store.users.push({ ...d.data(), id: d.id }));
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
  try {
    // Las ~11 colecciones son independientes entre sí (cada una llena su
    // propia parte de "store" y ninguna necesita el resultado de otra), así
    // que se piden todas al mismo tiempo en vez de una atrás de la otra.
    // Antes, con miles de ventas/movimientos ya cargados, cada colección
    // sumaba su propio viaje de ida y vuelta a Firestore en fila (12
    // esperas seguidas), y eso solo -sin ningún problema de conexión- ya
    // tardaba muchos segundos. Pedirlas en paralelo hace que el tiempo
    // total sea el de la colección más lenta, no la suma de todas.
    //
    // OJO con Promise.all "a secas" acá: si UNA sola de las 12 fallaba
    // (por ej. un timeout puntual de esa colección en particular, con el
    // resto respondiendo bien), Promise.all se rechazaba entera y el catch
    // de más abajo tiraba TODO lo ya cargado a la basura para volver a los
    // datos guardados en el celular -aunque 11 de las 12 colecciones ya
    // hubiesen llegado bien-. En una conexión de por sí floja (4G/5G con
    // señal débil), pedir 12 cosas a la vez hace más probable que alguna
    // puntual se caiga, así que este "todo o nada" terminaba mostrando
    // "Error cargando. Usando datos locales." muy seguido incluso cuando
    // la carga real casi había terminado bien. Ahora cada colección tiene
    // su propio reintento (si falla, se prueba una vez más) y se usa
    // Promise.allSettled en vez de Promise.all: una colección que sigue
    // fallando después del reintento no tira abajo a las demás, que ya
    // quedaron cargadas y actualizadas en "store".
    //
    // Sigue protegido además con un único límite de tiempo total: si
    // Firestore se cuelga de verdad (conexión realmente caída, problema
    // general del servicio, etc.), a los 25s se corta todo y se usan los
    // datos guardados localmente en vez de quedarse en "Cargando datos..."
    // para siempre.
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
      const results = await Promise.allSettled(
        tasks.map(([label, fn]) => _loadCollectionWithRetry(fn, label))
      );
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
    })(), 25000, 'cargar datos del sistema');
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
  const snap = await db.collection('products').get();
  store.products = [];
  if (snap.size > 0) {
    snap.forEach(d => store.products.push({ ...d.data(), id: parseInt(d.id) }));
    store.nextProdId = Math.max(...store.products.map(p => p.id), 7) + 1;
  }
}

async function _loadProveedores() {
  const snap = await db.collection('proveedores').get();
  store.proveedores = [];
  if (snap.size > 0) {
    snap.forEach(d => store.proveedores.push({ ...d.data(), id: parseInt(d.id) }));
    store.nextProvId = Math.max(...store.proveedores.map(p => p.id), 4) + 1;
  }
}

async function _loadSales() {
  const snap = await db.collection('sales').get();
  store.sales = [];
  snap.forEach(d => store.sales.push({ ...d.data(), id: parseInt(d.id) }));
  store.sales.sort((a, b) => a.id - b.id);
}

async function _loadOrders() {
  const snap = await db.collection('orders').get();
  store.orders = [];
  snap.forEach(d => store.orders.push({ ...d.data(), id: parseInt(d.id) }));
  store.nextOCId = store.orders.length ? Math.max(...store.orders.map(o => o.id), 0) + 1 : 1;
}

async function _loadMovimientos() {
  const snap = await db.collection('movimientos').get();
  store.movimientos = [];
  snap.forEach(d => store.movimientos.push({ ...d.data(), id: parseInt(d.id) }));
  store.movimientos.sort((a, b) => a.id - b.id);
}

async function _loadCtaCte() {
  const snap = await db.collection('ctacte').get();
  store.ctacteMovs = [];
  snap.forEach(d => store.ctacteMovs.push({ ...d.data(), id: parseInt(d.id) }));
  store.nextCCId = store.ctacteMovs.length ? Math.max(...store.ctacteMovs.map(c => c.id), 0) + 1 : 1;
}

async function _loadRetiros() {
  const snap = await db.collection('retiros').get();
  store.retiros = [];
  snap.forEach(d => store.retiros.push({ ...d.data(), id: parseInt(d.id) }));
  store.nextRetiroId = store.retiros.length ? Math.max(...store.retiros.map(r => r.id), 0) + 1 : 1;
}

// FIX: _loadCajas restaura correctamente la caja abierta desde Firebase
async function _loadCajas() {
  const snap = await db.collection('cajas').get();
  store.cajaHistory = [];
  snap.forEach(d => {
    // FIX: JSON.parse/stringify elimina undefined antes de guardar en el store
    const raw = d.data();
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
    snap.forEach(d => store.combos.push({ ...d.data(), id: d.id }));
  } catch(e) { store.combos = []; }
}

async function _loadDevoluciones() {
  try {
    const snap = await db.collection('devoluciones').get();
    store.devoluciones = [];
    snap.forEach(d => store.devoluciones.push({ ...d.data(), id: parseInt(d.id) }));
    store.nextDevId = store.devoluciones.length
      ? Math.max(...store.devoluciones.map(d => d.id), 0) + 1 : 1;
  } catch(e) { store.devoluciones = []; store.nextDevId = 1; }
}

// ===== OPERACIONES DE NEGOCIO =====

async function saveProduct(product)  { await saveDoc('products', product.id, product); }
async function removeProduct(id)     { await deleteDoc('products', id); }

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
  try {
    const batch = db.batch();
    batch.set(db.collection('sales').doc(String(sale.id)), sale);
    updatedProducts.forEach(p => batch.set(db.collection('products').doc(String(p.id)), p));
    newMovimientos.forEach(m => batch.set(db.collection('movimientos').doc(String(m.id)), m));
    await withTimeout(batch.commit(), 10000, 'guardar venta');
    saveLocalData();
  } catch(e) {
    console.error('saveSale error:', e);
    addToOfflineQueue({ type: 'batch', items: [
      { type: 'set', col: 'sales',      id: String(sale.id), data: sale },
      ...updatedProducts.map(p => ({ type: 'set', col: 'products',   id: String(p.id), data: p })),
      ...newMovimientos.map(m => ({ type: 'set', col: 'movimientos', id: String(m.id), data: m })),
    ]});
  }
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
