'use strict';
// Servidor local de DJ YouTube: sirve la interfaz y consulta títulos de videos (oEmbed de YouTube).
// YouTube exige que el reproductor se abra desde una página http(s), por eso no basta con abrir el HTML.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 8090;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_URL = `http://localhost:${PORT}/`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const oembedCache = new Map();

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function handleOembed(id, res) {
  if (!/^[\w-]{11}$/.test(id || '')) return sendJson(res, 400, { ok: false, status: 400 });
  if (oembedCache.has(id)) return sendJson(res, 200, oembedCache.get(id));
  try {
    const target = 'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id);
    const r = await fetch(target, { signal: AbortSignal.timeout(8000) });
    let data;
    if (r.ok) {
      const j = await r.json();
      data = { ok: true, title: j.title, author: j.author_name };
    } else {
      // 401/403: no se permite insertar; 404: privado o eliminado
      data = { ok: false, status: r.status };
    }
    oembedCache.set(id, data);
    sendJson(res, 200, data);
  } catch {
    sendJson(res, 200, { ok: false, status: 0 });
  }
}

function serveStatic(pathname, res) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Prohibido');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function openBrowser() {
  const cmd = process.platform === 'win32' ? `start "" "${APP_URL}"`
    : process.platform === 'darwin' ? `open "${APP_URL}"`
    : `xdg-open "${APP_URL}"`;
  exec(cmd);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/ping') return sendJson(res, 200, { app: 'djyoutube' });
  if (url.pathname === '/api/oembed') return void handleOembed(url.searchParams.get('id'), res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  serveStatic(url.pathname, res);
});

server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  // ¿Ya hay un DJ YouTube abierto? Entonces solo abrimos el navegador.
  try {
    const r = await fetch(`http://${HOST}:${PORT}/api/ping`);
    const j = await r.json();
    if (j.app === 'djyoutube') {
      console.log('DJ YouTube ya estaba en marcha. Abriendo el navegador...');
      openBrowser();
      return setTimeout(() => process.exit(0), 500);
    }
  } catch { /* el puerto lo usa otro programa */ }
  console.error(`El puerto ${PORT} lo está usando otro programa. Ciérralo o elige otro: set PORT=8091`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  DJ YouTube está listo en ' + APP_URL);
  console.log('  Deja esta ventana abierta mientras pinchas. Para salir pulsa Ctrl+C.');
  console.log('');
  if (!process.argv.includes('--no-open')) openBrowser();
});
