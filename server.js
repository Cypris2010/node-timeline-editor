// LED Timeline – lokaler Server: liefert die Oberfläche aus, speichert Projekte/Medien
// und leitet die im Browser gerenderten Frames per UDP an WLED weiter.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Output, DEFAULT_PORTS } from './lib/output.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const MEDIA = path.join(DATA, 'media');
const PROJECTS = path.join(DATA, 'projects');
const OUTPUT_FILE = path.join(DATA, 'output.json');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
};
const KIND = (ext) => {
  const t = MIME[ext] || '';
  return t.startsWith('video') ? 'video' : t.startsWith('image') ? 'image' : t.startsWith('audio') ? 'audio' : null;
};

await fsp.mkdir(MEDIA, { recursive: true });
await fsp.mkdir(PROJECTS, { recursive: true });

let savedOutput = {};
try { savedOutput = JSON.parse(await fsp.readFile(OUTPUT_FILE, 'utf8')); } catch { /* erster Start */ }
const output = new Output(savedOutput);

const safeName = (s) => String(s).normalize('NFC').replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^\.+/, '').slice(0, 120) || 'unbenannt';

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 20e6) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Anfrage zu groß'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function serveFile(base, rel, req, res) {
  const file = path.resolve(base, '.' + path.sep + decodeURIComponent(rel));
  if (!file.startsWith(base + path.sep)) return sendJson(res, { error: 'Nicht gefunden' }, 404);
  let stat;
  try { stat = await fsp.stat(file); } catch { return sendJson(res, { error: 'Nicht gefunden' }, 404); }
  if (!stat.isFile()) return sendJson(res, { error: 'Nicht gefunden' }, 404);

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    // Byte-Ranges braucht der Browser, um in Videos springen zu können
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    end = Math.min(end, stat.size - 1);
    if (!(start >= 0) || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1,
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

async function listMedia() {
  const files = await fsp.readdir(MEDIA);
  return files
    .map((name) => ({ name, kind: KIND(path.extname(name).toLowerCase()), url: '/media/' + encodeURIComponent(name) }))
    .filter((m) => m.kind)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = req.method;

    if (p === '/api/output') {
      if (method === 'PUT') {
        output.configure(JSON.parse(await readBody(req)));
        await fsp.writeFile(OUTPUT_FILE, JSON.stringify(output.config, null, 2));
        broadcast({ type: 'output', config: output.config });
      }
      return sendJson(res, { config: output.config, defaultPorts: DEFAULT_PORTS });
    }
    if (p === '/api/blackout' && method === 'POST') {
      output.blackout();
      return sendJson(res, { ok: true });
    }

    if (p === '/api/projects' && method === 'GET') {
      const files = (await fsp.readdir(PROJECTS)).filter((f) => f.endsWith('.json'));
      return sendJson(res, files.map((f) => f.slice(0, -5)).sort());
    }
    const proj = p.match(/^\/api\/projects\/([^/]+)$/);
    if (proj) {
      const file = path.join(PROJECTS, safeName(decodeURIComponent(proj[1])) + '.json');
      if (method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        await fsp.writeFile(file, JSON.stringify(body, null, 2));
        return sendJson(res, { ok: true, name: path.basename(file, '.json') });
      }
      if (method === 'DELETE') {
        await fsp.rm(file, { force: true });
        return sendJson(res, { ok: true });
      }
      try { return sendJson(res, JSON.parse(await fsp.readFile(file, 'utf8'))); }
      catch { return sendJson(res, { error: 'Projekt nicht gefunden' }, 404); }
    }

    if (p === '/api/media' && method === 'GET') return sendJson(res, await listMedia());
    if (p === '/api/media' && method === 'POST') {
      // Upload als roher Body: POST /api/media?name=datei.mp4
      const name = safeName(url.searchParams.get('name') || 'datei');
      const ext = path.extname(name).toLowerCase();
      if (!KIND(ext)) return sendJson(res, { error: `Dateityp ${ext || '?'} wird nicht unterstützt` }, 415);
      let target = name;
      for (let i = 2; fs.existsSync(path.join(MEDIA, target)); i++) target = `${path.basename(name, ext)}-${i}${ext}`;
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(path.join(MEDIA, target));
        req.pipe(ws).on('finish', resolve).on('error', reject);
        req.on('error', reject);
      });
      return sendJson(res, { name: target, kind: KIND(ext), url: '/media/' + encodeURIComponent(target) });
    }
    if (p.startsWith('/media/')) return serveFile(MEDIA, p.slice(7), req, res);

    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, { error: 'Methode nicht erlaubt' }, 405);
    return serveFile(PUBLIC, p === '/' ? 'index.html' : p.slice(1), req, res);
  } catch (e) {
    console.error(e);
    sendJson(res, { error: e.message }, e.status || 500);
  }
});

// WebSocket: Browser schickt Frames, Server meldet Statistiken zurück.
// Nur der zuletzt geöffnete Tab darf senden, damit sich zwei Tabs nicht überlagern.
const wss = new WebSocketServer({ server, path: '/ws' });
let master = null;

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}
function announceMaster() {
  for (const c of wss.clients) if (c.readyState === 1) c.send(JSON.stringify({ type: 'role', master: c === master }));
}

wss.on('connection', (ws) => {
  master = ws;
  announceMaster();
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (ws === master) output.sendFrame(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'claim') { master = ws; announceMaster(); }
  });
  ws.on('close', () => {
    if (master === ws) {
      master = [...wss.clients].filter((c) => c.readyState === 1).pop() || null;
      announceMaster();
    }
  });
});

setInterval(() => {
  const s = output.takeStats();
  broadcast({ type: 'stats', ...s, target: `${output.config.host}:${output.port}`, protocol: output.config.protocol });
}, 1000);

server.listen(PORT, HOST, () => {
  console.log(`LED Timeline läuft auf http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Ausgabe: ${output.config.protocol.toUpperCase()} → ${output.config.host}:${output.port} (${output.config.width}×${output.config.height})`);
});
