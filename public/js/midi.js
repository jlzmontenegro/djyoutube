'use strict';
/* Controladora MIDI (Web MIDI). Funciona con cualquier marca mediante «Aprender»:
   pulsas Aprender en una acción y mueves el botón, fader o perilla de tu controladora. */

// kind: 'btn' = botón (al pulsar) · 'hold' = mientras se mantiene · 'abs' = fader/perilla 0..127 · 'rel' = rueda (jog)
function midiActions() {
  const list = [];
  for (const L of ['A', 'B']) {
    const d = () => decks[L];
    list.push(
      { id: `${L}.play`, label: `${L} · Play / pausa`, kind: 'btn', run: () => d().toggle() },
      { id: `${L}.cue`, label: `${L} · CUE`, kind: 'btn', run: () => d().cuePress() },
      ...[0, 1, 2, 3].map((i) => ({ id: `${L}.hc${i + 1}`, label: `${L} · Hot cue ${i + 1}`, kind: 'btn', run: () => d().hotCue(i) })),
      { id: `${L}.loop4`, label: `${L} · Loop 4 tiempos`, kind: 'btn', run: () => d().beatLoop(4) },
      { id: `${L}.loopExit`, label: `${L} · Salir del loop / reloop`, kind: 'btn', run: () => d().loopToggle() },
      { id: `${L}.sync`, label: `${L} · SYNC`, kind: 'btn', run: () => toggleSync(d()) },
      { id: `${L}.tap`, label: `${L} · TAP (BPM)`, kind: 'btn', run: () => d().tap() },
      { id: `${L}.load`, label: `${L} · Cargar la siguiente`, kind: 'btn', run: () => { const n = nextTrack(lastLoadedId); if (n) safeLoad(d(), n); } },
      { id: `${L}.pfl`, label: `${L} · Pre-escucha (PFL)`, kind: 'btn', run: () => d().setPfl(!d().pflOn) },
      { id: `${L}.fx`, label: `${L} · Efecto on/off`, kind: 'btn', run: () => d().setFx({ on: !d().fx.on }) },
      { id: `${L}.gate`, label: `${L} · Gate`, kind: 'btn', run: () => mixFx.start(d(), 'gate') },
      { id: `${L}.brake`, label: `${L} · Freno`, kind: 'btn', run: () => mixFx.start(d(), 'brake') },
      { id: `${L}.echo`, label: `${L} · Echo out`, kind: 'btn', run: () => mixFx.start(d(), 'echo') },
      { id: `${L}.bendDown`, label: `${L} · Frenar un poco (mantener)`, kind: 'hold', run: (on) => (on ? d().bendStart(-1) : d().bendStop()) },
      { id: `${L}.bendUp`, label: `${L} · Acelerar un poco (mantener)`, kind: 'hold', run: (on) => (on ? d().bendStart(1) : d().bendStop()) },
      { id: `${L}.jog`, label: `${L} · Rueda (jog)`, kind: 'rel', run: (delta) => d().jog(delta) },
      { id: `${L}.vol`, label: `${L} · Volumen del canal`, kind: 'abs', run: (v) => setRange(`vol${L}`, v / 127 * 100) },
      { id: `${L}.tempo`, label: `${L} · Tempo (fader)`, kind: 'abs', run: (v) => {
        const s = d().ui.slider;
        d().setRate(1 + (+s.min + (v / 127) * (s.max - s.min)) / 100);
      } },
      ...['high', 'mid', 'low', 'filter'].map((k) => ({
        id: `${L}.${k}`, label: `${L} · ${{ high: 'EQ agudos', mid: 'EQ medios', low: 'EQ graves', filter: 'Filtro' }[k]}`,
        kind: 'abs', run: (v) => d().knobs[k].setFromMidi(v),
      })),
    );
  }
  list.push(
    { id: 'xfader', label: 'Crossfader', kind: 'abs', run: (v) => setXf(v / 127, true) },
    { id: 'master', label: 'Volumen master', kind: 'abs', run: (v) => setRange('master', v / 127 * 100) },
    { id: 'autofade', label: 'Auto-fade', kind: 'btn', run: () => (fade ? stopFade() : autoFade()) },
    { id: 'automix', label: 'AutoMix on/off', kind: 'btn', run: () => setAutomix(!automixOn) },
    { id: 'blackout', label: 'Pantalla negra', kind: 'btn', run: () => toggleBlackout() },
    { id: 'mic', label: 'Micrófono on/off', kind: 'btn', run: () => $('#micOn').click() },
    ...PAD_RECIPES.map((_, i) => ({ id: `pad${i + 1}`, label: `Sampler · pad ${i + 1}`, kind: 'btn', run: () => sampler.trigger(i) })),
    { id: 'strobe', label: 'Video · estrobo on/off', kind: 'btn', run: () => toggleVfx('strobe') },
    { id: 'flash', label: 'Video · flash al ritmo on/off', kind: 'btn', run: () => toggleVfx('flash') },
  );
  return list;
}

// Mueve un control deslizante de la página como si lo hubiera movido el DJ
function setRange(id, value) {
  const el = $('#' + id);
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

const midi = {
  access: null,
  actions: [],
  map: store.get('midiMap', {}),   // clave del control MIDI → id de acción
  learning: null,
  held: new Set(),

  async connect() {
    if (!navigator.requestMIDIAccess) {
      toast('Este navegador no tiene MIDI. Usa Chrome o Edge.', 'error');
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      toast('No diste permiso para usar dispositivos MIDI', 'error');
      return;
    }
    this.access.onstatechange = () => this.bindInputs();
    this.bindInputs();
  },

  bindInputs() {
    const names = [];
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (e) => this.onMessage(e.data);
      names.push(input.name);
    }
    $('#midiStatus').textContent = names.length
      ? `● Conectado: ${names.join(', ')}`
      : 'No hay controladoras conectadas. Conéctala por USB (el navegador la detecta sola).';
    $('#midiStatus').classList.toggle('on', names.length > 0);
    $('#midiConnect').hidden = true;
  },

  onMessage([status, d1, d2 = 0]) {
    const type = status & 0xf0, ch = status & 0x0f;
    let key, value, press;
    if (type === 0x90 || type === 0x80) {
      key = `n:${ch}:${d1}`;
      press = type === 0x90 && d2 > 0;
      value = press ? 127 : 0;
    } else if (type === 0xb0) {
      key = `c:${ch}:${d1}`;
      value = d2;
      press = d2 > 0;
    } else if (type === 0xe0) {
      key = `p:${ch}`;
      value = ((d2 << 7) | d1) / 16383 * 127; // pitch bend de 14 bits (algunos faders de tempo)
      press = true;
    } else return;

    if (this.learning) {
      if (type === 0x80 || (type === 0x90 && !press)) return; // esperar a que se pulse
      for (const k of Object.keys(this.map)) if (this.map[k] === this.learning) delete this.map[k];
      this.map[key] = this.learning;
      store.set('midiMap', this.map);
      toast(`Asignado: ${this.actions.find((a) => a.id === this.learning)?.label}`, 'ok');
      this.learning = null;
      this.render();
      return;
    }

    const action = this.actions.find((a) => a.id === this.map[key]);
    if (!action) return;
    if (action.kind === 'btn') {
      // Botones: actúan al pulsar (no al soltar)
      if (press && !this.held.has(key)) action.run();
      if (press) this.held.add(key); else this.held.delete(key);
    } else if (action.kind === 'hold') {
      action.run(press);
    } else if (action.kind === 'abs') {
      action.run(value);
    } else if (action.kind === 'rel') {
      // Ruedas: 1..63 = adelante, 65..127 = atrás (también 64 ± n)
      const delta = value < 64 ? value : value - 128;
      if (delta) action.run(delta);
    }
  },

  keyLabel(id) {
    const key = Object.keys(this.map).find((k) => this.map[k] === id);
    if (!key) return '—';
    const [t, ch, n] = key.split(':');
    return t === 'n' ? `Nota ${n} · canal ${+ch + 1}` : t === 'c' ? `CC ${n} · canal ${+ch + 1}` : `Pitch · canal ${+ch + 1}`;
  },

  render() {
    $('#midiTable').innerHTML = this.actions.map((a) => `
      <tr class="${this.learning === a.id ? 'learning' : ''}">
        <td>${esc(a.label)}</td>
        <td class="mono">${this.learning === a.id ? 'Mueve un control…' : this.keyLabel(a.id)}</td>
        <td><button class="btn small" data-learn="${a.id}">${this.learning === a.id ? 'Cancelar' : 'Aprender'}</button>
            <button class="btn small danger" data-forget="${a.id}" title="Quitar asignación">✕</button></td>
      </tr>`).join('');
  },
};

function initMidi() {
  midi.actions = midiActions();
  midi.render();
  $('#midiConnect').addEventListener('click', () => midi.connect());
  $('#midiTable').addEventListener('click', (e) => {
    const learn = e.target.closest('[data-learn]')?.dataset.learn;
    const forget = e.target.closest('[data-forget]')?.dataset.forget;
    if (learn) {
      if (!midi.access) midi.connect();
      midi.learning = midi.learning === learn ? null : learn;
    }
    if (forget) {
      for (const k of Object.keys(midi.map)) if (midi.map[k] === forget) delete midi.map[k];
      store.set('midiMap', midi.map);
    }
    midi.render();
  });
  $('#midiClear').addEventListener('click', () => {
    if (!confirm('¿Borrar todas las asignaciones MIDI?')) return;
    midi.map = {};
    store.set('midiMap', midi.map);
    midi.render();
  });
  // Si ya había asignaciones, reconectar sin preguntar de nuevo (el permiso queda guardado)
  if (Object.keys(midi.map).length && navigator.requestMIDIAccess) midi.connect();
}
