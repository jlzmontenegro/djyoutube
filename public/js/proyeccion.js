'use strict';
/* DJ YouTube — ventana de proyección.
   Muestra en silencio los mismos videos que las bandejas de la consola y los mantiene sincronizados. */

// Debe coincidir con APP_VERSION de app.js: así la consola detecta una proyección desactualizada.
const APP_VERSION = '13';
const PS = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 };
const channel = new BroadcastChannel('djyoutube');
const layers = { A: document.getElementById('layerA'), B: document.getElementById('layerB') };
const newDeck = () => ({
  player: null, ready: false, videoId: null, lastSeek: 0,
  warming: false, startAt: 0, loadedAt: 0, lastRaw: -1, lastRawAt: 0, stuck: false,
});
const decks = { A: newDeck(), B: newDeck() };
const statusEl = document.getElementById('status');
let last = null;
let lastMsgAt = 0;
let shownTitleKey = '';
let titleTimer = null;
let captionsOn = false;

// Subtítulos (CC) según la casilla de la consola
function applyCaptions(d, force = false) {
  if (!d.ready) return;
  // Evita repetirlo en bucle: activar el módulo vuelve a disparar onApiChange
  const now = Date.now();
  if (!force && now - (d.capsAt || 0) < 400) return;
  d.capsAt = now;
  const player = d.player;
  try {
    if (!captionsOn) {
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

window.onYouTubeIframeAPIReady = () => {
  for (const k of ['A', 'B']) {
    decks[k].player = new YT.Player(layers[k].querySelector('div'), {
      width: '100%',
      height: '100%',
      playerVars: {
        controls: 0, disablekb: 1, rel: 0, iv_load_policy: 3, modestbranding: 1, playsinline: 1, fs: 0,
        mute: 1, autoplay: 1, origin: location.origin,
      },
      events: {
        onReady: () => {
          decks[k].ready = true;
          decks[k].player.mute();
          if (last) apply(last);
        },
        onStateChange: (e) => { if (e.data === PS.PLAYING) applyCaptions(decks[k]); },
        onApiChange: () => applyCaptions(decks[k]),
      },
    });
  }
};

channel.onmessage = (e) => {
  const m = e.data;
  if (m?.type === 'spec') { spectrum.A = m.A; spectrum.B = m.B; spectrum.at = performance.now(); return; }
  if (m?.type === 'logo') { setLogo(m.data); return; }
  if (m?.type !== 'state') return;
  last = m;
  lastMsgAt = Date.now();
  apply(last);
};
channel.postMessage({ type: 'hello', version: APP_VERSION });
setInterval(() => channel.postMessage({ type: 'alive', version: APP_VERSION }), 1000);

function apply(s) {
  if (!!s.captions !== captionsOn) {
    captionsOn = !!s.captions;
    applyCaptions(decks.A, true);
    applyCaptions(decks.B, true);
  }
  for (const k of ['A', 'B']) {
    syncDeck(k, s.decks[k], s.sentAt);
    // YouTube vuelve a activar los subtítulos por su cuenta: con la casilla apagada se quitan cada segundo
    const d = decks[k];
    if (!captionsOn && d.videoId && Date.now() - (d.capsAt || 0) > 1000) applyCaptions(d, true);
  }
  // Bandejas con MP3: en vez de video se ve un visualizador con el nombre de la canción
  for (const k of ['A', 'B']) {
    const st = s.decks[k];
    layers[k].classList.toggle('file', !!st?.file);
    layers[k].querySelector('.viz-title').textContent = st?.file ? st.title : '';
  }
  // Una capa preparándose o detenida en un anuncio no se muestra en la pantalla
  const hidden = (k) => s.blackout || (!s.decks[k]?.file && (decks[k].warming || decks[k].stuck));
  const oa = hidden('A') ? 0 : s.opacity.A;
  let ob = hidden('B') ? 0 : s.opacity.B;
  if (!oa && ob > 0) ob = 1;
  applyTransition(s.vfx?.transition || 'fade', oa, ob);
  document.body.classList.toggle('black', !!s.blackout);
  document.getElementById('overlayText').textContent = s.overlayText || '';
  applyVfxSettings(s.vfx);
  showTitle(s);
}

// Fundido: la capa B se superpone con transparencia. Cortina: B entra desde la derecha
// tapando a A. Deslizar: B empuja a A hacia la izquierda.
function applyTransition(kind, oa, ob) {
  const stage = document.getElementById('stage');
  stage.classList.toggle('wipe', kind === 'wipe');
  stage.classList.toggle('slide', kind === 'slide');
  const A = layers.A.style, B = layers.B.style;
  if (kind === 'fade' || !oa || !ob) {
    A.opacity = oa; B.opacity = ob;
    A.clipPath = B.clipPath = A.transform = B.transform = '';
    return;
  }
  A.opacity = 1;
  B.opacity = 1;
  if (kind === 'wipe') {
    A.transform = B.transform = '';
    B.clipPath = `inset(0 0 0 ${(1 - ob) * 100}%)`;
  } else {
    B.clipPath = '';
    A.transform = `translateX(${-ob * 100}%)`;
    B.transform = `translateX(${(1 - ob) * 100}%)`;
  }
}

function syncDeck(k, st, sentAt) {
  const d = decks[k];
  if (!d.ready || !st) return;
  const p = d.player;
  const now = Date.now();
  if (!p.isMuted()) p.mute();

  if (!st.videoId) {
    if (d.videoId) { p.stopVideo(); d.videoId = null; }
    d.warming = d.stuck = false;
    return;
  }
  const target = st.time + (st.playing ? Math.max(0, (now - sentAt) / 1000) * st.rate : 0);
  if (st.videoId !== d.videoId) {
    d.videoId = st.videoId;
    p.loadVideoById({ videoId: st.videoId, startSeconds: target });
    Object.assign(d, { lastSeek: now, warming: true, startAt: target, loadedAt: now, lastRaw: -1, lastRawAt: now, stuck: false });
    return;
  }

  const state = p.getPlayerState();
  const raw = p.getCurrentTime() || 0;
  if (raw !== d.lastRaw) { d.lastRaw = raw; d.lastRawAt = now; }

  // Calentando: se deja correr oculta y en silencio (con su posible anuncio) hasta que la canción avanza
  if (d.warming) {
    if (raw > d.startAt + 0.1) d.warming = false;
    else {
      if (state !== PS.PLAYING && state !== PS.BUFFERING && now - d.loadedAt > 1500) p.playVideo();
      if (now - d.loadedAt > 90000) d.warming = false;
      return;
    }
  }
  if (st.ended) return;
  if (Math.abs(p.getPlaybackRate() - st.rate) > 0.001) p.setPlaybackRate(st.rate);

  if (st.playing && state !== PS.PLAYING && state !== PS.BUFFERING) p.playVideo();
  if (!st.playing && (state === PS.PLAYING || state === PS.BUFFERING)) p.pauseVideo();

  // Si debería avanzar y no avanza, hay un anuncio a mitad de canción: se oculta esa capa
  d.stuck = st.playing && state === PS.PLAYING && now - d.lastRawAt > 1500;
  if (d.stuck) return;

  // Corregir el desfase solo si es notable, para no dar tirones
  if (now - d.lastSeek < 2000) return;
  const drift = raw - target;
  if (Math.abs(drift) > (st.playing ? 0.5 : 0.2)) {
    p.seekTo(target + (st.playing ? 0.1 : 0), true);
    d.lastSeek = now;
  }
}

// Muestra el nombre de la canción unos segundos cada vez que cambia la que está al frente
function showTitle(s) {
  const np = document.getElementById('nowPlaying');
  const front = s.decks[s.front];
  const id = front?.videoId || (front?.file ? 'file:' + front.title : '');
  const key = s.showTitle && id && front.playing ? id : '';
  if (key === shownTitleKey) return;
  shownTitleKey = key;
  clearTimeout(titleTimer);
  if (!key) { np.classList.remove('show'); return; }
  document.getElementById('npTitle').textContent = front.title;
  document.getElementById('npAuthor').textContent = front.author;
  np.classList.add('show');
  titleTimer = setTimeout(() => np.classList.remove('show'), 9000);
}

// ----- Pantalla completa, aviso y cursor -----
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
document.addEventListener('dblclick', (e) => {
  if (!e.target.closest('.card')) toggleFullscreen();
});
document.getElementById('btnFull').addEventListener('click', () => { toggleFullscreen(); closeHint(); });
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF') toggleFullscreen();
});

// El aviso sale una sola vez al abrir la ventana (y nunca si se marcó «No volver a mostrar»).
const HINT_KEY = 'djyt.projHintOff';
const hint = document.getElementById('hint');
const hintOff = document.getElementById('hintOff');
let hintOpen = false;
let hintTimer = null;

function hintDisabled() {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
}
function closeHint() {
  if (hint.hidden) return;
  hintOpen = false;
  clearTimeout(hintTimer);
  hint.classList.add('closing');
  setTimeout(() => { hint.hidden = true; }, 400);
}
hintOff.addEventListener('change', () => {
  try {
    if (hintOff.checked) localStorage.setItem(HINT_KEY, '1');
    else localStorage.removeItem(HINT_KEY);
  } catch { /* almacenamiento bloqueado */ }
});
document.getElementById('btnHintClose').addEventListener('click', closeHint);
// También se cierra con Esc o con un clic fuera del recuadro
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHint(); });
hint.addEventListener('click', (e) => { if (!e.target.closest('.card')) closeHint(); });
document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) closeHint(); });

if (!hintDisabled()) {
  hint.hidden = false;
  hintOpen = true;
  hintTimer = setTimeout(closeHint, 20000);
}

// Ocultar el cursor cuando el ratón no se mueve
let idleTimer = null;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
}
document.addEventListener('mousemove', wake);
wake();

setInterval(() => {
  const connected = Date.now() - lastMsgAt < 3000;
  statusEl.textContent = connected ? '● Conectada a la consola' : 'Esperando la consola de DJ… (déjala abierta)';
  statusEl.classList.toggle('on', connected);
}, 1000);

// =====================================================================
// Efectos de video (VJ) y visualizador de las bandejas MP3
// =====================================================================
const spectrum = { A: null, B: null, at: 0 };
const smooth = { A: new Float32Array(32), B: new Float32Array(32) };
const stage = document.getElementById('stage');
const flashEl = document.getElementById('flash');
const strobeEl = document.getElementById('strobe');
const logoEl = document.getElementById('logo');
const marqueeEl = document.getElementById('marquee');
let vfx = {};

const FILTERS = {
  none: '', bw: 'grayscale(1) contrast(1.1)', sepia: 'sepia(.9) contrast(1.05)', invert: 'invert(1) hue-rotate(180deg)',
  vivid: 'saturate(2.2) contrast(1.15)', blur: 'blur(6px) brightness(1.1)', noir: 'grayscale(1) contrast(2.2) brightness(.9)', rainbow: '',
};

function setLogo(data) {
  logoEl.hidden = !data;
  if (data) logoEl.src = data; else logoEl.removeAttribute('src');
}

function applyVfxSettings(v = {}) {
  vfx = v;
  stage.style.filter = FILTERS[v.filter] ?? '';
  stage.classList.toggle('rainbow', v.filter === 'rainbow');
  logoEl.className = v.logoPos || 'tr';
  logoEl.style.width = `${v.logoSize || 14}vw`;
  const text = (v.marquee || '').trim();
  marqueeEl.hidden = !text;
  const span = marqueeEl.firstElementChild;
  if (span.textContent !== text) span.textContent = text;
  span.style.animationDuration = `${Math.max(4, (text.length + 40) / (v.marqueeSpeed || 18) * 2)}s`;
  // Un logo abajo no debe quedar tapado por la franja del texto que pasa
  logoEl.style.bottom = text && /^b/.test(v.logoPos || '') ? `calc(${marqueeEl.offsetHeight}px + 2vh)` : '';
  // El espejo voltea la imagen, pero el nombre de la canción se sigue leyendo al derecho
  document.querySelectorAll('.viz-title').forEach((el) => { el.style.transform = v.mirror ? 'scaleX(-1)' : ''; });
}

// Tiempos (con decimales) de la canción al frente, avanzando con el reloj entre mensajes
function currentBeats() {
  const b = last?.beat;
  if (!b || !b.bpm) return null;
  const elapsed = b.playing ? (Date.now() - last.sentAt) / 60000 * b.bpm : 0;
  return b.beats + elapsed;
}

function renderVfx() {
  const beats = currentBeats();
  const playing = !!last?.beat?.playing;
  const frac = (x) => x - Math.floor(x);
  const black = !!last?.blackout;

  // Estrobo: destello blanco corto en cada fracción de tiempo elegida
  let strobe = 0;
  if (vfx.strobe && !black) {
    const div = vfx.strobeDiv || 1;
    const phase = beats != null ? frac(beats * div) : frac(performance.now() / 1000 * 2 * div);
    strobe = phase < 0.12 ? 1 : 0;
  }
  strobeEl.style.opacity = strobe;

  // Flash de color que se apaga en cada golpe
  let flash = 0;
  if (vfx.flash && !black && beats != null && playing) flash = Math.exp(-frac(beats) * 6) * 0.55;
  flashEl.style.opacity = flash;
  flashEl.style.background = vfx.flashColor || '#ffffff';

  // Espejo, zoom y pulso en cada golpe
  let scale = (vfx.zoom || 100) / 100;
  if (vfx.pulse && beats != null && playing) scale *= 1 + 0.045 * Math.exp(-frac(beats) * 5);
  stage.style.transform = `scale(${vfx.mirror ? -scale : scale}, ${scale})`;

  drawViz('A');
  drawViz('B');
  requestAnimationFrame(renderVfx);
}

// Visualizador: barras simétricas desde el centro, con brillo que sigue a los graves
function drawViz(k) {
  const layer = layers[k];
  if (!layer.classList.contains('file') || layer.style.opacity === '0') return;
  const c = layer.querySelector('.viz');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (!w || !h) return;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  const fresh = performance.now() - spectrum.at < 300;
  const bands = fresh ? spectrum[k] : null;
  const sm = smooth[k];
  for (let i = 0; i < sm.length; i++) {
    const target = bands ? bands[i] : 0;
    sm[i] += (target - sm[i]) * (target > sm[i] ? 0.6 : 0.12);
  }
  const bass = (sm[1] + sm[2] + sm[3]) / 3;
  const bg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
  bg.addColorStop(0, `rgba(60,64,72,${0.35 + bass * 0.5})`);
  bg.addColorStop(1, '#000');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const n = sm.length, gap = w * 0.004, barW = (w / 2) / n - gap;
  for (let i = 0; i < n; i++) {
    const v = Math.pow(sm[i], 1.4);
    const bh = Math.max(2 * dpr, v * h * 0.42);
    const light = 70 + v * 30;
    g.fillStyle = `hsl(220, 10%, ${light}%)`;
    const xr = w / 2 + i * (barW + gap), xl = w / 2 - (i + 1) * (barW + gap);
    for (const x of [xr, xl]) {
      g.fillRect(x, h * 0.62 - bh, barW, bh);
      g.globalAlpha = 0.18;
      g.fillRect(x, h * 0.62 + 4 * dpr, barW, bh * 0.45);
      g.globalAlpha = 1;
    }
  }
}

requestAnimationFrame(renderVfx);
