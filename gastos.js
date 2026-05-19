/**
 * gastos.js — BazarHub
 * Módulo de gastos fijos mensuales.
 */

const GASTO_CATS = ['Alquiler', 'Servicios', 'Sueldos', 'Impuestos', 'Mantenimiento', 'Seguros', 'Otro'];

function calcTotalGastosMes() {
  return (store.gastos || []).filter(g => g.activo !== false).reduce((s, g) => s + (g.monto || 0), 0);
}

function renderGastos() {
  if (!store.gastos) store.gastos = [];

  const gastos  = store.gastos;
  const activos = gastos.filter(g => g.activo !== false);
  const total   = activos.reduce((s, g) => s + g.monto, 0);

  const countEl = document.getElementById('gastos-count');
  const totalEl = document.getElementById('gastos-total-mes');
  if (countEl) countEl.textContent = activos.length;
  if (totalEl) totalEl.textContent = formatMoney(total);

  const tbody = document.getElementById('gastos-table');
  const empty = document.getElementById('gastos-empty');
  if (!tbody) return;

  if (!gastos.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  const hoy = new Date().getDate();
  const sorted = [...gastos].sort((a, b) => (a.vencimiento || 99) - (b.vencimiento || 99));

  tbody.innerHTML = sorted.map(g => {
    const activo  = g.activo !== false;
    const diasRest = g.vencimiento ? g.vencimiento - hoy : null;
    const proximo  = activo && diasRest !== null && diasRest >= 0 && diasRest <= 5;
    const vencido  = activo && diasRest !== null && diasRest < 0;

    const vencLabel = g.vencimiento
      ? `Día ${g.vencimiento}` + (proximo ? ' <span class="badge warn">Próximo</span>' : '')
                                + (vencido ? ' <span class="badge out">Vencido</span>' : '')
      : '-';

    return `
      <tr class="${activo ? '' : 'row-anulada'}">
        <td><strong>${g.nombre}</strong></td>
        <td><span style="background:var(--blue-l);color:var(--blue);padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600">${g.categoria}</span></td>
        <td><strong style="font-size:15px">${formatMoney(g.monto)}</strong></td>
        <td style="font-size:13px">${vencLabel}</td>
        <td><span class="badge ${activo ? 'ok' : 'gray'}">${activo ? 'Activo' : 'Pausado'}</span></td>
        <td>
          <div style="display:flex;gap:6px">
            <button class="btn sm" onclick="openGastoModal(${g.id})">Editar</button>
            <button class="btn sm" onclick="toggleGastoActivo(${g.id})" style="color:var(--warn)">${activo ? 'Pausar' : 'Activar'}</button>
            <button class="btn sm" onclick="deleteGastoConfirm(${g.id})" style="color:var(--red)">Eliminar</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

function openGastoModal(id) {
  if (!store.gastos) store.gastos = [];
  store._editGastoId = id || null;
  const g = id ? store.gastos.find(x => x.id === id) : null;

  document.getElementById('gasto-modal-title').textContent = g ? 'Editar gasto fijo' : 'Nuevo gasto fijo';
  document.getElementById('g-nombre').value      = g ? g.nombre      : '';
  document.getElementById('g-monto').value       = g ? g.monto       : '';
  document.getElementById('g-cat').value         = g ? g.categoria   : 'Alquiler';
  document.getElementById('g-vencimiento').value = g && g.vencimiento ? g.vencimiento : '';
  document.getElementById('msg-gasto').style.display = 'none';

  openModal('modal-gasto');
  document.getElementById('g-nombre').focus();
}

async function saveGasto() {
  const nombre      = document.getElementById('g-nombre').value.trim();
  const monto       = parseFloat(document.getElementById('g-monto').value);
  const categoria   = document.getElementById('g-cat').value;
  const vencRaw     = document.getElementById('g-vencimiento').value;
  const vencimiento = vencRaw ? parseInt(vencRaw) : null;

  if (!nombre) {
    showMsg('msg-gasto', 'Ingresá un nombre para el gasto', 'err'); return;
  }
  if (!monto || monto <= 0) {
    showMsg('msg-gasto', 'Ingresá un monto válido en pesos', 'err'); return;
  }
  if (vencimiento !== null && (vencimiento < 1 || vencimiento > 31)) {
    showMsg('msg-gasto', 'El día de vencimiento debe estar entre 1 y 31', 'err'); return;
  }

  if (!store.gastos)     store.gastos     = [];
  if (!store.nextGastoId) store.nextGastoId = 1;

  const isEdit = !!store._editGastoId;

  if (isEdit) {
    const g = store.gastos.find(x => x.id === store._editGastoId);
    if (!g) return;
    Object.assign(g, { nombre, monto, categoria, vencimiento });
    await saveDoc('gastos', g.id, g);
  } else {
    const g = {
      id:          store.nextGastoId++,
      nombre,
      monto,
      categoria,
      vencimiento,
      activo:      true,
      creadoEn:    new Date().toLocaleString('es-AR'),
    };
    store.gastos.push(g);
    await saveDoc('gastos', g.id, g);
  }

  closeModal('modal-gasto');
  toast(isEdit ? 'Gasto actualizado' : 'Gasto agregado');
  renderGastos();
  _refreshDashGastos();
}

async function toggleGastoActivo(id) {
  const g = store.gastos && store.gastos.find(x => x.id === id);
  if (!g) return;
  g.activo = g.activo === false;
  await saveDoc('gastos', g.id, g);
  renderGastos();
  _refreshDashGastos();
}

async function deleteGastoConfirm(id) {
  const g = store.gastos && store.gastos.find(x => x.id === id);
  if (!g) return;
  if (!confirm(`¿Eliminar el gasto "${g.nombre}"? Esta acción no se puede deshacer.`)) return;
  store.gastos = store.gastos.filter(x => x.id !== id);
  await deleteDoc('gastos', id);
  toast('Gasto eliminado');
  renderGastos();
  _refreshDashGastos();
}

function _refreshDashGastos() {
  const el = document.getElementById('dash-gastos-total');
  if (el) el.textContent = formatMoney(calcTotalGastosMes());
}
