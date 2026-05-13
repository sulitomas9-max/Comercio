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
    store.cajaHistory  = s.cajaHistory  || [];
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
        await db.collection(op.col).doc(String(op.id)).set(op.data);
      } else if (op.type === 'delete') {
        await db.collection(op.col).doc(String(op.id)).delete();
      } else if (op.type === 'batch') {
        const batch = db.batch();
        for (const item of op.items) {
          if (item.type === 'set')
            batch.set(db.collection(item.col).doc(String(item.id)), item.data);
          else if (item.type === 'delete')
            batch.delete(db.collection(item.col).doc(String(item.id)));
        }
        await batch.commit();
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

  // Persistencia offline de Firestore (caché adicional del SDK)
  db.enablePersistence({ synchronizeTabs: true }).catch(err => {
    if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
      console.warn('Persistencia Firestore:', err.code);
    }
  });

  return true;
}

/**
 * Espera a que Firebase esté listo Y el usuario esté autenticado anónimamente.
 * Solo después llama al callback.
 */
function waitForFirebase(callback, tries = 0) {
  if (typeof firebase === 'undefined' || !initFirebase()) {
    if (tries < 30) {
      setTimeout(() => waitForFirebase(callback, tries + 1), 200);
    } else {
      // Sin Firebase: intentar con caché local
      const hasLocal = loadLocalData();
      if (hasLocal) {
        toast('Sin conexión. Usando datos guardados localmente.', 'warn');
        updateConnBadge();
        callback();
      } else {
        toast('No se pudo conectar a Firebase y no hay datos locales.', 'err');
        showLoadingOverlay(false);
      }
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
  auth.signInAnonymously()
    .then(() => {
      callback();
    })
    .catch(err => {
      console.error('Auth anónima falló:', err);
      // Si falla la auth (ej. sin internet), intentar con caché local
      const hasLocal = loadLocalData();
      if (hasLocal) {
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
    await db.collection(col).doc(String(id)).set(data);
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
    await db.collection(col).doc(String(id)).delete();
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

async function loadUsersFromFirebase() {
  if (!db || !auth.currentUser) {
    loadLocalData();
    return;
  }
  try {
    const snap = await db.collection('users').get();
    store.users = [];
    snap.forEach(d => store.users.push({ ...d.data(), id: d.id }));
    const needsMigration = store.users.some(u => u.pass && !u.passHash);
    if (needsMigration) console.warn('[BazarHub] Hay usuarios con contraseñas en texto plano.');
  } catch(e) {
    console.error('loadUsersFromFirebase error:', e);
    loadLocalData();
  }
}

// ===== CARGA INICIAL (post-login BazarHub) =====

async function loadFromFirebase() {
  if (!db || !navigator.onLine) {
    const hasLocal = loadLocalData();
    if (hasLocal) {
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
  try {
    await _loadProducts();
    await _loadProveedores();
    await _loadSales();
    await _loadOrders();
    await _loadMovimientos();
    await _loadCtaCte();
    await _loadRetiros();
    await _loadCajas();
    await _loadConfig();
    await _loadUsers();
    await _loadDevoluciones();
    await _loadCombos();
    saveLocalData();
    await syncOfflineQueue();
  } catch(e) {
    console.error('loadFromFirebase error:', e);
    toast('Error cargando. Usando datos locales.', 'warn');
    loadLocalData();
  }

  showLoadingOverlay(false);
  updateConnBadge();
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
  const doc = await db.collection('config').doc('saldo').get();
  if (doc.exists) store.saldoAnterior = doc.data().valor || 0;
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
    await batch.commit();
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
    await batch.commit();
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
    await batch.commit();
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
