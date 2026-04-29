/**
 * stock.js — BazarHub
 * Productos, stock, movimientos, proveedores, cta cte, órdenes de compra.
 */

// ===== STOCK =====

function renderStockPage() {
  const lowStock = store.products.filter(p => p.stock > 0 && p.stock <= p.minStock);
  const noStock  = store.products.filter(p => p.stock === 0);
  const valTotal = store.products.reduce((s, p) => s + p.cost * p.stock, 0);
  document.getElementById('st-total').textContent = store.products.length;
  document.getElementById('st-low').textContent   = lowStock.length;
  document.getElementById('st-out').textContent   = noStock.length;
  document.getElementById('st-val').textContent   = formatMoney(valTotal);
  renderStock('');
}

function renderStock(query = '') {
  const isAdmin = store.currentUser?.role === 'admin';
  const thCosto = document.getElementById('th-costo');
  if (thCosto) thCosto.style.display = isAdmin ? '' : 'none';

  const filtered = query
    ? store.products.filter(p => p.name.toLowerCase().includes(query.toLowerCase()) || p.code.includes(query))
    : store.products;

  document.getElementById('stock-table').innerHTML = filtered.map(p => {
    const proveedor = store.proveedores.find(v => v.id === p.provId);
    const { badge, state } = getStockBadge(p);
    const hasPres = p.presentaciones?.length > 0;
    return `
      <tr>
        <td style="font-family:var(--mono);font-size:11px;color:var(--txt2)">${p.code}</td>
        <td style="font-weight:500">
          ${p.name}
          ${hasPres ? `<span style="font-size:10px;color:var(--blue);font-weight:600;margin-left:4px">• ${p.presentaciones.length} presentaciones</span>` : ''}
        </td>
        <td style="font-size:12px;color:var(--txt2)">${proveedor ? proveedor.name : '-'}</td>
        <td style="font-weight:600">${formatMoney(p.price)}</td>
        ${isAdmin ? `<td style="color:var(--txt2)">${formatMoney(p.cost)}</td>` : ''}
        <td style="font-weight:700;font-size:15px">${p.stock}</td>
        <td><span class="badge ${state}">${badge}</span></td>
        <td><button class="btn sm" onclick="openStockModal(${p.id})">Ajustar</button></td>
      </tr>`;
  }).join('');
}

function getStockBadge(product) {
  if (product.stock === 0)             return { badge: 'Sin stock', state: 'out' };
  if (product.stock <= product.minStock) return { badge: 'Stock bajo', state: 'low' };
  return { badge: 'Normal', state: 'ok' };
}

function openStockModal(id) {
  store.stockEditId = id;
  const prod = store.products.find(p => p.id === id);
  document.getElementById('s-pname').value = prod.name;
  document.getElementById('s-cur').value   = prod.stock;
  document.getElementById('s-new').value   = prod.stock;
  document.getElementById('s-note').value  = '';
  openModal('modal-stock');
}

async function saveStock() {
  const prod   = store.products.find(p => p.id === store.stockEditId);
  const newQty = parseInt(document.getElementById('s-new').value);
  if (isNaN(newQty) || newQty < 0) { toast('Valor inválido', 'err'); return; }
  const tipo      = document.getElementById('s-type').value;
  const nota      = document.getElementById('s-note').value;
  const prevStock = prod.stock;
  prod.stock = newQty;
  const mov = registrarMovimiento(prod.id, tipo, newQty - prevStock, prevStock, newQty, nota || tipo);
  await saveStockAdjustment(prod, mov);
  closeModal('modal-stock');
  renderStockPage();
  toast('Stock actualizado');
}

// ===== MOVIMIENTOS =====

function renderMovimientos() {
  const isAdmin  = store.currentUser?.role === 'admin';
  const thAcc    = document.getElementById('th-mov-acc');
  const btnNuevo = document.getElementById('btn-nuevo-mov');
  if (thAcc)    thAcc.textContent      = isAdmin ? 'Acciones' : '';
  if (btnNuevo) btnNuevo.style.display = isAdmin ? 'inline-block' : 'none';

  const sel  = document.getElementById('mov-fprod');
  const prev = sel.value;
  sel.innerHTML = '<option value="">Todos los productos</option>' +
    store.products.map(p => `<option value="${p.id}" ${prev == p.id ? 'selected' : ''}>${p.name}</option>`).join('');
  sel.value = prev;

  const fp       = sel.value;
  const ft       = document.getElementById('mov-ftype').value;
  const filtered = store.movimientos.filter(m => (!fp || m.prodId == fp) && (!ft || m.tipo === ft));
  const tb = document.getElementById('mov-table');
  const em = document.getElementById('mov-empty');

  if (!filtered.length) { tb.innerHTML = ''; em.style.display = 'block'; return; }
  em.style.display = 'none';
  tb.innerHTML = [...filtered].reverse().map(m => {
    const badgeClass = (m.tipo === 'venta' || m.tipo === 'merma') ? 'out'
      : (m.tipo === 'entrada' || m.tipo === 'devolucion') ? 'ok' : 'gray';
    return `
      <tr>
        <td style="font-size:12px;color:var(--txt2);white-space:nowrap">${m.fecha}</td>
        <td style="font-weight:500">${m.prodName}</td>
        <td><span class="badge ${badgeClass}">${MOV_TYPE_LABELS[m.tipo] || m.tipo}</span></td>
        <td class="mov-qty ${m.cantidad >= 0 ? 'pos' : 'neg'}">${m.cantidad >= 0 ? '+' : ''}${m.cantidad}</td>
        <td style="color:var(--txt2)">${m.stockAntes}</td>
        <td style="font-weight:600">${m.stockDespues}</td>
        <td style="font-size:12px;color:var(--txt2)">${m.userName}</td>
        <td style="font-size:12px;color:var(--txt2)">${m.motivo}</td>
        <td>${isAdmin ? `<div style="display:flex;gap:4px">
          <button class="btn sm" onclick="openMovModal(${m.id})">Editar</button>
          <button class="btn sm red" onclick="delMov(${m.id})" style="padding:5px 8px">✕</button>
        </div>` : ''}</td>
      </tr>`;
  }).join('');
}

function openMovModal(id = null) {
  store.editMovId = id || null;
  document.getElementById('mov-modal-title').textContent = id ? 'Editar movimiento' : 'Agregar movimiento';
  document.getElementById('mov-prod').innerHTML = store.products.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  if (id) {
    const mov = store.movimientos.find(m => m.id === id);
    if (mov) {
      document.getElementById('mov-prod').value   = mov.prodId;
      document.getElementById('mov-tipo').value   = mov.tipo;
      document.getElementById('mov-cant').value   = mov.cantidad;
      document.getElementById('mov-motivo').value = mov.motivo;
      document.getElementById('mov-fecha').value  = mov.fecha;
    }
  } else {
    document.getElementById('mov-prod').value   = store.products[0]?.id || '';
    document.getElementById('mov-tipo').value   = 'entrada';
    document.getElementById('mov-cant').value   = '';
    document.getElementById('mov-motivo').value = '';
    document.getElementById('mov-fecha').value  = new Date().toLocaleString('es-AR');
  }
  openModal('modal-mov');
}

async function saveMov() {
  const prodId = parseInt(document.getElementById('mov-prod').value);
  const cant   = parseInt(document.getElementById('mov-cant').value);
  const tipo   = document.getElementById('mov-tipo').value;
  const motivo = document.getElementById('mov-motivo').value.trim();
  const fecha  = document.getElementById('mov-fecha').value.trim();
  if (!prodId || isNaN(cant)) { showMsg('msg-mov', 'Completá producto y cantidad', 'err'); return; }
  const prod = store.products.find(p => p.id === prodId);
  if (store.editMovId) {
    const mov = store.movimientos.find(m => m.id === store.editMovId);
    if (mov) { Object.assign(mov, { prodId, prodName: prod?.name || '', tipo, cantidad: cant, motivo, fecha }); await saveMovimiento(mov); toast('Movimiento actualizado'); }
  } else {
    const newMov = { id: store.movimientos.length ? Math.max(...store.movimientos.map(m => m.id)) + 1 : 1, prodId, prodName: prod?.name || '', tipo, cantidad: cant, stockAntes: prod?.stock || 0, stockDespues: prod ? prod.stock + cant : cant, motivo, userId: store.currentUser.id, userName: store.currentUser.name, fecha };
    store.movimientos.push(newMov);
    await saveMovimiento(newMov);
    toast('Movimiento agregado');
  }
  closeModal('modal-mov');
  renderMovimientos();
}

async function delMov(id) {
  if (!confirm('¿Eliminar este movimiento?')) return;
  store.movimientos = store.movimientos.filter(m => m.id !== id);
  await removeMovimiento(id);
  renderMovimientos();
  toast('Movimiento eliminado');
}

// ===== PRODUCTOS =====

function renderProducts() {
  const isAdmin = store.currentUser?.role === 'admin';
  const thCP = document.getElementById('th-costo-prod');
  const thM  = document.getElementById('th-margen');
  const thA  = document.getElementById('th-acc-prod');
  if (thCP) thCP.style.display = isAdmin ? '' : 'none';
  if (thM)  thM.style.display  = isAdmin ? '' : 'none';
  if (thA)  thA.textContent    = isAdmin ? 'Acciones' : '';

  document.getElementById('prod-table').innerHTML = store.products.map(p => {
    const margin    = p.cost > 0 ? Math.round((p.price - p.cost) / p.price * 100) : 0;
    const proveedor = store.proveedores.find(v => v.id === p.provId);
    const marginColor = margin > 30 ? 'var(--accent)' : margin > 15 ? 'var(--warn)' : 'var(--red)';
    const hasPres = p.presentaciones?.length > 0;
    return `
      <tr>
        <td style="font-family:var(--mono);font-size:11px;color:var(--txt2)">${p.code}</td>
        <td style="font-weight:500">
          ${p.name}
          ${hasPres ? `<div style="font-size:10px;color:var(--blue)">${p.presentaciones.length} presentaciones</div>` : ''}
        </td>
        <td>${p.cat}</td>
        <td style="font-size:12px;color:var(--txt2)">${proveedor ? proveedor.name : '-'}</td>
        ${isAdmin ? `<td style="color:var(--txt2)">${formatMoney(p.cost)}</td>` : ''}
        <td style="font-weight:600">${formatMoney(p.price)}</td>
        ${isAdmin ? `<td style="color:${marginColor};font-weight:600">${margin}%</td>` : ''}
        <td>${isAdmin ? `<div style="display:flex;gap:5px">
          <button class="btn sm" onclick="openProdModal(${p.id})">Editar</button>
          <button class="btn sm red" onclick="delProd(${p.id})" style="padding:5px 8px">✕</button>
        </div>` : ''}</td>
      </tr>`;
  }).join('');
}

function openProdModal(id = null) {
  if (store.currentUser?.role !== 'admin') return;
  store.editProdId = id;
  document.getElementById('prod-modal-title').textContent = id ? 'Editar producto' : 'Nuevo producto';
  const prod = id ? store.products.find(p => p.id === id) : {};
  document.getElementById('f-prov').innerHTML =
    '<option value="">Sin proveedor</option>' +
    store.proveedores.map(v => `<option value="${v.id}">${v.name}</option>`).join('');

  document.getElementById('f-code').value     = prod.code     || '';
  document.getElementById('f-name').value     = prod.name     || '';
  document.getElementById('f-cat').value      = prod.cat      || 'Almacén';
  document.getElementById('f-prov').value     = prod.provId   || '';
  document.getElementById('f-cost').value     = prod.cost     || '';
  document.getElementById('f-price').value    = prod.price    || '';
  document.getElementById('f-stock').value    = prod.stock    || '';
  document.getElementById('f-minstock').value = prod.minStock || 5;

  // Presentaciones
  store._editPres = prod.presentaciones ? JSON.parse(JSON.stringify(prod.presentaciones)) : [];
  renderPresentacionesEditor();
  openModal('modal-prod');
}

function renderPresentacionesEditor() {
  const container = document.getElementById('f-presentaciones');
  if (!container) return;
  container.innerHTML = (store._editPres || []).map((p, i) => `
    <div style="display:grid;grid-template-columns:1fr 90px 55px 90px 28px;gap:6px;align-items:center;margin-bottom:6px">
      <input placeholder="Etiqueta (ej: Set x6)" value="${p.label || ''}"
        onchange="store._editPres[${i}].label=this.value"
        style="font-size:13px">
      <input type="number" placeholder="Precio" value="${p.price || ''}"
        onchange="store._editPres[${i}].price=parseFloat(this.value)||0"
        style="font-size:13px;font-weight:700">
      <input type="number" placeholder="Uds" value="${p.unidades || ''}" title="Unidades que descuenta del stock"
        onchange="store._editPres[${i}].unidades=parseInt(this.value)||1"
        style="font-size:13px">
      <input placeholder="Cód. barras" value="${p.code || ''}"
        onchange="store._editPres[${i}].code=this.value"
        style="font-size:12px;font-family:var(--mono)">
      <button class="btn sm red" onclick="store._editPres.splice(${i},1);renderPresentacionesEditor()"
        style="padding:4px 6px">✕</button>
    </div>`).join('') +
    `<button class="btn sm" onclick="store._editPres.push({id:Date.now(),label:'',price:0,unidades:1,code:''});renderPresentacionesEditor()" style="margin-top:4px;width:100%">
      + Agregar presentación (set, pack, etc.)
    </button>`;
}

async function saveProd() {
  const code = document.getElementById('f-code').value.trim();
  const name = document.getElementById('f-name').value.trim();
  if (!code || !name) { showMsg('msg-prod', 'Completá código y nombre', 'err'); return; }
  if (store.products.find(p => p.code === code && p.id !== store.editProdId)) {
    showMsg('msg-prod', 'Código ya existe', 'err'); return;
  }

  // Filtrar presentaciones válidas
  const presentaciones = (store._editPres || []).filter(p => p.label && p.price > 0 && p.unidades > 0);

  const data = {
    code, name,
    cat:           document.getElementById('f-cat').value,
    provId:        parseInt(document.getElementById('f-prov').value) || null,
    cost:          parseFloat(document.getElementById('f-cost').value) || 0,
    price:         parseFloat(document.getElementById('f-price').value) || 0,
    stock:         parseInt(document.getElementById('f-stock').value) || 0,
    minStock:      parseInt(document.getElementById('f-minstock').value) || 5,
    presentaciones,
  };

  if (store.editProdId) {
    const prod = store.products.find(p => p.id === store.editProdId);
    Object.assign(prod, data);
    await saveProduct(prod);
  } else {
    const newProd = { id: store.nextProdId++, ...data, sold: 0, revenue: 0 };
    store.products.push(newProd);
    await saveProduct(newProd);
  }

  closeModal('modal-prod');
  renderProducts();
  toast('Producto guardado');
}

async function delProd(id) {
  if (store.currentUser?.role !== 'admin') return;
  if (!confirm('¿Borrar producto?')) return;
  store.products = store.products.filter(p => p.id !== id);
  await removeProduct(id);
  renderProducts();
  toast('Eliminado');
}

// ===== PROVEEDORES =====

function renderProveedores() {
  const deudaTotal = store.ctacteMovs.reduce((s, m) => m.type === 'deuda' ? s + m.monto : s - m.monto, 0);
  document.getElementById('pv-total').textContent   = store.proveedores.length;
  document.getElementById('pv-pending').textContent = store.orders.filter(o => o.status === 'pendiente').length;
  document.getElementById('pv-deuda').textContent   = formatMoney(Math.max(0, deudaTotal));

  document.getElementById('prov-list').innerHTML = store.proveedores.map(pv => {
    const pvProds = store.products.filter(p => p.provId === pv.id);
    const pvOrds  = store.orders.filter(o => o.provId === pv.id);
    const pvDeuda = store.ctacteMovs.filter(m => m.provId === pv.id).reduce((s, m) => m.type === 'deuda' ? s + m.monto : s - m.monto, 0);
    const deudaColor = pvDeuda > 0 ? 'var(--red)' : 'var(--accent)';
    return `
      <div class="prov-card">
        <div class="prov-head">
          <div><div class="prov-nm">${pv.name}</div><div class="prov-cat">${pv.cat}</div></div>
          <div style="text-align:right">
            <span class="badge blu">${pvProds.length} productos</span>
            ${pvDeuda > 0 ? `<div style="font-size:12px;color:var(--red);font-weight:700;margin-top:4px">Deuda: ${formatMoney(pvDeuda)}</div>` : ''}
          </div>
        </div>
        <div class="prov-grid">
          <div>Contacto: <strong>${pv.contact}</strong></div>
          <div>Tel: <strong>${pv.phone}</strong></div>
          <div>Email: <strong>${pv.email}</strong></div>
          <div>Entrega: <strong>${DELIVERY_LABELS[pv.days] || pv.days + ' d'}</strong></div>
          <div>Órdenes: <strong>${pvOrds.length}</strong></div>
          <div>Estado: <strong style="color:${deudaColor}">${pvDeuda > 0 ? 'Con deuda' : 'Al día'}</strong></div>
        </div>
        ${pv.notes ? `<div class="prov-note">${pv.notes}</div>` : ''}
        <div class="prov-acts">
          <button class="btn sm" onclick="openProvModal(${pv.id})">Editar</button>
          <button class="btn sm blu" onclick="openOCModal(${pv.id})">Nueva orden</button>
          <button class="btn sm" onclick="openPagoModal(${pv.id})">Registrar pago</button>
          <button class="btn sm red" onclick="delProv(${pv.id})">Eliminar</button>
        </div>
      </div>`;
  }).join('');
}

function openProvModal(id = null) {
  store.editProvId = id;
  document.getElementById('prov-modal-title').textContent = id ? 'Editar proveedor' : 'Nuevo proveedor';
  const pv = id ? store.proveedores.find(p => p.id === id) : {};
  document.getElementById('pv-name').value    = pv.name    || '';
  document.getElementById('pv-cat').value     = pv.cat     || 'Almacén';
  document.getElementById('pv-contact').value = pv.contact || '';
  document.getElementById('pv-phone').value   = pv.phone   || '';
  document.getElementById('pv-email').value   = pv.email   || '';
  document.getElementById('pv-days').value    = pv.days    || 2;
  document.getElementById('pv-notes').value   = pv.notes   || '';
  openModal('modal-prov');
}

async function saveProv() {
  const name = document.getElementById('pv-name').value.trim();
  if (!name) { showMsg('msg-prov', 'Ingresá el nombre', 'err'); return; }
  const data = {
    name, cat: document.getElementById('pv-cat').value,
    contact: document.getElementById('pv-contact').value.trim(),
    phone:   document.getElementById('pv-phone').value.trim(),
    email:   document.getElementById('pv-email').value.trim(),
    days:    parseInt(document.getElementById('pv-days').value),
    notes:   document.getElementById('pv-notes').value.trim(),
  };
  if (store.editProvId) {
    const pv = store.proveedores.find(p => p.id === store.editProvId);
    Object.assign(pv, data); await saveProveedor(pv);
  } else {
    const newPv = { id: store.nextProvId++, ...data };
    store.proveedores.push(newPv); await saveProveedor(newPv);
  }
  closeModal('modal-prov'); renderProveedores(); toast('Proveedor guardado');
}

async function delProv(id) {
  if (!confirm('¿Eliminar proveedor?')) return;
  const affected = store.products.filter(p => p.provId === id);
  affected.forEach(p => { p.provId = null; });
  store.proveedores = store.proveedores.filter(p => p.id !== id);
  await removeProveedor(id, affected);
  renderProveedores(); toast('Proveedor eliminado');
}

// ===== CUENTA CORRIENTE =====

function renderCtaCte() {
  const sel  = document.getElementById('cc-prov-sel');
  const prev = sel.value;
  sel.innerHTML = '<option value="">Todos los proveedores</option>' +
    store.proveedores.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
  sel.value = prev;
  const fp       = sel.value;
  const filtered = store.ctacteMovs.filter(m => !fp || m.provId == fp);

  document.getElementById('cc-cards').innerHTML = store.proveedores
    .filter(pv => !fp || pv.id == fp)
    .map(pv => {
      const saldo = store.ctacteMovs.filter(m => m.provId === pv.id).reduce((s, m) => m.type === 'deuda' ? s + m.monto : s - m.monto, 0);
      return `<div class="card"><div class="card-lbl">${pv.name}</div><div class="card-val ${saldo > 0 ? 'r' : 'g'}" style="font-size:15px">${saldo > 0 ? 'Debe ' + formatMoney(saldo) : 'Al día'}</div></div>`;
    }).join('');

  const tb = document.getElementById('cc-table');
  const em = document.getElementById('cc-empty');
  if (!filtered.length) { tb.innerHTML = ''; em.style.display = 'block'; return; }
  em.style.display = 'none';
  let saldoAcum = 0;
  tb.innerHTML = filtered.map(m => {
    const pv = store.proveedores.find(v => v.id === m.provId);
    saldoAcum += m.type === 'deuda' ? m.monto : -m.monto;
    return `
      <tr>
        <td style="font-size:12px;color:var(--txt2);white-space:nowrap">${m.fecha}</td>
        <td style="font-weight:500">${pv ? pv.name : '-'}</td>
        <td style="font-size:12px">${m.concepto}</td>
        <td style="color:var(--red);font-weight:600">${m.type === 'deuda' ? formatMoney(m.monto) : '-'}</td>
        <td style="color:var(--accent);font-weight:600">${m.type === 'pago' ? formatMoney(m.monto) : '-'}</td>
        <td style="font-weight:700;color:${saldoAcum > 0 ? 'var(--red)' : 'var(--accent)'}">${saldoAcum > 0 ? formatMoney(saldoAcum) : '$0'}</td>
      </tr>`;
  }).join('');
}

function openPagoModal(provId = null) {
  document.getElementById('pago-prov').innerHTML = store.proveedores.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
  if (provId) document.getElementById('pago-prov').value = provId;
  document.getElementById('pago-monto').value = '';
  document.getElementById('pago-ref').value   = '';
  openModal('modal-pago');
}

async function savePago() {
  const monto = parseFloat(document.getElementById('pago-monto').value) || 0;
  if (!monto) { showMsg('msg-pago', 'Ingresá un monto', 'err'); return; }
  const provId = parseInt(document.getElementById('pago-prov').value);
  const met    = document.getElementById('pago-met').value;
  const ref    = document.getElementById('pago-ref').value;
  const pago = { id: store.nextCCId++, provId, type: 'pago', monto, concepto: `Pago ${met}${ref ? ' (' + ref + ')' : ''}`, fecha: new Date().toLocaleString('es-AR') };
  store.ctacteMovs.push(pago);
  await savePagoCtaCte(pago);
  closeModal('modal-pago'); renderCtaCte(); toast('Pago registrado');
}

// ===== ÓRDENES DE COMPRA =====

function renderOrdenes() {
  const tb = document.getElementById('oc-table');
  const em = document.getElementById('oc-empty');
  if (!store.orders.length) { tb.innerHTML = ''; em.style.display = 'block'; return; }
  em.style.display = 'none';
  const statusBadge = { pendiente: 'low', recibida: 'ok', cancelada: 'gray' };
  const statusLabel = { pendiente: 'Pendiente', recibida: 'Recibida', cancelada: 'Cancelada' };
  tb.innerHTML = [...store.orders].reverse().map(o => {
    const pv = store.proveedores.find(v => v.id === o.provId);
    const actions = o.status === 'pendiente' ? `<div style="display:flex;gap:5px"><button class="btn sm pri" onclick="receiveOC(${o.id})">Recibir</button><button class="btn sm red" onclick="cancelOC(${o.id})">Cancelar</button></div>` : '—';
    return `<tr><td style="font-weight:700">#${o.id}</td><td style="font-size:12px;color:var(--txt2)">${o.date}</td><td style="font-weight:500">${pv ? pv.name : '-'}</td><td style="font-weight:700;color:var(--accent)">${formatMoney(o.total)}</td><td><span class="badge ${statusBadge[o.status]}">${statusLabel[o.status]}</span></td><td>${actions}</td></tr>`;
  }).join('');
}

function openOCModal(provId = null) {
  store.ocItems = [];
  const sel = document.getElementById('oc-prov');
  sel.innerHTML = store.proveedores.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
  if (provId) sel.value = provId;
  document.getElementById('oc-date').value  = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0];
  document.getElementById('oc-notes').value = '';
  addOCItem(); openModal('modal-oc');
}

function loadOCProds() { store.ocItems = []; renderOCItems(); addOCItem(); }
function addOCItem() { store.ocItems.push({ prodId: '', qty: 1, cost: 0, name: '' }); renderOCItems(); }
function getOCProds() { return store.products.filter(p => p.provId === parseInt(document.getElementById('oc-prov').value)); }

function renderOCItems() {
  const prods = getOCProds();
  document.getElementById('oc-prod-list').innerHTML = store.ocItems.map((item, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--brd)">
      <select onchange="setOCProd(${i}, this.value)" style="flex:1;font-size:12px">
        <option value="">Seleccioná producto...</option>
        ${prods.map(p => `<option value="${p.id}" ${item.prodId == p.id ? 'selected' : ''}>${p.name} (stock: ${p.stock})</option>`).join('')}
      </select>
      <input type="number" min="1" value="${item.qty}" onchange="setOCQty(${i}, this.value)" style="width:64px">
      <span style="font-size:12px;min-width:70px;text-align:right;font-weight:600">${formatMoney(item.cost * item.qty)}</span>
      <button class="btn sm red" onclick="removeOCItem(${i})" style="padding:4px 8px">✕</button>
    </div>`).join('');
  document.getElementById('oc-total').textContent = formatMoney(store.ocItems.reduce((s, i) => s + i.cost * i.qty, 0));
}

function setOCProd(index, val) {
  const prod = store.products.find(p => p.id == parseInt(val));
  store.ocItems[index].prodId = val; store.ocItems[index].cost = prod ? prod.cost : 0; store.ocItems[index].name = prod ? prod.name : '';
  renderOCItems();
}
function setOCQty(index, val) { store.ocItems[index].qty = parseInt(val) || 1; renderOCItems(); }
function removeOCItem(index) { store.ocItems.splice(index, 1); renderOCItems(); }

async function saveOC() {
  const valid = store.ocItems.filter(i => i.prodId && i.qty > 0);
  if (!valid.length) { showMsg('msg-oc', 'Agregá al menos un producto', 'err'); return; }
  const total  = valid.reduce((s, i) => s + i.cost * i.qty, 0);
  const provId = parseInt(document.getElementById('oc-prov').value);
  const order  = { id: store.nextOCId++, provId, date: document.getElementById('oc-date').value, items: valid.map(i => ({ ...i })), total, notes: document.getElementById('oc-notes').value, status: 'pendiente' };
  store.orders.push(order);
  const ctaMov = { id: store.nextCCId++, provId, type: 'deuda', monto: total, concepto: `Orden de compra #${order.id}`, fecha: new Date().toLocaleString('es-AR') };
  store.ctacteMovs.push(ctaMov);
  await saveOrder(order, ctaMov);
  closeModal('modal-oc'); renderOrdenes(); toast('Orden enviada');
}

async function receiveOC(id) {
  const order = store.orders.find(o => o.id === id);
  if (!order) return;
  const updatedProducts = []; const newMovimientos = [];
  order.items.forEach(item => {
    const prod = store.products.find(p => p.id == item.prodId);
    if (prod) { const prev = prod.stock; prod.stock += item.qty; updatedProducts.push(prod); newMovimientos.push(registrarMovimiento(prod.id, 'entrada', item.qty, prev, prod.stock, 'Orden compra #' + id)); }
  });
  order.status = 'recibida';
  await updateOrder(order, updatedProducts, newMovimientos);
  renderOrdenes(); toast('Mercadería recibida. Stock actualizado.');
}

async function cancelOC(id) {
  const order = store.orders.find(o => o.id === id);
  if (!order) return;
  order.status = 'cancelada';
  store.ctacteMovs = store.ctacteMovs.filter(m => m.concepto !== `Orden de compra #${id}`);
  await cancelOrderInDB(order);
  renderOrdenes(); toast('Orden cancelada');
}
