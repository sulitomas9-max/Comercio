/**
 * firebase.js
 * Maneja la conexión a Firebase y las operaciones CRUD base.
 * La config se lee desde window.FIREBASE_CONFIG para no hardcodear credenciales.
 */

let db = null;

/**
 * Inicializa Firebase. La configuración debe estar definida ANTES de cargar este
 * archivo, en un script separado:
 *
 *   window.FIREBASE_CONFIG = {
 *     apiKey: "...",
 *     authDomain: "...",
 *     projectId: "...",
 *     storageBucket: "...",
 *     messagingSenderId: "...",
 *     appId: "..."
 *   };
 *
 * De esta forma las credenciales no quedan en el código fuente versionado.
 */
function initFirebase() {
  if (typeof firebase === 'undefined') {
    console.error('Firebase SDK no cargado');
    return false;
  }
  if (db) return true;

  const config = window.FIREBASE_CONFIG;
  if (!config) {
    console.error('window.FIREBASE_CONFIG no definido. Creá un archivo config.js con tus credenciales.');
    return false;
  }

  if (!firebase.apps.length) {
    firebase.initializeApp(config);
  }
  db = firebase.firestore();
  return true;
}

/**
 * Espera a que el SDK de Firebase esté disponible e inicializado.
 * Reintenta hasta 30 veces (cada 200ms) antes de fallar.
 */
function waitForFirebase(callback, tries = 0) {
  if (typeof firebase !== 'undefined' && initFirebase()) {
    callback();
  } else if (tries < 30) {
    setTimeout(() => waitForFirebase(callback, tries + 1), 200);
  } else {
    toast('No se pudo conectar a Firebase. Verificá tu conexión.', 'err');
    showLoadingOverlay(false);
  }
}

// ===== CRUD GENÉRICO =====

async function saveDoc(collection, id, data) {
  try {
    await db.collection(collection).doc(String(id)).set(data);
  } catch (e) {
    console.error('saveDoc error:', collection, id, e);
  }
}

async function deleteDoc(collection, id) {
  try {
    await db.collection(collection).doc(String(id)).delete();
  } catch (e) {
    console.error('deleteDoc error:', collection, id, e);
  }
}

async function getCollection(collection) {
  const snap = await db.collection(collection).get();
  const docs = [];
  snap.forEach(d => docs.push({ ...d.data(), id: d.id }));
  return docs;
}

// ===== CARGA INICIAL =====

/**
 * Carga todos los datos desde Firebase al iniciar sesión.
 * Si una colección está vacía (primer uso), sube los datos demo.
 */
async function loadFromFirebase() {
  if (!db) {
    toast('Error de conexión', 'err');
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
  } catch (e) {
    console.error('loadFromFirebase error:', e);
    toast('Error cargando datos. Verificá la conexión.', 'err');
  }

  showLoadingOverlay(false);
}

async function _loadProducts() {
  const snap = await db.collection('products').get();
  if (snap.size > 0) {
    store.products = [];
    snap.forEach(d => store.products.push({ ...d.data(), id: parseInt(d.id) }));
    store.nextProdId = Math.max(...store.products.map(p => p.id), 7) + 1;
  } else {
    // Primer uso: guardar productos demo
    const batch = db.batch();
    store.products.forEach(p => batch.set(db.collection('products').doc(String(p.id)), p));
    await batch.commit();
  }
}

async function _loadProveedores() {
  const snap = await db.collection('proveedores').get();
  if (snap.size > 0) {
    store.proveedores = [];
    snap.forEach(d => store.proveedores.push({ ...d.data(), id: parseInt(d.id) }));
    store.nextProvId = Math.max(...store.proveedores.map(p => p.id), 4) + 1;
  } else {
    const batch = db.batch();
    store.proveedores.forEach(p => batch.set(db.collection('proveedores').doc(String(p.id)), p));
    await batch.commit();
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

async function _loadCajas() {
  const snap = await db.collection('cajas').get();
  store.cajaHistory = [];
  snap.forEach(d => store.cajaHistory.push({ ...d.data(), id: parseInt(d.id) }));
  store.cajaHistory.sort((a, b) => a.id - b.id);
}

async function _loadConfig() {
  const saldoDoc = await db.collection('config').doc('saldo').get();
  if (saldoDoc.exists) store.saldoAnterior = saldoDoc.data().valor || 0;
}

async function _loadUsers() {
  const snap = await db.collection('users').get();
  if (snap.size > 0) {
    store.users = [];
    snap.forEach(d => store.users.push({ ...d.data(), id: d.id }));
  } else {
    const batch = db.batch();
    store.users.forEach(u => batch.set(db.collection('users').doc(u.id), u));
    await batch.commit();
  }
}

// ===== OPERACIONES DE NEGOCIO CON PERSISTENCIA =====

async function saveProduct(product) {
  await saveDoc('products', product.id, product);
}

async function removeProduct(id) {
  await deleteDoc('products', id);
}

async function saveSale(sale, updatedProducts, newMovimientos) {
  const batch = db.batch();
  batch.set(db.collection('sales').doc(String(sale.id)), sale);
  updatedProducts.forEach(p => batch.set(db.collection('products').doc(String(p.id)), p));
  newMovimientos.forEach(m => batch.set(db.collection('movimientos').doc(String(m.id)), m));
  await batch.commit();
}

async function saveStockAdjustment(product, movimiento) {
  await saveDoc('products', product.id, product);
  await saveDoc('movimientos', movimiento.id, movimiento);
}

async function saveProveedor(proveedor) {
  await saveDoc('proveedores', proveedor.id, proveedor);
}

async function removeProveedor(id, affectedProducts) {
  const batch = db.batch();
  batch.delete(db.collection('proveedores').doc(String(id)));
  affectedProducts.forEach(p => batch.set(db.collection('products').doc(String(p.id)), p));
  await batch.commit();
}

async function saveOrder(order, ctaMov) {
  await saveDoc('orders', order.id, order);
  await saveDoc('ctacte', ctaMov.id, ctaMov);
}

async function updateOrder(order, updatedProducts, newMovimientos) {
  const batch = db.batch();
  batch.set(db.collection('orders').doc(String(order.id)), order);
  updatedProducts.forEach(p => batch.set(db.collection('products').doc(String(p.id)), p));
  newMovimientos.forEach(m => batch.set(db.collection('movimientos').doc(String(m.id)), m));
  await batch.commit();
}

async function cancelOrderInDB(order) {
  await saveDoc('orders', order.id, order);
}

async function savePagoCtaCte(pago) {
  await saveDoc('ctacte', pago.id, pago);
}

async function saveCaja(caja) {
  await saveDoc('cajas', caja.id, caja);
}

async function saveSaldoConfig(valor) {
  await saveDoc('config', 'saldo', { valor });
}

async function saveRetiroDoc(retiro) {
  await saveDoc('retiros', retiro.id, retiro);
}

async function saveUser(user) {
  await saveDoc('users', user.id, user);
}

async function removeUser(id) {
  await deleteDoc('users', id);
}

async function saveMovimiento(movimiento) {
  await saveDoc('movimientos', movimiento.id, movimiento);
}

async function removeMovimiento(id) {
  await deleteDoc('movimientos', id);
}
