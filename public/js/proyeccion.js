'use strict';
/* DJ YouTube — ventana de proyección.
   Muestra en silencio los mismos videos que las bandejas de la consola y los mantiene sincronizados. */

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
  if (e.data?.type !== 'state') return;
  last = e.data;
  lastMsgAt = Date.now();
  apply(last);
};
channel.postMessage({ type: 'hello' });
setInterval(() => channel.postMessage({ type: 'alive' }), 1000);

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
  // Una capa preparándose o detenida en un anuncio no se muestra en la pantalla
  const hidden = (k) => s.blackout || decks[k].warming || decks[k].stuck;
  const oa = hidden('A') ? 0 : s.opacity.A;
  let ob = hidden('B') ? 0 : s.opacity.B;
  if (!oa && ob > 0) ob = 1;
  layers.A.style.opacity = oa;
  layers.B.style.opacity = ob;
  document.body.classList.toggle('black', !!s.blackout);
  document.getElementById('overlayText').textContent = s.overlayText || '';
  showTitle(s);
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
  const key = s.showTitle && front?.videoId && front.playing ? front.videoId : '';
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
