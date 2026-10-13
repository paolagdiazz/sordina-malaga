// Configuración editable de Sordina. Cada umbral lleva su fuente.
// Los umbrales NO se usan para colorear el mapa (casi todo los supera):
// sirven para los avisos y para el recuento de sensores por encima.

export const PERFILES = {
  general: {
    nombre: 'General',
    corto: 'General',
    metrica: 'Lden',
    umbral: 53,
    descripcion: 'Exposición diaria ponderada (día, tarde y noche).',
    enfasis: 'Lden típico del día de hoy',
    fuente: 'OMS 2018, Environmental Noise Guidelines for the European Region: tráfico rodado, Lden 53 dB.',
    oficial: true,
  },
  sueno: {
    nombre: 'Sueño',
    corto: 'Sueño',
    metrica: 'Ln',
    umbral: 45,
    descripcion: 'Resalta el nivel nocturno (23-07 h), el que más afecta al descanso.',
    enfasis: 'Ln típico de la noche de hoy',
    fuente: 'OMS 2018, Environmental Noise Guidelines for the European Region: tráfico rodado, Lnight 45 dB.',
    oficial: true,
  },
  ninos: {
    nombre: 'Niños',
    corto: 'Niños',
    metrica: 'Ld',
    umbral: 55,
    descripcion: 'Resalta el nivel de día (07-19 h), cuando hay colegio y parque.',
    enfasis: 'Ld típico del día de hoy',
    fuente: 'OMS 1999, Guidelines for Community Noise: patios escolares y zonas de juego exteriores, 55 dB LAeq durante el juego.',
    oficial: true,
  },
  migranas: {
    nombre: 'Migrañas',
    corto: 'Migrañas',
    metrica: 'ahora',
    umbral: 50,
    descripcion: 'Mira el nivel de este momento y avisa de los picos.',
    enfasis: 'Nivel en directo y picos',
    fuente: 'Referencia adaptada: OMS 1999, molestia moderada en exteriores, 50 dB LAeq. No existe un umbral oficial para migrañas: ajústalo a tu caso.',
    oficial: false,
  },
  sensorial: {
    nombre: 'Sensibilidad sensorial',
    corto: 'Sensorial',
    metrica: 'ahora',
    umbral: 50,
    descripcion: 'Mira el nivel de este momento y su variabilidad.',
    enfasis: 'Nivel en directo y variabilidad',
    fuente: 'Referencia adaptada: OMS 1999, molestia moderada en exteriores, 50 dB LAeq. No existe un umbral oficial para sensibilidad sensorial: ajústalo a tu caso.',
    oficial: false,
  },
};

export const ESCALA = {
  min: 45,
  max: 85,
  // verde azulado → ámbar → magenta/rojo
  stops: [
    [45, '#1fb7a6'],
    [55, '#62c48a'],
    [63, '#e9c046'],
    [70, '#f59a3a'],
    [77, '#ef4f5a'],
    [85, '#d6248f'],
  ],
  etiquetas: [
    { hasta: 55, texto: 'Tranquilo' },
    { hasta: 65, texto: 'Moderado' },
    { hasta: 75, texto: 'Alto' },
    { hasta: Infinity, texto: 'Muy alto' },
  ],
};

export const SUPERFICIE = {
  celdaM: 150, // hexágonos de ~150 m entre lados
  radioMaxM: 500, // más allá: transparente («sin datos»)
  potenciaIDW: 2,
};

export const MEDICION = {
  // Nivel en dB(A) = dBFS(A) + referenciaNominal + calibración del usuario.
  // La referencia nominal es una aproximación para micrófonos de móvil sin calibrar.
  referenciaNominal: 100,
  calibracion: 0,
  ventanaS: 30,
  bandaVoz: [300, 3400],
};

export const MOTOR = {
  tickMs: 5000,
  transicionMin: 30,
  derivaDb: 1.5,
  picoProbPorSegundo: 1 / 240,
  picoDb: [3, 8],
  picoDuracionS: [2, 4],
};

export function etiquetaNivel(db) {
  if (db == null || !isFinite(db)) return 'Sin datos';
  return ESCALA.etiquetas.find(e => db < e.hasta).texto;
}

function hex2rgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const STOPS_RGB = ESCALA.stops.map(([v, c]) => [v, hex2rgb(c)]);
export function colorNivel(db, alpha = 1) {
  if (db == null || !isFinite(db)) return `rgba(120,130,145,${alpha})`;
  const s = STOPS_RGB;
  if (db <= s[0][0]) return `rgba(${s[0][1].join(',')},${alpha})`;
  for (let i = 1; i < s.length; i++) {
    if (db <= s[i][0]) {
      const t = (db - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
      const c = s[i - 1][1].map((a, k) => Math.round(a + (s[i][1][k] - a) * t));
      return `rgba(${c.join(',')},${alpha})`;
    }
  }
  return `rgba(${s[s.length - 1][1].join(',')},${alpha})`;
}
// Expresión de MapLibre equivalente
export function expresionColor(input) {
  const e = ['interpolate', ['linear'], input];
  for (const [v, c] of ESCALA.stops) e.push(v, c);
  return e;
}
