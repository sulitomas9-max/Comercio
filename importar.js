/**
 * importar.js
 * Importación masiva de productos desde PDF de proveedor.
 * Parser específico para facturas Berkma (formato columnar argentino).
 *
 * Estructura de línea de producto:
 *   CÓDIGO  CANTIDAD  DESCRIPCIÓN  DESPACHO  ORIG  ADUANA  P.UNITARIO  [desc...]  IMPORTE
 *   NS388695  300  ALFOMBRA  25001IC05023651M  CHINA  BUE  2000,000  -35,00  322335,00
 *
 * Reglas del parser:
 *  - P.UNITARIO siempre tiene 3 decimales (ej: 2000,000)
 *  - DESPACHO es alfanumérico largo (ej: 25001IC05023651M)
 *  - DESCRIPCIÓN es todo lo que queda entre CANTIDAD y DESPACHO
 *  - CÓDIGO interno y todo lo posterior al precio se ignoran
 */

// ===== ESTADO DEL MÓDULO =====
const importState = {
  rawText:     '',
  productos:   [],
  proveedorId: null,
};

// ===== CONSTANTES DEL PARSER =====

// Patrones para ignorar líneas que no son productos
const SKIP_PATTERNS = [
  /^(código|cantidad|descripci[oó]n|despacho|orig|aduana|p\.\s*unitario|importe)/i,
  /^(subtotal|impuesto|iva|i\.v\.a|inscripto|total|percepci[oó]n|iibb|caba)/i,
  /^(importante|reclamos|comprobante|autorizado|c\.a\.e|fecha\s*de)/i,
  /^(sr\(es\)|condici[oó]n|remito|nro\.|c\.u\.i\.t|ingresos|inicio|responsable)/i,
  /^\d{1,2}\/\d{1,2}\/\d{4}/,         // fecha DD/MM/YYYY
  /^\d+%/,                              // porcentajes
  /^-?\d[\d.,]*\s*$/,                   // línea de solo número
  /^[A-F0-9]{20,}\s*$/,                // hash / código QR
  /^\(?\s*\d{5,}\s*\)?$/,              // número de remito solo
  /^30\s*D[ií]as$/i,                   // condición de venta
  /^[A-Z\s]{2,6}\s+\d{4,}/,           // encabezados con número al lado
  /^(factura|electr[oó]nica)/i,
];

// Despacho: empieza con dígitos, tiene letras intercaladas, termina en letra o dígito
// Ej: 25001IC05023651M, 12345AB67890C
const RE_DESPACHO = /^[0-9]{3,8}[A-Z]{1,5}[0-9]{4,12}[A-Z]?$/;

// Precio unitario: dígitos con exactamente 3 decimales — Ej: 2000,000 / 850,500
const RE_PRECIO_3D = /^\d{1,8},\d{3}$/;

// ===== ENTRADA AL MÓDULO =====

function renderImportar() {
  importState.productos  = [];
  importState.rawText    = '';
  _renderStepUpload();
}

// ===== PASO 1: PANTALLA DE UPLOAD =====

function _renderStepUpload() {
  const page = document.getElementById('page-importar');
  if (!page) return;

  page.innerHTML = `
    <div class="imp-wrap">
      <div class="imp-header">
        <div class="imp-title">📄 Importar productos desde PDF</div>
        <div class="imp-sub">Subí la factura o lista de precios del proveedor</div>
      </div>

      <div class="imp-step-bar">
        <div class="imp-step act">1 Subir PDF</div>
        <div class="imp-step-sep">›</div>
        <div class="imp-step">2 Revisar</div>
        <div class="imp-step-sep">›</div>
        <div class="imp-step">3 Escanear</div>
        <div class="imp-step-sep">›</div>
        <div class="imp-step">4 Guardar</div>
      </div>

      <div class="imp-card">
        <div style="margin-bottom:16px">
          <label style="font-size:12px;font-weight:600;color:var(--txt2);text-transform:uppercase;letter-spacing:.06em">
            Proveedor (opcional)
          </label>
          <select id="imp-prov-sel" style="width:100%;margin-top:6px">
            <option value="">Sin asignar</option>
            ${store.proveedores.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
          </select>
        </div>

        <div class="imp-dropzone" id="imp-dropzone"
          ondragover="event.preventDefault();this.classList.add('drag')"
          ondragleave="this.classList.remove('drag')"
          ondrop="_onDrop(event)">
          <div class="imp-drop-icon">📑</div>
          <div class="imp-drop-title">Arrastrá tu PDF acá</div>
          <div class="imp-drop-sub">o hacé click para seleccionar</div>
          <input type="file" id="imp-file-input" accept=".pdf,application/pdf"
            style="display:none" onchange="_onFileSelected(this)">
          <button class="btn pri" style="margin-top:14px"
            onclick="document.getElementById('imp-file-input').click()">
            Seleccionar PDF
          </button>
        </div>

        <div id="imp-upload-status" style="margin-top:12px"></div>
      </div>

      <div class="imp-card" style="background:var(--bg3);border-style:dashed">
        <div style="font-size:12px;font-weight:600;color:var(--txt2);margin-bottom:8px">
          💡 Formato compatible
        </div>
        <div style="font-size:12px;color:var(--txt2);line-height:1.8;font-family:var(--mono)">
          CÓDIGO &nbsp; CANTIDAD &nbsp; DESCRIPCIÓN &nbsp; DESPACHO &nbsp; ORIG &nbsp; ADUANA &nbsp; P.UNITARIO &nbsp; IMPORTE<br>
          <span style="color:var(--accent-d)">NS388695 &nbsp; 300 &nbsp; ALFOMBRA &nbsp; 25001IC05023651M &nbsp; CHINA &nbsp; BUE &nbsp; 2000,000 &nbsp; 322335,00</span>
        </div>
        <div style="font-size:11px;color:var(--txt3);margin-top:8px">
          El código interno del proveedor y los descuentos se ignoran automáticamente.
        </div>
      </div>
    </div>`;
}

// ===== MANEJO DE ARCHIVO =====

function _onDrop(e) {
  e.preventDefault();
  document.getElementById('imp-dropzone').classList.remove('drag');
  const file = e.dataTransfer.files[0];
  if (file) _procesarArchivo(file);
}

function _onFileSelected(input) {
  const file = input.files[0];
  if (file) _procesarArchivo(file);
  input.value = '';
}

async function _procesarArchivo(file) {
  if (file.type !== 'application/pdf' && !file.name.endsWith('.pdf')) {
    _setUploadStatus('❌ Solo se aceptan archivos PDF', 'err');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    _setUploadStatus('❌ El archivo supera 20 MB', 'err');
    return;
  }

  importState.proveedorId = parseInt(document.getElementById('imp-prov-sel').value) || null;
  _setUploadStatus('⏳ Leyendo PDF...', 'loading');

  try {
    const text = await leerPDF(file);

    if (!text || text.trim().length < 10) {
      _setUploadStatus('❌ No se pudo extraer texto. ¿Es un PDF escaneado (imagen)?', 'err');
      return;
    }

    importState.rawText  = text;
    importState.productos = parseProductsFromText(text);

    if (!importState.productos.length) {
      _setUploadStatus(
        '❌ No se encontraron productos. Verificá que la factura tenga el formato Berkma estándar.',
        'err'
      );
      return;
    }

    _setUploadStatus(
      `✅ ${importState.productos.length} producto${importState.productos.length !== 1 ? 's' : ''} encontrado${importState.productos.length !== 1 ? 's' : ''}. Revisá los datos antes de guardar.`,
      'ok'
    );
    setTimeout(() => _renderPreview(), 500);

  } catch (e) {
    console.error('_procesarArchivo:', e);
    _setUploadStatus('❌ Error procesando el PDF: ' + (e.message || 'desconocido'), 'err');
  }
}

function _setUploadStatus(msg, type) {
  const el = document.getElementById('imp-upload-status');
  if (!el) return;
  const cls = { err: 'imp-status-err', ok: 'imp-status-ok', loading: 'imp-status-loading' }[type] || '';
  el.innerHTML = `<div class="imp-status ${cls}">${msg}</div>`;
}

// ===== PASO 2: LEER PDF CON PDF.JS =====

async function leerPDF(file) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('pdf.js no está cargado. Verificá el script en index.html.');
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let fullText = '';

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page    = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // Reconstruir líneas por posición Y (respeta columnas del PDF)
    let lastY = null;
    let line  = '';

    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        fullText += line.trim() + '\n';
        line = '';
      }
      line  += item.str + ' ';
      lastY  = y;
    }
    if (line.trim()) fullText += line.trim() + '\n';
    fullText += '\n';
  }

  return fullText;
}

// ===== PASO 3: PARSER PARA FORMATO BERKMA =====

/**
 * parseProductsFromText(text)
 *
 * Estructura de columnas Berkma:
 *   [0] CÓDIGO      → alfanumérico (ignorar)
 *   [1] CANTIDAD    → entero
 *   [2..N] DESC     → texto hasta el DESPACHO
 *   [desp] DESPACHO → string alfanum largo (ignorar)
 *   [+1] ORIGEN     → país (ignorar)
 *   [+2] ADUANA     → código aduana (ignorar)
 *   [+3] P.UNIT     → precio con 3 decimales: 2000,000
 *   [...] desctos e IMPORTE (ignorar)
 *
 * Retorna: [{ name, price, stock, barcode, cat, provId, cost, minStock }]
 */
function parseProductsFromText(text) {
  const lines    = text.split('\n');
  const products = [];
  const seenNames = new Set();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.length < 8) continue;
    if (_shouldSkipLine(line))   continue;

    const parsed = _parseBerkmaLine(line);
    if (!parsed) continue;

    // Deduplicar por nombre normalizado
    const nameKey = parsed.name.toLowerCase().replace(/\s+/g, '');
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);

    products.push({
      name:     parsed.name,
      price:    parsed.price,
      stock:    parsed.stock,
      barcode:  '',
      cat:      _inferirCategoria(parsed.name),
      provId:   importState.proveedorId || null,
      cost:     parsed.price,   // P.UNITARIO es el costo; el usuario setea precio de venta
      minStock: 5,
    });
  }

  return products;
}

function _shouldSkipLine(line) {
  for (const pat of SKIP_PATTERNS) {
    if (pat.test(line)) return true;
  }
  return false;
}

/**
 * _parseBerkmaLine(line)
 * Detecta la posición del DESPACHO y del PRECIO para extraer descripción y precio.
 * Retorna { name, stock, price } o null si la línea no es un producto.
 */
function _parseBerkmaLine(line) {
  const parts = line.split(/\s+/);
  if (parts.length < 7) return null;

  let despIdx = null;
  let precIdx = null;

  for (let i = 0; i < parts.length; i++) {
    if (despIdx === null && RE_DESPACHO.test(parts[i])) despIdx = i;
    if (precIdx === null && RE_PRECIO_3D.test(parts[i])) precIdx = i;
  }

  // Validaciones estructurales
  if (despIdx === null || precIdx === null) return null;
  if (despIdx < 3)              return null;   // necesita al menos: codigo + qty + 1 palabra de desc
  if (precIdx !== despIdx + 3)  return null;   // precio siempre 3 cols después del despacho

  // Validar cantidad en posición 1
  const qty = parseInt(parts[1]);
  if (isNaN(qty) || qty <= 0 || qty > 99999) return null;

  const name  = parts.slice(2, despIdx).join(' ').trim();
  const price = parseFloat(parts[precIdx].replace(',', '.'));

  if (!name || name.length < 2) return null;
  if (price <= 0)                return null;

  return {
    name:  _limpiarNombre(name),
    stock: qty,
    price: Math.round(price * 100) / 100,
  };
}

function _limpiarNombre(str) {
  return str
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-\.]+|[\s\-\.]+$/g, '')
    .trim()
    .substring(0, 80);
}

function _inferirCategoria(nombre) {
  const n = nombre.toUpperCase();
  if (/ALFOMBRA|TAPETE|PISO/.test(n))                         return 'Otros';
  if (/LECHE|YOGUR|QUESO|CREMA|MANTECA|LACTEO/.test(n))       return 'Lácteos';
  if (/COCA|PEPSI|AGUA|JUGO|GASEOSA|CERVEZA|VINO|BEBIDA/.test(n)) return 'Bebidas';
  if (/JABON|CHAMPU|DESODORANTE|PASTA DENTAL|PERFUM/.test(n)) return 'Perfumería';
  if (/LAVANDINA|DETERGENTE|LIMPIA|CLORO|DESINFECT/.test(n))  return 'Limpieza';
  if (/PAPA|CHIZITO|SNACK|GALLETA|ALFAJOR|CHICLE/.test(n))    return 'Snacks';
  if (/ARROZ|FIDEO|AZUCAR|SAL|ACEITE|HARINA/.test(n))         return 'Almacén';
  return 'Almacén';
}

// ===== PASO 4: PREVIEW EDITABLE =====

function _renderPreview() {
  const page  = document.getElementById('page-importar');
  const total = importState.productos.length;
  if (!page) return;

  page.innerHTML = `
    <div class="imp-wrap imp-wide">
      <div class="imp-step-bar">
        <div class="imp-step done">✓ PDF</div>
        <div class="imp-step-sep">›</div>
        <div class="imp-step act">2 Revisar y editar</div>
        <div class="imp-step-sep">›</div>
        <div class="imp-step">3 Escanear códigos</div>
        <div class="imp-step-sep">›</div>
        <div class="imp-step">4 Guardar</div>
      </div>

      <div class="imp-toolbar">
        <div>
          <div class="imp-counter" id="imp-counter">
            <span id="imp-complete-count">0</span> / ${total} con código de barras
          </div>
          <div style="font-size:11px;color:var(--txt3);margin-top:3px">
            💡 El precio importado es el costo del proveedor — ajustá el precio de venta
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn sm" onclick="_agregarFilaManual()">+ Agregar fila</button>
          <button class="btn sm" id="imp-del-btn" style="display:none"
            onclick="_eliminarSeleccionados()">🗑 Eliminar seleccionados</button>
          <button class="btn pri" onclick="_irAEscaneo()">Siguiente →</button>
        </div>
      </div>

      <div id="imp-msg" class="msg" style="margin-bottom:8px"></div>

      <div class="imp-table-wrap">
        <table class="imp-table" id="imp-table">
          <thead>
            <tr>
              <th style="width:32px">
                <input type="checkbox" id="imp-check-all" onchange="_toggleAll(this)">
              </th>
              <th>Nombre del producto</th>
              <th style="width:130px">Costo (PDF)</th>
              <th style="width:130px">Precio venta</th>
              <th style="width:70px">Stock</th>
              <th style="width:130px">Categoría</th>
              <th style="width:170px">Código de barras</th>
              <th style="width:36px"></th>
            </tr>
          </thead>
          <tbody id="imp-tbody"></tbody>
        </table>
      </div>

      <div class="imp-footer-actions">
        <button class="btn" onclick="_renderStepUpload()">← Volver</button>
        <button class="btn pri" onclick="_irAEscaneo()">Siguiente: Escanear →</button>
      </div>
    </div>`;

  _renderTablaProductos();
  _actualizarContador();
}

function _renderTablaProductos() {
  const tbody = document.getElementById('imp-tbody');
  if (!tbody) return;
  tbody.innerHTML = importState.productos.map((p, i) => _renderFila(i)).join('');
}

function _renderFila(i) {
  const p   = importState.productos[i];
  if (!p) return '';
  const inc = !p.barcode;
  const dup = p.barcode && _esBarcodeDuplicado(p.barcode, i);

  return `
    <tr class="imp-row ${inc ? 'imp-row-inc' : 'imp-row-ok'} ${dup ? 'imp-row-dup' : ''}"
        id="imp-row-${i}">
      <td>
        <input type="checkbox" class="imp-chk" data-idx="${i}" onchange="_onCheckChange()">
      </td>
      <td>
        <input class="imp-inp imp-inp-name" type="text" value="${_esc(p.name)}"
          onchange="importState.productos[${i}].name = this.value"
          placeholder="Nombre del producto">
      </td>
      <td>
        <input class="imp-inp" type="number" value="${p.cost}" step="0.01"
          onchange="importState.productos[${i}].cost = parseFloat(this.value)||0"
          placeholder="0" min="0" style="font-family:var(--mono)">
      </td>
      <td>
        <input class="imp-inp imp-inp-price" type="number"
          value="${p.price !== p.cost ? p.price : ''}"
          step="0.01"
          onchange="importState.productos[${i}].price = parseFloat(this.value)||0; _actualizarContador()"
          placeholder="Ingresar..."
          min="0">
      </td>
      <td style="text-align:center;font-weight:600;color:var(--txt2)">${p.stock}</td>
      <td>
        <select class="imp-inp" onchange="importState.productos[${i}].cat = this.value">
          ${['Almacén','Bebidas','Lácteos','Limpieza','Perfumería','Snacks','Otros'].map(c =>
            `<option ${p.cat === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </td>
      <td>
        <input class="imp-inp imp-barcode ${dup ? 'imp-bc-dup' : ''}"
          type="text" id="imp-bc-${i}"
          value="${_esc(p.barcode)}"
          placeholder="Escanear..."
          onkeydown="_onBarcodeKeydown(event, ${i})"
          onchange="_onBarcodeChange(${i}, this.value)"
          autocomplete="off">
        ${dup ? '<div class="imp-dup-warn">⚠ duplicado</div>' : ''}
      </td>
      <td>
        <button class="qbtn" onclick="_eliminarFila(${i})"
          style="color:var(--red);border-color:var(--red-l)" title="Eliminar">✕</button>
      </td>
    </tr>`;
}

function _esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

// ===== GESTIÓN DE FILAS =====

function _agregarFilaManual() {
  importState.productos.push({
    name: '', price: 0, cost: 0, stock: 1, barcode: '',
    cat: 'Almacén', provId: importState.proveedorId || null, minStock: 5,
  });
  const i = importState.productos.length - 1;
  document.getElementById('imp-tbody').insertAdjacentHTML('beforeend', _renderFila(i));
  _actualizarContador();
  document.getElementById(`imp-bc-${i}`)?.focus();
}

function _eliminarFila(i) {
  importState.productos.splice(i, 1);
  _renderTablaProductos();
  _actualizarContador();
}

function _toggleAll(chk) {
  document.querySelectorAll('.imp-chk').forEach(c => c.checked = chk.checked);
  _onCheckChange();
}

function _onCheckChange() {
  const any = [...document.querySelectorAll('.imp-chk')].some(c => c.checked);
  const btn = document.getElementById('imp-del-btn');
  if (btn) btn.style.display = any ? 'inline-block' : 'none';
}

function _eliminarSeleccionados() {
  [...document.querySelectorAll('.imp-chk')]
    .map((c, i) => ({ checked: c.checked, idx: parseInt(c.dataset.idx) }))
    .filter(x => x.checked)
    .map(x => x.idx)
    .sort((a, b) => b - a)
    .forEach(i => importState.productos.splice(i, 1));
  _renderTablaProductos();
  _actualizarContador();
}

// ===== ESCANEO DE CÓDIGO DE BARRAS =====

function _onBarcodeKeydown(e, idx) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  _onBarcodeChange(idx, e.target.value.trim());
  const next = _siguienteSinBarcode(idx + 1);
  if (next !== -1) {
    const el = document.getElementById(`imp-bc-${next}`);
    if (el) { el.focus(); el.select(); }
  }
}

function _onBarcodeChange(idx, val) {
  const cleaned = val.trim();
  importState.productos[idx].barcode = cleaned;

  const row = document.getElementById(`imp-row-${idx}`);
  const inp = document.getElementById(`imp-bc-${idx}`);
  const dup = _esBarcodeDuplicado(cleaned, idx);

  if (row) row.className = `imp-row ${!cleaned ? 'imp-row-inc' : 'imp-row-ok'} ${dup ? 'imp-row-dup' : ''}`;
  if (inp) inp.className = `imp-inp imp-barcode ${dup ? 'imp-bc-dup' : ''}`;

  _actualizarContador();
}

function _siguienteSinBarcode(from) {
  for (let i = from; i < importState.productos.length; i++) {
    if (!importState.productos[i].barcode) return i;
  }
  for (let i = 0; i < from; i++) {
    if (!importState.productos[i].barcode) return i;
  }
  return -1;
}

function _esBarcodeDuplicado(bc, idx) {
  if (!bc) return false;
  return importState.productos.some((p, i) => i !== idx && p.barcode === bc);
}

function _actualizarContador() {
  const total     = importState.productos.length;
  const completos = importState.productos.filter(p => p.barcode).length;
  const el        = document.getElementById('imp-complete-count');
  if (el) el.textContent = completos;
  const counter   = document.getElementById('imp-counter');
  if (counter) counter.className = `imp-counter ${completos === total && total > 0 ? 'imp-counter-done' : ''}`;
}

// ===== PASO 5: PANTALLA DE ESCANEO FOCALIZADO =====

function _irAEscaneo() {
  const sinPrecio = importState.productos.filter(p => !p.price || p.price <= 0).length;
  if (sinPrecio > 0 && !confirm(`${sinPrecio} producto(s) no tienen precio de venta. ¿Continuar igualmente?`)) {
    return;
  }
  if (!importState.productos.length) {
    showMsg('imp-msg', 'No hay productos para continuar', 'err');
    return;
  }

  const sinBC = importState.productos.filter(p => !p.barcode).length;
  if (sinBC === 0) { _irAGuardar(); return; }

  const page = document.getElementById('page-importar');
  page.innerHTML = `
    <div class="imp-wrap">
      <div class="imp-step-bar">
        <div class="imp-step done">✓ PDF</div>
        <div class="imp-step-sep">›</div>
        <div class="imp-step done">✓ Revisión</div>
        <div class="imp-step-sep">›</div>
        <div class="imp-step act">3 Escanear códigos</div>
        <div class="imp-step-sep">›</div>
        <div class="imp-step">4 Guardar</div>
      </div>

      <div class="imp-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap;gap:10px">
          <div>
            <div style="font-size:15px;font-weight:700">Escaneá los códigos de barras</div>
            <div style="font-size:12px;color:var(--txt2);margin-top:4px">
              Usá tu lector USB. Enter avanza al siguiente automáticamente.
            </div>
          </div>
          <div class="imp-counter" id="imp-counter2">
            <span id="imp-scan-progress">0</span> / ${importState.productos.length}
          </div>
        </div>

        <div class="imp-progress-bar">
          <div class="imp-progress-fill" id="imp-progress-fill" style="width:0%"></div>
        </div>

        <div class="imp-scan-list" id="imp-scan-list"></div>
      </div>

      <div class="imp-footer-actions">
        <button class="btn" onclick="_renderPreview()">← Volver a edición</button>
        <button class="btn pri" onclick="_irAGuardar()">Siguiente: Guardar →</button>
      </div>
    </div>`;

  _renderScanList();
  _focusSiguienteBarcode();
}

function _renderScanList() {
  const container = document.getElementById('imp-scan-list');
  if (!container) return;

  container.innerHTML = importState.productos.map((p, i) => `
    <div class="imp-scan-row ${p.barcode ? 'imp-scan-done' : 'imp-scan-pending'}" id="imp-scan-row-${i}">
      <div class="imp-scan-status">${p.barcode ? '✓' : '○'}</div>
      <div class="imp-scan-name">${_esc(p.name) || '(sin nombre)'}</div>
      <div class="imp-scan-price">${p.price > 0 ? formatMoney(p.price) : '—'}</div>
      <div>
        <input class="imp-inp imp-barcode-scan" type="text"
          id="imp-scan-bc-${i}"
          value="${_esc(p.barcode)}"
          placeholder="${p.barcode || 'Escanear...'}"
          onkeydown="_onScanKeydown(event, ${i})"
          onchange="_onScanChange(${i}, this.value)"
          autocomplete="off">
      </div>
    </div>`).join('');

  _updateScanProgress();
}

function _onScanKeydown(e, idx) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  _onScanChange(idx, e.target.value.trim());
  const next = _siguienteSinBarcode(idx + 1);
  if (next !== -1) {
    const el = document.getElementById(`imp-scan-bc-${next}`);
    if (el) { el.focus(); el.select(); }
  }
}

function _onScanChange(idx, val) {
  const cleaned = val.trim();
  importState.productos[idx].barcode = cleaned;

  const row    = document.getElementById(`imp-scan-row-${idx}`);
  const status = row?.querySelector('.imp-scan-status');
  if (row)    row.className    = `imp-scan-row ${cleaned ? 'imp-scan-done' : 'imp-scan-pending'}`;
  if (status) status.textContent = cleaned ? '✓' : '○';

  _updateScanProgress();
  _actualizarContador();
}

function _updateScanProgress() {
  const total     = importState.productos.length;
  const completos = importState.productos.filter(p => p.barcode).length;
  const pct       = total > 0 ? (completos / total * 100) : 0;

  const prog    = document.getElementById('imp-scan-progress');
  const fill    = document.getElementById('imp-progress-fill');
  const counter = document.getElementById('imp-counter2');

  if (prog)    prog.textContent  = completos;
  if (fill)    fill.style.width  = pct + '%';
  if (counter) counter.className = `imp-counter ${completos === total ? 'imp-counter-done' : ''}`;
}

function _focusSiguienteBarcode() {
  const idx = _siguienteSinBarcode(0);
  if (idx !== -1) {
    const el = document.getElementById(`imp-scan-bc-${idx}`);
    if (el) { el.focus(); el.select(); }
  }
}

// ===== PASO 6: VALIDACIÓN Y RESUMEN =====

function _irAGuardar() {
  const page      = document.getElementById('page-importar');
  const total     = importState.productos.length;
  const conBC     = importState.productos.filter(p => p.barcode).length;
  const sinBC     = total - conBC;
  const sinPrecio = importState.productos.filter(p => !p.price || p.price <= 0).length;
  const { errores } = validateProducts(importState.productos);

  page.innerHTML = `
    <div class="imp-wrap">
      <div class="imp-step-bar">
        <div class="imp-step done">✓ PDF</div>
        <div class="imp-step-sep">›</div>
        <div class="imp-step done">✓ Revisión</div>
        <div class="imp-step-sep">›</div>
        <div class="imp-step done">✓ Escaneo</div>
        <div class="imp-step-sep">›</div>
        <div class="imp-step act">4 Guardar</div>
      </div>

      <div class="imp-card">
        <div style="font-size:16px;font-weight:700;margin-bottom:16px">Resumen final</div>

        <div class="imp-resumen-grid">
          <div class="imp-resumen-item">
            <div class="imp-resumen-val">${total}</div>
            <div class="imp-resumen-lbl">Total productos</div>
          </div>
          <div class="imp-resumen-item ${conBC === total ? 'g' : 'w'}">
            <div class="imp-resumen-val">${conBC}</div>
            <div class="imp-resumen-lbl">Con código de barras</div>
          </div>
          <div class="imp-resumen-item ${sinBC > 0 ? 'w' : 'g'}">
            <div class="imp-resumen-val">${sinBC}</div>
            <div class="imp-resumen-lbl">Sin código</div>
          </div>
          <div class="imp-resumen-item ${sinPrecio > 0 ? 'r' : 'g'}">
            <div class="imp-resumen-val">${sinPrecio}</div>
            <div class="imp-resumen-lbl">Sin precio de venta</div>
          </div>
        </div>

        ${errores.length ? `
          <div style="margin:14px 0">
            <div style="font-size:12px;font-weight:700;color:var(--warn);margin-bottom:6px">⚠ Advertencias</div>
            ${errores.map(e => `<div class="imp-warn-row">${e}</div>`).join('')}
          </div>` : ''}

        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
          ${sinBC > 0 && conBC > 0 ? `
            <button class="btn warn-btn" onclick="_guardarSoloCompletos()">
              Guardar solo los ${conBC} completos
            </button>` : ''}
          <button class="btn pri" onclick="_guardarTodos()">
            Guardar todos (${total})
          </button>
        </div>

        <div id="imp-save-status" style="margin-top:12px"></div>
      </div>

      <div class="imp-footer-actions">
        <button class="btn" onclick="_irAEscaneo()">← Volver al escaneo</button>
      </div>
    </div>`;
}

// ===== VALIDACIÓN =====

function validateProducts(productos) {
  const errores  = [];
  const barcodes = {};
  const existentes = new Set(store.products.map(p => p.code));

  productos.forEach((p, i) => {
    const n = i + 1;
    if (!p.name?.trim())   errores.push(`Producto ${n}: sin nombre`);
    if (!p.price || p.price <= 0) errores.push(`"${p.name || n}": sin precio de venta`);

    if (p.barcode) {
      if (barcodes[p.barcode] !== undefined) {
        errores.push(`Código ${p.barcode}: duplicado en filas ${barcodes[p.barcode] + 1} y ${n}`);
      }
      barcodes[p.barcode] = i;
      if (existentes.has(p.barcode)) {
        errores.push(`Código ${p.barcode} ya existe en el sistema → se actualizará`);
      }
    }
  });

  return { valid: errores.length === 0, errores };
}

// ===== GUARDADO EN FIREBASE =====

async function _guardarSoloCompletos() {
  await saveProducts(importState.productos.filter(p => p.barcode && p.price > 0));
}

async function _guardarTodos() {
  await saveProducts(importState.productos);
}

/**
 * saveProducts(productos)
 * Guarda en batch en Firebase y actualiza store.products.
 */
async function saveProducts(productos) {
  if (!productos.length) {
    toast('No hay productos para guardar', 'err');
    return;
  }

  const statusEl = document.getElementById('imp-save-status');
  const setStatus = (msg, type) => {
    if (!statusEl) return;
    const cls = { ok: 'imp-status-ok', err: 'imp-status-err', loading: 'imp-status-loading' }[type] || '';
    statusEl.innerHTML = `<div class="imp-status ${cls}">${msg}</div>`;
  };

  setStatus('💾 Guardando en Firebase...', 'loading');

  try {
    const batch    = db.batch();
    const guardados = [];
    const ahora    = new Date().toLocaleString('es-AR');

    for (const p of productos) {
      const id = store.nextProdId++;

      // Si el barcode ya existe, actualizar ese producto en lugar de duplicar
      const existente = store.products.find(ex => ex.code === p.barcode);
      if (existente) {
        Object.assign(existente, {
          name:     (p.name || existente.name).trim(),
          cat:      p.cat     || existente.cat,
          provId:   p.provId  ?? existente.provId,
          cost:     p.cost    || existente.cost,
          price:    p.price   || existente.price,
          stock:    existente.stock + (p.stock || 0),
          minStock: p.minStock || existente.minStock,
          updatedAt: ahora,
        });
        batch.set(db.collection('products').doc(String(existente.id)), existente);
        guardados.push(existente);
        continue;
      }

      const prod = {
        id,
        code:      p.barcode  || `IMP-${id}`,
        name:      (p.name    || 'Sin nombre').trim(),
        cat:       p.cat      || 'Almacén',
        provId:    p.provId   || null,
        cost:      p.cost     || 0,
        price:     p.price    || 0,
        stock:     p.stock    || 0,
        minStock:  p.minStock || 5,
        sold:      0,
        revenue:   0,
        importedAt: ahora,
      };
      batch.set(db.collection('products').doc(String(id)), prod);
      store.products.push(prod);
      guardados.push(prod);
    }

    await batch.commit();

    setStatus(`✅ ${guardados.length} productos guardados correctamente`, 'ok');
    toast(`${guardados.length} productos importados`);

    importState.productos = [];
    importState.rawText   = '';

    setTimeout(() => go('stock'), 1500);

  } catch (e) {
    console.error('saveProducts:', e);
    setStatus('❌ Error guardando: ' + (e.message || 'verificá la conexión'), 'err');
    toast('Error al guardar productos', 'err');
  }
}
