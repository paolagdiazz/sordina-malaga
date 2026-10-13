// Rejilla hexagonal de ~150 m (misma definición que en server.js).
// Sirve para la superficie de ruido y como celda anónima de las aportaciones.
const LAT0 = 36.72, LON0 = -4.43;
const M_LAT = 111320;
const M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const S = 150 / Math.sqrt(3); // radio centro-vértice
const R3 = Math.sqrt(3);

export const toXY = (lat, lon) => ({ x: (lon - LON0) * M_LON, y: (lat - LAT0) * M_LAT });
export const toLL = (x, y) => ({ lat: LAT0 + y / M_LAT, lon: LON0 + x / M_LON });

export function distM(a, b) {
  const dx = (a.lon - b.lon) * M_LON, dy = (a.lat - b.lat) * M_LAT;
  return Math.hypot(dx, dy);
}

export function celdaDe(lat, lon) {
  const { x, y } = toXY(lat, lon);
  const qf = ((R3 / 3) * x - (1 / 3) * y) / S;
  const rf = ((2 / 3) * y) / S;
  // redondeo cúbico
  let xq = qf, zq = rf, yq = -xq - zq;
  let rx = Math.round(xq), ry = Math.round(yq), rz = Math.round(zq);
  const dx = Math.abs(rx - xq), dy = Math.abs(ry - yq), dz = Math.abs(rz - zq);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz, id: `m150:${rx}:${rz}` };
}

export function centroCelda(q, r) {
  return toLL(S * (R3 * q + (R3 / 2) * r), S * 1.5 * r);
}

export function poligonoCelda(q, r) {
  const c = toXY(centroCelda(q, r).lat, centroCelda(q, r).lon);
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    const p = toLL(c.x + S * Math.cos(a), c.y + S * Math.sin(a));
    pts.push([p.lon, p.lat]);
  }
  pts.push(pts[0]);
  return pts;
}

export function parseCelda(id) {
  const m = /^m150:(-?\d+):(-?\d+)$/.exec(id || '');
  return m ? { q: +m[1], r: +m[2] } : null;
}

// Construye la superficie: celdas a menos de radioMax de algún sensor,
// con sus vecinos y pesos IDW precalculados.
export function construirSuperficie(sensores, radioMax = 500, potencia = 2) {
  const celdas = new Map();
  const pasos = Math.ceil(radioMax / (S * 1.5)) + 1;
  sensores.forEach(s => {
    const c0 = celdaDe(s.lat, s.lon);
    for (let dq = -pasos * 2; dq <= pasos * 2; dq++) {
      for (let dr = -pasos; dr <= pasos; dr++) {
        const q = c0.q + dq, r = c0.r + dr;
        const k = q + ':' + r;
        if (celdas.has(k)) continue;
        const cc = centroCelda(q, r);
        if (distM(cc, s) <= radioMax) celdas.set(k, { q, r, ...cc });
      }
    }
  });
  const lista = [...celdas.values()].map((c, id) => {
    const vecinos = [];
    let dmin = Infinity;
    sensores.forEach((s, i) => {
      const d = distM(c, s);
      if (d <= radioMax) {
        vecinos.push([i, 1 / Math.pow(Math.max(d, 40), potencia)]);
        dmin = Math.min(dmin, d);
      }
    });
    return { id, q: c.q, r: c.r, lat: c.lat, lon: c.lon, vecinos, dmin };
  });
  return lista;
}

// Índice simple para muestrear la superficie en cualquier punto
export function indiceSensores(sensores, radioMax = 500) {
  const tam = radioMax;
  const cubos = new Map();
  sensores.forEach((s, i) => {
    const { x, y } = toXY(s.lat, s.lon);
    const k = Math.floor(x / tam) + ':' + Math.floor(y / tam);
    if (!cubos.has(k)) cubos.set(k, []);
    cubos.get(k).push(i);
  });
  return function cercanos(lat, lon) {
    const { x, y } = toXY(lat, lon);
    const bx = Math.floor(x / tam), by = Math.floor(y / tam);
    const out = [];
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const l = cubos.get(bx + i + ':' + (by + j));
        if (!l) continue;
        for (const idx of l) {
          const d = distM({ lat, lon }, sensores[idx]);
          if (d <= radioMax) out.push([idx, d]);
        }
      }
    return out;
  };
}
