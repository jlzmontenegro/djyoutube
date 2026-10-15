'use strict';
/* Arranque: se carga al final, cuando todos los módulos ya están definidos. */

if (location.protocol === 'file:') $('#fileWarning').classList.remove('hidden');

bindMixer();
bindLibrary();
bindDialogs();
bindKeyboard();
initSession();
initSampler();
initMic();
initMidi();
initVfx();
bindExtrasTabs();
bindHeadphones();
setXf(0);
drawList();

meters.A = buildMeter('meterA');
meters.B = buildMeter('meterB');
meters.M = buildMeter('meterM');
$('#btnMeter').addEventListener('click', toggleRealMeter);
requestAnimationFrame(drawMeters);

// Recuperar títulos que quedaron pendientes (p. ej. sin internet la última vez)
for (const p of playlists) for (const t of p.tracks) if (t.title === LOADING_TITLE && !t.file) queueMeta(t.id);

// Reloj rápido: tiempos, barras, loops, ondas y efectos de mezcla
setInterval(() => {
  const now = performance.now();
  for (const d of deckList) {
    const t = d.renderTick();
    if (d.loop.on && d.playing && !d.inAd && d.loop.out != null && t >= d.loop.out) d.seek(d.loop.in);
  }
  mixFx.tick(now);
  phaseMeter();
}, 40);

// SYNC: corrige tempo y fase
setInterval(syncTick, 100);

// Reloj lento: estado al aire, AutoMix, historial y sincronización con la proyección
setInterval(() => {
  for (const d of deckList) d.el.classList.toggle('onair', d.isOnAir());
  automixTick();
  autoNextTick();
  historyTick();
  for (const d of deckList) d.enforceCaptions();
  publish();
  updateProjStatus();
}, 200);

// Visualizador de las bandejas MP3 en la proyección
setInterval(publishSpectrum, 33);

// Redibujar las formas de onda si cambia el tamaño de la ventana
window.addEventListener('resize', () => deckList.forEach((d) => d.drawOverview()));

setTimeout(() => {
  if (!ytReady) toast('No se pudo cargar el reproductor de YouTube. Revisa tu conexión a internet y recarga la página.', 'error');
}, 10000);
