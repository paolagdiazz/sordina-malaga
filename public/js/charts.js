// Gráficos SVG hechos a mano: medidor, tendencia, típicos y patrón semanal.
import { colorNivel, etiquetaNivel, ESCALA } from './config.js';

export const reducirMovimiento = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const NS = 'http://www.w3.org/2000/svg';
const fx = (v, d = 1) => (v == null || !isFinite(v) ? '—' : v.toFixed(d).replace('.', ','));
export { fx };

export function contar(el, hasta, dec = 1, ms = 600) {
  if (!el) return;
  const desde = parseFloat(el.dataset.v ?? 'NaN');
  el.dataset.v = hasta;
  if (!isFinite(desde) || reducirMovimiento() || !isFinite(hasta)) {
    el.textContent = fx(hasta, dec);
    return;
  }
  const t0 = performance.now();
  const paso = t => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fx(desde + (hasta - desde) * e, dec);
    if (k < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

// --- Medidor semicircular ---------------------------------------------------
function polar(cx, cy, r, ang) {
  return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
}
function arco(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
  const grande = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${grande} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}
const ANG0 = Math.PI * 0.8, ANG1 = Math.PI * 2.2; // 252°
const angDe = v => ANG0 + ((Math.min(ESCALA.max, Math.max(ESCALA.min, v)) - ESCALA.min) / (ESCALA.max - ESCALA.min)) * (ANG1 - ANG0);

export function medidor(cont, { titulo = 'Nivel actual' } = {}) {
  const cx = 110, cy = 122, r = 84;
  let pistas = '';
  for (let v = ESCALA.min; v < ESCALA.max; v += 1) {
    pistas += `<path d="${arco(cx, cy, r, angDe(v), angDe(v + 1.04))}" stroke="${colorNivel(v + 0.5, 0.28)}" />`;
  }
  let marcas = '';
  for (let v = ESCALA.min; v <= ESCALA.max; v += 5) {
    const a = angDe(v), mayor = v % 10 === 5;
    const [x0, y0] = polar(cx, cy, r + 9, a), [x1, y1] = polar(cx, cy, r + (mayor ? 16 : 13), a);
    marcas += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" class="g-tick${mayor ? ' mayor' : ''}"/>`;
    if (mayor) {
      const [tx, ty] = polar(cx, cy, r + 27, a);
      marcas += `<text x="${tx}" y="${ty + 4}" class="g-lbl">${v}</text>`;
    }
  }
  cont.innerHTML = `
    <svg viewBox="0 0 220 214" class="gauge" role="img" aria-label="${titulo}">
      <g fill="none" stroke-width="12" stroke-linecap="butt">${pistas}</g>
      <path class="g-val" fill="none" stroke-width="12" stroke-linecap="round" d=""/>
      ${marcas}
      <circle class="g-tip" r="7" cx="0" cy="0"/>
      <text x="${cx}" y="${cy + 6}" class="g-num">—</text>
      <text x="${cx}" y="${cy + 28}" class="g-unit">dB(A)</text>
      <text x="${cx}" y="${cy + 70}" class="g-cat">—</text>
    </svg>`;
  const svg = cont.firstElementChild;
  const pv = svg.querySelector('.g-val'), tip = svg.querySelector('.g-tip');
  const num = svg.querySelector('.g-num'), cat = svg.querySelector('.g-cat');
  let actual = null;
  function pintar(v) {
    const a = angDe(v);
    pv.setAttribute('d', arco(cx, cy, r, ANG0, Math.max(ANG0 + 0.001, a)));
    pv.setAttribute('stroke', colorNivel(v));
    const [x, y] = polar(cx, cy, r, a);
    tip.setAttribute('cx', x); tip.setAttribute('cy', y);
    tip.setAttribute('fill', colorNivel(v));
    num.textContent = fx(v);
  }
  return {
    set(v) {
      cat.textContent = etiquetaNivel(v);
      if (reducirMovimiento()) { pintar(v); actual = v; return; }
      const v0 = actual ?? ESCALA.min, t0 = performance.now();
      actual = v;
      const paso = t => {
        const k = Math.min(1, (t - t0) / 650), e = 1 - Math.pow(1 - k, 3);
        pintar(v0 + (v - v0) * e);
        if (k < 1) requestAnimationFrame(paso);
      };
      requestAnimationFrame(paso);
    },
  };
}

// --- Tendencia de 60 min -------------------------------------------------------
export function tendencia(cont, serie, { umbral = null, etiquetaUmbral = '' } = {}) {
  const W = 340, H = 150, ml = 30, mr = 10, mt = 10, mb = 22;
  const vals = serie.map(p => p[1]);
  let lo = Math.floor((Math.min(...vals, umbral ?? Infinity) - 2) / 5) * 5;
  let hi = Math.ceil((Math.max(...vals) + 2) / 5) * 5;
  if (umbral != null && umbral < lo - 10) lo = Math.floor((Math.min(...vals) - 2) / 5) * 5;
  if (hi - lo < 10) hi = lo + 10;
  const t0 = serie[0][0], t1 = serie[serie.length - 1][0];
  const X = t => ml + ((t - t0) / (t1 - t0)) * (W - ml - mr);
  const Y = v => mt + (1 - (v - lo) / (hi - lo)) * (H - mt - mb);
  // reducir a 1 punto cada 15 s para el trazo
  const pts = [];
  for (let i = 0; i < serie.length; i += 3) pts.push(serie[i]);
  if (pts[pts.length - 1] !== serie[serie.length - 1]) pts.push(serie[serie.length - 1]);
  const linea = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const area = `${linea}L${X(t1).toFixed(1)},${Y(lo)}L${X(t0).toFixed(1)},${Y(lo)}Z`;
  let rejilla = '';
  for (let v = lo; v <= hi; v += 5) {
    rejilla += `<line x1="${ml}" x2="${W - mr}" y1="${Y(v)}" y2="${Y(v)}" class="c-grid"/><text x="${ml - 6}" y="${Y(v) + 3.5}" class="c-ax" text-anchor="end">${v}</text>`;
  }
  const ultimo = serie[serie.length - 1];
  const col = colorNivel(ultimo[1]);
  let lu = '';
  if (umbral != null && umbral >= lo && umbral <= hi) {
    lu = `<line x1="${ml}" x2="${W - mr}" y1="${Y(umbral)}" y2="${Y(umbral)}" class="c-umbral"/><text x="${W - mr}" y="${Y(umbral) - 4}" class="c-ax c-umbral-t" text-anchor="end">${etiquetaUmbral}</text>`;
  }
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  const primeraVez = !cont.querySelector('svg');
  cont.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="trend" role="img" aria-label="Tendencia de los últimos 60 minutos: de ${fx(vals[0])} a ${fx(ultimo[1])} dB">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${col}" stop-opacity=".38"/><stop offset="1" stop-color="${col}" stop-opacity="0"/>
      </linearGradient></defs>
      ${rejilla}${lu}
      <path d="${area}" fill="url(#${id})" class="c-area"/>
      <path d="${linea}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" class="c-line${primeraVez && !reducirMovimiento() ? ' dibuja' : ''}" pathLength="1"/>
      <circle cx="${X(ultimo[0])}" cy="${Y(ultimo[1])}" r="4" fill="${col}" class="c-end"/>
      <text x="${ml}" y="${H - 5}" class="c-ax">−60 min</text>
      <text x="${(ml + W - mr) / 2}" y="${H - 5}" class="c-ax" text-anchor="middle">−30</text>
      <text x="${W - mr}" y="${H - 5}" class="c-ax" text-anchor="end">ahora</text>
    </svg>`;
}

// --- Niveles típicos de hoy ------------------------------------------------
export function tipicos(cont, filas, { umbral = null, enfasis = null } = {}) {
  const lo = 35, hi = 85;
  const P = v => ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100;
  cont.innerHTML = filas
    .map(f => {
      const sobre = umbral != null && f.metrica === enfasis && f.valor > umbral;
      return `<div class="tb-row${f.metrica === enfasis ? ' enf' : ''}">
        <span class="tb-k">${f.nombre}<small>${f.horas}</small></span>
        <span class="tb-bar" aria-hidden="true"><i style="--w:${P(f.valor)}%;--c:${colorNivel(f.valor)}"></i>${
          f.metrica === enfasis && umbral != null ? `<b class="tb-um" style="left:${P(umbral)}%" title="Tu umbral"></b>` : ''
        }</span>
        <span class="tb-v mono">${fx(f.valor)}<small> dB</small>${sobre ? `<em class="tb-plus">+${fx(f.valor - umbral)}</em>` : ''}</span>
      </div>`;
    })
    .join('');
}

// --- Patrón semanal --------------------------------------------------------
export function semanal(cont, s, hoy, enfasis) {
  const dias = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const nombres = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const filas = [['Ld', 'Día'], ['Le', 'Tarde'], ['Ln', 'Noche']];
  let html = `<div class="wk" role="table" aria-label="Patrón semanal de niveles típicos"><div class="wk-r" role="row"><span role="columnheader"></span>${dias
    .map((d, i) => `<span class="wk-h${i === hoy ? ' hoy' : ''}" role="columnheader" aria-label="${nombres[i]}">${d}</span>`)
    .join('')}</div>`;
  for (const [k, n] of filas) {
    html += `<div class="wk-r${k === enfasis ? ' enf' : ''}" role="row"><span class="wk-k" role="rowheader">${n}</span>${s.tipico[k]
      .map(
        (v, i) =>
          `<span role="cell" class="wk-c${i === hoy ? ' hoy' : ''}" style="--c:${colorNivel(v, 0.85)}" aria-label="${n}, ${nombres[i]}: ${fx(v)} dB">${Math.round(v)}</span>`,
      )
      .join('')}</div>`;
  }
  cont.innerHTML = html + '</div>';
}

export function sparkline(cont, vals, col) {
  const W = 120, H = 28;
  const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * W).toFixed(1)},${(H - ((v - lo) / (hi - lo)) * H).toFixed(1)}`).join('');
  cont.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="${col}" stroke-width="1.5"/></svg>`;
}
export { NS };
