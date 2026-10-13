// Convierte data/campana_completa_geo.csv en public/data/sensores.json
// Uso: node scripts/build-data.js   (sin dependencias)
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'data', 'campana_completa_geo.csv');
const OUT = path.join(__dirname, '..', 'public', 'data', 'sensores.json');

const EVENTOS = {
  obras: 'Obras',
  montaje_feria: 'Montaje de la Feria',
  evento_feria: 'Feria de Málaga',
  evento_partido: 'Partido de fútbol',
  evento_san_juan: 'Noche de San Juan',
};
const MOTIVOS = {
  fallo_sensor: 'Fallo de sensor: valores en 0 o sin muestras',
  valor_bajo_anomalo: 'Valor anormalmente bajo frente a su propia serie',
  pico_aislado_ld: 'Pico aislado en el periodo de día (Ld) sin causa conocida',
  pico_aislado_le: 'Pico aislado en el periodo de tarde (Le) sin causa conocida',
  pico_aislado_ln: 'Pico aislado en el periodo de noche (Ln) sin causa conocida',
};

function parseCSV(txt) {
  const lines = txt.replace(/\r/g, '').split('\n').filter(Boolean);
  const head = lines[0].split(',');
  return lines.slice(1).map(l => {
    const c = l.split(',');
    const o = {};
    head.forEach((h, i) => (o[h] = c[i]));
    return o;
  });
}
const num = v => (v === '' || v == null ? null : Number(v));
const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = v => (v == null ? null : Math.round(v * 10) / 10);

const rows = parseCSV(fs.readFileSync(SRC, 'utf8')).map(r => {
  const [d, m, y] = r.time.split('/').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return {
    fecha: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    dow: (date.getUTCDay() + 6) % 7, // 0 = lunes
    Ld: num(r.Ld), Le: num(r.Le), Ln: num(r.Ln), Lden: num(r.Lden),
    lat: Number(r.latitude), lon: Number(r.longitude),
    atipico: r.atipico === 'True',
    tipo: r.tipo_atipico || null,
    valido: r.valido_heatmap === 'True',
    peso: num(r.peso_heatmap),
  };
});

// Ubicaciones únicas -> S01..S86 ordenadas de oeste a este
const locs = new Map();
for (const r of rows) {
  const k = `${r.lat},${r.lon}`;
  if (!locs.has(k)) locs.set(k, { lat: r.lat, lon: r.lon, rows: [] });
  locs.get(k).rows.push(r);
}
const ordered = [...locs.values()].sort((a, b) => a.lon - b.lon || b.lat - a.lat);

const descartadas = [];
const sensores = ordered.map((L, i) => {
  const id = 'S' + String(i + 1).padStart(2, '0');
  const tipicas = L.rows.filter(r => r.valido && !r.atipico);
  const validas = L.rows.filter(r => r.valido);
  const tipico = { Ld: [], Le: [], Ln: [], Lden: [] };
  const global = {};
  for (const k of ['Ld', 'Le', 'Ln', 'Lden']) {
    global[k] = r1(median(tipicas.map(r => r[k])));
    for (let d = 0; d < 7; d++) {
      const v = median(tipicas.filter(r => r.dow === d).map(r => r[k]));
      tipico[k].push(r1(v ?? global[k]));
    }
  }
  const eventos = [];
  for (const r of L.rows) {
    if (!r.tipo) continue;
    if (EVENTOS[r.tipo]) {
      eventos.push({ fecha: r.fecha, tipo: r.tipo, etiqueta: EVENTOS[r.tipo], Ld: r.Ld, Le: r.Le, Ln: r.Ln, Lden: r.Lden });
    } else {
      descartadas.push({ sensor: id, fecha: r.fecha, tipo: r.tipo, motivo: MOTIVOS[r.tipo] || r.tipo, Ld: r.Ld, Le: r.Le, Ln: r.Ln, Lden: r.Lden, valido_heatmap: r.valido });
    }
  }
  eventos.sort((a, b) => a.fecha.localeCompare(b.fecha));
  const pesos = validas.map(r => r.peso).filter(v => v != null);
  return {
    id, lat: L.lat, lon: L.lon, nombre: null,
    dias: L.rows.length, dias_tipicos: tipicas.length,
    peso_heatmap: pesos.length ? Math.round((pesos.reduce((a, b) => a + b, 0) / pesos.length) * 1000) / 1000 : null,
    tipico, tipico_global: global, eventos,
  };
});
descartadas.sort((a, b) => b.fecha.localeCompare(a.fecha) || a.sensor.localeCompare(b.sensor));

const fechas = rows.map(r => r.fecha).sort();
const out = {
  fuente: 'campana_completa_geo.csv',
  filas: rows.length,
  filas_excluidas_no_validas: rows.filter(r => !r.valido).length,
  desde: fechas[0], hasta: fechas[fechas.length - 1],
  dias_semana: ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'],
  sensores, descartadas,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`${sensores.length} sensores, ${rows.length} filas, ${descartadas.length} descartadas, ${sensores.reduce((a, s) => a + s.eventos.length, 0)} eventos, ${fechas[0]}..${fechas[fechas.length - 1]}`);
