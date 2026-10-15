'use strict';
/* Efectos de video para la proyección (VJ): filtros, espejo, zoom, estrobo y flashes al ritmo,
   pulso en cada golpe, estilos de transición entre bandejas, logo y texto que pasa.
   La consola solo guarda la configuración; la ventana de proyección los dibuja. */

const VFX_DEFAULTS = {
  filter: 'none', mirror: false, zoom: 100,
  strobe: false, strobeDiv: 1, flash: false, flashColor: '#ffffff', pulse: false,
  transition: 'fade', logoPos: 'tr', logoSize: 14, marquee: '', marqueeSpeed: 18,
};
settings.vfx = Object.assign({}, VFX_DEFAULTS, settings.vfx || {});

let logoData = store.get('logo', null); // imagen en data URL (reducida)

function sendLogo() {
  channel?.postMessage({ type: 'logo', data: logoData });
}

function toggleVfx(key) {
  settings.vfx[key] = !settings.vfx[key];
  saveSettings();
  paintVfx();
  publish();
}

function paintVfx() {
  const v = settings.vfx;
  $('#vfxFilter').value = v.filter;
  $('#vfxTransition').value = v.transition;
  $('#vfxZoom').value = v.zoom;
  $('#vfxZoomVal').textContent = `${v.zoom}%`;
  $('#vfxStrobeDiv').value = String(v.strobeDiv);
  $('#vfxFlashColor').value = v.flashColor;
  $('#vfxLogoPos').value = v.logoPos;
  $('#vfxLogoSize').value = v.logoSize;
  $('#vfxMarquee').value = v.marquee;
  $('#vfxMarqueeSpeed').value = v.marqueeSpeed;
  for (const key of ['mirror', 'strobe', 'flash', 'pulse']) $(`#vfx_${key}`).classList.toggle('on', !!v[key]);
  $('#logoPreview').src = logoData || '';
  $('#logoPreview').hidden = !logoData;
  $('#logoRemove').hidden = !logoData;
}

// Reduce la imagen del logo para que viaje rápido a la proyección y quepa en el navegador
function shrinkImage(file, max = 480) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('No es una imagen válida'));
    img.src = URL.createObjectURL(file);
  });
}

function initVfx() {
  const v = settings.vfx;
  const save = () => { saveSettings(); paintVfx(); publish(); };
  const onVal = (id, key, ev = 'change', num = false) =>
    $('#' + id).addEventListener(ev, (e) => { v[key] = num ? +e.target.value : e.target.value; save(); });

  onVal('vfxFilter', 'filter');
  onVal('vfxTransition', 'transition');
  onVal('vfxZoom', 'zoom', 'input', true);
  onVal('vfxStrobeDiv', 'strobeDiv', 'change', true);
  onVal('vfxFlashColor', 'flashColor', 'input');
  onVal('vfxLogoPos', 'logoPos');
  onVal('vfxLogoSize', 'logoSize', 'input', true);
  onVal('vfxMarquee', 'marquee', 'input');
  onVal('vfxMarqueeSpeed', 'marqueeSpeed', 'input', true);
  for (const key of ['mirror', 'strobe', 'flash', 'pulse']) $(`#vfx_${key}`).addEventListener('click', () => toggleVfx(key));
  $('#vfxReset').addEventListener('click', () => {
    Object.assign(v, VFX_DEFAULTS, { marquee: v.marquee, logoPos: v.logoPos, logoSize: v.logoSize });
    save();
  });

  $('#logoFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      logoData = await shrinkImage(f);
      store.set('logo', logoData);
      sendLogo();
      paintVfx();
      toast('Logo cargado en la proyección', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#logoRemove').addEventListener('click', () => {
    logoData = null;
    store.set('logo', null);
    sendLogo();
    paintVfx();
  });

  // Atajos: J = estrobo, K = flash al ritmo
  document.addEventListener('keydown', (e) => {
    if (!shortcutAllowed(e)) return;
    if (e.code === 'KeyJ') { e.preventDefault(); toggleVfx('strobe'); }
    if (e.code === 'KeyK') { e.preventDefault(); toggleVfx('flash'); }
  });
  paintVfx();
}

// Espectro de las bandejas MP3 para el visualizador de la proyección (~30 veces por segundo)
function publishSpectrum() {
  if (!channel) return;
  const bands = (d) => (d.kind === 'file' && d.fe && d.playing ? d.fe.bands(32) : null);
  const A = bands(decks.A), B = bands(decks.B);
  if (A || B) channel.postMessage({ type: 'spec', A, B });
}
