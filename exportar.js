/**
 * exportar.js — BazarHub (v27.8)
 * Descarga una copia de los datos para llevarlos al sistema nuevo.
 *
 * SOLO LEE lo que ya está cargado en la pantalla (el objeto "store"): no consulta
 * Firebase, no escribe nada, no toca la cola de operaciones, la sesión ni la copia
 * local. Las contraseñas (hashes) NO se incluyen. Si algo falla, solo muestra el
 * error en el mensaje del botón; el resto de la app no se entera.
 */
(function () {
  'use strict';

  var COLECCIONES = ['products', 'proveedores', 'sales', 'orders', 'movimientos',
                     'ctacteMovs', 'cajaHistory', 'retiros', 'combos', 'devoluciones'];
  var CONTADORES = ['nextProdId', 'nextProvId', 'nextOCId', 'nextUserId', 'nextCCId',
                    'nextRetiroId', 'saldoAnterior'];
  var CAMPOS_SECRETOS = ['pass', 'password', 'hash', 'clave'];

  function rango(lista) {
    var min = null, max = null;
    for (var i = 0; i < lista.length; i++) {
      var t = lista[i] && lista[i].ts;
      if (typeof t === 'number' && isFinite(t)) {
        if (min === null || t < min) min = t;
        if (max === null || t > max) max = t;
      }
    }
    return min === null ? null : { desde: new Date(min).toISOString(), hasta: new Date(max).toISOString() };
  }

  function sinSecretos(usuario) {
    var copia = {};
    Object.keys(usuario || {}).forEach(function (k) {
      if (CAMPOS_SECRETOS.indexOf(k) < 0) copia[k] = usuario[k];
    });
    return copia;
  }

  // Arma el contenido del archivo a partir de "origen" (por defecto, el store de la app).
  function armar(origen) {
    var s = origen || (typeof store !== 'undefined' ? store : null);
    if (!s) throw new Error('Los datos todavía no están cargados.');

    var datos = {}, resumen = {};
    COLECCIONES.forEach(function (c) {
      var lista = Array.isArray(s[c]) ? s[c] : [];
      datos[c] = lista;
      resumen[c] = { cantidad: lista.length, rango: rango(lista) };
    });
    datos.users = (Array.isArray(s.users) ? s.users : []).map(sinSecretos);
    resumen.users = { cantidad: datos.users.length, rango: null };

    var contadores = {};
    CONTADORES.forEach(function (k) { contadores[k] = s[k] === undefined ? null : s[k]; });

    return {
      formato: 'bazarhub-export-1',
      exportadoEn: new Date().toISOString(),
      version: '27.8',
      resumen: resumen,
      contadores: contadores,
      cajaAbierta: s.cajaAbierta || null,
      datos: datos
    };
  }

  function nombreArchivo() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return 'bazarhub_datos_' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           '_' + p(d.getHours()) + p(d.getMinutes()) + '.json';
  }

  function mostrar(texto, ok) {
    var el = document.getElementById('msg-export');
    if (!el) return;
    el.textContent = texto;
    el.className = 'msg ' + (ok ? 'ok' : 'err');
    el.style.display = 'block';
  }

  function descargar() {
    try {
      var paquete = armar();
      var texto = JSON.stringify(paquete);
      var blob = new Blob([texto], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = nombreArchivo();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);

      var r = paquete.resumen;
      var mov = r.movimientos.rango
        ? ' (movimientos cargados desde el ' + r.movimientos.rango.desde.slice(0, 10) + ')'
        : '';
      mostrar('Listo: se descargó ' + nombreArchivo() + ' (' + Math.round(texto.length / 1024) + ' KB) con ' +
        r.products.cantidad + ' productos, ' + r.sales.cantidad + ' ventas, ' +
        r.movimientos.cantidad + ' movimientos' + mov + ', ' + r.proveedores.cantidad + ' proveedores y ' +
        r.cajaHistory.cantidad + ' cierres de caja.', true);
    } catch (e) {
      mostrar('No se pudo armar la copia: ' + (e && e.message ? e.message : e), false);
    }
  }

  window.bhExportarDatos = descargar;
  window.bhArmarExport = armar;   // para pruebas
})();
