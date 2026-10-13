// Sordina · servidor de la demo (Node >= 22.13, sin dependencias externas)
// - Sirve la app (carpeta public/)
// - POST /api/ingest: recibe aportaciones anónimas {celda, hora, db, calidad, token}
// - Agrega por celda y ventana de 5 min con mediana y MAD
// - Hace de intermediario con OSRM (rutas a pie) y Nominatim (buscador y nombres de calle)
// No guarda IP, User-Agent ni cookies. No escribe registros de acceso.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// Configuración (todo editable por variables de entorno)
// ---------------------------------------------------------------------------
const CONFIG = {
  puerto: Number(process.env.PORT || 3000),
  bd: process.env.DB_PATH || path.join(__dirname, 'data', 'sordina.db'),
  minAportes: Number(process.env.MIN_APORTES || 2), // mínimo por celda y ventana para fiabilidad normal
  retencionHoras: Number(process.env.RETENCION_HORAS || 24), // purga de la demo
  ventanaMin: 5, // la hora se redondea a 5 min
  celdaM: 150, // rejilla hexagonal de ~150 m (equivalente a H3 res. 9)
  limiteTasa: Number(process.env.LIMITE_TASA || 30), // envíos por cliente y 10 min (en memoria)
  limiteGlobal: Number(process.env.LIMITE_GLOBAL || 2000), // envíos totales por 10 min
  osrm: process.env.OSRM_URL || 'https://routing.openstreetmap.de/routed-foot',
  osrmBici: process.env.OSRM_BICI_URL || 'https://routing.openstreetmap.de/routed-bike',
  nominatim: process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
  geocodificar: process.env.GEOCODIFICAR !== '0',
  agenteHttp: 'Sordina-Malaga-demo/1.0 (MVP ruido urbano; uso puntual)',
};

// Caja de Málaga ampliada (validación de celdas y rutas)
const BBOX = { minLat: 36.60, maxLat: 36.82, minLon: -4.65, maxLon: -4.25 };

// ---------------------------------------------------------------------------
// Rejilla hexagonal de 150 m (misma definición que public/js/grid.js)
// ---------------------------------------------------------------------------
const GRID = (() => {
  const lat0 = 36.72, lon0 = -4.43;
  const mLat = 111320, mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const s = CONFIG.celdaM / Math.sqrt(3); // radio (centro-vértice) para 150 m entre lados
  const centro = (q, r) => {
    const x = s * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
    const y = s * 1.5 * r;
    return { lat: lat0 + y / mLat, lon: lon0 + x / mLon };
  };
  const parse = id => {
    const m = /^m150:(-?\d{1,4}):(-?\d{1,4})$/.exec(String(id));
    if (!m) return null;
    const q = Number(m[1]), r = Number(m[2]);
    const c = centro(q, r);
    if (c.lat < BBOX.minLat || c.lat > BBOX.maxLat || c.lon < BBOX.minLon || c.lon > BBOX.maxLon) return null;
    return { q, r, ...c };
  };
  return { centro, parse };
})();

// ---------------------------------------------------------------------------
// Base de datos: solo los cinco campos del paquete
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(CONFIG.bd), { recursive: true });
const db = new DatabaseSync(CONFIG.bd);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS aportes (
    celda   TEXT NOT NULL,
    hora    TEXT NOT NULL,
    db      REAL NOT NULL,
    calidad TEXT NOT NULL,
    token   TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS aportes_hora ON aportes(hora);
  CREATE TABLE IF NOT EXISTS lugares (sensor TEXT PRIMARY KEY, nombre TEXT NOT NULL);
`);
const q = {
  insertar: db.prepare('INSERT INTO aportes (celda, hora, db, calidad, token) VALUES (?, ?, ?, ?, ?)'),
  recientes: db.prepare('SELECT celda, hora, db, calidad, token FROM aportes ORDER BY rowid DESC LIMIT ?'),
  desde: db.prepare('SELECT celda, hora, db, calidad, token FROM aportes WHERE hora >= ?'),
  total: db.prepare('SELECT COUNT(*) AS n FROM aportes'),
  purgar: db.prepare('DELETE FROM aportes WHERE hora < ?'),
  lugares: db.prepare('SELECT sensor, nombre FROM lugares'),
  lugar: db.prepare('INSERT OR REPLACE INTO lugares (sensor, nombre) VALUES (?, ?)'),
};

const isoMin = d => d.toISOString().slice(0, 16) + 'Z'; // 2026-10-13T10:15Z

function purgar() {
  const limite = isoMin(new Date(Date.now() - CONFIG.retencionHoras * 3600e3));
  q.purgar.run(limite);
}
purgar();
setInterval(purgar, 10 * 60e3).unref();

// ---------------------------------------------------------------------------
// Limitación de tasa sin persistir identificadores
// La clave es un HMAC de la IP con una sal aleatoria que se regenera cada 10 min.
// Vive solo en memoria y se borra entera en cada rotación. Nunca se escribe en disco.
// ---------------------------------------------------------------------------
let sal = crypto.randomBytes(32);
let contadores = new Map();
let globalCount = 0;
setInterval(() => {
  sal = crypto.randomBytes(32);
  contadores = new Map();
  globalCount = 0;
}, 10 * 60e3).unref();

function permitido(req) {
  if (++globalCount > CONFIG.limiteGlobal) return false;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const k = crypto.createHmac('sha256', sal).update(ip).digest('base64').slice(0, 16);
  const n = (contadores.get(k) || 0) + 1;
  contadores.set(k, n);
  return n <= CONFIG.limiteTasa;
}

// ---------------------------------------------------------------------------
// Validación del paquete
// ---------------------------------------------------------------------------
const CAMPOS = ['celda', 'hora', 'db', 'calidad', 'token'];
const CALIDADES = ['buena', 'media', 'baja'];

function validar(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'El cuerpo debe ser un objeto JSON.';
  const claves = Object.keys(p).sort();
  if (claves.join() !== [...CAMPOS].sort().join()) return 'Solo se aceptan los campos: ' + CAMPOS.join(', ') + '.';
  if (!GRID.parse(p.celda)) return 'Celda no válida o fuera de Málaga.';
  if (typeof p.hora !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/.test(p.hora)) return 'Hora con formato no válido.';
  const t = Date.parse(p.hora);
  if (!Number.isFinite(t) || new Date(t).getUTCMinutes() % CONFIG.ventanaMin) return 'La hora debe ir redondeada a 5 min.';
  if (t > Date.now() + 5 * 60e3 || t < Date.now() - CONFIG.retencionHoras * 3600e3) return 'Hora fuera de rango.';
  if (typeof p.db !== 'number' || !Number.isFinite(p.db) || p.db < 30 || p.db > 130) return 'dB fuera del rango 30-130.';
  if (!CALIDADES.includes(p.calidad)) return 'Indicador de calidad no válido.';
  if (typeof p.token !== 'string' || !/^[0-9a-f]{32}$/.test(p.token)) return 'Token no válido.';
  return null;
}

// ---------------------------------------------------------------------------
// Agregación: mediana y MAD por celda y ventana de 5 min
// ---------------------------------------------------------------------------
const mediana = a => {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function agregar(minutos = 60) {
  const desde = isoMin(new Date(Date.now() - minutos * 60e3 - CONFIG.ventanaMin * 60e3));
  const grupos = new Map();
  for (const r of q.desde.all(desde)) {
    const k = r.celda + '|' + r.hora;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(r);
  }
  const out = [];
  for (const filas of grupos.values()) {
    const vals = filas.map(f => f.db);
    const med = mediana(vals);
    const mad = mediana(vals.map(v => Math.abs(v - med)));
    const umbral = 3 * Math.max(mad, 0.5);
    const validos = filas.filter(f => Math.abs(f.db - med) <= umbral);
    const descartados = filas.filter(f => Math.abs(f.db - med) > umbral);
    const medFinal = mediana(validos.map(f => f.db));
    const n = validos.length;
    const c = GRID.parse(filas[0].celda);
    out.push({
      celda: filas[0].celda,
      hora: filas[0].hora,
      lat: Number(c.lat.toFixed(5)),
      lon: Number(c.lon.toFixed(5)),
      n_recibidos: filas.length,
      n_validos: n,
      mediana: Math.round(medFinal * 10) / 10,
      mad: Math.round(mad * 10) / 10,
      fiabilidad: n < CONFIG.minAportes ? 'baja' : n >= 5 ? 'alta' : 'media',
      descartados: descartados.map(f => ({
        db: f.db,
        motivo: `|${f.db} − ${med.toFixed(1)}| > 3 × MAD (${(3 * Math.max(mad, 0.5)).toFixed(1)} dB)`,
      })),
    });
  }
  out.sort((a, b) => b.hora.localeCompare(a.hora) || a.celda.localeCompare(b.celda));
  return out;
}

// ---------------------------------------------------------------------------
// Llamadas externas (OSRM, Nominatim). No se reenvía nada del usuario salvo la consulta.
// ---------------------------------------------------------------------------
async function getJSON(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': CONFIG.agenteHttp, 'Accept-Language': 'es' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function coordsValidas(str) {
  const pts = String(str || '').split(';').map(p => p.split(',').map(Number));
  if (pts.length < 2 || pts.length > 4) return null;
  for (const [lon, lat] of pts) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lat < BBOX.minLat || lat > BBOX.maxLat || lon < BBOX.minLon || lon > BBOX.maxLon) return null;
  }
  return pts.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');
}

// Nombres de calle/barrio para S01..S86 (una vez, 1 petición/s, en segundo plano)
const lugares = new Map(q.lugares.all().map(r => [r.sensor, r.nombre]));
async function geocodificarSensores() {
  if (!CONFIG.geocodificar) return;
  let datos;
  try {
    datos = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'data', 'sensores.json'), 'utf8'));
  } catch {
    return;
  }
  let fallos = 0;
  for (const s of datos.sensores) {
    if (lugares.has(s.id)) continue;
    try {
      const j = await getJSON(`${CONFIG.nominatim}/reverse?format=jsonv2&zoom=17&addressdetails=1&lat=${s.lat}&lon=${s.lon}`);
      const a = j.address || {};
      const calle = a.road || a.pedestrian || a.footway || a.square || a.path || null;
      const barrio = a.neighbourhood || a.quarter || a.suburb || a.city_district || null;
      const nombre = [calle, barrio].filter(Boolean).join(' · ');
      if (nombre) {
        lugares.set(s.id, nombre);
        q.lugar.run(s.id, nombre);
      }
      fallos = 0;
    } catch {
      if (++fallos >= 3) {
        console.log('Geocodificación inversa no disponible: se mantienen los códigos S01…S86.');
        return;
      }
    }
    await new Promise(r => setTimeout(r, 1200)); // política de uso de Nominatim: máx. 1/s
  }
  console.log(`Nombres de lugar disponibles: ${lugares.size}/${datos.sensores.length}`);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const PUBLIC = path.join(__dirname, 'public');
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.cartocdn.com https://tiles.openfreemap.org",
  "connect-src 'self' https://*.cartocdn.com https://tiles.openfreemap.org",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "child-src blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cabeceras(res, extra = {}) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), geolocation=(self), screen-wake-lock=(self), camera=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}
function json(res, code, obj) {
  cabeceras(res, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.writeHead(code);
  res.end(JSON.stringify(obj));
}
function leerCuerpo(req, max = 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const partes = [];
    req.on('data', c => {
      n += c.length;
      if (n > max) {
        reject(new Error('demasiado grande'));
        req.destroy();
      } else partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

async function api(req, res, url) {
  const ruta = url.pathname;

  if (ruta === '/api/ingest' && req.method === 'POST') {
    if (!permitido(req)) return json(res, 429, { error: 'Demasiados envíos seguidos. Prueba en unos minutos.' });
    let p;
    try {
      p = JSON.parse(await leerCuerpo(req));
    } catch {
      return json(res, 400, { error: 'JSON no válido o demasiado grande.' });
    }
    const err = validar(p);
    if (err) return json(res, 422, { error: err });
    try {
      q.insertar.run(p.celda, p.hora, Math.round(p.db * 10) / 10, p.calidad, p.token);
    } catch {
      return json(res, 409, { error: 'Token repetido: ese envío ya se recibió.' });
    }
    return json(res, 201, { ok: true });
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'Método no permitido.' });

  if (ruta === '/api/config') {
    return json(res, 200, {
      min_aportes: CONFIG.minAportes, retencion_horas: CONFIG.retencionHoras,
      ventana_min: CONFIG.ventanaMin, celda_m: CONFIG.celdaM, campos: CAMPOS, calidades: CALIDADES,
    });
  }
  if (ruta === '/api/registros') {
    const lim = Math.min(200, Math.max(1, Number(url.searchParams.get('limite')) || 50));
    return json(res, 200, { total: q.total.get().n, registros: q.recientes.all(lim) });
  }
  if (ruta === '/api/agregados') {
    const min = Math.min(24 * 60, Math.max(5, Number(url.searchParams.get('minutos')) || 60));
    return json(res, 200, { min_aportes: CONFIG.minAportes, grupos: agregar(min) });
  }
  if (ruta === '/api/lugares') return json(res, 200, Object.fromEntries(lugares));

  if (ruta === '/api/ruta') {
    const coords = coordsValidas(url.searchParams.get('coords'));
    if (!coords) return json(res, 400, { error: 'Coordenadas no válidas o fuera de Málaga.' });
    const alt = url.searchParams.get('alternativas') === '0' ? 'false' : '3';
    const bici = url.searchParams.get('perfil') === 'bike';
    const base = bici ? CONFIG.osrmBici : CONFIG.osrm;
    try {
      const j = await getJSON(`${base}/route/v1/${bici ? 'bike' : 'foot'}/${coords}?alternatives=${alt}&overview=full&geometries=geojson&steps=false`);
      return json(res, 200, j);
    } catch (e) {
      return json(res, 502, { error: 'El servicio de rutas no responde ahora mismo.' });
    }
  }
  if (ruta === '/api/buscar') {
    const texto = String(url.searchParams.get('q') || '').slice(0, 120).trim();
    if (texto.length < 3) return json(res, 200, []);
    try {
      const vb = `${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon},${BBOX.minLat}`;
      const j = await getJSON(`${CONFIG.nominatim}/search?format=jsonv2&limit=6&countrycodes=es&bounded=1&viewbox=${vb}&q=${encodeURIComponent(texto)}`);
      return json(res, 200, j.map(r => ({ nombre: r.display_name, lat: Number(r.lat), lon: Number(r.lon) })));
    } catch {
      return json(res, 502, { error: 'El buscador no responde ahora mismo.' });
    }
  }
  return json(res, 404, { error: 'No encontrado.' });
}

function estatico(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUBLIC, p));
  if (!f.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) {
      cabeceras(res, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.writeHead(404);
      return res.end('No encontrado');
    }
    const ext = path.extname(f);
    const cache = /\/vendor\//.test(f) ? 'public, max-age=604800' : ext === '.html' ? 'no-cache' : 'public, max-age=300';
    cabeceras(res, { 'Content-Type': TIPOS[ext] || 'application/octet-stream', 'Cache-Control': cache, 'Content-Length': st.size });
    res.writeHead(200);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  // Sin registros de acceso: no se escribe nada sobre la petición.
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(() => json(res, 500, { error: 'Error interno.' }));
  } else estatico(req, res, url);
});

server.listen(CONFIG.puerto, () => {
  console.log(`Sordina escuchando en http://localhost:${CONFIG.puerto}`);
  geocodificarSensores();
});
