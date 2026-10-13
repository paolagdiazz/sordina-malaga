// Motor «en directo» de la demo.
// Es determinista: el nivel de un sensor en un instante depende solo de (sensor, instante),
// así que el histórico de la última hora se genera con el mismo método y todos los
// dispositivos ven los mismos valores.
import { MOTOR } from './config.js';
import { distM } from './grid.js';

// --- utilidades deterministas ---------------------------------------------
function hash(a, b, c = 0) {
  let h = 2166136261 ^ a;
  h = Math.imul(h ^ (b | 0), 16777619);
  h = Math.imul(h ^ (Math.floor(b / 4294967296) | 0), 16777619);
  h = Math.imul(h ^ c, 16777619);
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const suave = t => t * t * (3 - 2 * t);
function ruidoValor(semilla, tS, periodoS, canal) {
  const x = tS / periodoS, i = Math.floor(x), f = suave(x - i);
  const a = hash(semilla, i, canal) * 2 - 1, b = hash(semilla, i + 1, canal) * 2 - 1;
  return a + (b - a) * f;
}

// --- hora local de Madrid ---------------------------------------------------
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const cacheOffset = new Map();
function offsetMadrid(ms) {
  const k = Math.floor(ms / 3600e3);
  if (cacheOffset.has(k)) return cacheOffset.get(k);
  const p = Object.fromEntries(fmt.formatToParts(new Date(k * 3600e3)).map(x => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = local - k * 3600e3;
  if (cacheOffset.size > 500) cacheOffset.clear();
  cacheOffset.set(k, off);
  return off;
}
export function madrid(ms) {
  const d = new Date(ms + offsetMadrid(ms));
  return {
    h: d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600,
    dow: (d.getUTCDay() + 6) % 7, // 0 = lunes
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(),
  };
}
export function periodoDe(h) {
  if (h >= 7 && h < 19) return 'Ld';
  if (h >= 19 && h < 23) return 'Le';
  return 'Ln';
}
export const NOMBRE_PERIODO = { Ld: 'Día', Le: 'Tarde', Ln: 'Noche' };

// Nivel típico (mediana) para un periodo, teniendo en cuenta que la noche
// que empieza a las 23 h del día D se registra en la fila del día D.
function tipico(s, per, dow, h) {
  if (per === 'Ln' && h < 12) return s.tipico.Ln[(dow + 6) % 7];
  return s.tipico[per][dow];
}

// Nivel base con transición suave de 30 min centrada en cada cambio de periodo
const FRONTERAS = [
  [7, 'Ln', 'Ld'],
  [19, 'Ld', 'Le'],
  [23, 'Le', 'Ln'],
];
export function nivelBase(s, ms) {
  const { h, dow } = madrid(ms);
  const mitad = MOTOR.transicionMin / 120; // en horas
  for (const [b, antes, despues] of FRONTERAS) {
    if (Math.abs(h - b) < mitad) {
      const w = suave((h - (b - mitad)) / (2 * mitad));
      const vA = tipico(s, antes, dow, antes === 'Ln' ? 0 : h);
      const vD = tipico(s, despues, dow, despues === 'Ln' ? 23 : h);
      return { valor: vA + (vD - vA) * w, periodo: w < 0.5 ? antes : despues, transicion: true };
    }
  }
  const per = periodoDe(h);
  return { valor: tipico(s, per, dow, h), periodo: per, transicion: false };
}

export class Motor {
  constructor(sensores) {
    this.sensores = sensores;
    this.velocidad = 1;
    this.pausado = false;
    this.anclaReal = Date.now();
    this.anclaSim = Date.now();
    this.eventos = []; // eventos simulados {i, inicio, dur, amp}
    // vecinos para propagar eventos simulados
    this.vecinos = sensores.map(a => sensores.map((b, j) => [j, distM(a, b)]).filter(([, d]) => d < 700 && d > 0));
  }
  ahora() {
    if (this.pausado) return this.anclaSim;
    return this.anclaSim + (Date.now() - this.anclaReal) * this.velocidad;
  }
  reanclar() {
    this.anclaSim = this.ahora();
    this.anclaReal = Date.now();
  }
  setVelocidad(v) { this.reanclar(); this.velocidad = v; }
  setPausa(p) { this.reanclar(); this.pausado = p; }
  irA(ms) { this.anclaSim = ms; this.anclaReal = Date.now(); }
  volverATiempoReal() { this.velocidad = 1; this.pausado = false; this.irA(Date.now()); }

  simularEvento(i, ms = this.ahora()) {
    const ev = { i, inicio: ms, dur: 3 * 60e3, amp: 11 + hash(i, ms, 9) * 5 };
    this.eventos.push(ev);
    return ev;
  }

  // Aportaciones simuladas por zona (1-8), cambian cada 30 min
  aportaciones(i, ms) {
    const r = hash(i, Math.floor(ms / 1800e3), 41);
    const n = 1 + Math.floor(r * r * 0.4 * 8 + r * 0.6 * 8); // sesgo hacia 3-6
    return Math.min(8, Math.max(1, n));
  }
  fiabilidad(n) {
    return n < 2 ? 'baja' : n < 5 ? 'media' : 'alta';
  }

  extraEvento(i, ms) {
    let extra = 0;
    for (const ev of this.eventos) {
      if (ms < ev.inicio || ms > ev.inicio + ev.dur) continue;
      const fase = (ms - ev.inicio) / ev.dur;
      const env = Math.min(1, fase * 8) * Math.min(1, (1 - fase) * 5);
      if (ev.i === i) extra += ev.amp * env;
      else {
        const v = this.vecinos[ev.i].find(([j]) => j === i);
        if (v) extra += ev.amp * env * Math.max(0, 1 - v[1] / 700) * 0.7;
      }
    }
    return extra;
  }

  // Lectura de un sensor en un instante
  lectura(i, ms) {
    const s = this.sensores[i];
    const base = nivelBase(s, ms);
    const tS = ms / 1000;
    // deriva correlacionada (±1-2 dB)
    const deriva =
      MOTOR.derivaDb *
      (0.55 * ruidoValor(i, tS, 70, 1) + 0.35 * ruidoValor(i, tS, 290, 2) + 0.2 * ruidoValor(i, tS, 17, 3));
    // picos ocasionales de 3-8 dB y 2-4 s
    let pico = 0;
    const seg = Math.floor(tS);
    for (let k = seg - 4; k <= seg; k++) {
      if (hash(i, k, 7) < MOTOR.picoProbPorSegundo) {
        const dur = MOTOR.picoDuracionS[0] + Math.floor(hash(i, k, 8) * (MOTOR.picoDuracionS[1] - MOTOR.picoDuracionS[0] + 1));
        if (tS >= k && tS < k + dur) {
          const amp = MOTOR.picoDb[0] + hash(i, k, 11) * (MOTOR.picoDb[1] - MOTOR.picoDb[0]);
          const env = Math.min(1, (tS - k) / 0.3) * Math.min(1, (k + dur - tS) / 0.5);
          pico = Math.max(pico, amp * env);
        }
      }
    }
    const ev = this.extraEvento(i, ms);
    // suma energética del evento
    const conEvento = ev > 0 ? 10 * Math.log10(Math.pow(10, (base.valor + deriva) / 10) + Math.pow(10, (base.valor + ev) / 10)) : base.valor + deriva;
    const valor = conEvento + pico;
    return { valor, base: base.valor, periodo: base.periodo, transicion: base.transicion, pico: pico > 0.5, evento: ev > 0.5 };
  }

  todas(ms) {
    return this.sensores.map((_, i) => this.lectura(i, ms));
  }

  historico(i, finMs, minutos = 60, pasoS = 5) {
    const out = [];
    for (let t = finMs - minutos * 60e3; t <= finMs; t += pasoS * 1000) out.push([t, this.lectura(i, t).valor]);
    return out;
  }
}
