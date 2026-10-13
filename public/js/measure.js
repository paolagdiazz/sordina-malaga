// «Medir aquí»: sonómetro orientativo con Web Audio API.
// El audio se procesa SOLO en memoria: nunca se guarda ni se envía.
import { MEDICION } from './config.js';

// Ponderación A (IEC 61672) en dB para una frecuencia
function pesoA(f) {
  if (f < 10) return -70;
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return 20 * Math.log10(ra) + 2.0;
}

const energia = arr => 10 * Math.log10(arr.reduce((a, v) => a + Math.pow(10, v / 10), 0) / arr.length);
function percentil(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

// Detección de habla probable: proporción de energía en 300-3400 Hz
// y modulación silábica (2-8 Hz) de la envolvente de esa banda.
function analizarVoz(env, ratios, fps) {
  if (env.length < fps * 4) return { voz: false, ratio: 0, modulacion: 0 };
  const ratioMedio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const N = Math.round(fps * 2); // segmentos de 2 s → resolución 0,5 Hz
  let pBanda = 0, pTotal = 0, desv = 0, nseg = 0;
  for (let s = 0; s + N <= env.length; s += N) {
    const seg = env.slice(s, s + N);
    const m = seg.reduce((a, b) => a + b, 0) / N;
    const x = seg.map(v => v - m);
    desv += Math.sqrt(x.reduce((a, b) => a + b * b, 0) / N);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * fps) / N;
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const a = (2 * Math.PI * k * n) / N;
        re += x[n] * Math.cos(a);
        im -= x[n] * Math.sin(a);
      }
      const p = re * re + im * im;
      if (f >= 0.5 && f <= 12) pTotal += p;
      if (f >= 2 && f <= 8) pBanda += p;
    }
    nseg++;
  }
  const modulacion = pTotal ? pBanda / pTotal : 0;
  const profundidad = desv / Math.max(1, nseg);
  const voz = ratioMedio > 0.5 && modulacion > 0.55 && profundidad > 2.5;
  return { voz, ratio: ratioMedio, modulacion, profundidad };
}

export class Sonometro {
  constructor() {
    this.activo = false;
    this.calibracion = MEDICION.calibracion;
    this.referencia = MEDICION.referenciaNominal;
  }

  async iniciar({ alSegundo, alVentana, alEstado }) {
    this.alSegundo = alSegundo; this.alVentana = alVentana; this.alEstado = alEstado || (() => {});
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite usar el micrófono aquí. Abre la app con https.');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      video: false,
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 2048;
    this.an.smoothingTimeConstant = 0;
    src.connect(this.an);
    // salida silenciosa para que Safari mantenga el grafo activo
    const mudo = this.ctx.createGain();
    mudo.gain.value = 0;
    this.an.connect(mudo).connect(this.ctx.destination);

    const sr = this.ctx.sampleRate, n = this.an.frequencyBinCount;
    this.pesos = new Float32Array(n);
    this.enBanda = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const f = (i * sr) / this.an.fftSize;
      this.pesos[i] = Math.pow(10, pesoA(f) / 10);
      this.enBanda[i] = f >= MEDICION.bandaVoz[0] && f <= MEDICION.bandaVoz[1] ? 1 : 0;
    }
    this.espectro = new Float32Array(n);
    this.tiempo = new Float32Array(this.an.fftSize);
    this.fps = 25;
    this.tramas = []; // niveles por trama del segundo en curso
    this.segundos = []; // niveles de 1 s de la ventana en curso
    this.env = []; this.ratios = []; this.saturadas = 0; this.tramasVentana = 0;
    this.inicioVentana = performance.now();
    this.inicioSegundo = performance.now();
    this.activo = true;
    this.timer = setInterval(() => this.trama(), 1000 / this.fps);
    await this.pedirWakeLock();
    document.addEventListener('visibilitychange', this._vis = () => {
      if (document.visibilityState === 'visible' && this.activo) this.pedirWakeLock();
    });
  }

  async pedirWakeLock() {
    try {
      if (!('wakeLock' in navigator)) throw new Error('no');
      this.wake = await navigator.wakeLock.request('screen');
      this.alEstado({ wakeLock: true });
    } catch {
      this.alEstado({ wakeLock: false });
    }
  }

  trama() {
    if (!this.activo) return;
    this.an.getFloatTimeDomainData(this.tiempo);
    this.an.getFloatFrequencyData(this.espectro);
    let suma = 0, pico = 0;
    for (let i = 0; i < this.tiempo.length; i++) {
      const v = this.tiempo[i];
      suma += v * v;
      if (Math.abs(v) > pico) pico = Math.abs(v);
    }
    if (pico > 0.99) this.saturadas++;
    const rms = Math.sqrt(suma / this.tiempo.length);
    // El silencio digital (arranque del micro, cortes) no es una medida: no se cuenta
    if (rms > 1e-6) {
      let pTot = 0, pA = 0, pBanda = 0;
      for (let i = 1; i < this.espectro.length; i++) {
        const p = Math.pow(10, this.espectro[i] / 10);
        if (!isFinite(p)) continue;
        pTot += p; pA += p * this.pesos[i];
        if (this.enBanda[i]) pBanda += p;
      }
      const corrA = pTot > 0 ? 10 * Math.log10(pA / pTot) : 0;
      const nivel = 20 * Math.log10(rms) + corrA + this.referencia + this.calibracion;
      this.tramas.push(nivel);
      this.tramasVentana++;
      this.env.push(10 * Math.log10(pBanda + 1e-12));
      this.ratios.push(pTot > 0 ? pBanda / pTot : 0);
    }

    const ahora = performance.now();
    if (ahora - this.inicioSegundo >= 1000) {
      this.inicioSegundo = ahora;
      this.nSeg = (this.nSeg || 0) + 1;
      if (this.tramas.length) {
        const l1 = energia(this.tramas);
        this.segundos.push(l1);
        this.alSegundo?.(l1, this.nSeg);
      } else this.alSegundo?.(null, this.nSeg);
      this.tramas = [];
      if (this.nSeg >= MEDICION.ventanaS) {
        this.nSeg = 0;
        if (this.segundos.length >= 10) this.cerrarVentana();
        else this.descartarVentana();
      }
    }
  }

  descartarVentana() {
    this.segundos = []; this.env = []; this.ratios = []; this.saturadas = 0; this.tramasVentana = 0;
  }

  cerrarVentana() {
    const seg = this.segundos;
    const voz = analizarVoz(this.env, this.ratios, this.fps);
    const esperadas = MEDICION.ventanaS * this.fps;
    const cobertura = this.tramasVentana / esperadas;
    const sd = Math.sqrt(seg.reduce((a, v) => a + (v - seg.reduce((x, y) => x + y, 0) / seg.length) ** 2, 0) / seg.length);
    let calidad = 'buena';
    if (this.saturadas > 3 || cobertura < 0.8 || sd > 8) calidad = 'media';
    if (this.saturadas > 25 || cobertura < 0.5) calidad = 'baja';
    const ventana = {
      fin: Date.now(),
      L90: percentil(seg, 0.1),
      L50: percentil(seg, 0.5),
      Leq: energia(seg),
      voz: voz.voz,
      detalleVoz: voz,
      calidad,
      segundos: seg.slice(),
    };
    this.descartarVentana();
    this.alVentana?.(ventana);
  }

  detener() {
    this.activo = false;
    clearInterval(this.timer);
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { this.ctx?.close(); } catch {}
    try { this.wake?.release(); } catch {}
    document.removeEventListener('visibilitychange', this._vis);
    this.stream = null; this.ctx = null; this.wake = null;
  }
}
