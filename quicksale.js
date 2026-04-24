/**
 * quicksale.js
 * Modo rápido de caja: búsqueda con teclado, autocompletado, navegación sin mouse.
 * Depende de: app.js, caja.js, firebase.js
 */

let qs = {
  active:      false,
  searchIdx:   -1,    // índice del resultado seleccionado
  results:     [],    // productos filtrados actuales
};

// ===== ABRIR / CERRAR MODO RÁPIDO =====

function openQuickSale() {
  if (!store.cajaAbierta) { toast('Abrí la caja primero', 'err'); return; }
  qs.active = true;
  document.getElementById('page-quicksale').classList.add('act');
  document.querySelectorAll('.page').forEach(p => {
    if (p.id !== 'page-quicksale') p.classList.remove('act');
  });
  document.getElementById('topbar-title').textContent = 'Modo Rápido';
  closeSidebar();

  // Autofocus permanente
  const inp = document.getElementById('qs-search');
  if (inp) {
    inp.value = '';
    inp.focus();
  }
  renderQSCart();
  renderQSResults('');
}

function closeQuickSale() {
  qs.active = false;
  document.getElementById('page-quicksale').classList.remove('act');
  go('ventas');
}

// ===== BÚSQUEDA Y RESULTADOS =====

function qsSearch(val) {
  qs.searchIdx = -1;
  renderQSResults(val.trim().toLowerCase());
}

function renderQSResults(q) {
  const container = document.getElementById('qs-results');

  if (!q) {
    // Sin query: mostrar todos ordenados por más vendido
    qs.results = [...store.products].sort((a, b) => b.sold - a.sold).slice(0, 12);
  } else {
    qs.results = store.products.filter(p =>
      p.name.toLowerCase().includes(q) || p.code.includes(q)
    );
  }

  if (!qs.results.length) {
    container.innerHTML = '<div class="qs-no-results">Sin resultados</div>';
    return;
  }

  container.innerHTML = qs.results.map((p, i) => {
    const inCart   = store.cart.find(c => c.id === p.id);
    const noStock  = p.stock <= 0;
    return `
      <div class="qs-result-item ${noStock ? 'qs-no-stock' : ''} ${i === qs.searchIdx ? 'qs-selected' : ''}"
           id="qsr-${i}"
           onclick="${noStock ? '' : `qsAddProduct(${p.id})`}"
           data-idx="${i}">
        <div class="qs-prod-main">
          <div class="qs-prod-name">${_qsHighlight(p.name, q)}</div>
          <div class="qs-prod-code">${p.code}</div>
        </div>
        <div class="qs-prod-right">
          <div class="qs-prod-price">${formatMoney(p.price)}</div>
          <div class="qs-stock-badge ${noStock ? 'qs-badge-out' : p.stock <= p.minStock ? 'qs-badge-low' : 'qs-badge-ok'}">
            ${noStock ? 'Sin stock' : 'Stock: ' + p.stock}
          </div>
          ${inCart ? `<div class="qs-in-cart">✓ ${inCart.qty} en carro</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

function _qsHighlight(text, q) {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return text;
  return text.slice(0, idx) +
    `<mark class="qs-mark">${text.slice(idx, idx + q.length)}</mark>` +
    text.slice(idx + q.length);
}

// ===== NAVEGACIÓN CON TECLADO =====

function qsKeydown(e) {
  const inp = document.getElementById('qs-search');

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      qs.searchIdx = Math.min(qs.searchIdx + 1, qs.results.length - 1);
      _qsUpdateSelection();
      break;

    case 'ArrowUp':
      e.preventDefault();
      qs.searchIdx = Math.max(qs.searchIdx - 1, -1);
      _qsUpdateSelection();
      break;

    case 'Enter':
      e.preventDefault();
      if (qs.searchIdx >= 0 && qs.results[qs.searchIdx]) {
        const prod = qs.results[qs.searchIdx];
        if (prod.stock > 0) qsAddProduct(prod.id);
      } else if (qs.results.length === 1 && qs.results[0].stock > 0) {
        qsAddProduct(qs.results[0].id);
      }
      break;

    case 'Escape':
      inp.value = '';
      qs.searchIdx = -1;
      renderQSResults('');
      break;

    case 'F2':
      e.preventDefault();
      qsFinalizarVenta();
      break;

    case 'Delete':
    case 'Backspace':
      // Si input está vacío, eliminar último ítem del carrito
      if (inp.value === '') {
        e.preventDefault();
        if (store.cart.length) {
          const last = store.cart[store.cart.length - 1];
          removeFromCart(last.id);
          renderQSCart();
        }
      }
      break;
  }
}

function _qsUpdateSelection() {
  document.querySelectorAll('.qs-result-item').forEach((el, i) => {
    el.classList.toggle('qs-selected', i === qs.searchIdx);
  });
  const sel = document.getElementById('qsr-' + qs.searchIdx);
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

// ===== AGREGAR AL CARRITO =====

function qsAddProduct(id) {
  const prod = store.products.find(p => p.id === id);
  if (!prod) return;

  addToCart(prod);          // reutiliza función de caja.js
  renderQSCart();
  renderQSResults(document.getElementById('qs-search').value.trim().toLowerCase());

  // Limpiar búsqueda y refocus
  const inp = document.getElementById('qs-search');
  inp.value = '';
  inp.focus();
  qs.searchIdx = -1;
  renderQSResults('');
}

function qsChangeQty(id, delta) {
  changeQty(id, delta);     // reutiliza función de caja.js
  renderQSCart();
  renderQSResults(document.getElementById('qs-search').value.trim().toLowerCase());
}

function qsRemove(id) {
  removeFromCart(id);
  renderQSCart();
  renderQSResults(document.getElementById('qs-search').value.trim().toLowerCase());
}

// ===== RENDERIZADO DEL CARRITO EN MODO RÁPIDO =====

function renderQSCart() {
  const list    = document.getElementById('qs-cart-list');
  const empty   = document.getElementById('qs-cart-empty');
  const total   = store.cart.reduce((s, c) => s + c.price * c.qty, 0);

  document.getElementById('qs-total').textContent = formatMoney(total);

  if (!store.cart.length) {
    if (list)  list.innerHTML = '';
    if (empty) empty.style.display = 'flex';
    document.getElementById('qs-cobrar-btn').disabled = true;
    return;
  }

  if (empty) empty.style.display = 'none';
  document.getElementById('qs-cobrar-btn').disabled = false;

  list.innerHTML = [...store.cart].reverse().map(c => `
    <div class="qs-cart-item">
      <div class="qs-ci-name">${c.name}</div>
      <div class="qs-ci-controls">
        <button class="qbtn" onclick="qsChangeQty(${c.id}, -1)">−</button>
        <span class="qs-ci-qty">${c.qty}</span>
        <button class="qbtn" onclick="qsChangeQty(${c.id}, 1)">+</button>
        <span class="qs-ci-price">${formatMoney(c.price * c.qty)}</span>
        <button class="qbtn" onclick="qsRemove(${c.id})" style="color:var(--red);border-color:var(--red-l)">✕</button>
      </div>
    </div>`).join('');
}

// ===== COBRO RÁPIDO =====

function qsSetPay(method) {
  store.payMethod = method;
  ['cash', 'card', 'transfer'].forEach(m => {
    document.getElementById('qs-pm-' + m)?.classList.toggle('sel', m === method);
  });
  const cashRow = document.getElementById('qs-cash-row');
  if (cashRow) cashRow.style.display = method === 'cash' ? 'block' : 'none';
  qsCalcChange();
}

function qsCalcChange() {
  const total    = store.cart.reduce((s, c) => s + c.price * c.qty, 0);
  const received = parseFloat(document.getElementById('qs-cash-recv')?.value) || 0;
  const el       = document.getElementById('qs-vuelto');
  if (!el) return;

  if (store.payMethod === 'cash' && received > 0) {
    const change   = received - total;
    el.style.display = 'block';
    el.className     = 'vuelto ' + (change >= 0 ? 'ok' : 'err');
    el.textContent   = change >= 0 ? 'Vuelto: ' + formatMoney(change) : 'Falta: ' + formatMoney(Math.abs(change));
  } else {
    el.style.display = 'none';
  }
}

async function qsFinalizarVenta() {
  if (!store.cart.length) { toast('Carrito vacío', 'err'); return; }

  const total  = store.cart.reduce((s, c) => s + c.price * c.qty, 0);
  const qsRecv = document.getElementById('qs-cash-recv');

  if (store.payMethod === 'cash') {
    const recv = parseFloat(qsRecv?.value) || 0;
    if (recv < total) { toast('Monto insuficiente', 'err'); return; }
    // Sincronizar al input principal que lee processSale()
    const mainRecv = document.getElementById('cash-recv');
    if (mainRecv) mainRecv.value = recv;
  }

  await processSale();

  // Resetear ambos inputs
  if (qsRecv) qsRecv.value = '';
  const mainRecv = document.getElementById('cash-recv');
  if (mainRecv) mainRecv.value = '';
  qsCalcChange();
  renderQSCart();

  document.getElementById('qs-search')?.focus();
}
