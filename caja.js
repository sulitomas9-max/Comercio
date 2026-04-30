/**
 * caja.js — BazarHub
 * Maneja: carrito, proceso de venta, caja (apertura/cierre), retiros e historial.
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

// ===== CAJA BAR =====

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
  el.textContent      = diferencia === 0 ? '✓ Cuadra perfecto'
    : diferencia > 0 ? `Sobrante: ${formatMoney(diferencia)}`
    : `Faltante: ${formatMoney(Math.abs(diferencia))}`;
}

async function cerrarCaja() {
  if (!store.cajaAbierta) return;
  const ventasEf     = calcVentasEfCaja();
  const totalRetiros = calcRetirosCaja();
  const esperado     = store.cajaAbierta.inicial + ventasEf - totalRetiros;
  const contado      = parseFloat(document.getElementById('caj-contado').value) || 0;

  // Armar objeto completo ANTES de modificar el estado
  const cajaCerrada = {
    ...store.cajaAbierta,
    ventasEf,
    totalRetiros,
    esperado,
    contado,
    diferencia: contado - esperado,
    cierre:     new Date().toLocaleString('es-AR'),
    abierta:    false,
  };

  // Primero guardar en Firebase, después limpiar estado local
  await saveCaja(cajaCerrada);
  await saveSaldoConfig(contado);

  store.cajaHistory.push(cajaCerrada);
  store.saldoAnterior = contado;
  store.cajaAbierta   = null;

  closeModal('modal-cerrar-caja');
  updateCajaBar();
  toast('Caja cerrada.');
}

// ===== RETIRO =====

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
    monto, motivo,
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

// ===== PRESENTACIONES =====

function openPresentacionModal(prod) {
  const el = document.getElementById('modal-presentacion');
  if (!el) return;
  document.getElementById('pres-prod-name').textContent = prod.name;
  document.getElementById('pres-stock').textContent = `${prod.stock} unidades en stock`;

  let html = `
    <div class="pres-option" onclick="addToCartConPresentacion(store.products.find(p=>p.id===${prod.id}),{id:'unit',label:'Unidad',price:${prod.price},unidades:1}); closeModal('modal-presentacion')">
      <div class="pres-label">Unidad</div>
      <div class="pres-price">${formatMoney(prod.price)}</div>
      <div class="pres-units">Descuenta 1 unidad del stock</div>
    </div>
    ${(prod.presentaciones || []).map(pres => `
      <div class="pres-option" onclick="addToCartConPresentacion(store.products.find(p=>p.id===${prod.id}),${JSON.stringify(pres).replace(/"/g,"'")}); closeModal('modal-presentacion')">
        <div class="pres-label">${pres.label}</div>
        <div class="pres-price">${formatMoney(pres.price)}</div>
        <div class="pres-units">Descuenta ${pres.unidades} unidades del stock</div>
      </div>`).join('')}`;

  const combosConProd = (store.combos || []).filter(c => c.items.some(i => i.prodId === prod.id));
  if (combosConProd.length) {
    html += `<div class="pres-section-title">Combos disponibles</div>` +
      combosConProd.map(combo => `
        <div class="pres-option pres-combo" onclick="addComboToCart(store.combos.find(c=>c.id===${combo.id})); closeModal('modal-presentacion')">
          <div class="pres-label">🎁 ${combo.name}</div>
          <div class="pres-price">${formatMoney(combo.price)}</div>
          <div class="pres-units">${combo.items.map(i => { const p = store.products.find(x=>x.id===i.prodId); return (p?.name||'?')+' ×'+i.qty; }).join(' + ')}</div>
        </div>`).join('');
  }

  document.getElementById('pres-options').innerHTML = html;
  openModal('modal-presentacion');
}

// ===== CARRITO =====

function scanBarcode() {
  const code = document.getElementById('barcode-in').value.trim();
  if (!code) return;

  let prod = store.products.find(p => p.code === code);
  let presentacion = null;

  if (!prod) {
    for (const p of store.products) {
      const pres = (p.presentaciones || []).find(pr => pr.code === code);
      if (pres) { prod = p; presentacion = pres; break; }
    }
  }

  if (prod) {
    if (presentacion) {
      addToCartConPresentacion(prod, presentacion);
    } else if (prod.presentaciones && prod.presentaciones.length > 0) {
      openPresentacionModal(prod);
    } else {
      addToCart(prod);
    }
  } else {
    const combo = (store.combos || []).find(c => c.code === code);
    if (combo) addComboToCart(combo);
    else toast('Código no encontrado', 'err');
  }

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
  const foundCombos = (store.combos || []).filter(c =>
    c.name.toLowerCase().includes(q)
  );

  if (!found.length && !foundCombos.length) { res.style.display = 'none'; return; }

  res.style.display = 'block';
  res.innerHTML =
    found.map(p => `
      <div class="sr-item" onclick="addToCartById(${p.id})">
        <div>
          <div class="sr-name">${p.name}${p.presentaciones?.length ? ' <span style="font-size:10px;color:var(--blue);font-weight:600">• presentaciones</span>' : ''}</div>
          <div class="sr-meta">Stock: ${p.stock} · ${p.code}</div>
        </div>
        <div class="sr-price">${formatMoney(p.price)}</div>
      </div>`).join('') +
    foundCombos.map(c => `
      <div class="sr-item" onclick="addComboToCart(store.combos.find(x=>x.id===${c.id})); document.getElementById('search-prod').value=''; document.getElementById('search-results').style.display='none'">
        <div>
          <div class="sr-name">🎁 ${c.name}</div>
          <div class="sr-meta">Combo · ${c.items.length} productos</div>
        </div>
        <div class="sr-price">${formatMoney(c.price)}</div>
      </div>`).join('');
}

function addToCartById(id) {
  const prod = store.products.find(p => p.id === id);
  if (!prod) return;
  document.getElementById('search-prod').value = '';
  document.getElementById('search-results').style.display = 'none';
  if (prod.presentaciones && prod.presentaciones.length > 0) {
    openPresentacionModal(prod);
  } else {
    addToCart(prod);
  }
}

function addToCart(prod) {
  if (!store.cajaAbierta) { toast('Abrí la caja primero', 'err'); return; }
  if (prod.stock <= 0)     { toast('Sin stock disponible', 'err'); return; }
  const existing = store.cart.find(c => c.id === prod.id && !c.presentacionId && !c.isCombo);
  if (existing) {
    if (existing.qty >= prod.stock) { toast('Stock insuficiente', 'err'); return; }
    existing.qty++;
  } else {
    store.cart.push({ id: prod.id, name: prod.name, price: prod.price, qty: 1, unidades: 1 });
  }
  renderCart();
  toast(prod.name + ' agregado');
}

function addToCartConPresentacion(prod, pres) {
  if (!store.cajaAbierta) { toast('Abrí la caja primero', 'err'); return; }
  const unidades = pres.unidades || 1;
  if (prod.stock < unidades) { toast('Stock insuficiente', 'err'); return; }
  const cartKey = prod.id + '_' + pres.id;
  const existing = store.cart.find(c => c._cartKey === cartKey);
  if (existing) {
    if ((existing.qty + 1) * unidades > prod.stock) { toast('Stock insuficiente', 'err'); return; }
    existing.qty++;
  } else {
    store.cart.push({
      id: prod.id, _cartKey: cartKey, presentacionId: pres.id,
      name: prod.name + (pres.label ? ' · ' + pres.label : ''),
      price: pres.price, qty: 1, unidades,
    });
  }
  renderCart();
  toast(prod.name + (pres.label ? ' · ' + pres.label : '') + ' agregado');
}

function addComboToCart(combo) {
  if (!store.cajaAbierta) { toast('Abrí la caja primero', 'err'); return; }
  for (const comp of combo.items) {
    const prod = store.products.find(p => p.id === comp.prodId);
    if (!prod || prod.stock < comp.qty) {
      toast('Stock insuficiente para el combo (' + (prod?.name || 'producto') + ')', 'err');
      return;
    }
  }
  const existing = store.cart.find(c => c._comboId === combo.id);
  if (existing) {
    for (const comp of combo.items) {
      const prod = store.products.find(p => p.id === comp.prodId);
      if (prod.stock < comp.qty * (existing.qty + 1)) { toast('Stock insuficiente', 'err'); return; }
    }
    existing.qty++;
  } else {
    store.cart.push({
      id: 'combo_' + combo.id, _comboId: combo.id,
      name: '🎁 ' + combo.name, price: combo.price,
      qty: 1, isCombo: true, comboItems: combo.items,
    });
  }
  renderCart();
  toast('Combo ' + combo.name + ' agregado');
}

function changeQty(cartKey, delta) {
  const item = store.cart.find(c => (c._cartKey || c._comboId || String(c.id)) === cartKey);
  if (!item) return;
  const newQty = item.qty + delta;
  if (newQty < 1) {
    store.cart = store.cart.filter(c => (c._cartKey || c._comboId || String(c.id)) !== cartKey);
    renderCart();
    return;
  }
  if (item.isCombo) {
    for (const comp of item.comboItems) {
      const prod = store.products.find(p => p.id === comp.prodId);
      if (prod && prod.stock < comp.qty * newQty) { toast('Stock insuficiente', 'err'); return; }
    }
  } else {
    const prod = store.products.find(p => p.id === item.id);
    const unidades = item.unidades || 1;
    if (prod && newQty * unidades > prod.stock) { toast('Stock insuficiente', 'err'); return; }
  }
  item.qty = newQty;
  renderCart();
}

function setQty(cartKey, val) {
  const item = store.cart.find(c => (c._cartKey || c._comboId || String(c.id)) === cartKey);
  if (!item) return;
  let newQty = Math.max(1, parseInt(val) || 1);
  if (!item.isCombo) {
    const prod = store.products.find(p => p.id === item.id);
    const unidades = item.unidades || 1;
    if (prod && newQty * unidades > prod.stock) {
      toast(`Stock insuficiente (máx ${Math.floor(prod.stock / unidades)})`, 'err');
      newQty = Math.floor(prod.stock / unidades);
    }
  }
  item.qty = newQty;
  renderCart();
}

function removeFromCart(cartKey) {
  store.cart = store.cart.filter(c => (c._cartKey || c._comboId || String(c.id)) !== cartKey);
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

  list.innerHTML = store.cart.map(c => {
    const cartKey = c._cartKey || c._comboId || String(c.id);
    return `
      <div class="ci">
        <div class="ci-name">
          ${c.name}
          <div class="ci-name-sub">${formatMoney(c.price)} c/u${c.unidades > 1 ? ` · descuenta ${c.unidades} uds` : ''}</div>
        </div>
        <div class="ci-qty">
          <button class="qbtn" onclick="changeQty('${cartKey}', -1)">−</button>
          <input class="ci-qty-input" type="number" min="1" value="${c.qty}"
            onchange="setQty('${cartKey}', this.value)" onclick="this.select()">
          <button class="qbtn" onclick="changeQty('${cartKey}', 1)">+</button>
        </div>
        <div class="ci-price">${formatMoney(c.price * c.qty)}</div>
        <div class="ci-del">
          <button class="qbtn" onclick="removeFromCart('${cartKey}')"
            style="color:var(--red);border-color:var(--red-l)">✕</button>
        </div>
      </div>`;
  }).join('');
  updateTotal();
}

function updateTotal() {
  const subtotal  = store.cart.reduce((s, c) => s + c.price * c.qty, 0);
  const descPct   = parseFloat(document.getElementById('desc-pct')?.value) || 0;
  const descMonto = Math.round(subtotal * descPct / 100);
  const total     = subtotal - descMonto;

  document.getElementById('v-sub').textContent   = formatMoney(subtotal);
  document.getElementById('v-total').textContent = formatMoney(total);
  const lbl = document.getElementById('vr-total-label');
  if (lbl) lbl.textContent = formatMoney(total);

  const descRow = document.getElementById('v-desc-row');
  if (descRow) descRow.style.display = descMonto > 0 ? 'flex' : 'none';
  const descVal = document.getElementById('v-desc-val');
  if (descVal) descVal.textContent = '- ' + formatMoney(descMonto);

  const cobrarBtn = document.getElementById('cobrar-btn');
  if (cobrarBtn) cobrarBtn.disabled = !store.cajaAbierta || !store.cart.length;

  calcChange();
}

function calcChange() {
  const subtotal = store.cart.reduce((s, c) => s + c.price * c.qty, 0);
  const descPct  = parseFloat(document.getElementById('desc-pct')?.value) || 0;
  const total    = Math.round(subtotal * (1 - descPct / 100));
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
    prodId, prodName: prod?.name || '', tipo, cantidad, stockAntes, stockDespues,
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

  const subtotal  = store.cart.reduce((s, c) => s + c.price * c.qty, 0);
  const descPct   = parseFloat(document.getElementById('desc-pct')?.value) || 0;
  const descMonto = Math.round(subtotal * descPct / 100);
  const total     = subtotal - descMonto;

  if (store.payMethod === 'cash') {
    const received = parseFloat(document.getElementById('cash-recv').value) || 0;
    if (received < total) { toast('Monto insuficiente', 'err'); return; }
  }

  const saleId = store.sales.length ? Math.max(...store.sales.map(s => s.id)) + 1 : 1;
  const now    = new Date();
  const updatedProducts = [];
  const newMovimientos  = [];

  store.cart.forEach(cartItem => {
    if (cartItem.isCombo) {
      cartItem.comboItems.forEach(comp => {
        const prod = store.products.find(p => p.id === comp.prodId);
        if (prod) {
          const uds  = comp.qty * cartItem.qty;
          const prev = prod.stock;
          prod.stock -= uds; prod.sold += uds; prod.revenue += prod.price * uds;
          updatedProducts.push(prod);
          newMovimientos.push(registrarMovimiento(prod.id, 'venta', -uds, prev, prod.stock, '🎁 Combo: ' + cartItem.name + ' - Venta #' + saleId));
        }
      });
    } else {
      const prod = store.products.find(p => p.id === cartItem.id);
      if (prod) {
        const uds  = cartItem.qty * (cartItem.unidades || 1);
        const prev = prod.stock;
        prod.stock -= uds; prod.sold += uds; prod.revenue += cartItem.price * cartItem.qty;
        updatedProducts.push(prod);
        newMovimientos.push(registrarMovimiento(prod.id, 'venta', -uds, prev, prod.stock, 'Venta #' + saleId));
      }
    }
  });

  const sale = {
    id: saleId, cajaId: store.cajaAbierta.id,
    date: `${now.getDate()}/${now.getMonth()+1}/${now.getFullYear()}`,
    time: now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
    items: [...store.cart], subtotal, descuento: descMonto, descPct, total,
    method: store.payMethod,
    userId: store.currentUser.id, userName: store.currentUser.name,
  };
  store.sales.push(sale);
  await saveSale(sale, updatedProducts, newMovimientos);

  generateTicket(sale);
  store.cart = [];
  const descEl = document.getElementById('desc-pct');
  if (descEl) descEl.value = '';
  document.getElementById('cash-recv').value = '';
  document.getElementById('vuelto').style.display = 'none';
  renderCart();
  updateCajaBar();
}

function generateTicket(sale) {
  const localName  = window.STORE_CONFIG?.localName || 'BAZARHUB';
  const localAddr  = window.STORE_CONFIG?.address   || '';
  const localPhone = window.STORE_CONFIG?.phone     || '';
  const methodName = { cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia' };

  const itemsHTML = sale.items.map(i => `
    <div class="tk-item">
      <div class="tk-item-name">${i.name}</div>
      <div class="tk-item-detail">
        <span>${i.qty} × ${formatMoney(i.price)}</span>
        <span class="tk-item-sub">${formatMoney(i.qty * i.price)}</span>
      </div>
    </div>`).join('');

  const descHTML = sale.descuento > 0 ? `
    <div class="tk-total-row" style="color:var(--red)">
      <span>Descuento ${sale.descPct}%</span>
      <span>- ${formatMoney(sale.descuento)}</span>
    </div>` : '';

  document.getElementById('ticket-content').innerHTML = `
    <div class="tk-wrap">
      <div class="tk-header">
        <div class="tk-logo">●</div>
        <div class="tk-local-name">${localName}</div>
        ${localAddr  ? `<div class="tk-local-sub">${localAddr}</div>`  : ''}
        ${localPhone ? `<div class="tk-local-sub">Tel: ${localPhone}</div>` : ''}
      </div>
      <div class="tk-meta">
        <div><span class="tk-meta-label">Fecha</span> ${sale.date} ${sale.time}</div>
        <div><span class="tk-meta-label">Cajero</span> ${sale.userName}</div>
        <div><span class="tk-meta-label">Comprobante</span> #${String(sale.id).padStart(6, '0')}</div>
      </div>
      <div class="tk-divider"></div>
      <div class="tk-items-header"><span>Producto</span><span>Subtotal</span></div>
      <div class="tk-items">${itemsHTML}</div>
      <div class="tk-divider"></div>
      <div class="tk-totals">
        <div class="tk-total-row"><span>Subtotal</span><span>${formatMoney(sale.subtotal || sale.total)}</span></div>
        ${descHTML}
        <div class="tk-total-row tk-total-final"><span>TOTAL</span><span>${formatMoney(sale.total)}</span></div>
        <div class="tk-total-row" style="color:var(--txt2);font-size:12px">
          <span>Método</span><span>${methodName[sale.method] || sale.method}</span>
        </div>
      </div>
      ${sale.anulada ? '<div class="tk-anulada">⚠ VENTA ANULADA</div>' : ''}
      <div class="tk-footer"><div>¡Gracias por su compra!</div></div>
    </div>`;
  openModal('modal-ticket');
}

function exportTicketPDF() { window.print(); }
function verTicket(id) { const sale = store.sales.find(s => s.id === id); if (sale) generateTicket(sale); }

// ===== HISTORIAL =====

function renderHistory() {
  const now    = new Date();
  const hoyISO = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  _renderHistorialFiltros();
  const desdeEl = document.getElementById('hist-desde');
  const hastaEl = document.getElementById('hist-hasta');
  if (desdeEl && !desdeEl.value) desdeEl.value = hoyISO;
  if (hastaEl && !hastaEl.value) hastaEl.value = hoyISO;
  _aplicarFiltroHistorial();
}

function _renderHistorialFiltros() {
  const el = document.getElementById('hist-search-bar');
  if (!el || el.dataset.init) return;
  el.dataset.init = '1';
  el.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
      <input id="hist-q" placeholder="🔍 Buscar producto o cajero..." style="flex:1;min-width:180px" oninput="_aplicarFiltroHistorial()">
      <input type="date" id="hist-desde" style="font-size:13px;padding:7px 10px" onchange="_aplicarFiltroHistorial()">
      <span style="color:var(--txt3);font-size:13px">→</span>
      <input type="date" id="hist-hasta" style="font-size:13px;padding:7px 10px" onchange="_aplicarFiltroHistorial()">
      <button class="btn sm" onclick="_limpiarFiltroHistorial()">Limpiar</button>
    </div>`;
}

function _limpiarFiltroHistorial() {
  const q = document.getElementById('hist-q');
  const d = document.getElementById('hist-desde');
  const h = document.getElementById('hist-hasta');
  if (q) q.value = ''; if (d) d.value = ''; if (h) h.value = '';
  _aplicarFiltroHistorial();
}

function parseLocalDate(str) {
  if (!str) return null;
  const parts = str.split('/');
  if (parts.length < 3) return null;
  return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
}

function _aplicarFiltroHistorial() {
  const q     = (document.getElementById('hist-q')?.value || '').toLowerCase();
  const desde = document.getElementById('hist-desde')?.value;
  const hasta = document.getElementById('hist-hasta')?.value;

  let ventas = [...store.sales].sort((a, b) => b.id - a.id);

  if (q) ventas = ventas.filter(v =>
    v.items.some(i => i.name.toLowerCase().includes(q)) ||
    (v.userName || '').toLowerCase().includes(q)
  );
  if (desde) {
    const [dy, dm, dd] = desde.split('-').map(Number);
    const dd2 = new Date(dy, dm - 1, dd);
    ventas = ventas.filter(v => { const d = parseLocalDate(v.date); return d && d >= dd2; });
  }
  if (hasta) {
    const [hy, hm, hd] = hasta.split('-').map(Number);
    const hh2 = new Date(hy, hm - 1, hd, 23, 59, 59);
    ventas = ventas.filter(v => { const d = parseLocalDate(v.date); return d && d <= hh2; });
  }

  const tbody = document.getElementById('hist-table');
  const empty = document.getElementById('hist-empty');

  if (!ventas.length) {
    if (tbody) tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    _updateHistMetrics([]);
    return;
  }
  if (empty) empty.style.display = 'none';
  _updateHistMetrics(ventas);

  if (tbody) {
    tbody.innerHTML = ventas.map(v => `
      <tr class="${v.anulada ? 'row-anulada' : ''}">
        <td><span style="font-family:var(--mono);font-weight:600">#${v.id}</span></td>
        <td>${v.date} ${v.time}</td>
        <td>${v.userName}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.items.map(i => `${i.name} ×${i.qty}`).join(', ')}</td>
        <td>
          ${v.descuento > 0 ? `<div style="font-size:11px;color:var(--txt2)">${formatMoney(v.subtotal || v.total)}</div>` : ''}
          <strong style="color:${v.anulada ? 'var(--red)' : 'var(--accent)'}">${v.anulada ? '<s>' : ''}${formatMoney(v.total)}${v.anulada ? '</s>' : ''}</strong>
          ${v.descuento > 0 ? `<div style="font-size:10px;color:var(--red)">-${v.descPct}% desc.</div>` : ''}
        </td>
        <td>${METHOD_LABELS[v.method] || v.method}</td>
        <td>${v.anulada ? '<span class="badge out">Anulada</span>' : store.devoluciones?.some(d => d.saleId === v.id) ? '<span class="badge warn">Con dev.</span>' : '<span class="badge ok">OK</span>'}</td>
        <td>
          ${!v.anulada ? `<button class="btn sm" onclick="openDevolucionModal(${v.id})">Dev.</button>` : ''}
          <button class="btn sm" onclick="verTicket(${v.id})" style="margin-left:4px">🧾</button>
        </td>
      </tr>`).join('');
  }
  _renderHistorialDevoluciones();
  _renderHistorialCajas();
}

function _updateHistMetrics(ventas) {
  const validas = ventas.filter(v => !v.anulada);
  const total   = validas.reduce((s, v) => s + v.total, 0);
  const count   = validas.length;
  const avg     = count ? Math.round(total / count) : 0;
  const mc = {};
  validas.forEach(v => { mc[v.method] = (mc[v.method] || 0) + 1; });
  const best = Object.entries(mc).sort((a, b) => b[1] - a[1])[0];
  document.getElementById('h-count').textContent  = count;
  document.getElementById('h-today').textContent  = formatMoney(total);
  document.getElementById('h-avg').textContent    = formatMoney(avg);
  document.getElementById('h-method').textContent = best ? (METHOD_LABELS[best[0]] || best[0]) : '-';
}

function _renderHistorialDevoluciones() {
  const tb = document.getElementById('dev-hist-table');
  const em = document.getElementById('dev-hist-empty');
  if (!tb) return;
  const devs = store.devoluciones || [];
  if (!devs.length) { tb.innerHTML = ''; em.style.display = 'block'; return; }
  em.style.display = 'none';
  tb.innerHTML = [...devs].reverse().map(d => `
    <tr>
      <td>${d.fecha}</td><td>#${d.saleId}</td>
      <td><span class="badge ${d.type === 'anulacion' ? 'out' : 'warn'}">${d.type === 'anulacion' ? 'Anulación' : 'Parcial'}</span></td>
      <td>${d.items.map(i => `${i.name} ×${i.qty}`).join(', ')}</td>
      <td>${formatMoney(d.total)}</td><td>${d.motivo}</td><td>${d.userName}</td>
    </tr>`).join('');
}

function _renderHistorialCajas() {
  const tb  = document.getElementById('caja-hist-tb');
  const em  = document.getElementById('caja-hist-empty');
  const all = [...store.cajaHistory, ...(store.cajaAbierta ? [store.cajaAbierta] : [])];
  if (!all.length) { if (tb) tb.innerHTML = ''; if (em) em.style.display = 'block'; return; }
  if (em) em.style.display = 'none';
  tb.innerHTML = [...all].reverse().map(c => {
    const ret = store.retiros.filter(r => r.cajaId === c.id).reduce((s, r) => s + r.monto, 0);
    const vef = c.ventasEf !== undefined
      ? c.ventasEf
      : store.sales.filter(s => s.cajaId === c.id && s.method === 'cash').reduce((s, v) => s + v.total, 0);
    const esp = c.esperado !== undefined ? c.esperado : c.inicial + vef - ret;
    const dif = c.diferencia;
    return `<tr>
      <td style="font-size:11px;color:var(--txt2)">${c.inicio}</td>
      <td>${c.cajeroNombre}</td>
      <td>${formatMoney(c.inicial)}</td>
      <td style="color:var(--accent);font-weight:600">${formatMoney(vef)}</td>
      <td style="color:var(--red);font-weight:600">${formatMoney(ret)}</td>
      <td style="font-weight:600">${formatMoney(esp)}</td>
      <td>${c.contado != null ? formatMoney(c.contado) : '—'}</td>
      <td style="font-weight:700;color:${dif == null ? '' : dif < 0 ? 'var(--red)' : dif === 0 ? 'var(--accent)' : 'var(--warn)'}">
        ${dif != null ? (dif === 0 ? '✓ Cuadra' : (dif > 0 ? '+' : '') + formatMoney(dif)) : '—'}
      </td>
      <td><span class="badge ${c.abierta ? 'ok' : 'gray'}">${c.abierta ? 'Abierta' : 'Cerrada'}</span></td>
    </tr>`;
  }).join('');
}

// ===== COMBOS =====

function renderCombos() {
  if (!store.combos) store.combos = [];
  const el = document.getElementById('combos-list');
  if (!el) return;
  el.innerHTML = store.combos.length
    ? store.combos.map(c => `
        <div class="cajero-card">
          <div class="cajero-head">
            <div class="cajero-av">🎁</div>
            <div>
              <div style="font-size:14px;font-weight:600">${c.name}</div>
              <div style="font-size:12px;color:var(--txt2)">${formatMoney(c.price)} · ${c.items.map(i => { const p = store.products.find(x => x.id === i.prodId); return (p?.name || '?') + ' ×' + i.qty; }).join(', ')}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn sm" onclick="openComboModal(${c.id})">Editar</button>
            <button class="btn sm red" onclick="delCombo(${c.id})">Eliminar</button>
          </div>
        </div>`).join('')
    : '<div style="color:var(--txt2);font-size:13px;padding:8px 0">No hay combos creados</div>';
}

function openComboModal(id = null) {
  if (!store.combos) store.combos = [];
  store._editComboId = id;
  const combo = id ? store.combos.find(c => c.id === id) : null;
  document.getElementById('combo-modal-title').textContent = id ? 'Editar combo' : 'Nuevo combo';
  document.getElementById('combo-name').value  = combo?.name  || '';
  document.getElementById('combo-price').value = combo?.price || '';
  document.getElementById('combo-code').value  = combo?.code  || '';
  store._comboItems = combo ? [...combo.items] : [{ prodId: '', qty: 1 }];
  renderComboItems();
  openModal('modal-combo');
}

function renderComboItems() {
  document.getElementById('combo-items').innerHTML = (store._comboItems || []).map((item, i) => `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <select onchange="store._comboItems[${i}].prodId=parseInt(this.value)" style="flex:1;font-size:13px">
        <option value="">Seleccioná producto...</option>
        ${store.products.map(p => `<option value="${p.id}" ${item.prodId === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
      </select>
      <input type="number" min="1" value="${item.qty}" onchange="store._comboItems[${i}].qty=parseInt(this.value)||1" style="width:60px">
      <button class="btn sm red" onclick="store._comboItems.splice(${i},1);renderComboItems()" style="padding:5px 8px">✕</button>
    </div>`).join('');
}

async function saveCombo() {
  const name  = document.getElementById('combo-name').value.trim();
  const price = parseFloat(document.getElementById('combo-price').value);
  const code  = document.getElementById('combo-code').value.trim();
  const items = (store._comboItems || []).filter(i => i.prodId && i.qty > 0);

  if (!name)             { showMsg('msg-combo', 'Ingresá el nombre', 'err'); return; }
  if (!price || price <= 0) { showMsg('msg-combo', 'Ingresá el precio', 'err'); return; }
  if (!items.length)     { showMsg('msg-combo', 'Agregá al menos un producto', 'err'); return; }

  if (!store.combos) store.combos = [];

  if (store._editComboId) {
    const combo = store.combos.find(c => c.id === store._editComboId);
    Object.assign(combo, { name, price, code, items });
    await saveDoc('combos', combo.id, combo);
  } else {
    const newCombo = { id: Date.now(), name, price, code, items };
    store.combos.push(newCombo);
    await saveDoc('combos', newCombo.id, newCombo);
  }

  closeModal('modal-combo');
  renderCombos();
  toast('Combo guardado');
}

async function delCombo(id) {
  if (!confirm('¿Eliminar combo?')) return;
  store.combos = store.combos.filter(c => c.id !== id);
  await deleteDoc('combos', id);
  renderCombos();
  toast('Combo eliminado');
}

// ===== MOBILE =====

function toggleCobroPanel() {
  const vr = document.getElementById('venta-right');
  if (vr) vr.classList.toggle('expanded');
}

renderCart();
