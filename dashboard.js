/**
 * dashboard.js — BazarHub
 * Dashboard, reportes avanzados, alertas y devoluciones.
 */

// ===== FECHAS CLAVE DEL BAZAR =====

const FECHAS_CLAVE = [
  { nombre: 'Año Nuevo',              mes: 1,  dia: 1  },
  { nombre: 'San Valentín',           mes: 2,  dia: 14 },
  { nombre: 'Reyes',                  mes: 1,  dia: 6  },
  { nombre: 'Pascuas',                mes: 4,  dia: 20 },
  { nombre: 'Día de la Madre',        mes: 10, dia: 19 },
  { nombre: 'Día del Padre',          mes: 6,  dia: 15 },
  { nombre: 'Día del Niño',           mes: 8,  dia: 11 },
  { nombre: 'Halloween',              mes: 10, dia: 31 },
  { nombre: 'Navidad',                mes: 12, dia: 25 },
  { nombre: 'Día de la Secretaria',   mes: 9,  dia: 4  },
  { nombre: 'Día del Maestro',        mes: 9,  dia: 11 },
];

function getFechasProximas() {
  const now = new Date();
  return FECHAS_CLAVE.map(f => {
    let fecha = new Date(now.getFullYear(), f.mes - 1, f.dia);
    if (fecha <= now) fecha = new Date(now.getFullYear() + 1, f.mes - 1, f.dia);
    const dias = Math.ceil((fecha - now) / 86400000);
    return { ...f, fecha, dias };
  }).sort((a, b) => a.dias - b.dias).slice(0, 6);
}

// ===== HELPERS DE FECHA =====

function parseLocalDate(dateStr) {
  if (!dateStr) return null;
  const p = dateStr.split('/');
  if (p.length < 3) return null;
  return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
}

function ventasEnRango(desde, hasta) {
  // Normalizar: desde = inicio del día, hasta = fin del día
  const desdeD = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate(), 0, 0, 0);
  const hastaD = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate(), 23, 59, 59);
  return store.sales.filter(s => {
    if (s.anulada) return false;
    const d = parseLocalDate(s.date);
    if (!d) return false;
    return d >= desdeD && d <= hastaD;
  });
}

function inicioMes(d)     { return new Date(d.getFullYear(), d.getMonth(), 1); }
function finMes(d)        { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function inicioMesAnterior(d) { return new Date(d.getFullYear(), d.getMonth() - 1, 1); }
function finMesAnterior(d)   { return new Date(d.getFullYear(), d.getMonth(), 0); }

// ===== MÉTRICAS =====

function calcMetrics() {
  const now   = new Date();
  // Construir fecha manualmente para que coincida exactamente con el formato
  // guardado en Firebase: "d/m/yyyy" (sin ceros adelante)
  const hoy   = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
  const semI  = new Date(now - 7 * 86400000);
  const mesI  = inicioMes(now);
  const prevI = inicioMesAnterior(now);
  const prevF = finMesAnterior(now);

  const ventasHoy    = store.sales.filter(s => !s.anulada && s.date === hoy);
  const ventasSemana = ventasEnRango(semI, now);
  const ventasMes    = ventasEnRango(mesI, now);
  const ventasPrev   = ventasEnRango(prevI, prevF);

  const totalHoy    = ventasHoy.reduce((s, v) => s + v.total, 0);
  const totalSemana = ventasSemana.reduce((s, v) => s + v.total, 0);
  const totalMes    = ventasMes.reduce((s, v) => s + v.total, 0);
  const totalPrev   = ventasPrev.reduce((s, v) => s + v.total, 0);
  const ticketProm  = ventasHoy.length ? Math.round(totalHoy / ventasHoy.length) : 0;

  const cambioPct = totalPrev > 0
    ? Math.round((totalMes - totalPrev) / totalPrev * 100)
    : null;

  // Top productos hoy
  const prodSales = {};
  store.sales.filter(s => !s.anulada).forEach(v => {
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

  return { ventasHoy, totalHoy, totalSemana, totalMes, totalPrev, ticketProm, topProds, byMethod, cambioPct };
}


// ===== VENTAS POR MES =====

function renderVentasPorMes() {
  const el = document.getElementById('dash-ventas-por-mes');
  if (!el) return;

  // Agrupar ventas por mes/año
  const meses = {};
  store.sales.filter(s => !s.anulada).forEach(v => {
    const d = parseLocalDate(v.date);
    if (!d) return;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    meses[key] = (meses[key] || 0) + v.total;
  });

  const MESES_LABEL = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                       'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

  const entries = Object.entries(meses).sort((a, b) => a[0].localeCompare(b[0]));

  if (!entries.length) {
    el.innerHTML = '<div style="color:var(--txt3);font-size:13px;padding:8px 0">Sin ventas registradas</div>';
    return;
  }

  const maxVal = Math.max(1, ...entries.map(([, v]) => v));
  const now = new Date();
  const mesActual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  el.innerHTML = entries.map(([key, val]) => {
    const [anio, mes] = key.split('-');
    const label = `${MESES_LABEL[parseInt(mes) - 1]} ${anio}`;
    const esActual = key === mesActual;
    return `
      <div class="rank-row" style="${esActual ? 'font-weight:700' : ''}">
        <div class="rank-name" style="width:130px;color:${esActual ? 'var(--accent-d)' : 'var(--txt)'}">
          ${label}${esActual ? ' ●' : ''}
        </div>
        <div class="rank-bar">
          <div class="rank-fill" style="width:${Math.round(val / maxVal * 100)}%;background:${esActual ? 'var(--accent)' : 'var(--blue)'}"></div>
        </div>
        <div class="rank-val" style="color:${esActual ? 'var(--accent-d)' : ''}">${formatMoney(val)}</div>
      </div>`;
  }).join('');
}

function renderDashboard() {
  const m = calcMetrics();

  document.getElementById('dash-hoy-count').textContent    = m.ventasHoy.length;
  document.getElementById('dash-hoy-total').textContent    = formatMoney(m.totalHoy);
  document.getElementById('dash-semana-total').textContent = formatMoney(m.totalSemana);
  document.getElementById('dash-ticket-prom').textContent  = formatMoney(m.ticketProm);
  const mesTotalEl = document.getElementById('dash-mes-total');
  if (mesTotalEl) mesTotalEl.textContent = formatMoney(m.totalMes);

  // Comparación mes
  const cmpEl = document.getElementById('dash-mes-cmp');
  if (cmpEl) {
    if (m.cambioPct === null) {
      cmpEl.textContent = 'Sin datos mes anterior';
      cmpEl.className = 'dash-cmp neutral';
    } else {
      const arrow = m.cambioPct >= 0 ? '↑' : '↓';
      cmpEl.textContent = `${arrow} ${Math.abs(m.cambioPct)}% vs mes anterior`;
      cmpEl.className = 'dash-cmp ' + (m.cambioPct >= 0 ? 'pos' : 'neg');
    }
  }

  renderPayMethodChart(m.byMethod);
  renderTopProds(m.topProds);
  renderHourlyChart();
  renderCatChart();
  renderVentasPorMes();
}

function renderTopProds(topProds) {
  const maxQty = Math.max(1, ...topProds.map(([, d]) => d.qty));
  document.getElementById('dash-top-prods').innerHTML = topProds.length
    ? topProds.map(([id, d], i) => `
        <div class="rank-row">
          <div class="rank-n">${i + 1}</div>
          <div class="rank-name" title="${d.name}">${d.name}</div>
          <div class="rank-bar"><div class="rank-fill" style="width:${Math.round(d.qty / maxQty * 100)}%"></div></div>
          <div class="rank-val">${d.qty} u.</div>
        </div>`).join('')
    : '<div style="color:var(--txt3);font-size:13px;padding:8px 0">Sin ventas aún</div>';
}

function renderCatChart() {
  const el = document.getElementById('dash-cat-chart');
  if (!el) return;

  const cats = {};
  store.sales.filter(s => !s.anulada).forEach(v => {
    v.items.forEach(i => {
      const prod = store.products.find(p => p.id === i.id);
      const cat  = prod ? prod.cat : 'Otros';
      cats[cat]  = (cats[cat] || 0) + i.price * i.qty;
    });
  });

  const entries = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));

  const COLORS = ['var(--accent)', 'var(--blue)', 'var(--warn)', '#8b5cf6', '#ec4899', '#06b6d4'];

  el.innerHTML = entries.length
    ? entries.map(([cat, val], i) => `
        <div class="rank-row">
          <div class="rank-name" style="width:90px">${cat}</div>
          <div class="rank-bar">
            <div class="rank-fill" style="width:${Math.round(val / max * 100)}%;background:${COLORS[i % COLORS.length]}"></div>
          </div>
          <div class="rank-val">${formatMoney(val)}</div>
        </div>`).join('')
    : '<div style="color:var(--txt3);font-size:13px">Sin datos</div>';
}

function renderFechasClavePanel() {
  const el = document.getElementById('dash-fechas-panel');
  if (!el) return;

  const fechas = getFechasProximas();
  el.innerHTML = fechas.map(f => {
    const urgente = f.dias <= 15;
    const pronto  = f.dias <= 45;
    const cls     = urgente ? 'fecha-urgente' : pronto ? 'fecha-pronto' : 'fecha-ok';
    const icon    = urgente ? '🔴' : pronto ? '🟡' : '🟢';
    return `
      <div class="fecha-item ${cls}">
        <div class="fecha-icon">${icon}</div>
        <div class="fecha-info">
          <div class="fecha-nombre">${f.nombre}</div>
          <div class="fecha-date">${f.fecha.toLocaleDateString('es-AR', { day:'numeric', month:'long' })}</div>
        </div>
        <div class="fecha-dias">
          <div class="fecha-dias-num">${f.dias}</div>
          <div class="fecha-dias-lbl">días</div>
        </div>
      </div>`;
  }).join('');
}

function renderPayMethodChart(byMethod) {
  const el = document.getElementById('dash-pay-chart');
  if (!el) return;

  const labels  = { cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia' };
  const colors  = { cash: '#1a7a56', card: '#1a4f8a', transfer: '#b06a00' };
  const entries = Object.entries(byMethod);
  const total   = entries.reduce((s, [, v]) => s + v, 0) || 1;

  if (!entries.length) {
    el.innerHTML = '<div style="color:var(--txt3);font-size:13px;text-align:center;padding:20px 0">Sin ventas hoy</div>';
    return;
  }

  const size = 100; const cx = 50; const cy = 50; const r = 38; const strokeW = 14;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const slices = entries.map(([key, val]) => {
    const pct = val / total;
    const dash = pct * circ;
    const s = { key, val, pct, dash, offset };
    offset += dash;
    return s;
  });

  const svgSlices = slices.map(s => `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="${colors[s.key] || '#999'}" stroke-width="${strokeW}"
      stroke-dasharray="${s.dash} ${circ - s.dash}"
      stroke-dashoffset="${-s.offset + circ / 4}"
      transform="rotate(-90, ${cx}, ${cy})"/>`).join('');

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
  const ctx = canvas.getContext('2d');
  const W   = canvas.width  = canvas.offsetWidth || 300;
  const H   = canvas.height = 90;
  const _n = new Date();
  const hoy = `${_n.getDate()}/${_n.getMonth() + 1}/${_n.getFullYear()}`;
  const ventas = store.sales.filter(s => !s.anulada && s.date === hoy);

  const hours = Array(24).fill(0);
  ventas.forEach(v => {
    // time puede ser "12:52 p. m." o "14:30" — extraer hora numérica
    const rawH = (v.time || '0:00').split(':')[0].trim();
    let h = parseInt(rawH);
    if ((v.time || '').includes('p. m.') && h !== 12) h += 12;
    if ((v.time || '').includes('a. m.') && h === 12) h = 0;
    hours[h] += v.total;
  });

  const maxVal = Math.max(1, ...hours);
  const barW   = W / 24;
  const padB   = 16;
  ctx.clearRect(0, 0, W, H);

  const style  = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--accent').trim() || '#1a7a56';
  const bg3    = style.getPropertyValue('--bg3').trim() || '#eceae4';
  const txt3   = style.getPropertyValue('--txt3').trim() || '#a09d96';

  hours.forEach((val, i) => {
    const bH = val > 0 ? Math.max(4, ((val / maxVal) * (H - padB - 4))) : 0;
    const x  = i * barW + barW * 0.15;
    const y  = H - padB - bH;
    const bw = barW * 0.7;
    ctx.fillStyle = bg3;
    ctx.beginPath(); ctx.roundRect(x, 4, bw, H - padB - 4, 2); ctx.fill();
    if (bH > 0) {
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.roundRect(x, y, bw, bH, 2); ctx.fill();
    }
    if (i % 4 === 0) {
      ctx.fillStyle = txt3;
      ctx.font = '9px var(--mono, monospace)';
      ctx.textAlign = 'center';
      ctx.fillText(i + 'h', x + bw / 2, H - 2);
    }
  });
}

// ===== REPORTES AVANZADOS =====

function renderReportes() {
  _renderReporteFiltros();
  _calcularYRenderReporte();
}

function _renderReporteFiltros() {
  const el = document.getElementById('rep-filtros');
  if (!el || el.dataset.init) return;
  el.dataset.init = '1';

  const now = new Date();
  const mesActual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  el.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="chip sel" onclick="setRepPeriodo('hoy', this)">Hoy</button>
        <button class="chip" onclick="setRepPeriodo('semana', this)">7 días</button>
        <button class="chip" onclick="setRepPeriodo('mes', this)">Este mes</button>
        <button class="chip" onclick="setRepPeriodo('mesant', this)">Mes anterior</button>
        <button class="chip" onclick="setRepPeriodo('custom', this)">Personalizado</button>
      </div>
      <div id="rep-custom-range" style="display:none;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="date" id="rep-desde" style="font-size:13px;padding:6px 10px">
        <span style="color:var(--txt3)">→</span>
        <input type="date" id="rep-hasta" style="font-size:13px;padding:6px 10px">
        <button class="btn sm pri" onclick="_calcularYRenderReporte()">Aplicar</button>
      </div>
    </div>`;
}

let _repPeriodo = 'mes';

function setRepPeriodo(periodo, btn) {
  _repPeriodo = periodo;
  document.querySelectorAll('#rep-filtros .chip').forEach(c => c.classList.remove('sel'));
  btn.classList.add('sel');
  const customEl = document.getElementById('rep-custom-range');
  if (customEl) customEl.style.display = periodo === 'custom' ? 'flex' : 'none';
  if (periodo !== 'custom') _calcularYRenderReporte();
}

function _getRangoReporte() {
  const now = new Date();
  switch (_repPeriodo) {
    case 'hoy':
      return { desde: new Date(now.getFullYear(), now.getMonth(), now.getDate()), hasta: now };
    case 'semana':
      return { desde: new Date(now - 7 * 86400000), hasta: now };
    case 'mes':
      return { desde: inicioMes(now), hasta: now };
    case 'mesant':
      return { desde: inicioMesAnterior(now), hasta: finMesAnterior(now) };
    case 'custom': {
      const desdeStr = document.getElementById('rep-desde')?.value;
      const hastaStr = document.getElementById('rep-hasta')?.value;
      if (!desdeStr || !hastaStr) return { desde: inicioMes(now), hasta: now };
      const [dy, dm, dd] = desdeStr.split('-').map(Number);
      const [hy, hm, hd] = hastaStr.split('-').map(Number);
      return { desde: new Date(dy, dm - 1, dd), hasta: new Date(hy, hm - 1, hd, 23, 59, 59) };
    }
    default:
      return { desde: inicioMes(now), hasta: now };
  }
}

function _calcularYRenderReporte() {
  const { desde, hasta } = _getRangoReporte();
  const ventas = ventasEnRango(desde, hasta);

  const totalVentas = ventas.reduce((s, v) => s + v.total, 0);
  const totalCosto  = ventas.reduce((s, v) =>
    s + v.items.reduce((ss, item) => {
      const prod = store.products.find(p => p.id === item.id);
      return ss + (prod ? prod.cost * item.qty : 0);
    }, 0), 0);
  const ganancia = totalVentas - totalCosto;
  const margen   = totalVentas > 0 ? Math.round(ganancia / totalVentas * 100) : 0;
  const ticket   = ventas.length ? Math.round(totalVentas / ventas.length) : 0;

  document.getElementById('rep-ventas').textContent  = formatMoney(totalVentas);
  document.getElementById('rep-costo').textContent   = formatMoney(totalCosto);
  document.getElementById('rep-gan').textContent     = formatMoney(ganancia);
  document.getElementById('rep-mg').textContent      = margen + '%';

  // Tarjetas extra
  const repCount = document.getElementById('rep-count');
  const repTicket = document.getElementById('rep-ticket');
  if (repCount)  repCount.textContent  = ventas.length;
  if (repTicket) repTicket.textContent = formatMoney(ticket);

  // Por método
  const byMethod = {};
  ventas.forEach(v => { byMethod[v.method] = (byMethod[v.method] || 0) + v.total; });
  _renderRankBar('rep-metodos', byMethod, k => METHOD_LABELS[k] || k, '');

  // Por cajero
  const byCajero = {};
  ventas.forEach(v => { byCajero[v.userName] = (byCajero[v.userName] || 0) + v.total; });
  _renderRankBar('rep-cajeros', byCajero, k => k, 'var(--blue)');

  // Por categoría
  const byCat = {};
  ventas.forEach(v => {
    v.items.forEach(i => {
      const prod = store.products.find(p => p.id === i.id);
      const cat  = prod ? prod.cat : 'Otros';
      byCat[cat] = (byCat[cat] || 0) + i.price * i.qty;
    });
  });
  _renderRankBar('rep-categorias', byCat, k => k, 'var(--warn)');

  // Gráfico diario
  _renderGraficoDiario(ventas, desde, hasta);
}

function _renderGraficoDiario(ventas, desde, hasta) {
  const canvas = document.getElementById('rep-daily-chart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const W   = canvas.width  = canvas.offsetWidth || 400;
  const H   = canvas.height = 120;

  // Agrupar por día
  const dias = {};
  const cur  = new Date(desde);
  while (cur <= hasta) {
    dias[cur.toLocaleDateString('es-AR')] = 0;
    cur.setDate(cur.getDate() + 1);
  }
  ventas.forEach(v => { if (dias[v.date] !== undefined) dias[v.date] += v.total; });

  const entries = Object.entries(dias);
  const maxVal  = Math.max(1, ...entries.map(([, v]) => v));
  const barW    = W / entries.length;
  const padB    = 20;

  ctx.clearRect(0, 0, W, H);
  const style  = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--accent').trim() || '#1a7a56';
  const bg3    = style.getPropertyValue('--bg3').trim() || '#eceae4';
  const txt3   = style.getPropertyValue('--txt3').trim() || '#a09d96';

  entries.forEach(([fecha, val], i) => {
    const bH = val > 0 ? Math.max(4, ((val / maxVal) * (H - padB - 8))) : 2;
    const x  = i * barW + barW * 0.1;
    const bw = barW * 0.8;
    const y  = H - padB - bH;

    ctx.fillStyle = bg3;
    ctx.beginPath(); ctx.roundRect(x, 8, bw, H - padB - 8, 3); ctx.fill();

    if (val > 0) {
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.roundRect(x, y, bw, bH, 3); ctx.fill();
    }

    // Etiqueta (solo cada N días según densidad)
    const step = entries.length <= 7 ? 1 : entries.length <= 14 ? 2 : entries.length <= 31 ? 5 : 7;
    if (i % step === 0) {
      ctx.fillStyle = txt3;
      ctx.font = '9px var(--mono, monospace)';
      ctx.textAlign = 'center';
      const parts = fecha.split('/');
      ctx.fillText(`${parts[0]}/${parts[1]}`, x + bw / 2, H - 4);
    }
  });
}

// ===== ALERTAS INTELIGENTES =====

function evaluateAlerts() {
  const alerts = [];
  const now = new Date();

  // Fechas clave próximas (< 20 días)
  getFechasProximas().filter(f => f.dias <= 20).forEach(f => {
    alerts.push({
      type: 'warn',
      icon: '🗓',
      title: `${f.nombre} en ${f.dias} días`,
      desc: `Revisá el stock de productos de regalo y decoración`,
      prodId: null,
    });
  });

  store.products.forEach(p => {
    if (p.stock > 0 && p.stock <= p.minStock) {
      alerts.push({ type: 'warn', icon: '⚠️', title: 'Stock bajo', desc: `${p.name}: quedan ${p.stock} unidades (mínimo: ${p.minStock})`, prodId: p.id });
    }
    if (p.stock === 0) {
      alerts.push({ type: 'err', icon: '🚫', title: 'Sin stock', desc: `${p.name} no tiene stock disponible`, prodId: p.id });
    }
    if (p.stock > 0 && p.sold === 0 && store.sales.length > 10) {
      const threshold = new Date(now - 30 * 86400000);
      const hasSale = store.movimientos.some(m => {
        if (m.prodId !== p.id || m.tipo !== 'venta') return false;
        const parts = m.fecha.split(/[\/, ]/);
        const d = new Date(parts[2], parts[1] - 1, parts[0]);
        return d >= threshold;
      });
      if (!hasSale) {
        alerts.push({ type: 'info', icon: '📭', title: 'Sin movimiento', desc: `${p.name} no registra ventas en 30 días`, prodId: p.id });
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

  const renderGroup = (items, color, label) => {
    if (!items.length) return '';
    return `
      <div style="margin-bottom:10px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${color};margin-bottom:6px">${label} (${items.length})</div>
        ${items.map(a => `
          <div class="alert-row alert-${a.type}" ${a.prodId ? `onclick="highlightProduct(${a.prodId})"` : ''} style="${a.prodId ? 'cursor:pointer' : 'cursor:default'}">
            <span class="alert-icon">${a.icon}</span>
            <div><div class="alert-title">${a.title}</div><div class="alert-desc">${a.desc}</div></div>
          </div>`).join('')}
      </div>`;
  };

  container.innerHTML =
    renderGroup(byType.err,  'var(--red)',  'Crítico') +
    renderGroup(byType.warn, 'var(--warn)', 'Advertencia') +
    renderGroup(byType.info, 'var(--blue)', 'Información');
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

// ===== HISTORIAL CON BÚSQUEDA =====

function renderHistory() {
  // Setear fecha de hoy en los filtros por defecto
  const now = new Date();
  const hoyISO = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  _renderHistorialFiltros();
  // Poner hoy como rango por defecto
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
  if (q) q.value = '';
  if (d) d.value = '';
  if (h) h.value = '';
  _aplicarFiltroHistorial();
}

function _aplicarFiltroHistorial() {
  const q      = (document.getElementById('hist-q')?.value || '').toLowerCase();
  const desde  = document.getElementById('hist-desde')?.value;
  const hasta  = document.getElementById('hist-hasta')?.value;

  let ventas = [...store.sales].sort((a, b) => b.id - a.id);

  if (q) {
    ventas = ventas.filter(v =>
      v.items.some(i => i.name.toLowerCase().includes(q)) ||
      (v.userName || '').toLowerCase().includes(q)
    );
  }
  if (desde) {
    const [dy, dm, dd] = desde.split('-').map(Number);
    const desdeDate = new Date(dy, dm - 1, dd);
    ventas = ventas.filter(v => { const d = parseLocalDate(v.date); return d && d >= desdeDate; });
  }
  if (hasta) {
    const [hy, hm, hd] = hasta.split('-').map(Number);
    const hastaDate = new Date(hy, hm - 1, hd, 23, 59, 59);
    ventas = ventas.filter(v => { const d = parseLocalDate(v.date); return d && d <= hastaDate; });
  }

  const tbody = document.getElementById('hist-table');
  const empty = document.getElementById('hist-empty');

  if (!ventas.length) {
    if (tbody) tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  // Métricas del rango filtrado (excluir anuladas)
  const ventasValidas = ventas.filter(v => !v.anulada);
  const totalFiltrado = ventasValidas.reduce((s, v) => s + v.total, 0);
  const countFiltrado = ventasValidas.length;
  const avgFiltrado   = countFiltrado ? Math.round(totalFiltrado / countFiltrado) : 0;

  document.getElementById('h-count').textContent  = countFiltrado;
  document.getElementById('h-today').textContent  = formatMoney(totalFiltrado);
  document.getElementById('h-avg').textContent    = formatMoney(avgFiltrado);

  const methodCount = {};
  ventasValidas.forEach(v => {
    methodCount[v.method] = (methodCount[v.method] || 0) + 1;
  });
  const bestMethod = Object.entries(methodCount).sort((a, b) => b[1] - a[1])[0];
  document.getElementById('h-method').textContent = bestMethod ? (METHOD_LABELS[bestMethod[0]] || bestMethod[0]) : '-';

  if (tbody) {
    tbody.innerHTML = ventas.map(v => `
      <tr class="${v.anulada ? 'row-anulada' : ''}">
        <td><span style="font-family:var(--mono);font-weight:600">#${v.id}</span></td>
        <td>${v.date} ${v.time}</td>
        <td>${v.userName}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${v.items.map(i => `${i.name} ×${i.qty}`).join(', ')}
        </td>
        <td><strong>${formatMoney(v.total)}</strong></td>
        <td>${METHOD_LABELS[v.method] || v.method}</td>
        <td>${v.anulada
          ? '<span class="badge out">Anulada</span>'
          : store.devoluciones?.some(d => d.saleId === v.id)
            ? '<span class="badge warn">Con dev.</span>'
            : '<span class="badge ok">OK</span>'
        }</td>
        <td>
          ${!v.anulada ? `<button class="btn sm" onclick="openDevolucionModal(${v.id})">Dev.</button>` : ''}
          <button class="btn sm" onclick="printTicket(${v.id})" style="margin-left:4px">🧾</button>
        </td>
      </tr>`).join('');
  }

  // Devoluciones
  _renderDevHistory();
  _renderCajaHistory();
}

function _renderDevHistory() {
  const tbody = document.getElementById('dev-hist-table');
  const empty = document.getElementById('dev-hist-empty');
  if (!tbody) return;
  const devs = store.devoluciones || [];
  if (!devs.length) { empty.style.display = 'block'; tbody.innerHTML = ''; return; }
  empty.style.display = 'none';
  tbody.innerHTML = [...devs].reverse().map(d => `
    <tr>
      <td>${d.fecha}</td>
      <td>#${d.saleId}</td>
      <td><span class="badge ${d.type === 'anulacion' ? 'out' : 'warn'}">${d.type === 'anulacion' ? 'Anulación' : 'Parcial'}</span></td>
      <td>${d.items.map(i => `${i.name} ×${i.qty}`).join(', ')}</td>
      <td>${formatMoney(d.total)}</td>
      <td>${d.motivo}</td>
      <td>${d.userName}</td>
    </tr>`).join('');
}

function _renderCajaHistory() {
  const tbody = document.getElementById('caja-hist-tb');
  const empty = document.getElementById('caja-hist-empty');
  if (!tbody) return;
  const cajas = [...store.cajaHistory].reverse();
  if (!cajas.length) { if (empty) empty.style.display = 'block'; tbody.innerHTML = ''; return; }
  if (empty) empty.style.display = 'none';
  tbody.innerHTML = cajas.map(c => {
    const dif = (c.contado || 0) - (c.esperado || 0);
    const difCls = dif > 0 ? 'g' : dif < 0 ? 'r' : '';
    return `
      <tr>
        <td>${c.apertura}</td>
        <td>${c.cajeroName || '-'}</td>
        <td>${formatMoney(c.inicial || 0)}</td>
        <td>${formatMoney(c.ventasEfectivo || 0)}</td>
        <td>${formatMoney(c.retiros || 0)}</td>
        <td>${formatMoney(c.esperado || 0)}</td>
        <td>${c.contado != null ? formatMoney(c.contado) : '-'}</td>
        <td class="${difCls}">${c.contado != null ? (dif >= 0 ? '+' : '') + formatMoney(dif) : '-'}</td>
        <td><span class="badge ${c.cerrada ? 'gray' : 'ok'}">${c.cerrada ? 'Cerrada' : 'Abierta'}</span></td>
      </tr>`;
  }).join('');
}

// ===== DEVOLUCIONES / ANULACIONES =====

function initDevolucionesStore() {
  if (!store.devoluciones) store.devoluciones = [];
  if (!store.nextDevId) store.nextDevId = 1;
}

function openDevolucionModal(saleId) {
  initDevolucionesStore();
  const sale = store.sales.find(s => s.id === saleId);
  if (!sale) { toast('Venta no encontrada', 'err'); return; }

  const devPrevias = store.devoluciones.filter(d => d.saleId === saleId);

  document.getElementById('dev-sale-id').textContent   = '#' + sale.id;
  document.getElementById('dev-sale-date').textContent = sale.date + ' ' + sale.time;
  document.getElementById('dev-sale-user').textContent = sale.userName;

  document.getElementById('dev-items').innerHTML = sale.items.map(item => {
    const yaDevuelto = devPrevias.flatMap(d => d.items)
      .filter(di => di.id === item.id).reduce((s, di) => s + di.qty, 0);
    const disponible = item.qty - yaDevuelto;
    return `
      <div class="dev-item" data-id="${item.id}" data-max="${disponible}" data-price="${item.price}">
        <div class="dev-item-name">${item.name}</div>
        <div class="dev-item-info">
          <span style="font-size:12px;color:var(--txt2)">Vendido: ${item.qty} · Ya devuelto: ${yaDevuelto}</span>
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
            <label style="font-size:12px;color:var(--txt2)">Devolver:</label>
            <input type="number" class="dev-qty-input" min="0" max="${disponible}" value="0"
              style="width:64px;text-align:center;font-weight:700" oninput="updateDevTotal()">
            <span style="font-size:12px;color:var(--txt3)">/ ${disponible} disponibles</span>
          </div>
        </div>
      </div>`;
  }).join('');

  document.getElementById('dev-total').textContent = formatMoney(0);
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
    const id    = parseInt(row.dataset.id);
    const max   = parseInt(row.dataset.max);
    const qty   = parseInt(row.querySelector('.dev-qty-input').value) || 0;
    const price = parseFloat(row.dataset.price);
    const name  = row.querySelector('.dev-item-name').textContent;
    if (qty > max) { toast(`No podés devolver más de ${max} de ${name}`, 'err'); hasError = true; return; }
    if (qty > 0) items.push({ id, name, qty, price });
  });

  if (hasError) return;
  if (!items.length) { showMsg('msg-devolucion', 'Seleccioná al menos un producto', 'err'); return; }

  const motivo = document.getElementById('dev-motivo').value.trim() || 'Devolución';
  const total  = items.reduce((s, i) => s + i.qty * i.price, 0);

  const devolucion = {
    id: store.nextDevId++, saleId, items, total, motivo,
    userId: store.currentUser.id, userName: store.currentUser.name,
    fecha: new Date().toLocaleString('es-AR'), type: 'parcial',
  };

  const updatedProducts = [];
  const newMovimientos  = [];

  items.forEach(item => {
    const prod = store.products.find(p => p.id === item.id);
    if (prod) {
      const prev = prod.stock;
      prod.stock += item.qty;
      const mov = registrarMovimiento(prod.id, 'devolucion', item.qty, prev, prod.stock, `Devolución venta #${saleId} - ${motivo}`);
      updatedProducts.push(prod);
      newMovimientos.push(mov);
    }
  });

  store.devoluciones.push(devolucion);

  try {
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
    console.error(e);
    showMsg('msg-devolucion', 'Error guardando la devolución', 'err');
  }
}

async function anularVenta(saleId) {
  initDevolucionesStore();
  if (!confirm(`¿Anular completamente la venta #${saleId}?`)) return;
  const sale = store.sales.find(s => s.id === saleId);
  if (!sale) { toast('Venta no encontrada', 'err'); return; }
  const devPrevias = store.devoluciones.filter(d => d.saleId === saleId);
  if (devPrevias.length) { toast('Ya tiene devoluciones parciales', 'err'); return; }

  const devolucion = {
    id: store.nextDevId++, saleId, items: sale.items.map(i => ({ ...i })),
    total: sale.total, motivo: 'Anulación completa',
    userId: store.currentUser.id, userName: store.currentUser.name,
    fecha: new Date().toLocaleString('es-AR'), type: 'anulacion',
  };

  const updatedProducts = [];
  const newMovimientos  = [];

  sale.items.forEach(item => {
    const prod = store.products.find(p => p.id === item.id);
    if (prod) {
      const prev = prod.stock;
      prod.stock   += item.qty;
      prod.sold    -= item.qty;
      prod.revenue -= item.price * item.qty;
      const mov = registrarMovimiento(prod.id, 'devolucion', item.qty, prev, prod.stock, `Anulación venta #${saleId}`);
      updatedProducts.push(prod);
      newMovimientos.push(mov);
    }
  });

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
    toast(`Venta #${saleId} anulada.`);
    renderHistory();
    renderStockPage();
  } catch (e) {
    console.error(e);
    toast('Error al anular', 'err');
  }
}

async function _loadDevoluciones() {
  const snap = await db.collection('devoluciones').get();
  store.devoluciones = [];
  snap.forEach(d => store.devoluciones.push({ ...d.data(), id: parseInt(d.id) }));
  store.nextDevId = store.devoluciones.length
    ? Math.max(...store.devoluciones.map(d => d.id), 0) + 1 : 1;
}
