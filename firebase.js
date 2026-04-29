/**
 * firebase.js — BazarHub
 * Maneja la conexión a Firebase y las operaciones CRUD base.
 * La config se lee desde window.FIREBASE_CONFIG para no hardcodear credenciales.
 */

let db = null;

/**
 * Inicializa Firebase. La configuración debe estar definida ANTES de cargar este
 * archivo, en un script separado (config.js — NO subir a GitHub):
 *
 * window.FIREBASE_CONFIG = {
 *   apiKey: "...",
 *   authDomain: "...",
 *   projectId: "...",
 *   storageBucket: "...",
 *   messagingSenderId: "...",
 *   appId: "..."
 * };
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

// ===== CARGA DE USUARIOS (antes del login) =====

/**
 * Carga SOLO los usuarios desde Firebase.
 * Se llama al arrancar la app, antes de mostrar el login,
 * para saber qué usuarios existen (y si hay que mostrar el wizard).
 * No requiere que el usuario esté logueado.
 */
async function loadUsersFromFirebase() {
  if (!db) return;
  try {
    const snap = await db.collection('users').get();
    store.users = [];
    snap.forEach(d => store.users.push({ ...d.data(), id: d.id }));

    // Migración: si algún usuario tiene contraseña en texto plano (campo 'pass'),
    // lo marcamos para que el admin lo actualice (no lo borramos automáticamente
    // para no romper el acceso).
    const needsMigration = store.users.some(u => u.pass && !u.passHash);
    if (needsMigration) {
      console.warn(
        '[BazarHub] Hay usuarios con contraseñas en texto plano. ' +
        'El admin debe cambiarlas desde el panel Usuarios → se migrarán a hash automáticamente.'
      );
    }
  } catch (e) {
    console.error('loadUsersFromFirebase error:', e);
    store.users = [];
  }
}

// ===== CARGA INICIAL (post-login) =====

/**
 * Carga todos los datos desde Firebase al iniciar sesión.
 * Si una colección está vacía (primer uso), sube los datos de ejemplo.
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
    await _loadDevoluciones();
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
    // Primer uso: guardar productos de ejemplo vacíos (sin demo hardcodeado)
    // El admin cargará sus propios productos desde el panel
    store.products = [];
  }
}

async function _loadProveedores() {
  const snap = await db.collection('proveedores').get();
  if (snap.size > 0) {
    store.proveedores = [];
    snap.forEach(d => store.proveedores.push({ ...d.data(), id: parseInt(d.id) }));
    store.nextProvId = Math.max(...store.proveedores.map(p => p.id), 4) + 1;
  } else {
    store.proveedores = [];
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
  // Reutiliza la carga ya hecha antes del login
  await loadUsersFromFirebase();
  if (store.users.length) {
    store.nextUserId = Math.max(...store.users.map(u => parseInt(u.id.replace(/\D/g, '')) || 0), 9) + 1;
  }
}

async function _loadDevoluciones() {
  if (typeof _loadDevoluciones._real === 'function') {
    return _loadDevoluciones._real();
  }
  try {
    const snap = await db.collection('devoluciones').get();
    store.devoluciones = [];
    snap.forEach(d => store.devoluciones.push({ ...d.data(), id: parseInt(d.id) }));
    store.nextDevId = store.devoluciones.length
      ? Math.max(...store.devoluciones.map(d => d.id), 0) + 1
      : 1;
  } catch (e) {
    store.devoluciones = [];
    store.nextDevId = 1;
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
  // Nunca guardar contraseña en texto plano
  const safeUser = { ...user };
  delete safeUser.pass;
  await saveDoc('users', safeUser.id, safeUser);
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
