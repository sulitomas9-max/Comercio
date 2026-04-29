/**
 * app.js — BazarHub
 * Estado central, login/logout, navegación, UI helpers.
 * Depende de: firebase.js
 *
 * SEGURIDAD:
 * - Las contraseñas se guardan hasheadas (SHA-256 via Web Crypto API).
 * - No hay contraseñas hardcodeadas ni hints de demo.
 * - Al primer arranque, si no hay usuarios en Firebase, se muestra
 *   el wizard de configuración inicial para crear la contraseña del admin.
 */

// ===== UTILIDADES DE HASH =====

async function hashPass(plain) {
  const enc = new TextEncoder().encode(plain);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPass(plain, hashed) {
  return (await hashPass(plain)) === hashed;
}

// ===== ESTADO CENTRAL =====

const store = {
  // Datos
  users: [],          // cargados desde Firebase — sin contraseñas en texto plano
  products: [],
  proveedores: [],
  sales: [],
  orders: [],
  movimientos: [],
  ctacteMovs: [],
  cajaHistory: [],
  retiros: [],

  // Sesión
  currentUser: null,
  selectedUserId: null,

  // Carrito y pago
  cart: [],
  payMethod: 'cash',

  // Caja
  cajaAbierta: null,
  saldoAnterior: 0,

  // UI
  isDark: false,
  rankFilter: 'qty',

  // IDs auto-incrementales
  nextProdId: 8,
  nextProvId: 5,
  nextOCId: 1,
  nextUserId: 10,
  nextCCId: 1,
  nextRetiroId: 1,

  // Estado de edición modal
  editProdId: null,
  editProvId: null,
  stockEditId: null,
  editMovId: null,

  // Orden de compra en curso
  ocItems: [],

  // Control de bloqueo por intentos fallidos
  loginAttempts: 0,
  loginLockedUntil: 0,
};

// ===== CONSTANTES DE PRESENTACIÓN =====

const DELIVERY_LABELS = { 1: '24 hs', 2: '48 hs', 3: '72 hs', 7: '1 semana', 15: 'Quincenal' };
const METHOD_LABELS = { cash: '💵 Efectivo', card: '💳 Tarjeta', transfer: '🏦 Transferencia' };
const MOV_TYPE_LABELS = { venta: 'Venta', entrada: 'Entrada', ajuste: 'Ajuste', devolucion: 'Devolución', merma: 'Merma' };

const NAV_ADMIN = [
  { sec: 'Ventas', items: [
    { id: 'ventas',     ico: '🛒', label: 'Ventas y caja' },
    { id: 'quicksale',  ico: '⚡', label: 'Modo rápido' },
    { id: 'historial',  ico: '📋', label: 'Historial' },
    { id: 'dashboard',  ico: '📊', label: 'Dashboard' },
  ]},
  { sec: 'Inventario', items: [
    { id: 'stock',       ico: '📦', label: 'Stock' },
    { id: 'movimientos', ico: '🔄', label: 'Movimientos' },
    { id: 'productos',   ico: '🏷',  label: 'Productos' },
    { id: 'importar',    ico: '📥', label: 'Importar desde PDF' },
  ]},
  { sec: 'Administración', items: [
    { id: 'proveedores', ico: '🚚', label: 'Proveedores' },
    { id: 'ctacte',      ico: '📒', label: 'Cta. cte. proveedores' },
    { id: 'ordenes',     ico: '📄', label: 'Órdenes de compra' },
    { id: 'ranking',     ico: '📊', label: 'Ranking' },
    { id: 'reportes',    ico: '📈', label: 'Reportes' },
    { id: 'usuarios',    ico: '👥', label: 'Usuarios' },
  ]},
];

const NAV_CAJERO = [
  { sec: 'Ventas', items: [
    { id: 'ventas',    ico: '🛒', label: 'Ventas y caja' },
    { id: 'quicksale', ico: '⚡', label: 'Modo rápido' },
    { id: 'historial', ico: '📋', label: 'Historial' },
  ]},
  { sec: 'Inventario', items: [
    { id: 'stock',       ico: '📦', label: 'Stock' },
    { id: 'movimientos', ico: '🔄', label: 'Movimientos' },
    { id: 'productos',   ico: '🏷',  label: 'Productos' },
  ]},
];

const PAGE_TITLES = {
  ventas:      'Ventas y caja',
  quicksale:   '⚡ Modo Rápido',
  historial:   'Historial',
  dashboard:   'Dashboard',
  stock:       'Stock',
  movimientos: 'Movimientos de stock',
  productos:   'Productos',
  proveedores: 'Proveedores',
  ctacte:      'Cuenta corriente proveedores',
  ordenes:     'Órdenes de compra',
  ranking:     'Ranking',
  reportes:    'Reportes',
  usuarios:    'Usuarios',
  importar:    'Importar desde PDF',
};

// ===== HELPERS UI =====

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

function openModal(id) {
  document.getElementById(id).classList.add('on');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('on');
}

function showMsg(elementId, text, type) {
  const el = document.getElementById(elementId);
  el.textContent = text;
  el.className = 'msg ' + type;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function showLoadingOverlay(show) {
  let el = document.getElementById('loading-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading-overlay';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-size:15px;color:#fff';
    el.innerHTML = '<div style="font-size:40px;animation:pulse 1.5s infinite">●</div><div>Cargando datos...</div>';
    document.body.appendChild(el);
  }
  el.style.display = show ? 'flex' : 'none';
}

function toggleDark() {
  store.isDark = !store.isDark;
  document.body.classList.toggle('dark', store.isDark);
  document.getElementById('dark-btn').textContent = store.isDark ? '☀️ Claro' : '🌙 Oscuro';
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('on');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('on');
}

function formatMoney(amount) {
  return '$' + amount.toLocaleString();
}

// ===== WIZARD DE PRIMER ARRANQUE =====
// Se muestra cuando no hay usuarios en Firebase (instalación nueva).

function showSetupWizard() {
  const existing = document.getElementById('setup-wizard');
  if (existing) return;

  const overlay = document.createElement('div');
  overlay.id = 'setup-wizard';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;
    display:flex;align-items:center;justify-content:center;padding:20px;
  `;
  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border-radius:14px;padding:28px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="font-size:28px;text-align:center;margin-bottom:6px">🔐</div>
      <div style="font-size:18px;font-weight:700;text-align:center;margin-bottom:4px">Configuración inicial</div>
      <div style="font-size:13px;color:var(--txt2,#666);text-align:center;margin-bottom:20px">
        Primera vez que usás BazarHub. Creá la contraseña del administrador.
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:5px">
          Contraseña administrador
        </label>
        <input type="password" id="setup-pass1" placeholder="Mínimo 6 caracteres"
          style="width:100%;padding:10px 12px;border:1.5px solid var(--brd,#ddd);border-radius:8px;font-size:14px;box-sizing:border-box">
      </div>
      <div style="margin-bottom:20px">
        <label style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:5px">
          Confirmar contraseña
        </label>
        <input type="password" id="setup-pass2" placeholder="Repetí la contraseña"
          style="width:100%;padding:10px 12px;border:1.5px solid var(--brd,#ddd);border-radius:8px;font-size:14px;box-sizing:border-box">
      </div>
      <div id="setup-err" style="display:none;color:#c0392b;font-size:12px;margin-bottom:12px;padding:8px 12px;background:#fdf0ee;border-radius:6px"></div>
      <button onclick="finishSetup()"
        style="width:100%;padding:12px;background:var(--accent,#222);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">
        Crear cuenta y entrar →
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('setup-pass1').focus();
}

async function finishSetup() {
  const p1 = document.getElementById('setup-pass1').value;
  const p2 = document.getElementById('setup-pass2').value;
  const errEl = document.getElementById('setup-err');

  errEl.style.display = 'none';

  if (p1.length < 6) {
    errEl.textContent = 'La contraseña debe tener al menos 6 caracteres';
    errEl.style.display = 'block';
    return;
  }
  if (p1 !== p2) {
    errEl.textContent = 'Las contraseñas no coinciden';
    errEl.style.display = 'block';
    return;
  }

  const hashed = await hashPass(p1);
  const adminUser = {
    id: 'admin',
    name: 'Administrador',
    role: 'admin',
    passHash: hashed,
    avatar: '👑',
  };

  store.users.push(adminUser);
  await saveUser(adminUser);

  document.getElementById('setup-wizard').remove();
  renderUserGrid();
  toast('¡BazarHub configurado! Ya podés ingresar.', 'ok');
}

// ===== LOGIN =====

function renderUserGrid() {
  const grid = document.getElementById('user-grid');
  if (!grid) return;
  grid.innerHTML = store.users.map(u => `
    <div class="user-card ${store.selectedUserId === u.id ? 'sel' : ''}" id="uc-${u.id}" data-uid="${u.id}" onclick="selectUser('${u.id}')">
      <div class="ico" style="pointer-events:none">${u.avatar}</div>
      <div class="nm" style="pointer-events:none">${u.name}</div>
      <div class="rl" style="pointer-events:none">${u.role === 'admin' ? 'Administrador' : 'Cajero'}</div>
    </div>
  `).join('');

  // Si no hay usuarios, mostrar wizard
  if (store.users.length === 0) {
    grid.innerHTML = '<div style="text-align:center;color:var(--txt2);font-size:13px;padding:12px">Cargando...</div>';
  }
}

function selectUser(id) {
  store.selectedUserId = id;
  document.querySelectorAll('.user-card').forEach(card => {
    card.classList.toggle('sel', card.id === 'uc-' + id);
  });
}

// Bloqueo por intentos fallidos (5 intentos → 2 minutos de espera)
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS   = 2 * 60 * 1000;

async function doLogin() {
  const errEl = document.getElementById('login-err');

  // ¿Está bloqueado?
  if (store.loginLockedUntil > Date.now()) {
    const secs = Math.ceil((store.loginLockedUntil - Date.now()) / 1000);
    errEl.textContent = `Demasiados intentos. Esperá ${secs}s`;
    errEl.style.display = 'block';
    return;
  }

  const pass = document.getElementById('login-pass').value;
  const user = store.users.find(u => u.id === store.selectedUserId);

  if (!user) {
    errEl.textContent = 'Seleccioná un usuario';
    errEl.style.display = 'block';
    return;
  }

  // Verificar hash
  const ok = await verifyPass(pass, user.passHash);

  if (!ok) {
    store.loginAttempts++;
    if (store.loginAttempts >= MAX_ATTEMPTS) {
      store.loginLockedUntil = Date.now() + LOCKOUT_MS;
      store.loginAttempts = 0;
      errEl.textContent = 'Demasiados intentos. Bloqueado 2 minutos.';
    } else {
      const restantes = MAX_ATTEMPTS - store.loginAttempts;
      errEl.textContent = `Contraseña incorrecta. ${restantes} intento${restantes === 1 ? '' : 's'} restante${restantes === 1 ? '' : 's'}.`;
    }
    errEl.style.display = 'block';
    return;
  }

  // Login exitoso
  store.loginAttempts = 0;
  store.loginLockedUntil = 0;
  errEl.style.display = 'none';
  store.currentUser = user;
  document.getElementById('login-pass').value = '';
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').classList.add('on');

  applyRole();
  showLoadingOverlay(true);
  waitForFirebase(() => {
    loadFromFirebase().then(() => {
      renderUserGrid();
      go('ventas');
    });
  });
}

function doLogout() {
  store.currentUser = null;
  store.cart = [];
  document.getElementById('login').style.display = 'flex';
  document.getElementById('app').classList.remove('on');
  store.selectedUserId = null;
  renderUserGrid();
  document.getElementById('login-pass').value = '';
}

// ===== ROL Y MENÚ =====

function applyRole() {
  const isAdmin = store.currentUser.role === 'admin';

  const av = document.getElementById('sb-av');
  av.textContent = store.currentUser.avatar;
  av.className = 'sb-av ' + (isAdmin ? 'av-admin' : 'av-cajero');
  document.getElementById('sb-uname').textContent = store.currentUser.name;
  document.getElementById('sb-urole').textContent = isAdmin ? 'Administrador' : 'Cajero';

  const nav = isAdmin ? NAV_ADMIN : NAV_CAJERO;
  document.getElementById('nav-menu').innerHTML = nav.map(section =>
    `<div class="nav-sec">${section.sec}</div>` +
    section.items.map(item =>
      `<button class="nav-btn" id="nb-${item.id}" onclick="go('${item.id}')">
        <span class="nav-ico">${item.ico}</span>${item.label}
      </button>`
    ).join('')
  ).join('');

  const btnNuevoProd = document.getElementById('btn-nuevo-prod');
  if (btnNuevoProd) btnNuevoProd.style.display = isAdmin ? 'inline-block' : 'none';
}

// ===== NAVEGACIÓN =====

function go(page) {
  if (!store.currentUser) return;

  document.querySelectorAll('.page').forEach(p => p.classList.remove('act'));
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('act');

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('act'));
  const navBtn = document.getElementById('nb-' + page);
  if (navBtn) navBtn.classList.add('act');

  document.getElementById('topbar-title').textContent = PAGE_TITLES[page] || page;
  closeSidebar();

  const renders = {
    ventas:      () => updateCajaBar(),
    quicksale:   () => openQuickSale(),
    historial:   () => renderHistory(),
    dashboard:   () => { renderDashboard(); renderAlerts(); },
    stock:       () => renderStockPage(),
    movimientos: () => renderMovimientos(),
    productos:   () => renderProducts(),
    proveedores: () => renderProveedores(),
    ctacte:      () => renderCtaCte(),
    ordenes:     () => renderOrdenes(),
    ranking:     () => renderRanking(),
    reportes:    () => renderReportes(),
    usuarios:    () => renderUsuarios(),
    importar:    () => renderImportar(),
  };
  if (renders[page]) renders[page]();
}

// ===== EXPORT CSV =====

function exportCSV(type) {
  let rows = [];
  let filename = '';

  switch (type) {
    case 'ventas':
      filename = 'ventas.csv';
      rows = [
        ['#', 'Fecha', 'Hora', 'Cajero', 'Productos', 'Total', 'Método'],
        ...store.sales.map(v => [
          v.id, v.date, v.time, v.userName,
          v.items.map(i => `${i.name} x${i.qty}`).join(' | '),
          v.total, METHOD_LABELS[v.method] || v.method,
        ]),
      ];
      break;

    case 'stock':
      filename = 'stock.csv';
      rows = [
        ['Código', 'Nombre', 'Categoría', 'Proveedor', 'Costo', 'Precio', 'Stock', 'Stock mínimo'],
        ...store.products.map(p => {
          const pv = store.proveedores.find(v => v.id === p.provId);
          return [p.code, p.name, p.cat, pv ? pv.name : '-', p.cost, p.price, p.stock, p.minStock];
        }),
      ];
      break;

    case 'movimientos':
      filename = 'movimientos.csv';
      rows = [
        ['Fecha', 'Producto', 'Tipo', 'Cantidad', 'Stock anterior', 'Stock nuevo', 'Usuario', 'Motivo'],
        ...store.movimientos.map(m => [m.fecha, m.prodName, m.tipo, m.cantidad, m.stockAntes, m.stockDespues, m.userName, m.motivo]),
      ];
      break;

    case 'ctacte':
      filename = 'cta_cte.csv';
      rows = [
        ['Fecha', 'Proveedor', 'Concepto', 'Debe', 'Haber'],
        ...store.ctacteMovs.map(m => {
          const pv = store.proveedores.find(v => v.id === m.provId);
          return [m.fecha, pv ? pv.name : '-', m.concepto, m.type === 'deuda' ? m.monto : '', m.type === 'pago' ? m.monto : ''];
        }),
      ];
      break;

    case 'retiros':
      filename = 'retiros_caja.csv';
      rows = [
        ['Fecha', 'Caja #', 'Monto', 'Motivo', 'Quién'],
        ...store.retiros.map(r => [r.fecha, 'Caja #' + r.cajaId, r.monto, r.motivo, r.userName]),
      ];
      break;

    case 'productos':
      filename = 'productos.csv';
      rows = [
        ['Código', 'Nombre', 'Categoría', 'Proveedor', 'Costo', 'Precio', 'Margen%', 'Vendidos', 'Ingresos'],
        ...store.products.map(p => {
          const pv = store.proveedores.find(v => v.id === p.provId);
          const margin = p.cost > 0 ? Math.round((p.price - p.cost) / p.price * 100) : 0;
          return [p.code, p.name, p.cat, pv ? pv.name : '-', p.cost, p.price, margin + '%', p.sold, p.revenue];
        }),
      ];
      break;

    default:
      return;
  }

  const csv = rows.map(row =>
    row.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(',')
  ).join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  toast('Descargado: ' + filename);
}

// ===== REPORTES =====

function renderReportes() {
  const totalVentas = store.sales.reduce((s, v) => s + v.total, 0);
  const totalCosto = store.sales.reduce((s, v) =>
    s + v.items.reduce((ss, item) => {
      const prod = store.products.find(p => p.id === item.id);
      return ss + (prod ? prod.cost * item.qty : 0);
    }, 0), 0
  );
  const ganancia = totalVentas - totalCosto;
  const margen = totalVentas > 0 ? Math.round(ganancia / totalVentas * 100) : 0;

  document.getElementById('rep-ventas').textContent = formatMoney(totalVentas);
  document.getElementById('rep-costo').textContent = formatMoney(totalCosto);
  document.getElementById('rep-gan').textContent = formatMoney(ganancia);
  document.getElementById('rep-mg').textContent = margen + '%';

  _renderRankBar('rep-metodos', _groupBy(store.sales, 'method', 'total'), key => METHOD_LABELS[key] || key, '');
  _renderRankBar('rep-cajeros', _groupBy(store.sales, 'userName', 'total'), key => key, 'var(--blue)');
}

function _groupBy(items, keyField, valueField) {
  const map = {};
  items.forEach(item => {
    const k = item[keyField];
    map[k] = (map[k] || 0) + item[valueField];
  });
  return map;
}

function _renderRankBar(containerId, data, labelFn, barColor) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const maxVal = Math.max(1, ...entries.map(([, v]) => v));
  const colorStyle = barColor ? `background:${barColor}` : '';
  const el = document.getElementById(containerId);
  el.innerHTML = entries.map(([key, val]) => `
    <div class="rank-row">
      <div class="rank-name">${labelFn(key)}</div>
      <div class="rank-bar"><div class="rank-fill" style="width:${Math.round(val / maxVal * 100)}%;${colorStyle}"></div></div>
      <div class="rank-val">${formatMoney(val)}</div>
    </div>
  `).join('') || '<div style="color:var(--txt3);font-size:13px;padding:8px 0">Sin datos aún</div>';
}

// ===== RANKING =====

function setRankFilter(filter, el) {
  store.rankFilter = filter;
  document.querySelectorAll('#rank-filters .chip').forEach(c => c.classList.remove('sel'));
  el.classList.add('sel');
  renderRanking();
}

function renderRanking() {
  const byQty = store.rankFilter === 'qty';
  const sorted = [...store.products].sort((a, b) => byQty ? b.sold - a.sold : b.revenue - a.revenue);
  const maxVal = Math.max(1, ...sorted.map(p => byQty ? p.sold : p.revenue));

  document.getElementById('rank-t1').textContent = byQty ? 'Top por cantidad vendida' : 'Top por ingresos';
  document.getElementById('rank-list').innerHTML = sorted.slice(0, 7).map((p, i) => {
    const val = byQty ? p.sold : p.revenue;
    return `
      <div class="rank-row">
        <div class="rank-n">${i + 1}</div>
        <div class="rank-name" title="${p.name}">${p.name}</div>
        <div class="rank-bar"><div class="rank-fill" style="width:${Math.round(val / maxVal * 100)}%"></div></div>
        <div class="rank-val">${byQty ? val + ' u.' : formatMoney(val)}</div>
      </div>`;
  }).join('');

  const cats = {};
  store.products.forEach(p => {
    if (!cats[p.cat]) cats[p.cat] = { qty: 0, rev: 0 };
    cats[p.cat].qty += p.sold;
    cats[p.cat].rev += p.revenue;
  });
  const catArr = Object.entries(cats).sort((a, b) =>
    byQty ? b[1].qty - a[1].qty : b[1].rev - a[1].rev
  );
  const maxCat = Math.max(1, ...catArr.map(([, d]) => byQty ? d.qty : d.rev));

  document.getElementById('cat-list').innerHTML = catArr.map(([name, d], i) => {
    const val = byQty ? d.qty : d.rev;
    return `
      <div class="rank-row">
        <div class="rank-n">${i + 1}</div>
        <div class="rank-name">${name}</div>
        <div class="rank-bar"><div class="rank-fill" style="width:${Math.round(val / maxCat * 100)}%;background:var(--blue)"></div></div>
        <div class="rank-val">${byQty ? val + ' u.' : formatMoney(val)}</div>
      </div>`;
  }).join('');
}

// ===== USUARIOS =====

function renderUsuarios() {
  const cajeros = store.users.filter(u => u.role === 'cajero');
  document.getElementById('cajeros-list').innerHTML = cajeros.length
    ? cajeros.map(u => `
        <div class="cajero-card">
          <div class="cajero-head">
            <div class="cajero-av">${u.avatar}</div>
            <div>
              <div style="font-size:14px;font-weight:600">${u.name}</div>
              <div style="font-size:12px;color:var(--txt2)">Cajero</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="password" id="pass-${u.id}" placeholder="Nueva contraseña" style="flex:1;min-width:150px;font-size:13px">
            <button class="btn sm pri" onclick="changeCajeroPass('${u.id}')">Cambiar</button>
            <button class="btn sm red" onclick="delUser('${u.id}')">Eliminar</button>
          </div>
        </div>`
      ).join('')
    : '<div style="color:var(--txt2);font-size:13px;padding:8px 0;margin-bottom:12px">No hay cajeros todavía</div>';
}

function openUserModal() {
  openModal('modal-user');
  document.getElementById('u-name').value = '';
  document.getElementById('u-pass').value = '';
}

async function saveUserForm() {
  const name = document.getElementById('u-name').value.trim();
  const pass = document.getElementById('u-pass').value;
  if (!name) { showMsg('msg-user', 'Ingresá el nombre', 'err'); return; }
  if (!pass || pass.length < 4) { showMsg('msg-user', 'Contraseña mínimo 4 caracteres', 'err'); return; }

  const u = {
    id: 'caj' + store.nextUserId++,
    name,
    role: 'cajero',
    passHash: await hashPass(pass),
    avatar: document.getElementById('u-avatar').value,
  };
  store.users.push(u);
  await saveUser(u);
  closeModal('modal-user');
  renderUsuarios();
  renderUserGrid();
  toast('Cajero creado');
}

async function changeCajeroPass(id) {
  const input = document.getElementById('pass-' + id);
  const val = input?.value;
  if (!val || val.length < 4) { toast('Mínimo 4 caracteres', 'err'); return; }
  const u = store.users.find(x => x.id === id);
  if (u) {
    u.passHash = await hashPass(val);
    delete u.pass; // por si quedó alguna versión vieja en texto plano
    await saveUser(u);
    input.value = '';
    toast('Contraseña actualizada');
  }
}

async function delUser(id) {
  if (!confirm('¿Eliminar cajero?')) return;
  store.users = store.users.filter(u => u.id !== id);
  await removeUser(id);
  renderUsuarios();
  renderUserGrid();
  toast('Cajero eliminado');
}

async function changeAdminPass() {
  const val = document.getElementById('admin-pass-new').value;
  if (!val || val.length < 4) { showMsg('msg-admin', 'Mínimo 4 caracteres', 'err'); return; }
  const admin = store.users.find(u => u.role === 'admin');
  if (admin) {
    admin.passHash = await hashPass(val);
    delete admin.pass;
    await saveUser(admin);
  }
  document.getElementById('admin-pass-new').value = '';
  showMsg('msg-admin', 'Contraseña actualizada', 'ok');
}

// ===== INIT =====
(function init() {
  // Primero cargamos usuarios desde Firebase antes de mostrar el grid
  waitForFirebase(async () => {
    await loadUsersFromFirebase();

    if (store.users.length === 0) {
      // Primera vez: wizard de configuración
      renderUserGrid();
      showSetupWizard();
    } else {
      renderUserGrid();
    }
  });

  const btn  = document.getElementById('login-btn');
  const pass = document.getElementById('login-pass');

  if (btn)  btn.addEventListener('click', doLogin);
  if (pass) pass.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
})();
