'use strict';
/* Organización de la sesión: cola de reproducción, historial (setlist), ficha de cada canción
   (BPM, tonalidad, energía, etiquetas, notas) y archivos de música propios. */

// =====================================================================
// Cola: lo que suena después, por encima del orden de la lista
// =====================================================================
let queue = store.get('queue', []);
const saveQueue = () => store.set('queue', queue);

function queuePeek() { return queue.find((t) => !t.blocked) || null; }
function isQueued(id) { return queue.some((t) => t.id === id); }

function queueAdd(t) {
  queue.push({ id: t.id, title: t.title, author: t.author || '', dur: t.dur || 0, ...(t.file ? { file: true } : {}) });
  saveQueue();
  renderList();
  toast(`«${t.title}» en la cola (posición ${queue.length})`, 'ok');
}

// Al cargar una canción que estaba primera en la cola, sale de la cola
function queueConsume(id) {
  const i = queue.findIndex((t) => t.id === id);
  if (i === 0) { queue.shift(); saveQueue(); renderQueue(); }
}

function renderQueue() {
  const tab = $('#tabBtnQueue');
  if (tab) tab.textContent = `Cola (${queue.length})`;
  const ol = $('#queueList');
  if (!ol) return;
  ol.innerHTML = queue.map((t, i) => trackRow(t, `data-q="${i}"`, {
    num: i + 1,
    inA: decks.A.track?.id === t.id,
    inB: decks.B.track?.id === t.id,
    actions: `
      <button class="btn small la" data-act="A" title="Cargar en la bandeja A">A</button>
      <button class="btn small lb" data-act="B" title="Cargar en la bandeja B">B</button>
      <button class="btn small" data-act="up" title="Subir">↑</button>
      <button class="btn small" data-act="down" title="Bajar">↓</button>
      <button class="btn small danger" data-act="del" title="Quitar de la cola">✕</button>`,
  })).join('');
  $('#queueEmpty').hidden = queue.length > 0;
}

function bindQueue() {
  $('#queueList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const i = +btn.closest('li').dataset.q;
    const t = queue[i];
    if (!t) return;
    const act = btn.dataset.act;
    if (act === 'A' || act === 'B') {
      // Cargar desde la cola la saca de la cola
      queue.splice(i, 1);
      saveQueue();
      safeLoad(decks[act], t);
    } else if (act === 'up' || act === 'down') {
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= queue.length) return;
      [queue[i], queue[j]] = [queue[j], queue[i]];
      saveQueue();
    } else if (act === 'del') {
      queue.splice(i, 1);
      saveQueue();
    }
    renderList();
  });
  $('#queueClear').addEventListener('click', () => {
    if (!queue.length || !confirm('¿Vaciar la cola?')) return;
    queue = [];
    saveQueue();
    renderList();
  });
}

// =====================================================================
// Historial de la sesión (setlist): cada canción que sonó al aire más de 15 s
// =====================================================================
let setlist = store.get('setlist', []);

function historyTick() {
  const now = performance.now();
  for (const d of deckList) {
    if (!d.track || !d.isOnAir() || d.outVolume < 30) { d.airSince = null; continue; }
    d.airSince ??= now;
    if (now - d.airSince > 15000 && d.loggedToken !== d.loadToken) {
      d.loggedToken = d.loadToken;
      setlist.push({ at: Date.now(), id: d.track.id, title: d.track.title, author: d.track.author, file: !!d.track.file });
      if (setlist.length > 1000) setlist = setlist.slice(-1000);
      store.set('setlist', setlist);
      renderHistory();
    }
  }
}

const timeOf = (ms) => new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

function renderHistory() {
  const ol = $('#historyList');
  if (!ol) return;
  const recent = setlist.slice().reverse();
  ol.innerHTML = recent.map((h) => `<li class="hist">
      <span class="h-time">${timeOf(h.at)}</span>
      <span class="h-title" title="${esc(h.title)}">${esc(h.title)}</span>
      <span class="h-author">${esc(h.author || '')}</span>
    </li>`).join('');
  $('#historyEmpty').hidden = setlist.length > 0;
  $('#tabBtnHistory').textContent = `Historial (${setlist.length})`;
}

function exportHistory(kind) {
  if (!setlist.length) return toast('El historial está vacío');
  let text, type, ext;
  if (kind === 'csv') {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    text = 'fecha,hora,titulo,artista,enlace\n' + setlist.map((h) => {
      const d = new Date(h.at);
      const link = h.file ? '' : `https://youtu.be/${h.id}`;
      return [d.toLocaleDateString('es'), timeOf(h.at), h.title, h.author, link].map(q).join(',');
    }).join('\n');
    type = 'text/csv';
    ext = 'csv';
  } else {
    text = setlist.map((h, i) => `${String(i + 1).padStart(2, '0')}. ${timeOf(h.at)}  ${h.title}${h.author ? ' — ' + h.author : ''}`).join('\n');
    type = 'text/plain';
    ext = 'txt';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: type + ';charset=utf-8' }));
  a.download = `setlist-${new Date().toISOString().slice(0, 10)}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function bindHistory() {
  $('#histTxt').addEventListener('click', () => exportHistory('txt'));
  $('#histCsv').addEventListener('click', () => exportHistory('csv'));
  $('#histClear').addEventListener('click', () => {
    if (!setlist.length || !confirm('¿Borrar el historial de canciones?')) return;
    setlist = [];
    store.set('setlist', setlist);
    renderHistory();
  });
}

// =====================================================================
// Ficha de la canción: BPM, tonalidad (rueda Camelot), energía, etiquetas, notas
// =====================================================================
const NOTE_ES = { C: 'Do', 'C#': 'Do♯', Db: 'Re♭', D: 'Re', Eb: 'Mi♭', E: 'Mi', F: 'Fa', 'F#': 'Fa♯', Gb: 'Sol♭', G: 'Sol', Ab: 'La♭', 'G#': 'Sol♯', A: 'La', Bb: 'Si♭', B: 'Si' };
const CAMELOT = [
  ['1A', 'Ab', 'm'], ['1B', 'B', ''], ['2A', 'Eb', 'm'], ['2B', 'F#', ''], ['3A', 'Bb', 'm'], ['3B', 'Db', ''],
  ['4A', 'F', 'm'], ['4B', 'Ab', ''], ['5A', 'C', 'm'], ['5B', 'Eb', ''], ['6A', 'G', 'm'], ['6B', 'Bb', ''],
  ['7A', 'D', 'm'], ['7B', 'F', ''], ['8A', 'A', 'm'], ['8B', 'C', ''], ['9A', 'E', 'm'], ['9B', 'G', ''],
  ['10A', 'B', 'm'], ['10B', 'D', ''], ['11A', 'F#', 'm'], ['11B', 'A', ''], ['12A', 'Db', 'm'], ['12B', 'E', ''],
];
const keyLabel = ([code, note, minor]) => `${code} · ${NOTE_ES[note]} ${minor ? 'menor' : 'mayor'} (${note}${minor})`;

// Tonalidades que combinan (mezcla armónica): la misma, ±1 en la rueda y su relativa
function keysCompatible(a, b) {
  const pa = /^(\d{1,2})([AB])$/.exec(a || ''), pb = /^(\d{1,2})([AB])$/.exec(b || '');
  if (!pa || !pb) return false;
  const na = +pa[1], nb = +pb[1];
  if (pa[2] === pb[2]) return na === nb || (na % 12) + 1 === nb || (nb % 12) + 1 === na;
  return na === nb;
}

let infoTrack = null;

function openTrackInfo(t) {
  infoTrack = t;
  const d = getCueData(t.id);
  $('#tiTitle').textContent = t.title;
  $('#tiBpm').value = d.bpm || '';
  $('#tiKey').value = d.key || '';
  $('#tiEnergy').value = d.energy || '';
  $('#tiTags').value = (d.tags || []).join(', ');
  $('#tiNotes').value = d.notes || '';
  $('#dlgTrack').showModal();
}

function bindTrackInfo() {
  $('#tiKey').innerHTML = '<option value="">— Sin tonalidad —</option>' +
    CAMELOT.map((k) => `<option value="${k[0]}">${keyLabel(k)}</option>`).join('');
  $('#dlgTrack').addEventListener('close', () => {
    if ($('#dlgTrack').returnValue !== 'save' || !infoTrack) return;
    const d = getCueData(infoTrack.id);
    const bpm = parseFloat(String($('#tiBpm').value).replace(',', '.'));
    d.bpm = bpm > 30 && bpm < 300 ? Math.round(bpm * 10) / 10 : null;
    d.key = $('#tiKey').value || null;
    d.energy = +$('#tiEnergy').value || null;
    d.tags = $('#tiTags').value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
    d.notes = $('#tiNotes').value.trim();
    saveCues();
    for (const deck of deckList) {
      if (deck.track?.id === infoTrack.id) { deck.bpm = d.bpm; deck.persist(); }
    }
    renderList();
    toast('Ficha guardada', 'ok');
  });
}

// =====================================================================
// Archivos de música propios (se guardan en este navegador)
// =====================================================================
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|webm)$/i;

async function addAudioFiles(files) {
  const audioFiles = files.filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
  if (!audioFiles.length) { toast('Esos archivos no son de música (MP3, WAV, M4A, OGG, FLAC…)', 'error'); return []; }
  const tracks = [];
  for (const f of audioFiles) {
    const id = 'f_' + uid() + uid();
    try {
      await idb.put('files', id, { blob: f, name: f.name, type: f.type });
    } catch {
      toast(`No hay espacio para guardar «${f.name}» en el navegador`, 'error');
      continue;
    }
    tracks.push({ id, title: f.name.replace(AUDIO_EXT, '').replace(/[_]+/g, ' ').trim(), author: 'Archivo local', dur: 0, file: true });
  }
  addTracks(tracks);
  if (tracks.length) toast(`Se ${tracks.length === 1 ? 'agregó 1 archivo' : `agregaron ${tracks.length} archivos`} a «${curPl().name}»`, 'ok');
  // Duración de cada archivo (sin decodificarlo entero)
  for (const t of tracks) {
    const rec = await idb.get('files', t.id);
    const a = new Audio();
    a.preload = 'metadata';
    a.src = URL.createObjectURL(rec.blob);
    a.addEventListener('loadedmetadata', () => {
      forEachTrack(t.id, (x) => { x.dur = Math.round(a.duration) || 0; });
      URL.revokeObjectURL(a.src);
      savePlaylists();
      renderList();
    }, { once: true });
  }
  return tracks;
}

// Borra el archivo guardado si ya no está en ninguna lista ni en la cola
function forgetFileIfUnused(id) {
  const used = playlists.some((p) => p.tracks.some((t) => t.id === id)) || isQueued(id);
  if (!used) idb.del('files', id).catch(() => {});
}

function bindFiles() {
  $('#fileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) await addAudioFiles(files);
  });
  // Soltar archivos sobre la lista
  const list = $('.library');
  list.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); list.classList.add('drop'); }
  });
  list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) list.classList.remove('drop'); });
  list.addEventListener('drop', (e) => {
    list.classList.remove('drop');
    if (!e.dataTransfer.files?.length) return;
    e.preventDefault();
    addAudioFiles([...e.dataTransfer.files]);
  });
}

// =====================================================================
// Pestañas: Lista / Cola / Historial
// =====================================================================
function bindLibraryTabs() {
  $$('#libTabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#libTabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.lib-pane').forEach((p) => { p.hidden = p.id !== b.dataset.pane; });
  }));
}

function initSession() {
  bindQueue();
  bindHistory();
  bindTrackInfo();
  bindFiles();
  bindLibraryTabs();
  renderQueue();
  renderHistory();
}
