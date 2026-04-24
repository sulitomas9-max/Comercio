/**
 * caja.js
 * Maneja: carrito, proceso de venta, caja (apertura/cierre), retiros e historial.
 * Depende de: app.js, firebase.js
 */

// ===== CÁLCULOS DE CAJA =====

function calcSaldoCaja() {
  if (!store.cajaAbierta) return 0;
  return store.cajaAbierta.inicial + calcVentasEfCaja() - calcRetirosCaja();
}

function calcVentasEfCaja() {
  if (!store.cajaAbierta) return 0;
  return store.sales
    .filter(s => s.cajaId === store.cajaAbierta.id && s.method === 'cash')
    .reduce((s, v) => s + v.total, 0);
}

function calcRetirosCaja() {
  if (!store.cajaAbierta) return 0;
  return store.retiros
    .filter(r => r.cajaId === store.cajaAbierta.id)
    .reduce((s, r) => s + r.monto, 0);
}

// ===== CAJA BAR (barra de estado) =====

function updateCajaBar() {
  const bar   = document.getElementById('caja-bar');
  const dot   = document.getElementById('caja-dot');
  const strip = document.getElementById('caja-saldo-strip');

  if (store.cajaAbierta) {
    bar.className = 'caja-bar abierta';
    dot.className = 'dot-pulse dp-on';
    document.getElementById('caja-bar-title').textContent = 'Caja abierta';
    document.getElementById('caja-bar-sub').textContent =
      `Cajero: ${store.cajaAbierta.cajeroNombre} · Desde ${store.cajaAbierta.inicio}`;

    const ventasEf = calcVentasEfCaja();
    const retiros  = calcRetirosCaja();
    const saldo    = store.cajaAbierta.inicial + ventasEf - retiros;

    document.getElementById('caja-actions').innerHTML = `
      <button class="btn warn-btn sm" onclick="openRetiro()">Retiro</button>
      <button class="btn red sm" onclick="openCerrarCaja()">Cerrar caja</button>`;

    strip.style.display = 'flex';
    document.getElementById('csi-inicial').textContent = formatMoney(store.cajaAbierta.inicial);
    document.getElementById('csi-ventas').textContent  = formatMoney(ventasEf);
    document.getElementById('csi-retiros').textContent = formatMoney(retiros);
    document.getElementById('csi-saldo').textContent   = formatMoney(saldo);
    document.getElementById('csi-saldo').className = 'csi-val ' + (saldo > 0 ? 'pos' : saldo < 0 ? 'neg' : '');

    document.getElementById('cobrar-btn').disabled = false;
  } else {
    bar.className = 'caja-bar cerrada';
    dot.className = 'dot-pulse dp-off';
    document.getElementById('caja-bar-title').textContent = 'Caja cerrada';
    document.getElementById('caja-bar-sub').textContent = store.saldoAnterior > 0
      ? `Saldo anterior disponible: ${formatMoney(store.saldoAnterior)}`
      : 'Abrí la caja para empezar a vender';
    document.getElementById('caja-actions').innerHTML =
      `<button class="btn pri sm" onclick="openAbrirCaja()">Abrir caja</button>`;
    strip.style.display = 'none';
    document.getElementById('cobrar-btn').disabled = true;
  }
}

// ===== ABRIR CAJA =====

function openAbrirCaja() {
  const sel = document.getElementById('caj-cajero-sel');
  sel.innerHTML = store.users.map(u => `<option value="${u.id}">${u.name}</option>`).join('');
  sel.value = store.currentUser.id;

  document.getElementById('caj-inicial').value = store.saldoAnterior || '';
  const hint = document.getElementById('caj-hint-saldo');
  if (store.saldoAnterior > 0) {
    hint.textContent = `Precargado con el saldo de la caja anterior: ${formatMoney(store.saldoAnterior)}`;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
  document.getElementById('caj-nota').value = '';
  openModal('modal-abrir-caja');
}

async function abrirCaja() {
  const inicial = parseFloat(document.getElementById('caj-inicial').value) || 0;
  const uid     = document.getElementById('caj-cajero-sel').value;
  const user    = store.users.find(u => u.id === uid) || store.currentUser;

  store.cajaAbierta = {
    id:           store.cajaHistory.length + 1,
    cajeroId:     user.id,
    cajeroNombre: user.name,
    inicio:       new Date().toLocaleString('es-AR'),
    inicial,
    abierta:      true,
    nota:         document.getElementById('caj-nota').value,
  };
  store.saldoAnterior = 0;

  await saveCaja(store.cajaAbierta);
  await saveSaldoConfig(0);

  closeModal('modal-abrir-caja');
  updateCajaBar();
  toast('Caja abierta');
}

// ===== CERRAR CAJA =====

function openCerrarCaja() {
  if (!store.cajaAbierta) return;

  const ventasEf      = calcVentasEfCaja();
  const totalRetiros  = calcRetirosCaja();
  const saldoEsperado = store.cajaAbierta.inicial + ventasEf - totalRetiros;

  document.getElementById('caj-resumen-cierre').innerHTML = `
    <div class="total-line"><span style="color:var(--txt2)">Monto inicial</span><span style="font-weight:600">${formatMoney(store.cajaAbierta.inicial)}</span></div>
    <div class="total-line"><span style="color:var(--txt2)">Ventas en efectivo</span><span style="font-weight:600;color:var(--accent)">+${formatMoney(ventasEf)}</span></div>
    <div class="total-line"><span style="color:var(--txt2)">Retiros realizados</span><span style="font-weight:600;color:var(--red)">-${formatMoney(totalRetiros)}</span></div>
    <div class="total-line" style="border-top:1px solid var(--brd);padding-top:6px;font-weight:700"><span>Esperado en caja</span><span>${formatMoney(saldoEsperado)}</span></div>`;

  document.getElementById('caj-contado').value = '';
  document.getElementById('dif-display').style.display = 'none';
  openModal('modal-cerrar-caja');
}

function calcDiferenciaCierre() {
  if (!store.cajaAbierta) return;
  const ventasEf   = calcVentasEfCaja();
  const retiros    = calcRetirosCaja();
  const esperado   = store.cajaAbierta.inicial + ventasEf - retiros;
  const contado    = parseFloat(document.getElementById('caj-contado').value) || 0;
  const diferencia = contado - esperado;

  const el = document.getElementById('dif-display');
  el.style.display    = 'block';
  el.style.background = diferencia >= 0 ? 'var(--accent-l)' : 'var(--red-l)';
  el.style.color      = diferencia >= 0 ? 'var(--accent-d)' : 'var(--red)';
  el.textContent      = diferencia === 0
    ? '✓ Cuadra perfecto'
    : diferencia > 0
      ? `Sobrante: ${formatMoney(diferencia)}`
      : `Faltante: ${formatMoney(Math.abs(diferencia))}`;
}

async function cerrarCaja() {
  if (!store.cajaAbierta) return;

  const ventasEf     = calcVentasEfCaja();
  const totalRetiros = calcRetirosCaja();
  const esperado     = store.cajaAbierta.inicial + ventasEf - totalRetiros;
  const contado      = parseFloat(document.getElementById('caj-contado').value) || 0;

  Object.assign(store.cajaAbierta, {
    ventasEf,
    totalRetiros,
    esperado,
    contado,
    diferencia: contado - esperado,
    cierre:     new Date().toLocaleString('es-AR'),
    abierta:    false,
  });

  store.cajaHistory.push({ ...store.cajaAbierta });
  store.saldoAnterior = contado;

  await saveCaja({ ...store.cajaAbierta });
  await saveSaldoConfig(contado);

  store.cajaAbierta = null;
  closeModal('modal-cerrar-caja');
  updateCajaBar();
  toast('Caja cerrada. Saldo guardado para la próxima apertura.');
}

// ===== RETIRO DE CAJA =====

function openRetiro() {
  if (!store.cajaAbierta) { toast('No hay caja abierta', 'err'); return; }
  const saldo = calcSaldoCaja();
  document.getElementById('retiro-saldo-actual').textContent = formatMoney(saldo);
  document.getElementById('retiro-monto').value = '';
  document.getElementById('retiro-warn').style.display = 'none';
  document.getElementById('retiro-motivo-sel').value = 'Gastos del negocio';
  document.getElementById('retiro-otro-wrap').style.display = 'none';
  document.getElementById('retiro-motivo-otro').value = '';
  openModal('modal-retiro');
}

function checkRetiroMonto() {
  const saldo = calcSaldoCaja();
  const monto = parseFloat(document.getElementById('retiro-monto').value) || 0;
  document.getElementById('retiro-warn').style.display = monto > saldo ? 'block' : 'none';
}

function toggleRetiroOtro() {
  const val = document.getElementById('retiro-motivo-sel').value;
  document.getElementById('retiro-otro-wrap').style.display = val === 'otro' ? 'block' : 'none';
}

async function saveRetiro() {
  const saldo = calcSaldoCaja();
  const monto = parseFloat(document.getElementById('retiro-monto').value) || 0;
  if (!monto || monto <= 0) { showMsg('msg-retiro', 'Ingresá un monto válido', 'err'); return; }
  if (monto > saldo)        { showMsg('msg-retiro', 'El monto supera el saldo disponible', 'err'); return; }

  const motivoSel = document.getElementById('retiro-motivo-sel').value;
  const motivo    = motivoSel === 'otro'
    ? document.getElementById('retiro-motivo-otro').value.trim() || 'Otro'
    : motivoSel;

  const retiro = {
    id:       store.nextRetiroId++,
    cajaId:   store.cajaAbierta.id,
    monto,
    motivo,
    userId:   store.currentUser.id,
    userName: store.currentUser.name,
    fecha:    new Date().toLocaleString('es-AR'),
  };
  store.retiros.push(retiro);
  await saveRetiroDoc(retiro);

  closeModal('modal-retiro');
  updateCajaBar();
  toast('Retiro registrado: ' + formatMoney(monto));
}

// ===== CARRITO =====

function scanBarcode() {
  const code = document.getElementById('barcode-in').value.trim();
  if (!code) return;
  const prod = store.products.find(p => p.code === code);
  if (prod) addToCart(prod);
  else toast('Código no encontrado', 'err');
  document.getElementById('barcode-in').value = '';
  document.getElementById('barcode-in').focus();
}

function filterProds() {
  const q   = document.getElementById('search-prod').value.toLowerCase().trim();
  const res = document.getElementById('search-results');
  if (!q) { res.style.display = 'none'; return; }

  const found = store.products.filter(p =>
    p.name.toLowerCase().includes(q) || p.code.includes(q)
  );
  if (!found.length) { res.style.display = 'none'; return; }

  res.style.display = 'block';
  res.innerHTML = found.map(p => `
    <div class="sr-item" onclick="addToCartById(${p.id})">
      <div>
        <div class="sr-name">${p.name}</div>
        <div class="sr-meta">Stock: ${p.stock} · ${p.code}</div>
      </div>
      <div class="sr-price">${formatMoney(p.price)}</div>
    </div>`
  ).join('');
}

function addToCartById(id) {
  const prod = store.products.find(p => p.id === id);
  if (prod) addToCart(prod);
  document.getElementById('search-prod').value = '';
  document.getElementById('search-results').style.display = 'none';
}

function addToCart(prod) {
  if (!store.cajaAbierta) { toast('Abrí la caja primero', 'err'); return; }
  if (prod.stock <= 0)     { toast('Sin stock disponible', 'err'); return; }

  const existing = store.cart.find(c => c.id === prod.id);
  if (existing) {
    if (existing.qty >= prod.stock) { toast('Stock insuficiente', 'err'); return; }
    existing.qty++;
  } else {
    store.cart.push({ id: prod.id, name: prod.name, price: prod.price, qty: 1 });
  }
  renderCart();
  toast(prod.name + ' agregado');
}

function changeQty(id, delta) {
  const item = store.cart.find(c => c.id === id);
  if (!item) return;
  const newQty = item.qty + delta;
  if (newQty < 1) { removeFromCart(id); return; }
  const prod = store.products.find(p => p.id === id);
  if (newQty > prod.stock) { toast('Stock insuficiente', 'err'); return; }
  item.qty = newQty;
  renderCart();
}

function setQty(id, val) {
  const item = store.cart.find(c => c.id === id);
  if (!item) return;
  const prod = store.products.find(p => p.id === id);
  let newQty = parseInt(val) || 1;
  newQty = Math.max(1, newQty);
  if (newQty > prod.stock) {
    toast(`Stock insuficiente (máx ${prod.stock})`, 'err');
    newQty = prod.stock;
  }
  item.qty = newQty;
  renderCart();
}

function removeFromCart(id) {
  store.cart = store.cart.filter(c => c.id !== id);
  renderCart();
}

function renderCart() {
  const list   = document.getElementById('cart-list');
  const empty  = document.getElementById('cart-empty');
  const header = document.getElementById('cart-header');

  if (!store.cart.length) {
    list.innerHTML = '';
    empty.style.display  = 'block';
    header.style.display = 'none';
    updateTotal();
    return;
  }

  empty.style.display  = 'none';
  header.style.display = 'grid';
  list.innerHTML = store.cart.map(c => `
    <div class="ci">
      <div class="ci-name">
        ${c.name}
        <div class="ci-name-sub">${formatMoney(c.price)} c/u</div>
      </div>
      <div class="ci-qty">
        <button class="qbtn" onclick="changeQty(${c.id}, -1)">−</button>
        <input class="ci-qty-input" type="number" min="1" value="${c.qty}"
          onchange="setQty(${c.id}, this.value)" onclick="this.select()">
        <button class="qbtn" onclick="changeQty(${c.id}, 1)">+</button>
      </div>
      <div class="ci-price">${formatMoney(c.price * c.qty)}</div>
      <div class="ci-del">
        <button class="qbtn" onclick="removeFromCart(${c.id})"
          style="color:var(--red);border-color:var(--red-l)">✕</button>
      </div>
    </div>`
  ).join('');
  updateTotal();
}

function updateTotal() {
  const total = store.cart.reduce((s, c) => s + c.price * c.qty, 0);
  document.getElementById('v-sub').textContent   = formatMoney(total);
  document.getElementById('v-total').textContent = formatMoney(total);
  const lbl = document.getElementById('vr-total-label');
  if (lbl) lbl.textContent = formatMoney(total);
  calcChange();
}

function calcChange() {
  const total    = store.cart.reduce((s, c) => s + c.price * c.qty, 0);
  const received = parseFloat(document.getElementById('cash-recv').value) || 0;
  const el       = document.getElementById('vuelto');

  if (store.payMethod === 'cash' && received > 0) {
    const change = received - total;
    el.style.display = 'block';
    el.className     = 'vuelto ' + (change >= 0 ? 'ok' : 'err');
    el.textContent   = change >= 0
      ? 'Vuelto: ' + formatMoney(change)
      : 'Falta: '  + formatMoney(Math.abs(change));
  } else {
    el.style.display = 'none';
  }
}

function setPay(method) {
  store.payMethod = method;
  ['cash', 'card', 'transfer'].forEach(m =>
    document.getElementById('pm-' + m).classList.toggle('sel', m === method)
  );
  document.getElementById('cash-row').style.display = method === 'cash' ? 'block' : 'none';
  if (method !== 'cash') document.getElementById('vuelto').style.display = 'none';
}

// ===== PROCESO DE VENTA =====

function registrarMovimiento(prodId, tipo, cantidad, stockAntes, stockDespues, motivo) {
  const prod = store.products.find(p => p.id === prodId);
  const mov = {
    id:           store.movimientos.length ? Math.max(...store.movimientos.map(m => m.id)) + 1 : 1,
    prodId,
    prodName:     prod?.name || '',
    tipo,
    cantidad,
    stockAntes,
    stockDespues,
    motivo:       motivo || tipo,
    userId:       store.currentUser?.id   || '',
    userName:     store.currentUser?.name || 'Sistema',
    fecha:        new Date().toLocaleString('es-AR'),
  };
  store.movimientos.push(mov);
  return mov;
}

async function processSale() {
  if (!store.cajaAbierta) { toast('Abrí la caja primero', 'err'); return; }
  if (!store.cart.length)  { toast('El carrito está vacío', 'err'); return; }

  const total = store.cart.reduce((s, c) => s + c.price * c.qty, 0);
  if (store.payMethod === 'cash') {
    const received = parseFloat(document.getElementById('cash-recv').value) || 0;
    if (received < total) { toast('Monto insuficiente', 'err'); return; }
  }

  const saleId = store.sales.length ? Math.max(...store.sales.map(s => s.id)) + 1 : 1;
  const now    = new Date();

  const updatedProducts = [];
  const newMovimientos  = [];

  store.cart.forEach(cartItem => {
    const prod = store.products.find(p => p.id === cartItem.id);
    if (prod) {
      const prevStock = prod.stock;
      prod.stock   -= cartItem.qty;
      prod.sold    += cartItem.qty;
      prod.revenue += cartItem.price * cartItem.qty;
      const mov = registrarMovimiento(prod.id, 'venta', -cartItem.qty, prevStock, prod.stock, 'Venta #' + saleId);
      updatedProducts.push(prod);
      newMovimientos.push(mov);
    }
  });

  const sale = {
    id:       saleId,
    cajaId:   store.cajaAbierta.id,
    date:     now.toLocaleDateString('es-AR'),
    time:     now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
    items:    [...store.cart],
    total,
    method:   store.payMethod,
    userId:   store.currentUser.id,
    userName: store.currentUser.name,
  };
  store.sales.push(sale);

  await saveSale(sale, updatedProducts, newMovimientos);

  generateTicket(sale);
  store.cart = [];
  document.getElementById('cash-recv').value = '';
  document.getElementById('vuelto').style.display = 'none';
  renderCart();
  updateCajaBar();
}

function generateTicket(sale) {
  const sep = '━━━━━━━━━━━━━━━━━━━━━━';
  const lines = [
    sep,
    '       MI COMERCIO',
    sep,
    `Fecha: ${sale.date}  ${sale.time}`,
    `Cajero: ${sale.userName}`,
    '─────────────────────────',
    ...sale.items.map(i => `${i.name}\n  ${i.qty} x ${formatMoney(i.price)} = ${formatMoney(i.qty * i.price)}`),
    '─────────────────────────',
    `TOTAL: ${formatMoney(sale.total)}`,
    `Método: ${METHOD_LABELS[sale.method] || sale.method}`,
    sep,
    '   ¡Gracias por su compra!',
    sep,
  ];
  document.getElementById('ticket-content').textContent = lines.join('\n');
  openModal('modal-ticket');
}

function verTicket(id) {
  const sale = store.sales.find(s => s.id === id);
  if (sale) generateTicket(sale);
}

// ===== HISTORIAL =====

function renderHistory() {
  const totalVentas  = store.sales.reduce((s, v) => s + v.total, 0);
  const countVentas  = store.sales.length;
  const ticketProm   = countVentas ? Math.round(totalVentas / countVentas) : 0;
  const methodCounts = {};
  store.sales.forEach(v => methodCounts[v.method] = (methodCounts[v.method] || 0) + 1);
  const bestMethod   = Object.entries(methodCounts).sort((a, b) => b[1] - a[1])[0];
  const methodNames  = { cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia' };

  document.getElementById('h-count').textContent  = countVentas;
  document.getElementById('h-today').textContent  = formatMoney(totalVentas);
  document.getElementById('h-avg').textContent    = formatMoney(ticketProm);
  document.getElementById('h-method').textContent = bestMethod ? (methodNames[bestMethod[0]] || bestMethod[0]) : '-';

  const tb = document.getElementById('hist-table');
  const em = document.getElementById('hist-empty');
  if (!store.sales.length) {
    tb.innerHTML = '';
    em.style.display = 'block';
  } else {
    em.style.display = 'none';
    tb.innerHTML = [...store.sales].reverse().map(v => `
      <tr>
        <td style="font-weight:700">#${v.id}</td>
        <td style="font-size:12px;color:var(--txt2)">${v.date} ${v.time}</td>
        <td style="font-size:12px">${v.userName}</td>
        <td style="font-size:11px;color:var(--txt2);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${v.items.map(i => `${i.name} x${i.qty}`).join(', ')}
        </td>
        <td style="font-weight:700;color:var(--accent)">${formatMoney(v.total)}</td>
        <td style="font-size:12px">${METHOD_LABELS[v.method] || v.method}</td>
        <td><button class="btn sm" onclick="verTicket(${v.id})">🧾</button></td>
      </tr>`
    ).join('');
  }

  _renderHistorialCajas();
}

function _renderHistorialCajas() {
  const tb  = document.getElementById('caja-hist-tb');
  const em  = document.getElementById('caja-hist-empty');
  const all = [...store.cajaHistory, ...(store.cajaAbierta ? [store.cajaAbierta] : [])];

  if (!all.length) {
    tb.innerHTML = '';
    em.style.display = 'block';
    return;
  }

  em.style.display = 'none';
  tb.innerHTML = [...all].reverse().map(c => {
    const retirosCaja = store.retiros
      .filter(r => r.cajaId === c.id)
      .reduce((s, r) => s + r.monto, 0);
    const ventasEfCaja = c.ventasEf !== undefined
      ? c.ventasEf
      : store.sales.filter(s => s.cajaId === c.id && s.method === 'cash').reduce((s, v) => s + v.total, 0);
    const esperado = c.esperado !== undefined ? c.esperado : c.inicial + ventasEfCaja - retirosCaja;
    const difColor = c.diferencia != null && c.diferencia < 0
      ? 'var(--red)'
      : c.diferencia === 0 ? 'var(--accent)' : 'var(--warn)';

    return `
      <tr>
        <td style="font-size:11px;color:var(--txt2)">${c.inicio}</td>
        <td>${c.cajeroNombre}</td>
        <td>${formatMoney(c.inicial)}</td>
        <td style="color:var(--accent);font-weight:600">${formatMoney(ventasEfCaja)}</td>
        <td style="color:var(--red);font-weight:600">${formatMoney(retirosCaja)}</td>
        <td style="font-weight:600">${formatMoney(esperado)}</td>
        <td>${c.contado != null ? formatMoney(c.contado) : '—'}</td>
        <td style="font-weight:700;color:${difColor}">
          ${c.diferencia != null ? (c.diferencia === 0 ? '✓ Cuadra' : (c.diferencia > 0 ? '+' : '') + c.diferencia.toLocaleString()) : '—'}
        </td>
        <td><span class="badge ${c.abierta ? 'ok' : 'gray'}">${c.abierta ? 'Abierta' : 'Cerrada'}</span></td>
      </tr>`;
  }).join('');
}

// ===== MOBILE =====

function toggleCobroPanel() {
  const vr = document.getElementById('venta-right');
  if (vr) vr.classList.toggle('expanded');
}

function expandCobroPanel() {
  const vr = document.getElementById('venta-right');
  if (vr) vr.classList.add('expanded');
}

// Inicializar carrito al cargar
renderCart();
