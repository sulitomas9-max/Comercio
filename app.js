/**
 * app.js
 * Estado central (store), login/logout, navegación, UI helpers.
 * Depende de: firebase.js
 */

// ===== ESTADO CENTRAL =====
// Todo el estado mutable de la aplicación vive aquí.
const store = {
  // Datos
  users: [
    { id: 'admin',  name: 'Administrador',   role: 'admin',  pass: 'admin123', avatar: '👑' },
    { id: 'caja1',  name: 'Cajero Principal', role: 'cajero', pass: 'caja123',  avatar: '🧾' },
  ],
  products: [
    { id:1, code:'7790001001', name:'Coca-Cola 500ml',          cat:'Bebidas',    provId:1, cost:350, price:550, stock:24, minStock:6,  sold:0, revenue:0 },
    { id:2, code:'7790001002', name:'Leche La Serenísima 1L',   cat:'Lácteos',    provId:2, cost:420, price:650, stock:15, minStock:8,  sold:0, revenue:0 },
    { id:3, code:'7790001003', name:'Arroz Gallo Oro 1kg',      cat:'Almacén',    provId:3, cost:280, price:420, stock:30, minStock:10, sold:0, revenue:0 },
    { id:4, code:'7790001004', name:'Jabón Dove 100g',          cat:'Perfumería', provId:4, cost:380, price:590, stock:3,  minStock:5,  sold:0, revenue:0 },
    { id:5, code:'7790001005', name:'Lavandina 1L',             cat:'Limpieza',   provId:4, cost:220, price:350, stock:0,  minStock:4,  sold:0, revenue:0 },
    { id:6, code:'7790001006', name:'Papas Fritas Pringles',    cat:'Snacks',     provId:3, cost:450, price:680, stock:18, minStock:6,  sold:0, revenue:0 },
    { id:7, code:'7790001007', name:'Aceite Girasol 900ml',     cat:'Almacén',    provId:3, cost:510, price:780, stock:12, minStock:5,  sold:0, revenue:0 },
  ],
  proveedores: [
    { id:1, name:'Coca-Cola FEMSA',       cat:'Bebidas',  contact:'Carlos Méndez', phone:'11 4444-5555', email:'ventas@femsa.com.ar',    days:2, notes:'Pago a 30 días.' },
    { id:2, name:'SanCor Distribución',   cat:'Lácteos',  contact:'Laura Gómez',   phone:'11 3333-2222', email:'lgomez@sancor.com',       days:1, notes:'Entrega martes y jueves' },
    { id:3, name:'Distribuidora Norte SA',cat:'Almacén',  contact:'Miguel Torres', phone:'11 6666-7777', email:'mtorres@dnorte.com.ar',   days:3, notes:'Descuento 5% al contado' },
    { id:4, name:'Unilever Argentina',    cat:'Limpieza', contact:'Sofía Ríos',    phone:'11 8888-1111', email:'srios@unilever.com',       days:7, notes:'Pedido mínimo $80.000' },
  ],
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
};

// ===== CONSTANTES DE PRESENTACIÓN =====
const DELIVERY_LABELS = { 1: '24 hs', 2: '48 hs', 3: '72 hs', 7: '1 semana', 15: 'Quincenal' };
const METHOD_LABELS = { cash: '💵 Efectivo', card: '💳 Tarjeta', transfer: '🏦 Transferencia' };
const MOV_TYPE_LABELS = { venta: 'Venta', entrada: 'Entrada', ajuste: 'Ajuste', devolucion: 'Devolución', merma: 'Merma' };

const NAV_ADMIN = [
  { sec: 'Ventas', items: [
    { id: 'ventas',    ico: '🛒', label: 'Ventas y caja' },
    { id: 'historial', ico: '📋', label: 'Historial' },
  ]},
  { sec: 'Inventario', items: [
    { id: 'stock',       ico: '📦', label: 'Stock' },
    { id: 'movimientos', ico: '🔄', label: 'Movimientos' },
    { id: 'productos',   ico: '🏷',  label: 'Productos' },
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
  historial:   'Historial',
  stock:       'Stock',
  movimientos: 'Movimientos de stock',
  productos:   'Productos',
  proveedores: 'Proveedores',
  ctacte:      'Cuenta corriente proveedores',
  ordenes:     'Órdenes de compra',
  ranking:     'Ranking',
  reportes:    'Reportes',
  usuarios:    'Usuarios',
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
}

function selectUser(id) {
  store.selectedUserId = id;
  document.querySelectorAll('.user-card').forEach(card => {
    card.classList.toggle('sel', card.id === 'uc-' + id);
  });
}

function doLogin() {
  const pass = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-err');
  const user = store.users.find(u => u.id === store.selectedUserId);

  if (!user) {
    errEl.textContent = 'Seleccioná un usuario';
    errEl.style.display = 'block';
    return;
  }
  if (pass !== user.pass) {
    errEl.style.display = 'block';
    return;
  }

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

  // Renderizar la página correspondiente
  const renders = {
    ventas:      () => updateCajaBar(),
    historial:   () => renderHistory(),
    stock:       () => renderStockPage(),
    movimientos: () => renderMovimientos(),
    productos:   () => renderProducts(),
    proveedores: () => renderProveedores(),
    ctacte:      () => renderCtaCte(),
    ordenes:     () => renderOrdenes(),
    ranking:     () => renderRanking(),
    reportes:    () => renderReportes(),
    usuarios:    () => renderUsuarios(),
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

  // Ranking por categoría
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
    pass,
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
    u.pass = val;
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
    admin.pass = val;
    await saveUser(admin);
  }
  document.getElementById('admin-pass-new').value = '';
  showMsg('msg-admin', 'Contraseña actualizada', 'ok');
}

// ===== INIT =====
(function init() {
  renderUserGrid();

  const btn  = document.getElementById('login-btn');
  const pass = document.getElementById('login-pass');

  if (btn)  btn.addEventListener('click', doLogin);
  if (pass) pass.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
})();
