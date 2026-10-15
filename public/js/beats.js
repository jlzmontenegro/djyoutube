'use strict';
/* Tiempos y compases (beatgrid), quantize, SYNC y efectos de mezcla (gate, freno, echo out).
   La grilla de cada canción es su BPM + el instante de un «tiempo 1» (beat1), guardados por canción. */

const PHRASE_BARS = 8; // compases por frase que se muestran en el contador

const beatGrid = {
  beatLen: (d) => (d.bpm ? 60 / d.bpm : 0),

  // Tiempos transcurridos desde el tiempo 1 (con decimales). null si no hay BPM.
  beats(d, t = d.time()) {
    return d.bpm ? (t - (d.beat1 || 0)) * d.bpm / 60 : null;
  },

  // Ajusta un instante al tiempo más cercano si está activado quantize
  snap(d, t) {
    if (!settings.quantize || !d.bpm) return t;
    const len = 60 / d.bpm, b1 = d.beat1 || 0;
    return b1 + Math.round((t - b1) / len) * len;
  },

  // Milisegundos reales hasta el próximo tiempo (para saltos cuantizados)
  msToNextBeat(d) {
    const b = this.beats(d);
    if (b == null || !d.playing) return 0;
    return (Math.ceil(b) - b) * 60 / d.bpm / d.effRate() * 1000;
  },

  // Diferencia de fase entre dos bandejas en tiempos (-0.5..0.5). Positivo: «a» va adelantada.
  phase(a, b) {
    const ba = this.beats(a), bb = this.beats(b);
    if (ba == null || bb == null) return null;
    let e = (ba - Math.floor(ba)) - (bb - Math.floor(bb));
    if (e > 0.5) e -= 1;
    if (e < -0.5) e += 1;
    return e;
  },
};

// Si quantize está activo y la bandeja suena, espera al próximo tiempo antes de saltar
function quantizedJump(d, fn) {
  const ms = settings.quantize && d.playing && d.bpm ? beatGrid.msToNextBeat(d) : 0;
  if (ms > 15) setTimeout(fn, ms - 10); else fn();
}

// =====================================================================
// SYNC: iguala el tempo con la otra bandeja y la mantiene en fase.
// Con archivos MP3 la velocidad es continua; con YouTube va en pasos de 0.05×,
// así que alterna entre los dos pasos más cercanos para no perder la fase.
// =====================================================================
function syncPartner(d) { return d === decks.A ? decks.B : decks.A; }

function toggleSync(d) {
  if (d.syncOn) { d.syncOn = false; d.render(); return; }
  const m = syncPartner(d);
  if (!d.track || !m.track) return toast('Carga canciones en las dos bandejas para usar SYNC');
  if (!d.bpm || !m.bpm) return toast('Las dos canciones necesitan BPM: márcalo con TAP (o se detecta solo en los MP3)');
  d.syncOn = true;
  const target = m.bpm * m.rate / d.bpm;
  d.setRate(target, { fromSync: true });
  // Alinear la fase de una vez si las dos suenan. En YouTube no: saltar lo hace recargar
  // y pierde más de lo que gana; ahí la fase la corrige el tempo sobre la marcha.
  const e = beatGrid.phase(m, d);
  if (e != null && m.playing && d.kind === 'file') d.seek(d.time() + e * 60 / d.bpm);
  if (d.kind === 'yt' && Math.abs(target - Math.round(target / 0.05) * 0.05) > 0.004) {
    toast(`SYNC ${d.letter}: YouTube solo cambia la velocidad en pasos de 0.05×; se corrige la fase sobre la marcha`);
  }
  d.render();
}

function syncTick() {
  const now = performance.now();
  for (const d of deckList) {
    if (!d.syncOn) continue;
    const m = syncPartner(d);
    if (!d.bpm || !m.bpm || !m.track) { d.syncOn = false; d.render(); continue; }
    const base = m.bpm * m.rate / d.bpm;
    let r = base;
    if (d.playing && m.playing) {
      const e = beatGrid.phase(m, d); // positivo: la otra va adelantada → acelerar
      // Corrección suave (±4 %): con YouTube, pasos más grandes lo hacen titubear y oscila
      if (e != null && Math.abs(e) > 0.01) r = base * (1 + clamp(e * 0.3, -0.04, 0.04));
    }
    if (d.kind === 'yt') {
      if (now - (d.syncAt || 0) < 450) continue;
      r = Math.round(r / 0.05) * 0.05;
    }
    if (Math.abs(r - d.rate) > 0.0005) {
      d.syncAt = now;
      d.setRate(r, { fromSync: true });
    }
  }
}

// =====================================================================
// Efectos de mezcla para las dos clases de bandeja
// =====================================================================
const mixFx = {
  start(d, type) {
    if (!d.track || !d.playing) return toast(`La bandeja ${d.letter} tiene que estar sonando`);
    const now = performance.now();
    if (d.mfx?.type === type && type === 'gate') { this.stop(d); return; }
    this.stop(d);
    const beatMs = (d.bpm ? 60 / d.bpm / d.effRate() : 0.5) * 1000;
    d.mfx = { type, t0: now, beatMs, fromRate: d.rate, keyLock: d.keyLock };
    if (type === 'echo' && d.kind === 'file') d.fe.echoOut(beatMs / 1000);
    d.render();
  },

  stop(d) {
    if (!d.mfx) return;
    const m = d.mfx;
    d.mfx = null;
    if (m.type === 'brake') {
      d.bend = 1;
      d.setRate(m.fromRate);
      if (d.kind === 'file') d.fe.setKeyLock(d.keyLock);
    }
    applyVolumes();
    d.render();
  },

  // Multiplicador de volumen que aplica el efecto en este instante
  gain(d, now) {
    const m = d.mfx;
    if (!m) return 1;
    if (m.type === 'gate') {
      const div = settings.gateDiv || 4;
      const b = beatGrid.beats(d) ?? (now - m.t0) / m.beatMs;
      return ((b * div / 4) % 1 + 1) % 1 < 0.5 ? 1 : 0;
    }
    if (m.type === 'echo' && d.kind === 'yt') {
      // Eco simulado: golpes cada vez más bajos al ritmo
      const k = (now - m.t0) / m.beatMs;
      const step = Math.floor(k);
      return Math.pow(0.5, step + 1) * (k - step < 0.4 ? 1 : 0.12);
    }
    return 1;
  },

  tick(now) {
    let changed = false;
    for (const d of deckList) {
      const m = d.mfx;
      if (!m) continue;
      changed = true;
      const elapsed = now - m.t0;
      if (m.type === 'brake') {
        if (d.kind === 'file') {
          // Freno de tocadiscos real: baja la velocidad y el tono hasta pararse
          const p = elapsed / 1400;
          d.fe.setKeyLock(false);
          d.bend = Math.max(0.0625, Math.pow(1 - Math.min(p, 1), 1.6)) ;
          d.applyEngineRate();
          if (p >= 1) { d.pause(); this.stop(d); }
        } else {
          // YouTube: bajadas por pasos
          const steps = [0.75, 0.5, 0.25];
          const i = Math.floor(elapsed / 260);
          if (i >= steps.length) { d.pause(); this.stop(d); } else if (d.bend !== steps[i]) { d.bend = steps[i]; d.applyEngineRate(); }
        }
      } else if (m.type === 'echo') {
        if (elapsed > m.beatMs * 4) { d.pause(); this.stop(d); }
      }
    }
    if (changed) applyVolumes();
  },
};

// Echo out real para archivos: el eco sigue sonando cuando la canción se detiene
FileEngine.prototype.echoOut = function (beatSec) {
  const fx = this.fx, t = fx.ctx.currentTime;
  const prev = { type: fx.type, on: fx.on, amount: fx.amount };
  fx.set({ type: 'echo', on: true, amount: 0.9 });
  fx.delay.delayTime.setValueAtTime(Math.min(3.9, beatSec * 0.75), t);
  fx.feedback.gain.setTargetAtTime(0.62, t, 0.02);
  fx.dry.gain.setTargetAtTime(0, t + beatSec * 0.5, 0.08);
  setTimeout(() => {
    fx.feedback.gain.setTargetAtTime(0.45, fx.ctx.currentTime, 0.1);
    fx.set(prev);
    this.deck.syncFxUi();
  }, beatSec * 4000 + 3500);
};
