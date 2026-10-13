// Sordina · app principal
import { PERFILES, ESCALA, SUPERFICIE, MEDICION, MOTOR, etiquetaNivel, colorNivel, expresionColor } from './config.js';
import { construirSuperficie, indiceSensores, poligonoCelda, celdaDe, parseCelda, distM } from './grid.js';
import { Motor, madrid, NOMBRE_PERIODO } from './sim.js';
import * as G from './charts.js';
import { Sonometro } from './measure.js';

const fx = G.fx;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem('sordina.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sordina.' + k, JSON.stringify(v)); } catch {} },
};
const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const HORAS = { Ld: '07–19 h', Le: '19–23 h', Ln: '23–07 h', Lden: '24 h' };
const NOMBRE_METRICA = { Ld: 'Ld (día)', Le: 'Le (tarde)', Ln: 'Lnight (noche)', Lden: 'Lden', ahora: 'nivel en directo' };
const BBOX = { minLat: 36.6, maxLat: 36.82, minLon: -4.65, maxLon: -4.25 };
const reducir = G.reducirMovimiento;

async function getJSON(url, opts = {}, ms = 15000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'HTTP ' + r.status), { status: r.status });
    return j;
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const S = {
  datos: null, sensores: [], motor: null, lecturas: [], tMs: Date.now(), ultimaAct: 0,
  perfil: store.get('perfil', 'general'), umbrales: store.get('umbrales', {}),
  capa: 'directo', sel: null, panel: null, superficie: [], cercanos: null,
  map: null, mapaListo: false, marcadores: [], lugares: {}, config: { min_aportes: 2, retencion_horas: 24 },
  valoresSup: null, agregados: [], registros: [],
  ruta: { origen: null, destino: null, modo: 'foot', tolerancia: store.get('tolerancia', 5), resultados: [], elegida: null, calculando: false, hora: null },
  medir: { activo: false, son: null, ventanas: [], pos: null, auto: store.get('autoEnvio', false), mios: new Set(), segundo: null, wake: null, geoError: null, nSeg: 0 },
  marcadorYo: null, marcadoresRuta: {},
};

function perfil(k = S.perfil) {
  const p = PERFILES[k];
  return { ...p, clave: k, umbral: Number(S.umbrales[k] ?? p.umbral) };
}
function hoy() { return madrid(S.tMs).dow; }
function valorPerfil(i, p = perfil()) {
  const s = S.sensores[i];
  if (p.metrica === 'ahora') return S.lecturas[i]?.valor;
  return s.tipico[p.metrica][hoy()];
}
function nombreSensor(i) {
  const s = S.sensores[i];
  return S.lugares[s.id] || null;
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
async function boot() {
  S.datos = await getJSON('/data/sensores.json');
  S.sensores = S.datos.sensores;
  $('#sobreDe').textContent = 'de ' + S.sensores.length;
  S.motor = new Motor(S.sensores);
  S.superficie = construirSuperficie(S.sensores, SUPERFICIE.radioMaxM, SUPERFICIE.potenciaIDW);
  S.cercanos = indiceSensores(S.sensores, SUPERFICIE.radioMaxM);
  getJSON('/api/config').then(c => (S.config = c)).catch(() => {});
  cargarLugares();
  bindUI();
  pintarPerfil();
  tick();
  setInterval(tick, MOTOR.tickMs);
  setInterval(reloj, 1000);
  reloj();
  await initMapa();
  tick();
  cargarAgregados();
  setInterval(cargarAgregados, 20000);
}

let intentosLugares = 0;
async function cargarLugares() {
  try {
    S.lugares = await getJSON('/api/lugares');
    S.marcadores.forEach((m, i) => etiquetarMarcador(i));
  } catch {}
  if (Object.keys(S.lugares).length < S.sensores.length && ++intentosLugares < 12) setTimeout(cargarLugares, 15000);
}

// ---------------------------------------------------------------------------
// Mapa
// ---------------------------------------------------------------------------
async function cargarEstilo() {
  const op = [
    { url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', at: '© <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">colaboradores de OpenStreetMap</a>' },
    { url: 'https://tiles.openfreemap.org/styles/dark', at: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">colaboradores de OpenStreetMap</a>' },
  ];
  for (const o of op) {
    try {
      const st = await getJSON(o.url, {}, 6000);
      if (st && st.layers) return { style: st, at: o.at };
    } catch {}
  }
  return {
    style: { version: 8, sources: {}, layers: [{ id: 'fondo', type: 'background', paint: { 'background-color': '#0b1118' } }] },
    at: 'Mapa base no disponible ahora mismo',
    sinBase: true,
  };
}

async function initMapa() {
  const { style, at, sinBase } = await cargarEstilo();
  const map = (S.map = new maplibregl.Map({
    container: 'map', style, center: [-4.44, 36.718], zoom: window.innerWidth < 600 ? 12.1 : 12.8,
    attributionControl: false, dragRotate: false, pitchWithRotate: false, maxPitch: 0,
    maxBounds: [[-4.8, 36.5], [-4.1, 36.9]],
  }));
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: at }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  if (sinBase) toast('No se pudo cargar el mapa base: se muestran solo los datos de ruido.');
  await new Promise(r => map.on('load', r));

  const primeraEtiqueta = (map.getStyle().layers.find(l => l.type === 'symbol') || {}).id;

  map.addSource('superficie', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: S.superficie.map(c => ({ type: 'Feature', id: c.id, properties: {}, geometry: { type: 'Polygon', coordinates: [poligonoCelda(c.q, c.r)] } })),
    },
  });
  map.addLayer({
    id: 'sup-fill', type: 'fill', source: 'superficie',
    paint: {
      'fill-color': expresionColor(['coalesce', ['feature-state', 'v'], 45]),
      'fill-opacity': ['coalesce', ['feature-state', 'a'], 0],
      'fill-antialias': false,
    },
  }, primeraEtiqueta);
  map.addLayer({
    id: 'sup-line', type: 'line', source: 'superficie',
    paint: { 'line-color': '#070b10', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.2, 15, 0.8], 'line-opacity': ['*', 0.6, ['coalesce', ['feature-state', 'a'], 0]] },
  }, primeraEtiqueta);

  // Mapa de calor de la campaña (peso_heatmap como intensidad)
  map.addSource('calor', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: S.sensores.map(s => ({ type: 'Feature', properties: { peso: s.peso_heatmap ?? 0 }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })) },
  });
  map.addLayer({
    id: 'calor', type: 'heatmap', source: 'calor', layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': ['get', 'peso'],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 11, 0.9, 15, 1.6],
      'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 11, 14, 13, 38, 15, 110],
      'heatmap-opacity': 0.8,
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.15, 'rgba(31,183,166,0.55)', 0.4, '#62c48a', 0.6, '#e9c046', 0.8, '#ef4f5a', 1, '#d6248f'],
    },
  }, primeraEtiqueta);

  // Aportaciones agregadas del servidor
  map.addSource('aportes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'aportes-fill', type: 'fill', source: 'aportes',
    paint: { 'fill-color': expresionColor(['get', 'mediana']), 'fill-opacity': ['case', ['==', ['get', 'fiabilidad'], 'baja'], 0.25, 0.6] },
  });
  map.addLayer({
    id: 'aportes-line', type: 'line', source: 'aportes',
    paint: { 'line-color': '#ffad4a', 'line-width': 2, 'line-dasharray': [2, 1.5] },
  });

  // Rutas
  map.addSource('rutas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('ruta-seg', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'rutas-alt', type: 'line', source: 'rutas', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#a3b2c1', 'line-width': 4, 'line-opacity': 0.45, 'line-dasharray': [1, 1.6] } });
  map.addLayer({ id: 'ruta-casing', type: 'line', source: 'ruta-seg', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#070b10', 'line-width': 10 } });
  map.addLayer({ id: 'ruta-seg', type: 'line', source: 'ruta-seg', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['case', ['has', 'v'], expresionColor(['get', 'v']), '#6f8193'], 'line-width': 6 } });

  // Marcadores de sensores
  S.sensores.forEach((s, i) => {
    const el = document.createElement('button');
    el.className = 'sensor';
    el.innerHTML = '<span class="ring"></span><span class="dot"></span><span class="lbl mono"></span>';
    el.addEventListener('click', e => { e.stopPropagation(); abrirSensor(i); });
    const m = new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(map);
    S.marcadores.push({ m, el, lbl: el.querySelector('.lbl') });
    etiquetarMarcador(i);
  });
  const zoomClase = () => $('#map').classList.toggle('zoom-cerca', map.getZoom() >= 13.6);
  map.on('zoom', zoomClase);
  zoomClase();

  map.on('click', e => {
    if (S.panel === 'ruta') return fijarPuntoRuta(e.lngLat);
    const f = map.queryRenderedFeatures(e.point, { layers: ['aportes-fill'] })[0];
    if (f) {
      const p = f.properties;
      toast(`Celda ${p.celda}: mediana ${fx(p.mediana)} dB · ${p.n_validos} aportaciones válidas · fiabilidad ${p.fiabilidad}`);
    }
  });
  S.mapaListo = true;
  pintarAgregados();
}

function etiquetarMarcador(i) {
  const mk = S.marcadores[i];
  if (!mk) return;
  const s = S.sensores[i], l = S.lecturas[i];
  const n = S.motor.aportaciones(i, S.tMs), f = S.motor.fiabilidad(n);
  const nombre = nombreSensor(i);
  mk.el.setAttribute('aria-label', `${s.id}${nombre ? ', ' + nombre : ''}: ${l ? fx(l.valor) + ' dB, ' + etiquetaNivel(l.valor) : ''}, fiabilidad ${f}`);
}

function actualizarMarcadores() {
  if (!S.marcadores.length) return;
  const p = perfil();
  S.marcadores.forEach((mk, i) => {
    const l = S.lecturas[i];
    const v = S.capa === 'directo' || S.capa === 'campana' ? l.valor : S.sensores[i].tipico[S.capa][hoy()];
    const k = Math.min(1, Math.max(0, (v - ESCALA.min) / (ESCALA.max - ESCALA.min)));
    const el = mk.el;
    el.style.setProperty('--c', colorNivel(v));
    el.style.setProperty('--dur', (3.4 - k * 2.6).toFixed(2) + 's');
    el.style.setProperty('--k', (1.7 + k * 1.9).toFixed(2));
    const n = S.motor.aportaciones(i, S.tMs), f = S.motor.fiabilidad(n);
    el.classList.toggle('baja', S.capa === 'directo' && f === 'baja');
    el.classList.toggle('media', S.capa === 'directo' && f === 'media');
    el.classList.toggle('pico', S.capa === 'directo' && (l.pico || l.evento));
    el.classList.toggle('sel', S.sel === i);
    el.classList.toggle('sobre', valorPerfil(i, p) > p.umbral);
    mk.lbl.textContent = Math.round(v);
    if (!reducir()) {
      el.classList.remove('latido');
      void el.offsetWidth;
      el.classList.add('latido');
    }
    etiquetarMarcador(i);
  });
}

// Superficie IDW con transición de color de ~600 ms
let animSup = null;
function valoresSensores() {
  if (S.capa === 'directo' || S.capa === 'campana') return S.lecturas.map(l => l.valor);
  const d = hoy();
  return S.sensores.map(s => s.tipico[S.capa][d]);
}
function actualizarSuperficie() {
  if (!S.mapaListo) return;
  const vs = valoresSensores();
  const visible = S.capa !== 'campana';
  const fia = S.sensores.map((_, i) => S.motor.fiabilidad(S.motor.aportaciones(i, S.tMs)));
  const factorFia = { baja: 0.42, media: 0.75, alta: 1 };
  const destino = S.superficie.map(c => {
    let sw = 0, sv = 0, cerca = null, dcerca = Infinity;
    for (const [i, w] of c.vecinos) {
      sw += w; sv += w * vs[i];
      if (1 / w < dcerca) { dcerca = 1 / w; cerca = i; }
    }
    const v = sw ? sv / sw : null;
    const borde = 1 - suave(Math.min(1, Math.max(0, (c.dmin - 300) / (SUPERFICIE.radioMaxM - 300))));
    const ff = S.capa === 'directo' && cerca != null ? factorFia[fia[cerca]] : 1;
    return { v, a: visible && v != null ? 0.6 * borde * ff : 0 };
  });
  const origen = S.valoresSup || destino;
  S.valoresSup = destino;
  cancelAnimationFrame(animSup);
  const aplicar = k => {
    for (let j = 0; j < destino.length; j++) {
      const o = origen[j], d = destino[j];
      S.map.setFeatureState({ source: 'superficie', id: S.superficie[j].id }, { v: o.v + (d.v - o.v) * k, a: o.a + (d.a - o.a) * k });
    }
  };
  if (reducir() || origen === destino) return aplicar(1);
  const t0 = performance.now();
  let ultimo = 0;
  const paso = t => {
    const k = Math.min(1, (t - t0) / 600);
    if (k === 1 || t - ultimo > 110) { ultimo = t; aplicar(1 - Math.pow(1 - k, 2)); }
    if (k < 1) animSup = requestAnimationFrame(paso);
  };
  animSup = requestAnimationFrame(paso);
}
const suave = t => t * t * (3 - 2 * t);

// Valor de la superficie en un punto cualquiera (para rutas)
function muestrear(lat, lon, vs) {
  const cerca = S.cercanos(lat, lon);
  if (!cerca.length) return null;
  let sw = 0, sv = 0;
  for (const [i, d] of cerca) {
    const w = 1 / Math.pow(Math.max(d, 40), SUPERFICIE.potenciaIDW);
    sw += w; sv += w * vs[i];
  }
  return sv / sw;
}

// ---------------------------------------------------------------------------
// Motor en directo
// ---------------------------------------------------------------------------
function tick() {
  S.tMs = S.motor.ahora();
  S.lecturas = S.motor.todas(S.tMs);
  S.ultimaAct = Date.now();
  actualizarCabecera();
  actualizarMarcadores();
  actualizarSuperficie();
  if (S.panel === 'sensor' && S.sel != null) actualizarSensor(false);
  pulso();
}

function pulso() {
  const pill = $('#livePill');
  pill.classList.toggle('pausa', S.motor.pausado);
  if (reducir()) return;
  pill.classList.add('flash');
  setTimeout(() => pill.classList.remove('flash'), 350);
  const bar = $('#tickbar');
  bar.classList.remove('run');
  void bar.offsetWidth;
  bar.style.setProperty('--tick', MOTOR.tickMs + 'ms');
  if (!S.motor.pausado) bar.classList.add('run');
}

function reloj() {
  const m = madrid(S.motor.ahora());
  const p = n => String(n).padStart(2, '0');
  const simulada = S.motor.velocidad !== 1 || S.motor.pausado || Math.abs(S.motor.ahora() - Date.now()) > 60e3;
  $('#reloj').textContent = `${p(m.hh)}:${p(m.mm)}:${p(m.ss)}`;
  $('#reloj').setAttribute('aria-label', 'Hora de Madrid ' + `${p(m.hh)}:${p(m.mm)}` + (simulada ? ' (simulada)' : ''));
  const s = Math.max(0, Math.floor((Date.now() - S.ultimaAct) / 1000));
  let txt = S.motor.pausado ? 'en pausa' : `actualizado hace ${s} s`;
  if (S.motor.velocidad !== 1) txt += ` · ×${S.motor.velocidad}`;
  else if (simulada && !S.motor.pausado) txt += ' · hora simulada';
  $('#hace').textContent = txt;
}

function actualizarCabecera() {
  const vs = S.lecturas.map(l => l.valor);
  const medio = vs.reduce((a, b) => a + b, 0) / vs.length;
  G.contar($('#medio'), medio, 1);
  const p = perfil();
  const sobre = S.sensores.filter((_, i) => valorPerfil(i, p) > p.umbral).length;
  G.contar($('#sobre'), sobre, 0);
  $('#sobreK').textContent = `Sobre ${p.metrica === 'ahora' ? '' : NOMBRE_METRICA[p.metrica].split(' ')[0] + ' '}${p.umbral} dB`;
  $('#perfilNombre').textContent = p.corto;
  if (S.panel === 'perfil') pintarAvisoPerfilPanel();
}

// ---------------------------------------------------------------------------
// Perfiles y avisos
// ---------------------------------------------------------------------------
function textoAviso(p = perfil()) {
  const n = S.sensores.filter((_, i) => valorPerfil(i, p) > p.umbral).length;
  const pct = Math.round((n / S.sensores.length) * 100);
  const cuando = p.metrica === 'ahora' ? 'ahora mismo' : p.metrica === 'Ln' ? `en una noche típica de ${DIAS[hoy()]}` : `en un ${DIAS[hoy()]} típico`;
  return { n, pct, html: `<b>${esc(p.nombre)}</b>: ${n} de ${S.sensores.length} sensores (${pct} %) superan ${p.metrica === 'ahora' ? '' : esc(NOMBRE_METRICA[p.metrica]) + ' '}${p.umbral} dB ${cuando}.` };
}
function pintarPerfil() {
  const p = perfil();
  $('#perfilNombre').textContent = p.corto;
  const a = $('#avisoPerfil');
  if (!S.datos || store.get('avisoCerrado.' + p.clave, false)) { a.hidden = true; recolocar(); return; }
  const t = textoAviso(p);
  const sugerencia = p.metrica !== 'ahora' && p.metrica !== 'Lden' && S.capa !== p.metrica
    ? `<button class="chip" data-vercapa="${p.metrica}" style="margin:0">Ver ${p.metrica === 'Ln' ? 'noche' : 'día'} típico</button>` : '';
  a.innerHTML = `<div style="flex:1;min-width:0">${t.html} <span class="nota">El umbral sirve para avisar; el color sigue la escala 45-85 dB.</span> ${sugerencia}</div><button aria-label="Cerrar aviso" id="cerrarAviso">✕</button>`;
  a.hidden = false;
  $('#cerrarAviso').onclick = () => { store.set('avisoCerrado.' + p.clave, true); a.hidden = true; recolocar(); };
  requestAnimationFrame(recolocar);
  const b = a.querySelector('[data-vercapa]');
  if (b) b.onclick = () => setCapa(b.dataset.vercapa);
}
function setPerfil(k) {
  S.perfil = k;
  store.set('perfil', k);
  store.set('avisoCerrado.' + k, false);
  actualizarCabecera();
  actualizarMarcadores();
  pintarPerfil();
  if (S.panel === 'sensor') actualizarSensor(true);
  if (S.panel === 'ruta' && S.ruta.resultados.length) pintarResultadosRuta();
  toast(`Perfil ${PERFILES[k].nombre}: ${textoAviso().n} sensores por encima de su umbral`);
}

function panelPerfil() {
  const body = abrirPanel('perfil', `
    <div class="eyebrow">Perfiles</div>
    <h2 class="h1" id="sheetTitle">¿Para quién miras el ruido?</h2>
    <p class="lead">Cada perfil usa su propio umbral para los avisos y el recuento de sensores por encima. El color del mapa no cambia: casi toda la ciudad supera las referencias de la OMS.</p>
    <div id="avisoPanel"></div>
    <div class="perfiles" role="radiogroup" aria-label="Perfil">
      ${Object.entries(PERFILES).map(([k]) => {
        const p = perfil(k);
        return `<button class="perfil-c" role="radio" aria-checked="${k === S.perfil}" data-perfil="${k}">
          <span class="pc-t"><span class="pc-n">${esc(p.nombre)}</span><span class="pc-u">${p.metrica === 'ahora' ? 'ahora' : esc(p.metrica)} &gt; ${p.umbral} dB</span></span>
          <span class="pc-d">${esc(p.descripcion)}</span>
          <span class="pc-f">Fuente: ${esc(p.fuente)}</span>
          ${p.oficial ? '' : '<span class="pc-x">Sin umbral oficial para este grupo: valor orientativo editable en Más › Ajustes.</span>'}
        </button>`;
      }).join('')}
    </div>`);
  body.querySelectorAll('[data-perfil]').forEach(b => b.addEventListener('click', () => {
    setPerfil(b.dataset.perfil);
    body.querySelectorAll('[data-perfil]').forEach(x => x.setAttribute('aria-checked', x === b));
    pintarAvisoPerfilPanel();
  }));
  pintarAvisoPerfilPanel();
}
function pintarAvisoPerfilPanel() {
  const el = $('#avisoPanel');
  if (!el) return;
  el.innerHTML = `<div class="alerta">${textoAviso().html}</div>`;
}

function setCapa(c) {
  S.capa = c;
  $$('#capas button').forEach(b => b.setAttribute('aria-checked', b.dataset.capa === c));
  const t = { directo: 'Nivel en directo · dB(A)', Ld: `Día típico (Ld) · ${DIAS[hoy()]}`, Le: `Tarde típica (Le) · ${DIAS[hoy()]}`, Ln: `Noche típica (Ln) · ${DIAS[hoy()]}`, campana: 'Campaña 2015 · intensidad peso_heatmap' };
  $('#leyT').textContent = t[c];
  if (S.mapaListo) S.map.setLayoutProperty('calor', 'visibility', c === 'campana' ? 'visible' : 'none');
  actualizarSuperficie();
  actualizarMarcadores();
  pintarPerfil();
}

// ---------------------------------------------------------------------------
// Panel inferior / lateral
// ---------------------------------------------------------------------------
let alCerrar = null;
function abrirPanel(nombre, html, { alto = null } = {}) {
  const sh = $('#sheet');
  if (alCerrar) { const f = alCerrar; alCerrar = null; f(); }
  S.panel = nombre;
  $('#sheetBody').innerHTML = html;
  $('#sheetBody').scrollTop = 0;
  const nuevo = sh.hidden;
  sh.hidden = false;
  sh.classList.remove('full');
  sh.style.height = alto && window.innerWidth < 900 ? alto : '';
  if (nuevo && !reducir()) {
    sh.classList.add('entrando');
    requestAnimationFrame(() => requestAnimationFrame(() => sh.classList.remove('entrando')));
  }
  $$('.dock-b').forEach(b => b.setAttribute('aria-pressed', b.dataset.panel === nombre));
  $('#map').classList.toggle('elegir', nombre === 'ruta');
  document.body.classList.add('sheet-abierta');
  return $('#sheetBody');
}
function cerrarPanel() {
  if (alCerrar) { const f = alCerrar; alCerrar = null; f(); }
  $('#sheet').hidden = true;
  document.body.classList.remove('sheet-abierta');
  S.panel = null;
  S.sel = null;
  $$('.dock-b').forEach(b => b.setAttribute('aria-pressed', 'false'));
  $('#map').classList.remove('elegir');
  actualizarMarcadores();
}

// ---------------------------------------------------------------------------
// Detalle de sensor
// ---------------------------------------------------------------------------
let gaugeSensor = null;
function abrirSensor(i) {
  S.sel = i;
  const s = S.sensores[i];
  const nombre = nombreSensor(i);
  abrirPanel('sensor', `
    <div class="eyebrow" id="dEyebrow">Sensor ${s.id}</div>
    <h2 class="h1" id="sheetTitle">${esc(nombre || 'Sensor ' + s.id)}</h2>
    <div class="badges" id="dBadges"></div>
    <div class="det-top">
      <div class="gauge-w" id="dGauge"></div>
      <dl class="kv" id="dKv"></dl>
    </div>
    <div id="dAlerta"></div>
    <h3 class="h2">Últimos 60 min <small>una lectura cada 5 s</small></h3>
    <div id="dTrend"></div>
    <h3 class="h2">Niveles típicos <small id="dDia"></small></h3>
    <div id="dTip"></div>
    <h3 class="h2">Patrón semanal <small>mediana por día</small></h3>
    <div id="dSem"></div>
    <h3 class="h2">Eventos detectados <small id="dEvN"></small></h3>
    <ul class="lista" id="dEv"></ul>
    <h3 class="h2">Lecturas descartadas <small id="dDescN"></small></h3>
    <ul class="lista" id="dDesc"></ul>
    <p class="nota" style="margin-top:16px">Típicos: mediana de ${s.dias_tipicos} días válidos y no atípicos de la campaña (${S.datos.desde} a ${S.datos.hasta}). La lectura en directo es una simulación construida a partir de esos típicos.</p>`);
  const ev = s.eventos;
  $('#dEvN').textContent = ev.length ? ev.length + ' en la campaña' : '';
  const desc = S.datos.descartadas.filter(d => d.sensor === s.id);
  $('#dDescN').textContent = desc.length ? desc.length + ' por consenso' : '';
  $('#dDesc').innerHTML = desc.length
    ? desc.map(d => `<li><span class="t">${esc(d.fecha)}</span><span class="v">Ld ${fx(d.Ld)} · Le ${fx(d.Le)} · Ln ${fx(d.Ln)}</span><span class="m">${esc(d.motivo)}</span></li>`).join('')
    : '<li><span class="m">Ninguna lectura de este sensor se ha descartado.</span></li>';
  gaugeSensor = G.medidor($('#dGauge'));
  actualizarSensor(true);
  if (S.mapaListo) {
    const off = window.innerWidth >= 900 ? [200, 0] : [0, -Math.min(220, window.innerHeight * 0.25)];
    S.map.easeTo({ center: [s.lon, s.lat], offset: off, zoom: Math.max(S.map.getZoom(), 14), duration: reducir() ? 0 : 700 });
  }
  actualizarMarcadores();
}

function actualizarSensor(completo) {
  const i = S.sel;
  if (i == null || !$('#dGauge')) return;
  const s = S.sensores[i], l = S.lecturas[i], p = perfil();
  const n = S.motor.aportaciones(i, S.tMs), f = S.motor.fiabilidad(n);
  const d = hoy();
  gaugeSensor.set(l.valor);
  $('#dEyebrow').textContent = `Sensor ${s.id} · ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`;
  $('#dBadges').innerHTML = `
    <span class="badge" style="--c:${colorNivel(l.valor)}"><i></i>${etiquetaNivel(l.valor)}</span>
    <span class="badge fia-${f}">Fiabilidad ${f} · ${n} aportaci${n === 1 ? 'ón' : 'ones'}</span>
    <span class="badge">Periodo: ${NOMBRE_PERIODO[l.periodo]}${l.transicion ? ' (transición)' : ''}</span>
    ${l.pico ? '<span class="badge acc">Pico breve</span>' : ''}${l.evento ? '<span class="badge acc">Evento simulado</span>' : ''}`;
  $('#dKv').innerHTML = `
    <dt>Ahora</dt><dd>${fx(l.valor)} dB</dd>
    <dt>Típico ahora</dt><dd>${fx(l.base)} dB</dd>
    <dt>Diferencia</dt><dd>${l.valor - l.base >= 0 ? '+' : ''}${fx(l.valor - l.base)} dB</dd>
    <dt>Lden típico</dt><dd>${fx(s.tipico.Lden[d])} dB</dd>
    <dt>Aportaciones</dt><dd>${n}</dd>`;
  const hist = S.motor.historico(i, S.tMs, 60, 5);
  const umbralGraf = p.metrica === 'ahora' ? p.umbral : null;
  G.tendencia($('#dTrend'), hist, { umbral: umbralGraf, etiquetaUmbral: umbralGraf ? `tu umbral ${p.umbral}` : '' });

  // Aviso según perfil
  let al;
  if (p.metrica === 'ahora') {
    const picos = hist.filter(([t], k) => k > 0 && S.motor.lectura(i, t).pico).length;
    const vals = hist.map(h => h[1]);
    const media = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, v) => a + (v - media) ** 2, 0) / vals.length);
    const extra = p.clave === 'migranas'
      ? `En la última hora hubo ${picos} lecturas con pico breve (3-8 dB).`
      : `Variabilidad en la última hora: ±${fx(sd)} dB (desviación típica).`;
    al = l.valor > p.umbral
      ? `<div class="alerta">Ahora hay ${fx(l.valor)} dB: ${fx(l.valor - p.umbral)} dB por encima de tu umbral de ${esc(p.nombre)} (${p.umbral} dB). ${extra}</div>`
      : `<div class="alerta ok">Ahora está por debajo de tu umbral de ${esc(p.nombre)} (${p.umbral} dB). ${extra}</div>`;
  } else {
    const v = s.tipico[p.metrica][d];
    al = v > p.umbral
      ? `<div class="alerta">Para ${esc(p.nombre)}: el ${esc(NOMBRE_METRICA[p.metrica])} típico de un ${DIAS[d]} es ${fx(v)} dB, ${fx(v - p.umbral)} dB por encima de ${p.umbral} dB (${esc(p.fuente.split(':')[0])}).</div>`
      : `<div class="alerta ok">Para ${esc(p.nombre)}: el ${esc(NOMBRE_METRICA[p.metrica])} típico de un ${DIAS[d]} es ${fx(v)} dB, por debajo de ${p.umbral} dB.</div>`;
  }
  $('#dAlerta').innerHTML = al;

  if (completo) {
    $('#dDia').textContent = DIAS[d] + ' · mediana 2015';
    const enf = p.metrica === 'ahora' ? l.periodo : p.metrica;
    G.tipicos($('#dTip'), [
      { nombre: 'Día', horas: HORAS.Ld, metrica: 'Ld', valor: s.tipico.Ld[d] },
      { nombre: 'Tarde', horas: HORAS.Le, metrica: 'Le', valor: s.tipico.Le[d] },
      { nombre: 'Noche', horas: HORAS.Ln, metrica: 'Ln', valor: s.tipico.Ln[d] },
      { nombre: 'Lden', horas: HORAS.Lden, metrica: 'Lden', valor: s.tipico.Lden[d] },
    ], { umbral: p.metrica === 'ahora' ? null : p.umbral, enfasis: enf });
    G.semanal($('#dSem'), s, d, p.metrica === 'ahora' ? l.periodo : p.metrica);
  }
  const sims = S.motor.eventos.filter(e => e.i === i);
  const evs = S.sensores[i].eventos;
  $('#dEv').innerHTML =
    sims.map(e => `<li class="sim"><span class="t">Evento simulado</span><span class="v">+${fx(e.amp)} dB · 3 min</span><span class="m">Iniciado a las ${new Date(e.inicio).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' })} desde Ajustes avanzados</span></li>`).join('') +
    (evs.length
      ? evs.map(e => `<li><span class="t">${esc(e.etiqueta)}</span><span class="v">Lden ${fx(e.Lden)} dB</span><span class="m">${esc(e.fecha)} · Ld ${fx(e.Ld)} · Le ${fx(e.Le)} · Ln ${fx(e.Ln)} · lectura real, no es un error</span></li>`).join('')
      : sims.length ? '' : '<li><span class="m">Sin eventos con causa conocida en la campaña.</span></li>');
}

// ---------------------------------------------------------------------------
// Rutas tranquilas
// ---------------------------------------------------------------------------
function panelRuta() {
  const R = S.ruta;
  const body = abrirPanel('ruta', `
    <div class="eyebrow">Rutas tranquilas</div>
    <h2 class="h1" id="sheetTitle">Llega por donde hay menos ruido</h2>
    <p class="lead">Toca el mapa para marcar el origen y después el destino, o búscalos.</p>
    <div class="campo"><label for="rOrigen">Origen</label>
      <div class="fila"><input class="in" id="rOrigen" style="flex:1;min-width:0" placeholder="Busca una calle o toca el mapa" autocomplete="off" value="${esc(R.origen?.nombre || '')}">
      <button class="btn" id="rMiPos" aria-label="Usar mi ubicación como origen">Mi ubicación</button></div>
      <ul class="sugerencias" id="rOrigenSug" hidden></ul></div>
    <div class="campo"><label for="rDestino">Destino</label>
      <input class="in" id="rDestino" placeholder="Busca una calle o toca el mapa" autocomplete="off" value="${esc(R.destino?.nombre || '')}">
      <ul class="sugerencias" id="rDestinoSug" hidden></ul></div>
    <div class="fila" style="justify-content:space-between;margin:8px 0">
      <div class="seg" role="group" aria-label="Modo de desplazamiento">
        <button aria-pressed="${R.modo === 'foot'}" data-modo="foot">A pie</button>
        <button aria-pressed="${R.modo === 'bike'}" data-modo="bike">En bici</button>
      </div>
      <button class="btn" id="rBorrar">Borrar</button>
    </div>
    <div class="campo"><label for="rTol">Tiempo extra que aceptas: <b class="mono" id="rTolV">+${R.tolerancia} min</b></label>
      <input type="range" id="rTol" min="0" max="15" step="1" value="${R.tolerancia}"></div>
    <button class="btn pri full" id="rCalc">Calcular rutas</button>
    <div id="rRes" style="margin-top:14px"></div>
    <p class="nota" style="margin-top:14px">Limitación: solo se evalúan las alternativas que devuelve el servicio de rutas (OSRM sobre OpenStreetMap) y, si devuelve menos de tres, dos variantes con un punto intermedio a cada lado. No se busca la ruta más tranquila posible en toda la red. El ruido se muestrea cada ~25 m sobre la superficie en directo; los tramos a más de 500 m de un sensor cuentan como «sin datos».</p>`, { alto: '46vh' });
  alCerrar = () => {};
  const conectarBuscador = (idIn, idSug, campo) => {
    const inp = $('#' + idIn), sug = $('#' + idSug);
    let t;
    inp.addEventListener('input', () => {
      clearTimeout(t);
      const q = inp.value.trim();
      if (q.length < 3) { sug.hidden = true; return; }
      t = setTimeout(async () => {
        try {
          const r = await getJSON('/api/buscar?q=' + encodeURIComponent(q + ', Málaga'));
          if (!r.length) { sug.innerHTML = '<li class="nota" style="padding:8px">Sin resultados en Málaga.</li>'; sug.hidden = false; return; }
          sug.innerHTML = r.map((x, k) => `<li><button data-k="${k}">${esc(x.nombre.split(',').slice(0, 3).join(','))}</button></li>`).join('');
          sug.hidden = false;
          sug.querySelectorAll('button').forEach(b => (b.onclick = () => {
            const x = r[+b.dataset.k];
            fijarPunto(campo, { lat: x.lat, lon: x.lon, nombre: x.nombre.split(',').slice(0, 2).join(',') });
            sug.hidden = true;
          }));
        } catch (e) {
          sug.innerHTML = `<li class="nota" style="padding:8px">${esc(e.message)}</li>`;
          sug.hidden = false;
        }
      }, 400);
    });
  };
  conectarBuscador('rOrigen', 'rOrigenSug', 'origen');
  conectarBuscador('rDestino', 'rDestinoSug', 'destino');
  body.querySelectorAll('[data-modo]').forEach(b => (b.onclick = () => {
    R.modo = b.dataset.modo;
    body.querySelectorAll('[data-modo]').forEach(x => x.setAttribute('aria-pressed', x === b));
  }));
  $('#rTol').oninput = e => {
    R.tolerancia = +e.target.value;
    store.set('tolerancia', R.tolerancia);
    $('#rTolV').textContent = `+${R.tolerancia} min`;
    if (R.resultados.length) pintarResultadosRuta();
  };
  $('#rBorrar').onclick = () => {
    R.origen = R.destino = null; R.resultados = []; R.elegida = null;
    $('#rOrigen').value = $('#rDestino').value = '';
    pintarPinesRuta(); pintarRutasMapa(); $('#rRes').innerHTML = '';
  };
  $('#rMiPos').onclick = () => {
    if (!navigator.geolocation) return toast('Este navegador no da la ubicación.');
    navigator.geolocation.getCurrentPosition(
      p => fijarPunto('origen', { lat: p.coords.latitude, lon: p.coords.longitude, nombre: 'Mi ubicación' }),
      () => toast('No se pudo obtener tu ubicación. Toca el mapa para marcar el origen.'),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  $('#rCalc').onclick = calcularRutas;
  if (R.resultados.length) pintarResultadosRuta();
}

function dentroMalaga(p) { return p.lat > BBOX.minLat && p.lat < BBOX.maxLat && p.lon > BBOX.minLon && p.lon < BBOX.maxLon; }
function fijarPunto(campo, p) {
  if (!dentroMalaga(p)) return toast('Ese punto está fuera de Málaga.');
  S.ruta[campo] = p;
  const inp = $(campo === 'origen' ? '#rOrigen' : '#rDestino');
  if (inp) inp.value = p.nombre;
  pintarPinesRuta();
  if (S.ruta.origen && S.ruta.destino) calcularRutas();
}
function fijarPuntoRuta(ll) {
  const campo = !S.ruta.origen ? 'origen' : !S.ruta.destino ? 'destino' : null;
  if (!campo) return toast('Ya hay origen y destino. Pulsa «Borrar» para empezar otra ruta.');
  fijarPunto(campo, { lat: ll.lat, lon: ll.lng, nombre: `Punto en el mapa (${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)})` });
}
function pintarPinesRuta() {
  if (!S.mapaListo) return;
  for (const k of ['origen', 'destino']) {
    const p = S.ruta[k];
    if (S.marcadoresRuta[k]) { S.marcadoresRuta[k].remove(); S.marcadoresRuta[k] = null; }
    if (p) {
      const el = document.createElement('div');
      el.className = 'pin' + (k === 'destino' ? ' b' : '');
      el.innerHTML = `<b>${k === 'origen' ? 'A' : 'B'}</b>`;
      el.setAttribute('aria-label', k);
      S.marcadoresRuta[k] = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(S.map);
    }
  }
}

function longitud(coords) {
  let d = 0;
  for (let k = 1; k < coords.length; k++) d += distM({ lat: coords[k - 1][1], lon: coords[k - 1][0] }, { lat: coords[k][1], lon: coords[k][0] });
  return d;
}
function remuestrear(coords, paso = 25) {
  const out = [{ lat: coords[0][1], lon: coords[0][0], km: 0 }];
  let acum = 0, sig = paso;
  for (let k = 1; k < coords.length; k++) {
    const a = { lat: coords[k - 1][1], lon: coords[k - 1][0] }, b = { lat: coords[k][1], lon: coords[k][0] };
    const d = distM(a, b);
    while (acum + d >= sig) {
      const t = (sig - acum) / d;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, km: sig / 1000 });
      sig += paso;
    }
    acum += d;
  }
  const u = coords[coords.length - 1];
  out.push({ lat: u[1], lon: u[0], km: acum / 1000 });
  return out;
}
const leq = vs => 10 * Math.log10(vs.reduce((a, v) => a + Math.pow(10, v / 10), 0) / vs.length);

function puntuar(ruta, vs) {
  const m = remuestrear(ruta.geom, 25);
  m.forEach(p => (p.v = muestrear(p.lat, p.lon, vs)));
  const cub = m.filter(p => p.v != null);
  const cobertura = cub.length / m.length;
  const media = cub.length ? leq(cub.map(p => p.v)) : null;
  // tramo más ruidoso: ventana móvil de 200 m (8 muestras)
  let peor = null;
  for (let k = 0; k + 8 <= m.length; k++) {
    const w = m.slice(k, k + 8).filter(p => p.v != null);
    if (w.length < 6) continue;
    const v = leq(w.map(p => p.v));
    if (!peor || v > peor.v) peor = { v, km: m[k].km, lat: m[k + 4].lat, lon: m[k + 4].lon };
  }
  const p = perfil();
  const sobre = cub.length ? cub.filter(x => x.v > p.umbral).length / cub.length : 0;
  return { ...ruta, muestras: m, cobertura, media, peor, sobre };
}

async function pedirRuta(coords, alternativas) {
  const j = await getJSON(`/api/ruta?perfil=${S.ruta.modo}&alternativas=${alternativas ? 1 : 0}&coords=${coords.map(c => `${c.lon.toFixed(6)},${c.lat.toFixed(6)}`).join(';')}`);
  return (j.routes || []).map(r => ({ geom: r.geometry.coordinates, dur: r.duration, dist: r.distance }));
}
function parecida(a, b) {
  if (Math.abs(a.dist - b.dist) / Math.max(a.dist, b.dist) > 0.04) return false;
  const ma = remuestrear(a.geom, 60), mb = remuestrear(b.geom, 60);
  const cerca = ma.filter(p => mb.some(q => distM(p, q) < 35)).length;
  return cerca / ma.length > 0.9;
}

async function calcularRutas() {
  const R = S.ruta;
  if (!R.origen || !R.destino) return toast('Marca origen y destino: toca el mapa o búscalos.');
  if (R.calculando) return;
  R.calculando = true;
  const res = $('#rRes');
  if (res) res.innerHTML = '<p class="nota">Calculando alternativas…</p>';
  try {
    let rutas = (await pedirRuta([R.origen, R.destino], true)).map((r, k) => ({ ...r, tipo: k === 0 ? 'Ruta directa' : `Alternativa ${k}`, fuente: 'OSRM' }));
    if (!rutas.length) throw new Error('El servicio de rutas no encontró camino entre esos puntos.');
    if (rutas.length < 3) {
      // variantes con un punto intermedio desplazado a cada lado
      const a = R.origen, b = R.destino;
      const d = distM(a, b);
      const off = Math.min(600, Math.max(150, d * 0.22));
      const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
      const dx = (b.lon - a.lon) * Math.cos((mid.lat * Math.PI) / 180), dy = b.lat - a.lat;
      const n = Math.hypot(dx, dy) || 1;
      for (const sgn of [1, -1]) {
        const via = { lat: mid.lat + (sgn * dx / n) * (off / 111320), lon: mid.lon - (sgn * dy / n) * (off / (111320 * Math.cos((mid.lat * Math.PI) / 180))) };
        try {
          const [r] = await pedirRuta([a, via, b], false);
          if (r && !rutas.some(x => parecida(x, r))) rutas.push({ ...r, tipo: `Variante por el ${sgn > 0 ? 'norte/oeste' : 'sur/este'}`, fuente: 'OSRM con punto intermedio' });
        } catch {}
      }
    }
    const vs = S.lecturas.map(l => l.valor);
    R.resultados = rutas.map(r => puntuar(r, vs));
    R.hora = S.tMs;
    R.elegida = null;
    pintarResultadosRuta();
    const b = new maplibregl.LngLatBounds();
    R.resultados.forEach(r => r.geom.forEach(c => b.extend(c)));
    const mob = window.innerWidth < 900;
    S.map.fitBounds(b, { padding: mob ? { top: 150, bottom: window.innerHeight * 0.6, left: 30, right: 30 } : { top: 120, bottom: 120, left: 480, right: 80 }, duration: reducir() ? 0 : 800 });
  } catch (e) {
    if (res) res.innerHTML = `<div class="alerta">${esc(e.message)}. Inténtalo de nuevo en unos segundos.</div>`;
  } finally {
    R.calculando = false;
  }
}

function recomendacion() {
  const R = S.ruta;
  const rs = R.resultados;
  const rapida = rs.reduce((a, b) => (b.dur < a.dur ? b : a));
  const cand = rs.filter(r => r.media != null && r.cobertura >= 0.25 && (r.dur - rapida.dur) / 60 <= R.tolerancia + 1e-9);
  const reco = cand.length ? cand.reduce((a, b) => (b.media < a.media ? b : a)) : rapida;
  return { rapida, reco };
}

function pintarResultadosRuta() {
  const R = S.ruta, res = $('#rRes');
  const { rapida, reco } = recomendacion();
  if (R.elegida == null || !R.resultados[R.elegida]) R.elegida = R.resultados.indexOf(reco);
  const p = perfil();
  const hora = madrid(R.hora);
  const delta = rapida.media != null && reco.media != null ? reco.media - rapida.media : 0;
  let resumen;
  if (reco === rapida) resumen = `<div class="alerta info">La ruta más rápida ya es la más tranquila dentro de +${R.tolerancia} min${R.resultados.length === 1 ? ' (el servicio solo devolvió una ruta)' : ''}.</div>`;
  else resumen = `<div class="alerta ok">Recomendada: <b>${esc(reco.tipo)}</b>. ${fx(Math.abs(delta))} dB menos de ruido medio que la más rápida a cambio de ${fx((reco.dur - rapida.dur) / 60, 0)} min más.</div>`;
  if (res) {
    res.innerHTML = `${resumen}
      <p class="nota">Niveles en directo de las ${String(hora.hh).padStart(2, '0')}:${String(hora.mm).padStart(2, '0')}. <button class="btn" id="rRecalc" style="min-height:36px;padding:0 10px;margin-left:6px">Recalcular</button></p>
      <div class="rutas">${R.resultados.map((r, k) => {
        const extra = (r.dur - rapida.dur) / 60;
        const tiras = [];
        const paso = Math.max(1, Math.floor(r.muestras.length / 40));
        for (let j = 0; j < r.muestras.length; j += paso) tiras.push(`<i style="background:${r.muestras[j].v == null ? 'rgba(111,129,147,.4)' : colorNivel(r.muestras[j].v)}"></i>`);
        return `<button class="ruta-c${r === reco ? ' reco' : ''}" aria-pressed="${k === R.elegida}" data-r="${k}">
          <span class="rc-t"><span class="rc-n">${esc(r.tipo)}</span>${r === reco ? '<span class="badge acc">Recomendada</span>' : ''}</span>
          <span class="rc-m">
            <div><span>Ruido medio</span><b>${r.media == null ? '—' : fx(r.media)}</b></div>
            <div><span>Tramo peor</span><b>${r.peor ? fx(r.peor.v) : '—'}</b></div>
            <div><span>Tiempo</span><b>${fx(r.dur / 60, 0)}′ ${extra > 0.5 ? `<small>+${fx(extra, 0)}</small>` : ''}</b></div>
          </span>
          <span class="rc-strip" aria-hidden="true">${tiras.join('')}</span>
          <span class="nota">${fx(r.dist / 1000, 2)} km · ${Math.round(r.cobertura * 100)} % con datos · ${Math.round(r.sobre * 100)} % sobre tu umbral (${p.umbral} dB)${r.peor ? ` · tramo peor en el km ${fx(r.peor.km, 1)}` : ''} · ${esc(r.fuente)}</span>
        </button>`;
      }).join('')}</div>`;
    res.querySelectorAll('[data-r]').forEach(b => (b.onclick = () => { R.elegida = +b.dataset.r; pintarResultadosRuta(); }));
    $('#rRecalc').onclick = () => {
      const vs = S.lecturas.map(l => l.valor);
      R.resultados = R.resultados.map(r => puntuar(r, vs));
      R.hora = S.tMs;
      R.elegida = null;
      pintarResultadosRuta();
    };
  }
  pintarRutasMapa();
}

function pintarRutasMapa() {
  if (!S.mapaListo) return;
  const R = S.ruta;
  const otras = R.resultados.filter((_, k) => k !== R.elegida).map(r => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.geom } }));
  S.map.getSource('rutas').setData({ type: 'FeatureCollection', features: otras });
  const el = R.resultados[R.elegida];
  const segs = [];
  if (el) {
    for (let k = 1; k < el.muestras.length; k++) {
      const a = el.muestras[k - 1], b = el.muestras[k];
      const v = a.v != null && b.v != null ? (a.v + b.v) / 2 : null;
      segs.push({ type: 'Feature', properties: v == null ? {} : { v }, geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] } });
    }
  }
  S.map.getSource('ruta-seg').setData({ type: 'FeatureCollection', features: segs });
}

// ---------------------------------------------------------------------------
// Medir aquí
// ---------------------------------------------------------------------------
let gaugeMedir = null;
function consentimiento() {
  return new Promise(resolve => {
    if (store.get('consentimiento', false)) return resolve(true);
    const m = $('#modal'), box = $('#modalBox');
    box.innerHTML = `
      <div class="eyebrow">Antes de medir</div>
      <h2 class="h1" id="modalTitle" style="margin-right:0">Tu móvil mide. Tu audio se queda en él.</h2>
      <ul>
        <li>Usamos el <b>micrófono</b> para calcular el nivel de ruido. El audio se analiza en la memoria del móvil y <b>nunca se graba ni se envía</b>.</li>
        <li>Usamos tu <b>ubicación</b> solo para saber en qué celda de ~150 m estás. Tu posición exacta no sale del móvil.</li>
        <li>Cada 30 s puedes enviar un paquete con: celda, hora redondeada a 5 min, dB, calidad y un código aleatorio distinto en cada envío. Nada más. Verás el paquete antes de enviarlo.</li>
        <li>Sin cuentas, sin cookies de seguimiento y sin analítica. El servidor borra todo a las ${S.config.retencion_horas || 24} h.</li>
        <li>Es una medición orientativa: el micrófono del móvil no está calibrado.</li>
      </ul>
      <div class="fila" style="justify-content:flex-end;margin-top:14px">
        <button class="btn" id="cNo">Ahora no</button>
        <button class="btn pri" id="cSi">Acepto y empiezo</button>
      </div>`;
    m.hidden = false;
    $('#cSi').focus();
    const fin = ok => { m.hidden = true; if (ok) store.set('consentimiento', true); resolve(ok); };
    $('#cSi').onclick = () => fin(true);
    $('#cNo').onclick = () => fin(false);
  });
}

function panelMedir() {
  const M = S.medir;
  const body = abrirPanel('medir', `
    <div class="eyebrow">Medir aquí · orientativo</div>
    <h2 class="h1" id="sheetTitle">${M.activo ? 'Midiendo' : 'Mide el ruido donde estás'}</h2>
    <div id="mAvisos"></div>
    <div class="medidor-grande"><div class="gauge-w" id="mGauge"></div></div>
    <div class="fila" style="justify-content:space-between;margin:2px 0 6px">
      <span class="nota">Ventana de 30 s: <b class="mono" id="mSeg">0</b>/30 s</span>
      <span class="nota" id="mUbic">Ubicación: —</span>
    </div>
    <div class="progreso" aria-hidden="true"><i id="mProg"></i></div>
    <div class="fila" style="margin:14px 0 4px">
      <button class="btn ${M.activo ? 'peligro' : 'pri'} full" id="mToggle">${M.activo ? 'Detener medición' : 'Empezar a medir'}</button>
    </div>
    <label class="switch"><span>Envío automático de cada ventana</span><input type="checkbox" id="mAuto" ${M.auto ? 'checked' : ''}></label>
    <div class="campo"><label for="mCal">Desfase de calibración: <b class="mono" id="mCalV">${M.son?.calibracion ?? store.get('calibracion', MEDICION.calibracion)} dB</b></label>
      <input type="range" id="mCal" min="-20" max="20" step="0.5" value="${store.get('calibracion', MEDICION.calibracion)}"></div>
    <h3 class="h2">Ventanas de 30 s <small>L90 = fondo · L50 = mediana</small></h3>
    <div class="ventanas" id="mVentanas"></div>
    <p class="nota" style="margin-top:14px">El audio se procesa solo en memoria, con ponderación A y sin cancelación de eco, supresión de ruido ni control automático de ganancia. Las ventanas con «posible voz» (energía entre 300 y 3400 Hz con modulación silábica) no se usan como ruido de fondo y no se envían. El nivel usa una referencia nominal (dBFS + ${MEDICION.referenciaNominal}) más tu desfase: es orientativo.</p>`, { alto: '78vh' });
  gaugeMedir = G.medidor($('#mGauge'), { titulo: 'Nivel medido' });
  if (M.segundo != null) gaugeMedir.set(M.segundo);
  $('#mToggle').onclick = () => (M.activo ? detenerMedicion() : empezarMedicion());
  $('#mAuto').onchange = e => { M.auto = e.target.checked; store.set('autoEnvio', M.auto); if (M.auto) M.ventanas.filter(v => v.estado === 'lista').forEach(programarEnvio); pintarVentanas(); };
  $('#mCal').oninput = e => {
    const v = +e.target.value;
    store.set('calibracion', v);
    if (M.son) M.son.calibracion = v;
    $('#mCalV').textContent = fx(v) + ' dB';
  };
  pintarAvisosMedir();
  pintarVentanas();
  pintarUbicacion();
}

function pintarAvisosMedir() {
  const el = $('#mAvisos');
  if (!el) return;
  const M = S.medir;
  const a = [];
  if (M.activo && M.wake === false) a.push('<div class="alerta">No se pudo mantener la pantalla encendida en este navegador. Mantenla activa mientras mides: si se apaga, la medición se pausa.</div>');
  if (M.geoError) a.push(`<div class="alerta">${esc(M.geoError)}</div>`);
  if (!M.activo && !M.ventanas.length) a.push('<div class="alerta info">Ponte en el exterior, sujeta el móvil con el micrófono despejado y evita hablar cerca. Cada 30 s se calcula una ventana con L90 y L50.</div>');
  el.innerHTML = a.join('');
}
function pintarUbicacion() {
  const el = $('#mUbic');
  if (!el) return;
  const p = S.medir.pos;
  el.textContent = p ? `Celda ${celdaDe(p.lat, p.lon).id} · ±${Math.round(p.acc)} m` : S.medir.activo ? 'Buscando ubicación…' : 'Ubicación: —';
}

async function empezarMedicion() {
  const M = S.medir;
  if (!(await consentimiento())) return;
  if (!window.isSecureContext) return toast('El micrófono solo funciona con https. Abre la app desde su enlace https.');
  const son = new Sonometro();
  son.calibracion = store.get('calibracion', MEDICION.calibracion);
  try {
    await son.iniciar({
      alSegundo: (v, n) => {
        M.nSeg = n;
        if (v != null) { M.segundo = v; gaugeMedir?.set(v); }
        const s = $('#mSeg'); if (s) s.textContent = n;
        const pr = $('#mProg'); if (pr) pr.style.width = (n / MEDICION.ventanaS) * 100 + '%';
        pintarYo();
      },
      alVentana: v => nuevaVentana(v),
      alEstado: e => { if ('wakeLock' in e) { M.wake = e.wakeLock; pintarAvisosMedir(); } },
    });
  } catch (e) {
    const msg = e?.name === 'NotAllowedError' ? 'Permiso de micrófono denegado. Actívalo en los ajustes del navegador para este sitio.' : e?.message || 'No se pudo abrir el micrófono.';
    toast(msg);
    M.geoError = msg;
    pintarAvisosMedir();
    return;
  }
  M.son = son; M.activo = true; M.geoError = null;
  $('#btnMedir').classList.add('activo');
  $('#btnMedir').querySelector('span:last-child').textContent = 'Midiendo';
  if (navigator.geolocation) {
    M.watch = navigator.geolocation.watchPosition(
      p => {
        const primera = !M.pos;
        M.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
        M.geoError = dentroMalaga(M.pos) ? null : 'Estás fuera de Málaga: puedes medir, pero el servidor solo acepta celdas de Málaga y no se enviará nada.';
        pintarUbicacion(); pintarAvisosMedir(); pintarYo();
        if (primera && S.mapaListo && dentroMalaga(M.pos)) S.map.easeTo({ center: [M.pos.lon, M.pos.lat], zoom: 15, offset: [0, -120], duration: reducir() ? 0 : 900 });
      },
      err => {
        M.geoError = err.code === 1 ? 'Permiso de ubicación denegado: puedes medir, pero sin celda no se puede enviar.' : 'No se pudo obtener la ubicación todavía.';
        pintarAvisosMedir(); pintarUbicacion();
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
    );
  } else M.geoError = 'Este navegador no da la ubicación: sin celda no se puede enviar.';
  if (S.panel === 'medir') panelMedir();
}

function detenerMedicion() {
  const M = S.medir;
  M.son?.detener();
  M.son = null; M.activo = false;
  if (M.watch != null) navigator.geolocation.clearWatch(M.watch);
  M.watch = null;
  $('#btnMedir').classList.remove('activo');
  $('#btnMedir').querySelector('span:last-child').textContent = 'Medir aquí';
  if (S.panel === 'medir') panelMedir();
}

function pintarYo() {
  const M = S.medir;
  if (!S.mapaListo || !M.pos) return;
  if (!S.marcadorYo) {
    const el = document.createElement('div');
    el.className = 'yo';
    el.innerHTML = '<span class="yo-ring"></span><span class="yo-core"></span><span class="yo-lbl"></span>';
    S.marcadorYo = new maplibregl.Marker({ element: el }).setLngLat([M.pos.lon, M.pos.lat]).addTo(S.map);
  }
  S.marcadorYo.setLngLat([M.pos.lon, M.pos.lat]);
  const ult = M.ventanas[0];
  const v = M.activo && M.segundo != null ? M.segundo : ult?.L50;
  S.marcadorYo.getElement().querySelector('.yo-lbl').textContent = v != null ? `Tú · ${Math.round(v)} dB` : 'Tú';
}

function token() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
function hora5(ms) {
  const d = new Date(Math.floor(ms / 300000) * 300000);
  return d.toISOString().slice(0, 16) + 'Z';
}

function nuevaVentana(v) {
  const M = S.medir;
  v.id = Math.random().toString(36).slice(2);
  if (v.voz) v.estado = 'voz';
  else if (!M.pos || !dentroMalaga(M.pos)) v.estado = 'sinUbicacion';
  else {
    v.paquete = { celda: celdaDe(M.pos.lat, M.pos.lon).id, hora: hora5(v.fin), db: Math.round(v.L50 * 10) / 10, calidad: v.calidad, token: token() };
    v.estado = v.paquete.db < 30 || v.paquete.db > 130 ? 'fueraRango' : 'lista';
  }
  M.ventanas.unshift(v);
  M.ventanas = M.ventanas.slice(0, 12);
  if (M.auto && v.estado === 'lista') programarEnvio(v);
  pintarVentanas();
  pintarYo();
  if (S.panel === 'privacidad') pintarPrivacidad();
}

function programarEnvio(v) {
  if (v.estado !== 'lista') return;
  const espera = Math.floor(Math.random() * 21); // 0-20 s de retardo aleatorio
  v.estado = 'programada';
  v.enviaEn = Date.now() + espera * 1000;
  v.timer = setInterval(() => {
    if (Date.now() >= v.enviaEn) { clearInterval(v.timer); enviar(v); }
    pintarVentanas();
  }, 1000);
  pintarVentanas();
}
async function enviar(v) {
  v.estado = 'enviando';
  pintarVentanas();
  try {
    await getJSON('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v.paquete), credentials: 'omit', referrerPolicy: 'no-referrer' });
    v.estado = 'enviada';
    S.medir.mios.add(v.paquete.token);
    toast('Enviado. Ya aparece en «Qué guarda el servidor».');
    cargarAgregados();
    if (S.panel === 'privacidad') cargarRegistros();
  } catch (e) {
    v.estado = 'error';
    v.error = e.message;
  }
  pintarVentanas();
}

function pintarVentanas() {
  const el = $('#mVentanas');
  if (!el) return;
  const M = S.medir;
  if (!M.ventanas.length) {
    el.innerHTML = `<p class="nota">${M.activo ? 'La primera ventana se cierra a los 30 s.' : 'Aún no hay ventanas.'}</p>`;
    return;
  }
  const estado = v => ({
    voz: '<span class="badge" style="color:var(--warn)">Posible voz · no se usa ni se envía</span>',
    sinUbicacion: '<span class="badge">Sin celda · no se puede enviar</span>',
    fueraRango: '<span class="badge">Fuera de 30-130 dB · no se envía</span>',
    lista: '',
    programada: `<span class="badge acc">Se enviará en <span class="cuenta">${Math.max(0, Math.ceil((v.enviaEn - Date.now()) / 1000))} s</span></span>`,
    enviando: '<span class="badge acc">Enviando…</span>',
    enviada: '<span class="badge fia-alta">Enviada ✓</span>',
    error: `<span class="badge" style="color:var(--bad)">Error: ${esc(v.error)}</span>`,
  })[v.estado];
  el.innerHTML = M.ventanas.map(v => {
    const h = new Date(v.fin).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<div class="ventana${v.voz ? ' voz' : ''}">
      <div class="vt"><span class="mono">${h}</span>${estado(v)}</div>
      <div class="vm"><span>L90 <b>${fx(v.L90)}</b></span><span>L50 <b>${fx(v.L50)}</b></span><span>Leq ${fx(v.Leq)}</span><span>calidad ${esc(v.calidad)}</span></div>
      ${v.paquete && v.estado !== 'voz' ? `<div class="nota">Qué se envía (exactamente):</div><pre class="paquete">${esc(JSON.stringify(v.paquete, null, 2))}</pre>` : ''}
      ${v.estado === 'lista' ? `<div class="fila"><button class="btn pri" data-enviar="${v.id}">Enviar</button><span class="nota">Se envía con un retardo aleatorio de 0-20 s.</span></div>` : ''}
    </div>`;
  }).join('');
  el.querySelectorAll('[data-enviar]').forEach(b => (b.onclick = () => programarEnvio(M.ventanas.find(v => v.id === b.dataset.enviar))));
}

// ---------------------------------------------------------------------------
// Privacidad: qué se envía, qué guarda el servidor, agregados
// ---------------------------------------------------------------------------
let pestanaPriv = 'envia', timerPriv = null;
function panelPrivacidad(tab) {
  if (tab) pestanaPriv = tab;
  abrirPanel('privacidad', `
    <div class="eyebrow">Privacidad y servidor</div>
    <h2 class="h1" id="sheetTitle">Lo que sale de tu móvil, a la vista</h2>
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="envia" aria-selected="${pestanaPriv === 'envia'}">Qué se envía</button>
      <button role="tab" data-tab="guarda" aria-selected="${pestanaPriv === 'guarda'}">Qué guarda el servidor</button>
      <button role="tab" data-tab="agrega" aria-selected="${pestanaPriv === 'agrega'}">Agregado y descartes</button>
    </div>
    <div id="privBody" role="tabpanel"></div>`);
  $$('[data-tab]').forEach(b => (b.onclick = () => {
    pestanaPriv = b.dataset.tab;
    $$('[data-tab]').forEach(x => x.setAttribute('aria-selected', x === b));
    pintarPrivacidad();
    if (pestanaPriv !== 'envia') cargarRegistros();
  }));
  pintarPrivacidad();
  cargarRegistros();
  clearInterval(timerPriv);
  timerPriv = setInterval(() => { if (S.panel === 'privacidad' && pestanaPriv !== 'envia') cargarRegistros(); }, 10000);
  alCerrar = () => clearInterval(timerPriv);
}

async function cargarRegistros() {
  try {
    const [r, a] = await Promise.all([getJSON('/api/registros?limite=60'), getJSON('/api/agregados?minutos=1440')]);
    S.registros = r;
    S.agregadosDia = a;
    if (S.panel === 'privacidad') pintarPrivacidad();
  } catch (e) {
    S.registros = { error: e.message };
    if (S.panel === 'privacidad') pintarPrivacidad();
  }
}

function pintarPrivacidad() {
  const el = $('#privBody');
  if (!el) return;
  const M = S.medir;
  if (pestanaPriv === 'envia') {
    const ult = M.ventanas.find(v => v.paquete);
    const ejemplo = { celda: 'm150:12:-4', hora: hora5(Date.now()), db: 61.4, calidad: 'buena', token: '3f9c0e5a71b24d6e8a0c19f2b7d45e10' };
    el.innerHTML = `
      <p class="lead">Cada ventana de 30 s genera, como mucho, este paquete. Lo ves completo antes de que salga y puedes enviarlo a mano o activar el envío automático.</p>
      <div class="nota" style="margin-bottom:6px">${ult ? 'Tu último paquete:' : 'Ejemplo (aún no has medido):'}</div>
      <pre class="paquete">${esc(JSON.stringify(ult ? ult.paquete : ejemplo, null, 2))}</pre>
      <dl class="kv" style="margin-top:12px">
        <dt>celda</dt><dd>hexágono de ~150 m</dd>
        <dt>hora</dt><dd>redondeada a 5 min</dd>
        <dt>db</dt><dd>L50 de la ventana</dd>
        <dt>calidad</dt><dd>buena · media · baja</dd>
        <dt>token</dt><dd>aleatorio, nuevo en cada envío</dd>
      </dl>
      <h3 class="h2">Lo que nunca sale del móvil</h3>
      <ul class="lista">
        <li><span class="t">Audio</span><span class="m">Se procesa en memoria y se descarta al instante. No se graba.</span></li>
        <li><span class="t">Coordenadas exactas</span><span class="m">Solo se envía el identificador de la celda.</span></li>
        <li><span class="t">Identificador del dispositivo</span><span class="m">No existe: el token cambia en cada envío y no se puede enlazar con otros.</span></li>
        <li><span class="t">Cuenta, cookies, analítica</span><span class="m">No hay. El envío sale con un retardo aleatorio de 0-20 s, sin cookies ni Referer.</span></li>
      </ul>
      <label class="switch" style="margin-top:10px"><span>Envío automático</span><input type="checkbox" id="pAuto" ${M.auto ? 'checked' : ''}></label>
      ${M.activo ? '' : '<button class="btn pri full" id="pMedir" style="margin-top:8px">Ir a «Medir aquí»</button>'}`;
    const a = $('#pAuto');
    a.onchange = () => { M.auto = a.checked; store.set('autoEnvio', M.auto); if (M.auto) M.ventanas.filter(v => v.estado === 'lista').forEach(programarEnvio); };
    const pm = $('#pMedir');
    if (pm) pm.onclick = panelMedir;
    return;
  }
  const R = S.registros;
  if (!R || R.error) {
    el.innerHTML = `<div class="alerta">${R?.error ? 'No se pudo leer el servidor: ' + esc(R.error) : 'Cargando…'}</div>`;
    return;
  }
  if (pestanaPriv === 'guarda') {
    el.innerHTML = `
      <p class="lead">Estos son los últimos registros tal cual están en la base de datos: los mismos cinco campos y nada más. El servidor no guarda IP, navegador ni coordenadas, y borra todo a las ${S.config.retencion_horas} h.</p>
      <div class="nota" style="margin-bottom:6px">${R.total} registros en las últimas ${S.config.retencion_horas} h${M.mios.size ? ' · resaltados: los que has enviado tú (solo lo sabe este móvil)' : ''}</div>
      <div class="tabla-w"><table class="t">
        <thead><tr><th>celda</th><th>hora</th><th>db</th><th>calidad</th><th>token</th></tr></thead>
        <tbody>${R.registros.length ? R.registros.map(r => `<tr class="${M.mios.has(r.token) ? 'mio' : ''}"><td>${esc(r.celda)}</td><td>${esc(r.hora)}</td><td class="n">${fx(r.db)}</td><td>${esc(r.calidad)}</td><td>${esc(r.token)}</td></tr>`).join('') : '<tr><td colspan="5">Todavía no hay registros. Mide y envía para ver el tuyo aquí.</td></tr>'}</tbody>
      </table></div>
      <button class="btn" id="pRef" style="margin-top:10px">Actualizar</button>`;
    $('#pRef').onclick = cargarRegistros;
    return;
  }
  const A = S.agregadosDia || { grupos: [] };
  el.innerHTML = `
    <p class="lead">El servidor agrupa por celda y ventana de 5 min, calcula la mediana y la MAD, descarta lo que se aleja más de 3 MAD y exige al menos ${A.min_aportes ?? S.config.min_aportes} aportaciones para dar fiabilidad normal.</p>
    ${A.grupos.length ? `<div class="tabla-w"><table class="t">
      <thead><tr><th>celda</th><th>hora</th><th>n</th><th>mediana</th><th>MAD</th><th>fiabilidad</th></tr></thead>
      <tbody>${A.grupos.map(g => `<tr><td>${esc(g.celda)}</td><td>${esc(g.hora)}</td><td class="n">${g.n_validos}/${g.n_recibidos}</td><td class="n">${fx(g.mediana)}</td><td class="n">${fx(g.mad)}</td><td>${esc(g.fiabilidad)}</td></tr>${g.descartados.map(d => `<tr class="desc"><td colspan="2">descartado</td><td></td><td class="n">${fx(d.db)}</td><td colspan="2">${esc(d.motivo)}</td></tr>`).join('')}`).join('')}</tbody>
    </table></div>` : '<div class="alerta info">Sin aportaciones en las últimas 24 h.</div>'}
    <h3 class="h2">Descartes de la campaña 2015 <small>${S.datos.descartadas.length} lecturas</small></h3>
    <p class="nota">Las lecturas marcadas como atípicas sin causa conocida están en Más › Lecturas descartadas.</p>`;
}

async function cargarAgregados() {
  try {
    const a = await getJSON('/api/agregados?minutos=60');
    S.agregados = a.grupos;
    pintarAgregados();
  } catch {}
}
function pintarAgregados() {
  if (!S.mapaListo) return;
  const ult = new Map();
  for (const g of S.agregados) if (!ult.has(g.celda)) ult.set(g.celda, g);
  const feats = [...ult.values()].map(g => {
    const c = parseCelda(g.celda);
    return { type: 'Feature', properties: { celda: g.celda, mediana: g.mediana, n_validos: g.n_validos, fiabilidad: g.fiabilidad }, geometry: { type: 'Polygon', coordinates: [poligonoCelda(c.q, c.r)] } };
  });
  S.map.getSource('aportes')?.setData({ type: 'FeatureCollection', features: feats });
}

// ---------------------------------------------------------------------------
// Más: acerca, descartadas, eventos, ajustes avanzados
// ---------------------------------------------------------------------------
let filtroDesc = 'todas';
function panelMas(abrirAvanzado = false) {
  const d = S.datos;
  const M = S.motor;
  const evTodos = S.sensores.flatMap(s => s.eventos.map(e => ({ ...e, sensor: s.id })));
  const conteo = {};
  evTodos.forEach(e => (conteo[e.etiqueta] = (conteo[e.etiqueta] || 0) + 1));
  const body = abrirPanel('mas', `
    <div class="eyebrow">Acerca de Sordina</div>
    <h2 class="h1" id="sheetTitle">Modo demo</h2>
    <p class="p">Los sensores proceden de una <b>simulación</b>: cada 5 s se genera una lectura por sensor a partir de la mediana de la campaña de ${d.desde.slice(0, 4)} (${d.sensores.length} puntos de medida, ${d.desde} a ${d.hasta}) para el día de la semana y el periodo actuales, con deriva y picos aleatorios. Las mediciones del móvil son <b>orientativas</b> (sin calibrar).</p>
    <p class="nota">Datos: ${d.filas} filas de ${esc(d.fuente)}; se excluyen ${d.filas_excluidas_no_validas} con valido_heatmap = False. Los nombres de calle salen de OpenStreetMap (Nominatim) cuando hay red; si no, se usa el código S01-S${d.sensores.length}. Rutas: OSRM sobre OpenStreetMap.</p>

    <h3 class="h2">Eventos de la campaña <small>${evTodos.length} lecturas reales</small></h3>
    <p class="nota">Lecturas altas con causa conocida. No son errores y se mantienen en los datos.</p>
    <div class="badges">${Object.entries(conteo).map(([k, n]) => `<span class="badge">${esc(k)} · ${n}</span>`).join('')}</div>

    <h3 class="h2">Lecturas descartadas por consenso <small>${d.descartadas.length}</small></h3>
    <div class="seg" role="group" aria-label="Filtrar por motivo" id="fDesc">
      ${[['todas', 'Todas'], ['fallo_sensor', 'Fallo de sensor'], ['valor_bajo_anomalo', 'Valor bajo'], ['pico', 'Picos aislados']].map(([k, t]) => `<button data-f="${k}" aria-pressed="${filtroDesc === k}">${t}</button>`).join('')}
    </div>
    <ul class="lista" id="listaDesc" style="margin-top:8px"></ul>

    <details class="avanzado" id="avz" ${abrirAvanzado ? 'open' : ''}>
      <summary>Ajustes avanzados</summary>
      <label class="switch"><span>Pausar el directo</span><input type="checkbox" id="aPausa" ${M.pausado ? 'checked' : ''}></label>
      <div class="campo"><span class="lbl">Velocidad del reloj simulado</span>
        <div class="seg" role="group" aria-label="Velocidad" id="aVel">${[1, 10, 60, 360].map(v => `<button data-v="${v}" aria-pressed="${M.velocidad === v}">×${v}</button>`).join('')}</div></div>
      <div class="campo"><span class="lbl">Saltar a un cambio de periodo (hoy)</span>
        <div class="fila" id="aSaltar">
          <button class="btn" data-h="6.75">06:45 → día</button>
          <button class="btn" data-h="18.75">18:45 → tarde</button>
          <button class="btn" data-h="22.75">22:45 → noche</button>
          <button class="btn" id="aReal">Hora real</button>
        </div></div>
      <div class="campo"><span class="lbl">Evento</span>
        <button class="btn pri" id="aEvento">Simular evento${S.sel != null ? ' en ' + S.sensores[S.sel].id : ''}</button>
        <span class="nota">Sube 11-16 dB durante 3 min en un sensor (el abierto o uno al azar) y en menor medida a sus vecinos.</span></div>
      <h3 class="h2">Umbrales por perfil</h3>
      ${Object.entries(PERFILES).map(([k, p]) => `<div class="campo"><label for="u_${k}">${esc(p.nombre)} · ${p.metrica === 'ahora' ? 'nivel en directo' : esc(p.metrica)} (dB)</label>
        <input class="in mono" type="number" inputmode="decimal" min="30" max="90" step="0.5" id="u_${k}" value="${perfil(k).umbral}">
        <span class="nota">${esc(p.fuente)}</span></div>`).join('')}
      <button class="btn" id="aReset">Restablecer umbrales</button>
      <p class="nota">Mínimo de aportaciones por celda en el servidor: ${S.config.min_aportes} (variable MIN_APORTES).</p>
    </details>`);
  const pintarDesc = () => {
    const l = d.descartadas.filter(x => filtroDesc === 'todas' || (filtroDesc === 'pico' ? x.tipo.startsWith('pico') : x.tipo === filtroDesc));
    $('#listaDesc').innerHTML = l.slice(0, 80).map(x => `<li><span class="t">${x.sensor}${S.lugares[x.sensor] ? ' · ' + esc(S.lugares[x.sensor]) : ''}</span><span class="v">${x.fecha}</span><span class="m">${esc(x.motivo)} · Ld ${fx(x.Ld)} · Le ${fx(x.Le)} · Ln ${fx(x.Ln)}${x.valido_heatmap ? '' : ' · excluida del mapa'}</span></li>`).join('') + (l.length > 80 ? `<li><span class="m">… y ${l.length - 80} más.</span></li>` : '');
  };
  pintarDesc();
  body.querySelectorAll('#fDesc [data-f]').forEach(b => (b.onclick = () => {
    filtroDesc = b.dataset.f;
    body.querySelectorAll('#fDesc [data-f]').forEach(x => x.setAttribute('aria-pressed', x === b));
    pintarDesc();
  }));
  $('#aPausa').onchange = e => { M.setPausa(e.target.checked); tick(); reloj(); };
  body.querySelectorAll('#aVel [data-v]').forEach(b => (b.onclick = () => {
    M.setVelocidad(+b.dataset.v);
    body.querySelectorAll('#aVel [data-v]').forEach(x => x.setAttribute('aria-pressed', x === b));
    tick(); reloj();
  }));
  body.querySelectorAll('#aSaltar [data-h]').forEach(b => (b.onclick = () => {
    const now = M.ahora(), m = madrid(now);
    M.irA(now - (m.h - +b.dataset.h) * 3600e3);
    tick(); reloj();
    toast(`Reloj simulado en las ${b.textContent.split(' ')[0]}. Sube la velocidad para ver la transición.`);
  }));
  $('#aReal').onclick = () => {
    M.volverATiempoReal();
    body.querySelectorAll('#aVel [data-v]').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === '1'));
    $('#aPausa').checked = false;
    tick(); reloj();
  };
  $('#aEvento').onclick = () => {
    const i = S.sel != null ? S.sel : Math.floor(Math.random() * S.sensores.length);
    M.simularEvento(i);
    tick();
    toast(`Evento simulado en ${S.sensores[i].id}${nombreSensor(i) ? ' (' + nombreSensor(i) + ')' : ''} durante 3 min.`);
    if (S.mapaListo) S.map.easeTo({ center: [S.sensores[i].lon, S.sensores[i].lat], zoom: Math.max(14, S.map.getZoom()), duration: reducir() ? 0 : 700 });
  };
  Object.keys(PERFILES).forEach(k => {
    $('#u_' + k).onchange = e => {
      const v = Number(e.target.value);
      if (!isFinite(v) || v < 30 || v > 90) { e.target.value = perfil(k).umbral; return toast('El umbral debe estar entre 30 y 90 dB.'); }
      S.umbrales[k] = v;
      store.set('umbrales', S.umbrales);
      actualizarCabecera(); actualizarMarcadores(); pintarPerfil();
    };
  });
  $('#aReset').onclick = () => {
    S.umbrales = {};
    store.set('umbrales', {});
    Object.keys(PERFILES).forEach(k => ($('#u_' + k).value = PERFILES[k].umbral));
    actualizarCabecera(); pintarPerfil();
  };
}

// ---------------------------------------------------------------------------
// UI general
// ---------------------------------------------------------------------------
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 3800);
}

function recolocar() {
  const r = document.documentElement.style;
  const h = $('#topbar').getBoundingClientRect().bottom;
  r.setProperty('--hdr', h + 'px');
  const a = $('#avisoPerfil');
  const top = !a.hidden ? a.getBoundingClientRect().bottom + 8 : h + 8;
  r.setProperty('--tools-top', top + 'px');
}

function bindUI() {
  new ResizeObserver(recolocar).observe($('#topbar'));
  new ResizeObserver(recolocar).observe($('#avisoPerfil'));
  window.addEventListener('resize', recolocar);
  const paneles = { perfil: panelPerfil, ruta: panelRuta, medir: panelMedir, privacidad: () => panelPrivacidad(), mas: () => panelMas() };
  $$('[data-panel]').forEach(b => b.addEventListener('click', () => {
    if (S.panel === b.dataset.panel && b.dataset.panel !== 'medir') return cerrarPanel();
    paneles[b.dataset.panel]();
  }));
  $('#btnPerfil').onclick = panelPerfil;
  $('#btnDemo').onclick = () => panelMas();
  $('#sheetClose').onclick = cerrarPanel;
  $$('#capas button').forEach(b => (b.onclick = () => setCapa(b.dataset.capa)));
  const ley = $('#leyenda');
  if (window.innerWidth < 900) ley.classList.add('mini');
  ley.onclick = () => ley.classList.toggle('mini');
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('#modal').hidden) return;
      cerrarPanel();
    }
    if (e.key.toLowerCase() === 'e' && e.altKey) $('#aEvento')?.click();
  });
  // Arrastre del bottom sheet
  const sh = $('#sheet'), h = $('#sheetHandle');
  let y0 = null, alto0 = 0;
  h.addEventListener('pointerdown', e => { y0 = e.clientY; alto0 = sh.getBoundingClientRect().height; h.setPointerCapture(e.pointerId); sh.style.transition = 'none'; });
  h.addEventListener('pointermove', e => { if (y0 == null) return; sh.style.height = Math.max(120, alto0 - (e.clientY - y0)) + 'px'; });
  h.addEventListener('pointerup', e => {
    if (y0 == null) return;
    const dy = e.clientY - y0;
    y0 = null;
    sh.style.transition = '';
    if (Math.abs(dy) < 6) { sh.style.height = ''; sh.classList.toggle('full'); return; }
    if (dy > 140 && alto0 - dy < window.innerHeight * 0.3) return cerrarPanel();
    sh.style.height = '';
    sh.classList.toggle('full', dy < -60);
  });
  h.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sh.classList.toggle('full'); } });
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => actualizarMarcadores());
}

boot().catch(e => {
  console.error(e);
  toast('No se pudieron cargar los datos de los sensores. Recarga la página.');
});

// Para pruebas desde la consola
window.sordina = { S, tick, setPerfil, setCapa, abrirSensor, calcularRutas };
