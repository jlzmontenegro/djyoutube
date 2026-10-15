'use strict';
/* Motor de audio propio (Web Audio) para lo que YouTube no permite procesar:
   bandejas con archivos de música (EQ, filtro, efectos, pre-escucha, forma de onda, BPM),
   sampler y micrófono. Todo pasa por el bus master; la pre-escucha va por el bus de cue
   a la salida de audífonos que elijas. */

const audioEngine = (() => {
  let ctx = null;
  const bus = {};

  function init() {
    if (ctx) return ctx;
    ctx = new AudioContext({ latencyHint: 'interactive' });

    // Master: suma de bandejas MP3, sampler y micrófono → limitador → parlantes
    bus.master = ctx.createGain();
    bus.limiter = ctx.createDynamicsCompressor();
    bus.limiter.threshold.value = -3;
    bus.limiter.knee.value = 0;
    bus.limiter.ratio.value = 20;
    bus.limiter.attack.value = 0.003;
    bus.limiter.release.value = 0.15;
    bus.analyser = ctx.createAnalyser();
    bus.analyser.fftSize = 1024;
    bus.master.connect(bus.limiter).connect(ctx.destination);
    bus.limiter.connect(bus.analyser);

    // Cue (pre-escucha): sale por un <audio> al que se le puede elegir otra salida (audífonos)
    bus.cue = ctx.createGain();
    const cueDest = ctx.createMediaStreamDestination();
    bus.cue.connect(cueDest);
    bus.cueAudio = new Audio();
    bus.cueAudio.srcObject = cueDest.stream;
    bus.cueAudio.muted = true; // hasta elegir una salida de audífonos

    // Sampler y micrófono entran al master con su propio volumen
    bus.sampler = ctx.createGain();
    bus.sampler.connect(bus.master);
    bus.mic = ctx.createGain();
    bus.mic.connect(bus.master);
    return ctx;
  }

  // El navegador solo deja arrancar el audio tras un clic o una tecla
  const resume = () => { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); };
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => { init(); resume(); }, { capture: true }));

  async function setCueOutput(deviceId) {
    init();
    if (!deviceId) {
      bus.cueAudio.muted = true;
      bus.cueAudio.pause();
      return;
    }
    if (!bus.cueAudio.setSinkId) throw new Error('Este navegador no permite elegir la salida de audio. Usa Chrome o Edge.');
    await bus.cueAudio.setSinkId(deviceId);
    bus.cueAudio.muted = false;
    await bus.cueAudio.play();
  }

  function rms(analyser, buf) {
    analyser.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  return {
    init, resume, bus, setCueOutput, rms,
    get ctx() { return ctx; },
  };
})();

// =====================================================================
// Unidad de efectos: eco (al ritmo), reverberación, flanger
// =====================================================================
class FxUnit {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    // «send» alimenta el efecto: al apagarlo se corta la entrada pero la cola (eco, reverb) sigue sonando
    this.send = ctx.createGain();
    this.send.gain.value = 0;
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.send);
    this.wet.connect(this.output);

    // Eco
    this.delay = ctx.createDelay(4);
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.45;
    this.delay.connect(this.feedback).connect(this.delay);
    // Reverb: respuesta al impulso generada (ruido con caída exponencial)
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = FxUnit.impulse(ctx, 2.6);
    // Flanger: retardo muy corto modulado por un LFO
    this.flDelay = ctx.createDelay(0.05);
    this.flDelay.delayTime.value = 0.004;
    this.flFeedback = ctx.createGain();
    this.flFeedback.gain.value = 0.55;
    this.flDelay.connect(this.flFeedback).connect(this.flDelay);
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.25;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 0.0025;
    this.lfo.connect(this.lfoDepth).connect(this.flDelay.delayTime);
    this.lfo.start();

    this.type = 'echo';
    this.on = false;
    this.amount = 0.5;
    this.connected = null;
  }

  static impulse(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    return buf;
  }

  setBeat(seconds) {
    if (seconds > 0) this.delay.delayTime.setTargetAtTime(Math.min(3.9, seconds * 0.75), this.ctx.currentTime, 0.05);
  }

  // Conecta el efecto elegido entre «send» y «wet» (solo uno a la vez)
  route() {
    if (this.type === this.connected) return;
    for (const node of [this.delay, this.convolver, this.flDelay]) {
      try { this.send.disconnect(node); } catch { /* no conectado */ }
      try { node.disconnect(this.wet); } catch { /* no conectado */ }
    }
    const node = { echo: this.delay, reverb: this.convolver, flanger: this.flDelay }[this.type];
    this.send.connect(node);
    node.connect(this.wet);
    this.connected = this.type;
  }

  set({ type, on, amount }) {
    if (type) this.type = type;
    if (on != null) this.on = on;
    if (amount != null) this.amount = amount;
    this.route();
    const t = this.ctx.currentTime;
    this.send.gain.setTargetAtTime(this.on ? 1 : 0, t, 0.02);
    this.wet.gain.setTargetAtTime(this.type === 'flanger' ? this.amount * 1.2 : this.amount, t, 0.03);
    // El flanger suena mejor mezclado; el eco y la reverb conservan la señal original
    this.dry.gain.setTargetAtTime(this.on && this.type === 'flanger' ? 1 - this.amount * 0.4 : 1, t, 0.03);
  }
}

// =====================================================================
// Motor de una bandeja con archivo propio
// =====================================================================
class FileEngine {
  constructor(deck) {
    const ctx = audioEngine.init();
    this.deck = deck;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true; // key lock
    this.src = ctx.createMediaElementSource(this.audio);

    const bq = (type, freq, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    this.low = bq('lowshelf', 220);
    this.mid = bq('peaking', 1000, 0.8);
    this.high = bq('highshelf', 3800);
    this.hp = bq('highpass', 10);
    this.lp = bq('lowpass', 22000);
    this.fx = new FxUnit(ctx);
    this.fader = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.pfl = ctx.createGain();
    this.pfl.gain.value = 0;

    this.src.connect(this.low).connect(this.mid).connect(this.high).connect(this.hp).connect(this.lp).connect(this.fx.input);
    this.fx.output.connect(this.fader).connect(this.analyser);
    this.fader.connect(audioEngine.bus.master);
    this.fx.output.connect(this.pfl).connect(audioEngine.bus.cue); // pre-fader

    this.buf = new Float32Array(this.analyser.fftSize);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.url = null;
    this.peaks = null;
    this.audio.addEventListener('ended', () => deck.onFileEnded());
    this.audio.addEventListener('error', () => deck.onFileError());
  }

  async load(blob) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.peaks = null;
    this.audio.src = this.url;
    await new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error('El archivo no se pudo leer')); };
      const cleanup = () => { this.audio.removeEventListener('loadedmetadata', ok); this.audio.removeEventListener('error', bad); };
      this.audio.addEventListener('loadedmetadata', ok);
      this.audio.addEventListener('error', bad);
    });
  }

  get duration() { return this.audio.duration || 0; }
  get time() { return this.audio.currentTime || 0; }
  set time(t) { this.audio.currentTime = t; }
  play() { audioEngine.resume(); return this.audio.play().catch(() => {}); }
  pause() { this.audio.pause(); }
  stop() { this.audio.pause(); }
  setRate(r) { this.audio.playbackRate = clamp(r, 0.0625, 4); }
  setKeyLock(on) { this.audio.preservesPitch = on; }
  setVolume(v) { this.fader.gain.setTargetAtTime(v, this.fader.context.currentTime, 0.015); }
  setPfl(on) { this.pfl.gain.setTargetAtTime(on ? 1 : 0, this.pfl.context.currentTime, 0.02); }

  // EQ: -1 (corte total) … 0 (plano) … +1 (+6 dB)
  setEq(band, v) {
    const db = v >= 0 ? v * 6 : (v <= -0.98 ? -60 : v * 30);
    this[band].gain.setTargetAtTime(db, this[band].context.currentTime, 0.02);
  }

  // Filtro de un solo mando: izquierda = pasa bajos, derecha = pasa altos
  setFilter(v) {
    const t = this.lp.context.currentTime;
    if (v < -0.02) {
      this.lp.frequency.setTargetAtTime(20000 * Math.pow(150 / 20000, -v), t, 0.02);
      this.hp.frequency.setTargetAtTime(10, t, 0.02);
    } else if (v > 0.02) {
      this.hp.frequency.setTargetAtTime(20 * Math.pow(6000 / 20, v), t, 0.02);
      this.lp.frequency.setTargetAtTime(22000, t, 0.02);
    } else {
      this.lp.frequency.setTargetAtTime(22000, t, 0.02);
      this.hp.frequency.setTargetAtTime(10, t, 0.02);
    }
    const q = Math.abs(v) > 0.02 ? 4 : 0.7;
    this.lp.Q.setTargetAtTime(q, t, 0.05);
    this.hp.Q.setTargetAtTime(q, t, 0.05);
  }

  level() { return audioEngine.rms(this.analyser, this.buf); }

  // 32 bandas logarítmicas (0..1) para el visualizador de la proyección
  bands(n = 32) {
    this.analyser.getByteFrequencyData(this.freq);
    const out = new Array(n);
    const max = this.freq.length;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(Math.pow(max, i / n)), b = Math.max(a + 1, Math.floor(Math.pow(max, (i + 1) / n)));
      let s = 0;
      for (let k = a; k < b; k++) s += this.freq[k];
      out[i] = Math.round(s / (b - a)) / 255;
    }
    return out;
  }
}

// =====================================================================
// Análisis del archivo: forma de onda y BPM
// =====================================================================
const audioAnalysis = {
  async decode(blob) {
    const ctx = audioEngine.init();
    const data = await blob.arrayBuffer();
    return ctx.decodeAudioData(data);
  },

  // Picos por columna para dibujar la forma de onda (mono, 0..1)
  peaks(buffer, columns = 1200) {
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    const step = Math.max(1, Math.floor(ch0.length / columns));
    const out = new Float32Array(columns);
    let max = 0;
    for (let c = 0; c < columns; c++) {
      let s = 0;
      const start = c * step, end = Math.min(ch0.length, start + step);
      for (let i = start; i < end; i += 4) {
        const v = (ch0[i] + ch1[i]) * 0.5;
        s += v * v;
      }
      out[c] = Math.sqrt(s / Math.max(1, (end - start) / 4));
      if (out[c] > max) max = out[c];
    }
    if (max > 0) for (let c = 0; c < columns; c++) out[c] /= max;
    return out;
  },

  // Detección de BPM: envolvente de graves → autocorrelación → fase del tiempo 1
  async bpm(buffer) {
    const sr = 11025;
    const start = Math.max(0, Math.floor(buffer.duration * 0.15));
    const length = Math.min(90, Math.max(10, buffer.duration - start - 1));
    const off = new OfflineAudioContext(1, Math.ceil(length * sr), sr);
    const src = off.createBufferSource();
    src.buffer = buffer;
    const lp = off.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 150;
    src.connect(lp).connect(off.destination);
    src.start(0, start, length);
    const rendered = await off.startRendering();
    const x = rendered.getChannelData(0);

    // Envolvente de energía (~100 cuadros por segundo) y su crecimiento (dónde empiezan los golpes).
    // `fps` es la frecuencia exacta: con 11025/110 son 100.23, y usar 100 sesgaba el BPM un 0.23 %.
    const hop = Math.floor(sr / 100);
    const fps = sr / hop;
    const n = Math.floor(x.length / hop);
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < hop; k++) { const v = x[i * hop + k]; s += v * v; }
      env[i] = Math.sqrt(s / hop);
    }
    const onset = new Float32Array(n);
    for (let i = 1; i < n; i++) onset[i] = Math.max(0, env[i] - env[i - 1]);

    // Autocorrelación entre 60 y 190 BPM, sumando también el doble del período
    let best = 0, bestLag = 0;
    const score = new Float32Array(101);
    for (let lag = 31; lag <= 100; lag++) {
      let s = 0;
      for (let i = 0; i + 2 * lag < n; i++) s += onset[i] * (onset[i + lag] + 0.5 * onset[i + 2 * lag]);
      score[lag] = s;
      if (s > best) { best = s; bestLag = lag; }
    }
    if (!bestLag) return null;
    // Afinar con interpolación parabólica
    const a = score[bestLag - 1] || 0, b = score[bestLag], c = score[bestLag + 1] || 0;
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    let rough = 60 * fps / (bestLag + clamp(shift, -0.5, 0.5));
    while (rough < 78) rough *= 2;
    while (rough > 175) rough /= 2;

    // Afinado: tempo y fase que mejor alinean la grilla con los golpes en todo el tramo
    // (un error de 0.3 BPM ya desfasa la mezcla en pocos segundos)
    const comb = (bpm) => {
      const period = 60 * fps / bpm;
      let best = -1, phase = 0;
      for (let p = 0; p < period; p += 0.5) {
        let s = 0;
        for (let k = 0; p + k * period < n; k++) s += onset[Math.round(p + k * period)] || 0;
        if (s > best) { best = s; phase = p; }
      }
      return { score: best, phase };
    };
    let bpm = rough, bestComb = comb(rough);
    for (let cand = rough - 1.5; cand <= rough + 1.5; cand += 0.05) {
      const r = comb(cand);
      if (r.score > bestComb.score) { bestComb = r; bpm = cand; }
    }
    // Casi todas las canciones tienen BPM entero: si está muy cerca, se redondea
    bpm = Math.abs(bpm - Math.round(bpm)) < 0.2 ? Math.round(bpm) : Math.round(bpm * 10) / 10;
    const bestPhase = comb(bpm).phase;
    const beatAt = start + bestPhase / fps;
    const beatLen = 60 / bpm;
    const beat1 = beatAt - Math.floor(beatAt / beatLen) * beatLen; // primer golpe desde el inicio
    return { bpm, beat1 };
  },
};

// =====================================================================
// Perilla giratoria (arrastrar arriba/abajo, rueda del ratón, doble clic = centro)
// =====================================================================
class Knob {
  constructor(el, { min = -1, max = 1, value = 0, def = 0, onInput } = {}) {
    Object.assign(this, { el, min, max, value, def, onInput });
    el.classList.add('knob');
    el.tabIndex = 0;
    el.innerHTML = '<span class="knob-dial"><i></i></span>';
    this.dial = el.firstChild;
    el.addEventListener('pointerdown', (e) => {
      if (el.classList.contains('disabled')) return;
      el.setPointerCapture(e.pointerId);
      const y0 = e.clientY, v0 = this.value;
      const move = (ev) => this.set(v0 + (y0 - ev.clientY) / 150 * (this.max - this.min), true);
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('wheel', (e) => {
      if (el.classList.contains('disabled')) return;
      e.preventDefault();
      this.set(this.value - Math.sign(e.deltaY) * (this.max - this.min) / 40, true);
    }, { passive: false });
    el.addEventListener('dblclick', () => this.set(this.def, true));
    this.render();
  }

  set(v, fromUser = false) {
    v = clamp(v, this.min, this.max);
    if (Math.abs(v - this.def) < (this.max - this.min) * 0.02) v = this.def; // retén en el centro
    this.value = v;
    this.render();
    if (fromUser) this.onInput?.(v);
  }

  setFromMidi(v127) { this.set(this.min + (v127 / 127) * (this.max - this.min), true); }

  render() {
    const k = (this.value - this.min) / (this.max - this.min);
    this.dial.style.transform = `rotate(${-135 + k * 270}deg)`;
    this.el.classList.toggle('off-center', Math.abs(this.value - this.def) > 1e-6);
  }
}
