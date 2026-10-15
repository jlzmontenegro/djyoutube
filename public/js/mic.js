'use strict';
/* Micrófono con talkover: cuando hablas, la música baja sola; al callarte, vuelve.
   El micrófono puede sonar por los parlantes (si no tienes una consola aparte para él). */

const mic = {
  stream: null,
  source: null,
  analyser: null,
  buf: new Float32Array(1024),
  level: 0,
  lastVoice: 0,

  async start() {
    const ctx = audioEngine.init();
    audioEngine.resume();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
    } catch (err) {
      toast(err.name === 'NotAllowedError'
        ? 'No diste permiso para usar el micrófono (puedes darlo en el candado de la barra de direcciones)'
        : 'No se encontró un micrófono', 'error');
      return false;
    }
    this.source = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);
    this.source.connect(audioEngine.bus.mic);
    this.applyVolume();
    this.stream.getTracks().forEach((t) => t.addEventListener('ended', () => this.stop()));
    return true;
  },

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    try { this.source?.disconnect(); } catch { /* ya desconectado */ }
    this.stream = this.source = this.analyser = null;
    this.level = 0;
    this.setDuck(1);
    paintMic();
  },

  applyVolume() {
    if (!audioEngine.ctx) return;
    const v = settings.micMonitor ? ((settings.micVol ?? 80) / 100) ** 2 * 1.5 : 0;
    audioEngine.bus.mic.gain.setTargetAtTime(v, audioEngine.ctx.currentTime, 0.02);
  },

  setDuck(v) {
    if (Math.abs(v - duckLevel) < 0.002) return;
    duckLevel = v;
    applyVolumes();
  },

  // Cada 30 ms: mide la voz y baja/sube la música con suavidad
  tick() {
    if (!this.analyser) return;
    const rms = audioEngine.rms(this.analyser, this.buf);
    this.level = rms;
    const now = performance.now();
    const threshold = 0.012 + (1 - (settings.micSens ?? 60) / 100) * 0.06;
    if (rms > threshold) this.lastVoice = now;
    const talking = settings.talkover && now - this.lastVoice < 600;
    const target = talking ? (settings.duckTo ?? 30) / 100 : 1;
    // baja rápido (~100 ms) y vuelve despacio (~600 ms)
    const k = target < duckLevel ? 0.35 : 0.06;
    this.setDuck(duckLevel + (target - duckLevel) * k);
    const meter = $('#micLevel');
    meter.style.width = `${clamp(rms * 8, 0, 1) * 100}%`;
    meter.classList.toggle('talk', talking);
  },
};

function paintMic() {
  const on = !!mic.stream;
  const b = $('#micOn');
  b.classList.toggle('on', on);
  b.textContent = on ? '● Micrófono encendido' : 'Encender micrófono';
  if (!on) $('#micLevel').style.width = '0';
}

function initMic() {
  const bindRange = (id, key, def, after) => {
    const el = $('#' + id);
    el.value = settings[key] ?? def;
    el.addEventListener('input', () => { settings[key] = +el.value; saveSettings(); after?.(); });
  };
  const bindCheck = (id, key, def, after) => {
    const el = $('#' + id);
    el.checked = settings[key] ?? def;
    settings[key] = el.checked;
    el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); after?.(); });
  };
  bindRange('micVol', 'micVol', 80, () => mic.applyVolume());
  bindRange('duckTo', 'duckTo', 30);
  bindRange('micSens', 'micSens', 60);
  bindCheck('talkover', 'talkover', true, () => { if (!settings.talkover) mic.setDuck(1); });
  bindCheck('micMonitor', 'micMonitor', true, () => mic.applyVolume());

  $('#micOn').addEventListener('click', async () => {
    if (mic.stream) mic.stop();
    else if (await mic.start()) toast('Micrófono encendido. Si oyes un pitido (acople), baja el volumen o aleja el micrófono de los parlantes.', 'ok');
    paintMic();
  });
  document.addEventListener('keydown', (e) => {
    if (!shortcutAllowed(e) || e.code !== 'KeyM') return;
    e.preventDefault();
    $('#micOn').click();
  });
  setInterval(() => mic.tick(), 30);
  paintMic();
}
