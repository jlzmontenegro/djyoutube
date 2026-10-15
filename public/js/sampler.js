'use strict';
/* Sampler: 8 pads de sonidos. Los sonidos de fábrica se generan aquí mismo con síntesis
   (son originales, no grabaciones); cada pad puede cargar un sonido propio del PC. */

const PAD_KEYS = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyA', 'KeyS', 'KeyD', 'KeyG'];
const PAD_KEY_LABELS = ['Z', 'X', 'C', 'V', 'A', 'S', 'D', 'G'];

// Cada receta dibuja su sonido en un OfflineAudioContext (duración en segundos)
const PAD_RECIPES = [
  { name: 'Bocina', dur: 2.2, draw(c) {
    // Tres toques cortos y uno largo, con varias sierras desafinadas
    const blasts = [[0, 0.16], [0.22, 0.16], [0.44, 0.16], [0.7, 1.4]];
    const out = c.createGain();
    out.gain.value = 0.22;
    const shaper = c.createWaveShaper();
    shaper.curve = Float32Array.from({ length: 1024 }, (_, i) => Math.tanh((i / 512 - 1) * 3));
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.8;
    shaper.connect(bp).connect(out).connect(c.destination);
    for (const [t, len] of blasts) {
      for (const f of [466, 470, 587, 698]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f * 0.94, t);
        o.frequency.linearRampToValueAtTime(f, t + 0.05);
        const g = c.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.5, t + 0.02);
        g.gain.setValueAtTime(0.5, t + len - 0.05);
        g.gain.linearRampToValueAtTime(0, t + len);
        o.connect(g).connect(shaper);
        o.start(t); o.stop(t + len);
      }
    }
  } },
  { name: 'Sirena', dur: 2.6, draw(c) {
    const o = c.createOscillator();
    o.type = 'square';
    const lfo = c.createOscillator();
    lfo.frequency.value = 1.6;
    const depth = c.createGain();
    depth.gain.value = 320;
    o.frequency.value = 900;
    lfo.connect(depth).connect(o.frequency);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2500;
    const g = c.createGain();
    g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.18, 0.05);
    g.gain.setValueAtTime(0.18, 2.3); g.gain.linearRampToValueAtTime(0, 2.6);
    o.connect(lp).connect(g).connect(c.destination);
    o.start(); lfo.start();
  } },
  { name: 'Láser', dur: 1.1, draw(c) {
    for (const t of [0, 0.3, 0.6]) {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(2600, t);
      o.frequency.exponentialRampToValueAtTime(90, t + 0.28);
      const g = c.createGain();
      g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + 0.3);
    }
  } },
  { name: 'Subida', dur: 4.2, draw(c) {
    const noise = c.createBufferSource();
    noise.buffer = noiseBuffer(c, 4.2);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(200, 0); bp.frequency.exponentialRampToValueAtTime(7000, 4);
    const g = c.createGain();
    g.gain.setValueAtTime(0.02, 0); g.gain.exponentialRampToValueAtTime(0.5, 4); g.gain.linearRampToValueAtTime(0, 4.2);
    noise.connect(bp).connect(g).connect(c.destination);
    noise.start();
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, 0); o.frequency.exponentialRampToValueAtTime(880, 4);
    const og = c.createGain();
    og.gain.setValueAtTime(0.0, 0); og.gain.linearRampToValueAtTime(0.08, 4); og.gain.linearRampToValueAtTime(0, 4.2);
    o.connect(og).connect(c.destination);
    o.start(); o.stop(4.2);
  } },
  { name: 'Impacto', dur: 2.2, draw(c) {
    const o = c.createOscillator();
    o.frequency.setValueAtTime(120, 0); o.frequency.exponentialRampToValueAtTime(28, 1.6);
    const g = c.createGain();
    g.gain.setValueAtTime(1, 0); g.gain.exponentialRampToValueAtTime(0.001, 2.1);
    o.connect(g).connect(c.destination);
    o.start(); o.stop(2.2);
    const n = c.createBufferSource();
    n.buffer = noiseBuffer(c, 0.6);
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.6, 0); ng.gain.exponentialRampToValueAtTime(0.001, 0.6);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3000;
    n.connect(lp).connect(ng).connect(c.destination);
    n.start();
  } },
  { name: 'Bombo', dur: 0.6, draw(c) {
    const o = c.createOscillator();
    o.frequency.setValueAtTime(160, 0); o.frequency.exponentialRampToValueAtTime(42, 0.35);
    const g = c.createGain();
    g.gain.setValueAtTime(1, 0); g.gain.exponentialRampToValueAtTime(0.001, 0.55);
    o.connect(g).connect(c.destination);
    o.start(); o.stop(0.6);
  } },
  { name: 'Palmas', dur: 0.5, draw(c) {
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 1.2;
    bp.connect(c.destination);
    for (const t of [0, 0.012, 0.024, 0.04]) {
      const n = c.createBufferSource();
      n.buffer = noiseBuffer(c, 0.4);
      const g = c.createGain();
      const len = t === 0.04 ? 0.3 : 0.02;
      g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      n.connect(g).connect(bp);
      n.start(t);
    }
  } },
  { name: 'Rebobinar', dur: 1.4, draw(c) {
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(300, 0);
    o.frequency.exponentialRampToValueAtTime(2400, 0.9);
    o.frequency.exponentialRampToValueAtTime(60, 1.35);
    const wob = c.createOscillator();
    wob.frequency.value = 22;
    const wd = c.createGain();
    wd.gain.value = 140;
    wob.connect(wd).connect(o.frequency);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2200;
    const g = c.createGain();
    g.gain.setValueAtTime(0.25, 0); g.gain.linearRampToValueAtTime(0, 1.4);
    o.connect(lp).connect(g).connect(c.destination);
    o.start(); wob.start(); o.stop(1.4);
  } },
];

function noiseBuffer(c, seconds) {
  const b = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

const sampler = {
  buffers: [],     // AudioBuffer por pad
  custom: [],      // nombre del sonido propio, si lo hay
  playing: [],     // fuente sonando por pad (para cortar al volver a pulsar)
  loadingPad: null,

  async factory(i) {
    const r = PAD_RECIPES[i];
    const sr = 44100;
    const c = new OfflineAudioContext(1, Math.ceil(sr * r.dur), sr);
    r.draw(c);
    return c.startRendering();
  },

  async load(i) {
    const rec = await idb.get('pads', i).catch(() => null);
    if (rec?.blob) {
      try {
        this.buffers[i] = await audioAnalysis.decode(rec.blob);
        this.custom[i] = rec.name;
        return;
      } catch { /* sonido propio dañado: se usa el de fábrica */ }
    }
    this.custom[i] = null;
    this.buffers[i] = await this.factory(i);
  },

  async trigger(i) {
    const ctx = audioEngine.init();
    audioEngine.resume();
    if (!this.buffers[i]) await this.load(i);
    try { this.playing[i]?.stop(); } catch { /* ya terminó */ }
    audioEngine.bus.sampler.gain.value = ((settings.samplerVol ?? 80) / 100) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers[i];
    src.connect(audioEngine.bus.sampler);
    src.start();
    this.playing[i] = src;
    const pad = $$('#samplerPads .pad')[i];
    pad.classList.add('hit');
    setTimeout(() => pad.classList.remove('hit'), 140);
  },

  render() {
    $$('#samplerPads .pad').forEach((pad, i) => {
      $('.pad-name', pad).textContent = this.custom[i] || PAD_RECIPES[i].name;
      pad.classList.toggle('custom', !!this.custom[i]);
      $('.pad-reset', pad).hidden = !this.custom[i];
    });
  },
};

function initSampler() {
  const box = $('#samplerPads');
  box.innerHTML = PAD_RECIPES.map((r, i) => `
    <div class="pad" data-i="${i}" role="button" tabindex="0" title="Tocar (tecla ${PAD_KEY_LABELS[i]})">
      <span class="pad-key">${PAD_KEY_LABELS[i]}</span>
      <span class="pad-name">${r.name}</span>
      <span class="pad-tools">
        <button class="pad-load" title="Cargar un sonido propio en este pad">Cargar</button>
        <button class="pad-reset" title="Volver al sonido de fábrica" hidden>↺</button>
      </span>
    </div>`).join('');
  box.addEventListener('pointerdown', (e) => {
    const pad = e.target.closest('.pad');
    if (!pad || e.target.closest('button')) return;
    sampler.trigger(+pad.dataset.i);
  });
  box.addEventListener('click', async (e) => {
    const pad = e.target.closest('.pad');
    if (!pad) return;
    const i = +pad.dataset.i;
    if (e.target.closest('.pad-load')) {
      sampler.loadingPad = i;
      $('#padFile').click();
    } else if (e.target.closest('.pad-reset')) {
      await idb.del('pads', i).catch(() => {});
      await sampler.load(i);
      sampler.render();
    }
  });
  $('#padFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    const i = sampler.loadingPad;
    if (!f || i == null) return;
    try {
      const buf = await audioAnalysis.decode(f);
      if (buf.duration > 30) throw new Error('Para el sampler usa sonidos de menos de 30 segundos');
      await idb.put('pads', i, { blob: f, name: f.name.replace(/\.[^.]+$/, '').slice(0, 18) });
      sampler.buffers[i] = buf;
      sampler.custom[i] = f.name.replace(/\.[^.]+$/, '').slice(0, 18);
      sampler.render();
      toast(`Pad ${PAD_KEY_LABELS[i]}: «${sampler.custom[i]}» cargado`, 'ok');
    } catch (err) {
      toast('No se pudo cargar el sonido: ' + err.message, 'error');
    }
  });

  const vol = $('#samplerVol');
  vol.value = settings.samplerVol ?? 80;
  const applyVol = () => {
    settings.samplerVol = +vol.value;
    if (audioEngine.ctx) audioEngine.bus.sampler.gain.value = (settings.samplerVol / 100) ** 2;
  };
  vol.addEventListener('input', () => { applyVol(); saveSettings(); });

  document.addEventListener('keydown', (e) => {
    if (!shortcutAllowed(e)) return;
    const i = PAD_KEYS.indexOf(e.code);
    if (i < 0) return;
    e.preventDefault();
    sampler.trigger(i);
  });

  // Los nombres de los sonidos propios se cargan al abrir (sin decodificar todavía)
  Promise.all(PAD_RECIPES.map((_, i) => idb.get('pads', i).catch(() => null))).then((recs) => {
    recs.forEach((r, i) => { if (r?.name) sampler.custom[i] = r.name; });
    sampler.render();
  });
}
