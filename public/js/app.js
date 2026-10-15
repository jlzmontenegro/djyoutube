'use strict';
/* DJ YouTube — consola de control.
   Cada bandeja es un reproductor oficial de YouTube (IFrame API). El sonido sale de esta ventana;
   la ventana de proyección recibe el estado por BroadcastChannel y muestra los mismos videos en silencio. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Debe coincidir con APP_VERSION de proyeccion.js: así la consola detecta una proyección desactualizada.
const APP_VERSION = '13';
const PS = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
const DRAG_TRACK = 'application/x-djyt-track';
const DRAG_INDEX = 'application/x-djyt-index';
const LOADING_TITLE = 'Cargando título…';
const YT_ERRORS = {
  2: 'Enlace o ID de video no válido',
  5: 'El reproductor no pudo reproducir este video',
  100: 'Video no encontrado, privado o eliminado',
  // YouTube usa el mismo código para videos bloqueados por su dueño y para videos que no existen
  101: 'No se puede reproducir aquí: el dueño no permite usarlo fuera de YouTube, o el video no existe',
  150: 'No se puede reproducir aquí: el dueño no permite usarlo fuera de YouTube, o el video no existe',
  153: 'YouTube rechazó la reproducción: abre la app desde su enlace web o con «Iniciar DJ YouTube.bat»',
};
const PLAYER_VARS = {
  controls: 0, disablekb: 1, rel: 0, iv_load_policy: 3, modestbranding: 1, playsinline: 1, fs: 0,
  origin: location.origin,
};

// ---------- Persistencia ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('djyt.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('djyt.' + key, JSON.stringify(value)); } catch { /* almacenamiento bloqueado o lleno */ }
  },
};

// ---------- Utilidades ----------
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = Math.floor(sec % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 3800);
  setTimeout(() => el.remove(), 4300);
}

// Devuelve { video, list } a partir de un enlace o ID de YouTube.
function parseYouTube(token) {
  token = token.trim();
  if (/^[\w-]{11}$/.test(token) && /[\d_-]|[a-z][A-Z]/.test(token)) return { video: token };
  let u;
  try { u = new URL(/^https?:\/\//i.test(token) ? token : 'https://' + token); } catch { return {}; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let video = null;
  if (host === 'youtu.be') video = u.pathname.slice(1, 12);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    video = u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    if (m) video = m[1];
  } else return {};
  if (video && !/^[\w-]{11}$/.test(video)) video = null;
  return { video, list: u.searchParams.get('list') };
}

// Activa o quita los subtítulos (CC) de un reproductor. Al activarlos se elige una pista:
// el idioma del navegador, luego inglés, luego la primera que tenga el video.
function setCaptions(player, on) {
  try {
    if (!on) {
      player.unloadModule('captions');
      player.unloadModule('cc');
      return;
    }
    player.loadModule('captions');
    const list = player.getOption('captions', 'tracklist') || [];
    const lang = (navigator.language || 'es').slice(0, 2);
    const pick = list.find((t) => t.languageCode?.startsWith(lang)) ||
      list.find((t) => t.languageCode?.startsWith('en')) || list[0];
    if (pick) player.setOption('captions', 'track', { languageCode: pick.languageCode });
  } catch { /* el video aún no cargó el módulo de subtítulos */ }
}

// ---------- Estado guardado ----------
const settings = Object.assign({
  apiKey: '', fadeTime: 8, curve: 'smooth', videoMode: 'mix', overlayText: '', showTitle: true, hideTail: 20, captions: false, autoNext: true,
  master: 100, volA: 100, volB: 100, quantize: false, gateDiv: 4, cueDevice: null, cueVol: 100,
}, store.get('settings', {}));
const saveSettings = () => store.set('settings', settings);

let playlists = store.get('playlists', null);
if (!Array.isArray(playlists) || !playlists.length) playlists = [{ id: uid(), name: 'Mi lista', tracks: [] }];
let activePlId = store.get('activePl', playlists[0].id);
const curPl = () => playlists.find((p) => p.id === activePlId) || playlists[0];

let savePlTimer;
function savePlaylists() {
  clearTimeout(savePlTimer);
  savePlTimer = setTimeout(() => { store.set('playlists', playlists); store.set('activePl', activePlId); }, 200);
}

// Datos guardados por canción: cue, hot cues, BPM, tiempo 1 y ficha (tonalidad, energía, etiquetas, notas)
const cueData = store.get('cues', {});
let saveCueTimer;
function getCueData(id) {
  return cueData[id] || (cueData[id] = { cue: 0, hot: [null, null, null, null], bpm: null, beat1: 0 });
}
function saveCues() {
  clearTimeout(saveCueTimer);
  saveCueTimer = setTimeout(() => store.set('cues', cueData), 300);
}

const playedIds = new Set();
let lastLoadedId = null;

function forEachTrack(id, fn) {
  for (const p of playlists) for (const t of p.tracks) if (t.id === id) fn(t);
}

// =====================================================================
// Bandeja: reproduce videos de YouTube (reproductor oficial) o archivos de música propios
// (motor Web Audio con EQ, filtro, efectos y forma de onda). this.kind dice cuál está activo.
// =====================================================================
const FILE_THUMB = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#1b1d21"/>' +
  '<circle cx="80" cy="45" r="30" fill="none" stroke="#7d818a" stroke-width="3"/><circle cx="80" cy="45" r="5" fill="#b8bbc2"/>' +
  '<text x="150" y="82" font-family="sans-serif" font-size="13" font-weight="700" fill="#b8bbc2" text-anchor="end">MP3</text></svg>');

class Deck {
  constructor(letter) {
    this.letter = letter;
    const frag = $('#deckTpl').content.cloneNode(true);
    this.el = frag.querySelector('.deck');
    this.el.classList.add('deck-' + letter.toLowerCase());
    $('.deck-letter', this.el).textContent = letter;
    $('#slot' + letter).replaceWith(this.el);
    const q = (s) => $(s, this.el);
    this.ui = {
      title: q('.t-title'), author: q('.t-author'), yt: q('.yt'), msg: q('.deck-msg'), kind: q('.kind-badge'),
      bar: q('.bar'), fill: q('.fill'), cueMark: q('.cue-mark'), loopZone: q('.loop-zone'), hotMarks: q('.hot-marks'),
      elapsed: q('.t-elapsed'), remain: q('.t-remain'), bpm: q('.t-bpm'), rate: q('.t-rate'),
      ad: q('.deck-ad'), play: q('.play'), hc: $$('.hc', this.el), loopExit: q('.l-exit'), tap: q('.tap'),
      wz: q('.wave-zoom'), wo: q('.wave-over'), leds: $$('.leds i', this.el), phrase: q('.t-phrase'),
      sync: q('.b-sync'), qBtn: q('.q-btn'), slider: q('.tempo-slider'), mfx: $$('.mfx', this.el),
      fileCtrls: q('.file-ctrls'), fxType: q('.fx-type'), fxOn: q('.fx-on'), pfl: q('.pfl'), keylock: q('.keylock'),
    };

    this.player = null;
    this.ready = false;
    this.state = PS.UNSTARTED;
    this.kind = 'yt';
    this.fe = null;            // motor de archivo (se crea al cargar el primer MP3)
    this.track = null;
    this.playing = false;      // lo que quiere el DJ (no siempre igual al estado del reproductor)
    this.preloading = false;   // YouTube: cargando en silencio para dejarla lista en pausa
    this.hasPlayed = false;
    this.err = null;
    this.duration = 0;
    this.rate = 1;             // tempo elegido
    this.bend = 1;             // empujón temporal (pitch bend, freno)
    this.ytRate = 1;           // velocidad real que informa YouTube
    this.cue = 0;
    this.hot = [null, null, null, null];
    this.bpm = null;
    this.beat1 = 0;
    this.taps = [];
    this.loop = { in: null, out: null, on: false };
    this.clock = { raw: 0, at: 0 };
    this.holdUntil = 0;
    this.outVolume = 100;
    this.loadToken = 0;
    this.pending = null;
    this.inAd = false;         // hay un anuncio sonando en esta bandeja
    this.adKind = false;
    this.loadedAt = 0;
    this.lastRaw = -1;
    this.lastRawAt = 0;
    this.nudged = 0;
    this.syncOn = false;
    this.mfx = null;           // efecto de mezcla activo (gate, freno, echo out)
    this.keyLock = true;
    this.pflOn = false;
    this.eq = { high: 0, mid: 0, low: 0 };
    this.filter = 0;
    this.fx = { type: 'echo', on: false, amount: 0.5 };
    this.peaks = null;
    this.peaksFine = null;

    this.knobs = {};
    for (const band of ['high', 'mid', 'low']) {
      this.knobs[band] = new Knob(q(`.kn-${band}`), { onInput: (v) => this.setEq(band, v) });
    }
    this.knobs.filter = new Knob(q('.kn-filter'), { onInput: (v) => this.setFilter(v) });
    this.knobs.fx = new Knob(q('.kn-fx'), { min: 0, max: 1, value: 0.5, def: 0.5, onInput: (v) => this.setFx({ amount: v }) });

    this.bindUI();
    this.switchKind('yt', true);
    this.render();
  }

  createPlayer() {
    this.player = new YT.Player(this.ui.yt, {
      width: '100%',
      height: '100%',
      playerVars: PLAYER_VARS,
      events: {
        onReady: () => {
          this.ready = true;
          this.player.setVolume(this.outVolume);
          if (this.pending) {
            const [track, opts] = this.pending;
            this.pending = null;
            this.load(track, opts);
          }
        },
        onStateChange: (e) => { if (this.kind === 'yt') this.onState(e.data); },
        onError: (e) => { if (this.kind === 'yt') this.onError(e.data); },
        onPlaybackRateChange: (e) => { this.ytRate = e.data; },
        onApiChange: () => this.applyCaptions(), // el módulo de subtítulos se carga con cada video
      },
    });
  }

  bindUI() {
    const on = (sel, fn, ev = 'click') => $(sel, this.el).addEventListener(ev, fn);
    on('.play', () => this.toggle());
    on('.cue', (e) => {
      if (e.shiftKey) { this.pause(); this.seek(this.cue); } else this.cuePress();
    });
    on('.back', () => this.seek(this.time() - 5));
    on('.fwd', () => this.seek(this.time() + 5));
    this.ui.hc.forEach((b, i) => {
      b.addEventListener('click', (e) => this.hotCue(i, e.shiftKey));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); this.hotCue(i, true); });
    });
    on('.q-btn', () => setQuantize(!settings.quantize));
    on('.l-in', () => this.loopIn());
    on('.l-out', () => this.loopOut());
    on('.l-exit', () => this.loopToggle());
    $$('.l-beat', this.el).forEach((b) => b.addEventListener('click', () => this.beatLoop(+b.dataset.beats)));
    on('.t-down', () => this.stepRate(-1));
    on('.t-up', () => this.stepRate(1));
    on('.t-reset', () => this.setRate(1));
    on('.tap', () => this.tap());
    on('.b-one', () => this.markOne());
    on('.b-sync', () => toggleSync(this));
    on('.tempo-slider', () => this.setRate(1 + this.ui.slider.value / 100), 'input');
    for (const [sel, dir] of [['.bend-down', -1], ['.bend-up', 1]]) {
      const b = $(sel, this.el);
      b.addEventListener('pointerdown', () => this.bendStart(dir));
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => this.bendStop());
    }
    this.ui.mfx.forEach((b) => b.addEventListener('click', () => mixFx.start(this, b.dataset.fx)));
    on('.fx-type', () => this.setFx({ type: this.ui.fxType.value }), 'change');
    on('.fx-on', () => this.setFx({ on: !this.fx.on }));
    on('.pfl', () => this.setPfl(!this.pflOn));
    on('.keylock', () => this.setKeyLock(!this.keyLock));
    on('.b-next', () => {
      const next = nextTrack(lastLoadedId);
      if (next) safeLoad(this, next);
      else toast('No hay más canciones en la lista');
    });
    this.ui.bar.addEventListener('click', (e) => {
      if (!this.duration) return;
      const r = this.ui.bar.getBoundingClientRect();
      this.seek((e.clientX - r.left) / r.width * this.duration);
    });

    // Forma de onda ampliada: arrastrar = mover la canción (como un plato); rueda = ajuste fino
    const wz = this.ui.wz;
    wz.addEventListener('pointerdown', (e) => {
      if (this.kind !== 'file' || !this.duration) return;
      wz.setPointerCapture(e.pointerId);
      const wasPlaying = this.playing;
      if (wasPlaying) this.fe.pause();
      let x0 = e.clientX;
      const move = (ev) => {
        const dt = -(ev.clientX - x0) / wz.clientWidth * WAVE_WINDOW;
        x0 = ev.clientX;
        this.seek(this.time() + dt);
      };
      const up = () => {
        wz.removeEventListener('pointermove', move);
        wz.removeEventListener('pointerup', up);
        if (wasPlaying && this.playing) this.fe.play();
      };
      wz.addEventListener('pointermove', move);
      wz.addEventListener('pointerup', up);
    });
    wz.addEventListener('wheel', (e) => {
      if (this.kind !== 'file') return;
      e.preventDefault();
      this.seek(this.time() + Math.sign(e.deltaY) * 0.01);
    }, { passive: false });

    // Soltar canciones arrastradas desde la lista o los resultados, o archivos de música del PC
    this.el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TRACK) && !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.el.classList.add('drop');
    });
    this.el.addEventListener('dragleave', (e) => {
      if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('drop');
    });
    this.el.addEventListener('drop', async (e) => {
      this.el.classList.remove('drop');
      if (e.dataTransfer.files?.length) {
        e.preventDefault();
        const added = await addAudioFiles([...e.dataTransfer.files]);
        if (added[0]) safeLoad(this, added[0]);
        return;
      }
      const data = e.dataTransfer.getData(DRAG_TRACK);
      if (!data) return;
      e.preventDefault();
      safeLoad(this, JSON.parse(data));
    });
  }

  // ----- Cambio entre YouTube y archivo -----
  switchKind(kind, force = false) {
    if (this.kind === kind && !force) return;
    if (kind === 'file' && this.ready) { try { this.player.stopVideo(); } catch { /* sin video */ } }
    if (kind === 'yt' && this.fe) this.fe.stop();
    this.kind = kind;
    this.el.classList.toggle('is-file', kind === 'file');
    this.ui.wz.hidden = kind !== 'file';
    this.ui.wo.hidden = kind !== 'file';
    const s = this.ui.slider;
    // YouTube cambia la velocidad en pasos de 0.05×; un archivo, de forma continua
    if (kind === 'yt') { s.min = -50; s.max = 50; s.step = 5; } else { s.min = -16; s.max = 16; s.step = 0.1; }
    this.setOutVolume(this.outVolume, true);
  }

  // Datos guardados de la canción: cues, BPM y tiempo 1
  applyTrackData(track) {
    const d = getCueData(track.id);
    this.cue = d.cue || 0;
    this.hot = Array.isArray(d.hot) ? [...d.hot] : [null, null, null, null];
    this.bpm = d.bpm || null;
    this.beat1 = d.beat1 || 0;
    this.loop = { in: null, out: null, on: false };
    this.taps = [];
    this.syncOn = false;
    mixFx.stop(this);
    this.bend = 1;
  }

  afterLoad(track) {
    lastLoadedId = track.id;
    playedIds.add(track.id);
    queueConsume(track.id);
    this.render();
    renderList();
    renderResults();
  }

  // ----- Carga -----
  load(track, { autoplay = false } = {}) {
    if (track.file) return this.loadFile(track, { autoplay });
    if (!this.ready) {
      this.pending = [track, { autoplay }];
      toast('Esperando al reproductor de YouTube…');
      return;
    }
    this.switchKind('yt');
    this.track = { id: track.id, title: track.title, author: track.author || '' };
    this.loadToken++;
    this.applyTrackData(track);
    this.duration = track.dur || 0;
    this.err = null;
    this.rate = 1;
    this.playing = autoplay;
    this.hasPlayed = autoplay;
    this.preloading = !autoplay;
    this.setMsg('');

    // Sin autoplay se carga en silencio y se pausa en el cue cuando la canción arranca,
    // así queda en memoria y cualquier anuncio inicial ya pasó.
    if (this.preloading) this.player.mute(); else this.player.unMute();
    this.player.loadVideoById({ videoId: track.id, startSeconds: this.cue });
    this.player.setPlaybackRate(1);
    this.ytRate = 1;
    const now = performance.now();
    this.clock = { raw: this.cue, at: now };
    this.holdUntil = now + 600;
    this.loadedAt = now;
    this.lastRaw = -1;
    this.lastRawAt = now;
    this.nudged = 0;
    this.setAd(false);
    this.afterLoad(track);
  }

  async loadFile(track, { autoplay = false } = {}) {
    this.switchKind('file');
    const token = ++this.loadToken;
    this.track = { id: track.id, title: track.title, author: track.author || 'Archivo local', file: true };
    this.applyTrackData(track);
    this.err = null;
    this.preloading = false;
    this.playing = false;
    this.hasPlayed = autoplay;
    this.state = PS.UNSTARTED;
    this.duration = track.dur || 0;
    this.rate = 1;
    this.peaks = this.peaksFine = null;
    this.setAd(false);
    this.setMsg('Cargando archivo…');
    this.afterLoad(track);
    try {
      const rec = await idb.get('files', track.id);
      if (!rec) throw new Error('No se encontró el archivo en este navegador: vuelve a agregarlo a la lista');
      if (token !== this.loadToken) return;
      this.fe ??= new FileEngine(this);
      this.applyAudioSettings();
      await this.fe.load(rec.blob);
      if (token !== this.loadToken) return;
      this.duration = this.fe.duration;
      forEachTrack(track.id, (t) => { if (!t.dur) { t.dur = Math.round(this.duration); savePlaylists(); } });
      this.fe.time = this.cue;
      this.applyEngineRate();
      this.state = PS.PAUSED;
      this.setMsg('');
      if (autoplay) this.play();
      this.render();
      this.analyzeFile(rec.blob, token);
    } catch (e) {
      if (token !== this.loadToken) return;
      this.err = e.message;
      this.setMsg('⚠ ' + e.message);
      this.render();
    }
  }

  // Forma de onda y BPM (en segundo plano: tarda un par de segundos)
  async analyzeFile(blob, token) {
    try {
      const buf = await audioAnalysis.decode(blob);
      if (token !== this.loadToken) return;
      this.peaks = audioAnalysis.peaks(buf, 1200);
      this.peaksFine = audioAnalysis.peaks(buf, Math.min(90000, Math.ceil(buf.duration * WAVE_RES)));
      this.drawOverview();
      if (!this.bpm) {
        const r = await audioAnalysis.bpm(buf);
        if (r && token === this.loadToken && !this.bpm) {
          this.bpm = r.bpm;
          this.beat1 = r.beat1;
          this.persist();
          toast(`BPM detectado en la bandeja ${this.letter}: ${r.bpm}`, 'ok');
        }
      }
    } catch { /* el navegador no pudo decodificarlo: sin forma de onda */ }
  }

  applyAudioSettings() {
    const fe = this.fe;
    if (!fe) return;
    for (const band of ['high', 'mid', 'low']) fe.setEq(band, this.eq[band]);
    fe.setFilter(this.filter);
    fe.fx.set(this.fx);
    if (this.bpm) fe.fx.setBeat(60 / this.bpm / this.effRate());
    fe.setPfl(this.pflOn);
    fe.setKeyLock(this.keyLock);
    fe.setVolume(this.outVolume / 100);
  }

  onState(s) {
    this.state = s;
    if (s === PS.PLAYING) {
      this.fixTitleFromPlayer();
      this.applyCaptions();
      // Precargando: se deja sonar en silencio (también un posible anuncio) y checkAd() la pausa
      // en el cue cuando la canción de verdad empieza a avanzar.
      if (!this.preloading && !this.playing) this.player.pauseVideo();
    } else if (s === PS.ENDED) {
      this.playing = false;
    }
    this.render();
  }

  onFileEnded() {
    if (this.kind !== 'file') return;
    this.playing = false;
    this.state = PS.ENDED;
    this.render();
  }

  onFileError() {
    if (this.kind !== 'file' || !this.track) return;
    this.err = 'El navegador no puede reproducir este archivo';
    this.playing = false;
    this.setMsg('⚠ ' + this.err);
    this.render();
  }

  onError(code) {
    this.err = YT_ERRORS[code] || `Error de YouTube (${code})`;
    this.playing = false;
    this.preloading = false;
    this.setMsg('⚠ ' + this.err);
    if (this.track && [100, 101, 150].includes(code)) markBlocked(this.track.id, this.err);
    this.render();
  }

  fixTitleFromPlayer() {
    if (!this.track) return;
    let info;
    try { info = this.player.getVideoData?.(); } catch { return; }
    if (!info || !info.title) return;
    const placeholder = (t) => !t || t === LOADING_TITLE || t.startsWith('Video ');
    if (placeholder(this.track.title)) {
      this.track.title = info.title;
      this.track.author = info.author || this.track.author;
      forEachTrack(this.track.id, (t) => {
        if (placeholder(t.title)) { t.title = info.title; t.author = info.author || t.author; }
      });
      savePlaylists();
      renderList();
    }
  }

  // Detecta anuncios: mientras YouTube pone un anuncio, el tiempo de la canción no avanza.
  checkAd() {
    if (this.kind !== 'yt' || !this.ready || !this.track || this.err) { this.setAd(false); return; }
    const now = performance.now();
    const raw = this.player.getCurrentTime() || 0;
    if (raw !== this.lastRaw) {
      this.lastRaw = raw;
      this.lastRawAt = now;
      const dur = this.player.getDuration();
      if (dur > 0 && dur !== this.duration && raw > 0) {
        this.duration = dur;
        forEachTrack(this.track.id, (t) => { if (!t.dur) { t.dur = Math.round(dur); savePlaylists(); } });
        this.render();
      }
    }
    if (this.preloading) {
      // Durante un anuncio el tiempo de la canción se queda en el cue; si avanzó, ya es la canción.
      if (raw > this.cue + 0.1 || now - this.loadedAt > 90000) return this.finishPreload();
      // El navegador a veces pausa los videos en silencio: insistir cada 2 s
      if (now - this.loadedAt > 1500 && now - (this.nudged || 0) > 2000 &&
          this.state !== PS.PLAYING && this.state !== PS.BUFFERING) {
        this.nudged = now;
        this.player.playVideo();
      }
      this.setAd(now - this.loadedAt > 2500 ? 'prep' : false);
      return;
    }
    this.setAd(this.playing && this.state === PS.PLAYING && now - this.lastRawAt > 1500 ? 'ad' : false);
  }

  finishPreload() {
    this.preloading = false;
    this.player.pauseVideo();
    this.player.seekTo(this.cue, true);
    this.clock = { raw: this.cue, at: performance.now() };
    this.holdUntil = performance.now() + 400;
    setTimeout(() => { if (!this.preloading) this.player.unMute(); }, 350);
    this.setAd(false);
    this.render();
  }

  setAd(kind) {
    const inAd = kind === 'ad';
    if (inAd === this.inAd && kind === this.adKind) return;
    this.inAd = inAd;
    this.adKind = kind;
    this.ui.ad.hidden = !kind;
    this.ui.ad.textContent = kind === 'ad'
      ? 'Anuncio de YouTube en curso — oculto en la proyección'
      : 'Preparando… si YouTube pone un anuncio, pasa aquí en silencio';
  }

  // Subtítulos (CC) según la casilla del mezclador
  applyCaptions(force = false) {
    if (!this.ready || this.kind !== 'yt') return;
    // Evita repetirlo en bucle: activar el módulo vuelve a disparar onApiChange
    const now = performance.now();
    if (!force && now - (this.capsAt || 0) < 400) return;
    this.capsAt = now;
    this.capsCount = (this.capsCount || 0) + 1;
    setCaptions(this.player, settings.captions);
  }

  // YouTube vuelve a activar los subtítulos por su cuenta (p. ej. si el video está en otro idioma
  // o la cuenta los tiene siempre activos): con la casilla apagada se quitan cada segundo.
  enforceCaptions() {
    if (settings.captions || !this.ready || !this.track || this.kind !== 'yt') return;
    const now = performance.now();
    if (now - (this.capsAt || 0) < 1000) return;
    this.capsAt = now;
    setCaptions(this.player, false);
  }

  setMsg(text) {
    this.ui.msg.textContent = text;
    this.ui.msg.hidden = !text;
  }

  // ----- Tiempo -----
  // YouTube: interpolado entre las actualizaciones del reproductor. Archivo: exacto.
  time() {
    if (!this.track) return 0;
    if (this.kind === 'file') return this.fe ? this.fe.time : 0;
    if (!this.ready) return 0;
    const now = performance.now();
    if (now >= this.holdUntil) {
      const raw = this.player.getCurrentTime() || 0;
      if (raw !== this.clock.raw) this.clock = { raw, at: now };
    }
    const running = this.playing && this.state === PS.PLAYING && !this.inAd;
    return this.clock.raw + (running ? Math.min(1, (now - this.clock.at) / 1000) * this.ytRate : 0);
  }

  seek(t) {
    if (!this.track || this.err) return;
    const max = this.duration > 0 ? this.duration - 0.1 : Infinity;
    t = clamp(t, 0, max);
    if (this.kind === 'file') {
      if (this.fe) this.fe.time = t;
      return;
    }
    if (!this.ready) return;
    this.player.seekTo(t, true);
    this.clock = { raw: t, at: performance.now() };
    this.holdUntil = performance.now() + 400;
  }

  // ----- Transporte -----
  play() {
    if (!this.track || this.err) return;
    if (this.kind === 'file') {
      if (!this.fe || !this.duration) return;
      if (this.state === PS.ENDED) this.fe.time = this.cue;
      this.playing = true;
      this.hasPlayed = true;
      this.state = PS.PLAYING;
      this.fe.play();
      this.render();
      return;
    }
    if (!this.ready) return;
    this.preloading = false;
    this.player.unMute();
    if (this.state === PS.ENDED) this.seek(this.cue);
    this.playing = true;
    this.hasPlayed = true;
    this.player.playVideo();
    this.render();
  }

  pause() {
    if (!this.track) return;
    this.playing = false;
    if (this.kind === 'file') {
      this.fe?.pause();
      if (this.state !== PS.ENDED) this.state = PS.PAUSED;
    } else if (this.ready) {
      this.player.pauseVideo();
    }
    this.render();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  // Estilo CDJ: sonando → vuelve al cue y pausa; en pausa → guarda el cue donde está.
  cuePress() {
    if (!this.track || this.err) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cue);
      return;
    }
    const t = beatGrid.snap(this, this.time());
    if (Math.abs(t - this.cue) < 0.05) return;
    this.cue = t;
    this.persist();
    toast(`Cue de ${this.letter} guardado en ${fmt(t)}`);
  }

  hotCue(i, remove = false) {
    if (!this.track || this.err) return;
    if (remove) {
      if (this.hot[i] != null) { this.hot[i] = null; this.persist(); }
      return;
    }
    if (this.hot[i] == null) {
      this.hot[i] = beatGrid.snap(this, this.time());
      this.persist();
      return;
    }
    const target = this.hot[i];
    if (!this.playing) { this.seek(target); this.play(); return; }
    quantizedJump(this, () => this.seek(target));
  }

  persist() {
    if (!this.track) return;
    const d = getCueData(this.track.id);
    d.cue = this.cue;
    d.hot = [...this.hot];
    d.bpm = this.bpm;
    d.beat1 = this.beat1;
    saveCues();
    if (this.fe && this.bpm) this.fe.fx.setBeat(60 / this.bpm / this.effRate());
    this.render();
  }

  // ----- Loops -----
  loopIn() {
    if (!this.track) return;
    this.loop = { in: beatGrid.snap(this, this.time()), out: null, on: false };
    this.render();
  }

  loopOut() {
    if (!this.track) return;
    if (this.loop.in == null) return toast('Primero marca el inicio del loop con IN');
    let t = beatGrid.snap(this, this.time());
    if (t <= this.loop.in + 0.05) t = this.loop.in + (beatGrid.beatLen(this) || 0.5);
    this.loop.out = t;
    this.loop.on = true;
    this.seek(this.loop.in);
    this.render();
  }

  loopToggle() {
    if (this.loop.in == null || this.loop.out == null) return;
    this.loop.on = !this.loop.on;
    if (this.loop.on) this.seek(this.loop.in);
    this.render();
  }

  beatLoop(beats) {
    if (!this.track) return;
    if (!this.bpm) return toast('Marca el BPM con TAP para usar loops por tiempos');
    const t = beatGrid.snap(this, this.time());
    this.loop = { in: t, out: t + beats * 60 / this.bpm, on: true };
    this.render();
  }

  // ----- Tempo -----
  effRate() { return this.rate * this.bend; }

  // Envía al motor la velocidad final (tempo × empujón)
  applyEngineRate() {
    const r = this.effRate();
    if (this.kind === 'file') {
      this.fe?.setRate(r);
      return;
    }
    if (!this.ready || !this.track) return;
    const q = clamp(Math.round(r / 0.05) * 0.05, 0.25, 2);
    const t = this.time();
    this.player.setPlaybackRate(q);
    this.ytRate = q;
    this.clock = { raw: t, at: performance.now() };
  }

  setRate(r, { fromSync = false } = {}) {
    if (!this.track) return;
    if (!fromSync && this.syncOn) this.syncOn = false; // mover el tempo a mano suelta el SYNC
    r = this.kind === 'yt' ? clamp(Math.round(r / 0.05) * 0.05, 0.25, 2) : clamp(r, 0.5, 2);
    this.rate = Math.round(r * 10000) / 10000;
    this.applyEngineRate();
    if (this.fe && this.bpm) this.fe.fx.setBeat(60 / this.bpm / this.effRate());
    this.render();
  }

  stepRate(dir) { this.setRate(this.rate + dir * (this.kind === 'yt' ? 0.05 : 0.01)); }

  // Pitch bend: acelera o frena un poco mientras se mantiene el botón (para empatar golpes a mano)
  bendStart(dir) {
    if (!this.track || !this.playing) return;
    this.bend = 1 + dir * (this.kind === 'yt' ? 0.05 : 0.04);
    this.applyEngineRate();
  }

  bendStop() {
    if (this.bend === 1 || this.mfx?.type === 'brake') return;
    this.bend = 1;
    this.applyEngineRate();
  }

  // Rueda de la controladora MIDI: sonando = empujón; en pausa = mover la posición
  jog(delta) {
    if (!this.track) return;
    if (!this.playing) { this.seek(this.time() + delta * 0.02); return; }
    this.bend = clamp(1 + delta * 0.012, 0.7, 1.3);
    this.applyEngineRate();
    clearTimeout(this.jogTimer);
    this.jogTimer = setTimeout(() => this.bendStop(), 120);
  }

  tap() {
    if (!this.track) return;
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1].at > 2000) this.taps = [];
    this.taps.push({ at: now, t: this.time() });
    if (this.taps.length > 9) this.taps.shift();
    this.ui.tap.classList.add('flash');
    setTimeout(() => this.ui.tap.classList.remove('flash'), 90);
    if (this.taps.length >= 4) {
      const first = this.taps[0], last = this.taps[this.taps.length - 1];
      const interval = (last.at - first.at) / (this.taps.length - 1);
      this.bpm = Math.round(60000 / interval / this.effRate() * 10) / 10; // BPM original del tema
      // El primer toque marca el tiempo 1: se promedian todos los toques sobre la grilla
      const len = 60 / this.bpm;
      this.beat1 = this.taps.reduce((s, tp, i) => s + tp.t - i * len, 0) / this.taps.length;
      this.persist();
    }
  }

  // Marca el «tiempo 1» del compás en este instante (para el contador y quantize)
  markOne() {
    if (!this.track) return;
    this.beat1 = Math.max(0, this.time() - (this.playing ? 0.03 : 0));
    this.persist();
    toast(`Tiempo 1 de ${this.letter} marcado en ${fmt(this.beat1)}${this.bpm ? '' : ' (falta el BPM: usa TAP)'}`);
  }

  // ----- EQ, filtro, efectos (solo archivos) -----
  setEq(band, v) { this.eq[band] = v; this.fe?.setEq(band, v); }
  setFilter(v) { this.filter = v; this.fe?.setFilter(v); }
  setFx(change) {
    Object.assign(this.fx, change);
    if (this.fe) {
      this.fe.fx.set(this.fx);
      if (this.bpm) this.fe.fx.setBeat(60 / this.bpm / this.effRate());
    }
    this.syncFxUi();
  }
  syncFxUi() {
    const fx = this.fe ? this.fe.fx : this.fx;
    this.ui.fxType.value = fx.type;
    this.ui.fxOn.classList.toggle('on', !!fx.on);
    this.knobs.fx.set(fx.amount);
  }
  setPfl(on) {
    this.pflOn = on;
    this.fe?.setPfl(on);
    if (on && !audioEngine.bus.cueAudio?.srcObject) audioEngine.init();
    if (on && settings.cueDevice == null) toast('Elige la salida de audífonos en «Extras → Audífonos» para escuchar la pre-escucha');
    this.render();
  }
  setKeyLock(on) {
    this.keyLock = on;
    this.fe?.setKeyLock(on);
    this.render();
  }

  // ----- Volumen y estado -----
  setOutVolume(v, force = false) {
    if (v === this.outVolume && !force) return;
    this.outVolume = v;
    if (this.kind === 'file') this.fe?.setVolume(v / 100);
    else if (this.ready) this.player.setVolume(v);
  }

  isOnAir() { return this.playing && this.outVolume > 5; }

  render() {
    const u = this.ui, t = this.track, dur = this.duration;
    const pct = (x) => `${clamp(x / dur, 0, 1) * 100}%`;
    this.el.classList.toggle('loaded', !!t);
    u.title.textContent = t ? t.title : 'Bandeja vacía';
    u.author.textContent = t ? t.author : 'Usa los botones A / B de la lista o arrastra una canción o un MP3';
    u.kind.textContent = !t ? '' : this.kind === 'file' ? 'MP3' : 'YouTube';
    u.play.textContent = this.playing ? '❚❚' : '▶';
    u.play.classList.toggle('on', this.playing);

    u.cueMark.hidden = !t || !dur;
    if (dur) u.cueMark.style.left = pct(this.cue);
    u.hotMarks.innerHTML = !dur ? '' : this.hot
      .map((h, i) => (h == null ? '' : `<span style="left:${pct(h)}">${i + 1}</span>`)).join('');
    u.hc.forEach((b, i) => {
      const set = this.hot[i] != null;
      b.classList.toggle('set', set);
      b.title = set ? `Ir a ${fmt(this.hot[i])} (clic derecho o Mayús+clic: borrar)` : 'Guardar un hot cue aquí';
    });
    u.qBtn.classList.toggle('on', !!settings.quantize);

    const lp = this.loop;
    u.loopZone.hidden = lp.in == null || !dur;
    if (lp.in != null && dur) {
      u.loopZone.style.left = pct(lp.in);
      u.loopZone.style.width = lp.out != null ? `${(lp.out - lp.in) / dur * 100}%` : '0';
      u.loopZone.classList.toggle('on', lp.on);
    }
    u.loopExit.textContent = lp.on ? 'SALIR' : 'RELOOP';
    u.loopExit.classList.toggle('on', lp.on);
    u.loopExit.disabled = lp.out == null;

    u.bpm.textContent = this.bpm ? `${(this.bpm * this.rate).toFixed(1)} BPM` : '— BPM';
    const pctRate = (this.rate - 1) * 100;
    u.rate.textContent = `${pctRate >= 0 ? '+' : ''}${pctRate.toFixed(this.kind === 'yt' ? 0 : 1)}%`;
    u.rate.title = `${this.rate.toFixed(this.kind === 'yt' ? 2 : 3)}×`;
    if (document.activeElement !== u.slider) u.slider.value = pctRate;
    u.sync.classList.toggle('on', this.syncOn);
    u.mfx.forEach((b) => b.classList.toggle('on', this.mfx?.type === b.dataset.fx));

    const isFile = this.kind === 'file';
    u.fileCtrls.classList.toggle('disabled', !isFile);
    u.fileCtrls.title = isFile ? '' : 'Ecualizador y efectos: solo en bandejas con archivos MP3 (YouTube no deja procesar su audio)';
    Object.values(this.knobs).forEach((k) => k.el.classList.toggle('disabled', !isFile));
    u.fxType.disabled = !isFile;
    u.fxOn.disabled = u.pfl.disabled = u.keylock.disabled = !isFile;
    u.pfl.classList.toggle('on', this.pflOn);
    u.keylock.classList.toggle('on', this.keyLock);
    this.syncFxUi();
  }

  renderTick() {
    this.checkAd();
    const t = this.time(), dur = this.duration, u = this.ui;
    u.fill.style.width = dur > 0 ? `${clamp(t / dur, 0, 1) * 100}%` : '0';
    u.elapsed.textContent = fmt(t);
    const remain = dur > 0 ? dur - t : 0;
    u.remain.textContent = '-' + fmt(remain);
    u.remain.classList.toggle('warn', this.playing && dur > 0 && remain < 30);

    // Contador de tiempos (1-2-3-4) y compás dentro de la frase
    const b = beatGrid.beats(this, t);
    if (b == null || !this.track) {
      u.leds.forEach((l) => l.classList.remove('on', 'one'));
      u.phrase.textContent = '—';
    } else {
      const beat = ((Math.floor(b) % 4) + 4) % 4;
      const bar = Math.floor(b / 4);
      u.leds.forEach((l, i) => { l.classList.toggle('on', i === beat); l.classList.toggle('one', i === 0); });
      u.phrase.textContent = `Compás ${((bar % PHRASE_BARS) + PHRASE_BARS) % PHRASE_BARS + 1}/${PHRASE_BARS}`;
    }
    if (this.kind === 'file') this.drawZoom(t);
    return t;
  }

  // ----- Forma de onda -----
  fitCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return [w, h, dpr];
  }

  drawOverview() {
    const c = this.ui.wo;
    if (!this.peaks || !c.clientWidth) return;
    const [w, h] = this.fitCanvas(c);
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(184,187,194,.55)';
    const p = this.peaks;
    for (let x = 0; x < w; x++) {
      const v = p[Math.floor(x / w * p.length)] || 0;
      const bh = Math.max(1, v * h * 0.92);
      g.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }

  drawZoom(t) {
    const c = this.ui.wz;
    if (!c.clientWidth) return;
    const [w, h, dpr] = this.fitCanvas(c);
    const g = c.getContext('2d');
    g.fillStyle = '#0a0b0d';
    g.fillRect(0, 0, w, h);
    const t0 = t - WAVE_WINDOW / 2;
    const xOf = (time) => (time - t0) / WAVE_WINDOW * w;

    // Grilla de tiempos
    if (this.bpm) {
      const len = 60 / this.bpm;
      const first = Math.ceil((t0 - this.beat1) / len);
      for (let k = first; ; k++) {
        const bt = this.beat1 + k * len;
        if (bt > t0 + WAVE_WINDOW) break;
        const down = ((k % 4) + 4) % 4 === 0;
        g.fillStyle = down ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.09)';
        g.fillRect(Math.round(xOf(bt)), 0, down ? 2 * dpr : dpr, h);
      }
    }
    // Loop
    if (this.loop.in != null && this.loop.out != null) {
      g.fillStyle = this.loop.on ? 'rgba(45,212,191,.22)' : 'rgba(45,212,191,.1)';
      g.fillRect(xOf(this.loop.in), 0, xOf(this.loop.out) - xOf(this.loop.in), h);
    }
    // Onda
    const p = this.peaksFine;
    if (p) {
      for (let x = 0; x < w; x++) {
        const time = t0 + x / w * WAVE_WINDOW;
        if (time < 0 || time > this.duration) continue;
        const v = p[Math.floor(time * WAVE_RES)] || 0;
        const bh = Math.max(dpr, v * h * 0.9);
        g.fillStyle = time < t ? 'rgba(244,244,245,.9)' : 'rgba(150,154,162,.75)';
        g.fillRect(x, (h - bh) / 2, 1, bh);
      }
    } else {
      g.fillStyle = '#7d818a';
      g.font = `${12 * dpr}px Manrope, sans-serif`;
      g.textAlign = 'center';
      g.fillText('Analizando la forma de onda…', w / 2, h / 2);
    }
    // Cue y hot cues
    const mark = (time, color, label) => {
      if (time == null || time < t0 || time > t0 + WAVE_WINDOW) return;
      const x = Math.round(xOf(time));
      g.fillStyle = color;
      g.fillRect(x - dpr, 0, 2 * dpr, h);
      if (label) {
        g.fillRect(x - dpr, 0, 14 * dpr, 14 * dpr);
        g.fillStyle = '#000';
        g.font = `700 ${10 * dpr}px JetBrains Mono, monospace`;
        g.textAlign = 'left';
        g.fillText(label, x + 2 * dpr, 11 * dpr);
      }
    };
    mark(this.cue, '#fbbf24');
    ['#f87171', '#fb923c', '#facc15', '#a78bfa'].forEach((col, i) => mark(this.hot[i], col, String(i + 1)));
    // Cabezal
    g.fillStyle = '#ef4444';
    g.fillRect(Math.round(w / 2) - dpr, 0, 2 * dpr, h);
  }
}

const WAVE_WINDOW = 6;   // segundos visibles en la onda ampliada
const WAVE_RES = 50;     // columnas por segundo de la onda ampliada

const decks = { A: new Deck('A'), B: new Deck('B') };
const deckList = [decks.A, decks.B];
let ytReady = false;

window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  deckList.forEach((d) => d.createPlayer());
};

function safeLoad(deck, track) {
  if (!track) return;
  if (deck.isOnAir() &&
      !confirm(`La bandeja ${deck.letter} está sonando al aire.\n¿Cargar «${track.title}» de todas formas?`)) return;
  deck.load(track);
}

const offAirDeck = () => (mixer.xf < 0.5 ? decks.B : decks.A);

// Siguiente canción: primero la cola; si está vacía, la que sigue a `afterId` en la lista activa
// (o la primera sin sonar).
function nextTrack(afterId) {
  const queued = queuePeek();
  if (queued) return queued;
  const tracks = curPl().tracks;
  const i = afterId ? tracks.findIndex((t) => t.id === afterId) : -1;
  if (i < 0) return tracks.find((t) => !playedIds.has(t.id) && !t.blocked) || null;
  for (let k = i + 1; k < tracks.length; k++) if (!tracks[k].blocked) return tracks[k];
  return null;
}

// =====================================================================
// Mezclador
// =====================================================================
const mixer = { xf: 0, blackout: false };
let fade = null;
let automixOn = false;
let automixPrepared = null;
let automixEndNotified = false;

function xfGains(x, curve) {
  if (curve === 'linear') return [1 - x, x];
  if (curve === 'cut') return [x > 0.95 ? (1 - x) / 0.05 : 1, x < 0.05 ? x / 0.05 : 1];
  return [Math.cos(x * Math.PI / 2), Math.sin(x * Math.PI / 2)]; // potencia constante
}

// Volumen final de cada bandeja: canal × crossfader × master × talkover del micrófono × efecto de mezcla
function applyVolumes() {
  const [ga, gb] = xfGains(mixer.xf, settings.curve);
  const m = settings.master / 100 * duckLevel;
  const now = performance.now();
  decks.A.setOutVolume(Math.round(m * (settings.volA / 100) * ga * mixFx.gain(decks.A, now) * 100));
  decks.B.setOutVolume(Math.round(m * (settings.volB / 100) * gb * mixFx.gain(decks.B, now) * 100));
}

let duckLevel = 1; // lo baja el micrófono mientras hablas (talkover)

function setQuantize(on) {
  settings.quantize = on;
  saveSettings();
  deckList.forEach((d) => d.render());
  toast(on ? 'Quantize activado: cues, hot cues y loops caen exactos en el tiempo' : 'Quantize desactivado');
}

// ¿Se puede usar un atajo de teclado ahora? (no mientras se escribe o hay un diálogo abierto)
function shortcutAllowed(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return false;
  if (document.querySelector('dialog[open]')) return false;
  const tg = e.target;
  if (tg.isContentEditable || tg.matches?.('textarea, select, input:not([type=range]):not([type=checkbox])')) return false;
  if (tg.matches?.('input[type=range]') && e.code.startsWith('Arrow')) return false;
  return true;
}

function setXf(v, byUser = false) {
  if (byUser) stopFade();
  mixer.xf = clamp(v, 0, 1);
  $('#xfader').value = Math.round(mixer.xf * 1000);
  applyVolumes();
}

// Cruza hacia 'A' o 'B' (por defecto, hacia la bandeja que no está al aire).
function autoFade(toward, seconds = settings.fadeTime, onDone) {
  const target = toward === 'A' ? 0 : toward === 'B' ? 1 : (mixer.xf < 0.5 ? 1 : 0);
  const incoming = target === 1 ? decks.B : decks.A;
  if (incoming.track && !incoming.playing && !incoming.err) incoming.play();
  stopFade();
  const from = mixer.xf, t0 = performance.now(), ms = Math.max(100, seconds * 1000);
  $('#btnAutoFade').classList.add('active');
  fade = {
    timer: setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      setXf(from + (target - from) * e);
      if (k >= 1) {
        stopFade();
        onDone?.();
      }
    }, 30),
  };
}

function stopFade() {
  if (!fade) return;
  clearInterval(fade.timer);
  fade = null;
  $('#btnAutoFade').classList.remove('active');
}

function setAutomix(on) {
  automixOn = on;
  $('#automix').checked = on;
  automixPrepared = null;
  automixEndNotified = false;
  if (on) toast(`AutoMix activado: mezcla la lista «${curPl().name}» con fundidos de ${settings.fadeTime} s`, 'ok');
}

function automixTick() {
  if (!automixOn || fade || !ytReady) return;
  const live = mixer.xf < 0.5 ? decks.A : decks.B;
  const other = live === decks.A ? decks.B : decks.A;

  // Nada sonando en el lado al aire: arrancar algo
  if (!live.track || live.err || (!live.playing && !live.preloading)) {
    if (other.playing && !other.err) { autoFade(other.letter, 2); return; }
    if (other.track && !other.err && other.preloading) return; // espera a que termine su anuncio
    if (other.track && !other.err && !other.hasPlayed) { autoFade(other.letter, 2); return; }
    if (live.track && !live.err && live.state !== PS.ENDED) { live.play(); return; }
    const next = nextTrack(live.track?.id || lastLoadedId);
    if (!next) {
      if (!automixEndNotified) toast('AutoMix: se terminó la lista');
      automixEndNotified = true;
      return;
    }
    live.load(next, { autoplay: true });
    return;
  }

  // Dejar preparada la siguiente en la otra bandeja (una vez por canción al aire)
  const token = live.letter + live.loadToken;
  if (automixPrepared !== token) {
    automixPrepared = token;
    if (!other.playing && (!other.track || other.hasPlayed || other.err)) {
      const next = nextTrack(live.track.id);
      if (next) other.load(next);
    }
  }
  if (other.err && other.track && !other.playing) {
    const next = nextTrack(other.track.id);
    if (next) other.load(next);
    return;
  }

  // Cuando falta poco, cruzar (terminando justo antes de las miniaturas del final)
  const remain = live.duration - live.time();
  if (live.duration > 0 && !live.loop.on && remain <= mixPoint(live) + 0.5) {
    if (!other.track || other.err) {
      if (!automixEndNotified) toast('AutoMix: no hay más canciones en la lista');
      automixEndNotified = true;
      return;
    }
    if (other.preloading) return; // la siguiente aún está en un anuncio: no cruzar todavía
    crossToNext(live, other, remain);
  }
}

// Segundos antes del final en que empieza el cruce: el fundido termina justo donde
// empieza el tramo oculto del video (las miniaturas de YouTube).
// En videos cortos no se oculta el final: si no, se taparía casi todo el video.
// Los archivos MP3 no tienen pantalla final de YouTube: nunca se ocultan.
const tailFor = (d) => (d.kind === 'yt' && settings.hideTail > 0 && d.duration > settings.hideTail + 30 ? settings.hideTail : 0);
const mixPoint = (d) => settings.fadeTime + tailFor(d);

function crossToNext(outgoing, incoming, remain) {
  const seconds = clamp(remain - tailFor(outgoing), 1, settings.fadeTime);
  autoFade(incoming.letter, seconds, () => outgoing.pause());
}

// Sin AutoMix: si está activada la casilla, la canción al aire pasa sola a la siguiente
// antes de las miniaturas. Respeta lo que hace el DJ: si ya arrancó la otra bandeja, no toca nada.
let autoNextPrepared = null;
function autoNextTick() {
  if (automixOn || !settings.autoNext || fade || !ytReady) return;
  const live = mixer.xf < 0.5 ? decks.A : decks.B;
  const other = live === decks.A ? decks.B : decks.A;
  if (!live.track || !live.playing || live.preloading || live.loop.on || live.duration <= 0) return;
  if (other.playing) return;
  const remain = live.duration - live.time();

  // Dejar lista la siguiente con tiempo (por si YouTube mete un anuncio al cargarla)
  const token = live.letter + live.loadToken;
  if (remain <= mixPoint(live) + 45 && autoNextPrepared !== token) {
    autoNextPrepared = token;
    if (!other.track || other.hasPlayed || other.err) {
      const next = nextTrack(live.track.id);
      if (next) other.load(next);
    }
  }
  if (other.err && other.track) {
    const next = nextTrack(other.track.id);
    if (next) other.load(next);
    return;
  }
  if (remain <= mixPoint(live) + 0.5 && other.track && !other.preloading && !other.hasPlayed) {
    crossToNext(live, other, remain);
  }
}

// =====================================================================
// Proyección (otra ventana, mismo PC)
// =====================================================================
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('djyoutube') : null;
let projWin = null;
let projLastSeen = 0;
let projVersion = null;

if (channel) {
  channel.onmessage = (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'hello' || m.type === 'alive') {
      projLastSeen = Date.now();
      projVersion = m.version || null; // las versiones viejas no la envían
    }
    if (m.type === 'hello') { publish(); sendLogo(); }
  };
}

function videoOpacity() {
  // Una bandeja preparándose o en un anuncio no se muestra: se ve la otra o queda en negro.
  // Tampoco su tramo final, donde YouTube pone miniaturas de otros videos (pantalla final).
  const inTail = (d) => tailFor(d) > 0 && d.duration - d.time() < tailFor(d);
  const ok = (d) => !!(d.track && !d.err && d.state !== PS.ENDED && !d.preloading && !d.inAd && !inTail(d));
  const a = ok(decks.A), b = ok(decks.B);
  if (settings.videoMode === 'A') return [a ? 1 : 0, 0];
  if (settings.videoMode === 'B') return [0, b ? 1 : 0];
  return [a ? 1 : 0, b ? (a ? mixer.xf : 1) : 0];
}

function deckState(d) {
  const ok = d.track && !d.err;
  return {
    kind: d.kind,                                   // 'yt' = video; 'file' = visualizador
    videoId: ok && d.kind === 'yt' ? d.track.id : null,
    file: ok && d.kind === 'file',
    playing: d.playing && !d.preloading,
    time: d.time(),
    rate: d.kind === 'yt' ? d.ytRate : d.effRate(),
    ended: d.state === PS.ENDED,
    title: d.track?.title || '',
    author: d.track?.author || '',
  };
}

// Ritmo de la bandeja que se ve al frente, para los efectos de video al compás
function beatState(d) {
  const b = beatGrid.beats(d);
  return b == null ? null : { beats: b, bpm: d.bpm * d.effRate(), playing: d.playing };
}

function publish() {
  const [oa, ob] = videoOpacity();
  $('#vmixFill').style.width = `${(oa ? ob : 1) * 100}%`;
  $('.vmix').classList.toggle('black', mixer.blackout || (!oa && !ob));
  if (!channel) return;
  channel.postMessage({
    type: 'state',
    sentAt: Date.now(),
    decks: { A: deckState(decks.A), B: deckState(decks.B) },
    opacity: { A: oa, B: ob },
    front: ob > 0.5 || !oa ? 'B' : 'A',
    beat: beatState(ob > 0.5 || !oa ? decks.B : decks.A),
    blackout: mixer.blackout,
    overlayText: settings.overlayText,
    showTitle: settings.showTitle,
    captions: settings.captions,
    vfx: settings.vfx,
  });
}

async function openProjector() {
  const name = 'djyt-proyeccion';
  const url = `proyeccion.html?v=${APP_VERSION}`;
  const connected = Date.now() - projLastSeen < 3000;
  // Ya abierta y con el código actual: solo traerla al frente
  if (connected && projVersion === APP_VERSION) {
    const w = projWin && !projWin.closed ? projWin : window.open('', name);
    w?.focus();
    toast('La ventana de proyección ya está abierta');
    return;
  }
  // Abierta pero con una versión vieja (p. ej. de antes de una actualización): recargarla
  if (connected || (projWin && !projWin.closed)) {
    projWin = window.open(url, name);
    projWin?.focus();
    toast('La ventana de proyección se actualizó a la última versión', 'ok');
    return;
  }
  let features = 'popup=yes,width=1280,height=720';
  let placed = false;
  // Con un segundo monitor/proyector en modo «Extender», Chrome/Edge permiten abrirla directamente allí.
  if (window.screen.isExtended && 'getScreenDetails' in window) {
    try {
      const details = await window.getScreenDetails();
      const other = details.screens.find((s) => s !== details.currentScreen);
      if (other) {
        features = `popup=yes,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
        placed = true;
      }
    } catch { /* permiso denegado: se abre en esta pantalla */ }
  }
  projWin = window.open(url, name, features);
  if (!projWin) {
    toast('El navegador bloqueó la ventana. Pulsa otra vez «Abrir proyección» o permite ventanas emergentes para esta página.', 'error');
    return;
  }
  toast(placed
    ? 'Proyección abierta en la otra pantalla. Haz doble clic en ella para pantalla completa.'
    : 'Arrastra la ventana de proyección a la pantalla o proyector y haz doble clic para pantalla completa.', 'ok');
}

function updateProjStatus() {
  const on = Date.now() - projLastSeen < 3000;
  const pill = $('#projStatus');
  pill.textContent = on ? '● Proyección conectada' : 'Proyección cerrada';
  pill.classList.toggle('on', on);
}

function toggleBlackout() {
  mixer.blackout = !mixer.blackout;
  $('#btnBlackout').classList.toggle('on', mixer.blackout);
  $('#btnBlackout').textContent = mixer.blackout ? 'Pantalla negra (activa)' : 'Pantalla negra';
  publish();
}

// =====================================================================
// Listas
// =====================================================================
let listRenderQueued = false;
function renderList() {
  if (listRenderQueued) return;
  listRenderQueued = true;
  requestAnimationFrame(() => { listRenderQueued = false; drawList(); });
}

function trackRow(t, attrs, { num = '', inA, inB, actions }) {
  const cls = ['track'];
  if (inA) cls.push('on-a');
  if (inB) cls.push('on-b');
  if (playedIds.has(t.id)) cls.push('played');
  if (t.blocked) cls.push('blocked');
  const meta = [t.author, t.dur ? fmt(t.dur) : ''].filter(Boolean).map(esc).join(' · ');
  const badges = (inA ? '<span class="badge a">A</span>' : '') + (inB ? '<span class="badge b">B</span>' : '') +
    (isQueued(t.id) ? '<span class="badge q" title="Está en la cola">COLA</span>' : '') +
    (t.blocked ? `<span class="badge bad" title="${esc(t.note || '')}">NO DISPONIBLE</span>` : '');
  return `<li class="${cls.join(' ')}" draggable="true" ${attrs}>
    <span class="num">${num}</span>
    <img src="${t.file ? FILE_THUMB : thumb(t.id)}" alt="" loading="lazy">
    <div class="info"><div class="title" title="${esc(t.title)}">${badges}${esc(t.title)}</div>
      <div class="meta">${meta}${trackChips(t.id)}</div></div>
    <div class="acts">${actions}</div>
  </li>`;
}

// BPM, tonalidad, energía y etiquetas guardadas en la ficha de la canción
function trackChips(id) {
  const d = cueData[id];
  if (!d) return '';
  const chips = [];
  if (d.bpm) chips.push(`<span class="chip">${d.bpm.toFixed(1)} BPM</span>`);
  if (d.key) chips.push(`<span class="chip">${esc(d.key)}</span>`);
  if (d.energy) chips.push(`<span class="chip" title="Energía">${'●'.repeat(d.energy)}${'○'.repeat(5 - d.energy)}</span>`);
  for (const tag of (d.tags || []).slice(0, 3)) chips.push(`<span class="chip tag">${esc(tag)}</span>`);
  return chips.length ? ` <span class="chips">${chips.join('')}</span>` : '';
}

const LIST_ACTIONS = `
  <button class="btn small la" data-act="A" title="Cargar en la bandeja A">A</button>
  <button class="btn small lb" data-act="B" title="Cargar en la bandeja B">B</button>
  <button class="btn small" data-act="queue" title="Agregar a la cola (suena después de la actual)">+Cola</button>
  <button class="btn small" data-act="info" title="Ficha: BPM, tonalidad, energía, etiquetas y notas">✎</button>
  <button class="btn small" data-act="up" title="Subir">↑</button>
  <button class="btn small" data-act="down" title="Bajar">↓</button>
  <button class="btn small danger" data-act="del" title="Quitar de la lista">✕</button>`;

// Orden de la lista en pantalla (no cambia el orden guardado)
const SORTERS = {
  title: (a, b) => a.t.title.localeCompare(b.t.title, 'es'),
  bpm: (a, b) => (cueData[a.t.id]?.bpm || 999) - (cueData[b.t.id]?.bpm || 999),
  energy: (a, b) => (cueData[b.t.id]?.energy || 0) - (cueData[a.t.id]?.energy || 0),
  key: (a, b) => camelotOrder(cueData[a.t.id]?.key) - camelotOrder(cueData[b.t.id]?.key),
};
function camelotOrder(k) {
  const m = /^(\d{1,2})([AB])$/.exec(k || '');
  return m ? (+m[1]) * 2 + (m[2] === 'B' ? 1 : 0) : 999;
}

function drawList() {
  const pl = curPl();
  const q = $('#filter').value.trim().toLowerCase();
  $('#plSelect').innerHTML = playlists
    .map((p) => `<option value="${p.id}"${p.id === pl.id ? ' selected' : ''}>${esc(p.name)} (${p.tracks.length})</option>`)
    .join('');
  const inA = decks.A.track?.id, inB = decks.B.track?.id;
  // El filtro busca también en la ficha: tonalidad, etiquetas y notas
  const haystack = (t) => {
    const d = cueData[t.id] || {};
    return `${t.title} ${t.author} ${d.key || ''} ${(d.tags || []).join(' ')} ${d.notes || ''}`.toLowerCase();
  };
  let items = pl.tracks.map((t, i) => ({ t, i })).filter(({ t }) => !q || haystack(t).includes(q));
  const sorter = SORTERS[$('#sortBy').value];
  if (sorter) items = items.slice().sort(sorter);
  const rows = items.map(({ t, i }) =>
    trackRow(t, `data-index="${i}"`, { num: i + 1, inA: t.id === inA, inB: t.id === inB, actions: LIST_ACTIONS }));
  $('#trackList').innerHTML = rows.join('');
  renderQueue();
  const total = pl.tracks.reduce((s, t) => s + (t.dur || 0), 0);
  $('#listCount').textContent = `${pl.tracks.length} canciones` + (total ? ` · ${fmt(total)}` : '');
  $('#emptyHint').hidden = pl.tracks.length > 0;
}

function addTracks(items, at = null) {
  const pl = curPl();
  const existing = new Set(pl.tracks.map((t) => t.id));
  const fresh = [];
  for (const it of items) {
    if (!it?.id || existing.has(it.id)) continue;
    existing.add(it.id);
    fresh.push({ id: it.id, title: it.title || LOADING_TITLE, author: it.author || '', dur: it.dur || 0, ...(it.file ? { file: true } : {}) });
  }
  if (at == null) pl.tracks.push(...fresh);
  else pl.tracks.splice(at, 0, ...fresh);
  savePlaylists();
  renderList();
  fresh.filter((t) => t.title === LOADING_TITLE).forEach((t) => queueMeta(t.id));
  return fresh.length;
}

function markBlocked(id, note) {
  forEachTrack(id, (t) => { t.blocked = true; t.note = note; });
  savePlaylists();
  renderList();
}

// Títulos vía oEmbed (a través del servidor local), máximo 4 a la vez
const metaQueue = [];
let metaActive = 0;
function queueMeta(id) {
  metaQueue.push(id);
  pumpMeta();
}
function pumpMeta() {
  while (metaActive < 4 && metaQueue.length) {
    const id = metaQueue.shift();
    metaActive++;
    fetchMeta(id)
      .then((m) => applyMeta(id, m))
      .finally(() => { metaActive--; pumpMeta(); });
  }
}
// oEmbed de YouTube directo desde el navegador (funciona en GitHub Pages); si falla,
// se intenta el servidor local, que además informa por qué no está disponible.
async function fetchMeta(id) {
  const video = 'https://www.youtube.com/watch?v=' + id;
  try {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(video));
    if (r.ok) {
      const j = await r.json();
      return { ok: true, title: j.title, author: j.author_name };
    }
    return { ok: false, status: r.status };
  } catch { /* bloqueado o sin conexión */ }
  try {
    const r = await fetch('api/oembed?id=' + encodeURIComponent(id));
    if (r.ok) return await r.json();
  } catch { /* no hay servidor local */ }
  return { ok: false, status: 0 };
}

function applyMeta(id, m) {
  forEachTrack(id, (t) => {
    if (m.ok) {
      t.title = m.title;
      t.author = m.author;
      delete t.blocked;
      delete t.note;
      return;
    }
    if (t.title === LOADING_TITLE) t.title = 'Video ' + id;
    if (m.status === 401 || m.status === 403) {
      t.blocked = true;
      t.note = 'El dueño no permite reproducirlo fuera de YouTube';
    } else if (m.status === 400 || m.status === 404) {
      t.blocked = true;
      t.note = 'Video no disponible, privado o eliminado';
    }
  });
  for (const d of deckList) {
    if (d.track?.id === id && m.ok) { d.track.title = m.title; d.track.author = m.author; d.render(); }
  }
  savePlaylists();
  renderList();
}

// Lee los IDs de una lista de YouTube con un reproductor oculto (sin clave de API, hasta ~200 videos).
function importYouTubeList(listId) {
  return new Promise((resolve, reject) => {
    if (!ytReady) return reject(new Error('el reproductor de YouTube aún no cargó'));
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px';
    const inner = document.createElement('div');
    host.appendChild(inner);
    document.body.appendChild(host);
    let done = false, player = null, poll = null, timeout = null;
    const finish = (ids, err) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timeout);
      try { player?.destroy(); } catch { /* ya destruido */ }
      host.remove();
      if (err) reject(err); else resolve(ids);
    };
    player = new YT.Player(inner, {
      width: 320, height: 180,
      playerVars: { listType: 'playlist', list: listId, autoplay: 0, mute: 1, controls: 0 },
      events: {
        onReady: () => {
          if (!player.getPlaylist()?.length) player.cuePlaylist({ listType: 'playlist', list: listId });
          poll = setInterval(() => {
            const ids = player.getPlaylist?.();
            if (ids && ids.length) finish(ids);
          }, 300);
        },
        onError: (e) => finish(null, new Error(YT_ERRORS[e.data] || 'código ' + e.data)),
      },
    });
    timeout = setTimeout(() => finish(null, new Error('la lista es privada o no existe')), 15000);
  });
}

async function handleAdd(text) {
  text = text.trim();
  if (!text) return;
  const vids = [], lists = [];
  for (const tk of text.split(/\s+/)) {
    const r = parseYouTube(tk);
    if (r.video) vids.push(r.video);
    else if (r.list) lists.push(r.list);
  }
  if (!vids.length && !lists.length) return searchYouTube(text);

  $('#addInput').value = '';
  if (vids.length) {
    const n = addTracks(vids.map((id) => ({ id })));
    toast(n ? `Se agregó ${n === 1 ? '1 canción' : n + ' canciones'} a «${curPl().name}»` : 'Esa canción ya estaba en la lista', n ? 'ok' : '');
  }
  for (const listId of lists) {
    toast('Leyendo la lista de YouTube…');
    try {
      const ids = await importYouTubeList(listId);
      const n = addTracks(ids.map((id) => ({ id })));
      toast(`Lista importada: ${n} canciones nuevas`, 'ok');
    } catch (err) {
      toast('No se pudo leer la lista: ' + err.message, 'error');
    }
  }
}

// ----- Búsqueda (requiere clave de la API de YouTube) -----
let searchState = null; // { query, items, error, loading }

function parseIsoDuration(s) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || '');
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}

async function searchYouTube(query) {
  if (!settings.apiKey) {
    searchState = { query, items: [], error: 'nokey' };
    renderResults();
    return;
  }
  searchState = { query, items: [], loading: true };
  renderResults();
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.search = new URLSearchParams({
      part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '25', q: query, key: settings.apiKey,
    });
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'error ' + r.status);
    const items = j.items.filter((it) => it.id?.videoId).map((it) => ({
      id: it.id.videoId,
      title: decodeEntities(it.snippet.title),
      author: decodeEntities(it.snippet.channelTitle),
      dur: 0,
    }));
    if (items.length) {
      const u2 = new URL('https://www.googleapis.com/youtube/v3/videos');
      u2.search = new URLSearchParams({ part: 'contentDetails', id: items.map((i) => i.id).join(','), key: settings.apiKey });
      try {
        const j2 = await (await fetch(u2)).json();
        const durs = Object.fromEntries((j2.items || []).map((v) => [v.id, parseIsoDuration(v.contentDetails?.duration)]));
        items.forEach((i) => { i.dur = durs[i.id] || 0; });
      } catch { /* sin duraciones */ }
    }
    searchState = { query, items };
  } catch (err) {
    searchState = { query, items: [], error: err.message };
  }
  renderResults();
}

const RESULT_ACTIONS = `
  <button class="btn small" data-act="add" title="Agregar a la lista">+ Lista</button>
  <button class="btn small la" data-act="A" title="Cargar en la bandeja A">A</button>
  <button class="btn small lb" data-act="B" title="Cargar en la bandeja B">B</button>`;

function renderResults() {
  const box = $('#results');
  if (!searchState) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const { query, items, error, loading } = searchState;
  let body;
  if (loading) body = '<p class="msg muted">Buscando…</p>';
  else if (error === 'nokey') {
    body = `<p class="msg">Para buscar dentro de la app necesitas una clave gratuita de la API de YouTube
      (botón <b>Ajustes</b>). Mientras tanto, pulsa <b>Abrir YouTube ↗</b>, busca la canción,
      copia el enlace y pégalo aquí.</p>`;
  } else if (error) body = `<p class="msg" style="color:var(--bad)">Error al buscar: ${esc(error)}</p>`;
  else if (!items.length) body = '<p class="msg muted">Sin resultados.</p>';
  else {
    const inPl = new Set(curPl().tracks.map((t) => t.id));
    body = '<ol class="tracks">' + items.map((t, i) => trackRow(t, `data-r="${i}"`, {
      inA: decks.A.track?.id === t.id,
      inB: decks.B.track?.id === t.id,
      actions: inPl.has(t.id) ? RESULT_ACTIONS.replace('+ Lista', '✓ En lista') : RESULT_ACTIONS,
    })).join('') + '</ol>';
  }
  box.innerHTML = `<div class="results-head"><b>Resultados para «${esc(query)}»</b>
    <button class="btn small" data-act="close">Cerrar ✕</button></div>${body}`;
}

// =====================================================================
// Medidores de nivel (VU)
// YouTube no deja leer el audio de su reproductor. Sin captura, el nivel se estima con el volumen
// de salida de cada bandeja (y late al BPM si se marcó con TAP). Con «Medir audio real» se analiza
// el sonido de esta pestaña: el master es real y A/B lo reparten según su volumen.
// =====================================================================
const METER_SEGMENTS = 15;
const meters = {};
let realMeter = null;
const busBuf = new Float32Array(1024);

function buildMeter(id) {
  const el = $('#' + id);
  el.innerHTML = Array.from({ length: METER_SEGMENTS },
    (_, i) => `<i class="${i >= 13 ? 'r' : i >= 10 ? 'y' : 'g'}"></i>`).join('');
  return { el, segs: [...el.children], level: 0, peak: 0, peakAt: 0, lit: -1, peakIdx: -1 };
}

// Cuánto volumen está enviando la bandeja (0..1), solo si suena de verdad
function deckDrive(d) {
  if (!d.track || !d.playing || d.preloading || d.inAd || d.err || d.state !== PS.PLAYING) return 0;
  return d.outVolume / 100;
}

// Envolvente simulada: golpe en cada tiempo si hay BPM; si no, una variación suave
function simEnvelope(d, now) {
  if (d.bpm) {
    const phase = (d.time() * d.bpm / 60) % 1;
    return 0.38 + 0.3 * Math.exp(-phase * 5);
  }
  const t = now / 1000 + (d.letter === 'A' ? 0 : 7.7);
  return 0.45 + 0.12 * Math.sin(t * 7.3) * Math.sin(t * 2.9) + 0.06 * Math.sin(t * 17.1);
}

// Amplitud (lineal) → posición del medidor en escala de dB (-48 dB … 0 dB)
const ampToMeter = (amp) => (amp <= 0 ? 0 : clamp((20 * Math.log10(amp) + 48) / 48, 0, 1));

function realAmplitude() {
  const { analyser, buf } = realMeter;
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length) * 2.2; // RMS con margen para que la música normal llegue al amarillo
}

function updateMeter(m, target, now) {
  m.level = target > m.level ? target : Math.max(target, m.level - 0.02); // sube rápido, cae más lento
  if (m.level >= m.peak || now - m.peakAt > 1200) { m.peak = m.level; m.peakAt = now; }
  const lit = Math.round(m.level * METER_SEGMENTS);
  const peakIdx = m.peak > 0.03 ? Math.min(METER_SEGMENTS, Math.round(m.peak * METER_SEGMENTS)) - 1 : -1;
  if (lit === m.lit && peakIdx === m.peakIdx) return;
  m.lit = lit;
  m.peakIdx = peakIdx;
  m.segs.forEach((s, i) => s.classList.toggle('on', i < lit || i === peakIdx));
}

// Nivel real de una bandeja con archivo (después del fader), o null si es de YouTube
function fileAmp(d) {
  if (d.kind !== 'file') return null;
  return d.fe && d.playing ? d.fe.level() * 2.2 : 0;
}

function drawMeters(now) {
  const dA = deckDrive(decks.A), dB = deckDrive(decks.B);
  const fA = fileAmp(decks.A), fB = fileAmp(decks.B);
  // Sampler, micrófono y bandejas MP3 pasan por nuestro bus: ese nivel es real
  const busAmp = audioEngine.ctx ? audioEngine.rms(audioEngine.bus.analyser, busBuf) * 2.2 : 0;
  let ampA, ampB, ampM;
  if (fA != null || fB != null) {
    const ytA = fA == null ? dA * simEnvelope(decks.A, now) : 0;
    const ytB = fB == null ? dB * simEnvelope(decks.B, now) : 0;
    ampA = fA ?? ytA;
    ampB = fB ?? ytB;
    ampM = realMeter ? realAmplitude() : Math.min(1, Math.hypot(ytA, ytB, busAmp));
  } else if (realMeter) {
    ampM = realAmplitude();
    // Si suena música pero la captura está en silencio, se compartió la pestaña equivocada
    // (p. ej. la proyección, que está muda)
    if (Math.max(dA, dB) > 0.1 && ampM < 0.002) {
      realMeter.silentSince ??= now;
      if (now - realMeter.silentSince > 5000 && !realMeter.warned) {
        realMeter.warned = true;
        toast('El medidor real no recibe sonido: probablemente compartiste la ventana de proyección (que está en silencio). Apágalo y vuelve a activarlo eligiendo la pestaña de la consola de DJ.', 'error');
      }
    } else {
      realMeter.silentSince = null;
    }
    const total = dA * dA + dB * dB;
    ampA = total ? ampM * Math.sqrt(dA * dA / total) : 0;
    ampB = total ? ampM * Math.sqrt(dB * dB / total) : 0;
  } else {
    ampA = dA * simEnvelope(decks.A, now);
    ampB = dB * simEnvelope(decks.B, now);
    ampM = Math.min(1, Math.hypot(ampA, ampB, busAmp));
  }
  updateMeter(meters.A, ampToMeter(ampA), now);
  updateMeter(meters.B, ampToMeter(ampB), now);
  updateMeter(meters.M, ampToMeter(ampM), now);
  requestAnimationFrame(drawMeters);
}

function paintMeterButton() {
  const b = $('#btnMeter');
  b.classList.toggle('on', !!realMeter);
  b.textContent = realMeter ? '● Midiendo audio real (clic para apagar)' : 'Medir audio real';
}

async function toggleRealMeter() {
  if (realMeter) return stopRealMeter();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('Este navegador no permite medir el audio. Usa Chrome o Edge.', 'error');
    return;
  }
  toast('Elige la pestaña de la CONSOLA de DJ (no la proyección) y deja activado «Compartir también el audio». El navegador mostrará una barra de «compartiendo» mientras esté activo.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'exclude',
    });
  } catch {
    toast('No se activó el medidor real');
    return;
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    toast('No se compartió el audio. Inténtalo otra vez y activa «Compartir también el audio».', 'error');
    return;
  }
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser); // sin salida: no duplica el sonido
  realMeter = { stream, ctx, analyser, buf: new Float32Array(analyser.fftSize) };
  stream.getTracks().forEach((t) => t.addEventListener('ended', stopRealMeter));
  paintMeterButton();
  toast('Medidor real activado. Para apagarlo, pulsa el botón otra vez.', 'ok');
}

function stopRealMeter() {
  if (!realMeter) return;
  realMeter.stream.getTracks().forEach((t) => t.stop());
  realMeter.ctx.close();
  realMeter = null;
  paintMeterButton();
}

// =====================================================================
// Interfaz: eventos
// =====================================================================
function bindMixer() {
  const xf = $('#xfader');
  xf.addEventListener('input', () => setXf(xf.value / 1000, true));
  xf.addEventListener('dblclick', () => setXf(0.5, true));

  for (const key of ['volA', 'volB', 'master']) {
    const input = $('#' + key);
    input.value = settings[key];
    $(`#${key}Val`).textContent = settings[key];
    input.addEventListener('input', () => {
      settings[key] = +input.value;
      $(`#${key}Val`).textContent = input.value;
      applyVolumes();
      saveSettings();
    });
  }

  const curve = $('#xfCurve');
  curve.value = settings.curve;
  curve.addEventListener('change', () => { settings.curve = curve.value; applyVolumes(); saveSettings(); });

  const fadeSel = $('#fadeTime');
  fadeSel.value = String(settings.fadeTime);
  fadeSel.addEventListener('change', () => { settings.fadeTime = +fadeSel.value; saveSettings(); });

  const gateSel = $('#gateDiv');
  gateSel.value = String(settings.gateDiv);
  gateSel.addEventListener('change', () => { settings.gateDiv = +gateSel.value; saveSettings(); });

  $('#btnAutoFade').addEventListener('click', () => (fade ? stopFade() : autoFade()));
  $('#automix').addEventListener('change', (e) => setAutomix(e.target.checked));

  const modeBtns = $$('#videoMode button');
  const paintMode = () => modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.mode === settings.videoMode));
  modeBtns.forEach((b) => b.addEventListener('click', () => {
    settings.videoMode = b.dataset.mode;
    paintMode();
    saveSettings();
    publish();
  }));
  paintMode();

  $('#btnBlackout').addEventListener('click', toggleBlackout);

  const overlay = $('#overlayText');
  overlay.value = settings.overlayText;
  overlay.addEventListener('input', () => { settings.overlayText = overlay.value; saveSettings(); publish(); });

  const showTitle = $('#showTitle');
  showTitle.checked = settings.showTitle;
  showTitle.addEventListener('change', () => { settings.showTitle = showTitle.checked; saveSettings(); publish(); });

  const captions = $('#captions');
  captions.checked = settings.captions;
  captions.addEventListener('change', () => {
    settings.captions = captions.checked;
    saveSettings();
    deckList.forEach((d) => d.applyCaptions(true));
    publish();
  });

  const autoNext = $('#autoNext');
  autoNext.checked = settings.autoNext;
  autoNext.addEventListener('change', () => { settings.autoNext = autoNext.checked; saveSettings(); });

  const hideTail = $('#hideTail');
  hideTail.value = String(settings.hideTail);
  hideTail.addEventListener('change', () => { settings.hideTail = +hideTail.value; saveSettings(); publish(); });

  $('#btnProjector').addEventListener('click', openProjector);
}

function bindLibrary() {
  $('#plSelect').addEventListener('change', (e) => {
    activePlId = e.target.value;
    savePlaylists();
    automixPrepared = null;
    renderList();
    renderResults();
  });
  $('#plNew').addEventListener('click', () => {
    const name = prompt('Nombre de la nueva lista:', `Lista ${playlists.length + 1}`);
    if (!name?.trim()) return;
    const pl = { id: uid(), name: name.trim(), tracks: [] };
    playlists.push(pl);
    activePlId = pl.id;
    savePlaylists();
    renderList();
  });
  $('#plRename').addEventListener('click', () => {
    const pl = curPl();
    const name = prompt('Nuevo nombre de la lista:', pl.name);
    if (!name?.trim()) return;
    pl.name = name.trim();
    savePlaylists();
    renderList();
  });
  $('#plDelete').addEventListener('click', () => {
    const pl = curPl();
    if (!confirm(`¿Eliminar la lista «${pl.name}» y sus ${pl.tracks.length} canciones?`)) return;
    playlists = playlists.filter((p) => p !== pl);
    if (!playlists.length) playlists.push({ id: uid(), name: 'Mi lista', tracks: [] });
    activePlId = playlists[0].id;
    savePlaylists();
    renderList();
  });
  $('#plExport').addEventListener('click', () => {
    const pl = curPl();
    const blob = new Blob([JSON.stringify({ app: 'djyoutube', version: 1, playlists: [pl] }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${pl.name.replace(/[\\/:*?"<>|]+/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#plImport').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = Array.isArray(data.playlists) ? data.playlists : [data];
      let count = 0;
      for (const p of incoming) {
        if (!Array.isArray(p.tracks)) continue;
        const tracks = p.tracks
          .filter((t) => /^[\w-]{11}$/.test(t?.id || ''))
          .map((t) => ({ id: t.id, title: String(t.title || LOADING_TITLE), author: String(t.author || ''), dur: +t.dur || 0 }));
        const pl = { id: uid(), name: String(p.name || 'Lista importada'), tracks };
        playlists.push(pl);
        activePlId = pl.id;
        tracks.filter((t) => t.title === LOADING_TITLE).forEach((t) => queueMeta(t.id));
        count++;
      }
      if (!count) throw new Error('el archivo no contiene listas');
      savePlaylists();
      renderList();
      toast(`Se importaron ${count} lista(s)`, 'ok');
    } catch (err) {
      toast('No se pudo importar: ' + err.message, 'error');
    }
  });

  $('#addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleAdd($('#addInput').value);
  });
  $('#btnYtSearch').addEventListener('click', () => {
    const q = $('#addInput').value.trim();
    const url = q && !parseYouTube(q).video
      ? 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q)
      : 'https://www.youtube.com/';
    window.open(url, '_blank', 'noopener');
  });
  $('#filter').addEventListener('input', renderList);
  $('#sortBy').addEventListener('change', renderList);

  // Acciones de la lista
  const list = $('#trackList');
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const pl = curPl();
    const i = +btn.closest('li').dataset.index;
    const t = pl.tracks[i];
    if (!t) return;
    const act = btn.dataset.act;
    if (act === 'A' || act === 'B') safeLoad(decks[act], t);
    else if (act === 'queue') queueAdd(t);
    else if (act === 'info') openTrackInfo(t);
    else if (act === 'up' || act === 'down') {
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= pl.tracks.length) return;
      [pl.tracks[i], pl.tracks[j]] = [pl.tracks[j], pl.tracks[i]];
      savePlaylists();
      renderList();
    } else if (act === 'del') {
      pl.tracks.splice(i, 1);
      savePlaylists();
      renderList();
      if (t.file) forgetFileIfUnused(t.id);
    }
  });
  list.addEventListener('dblclick', (e) => {
    const li = e.target.closest('li.track');
    if (!li || e.target.closest('button')) return;
    safeLoad(offAirDeck(), curPl().tracks[+li.dataset.index]);
  });

  // Arrastrar: a una bandeja (cargar) o dentro de la lista (reordenar / agregar resultado)
  const startDrag = (e, track, index) => {
    e.dataTransfer.setData(DRAG_TRACK, JSON.stringify(track));
    if (index != null) e.dataTransfer.setData(DRAG_INDEX, String(index));
    e.dataTransfer.effectAllowed = 'copyMove';
  };
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li.track');
    if (!li) return;
    const i = +li.dataset.index;
    startDrag(e, curPl().tracks[i], i);
    li.classList.add('dragging');
  });
  const clearDragMarks = () => $$('.dragging, .drop-before').forEach((el) => el.classList.remove('dragging', 'drop-before'));
  document.addEventListener('dragend', clearDragMarks);
  list.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(DRAG_TRACK)) return;
    e.preventDefault();
    $$('.drop-before', list).forEach((el) => el.classList.remove('drop-before'));
    e.target.closest('li.track')?.classList.add('drop-before');
  });
  list.addEventListener('drop', (e) => {
    const data = e.dataTransfer.getData(DRAG_TRACK);
    if (!data) return;
    e.preventDefault();
    const pl = curPl();
    const li = e.target.closest('li.track');
    let to = li ? +li.dataset.index : pl.tracks.length;
    const fromStr = e.dataTransfer.getData(DRAG_INDEX);
    if (fromStr !== '') {
      const from = +fromStr;
      const [t] = pl.tracks.splice(from, 1);
      if (to > from) to--;
      pl.tracks.splice(to, 0, t);
      savePlaylists();
      renderList();
    } else {
      addTracks([JSON.parse(data)], to);
    }
    clearDragMarks();
  });

  // Resultados de búsqueda
  const results = $('#results');
  results.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'close') { searchState = null; renderResults(); return; }
    const t = searchState?.items[+btn.closest('li').dataset.r];
    if (!t) return;
    if (btn.dataset.act === 'add') {
      if (addTracks([t])) toast(`«${t.title}» agregada a la lista`, 'ok');
      renderResults();
    } else safeLoad(decks[btn.dataset.act], t);
  });
  results.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li.track');
    const t = li && searchState?.items[+li.dataset.r];
    if (t) startDrag(e, t, null);
  });
}

function bindDialogs() {
  const dlgS = $('#dlgSettings');
  $('#btnSettings').addEventListener('click', () => {
    $('#apiKey').value = settings.apiKey;
    if (location.protocol.startsWith('http')) $('#keySite').textContent = location.origin + '/*';
    dlgS.showModal();
  });
  dlgS.addEventListener('close', () => {
    if (dlgS.returnValue !== 'save') return;
    settings.apiKey = $('#apiKey').value.trim();
    saveSettings();
    toast('Ajustes guardados', 'ok');
  });
  $('#btnClearData').addEventListener('click', () => {
    if (!confirm('Esto borra tus listas, cues y ajustes guardados en este navegador. ¿Continuar?')) return;
    Object.keys(localStorage).filter((k) => k.startsWith('djyt.')).forEach((k) => localStorage.removeItem(k));
    location.reload();
  });
  $('#btnHelp').addEventListener('click', () => $('#dlgHelp').showModal());
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (!shortcutAllowed(e)) return;
    const { A, B } = decks;
    const hot = { Digit1: [A, 0], Digit2: [A, 1], Digit3: [A, 2], Digit4: [A, 3], Digit7: [B, 0], Digit8: [B, 1], Digit9: [B, 2], Digit0: [B, 3] };
    const actions = {
      KeyQ: () => A.toggle(),
      KeyW: () => A.cuePress(),
      KeyP: () => B.toggle(),
      KeyO: () => B.cuePress(),
      ArrowLeft: () => setXf(mixer.xf - 0.05, true),
      ArrowRight: () => setXf(mixer.xf + 0.05, true),
      ArrowDown: () => setXf(0.5, true),
      KeyF: () => (fade ? stopFade() : autoFade()),
      KeyN: () => toggleBlackout(),
    };
    let fn = actions[e.code];
    if (!fn && hot[e.code]) fn = () => hot[e.code][0].hotCue(hot[e.code][1], e.shiftKey);
    if (!fn) return;
    e.preventDefault();
    fn();
  });
}

// =====================================================================
// Pestañas del panel «Extras»
// =====================================================================
function bindExtrasTabs() {
  const show = (name) => {
    $$('#extrasTabs button').forEach((b) => b.classList.toggle('on', b.dataset.pane === name));
    $$('.extras-pane').forEach((p) => { p.hidden = p.id !== name; });
    store.set('extrasTab', name);
  };
  $$('#extrasTabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.pane)));
  show(store.get('extrasTab', 'paneSampler'));
}

// =====================================================================
// Audífonos: salida de la pre-escucha (PFL) de las bandejas MP3
// =====================================================================
async function listOutputs() {
  const sel = $('#cueDevice');
  let outs = [];
  try { outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput'); } catch { /* sin permiso */ }
  sel.innerHTML = '<option value="">— Sin pre-escucha —</option>' + outs
    .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `Salida de audio ${i + 1}`)}</option>`).join('');
  sel.value = settings.cueDevice || '';
  $('#cueNames').hidden = outs.some((d) => d.label);
}

function bindHeadphones() {
  const sel = $('#cueDevice');
  listOutputs();
  navigator.mediaDevices?.addEventListener?.('devicechange', listOutputs);
  sel.addEventListener('change', async () => {
    try {
      await audioEngine.setCueOutput(sel.value || null);
      settings.cueDevice = sel.value || null;
      saveSettings();
      if (sel.value) toast('Pre-escucha lista: activa PFL en una bandeja MP3 para oírla por esa salida', 'ok');
    } catch (err) {
      toast('No se pudo usar esa salida: ' + err.message, 'error');
    }
  });
  // Los nombres de las salidas solo aparecen tras dar permiso de micrófono (regla del navegador)
  $('#cueNames').addEventListener('click', async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch { toast('Sin ese permiso las salidas se ven sin nombre', 'error'); }
    listOutputs();
  });
  const vol = $('#cueVol');
  vol.value = settings.cueVol;
  const applyCueVol = () => { if (audioEngine.ctx) audioEngine.bus.cue.gain.value = (settings.cueVol / 100) ** 2; };
  vol.addEventListener('input', () => { settings.cueVol = +vol.value; saveSettings(); applyCueVol(); });
  $('#cueTest').addEventListener('click', () => {
    const ctx = audioEngine.init();
    applyCueVol();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 660;
    g.gain.setValueAtTime(0.25, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    o.connect(g).connect(audioEngine.bus.cue);
    o.start();
    o.stop(ctx.currentTime + 0.6);
    if (!settings.cueDevice) toast('Primero elige la salida de audífonos');
  });
  // Recuperar la salida elegida la última vez (necesita un primer clic para poder sonar)
  if (settings.cueDevice) {
    window.addEventListener('pointerdown', () => {
      applyCueVol();
      audioEngine.setCueOutput(settings.cueDevice).catch(() => { settings.cueDevice = null; saveSettings(); listOutputs(); });
    }, { once: true });
  }
}

// =====================================================================
// Medidor de fase: ¿los golpes de A y B caen juntos?
// =====================================================================
function phaseMeter() {
  const dot = $('#phaseDot'), txt = $('#phaseTxt');
  const A = decks.A, B = decks.B;
  const e = A.playing && B.playing ? beatGrid.phase(A, B) : null;
  $('.phase').classList.toggle('idle', e == null);
  if (e == null) {
    dot.style.left = '50%';
    txt.textContent = A.bpm && B.bpm ? `Δ ${Math.abs(A.bpm * A.rate - B.bpm * B.rate).toFixed(1)} BPM` : 'Fase —';
    return;
  }
  dot.style.left = `${50 + e * 100}%`;
  const ms = Math.round(Math.abs(e) * 60000 / (A.bpm * A.effRate()));
  const inPhase = Math.abs(e) < 0.03;
  dot.classList.toggle('ok', inPhase);
  txt.textContent = inPhase ? 'En fase' : `${e > 0 ? 'A' : 'B'} adelante ${ms} ms`;
}
