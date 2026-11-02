// Wandelt gerenderte RGB-Frames in Netzwerkpakete für WLED um (DDP, Art-Net, sACN/E1.31).
import dgram from 'node:dgram';
import crypto from 'node:crypto';

export const DEFAULT_OUTPUT = {
  enabled: true,
  protocol: 'ddp',      // ddp | artnet | sacn
  host: '192.168.1.50',
  port: 0,              // 0 = Standardport des Protokolls
  universe: 1,          // Start-Universe (nur Art-Net / sACN)
  width: 32,
  height: 16,
  wiring: 'rows',       // rows = Zeilen verkabelt, columns = Spalten verkabelt
  serpentine: true,     // Zickzack: jede zweite Zeile/Spalte läuft rückwärts
  flipX: false,
  flipY: false,
  brightness: 0.8,
  gamma: 2.2,
  fps: 40,
};

export const DEFAULT_PORTS = { ddp: 4048, artnet: 6454, sacn: 5568 };

const DDP_MAX_DATA = 1440;     // 480 RGB-Pixel pro Paket
const DMX_PIXELS = 170;        // 170 RGB-Pixel = 510 von 512 Kanälen pro Universe

const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

function sanitize(c) {
  const d = DEFAULT_OUTPUT;
  return {
    enabled: Boolean(c.enabled),
    protocol: ['ddp', 'artnet', 'sacn'].includes(c.protocol) ? c.protocol : d.protocol,
    host: String(c.host || d.host).trim(),
    port: Math.round(clamp(c.port, 0, 65535, 0)),
    universe: Math.round(clamp(c.universe, 0, 63999, d.universe)),
    width: Math.round(clamp(c.width, 1, 512, d.width)),
    height: Math.round(clamp(c.height, 1, 512, d.height)),
    wiring: c.wiring === 'columns' ? 'columns' : 'rows',
    serpentine: Boolean(c.serpentine),
    flipX: Boolean(c.flipX),
    flipY: Boolean(c.flipY),
    brightness: clamp(c.brightness, 0, 1, d.brightness),
    gamma: clamp(c.gamma, 1, 4, d.gamma),
    fps: Math.round(clamp(c.fps, 1, 120, d.fps)),
  };
}

export class Output {
  constructor(config = {}) {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (e) => { this.lastError = e.message; });
    this.cid = crypto.randomBytes(16);   // sACN-Absenderkennung
    this.seq = 0;
    this.stats = { frames: 0, packets: 0, bytes: 0 };
    this.lastError = null;
    this.config = { ...DEFAULT_OUTPUT };
    this.configure(config);
  }

  configure(patch) {
    const wasEnabled = this.config.enabled;
    this.config = sanitize({ ...this.config, ...patch });
    this.buildLut();
    this.buildMapping();
    this.lastError = null;
    if (wasEnabled && !this.config.enabled) this.blackout(true);
  }

  buildLut() {
    const { gamma, brightness } = this.config;
    this.lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) this.lut[i] = Math.round(Math.pow(i / 255, gamma) * 255 * brightness);
  }

  // mapping[ledIndex] = Pixelindex im gerenderten Bild (zeilenweise, oben links beginnend)
  buildMapping() {
    const { width: w, height: h, wiring, serpentine, flipX, flipY } = this.config;
    const map = new Uint32Array(w * h);
    let i = 0;
    const put = (x, y) => {
      if (flipX) x = w - 1 - x;
      if (flipY) y = h - 1 - y;
      map[i++] = y * w + x;
    };
    if (wiring === 'rows') {
      for (let y = 0; y < h; y++)
        for (let c = 0; c < w; c++) put(serpentine && y % 2 ? w - 1 - c : c, y);
    } else {
      for (let x = 0; x < w; x++)
        for (let r = 0; r < h; r++) put(x, serpentine && x % 2 ? h - 1 - r : r);
    }
    this.mapping = map;
  }

  get port() {
    return this.config.port || DEFAULT_PORTS[this.config.protocol];
  }

  // frame: Buffer mit [Breite u16 LE][Höhe u16 LE][RGB...]
  sendFrame(frame) {
    if (!this.config.enabled || frame.length < 4) return;
    const w = frame.readUInt16LE(0);
    const h = frame.readUInt16LE(2);
    if (w !== this.config.width || h !== this.config.height || frame.length < 4 + w * h * 3) {
      this.lastError = `Framegröße ${w}×${h} passt nicht zur Ausgabe ${this.config.width}×${this.config.height}`;
      return;
    }
    const n = w * h;
    const out = Buffer.allocUnsafe(n * 3);
    const { mapping, lut } = this;
    for (let i = 0; i < n; i++) {
      const s = 4 + mapping[i] * 3;
      out[i * 3] = lut[frame[s]];
      out[i * 3 + 1] = lut[frame[s + 1]];
      out[i * 3 + 2] = lut[frame[s + 2]];
    }
    this.sendPixels(out);
  }

  blackout(force = false) {
    if (!force && !this.config.enabled) return;
    this.sendPixels(Buffer.alloc(this.config.width * this.config.height * 3));
  }

  sendPixels(rgb) {
    this.seq = (this.seq + 1) & 0xff;
    const proto = this.config.protocol;
    if (proto === 'ddp') this.sendDdp(rgb);
    else if (proto === 'artnet') this.sendArtnet(rgb);
    else this.sendSacn(rgb);
    this.stats.frames++;
  }

  send(packet) {
    this.socket.send(packet, this.port, this.config.host, (err) => {
      if (err) this.lastError = err.message;
    });
    this.stats.packets++;
    this.stats.bytes += packet.length;
  }

  sendDdp(rgb) {
    const seq = (this.seq % 15) + 1;  // DDP-Sequenz 1..15
    for (let off = 0; off < rgb.length; off += DDP_MAX_DATA) {
      const chunk = rgb.subarray(off, off + DDP_MAX_DATA);
      const last = off + DDP_MAX_DATA >= rgb.length;
      const header = Buffer.alloc(10);
      header[0] = 0x40 | (last ? 0x01 : 0x00);  // Version 1, Push-Flag im letzten Paket
      header[1] = seq;
      header[2] = 0x01;                          // Datentyp RGB
      header[3] = 0x01;                          // Ziel: Standard-Ausgabe
      header.writeUInt32BE(off, 4);
      header.writeUInt16BE(chunk.length, 8);
      this.send(Buffer.concat([header, chunk]));
    }
  }

  sendArtnet(rgb) {
    const per = DMX_PIXELS * 3;
    for (let k = 0, off = 0; off < rgb.length; k++, off += per) {
      const data = rgb.subarray(off, off + per);
      const len = data.length + (data.length % 2);   // Art-Net verlangt gerade Länge
      const uni = this.config.universe + k;
      const p = Buffer.alloc(18 + len);
      p.write('Art-Net\0', 0, 'ascii');
      p.writeUInt16LE(0x5000, 8);   // OpDmx
      p.writeUInt16BE(14, 10);      // Protokollversion
      p[12] = this.seq || 1;
      p[13] = 0;                    // Physical
      p[14] = uni & 0xff;           // SubUni
      p[15] = (uni >> 8) & 0x7f;    // Net
      p.writeUInt16BE(len, 16);
      data.copy(p, 18);
      this.send(p);
    }
  }

  sendSacn(rgb) {
    const per = DMX_PIXELS * 3;
    for (let k = 0, off = 0; off < rgb.length; k++, off += per) {
      const data = rgb.subarray(off, off + per);
      const total = 126 + data.length;
      const p = Buffer.alloc(total);
      // Root Layer
      p.writeUInt16BE(0x0010, 0);
      p.write('ASC-E1.17', 4, 'ascii');
      p.writeUInt16BE(0x7000 | (total - 16), 16);
      p.writeUInt32BE(0x00000004, 18);
      this.cid.copy(p, 22);
      // Framing Layer
      p.writeUInt16BE(0x7000 | (total - 38), 38);
      p.writeUInt32BE(0x00000002, 40);
      p.write('LED Timeline', 44, 'utf8');
      p[108] = 100;                  // Priorität
      p[111] = this.seq;
      p.writeUInt16BE(Math.max(1, this.config.universe + k), 113);
      // DMP Layer
      p.writeUInt16BE(0x7000 | (total - 115), 115);
      p[117] = 0x02;
      p[118] = 0xa1;
      p.writeUInt16BE(0x0001, 121);
      p.writeUInt16BE(data.length + 1, 123);
      p[125] = 0x00;                 // DMX-Startcode
      data.copy(p, 126);
      this.send(p);
    }
  }

  takeStats() {
    const s = { ...this.stats, error: this.lastError };
    this.stats = { frames: 0, packets: 0, bytes: 0 };
    return s;
  }
}
