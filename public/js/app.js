'use strict';
/* DJ YouTube — consola de control.
   Cada bandeja es un reproductor oficial de YouTube (IFrame API). El sonido sale de esta ventana;
   la ventana de proyección recibe el estado por BroadcastChannel y muestra los mismos videos en silencio. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PS = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
const DRAG_TRACK = 'application/x-djyt-track';
const DRAG_INDEX = 'application/x-djyt-index';
const LOADING_TITLE = 'Cargando título…';
const YT_ERRORS = {
  2: 'Enlace o ID de video no válido',
  5: 'El reproductor no pudo reproducir este video',
  100: 'Video no encontrado, privado o eliminado',
  101: 'El dueño de este video no permite reproducirlo fuera de YouTube',
  150: 'El dueño de este video no permite reproducirlo fuera de YouTube',
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

// ---------- Estado guardado ----------
const settings = Object.assign({
  apiKey: '', fadeTime: 8, curve: 'smooth', videoMode: 'mix', overlayText: '', showTitle: true,
  master: 100, volA: 100, volB: 100,
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

// Puntos de cue, hot cues y BPM guardados por video
const cueData = store.get('cues', {});
let saveCueTimer;
function getCueData(id) {
  return cueData[id] || (cueData[id] = { cue: 0, hot: [null, null, null, null], bpm: null });
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
// Bandeja
// =====================================================================
class Deck {
  constructor(letter) {
    this.letter = letter;
    const frag = $('#deckTpl').content.cloneNode(true);
    this.el = frag.querySelector('.deck');
    this.el.classList.add('deck-' + letter.toLowerCase());
    $('.deck-letter', this.el).textContent = letter;
    $('#slot' + letter).replaceWith(this.el);
    this.ui = {
      title: $('.t-title', this.el), author: $('.t-author', this.el), yt: $('.yt', this.el), msg: $('.deck-msg', this.el),
      bar: $('.bar', this.el), fill: $('.fill', this.el), cueMark: $('.cue-mark', this.el),
      loopZone: $('.loop-zone', this.el), hotMarks: $('.hot-marks', this.el),
      elapsed: $('.t-elapsed', this.el), remain: $('.t-remain', this.el), bpm: $('.t-bpm', this.el), rate: $('.t-rate', this.el),
      ad: $('.deck-ad', this.el), play: $('.play', this.el), hc: $$('.hc', this.el), loopExit: $('.l-exit', this.el), tap: $('.tap', this.el),
    };

    this.player = null;
    this.ready = false;
    this.state = PS.UNSTARTED;
    this.track = null;
    this.playing = false;      // lo que quiere el DJ (no siempre igual al estado del reproductor)
    this.preloading = false;   // cargando en silencio para dejarla lista en pausa
    this.hasPlayed = false;
    this.err = null;
    this.duration = 0;
    this.rate = 1;
    this.rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    this.cue = 0;
    this.hot = [null, null, null, null];
    this.bpm = null;
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

    this.bindUI();
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
        onStateChange: (e) => this.onState(e.data),
        onError: (e) => this.onError(e.data),
        onPlaybackRateChange: (e) => { this.rate = e.data; this.render(); },
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
    on('.l-in', () => this.loopIn());
    on('.l-out', () => this.loopOut());
    on('.l-exit', () => this.loopToggle());
    $$('.l-beat', this.el).forEach((b) => b.addEventListener('click', () => this.beatLoop(+b.dataset.beats)));
    on('.t-down', () => this.stepRate(-1));
    on('.t-up', () => this.stepRate(1));
    on('.t-reset', () => this.setRate(1));
    on('.tap', () => this.tap());
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

    // Soltar canciones arrastradas desde la lista o los resultados
    this.el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TRACK)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.el.classList.add('drop');
    });
    this.el.addEventListener('dragleave', (e) => {
      if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('drop');
    });
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('drop');
      const data = e.dataTransfer.getData(DRAG_TRACK);
      if (!data) return;
      e.preventDefault();
      safeLoad(this, JSON.parse(data));
    });
  }

  // ----- Carga -----
  load(track, { autoplay = false } = {}) {
    if (!this.ready) {
      this.pending = [track, { autoplay }];
      toast('Esperando al reproductor de YouTube…');
      return;
    }
    this.track = { id: track.id, title: track.title, author: track.author || '' };
    this.loadToken++;
    const d = getCueData(track.id);
    this.cue = d.cue || 0;
    this.hot = Array.isArray(d.hot) ? [...d.hot] : [null, null, null, null];
    this.bpm = d.bpm || null;
    this.loop = { in: null, out: null, on: false };
    this.duration = track.dur || 0;
    this.err = null;
    this.taps = [];
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
    const now = performance.now();
    this.clock = { raw: this.cue, at: now };
    this.holdUntil = now + 600;
    this.loadedAt = now;
    this.lastRaw = -1;
    this.lastRawAt = now;
    this.nudged = 0;
    this.setAd(false);

    lastLoadedId = track.id;
    playedIds.add(track.id);
    this.render();
    renderList();
    renderResults();
  }

  onState(s) {
    this.state = s;
    if (s === PS.PLAYING) {
      const rates = this.player.getAvailablePlaybackRates?.();
      if (rates && rates.length) this.rates = rates;
      this.fixTitleFromPlayer();
      // Precargando: se deja sonar en silencio (también un posible anuncio) y checkAd() la pausa
      // en el cue cuando la canción de verdad empieza a avanzar.
      if (!this.preloading && !this.playing) this.player.pauseVideo();
    } else if (s === PS.ENDED) {
      this.playing = false;
    }
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
    if (!this.ready || !this.track || this.err) { this.setAd(false); return; }
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

  setMsg(text) {
    this.ui.msg.textContent = text;
    this.ui.msg.hidden = !text;
  }

  // ----- Tiempo (interpolado entre las actualizaciones del reproductor) -----
  time() {
    if (!this.ready || !this.track) return 0;
    const now = performance.now();
    if (now >= this.holdUntil) {
      const raw = this.player.getCurrentTime() || 0;
      if (raw !== this.clock.raw) this.clock = { raw, at: now };
    }
    const running = this.playing && this.state === PS.PLAYING && !this.inAd;
    return this.clock.raw + (running ? Math.min(1, (now - this.clock.at) / 1000) * this.rate : 0);
  }

  seek(t) {
    if (!this.ready || !this.track || this.err) return;
    const max = this.duration > 0 ? this.duration - 0.1 : Infinity;
    t = clamp(t, 0, max);
    this.player.seekTo(t, true);
    this.clock = { raw: t, at: performance.now() };
    this.holdUntil = performance.now() + 400;
  }

  // ----- Transporte -----
  play() {
    if (!this.ready || !this.track || this.err) return;
    this.preloading = false;
    this.player.unMute();
    if (this.state === PS.ENDED) this.seek(this.cue);
    this.playing = true;
    this.hasPlayed = true;
    this.player.playVideo();
    this.render();
  }

  pause() {
    if (!this.ready || !this.track) return;
    this.playing = false;
    this.player.pauseVideo();
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
    const t = this.time();
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
      this.hot[i] = this.time();
      this.persist();
      return;
    }
    this.seek(this.hot[i]);
    if (!this.playing) this.play();
  }

  persist() {
    if (!this.track) return;
    const d = getCueData(this.track.id);
    d.cue = this.cue;
    d.hot = [...this.hot];
    d.bpm = this.bpm;
    saveCues();
    this.render();
  }

  // ----- Loops -----
  loopIn() {
    if (!this.track) return;
    this.loop = { in: this.time(), out: null, on: false };
    this.render();
  }

  loopOut() {
    if (!this.track) return;
    if (this.loop.in == null) return toast('Primero marca el inicio del loop con IN');
    const t = this.time();
    if (t <= this.loop.in + 0.1) return;
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
    const t = this.time();
    this.loop = { in: t, out: t + beats * 60 / this.bpm, on: true };
    this.render();
  }

  // ----- Tempo -----
  setRate(r) {
    if (!this.ready || !this.track) return;
    const t = this.time();
    this.player.setPlaybackRate(r);
    this.rate = r;
    this.clock = { raw: t, at: performance.now() };
    this.render();
  }

  stepRate(dir) {
    let i = this.rates.findIndex((r) => Math.abs(r - this.rate) < 1e-6);
    if (i < 0) i = this.rates.indexOf(1);
    this.setRate(this.rates[clamp(i + dir, 0, this.rates.length - 1)]);
  }

  tap() {
    if (!this.track) return;
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 9) this.taps.shift();
    this.ui.tap.classList.add('flash');
    setTimeout(() => this.ui.tap.classList.remove('flash'), 90);
    if (this.taps.length >= 4) {
      const interval = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
      this.bpm = Math.round(60000 / interval / this.rate * 10) / 10; // BPM original del tema
      this.persist();
    }
  }

  // ----- Volumen y estado -----
  setOutVolume(v) {
    if (v === this.outVolume) return;
    this.outVolume = v;
    if (this.ready) this.player.setVolume(v);
  }

  isOnAir() { return this.playing && this.outVolume > 5; }

  render() {
    const u = this.ui, t = this.track, dur = this.duration;
    const pct = (x) => `${clamp(x / dur, 0, 1) * 100}%`;
    this.el.classList.toggle('loaded', !!t);
    u.title.textContent = t ? t.title : 'Bandeja vacía';
    u.author.textContent = t ? t.author : 'Usa los botones A / B de la lista o arrastra una canción';
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
    u.rate.textContent = `${this.rate.toFixed(2)}×`;
  }

  renderTick() {
    this.checkAd();
    const t = this.time(), dur = this.duration, u = this.ui;
    u.fill.style.width = dur > 0 ? `${clamp(t / dur, 0, 1) * 100}%` : '0';
    u.elapsed.textContent = fmt(t);
    const remain = dur > 0 ? dur - t : 0;
    u.remain.textContent = '-' + fmt(remain);
    u.remain.classList.toggle('warn', this.playing && dur > 0 && remain < 30);
    return t;
  }
}

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

// Siguiente canción de la lista activa después de `afterId` (o la primera sin sonar).
function nextTrack(afterId) {
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

function applyVolumes() {
  const [ga, gb] = xfGains(mixer.xf, settings.curve);
  const m = settings.master / 100;
  decks.A.setOutVolume(Math.round(m * (settings.volA / 100) * ga * 100));
  decks.B.setOutVolume(Math.round(m * (settings.volB / 100) * gb * 100));
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

  // Cuando falta poco, cruzar
  const remain = live.duration - live.time();
  if (live.duration > 0 && !live.loop.on && remain <= settings.fadeTime + 0.5) {
    if (!other.track || other.err) {
      if (!automixEndNotified) toast('AutoMix: no hay más canciones en la lista');
      automixEndNotified = true;
      return;
    }
    if (other.preloading) return; // la siguiente aún está en un anuncio: no cruzar todavía
    const outgoing = live;
    autoFade(other.letter, clamp(remain, 1, settings.fadeTime), () => { if (automixOn) outgoing.pause(); });
  }
}

// =====================================================================
// Proyección (otra ventana, mismo PC)
// =====================================================================
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('djyoutube') : null;
let projWin = null;
let projLastSeen = 0;

if (channel) {
  channel.onmessage = (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'hello' || m.type === 'alive') projLastSeen = Date.now();
    if (m.type === 'hello') publish();
  };
}

function videoOpacity() {
  // Una bandeja preparándose o en un anuncio no se muestra: se ve la otra o queda en negro.
  const ok = (d) => !!(d.track && !d.err && d.state !== PS.ENDED && !d.preloading && !d.inAd);
  const a = ok(decks.A), b = ok(decks.B);
  if (settings.videoMode === 'A') return [a ? 1 : 0, 0];
  if (settings.videoMode === 'B') return [0, b ? 1 : 0];
  return [a ? 1 : 0, b ? (a ? mixer.xf : 1) : 0];
}

function deckState(d) {
  return {
    videoId: d.track && !d.err ? d.track.id : null,
    playing: d.playing && !d.preloading,
    time: d.time(),
    rate: d.rate,
    ended: d.state === PS.ENDED,
    title: d.track?.title || '',
    author: d.track?.author || '',
  };
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
    blackout: mixer.blackout,
    overlayText: settings.overlayText,
    showTitle: settings.showTitle,
  });
}

async function openProjector() {
  if (projWin && !projWin.closed) {
    projWin.focus();
    toast('La ventana de proyección ya está abierta');
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
  projWin = window.open('proyeccion.html', 'djyt-proyeccion', features);
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
    (t.blocked ? `<span class="badge bad" title="${esc(t.note || '')}">NO DISPONIBLE</span>` : '');
  return `<li class="${cls.join(' ')}" draggable="true" ${attrs}>
    <span class="num">${num}</span>
    <img src="${thumb(t.id)}" alt="" loading="lazy">
    <div class="info"><div class="title" title="${esc(t.title)}">${badges}${esc(t.title)}</div><div class="meta">${meta}</div></div>
    <div class="acts">${actions}</div>
  </li>`;
}

const LIST_ACTIONS = `
  <button class="btn small la" data-act="A" title="Cargar en la bandeja A">A</button>
  <button class="btn small lb" data-act="B" title="Cargar en la bandeja B">B</button>
  <button class="btn small" data-act="up" title="Subir">↑</button>
  <button class="btn small" data-act="down" title="Bajar">↓</button>
  <button class="btn small danger" data-act="del" title="Quitar de la lista">✕</button>`;

function drawList() {
  const pl = curPl();
  const q = $('#filter').value.trim().toLowerCase();
  $('#plSelect').innerHTML = playlists
    .map((p) => `<option value="${p.id}"${p.id === pl.id ? ' selected' : ''}>${esc(p.name)} (${p.tracks.length})</option>`)
    .join('');
  const inA = decks.A.track?.id, inB = decks.B.track?.id;
  const rows = [];
  pl.tracks.forEach((t, i) => {
    if (q && !`${t.title} ${t.author}`.toLowerCase().includes(q)) return;
    rows.push(trackRow(t, `data-index="${i}"`, { num: i + 1, inA: t.id === inA, inB: t.id === inB, actions: LIST_ACTIONS }));
  });
  $('#trackList').innerHTML = rows.join('');
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
    fresh.push({ id: it.id, title: it.title || LOADING_TITLE, author: it.author || '', dur: it.dur || 0 });
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
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (document.querySelector('dialog[open]')) return;
    const tg = e.target;
    if (tg.isContentEditable || tg.matches?.('textarea, select, input:not([type=range]):not([type=checkbox])')) return;
    if (tg.matches?.('input[type=range]') && e.code.startsWith('Arrow')) return;
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
// Arranque
// =====================================================================
if (location.protocol === 'file:') $('#fileWarning').classList.remove('hidden');

bindMixer();
bindLibrary();
bindDialogs();
bindKeyboard();
setXf(0);
drawList();

// Recuperar títulos que quedaron pendientes (p. ej. sin internet la última vez)
for (const p of playlists) for (const t of p.tracks) if (t.title === LOADING_TITLE) queueMeta(t.id);

// Reloj rápido: tiempos, barras y loops
setInterval(() => {
  for (const d of deckList) {
    const t = d.renderTick();
    if (d.loop.on && d.playing && !d.inAd && d.loop.out != null && t >= d.loop.out) d.seek(d.loop.in);
  }
}, 40);

// Reloj lento: estado al aire, AutoMix y sincronización con la proyección
setInterval(() => {
  for (const d of deckList) d.el.classList.toggle('onair', d.isOnAir());
  automixTick();
  publish();
  updateProjStatus();
}, 200);

setTimeout(() => {
  if (!ytReady) toast('No se pudo cargar el reproductor de YouTube. Revisa tu conexión a internet y recarga la página.', 'error');
}, 10000);
