/**
 * dashboard.js
 * Dashboard de métricas, alertas inteligentes y devoluciones/anulaciones.
 * Depende de: app.js, firebase.js
 */

// ===== MÉTRICAS =====

function calcMetrics() {
  const now    = new Date();
  const hoy    = now.toLocaleDateString('es-AR');
  const semana = new Date(now - 7 * 86400000);

  const ventasHoy = store.sales.filter(s => s.date === hoy);
  const ventasSemana = store.sales.filter(s => {
    const parts = s.date.split('/');
    if (parts.length < 3) return false;
    const d = new Date(parts[2], parts[1] - 1, parts[0]);
    return d >= semana;
  });

  const totalHoy     = ventasHoy.reduce((s, v) => s + v.total, 0);
  const totalSemana  = ventasSemana.reduce((s, v) => s + v.total, 0);
  const ticketProm   = ventasHoy.length ? Math.round(totalHoy / ventasHoy.length) : 0;

  // Productos más vendidos (top 5)
  const prodSales = {};
  store.sales.forEach(v => {
    v.items.forEach(i => {
      prodSales[i.id] = prodSales[i.id] || { name: i.name, qty: 0, rev: 0 };
      prodSales[i.id].qty += i.qty;
      prodSales[i.id].rev += i.price * i.qty;
    });
  });
  const topProds = Object.entries(prodSales)
    .sort((a, b) => b[1].qty - a[1].qty)
    .slice(0, 5);

  // Por método de pago (hoy)
  const byMethod = {};
  ventasHoy.forEach(v => {
    byMethod[v.method] = (byMethod[v.method] || 0) + v.total;
  });

  return { ventasHoy, totalHoy, totalSemana, ticketProm, topProds, byMethod };
}

function renderDashboard() {
  const m = calcMetrics();

  document.getElementById('dash-hoy-count').textContent = m.ventasHoy.length;
  document.getElementById('dash-hoy-total').textContent = formatMoney(m.totalHoy);
  document.getElementById('dash-semana-total').textContent = formatMoney(m.totalSemana);
  document.getElementById('dash-ticket-prom').textContent = formatMoney(m.ticketProm);

  // Gráfico de métodos de pago
  renderPayMethodChart(m.byMethod);

  // Top productos
  const maxQty = Math.max(1, ...m.topProds.map(([, d]) => d.qty));
  document.getElementById('dash-top-prods').innerHTML = m.topProds.length
    ? m.topProds.map(([id, d], i) => `
        <div class="rank-row">
          <div class="rank-n">${i + 1}</div>
          <div class="rank-name" title="${d.name}">${d.name}</div>
          <div class="rank-bar"><div class="rank-fill" style="width:${Math.round(d.qty / maxQty * 100)}%"></div></div>
          <div class="rank-val">${d.qty} u.</div>
        </div>`).join('')
    : '<div style="color:var(--txt3);font-size:13px;padding:8px 0">Sin ventas aún</div>';

  // Ventas por hora (últimas 24h) — canvas chart
  renderHourlyChart();
}

function renderPayMethodChart(byMethod) {
  const el = document.getElementById('dash-pay-chart');
  if (!el) return;

  const labels   = { cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia' };
  const colors   = { cash: '#1a7a56', card: '#1a4f8a', transfer: '#b06a00' };
  const entries  = Object.entries(byMethod);
  const total    = entries.reduce((s, [, v]) => s + v, 0) || 1;

  if (!entries.length) {
    el.innerHTML = '<div style="color:var(--txt3);font-size:13px;text-align:center;padding:20px 0">Sin ventas hoy</div>';
    return;
  }

  // Donut SVG puro
  const size = 100;
  const cx = 50, cy = 50, r = 38, strokeW = 14;
  const circ = 2 * Math.PI * r;

  let offset = 0;
  const slices = entries.map(([key, val]) => {
    const pct  = val / total;
    const dash = pct * circ;
    const slice = { key, val, pct, dash, offset };
    offset += dash;
    return slice;
  });

  const svgSlices = slices.map(s => `
    <circle cx="${cx}" cy="${cy}" r="${r}"
      fill="none"
      stroke="${colors[s.key] || '#999'}"
      stroke-width="${strokeW}"
      stroke-dasharray="${s.dash} ${circ - s.dash}"
      stroke-dashoffset="${-s.offset + circ / 4}"
      transform="rotate(-90, ${cx}, ${cy})"
    />`).join('');

  const legend = entries.map(([key, val]) => `
    <div style="display:flex;align-items:center;gap:7px;font-size:12px">
      <span style="width:10px;height:10px;border-radius:50%;background:${colors[key] || '#999'};flex-shrink:0"></span>
      <span style="color:var(--txt2)">${labels[key] || key}</span>
      <span style="margin-left:auto;font-weight:600">${formatMoney(val)}</span>
    </div>`).join('');

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
      <svg viewBox="0 0 100 100" width="100" height="100" style="flex-shrink:0">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg3)" stroke-width="${strokeW}"/>
        ${svgSlices}
        <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--txt)" font-family="var(--font)">${formatMoney(total)}</text>
      </svg>
      <div style="flex:1;display:flex;flex-direction:column;gap:8px">${legend}</div>
    </div>`;
}

function renderHourlyChart() {
  const canvas = document.getElementById('dash-hourly-chart');
  if (!canvas) return;

  const ctx  = canvas.getContext('2d');
  const W    = canvas.width  = canvas.offsetWidth || 300;
  const H    = canvas.height = 90;
  const hoy  = new Date().toLocaleDateString('es-AR');
  const ventas = store.sales.filter(s => s.date === hoy);

  // Agrupar por hora
  const hours = Array(24).fill(0);
  ventas.forEach(v => {
    const h = parseInt((v.time || '0:0').split(':')[0]);
    hours[h] += v.total;
  });

  const maxVal = Math.max(1, ...hours);
  const barW   = W / 24;
  const padB   = 16;

  ctx.clearRect(0, 0, W, H);

  const style     = getComputedStyle(document.documentElement);
  const accent    = style.getPropertyValue('--accent').trim() || '#1a7a56';
  const bg3       = style.getPropertyValue('--bg3').trim() || '#eceae4';
  const txt3      = style.getPropertyValue('--txt3').trim() || '#a09d96';

  hours.forEach((val, i) => {
    const bH   = val > 0 ? Math.max(4, ((val / maxVal) * (H - padB - 4))) : 0;
    const x    = i * barW + barW * 0.15;
    const y    = H - padB - bH;
    const bw   = barW * 0.7;

    // Fondo
    ctx.fillStyle = bg3;
    ctx.beginPath();
    ctx.roundRect(x, 4, bw, H - padB - 4, 2);
    ctx.fill();

    // Barra de valor
    if (bH > 0) {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bH, 2);
      ctx.fill();
    }

    // Etiqueta de hora (cada 4)
    if (i % 4 === 0) {
      ctx.fillStyle = txt3;
      ctx.font      = '9px var(--mono, monospace)';
      ctx.textAlign = 'center';
      ctx.fillText(i + 'h', x + bw / 2, H - 2);
    }
  });
}

// ===== ALERTAS INTELIGENTES =====

function evaluateAlerts() {
  const alerts = [];
  const now    = new Date();

  store.products.forEach(p => {
    // Stock bajo
    if (p.stock > 0 && p.stock <= p.minStock) {
      alerts.push({
        type:  'warn',
        icon:  '⚠️',
        title: 'Stock bajo',
        desc:  `${p.name}: quedan ${p.stock} unidades (mínimo: ${p.minStock})`,
        prodId: p.id,
      });
    }

    // Sin stock
    if (p.stock === 0) {
      alerts.push({
        type:  'err',
        icon:  '🚫',
        title: 'Sin stock',
        desc:  `${p.name} no tiene stock disponible`,
        prodId: p.id,
      });
    }

    // Sin ventas en los últimos 30 días pero con stock
    if (p.stock > 0) {
      const threshold = new Date(now - 30 * 86400000);
      const hasSale   = store.movimientos.some(m => {
        if (m.prodId !== p.id || m.tipo !== 'venta') return false;
        const parts = m.fecha.split(/[\/, ]/);
        const d = new Date(parts[2], parts[1] - 1, parts[0]);
        return d >= threshold;
      });
      if (!hasSale && p.sold === 0 && store.sales.length > 10) {
        alerts.push({
          type:  'info',
          icon:  '📭',
          title: 'Sin movimiento',
          desc:  `${p.name} no registra ventas en los últimos 30 días`,
          prodId: p.id,
        });
      }
    }
  });

  return alerts;
}

function renderAlerts() {
  const container = document.getElementById('alerts-panel');
  if (!container) return;

  const alerts = evaluateAlerts();
  if (!alerts.length) {
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:14px;background:var(--accent-l);border-radius:var(--rad);color:var(--accent-d)">
        <span style="font-size:20px">✅</span>
        <span style="font-size:13px;font-weight:500">Todo en orden. No hay alertas activas.</span>
      </div>`;
    return;
  }

  const byType = { err: [], warn: [], info: [] };
  alerts.forEach(a => (byType[a.type] || byType.info).push(a));

  const renderGroup = (items, bg, color, label) => {
    if (!items.length) return '';
    return `
      <div style="margin-bottom:10px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${color};margin-bottom:6px">${label} (${items.length})</div>
        ${items.map(a => `
          <div class="alert-row alert-${a.type}" onclick="highlightProduct(${a.prodId})">
            <span class="alert-icon">${a.icon}</span>
            <div>
              <div class="alert-title">${a.title}</div>
              <div class="alert-desc">${a.desc}</div>
            </div>
          </div>`).join('')}
      </div>`;
  };

  container.innerHTML =
    renderGroup(byType.err,  'var(--red-l)',  'var(--red)',     'Crítico') +
    renderGroup(byType.warn, 'var(--warn-l)', 'var(--warn)',    'Advertencia') +
    renderGroup(byType.info, 'var(--blue-l)', 'var(--blue)',    'Información');
}

function highlightProduct(prodId) {
  go('stock');
  setTimeout(() => {
    const rows = document.querySelectorAll('#stock-table tr');
    const prod = store.products.find(p => p.id === prodId);
    if (!prod) return;
    rows.forEach(row => {
      if (row.textContent.includes(prod.name)) {
        row.style.background = 'var(--warn-l)';
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => row.style.background = '', 2000);
      }
    });
  }, 200);
}

// ===== DEVOLUCIONES / ANULACIONES =====

// store.devoluciones se añade en app.js store extension
function initDevolucionesStore() {
  if (!store.devoluciones) store.devoluciones = [];
  if (!store.nextDevId) store.nextDevId = 1;
}

function openDevolucionModal(saleId) {
  initDevolucionesStore();
  const sale = store.sales.find(s => s.id === saleId);
  if (!sale) { toast('Venta no encontrada', 'err'); return; }

  // Calcular qué ya fue devuelto de esta venta
  const devPrevias = store.devoluciones.filter(d => d.saleId === saleId);

  document.getElementById('dev-sale-id').textContent = '#' + sale.id;
  document.getElementById('dev-sale-date').textContent = sale.date + ' ' + sale.time;
  document.getElementById('dev-sale-user').textContent = sale.userName;

  document.getElementById('dev-items').innerHTML = sale.items.map(item => {
    const yaDevuelto = devPrevias
      .flatMap(d => d.items)
      .filter(di => di.id === item.id)
      .reduce((s, di) => s + di.qty, 0);
    const disponible = item.qty - yaDevuelto;

    return `
      <div class="dev-item" data-id="${item.id}" data-max="${disponible}" data-price="${item.price}">
        <div class="dev-item-name">${item.name}</div>
        <div class="dev-item-info">
          <span style="font-size:12px;color:var(--txt2)">Vendido: ${item.qty} · Ya devuelto: ${yaDevuelto}</span>
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
            <label style="font-size:12px;color:var(--txt2)">Devolver:</label>
            <input type="number" class="dev-qty-input" min="0" max="${disponible}" value="0"
              style="width:64px;text-align:center;font-weight:700"
              oninput="updateDevTotal()">
            <span style="font-size:12px;color:var(--txt3)">/ ${disponible} disponibles</span>
          </div>
        </div>
      </div>`;
  }).join('');

  document.getElementById('dev-total').textContent = formatMoney(0);
  document.getElementById('dev-type').value = 'parcial';

  // Botón de anulación completa
  const canAnular = !devPrevias.length;
  document.getElementById('dev-anular-btn').style.display = canAnular ? 'inline-block' : 'none';

  store._devSaleId = saleId;
  openModal('modal-devolucion');
}

function updateDevTotal() {
  let total = 0;
  document.querySelectorAll('.dev-item').forEach(row => {
    const qty   = parseInt(row.querySelector('.dev-qty-input').value) || 0;
    const price = parseFloat(row.dataset.price) || 0;
    total += qty * price;
  });
  document.getElementById('dev-total').textContent = formatMoney(total);
}

async function saveDevolucion() {
  initDevolucionesStore();
  const saleId = store._devSaleId;
  const sale   = store.sales.find(s => s.id === saleId);
  if (!sale) return;

  const items = [];
  let hasError = false;

  document.querySelectorAll('.dev-item').forEach(row => {
    const id     = parseInt(row.dataset.id);
    const max    = parseInt(row.dataset.max);
    const qty    = parseInt(row.querySelector('.dev-qty-input').value) || 0;
    const price  = parseFloat(row.dataset.price);
    const name   = row.querySelector('.dev-item-name').textContent;

    if (qty > max) {
      toast(`No podés devolver más de ${max} unidades de ${name}`, 'err');
      hasError = true;
      return;
    }
    if (qty > 0) items.push({ id, name, qty, price });
  });

  if (hasError) return;
  if (!items.length) { showMsg('msg-devolucion', 'Seleccioná al menos un producto a devolver', 'err'); return; }

  const motivo = document.getElementById('dev-motivo').value.trim() || 'Devolución';
  const total  = items.reduce((s, i) => s + i.qty * i.price, 0);

  const devolucion = {
    id:       store.nextDevId++,
    saleId,
    items,
    total,
    motivo,
    userId:   store.currentUser.id,
    userName: store.currentUser.name,
    fecha:    new Date().toLocaleString('es-AR'),
    type:     'parcial',
  };

  // Actualizar stock
  const updatedProducts = [];
  const newMovimientos  = [];

  items.forEach(item => {
    const prod = store.products.find(p => p.id === item.id);
    if (prod) {
      const prevStock  = prod.stock;
      prod.stock      += item.qty;
      const mov = registrarMovimiento(prod.id, 'devolucion', item.qty, prevStock, prod.stock, `Devolución venta #${saleId} - ${motivo}`);
      updatedProducts.push(prod);
      newMovimientos.push(mov);
    }
  });

  store.devoluciones.push(devolucion);

  try {
    // Guardar en Firebase
    const batch = db.batch();
    batch.set(db.collection('devoluciones').doc(String(devolucion.id)), devolucion);
    updatedProducts.forEach(p => batch.set(db.collection('products').doc(String(p.id)), p));
    newMovimientos.forEach(m => batch.set(db.collection('movimientos').doc(String(m.id)), m));
    await batch.commit();

    closeModal('modal-devolucion');
    toast(`Devolución registrada: ${formatMoney(total)}`);
    renderHistory();
    renderStockPage();
  } catch (e) {
    console.error('saveDevolucion error:', e);
    showMsg('msg-devolucion', 'Error guardando la devolución', 'err');
  }
}

async function anularVenta(saleId) {
  initDevolucionesStore();
  if (!confirm(`¿Anular completamente la venta #${saleId}? Esta acción devolverá el stock de todos los productos.`)) return;

  const sale = store.sales.find(s => s.id === saleId);
  if (!sale) { toast('Venta no encontrada', 'err'); return; }

  const devPrevias = store.devoluciones.filter(d => d.saleId === saleId);
  if (devPrevias.length) { toast('Esta venta ya tiene devoluciones parciales', 'err'); return; }

  const devolucion = {
    id:       store.nextDevId++,
    saleId,
    items:    sale.items.map(i => ({ ...i })),
    total:    sale.total,
    motivo:   'Anulación completa',
    userId:   store.currentUser.id,
    userName: store.currentUser.name,
    fecha:    new Date().toLocaleString('es-AR'),
    type:     'anulacion',
  };

  const updatedProducts = [];
  const newMovimientos  = [];

  sale.items.forEach(item => {
    const prod = store.products.find(p => p.id === item.id);
    if (prod) {
      const prevStock  = prod.stock;
      prod.stock      += item.qty;
      prod.sold       -= item.qty;
      prod.revenue    -= item.price * item.qty;
      const mov = registrarMovimiento(prod.id, 'devolucion', item.qty, prevStock, prod.stock, `Anulación venta #${saleId}`);
      updatedProducts.push(prod);
      newMovimientos.push(mov);
    }
  });

  // Marcar venta como anulada
  sale.anulada   = true;
  sale.anuladaAt = new Date().toLocaleString('es-AR');
  store.devoluciones.push(devolucion);

  try {
    const batch = db.batch();
    batch.set(db.collection('devoluciones').doc(String(devolucion.id)), devolucion);
    batch.set(db.collection('sales').doc(String(sale.id)), sale);
    updatedProducts.forEach(p => batch.set(db.collection('products').doc(String(p.id)), p));
    newMovimientos.forEach(m => batch.set(db.collection('movimientos').doc(String(m.id)), m));
    await batch.commit();

    closeModal('modal-devolucion');
    toast(`Venta #${saleId} anulada. Stock restaurado.`);
    renderHistory();
    renderStockPage();
  } catch (e) {
    console.error('anularVenta error:', e);
    toast('Error al anular la venta', 'err');
  }
}

// Carga devoluciones desde Firebase
async function _loadDevoluciones() {
  const snap = await db.collection('devoluciones').get();
  store.devoluciones = [];
  snap.forEach(d => store.devoluciones.push({ ...d.data(), id: parseInt(d.id) }));
  store.nextDevId = store.devoluciones.length
    ? Math.max(...store.devoluciones.map(d => d.id), 0) + 1
    : 1;
}
