// Clip-Typen: jeder Typ beschreibt seine Parameter (für den Inspektor) und wie er ein Bild rendert.
// render(ctx, c) bekommt c = { w, h, t (Zeit im Clip), T (Projektzeit), progress (0..1), p (Parameter),
//                               audio, bpm, media, clip }
// Alle Effekte sind zeitbasiert und deterministisch: gleiche Zeit = gleiches Bild, auch beim Scrubben.
import { clamp, fract, mix, hexToRgb, hsv, hash, fbm } from './util.js';

export const CATEGORIES = {
  gen:   { label: 'Generatoren', color: '#7c5cff' },
  text:  { label: 'Text',        color: '#e0b100' },
  audio: { label: 'Audio',       color: '#eb5757' },
  code:  { label: 'Shader',      color: '#f2994a' },
  media: { label: 'Medien',      color: '#2d9cdb' },
  live:  { label: 'Live',        color: '#27ae60' },
  node:  { label: 'Nodes',       color: '#ff6bd6' },
};

export const BLEND_MODES = [
  ['source-over', 'Normal'], ['lighter', 'Addieren'], ['screen', 'Negativ multipl.'],
  ['multiply', 'Multiplizieren'], ['overlay', 'Überlagern'], ['lighten', 'Aufhellen'],
  ['darken', 'Abdunkeln'], ['difference', 'Differenz'],
];

const FIT = [['cover', 'Füllen'], ['contain', 'Einpassen'], ['stretch', 'Strecken']];

export const DEFAULT_SHADER = `// Shadertoy-kompatibel. Verfügbar:
//   iTime, iResolution, iProgress (0..1 im Clip)
//   iAudio = (Pegel, Bass, Mitten, Höhen)   iParam = 4 Regler (0..1)
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    float t = iTime * (0.3 + iParam.x * 2.0);
    vec3 col = 0.5 + 0.5 * cos(t + uv.xyx * (3.0 + iParam.y * 10.0) + vec3(0.0, 2.0, 4.0));
    col *= 0.7 + iAudio.y * 0.6;
    fragColor = vec4(col, 1.0);
}
`;

// Startgraph für neue Patch-Clips (Knotentypen stehen in nodes.js)
export const DEFAULT_GRAPH = {
  nodes: [
    { id: 'regler', type: 'params', x: 0, y: 0, params: {} },
    { id: 'lfo', type: 'lfo', x: 0, y: 200, params: { shape: 'sine', sync: 'beat', rate: 8, phase: 0, min: 0, max: 1 } },
    { id: 'plasma', type: 'gen:plasma', x: 270, y: 30, params: { speed: 1, scale: 1, hue: 0, hueRange: 0.5, saturation: 1 } },
    { id: 'kaleido', type: 'mirror', x: 540, y: 30, params: { mode: 'kaleido', segments: 6, rotate: 0 } },
    { id: 'out', type: 'output', x: 810, y: 60, params: {} },
  ],
  links: [
    { from: 'regler', out: 'a', to: 'plasma', in: 'speed' },
    { from: 'lfo', out: 'value', to: 'plasma', in: 'hue' },
    { from: 'plasma', out: 'image', to: 'kaleido', in: 'image' },
    { from: 'kaleido', out: 'image', to: 'out', in: 'image' },
  ],
};

// Berechnet jedes Pixel einzeln. fn(x, y, u, v, ax, ay, out) schreibt RGBA (0..255) nach out.
// u, v: 0..1 über Breite/Höhe. ax, ay: seitenverhältnistreu (Höhe = 1).
function shade(ctx, w, h, fn) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const o = [0, 0, 0, 255];
  const inv = 1 / Math.max(1, h - 1);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      o[0] = o[1] = o[2] = 0; o[3] = 255;
      fn(x, y, x / Math.max(1, w - 1), y * inv, x * inv, y * inv, o);
      d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; d[i + 3] = o[3];
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function drawFit(ctx, src, sw, sh, w, h, fit = 'cover', mirror = false) {
  if (!sw || !sh) return;
  let dw = w, dh = h;
  if (fit !== 'stretch') {
    const s = fit === 'contain' ? Math.min(w / sw, h / sh) : Math.max(w / sw, h / sh);
    dw = sw * s; dh = sh * s;
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.restore();
}

const num = (key, label, min, max, step, extra = {}) => ({ key, label, type: 'number', min, max, step, ...extra });
const color = (key, label) => ({ key, label, type: 'color' });
const select = (key, label, options) => ({ key, label, type: 'select', options });
const tri = (s) => 1 - Math.abs(fract(s * 0.5) * 2 - 1);   // 0→1→0 mit Periode 2, nahtlos
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };

export const CLIP_TYPES = {
  color: {
    label: 'Farbe', category: 'gen', icon: '■',
    defaults: { color: '#ff2a6d' },
    params: [color('color', 'Farbe')],
    render(ctx, { w, h, p }) {
      ctx.fillStyle = p.color;
      ctx.fillRect(0, 0, w, h);
    },
  },

  gradient: {
    label: 'Verlauf', category: 'gen', icon: '◐',
    defaults: { colorA: '#00e5ff', colorB: '#ff00a8', mode: 'linear', angle: 0, scale: 1, speed: 0.2 },
    params: [
      color('colorA', 'Farbe A'), color('colorB', 'Farbe B'),
      select('mode', 'Form', [['linear', 'Linear'], ['radial', 'Radial']]),
      num('angle', 'Winkel', 0, 360, 1, { unit: '°' }), num('scale', 'Wiederholungen', 0.1, 8, 0.1),
      num('speed', 'Bewegung', -3, 3, 0.05),
    ],
    render(ctx, { w, h, t, p }) {
      const A = hexToRgb(p.colorA), B = hexToRgb(p.colorB);
      const a = p.angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      shade(ctx, w, h, (x, y, u, v, ax, ay, o) => {
        let s = p.mode === 'radial' ? Math.hypot(u - 0.5, v - 0.5) * 2 : (u - 0.5) * ca + (v - 0.5) * sa + 0.5;
        const f = tri(s * p.scale - t * p.speed);
        o[0] = mix(A[0], B[0], f); o[1] = mix(A[1], B[1], f); o[2] = mix(A[2], B[2], f);
      });
    },
  },

  rainbow: {
    label: 'Regenbogen', category: 'gen', icon: '🌈',
    defaults: { speed: 0.3, scale: 1, angle: 0, saturation: 1 },
    params: [
      num('speed', 'Geschwindigkeit', -3, 3, 0.05), num('scale', 'Breite', 0.1, 6, 0.1),
      num('angle', 'Winkel', 0, 360, 1, { unit: '°' }), num('saturation', 'Sättigung', 0, 1, 0.01),
    ],
    render(ctx, { w, h, t, p }) {
      const a = p.angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      shade(ctx, w, h, (x, y, u, v, ax, ay, o) => {
        const c = hsv((u * ca + v * sa) * p.scale - t * p.speed, p.saturation, 1);
        o[0] = c[0]; o[1] = c[1]; o[2] = c[2];
      });
    },
  },

  plasma: {
    label: 'Plasma', category: 'gen', icon: '◍',
    defaults: { speed: 1, scale: 1, hue: 0, hueRange: 0.5, saturation: 1 },
    params: [
      num('speed', 'Geschwindigkeit', 0, 5, 0.05), num('scale', 'Größe', 0.2, 4, 0.05),
      num('hue', 'Farbton', 0, 1, 0.01), num('hueRange', 'Farbumfang', 0, 1, 0.01),
      num('saturation', 'Sättigung', 0, 1, 0.01),
    ],
    render(ctx, { w, h, t, p }) {
      const T = t * p.speed;
      const cx = Math.sin(T / 3) * 4, cy = Math.cos(T / 2) * 4;
      shade(ctx, w, h, (x, y, u, v, ax, ay, o) => {
        const X = ax * 6 / p.scale, Y = ay * 6 / p.scale;
        const val = (Math.sin(X + T) + Math.sin((Y + T) / 2) + Math.sin((X + Y + T) / 2)
          + Math.sin(Math.sqrt((X + cx) ** 2 + (Y + cy) ** 2 + 1) + T)) / 4;
        const c = hsv(p.hue + val * p.hueRange + T * 0.03, p.saturation, 1);
        o[0] = c[0]; o[1] = c[1]; o[2] = c[2];
      });
    },
  },

  fire: {
    label: 'Feuer', category: 'gen', icon: '🔥',
    defaults: { speed: 1, scale: 1, height: 1, palette: 'fire' },
    params: [
      num('speed', 'Geschwindigkeit', 0, 4, 0.05), num('scale', 'Körnung', 0.3, 4, 0.05),
      num('height', 'Flammenhöhe', 0.2, 2, 0.05),
      select('palette', 'Farben', [['fire', 'Feuer'], ['blue', 'Gas (blau)'], ['green', 'Gift (grün)']]),
    ],
    render(ctx, { w, h, t, p }) {
      const fall = 0.9 / p.height;
      shade(ctx, w, h, (x, y, u, v, ax, ay, o) => {
        const n = fbm(ax * 3 * p.scale, ay * 3 * p.scale + t * p.speed * 2.5, t * 0.6, 4);
        const f = clamp(n * 1.3 - (1 - v) * fall + 0.05);
        const a = clamp(f * 3) * 255, b = clamp(f * 3 - 1) * 255, c = clamp(f * 3 - 2) * 255;
        if (p.palette === 'blue') { o[0] = c; o[1] = b; o[2] = a; }
        else if (p.palette === 'green') { o[0] = b; o[1] = a; o[2] = c; }
        else { o[0] = a; o[1] = b; o[2] = c; }
      });
    },
  },

  clouds: {
    label: 'Wolken', category: 'gen', icon: '☁',
    defaults: { colorA: '#001133', colorB: '#33ccff', scale: 1, speed: 0.3, contrast: 1.5 },
    params: [
      color('colorA', 'Farbe A'), color('colorB', 'Farbe B'), num('scale', 'Größe', 0.2, 4, 0.05),
      num('speed', 'Geschwindigkeit', 0, 3, 0.05), num('contrast', 'Kontrast', 0.5, 4, 0.05),
    ],
    render(ctx, { w, h, t, p }) {
      const A = hexToRgb(p.colorA), B = hexToRgb(p.colorB);
      shade(ctx, w, h, (x, y, u, v, ax, ay, o) => {
        const n = fbm(ax * 3 / p.scale + t * p.speed * 0.5, ay * 3 / p.scale, t * p.speed * 0.4, 4);
        const f = clamp((n - 0.5) * p.contrast + 0.5);
        o[0] = mix(A[0], B[0], f); o[1] = mix(A[1], B[1], f); o[2] = mix(A[2], B[2], f);
      });
    },
  },

  sparkle: {
    label: 'Glitzer', category: 'gen', icon: '✦',
    defaults: { color: '#ffffff', density: 0.15, rate: 1.5, decay: 3, rainbow: false },
    params: [
      color('color', 'Farbe'), num('density', 'Dichte', 0, 1, 0.01), num('rate', 'Tempo', 0.1, 10, 0.1, { unit: 'Hz' }),
      num('decay', 'Ausklingen', 0.5, 10, 0.1), { key: 'rainbow', label: 'Bunte Funken', type: 'bool' },
    ],
    render(ctx, { w, h, t, p }) {
      const C = hexToRgb(p.color);
      shade(ctx, w, h, (x, y, u, v, ax, ay, o) => {
        const i = y * w + x;
        const ph = t * p.rate + hash(i, 7);
        const cell = Math.floor(ph);
        const b = hash(i, cell) < p.density ? Math.pow(1 - (ph - cell), p.decay) : 0;
        const c = p.rainbow ? hsv(hash(i, cell, 3), 0.8, 1) : C;
        o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; o[3] = b * 255;
      });
    },
  },

  stripes: {
    label: 'Streifen', category: 'gen', icon: '▤',
    defaults: { colorA: '#ffffff', colorB: '#000000', count: 4, speed: 1, angle: 90, softness: 0.3 },
    params: [
      color('colorA', 'Farbe A'), color('colorB', 'Farbe B'), num('count', 'Anzahl', 0.5, 32, 0.5),
      num('speed', 'Geschwindigkeit', -5, 5, 0.05), num('angle', 'Winkel', 0, 360, 1, { unit: '°' }),
      num('softness', 'Weichheit', 0, 1, 0.01),
    ],
    render(ctx, { w, h, t, p }) {
      const A = hexToRgb(p.colorA), B = hexToRgb(p.colorB);
      const a = p.angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      shade(ctx, w, h, (x, y, u, v, ax, ay, o) => {
        const s = ((u - 0.5) * ca + (v - 0.5) * sa) * p.count - t * p.speed;
        const k = Math.abs(fract(s) * 2 - 1);
        const m = smooth(0.5 - p.softness * 0.5, 0.5 + p.softness * 0.5, k);
        o[0] = mix(A[0], B[0], m); o[1] = mix(A[1], B[1], m); o[2] = mix(A[2], B[2], m);
      });
    },
  },

  strobe: {
    label: 'Stroboskop', category: 'gen', icon: '⚡',
    defaults: { color: '#ffffff', sync: 'beat', rate: 1, duty: 0.25 },
    params: [
      color('color', 'Farbe'),
      select('sync', 'Takt', [['beat', 'Pro Beat (BPM)'], ['hz', 'Hertz']]),
      num('rate', 'Blitze pro Beat / Hz', 0.25, 16, 0.25), num('duty', 'Leuchtdauer', 0.02, 1, 0.01),
    ],
    render(ctx, { w, h, t, p, bpm }) {
      const hz = p.sync === 'beat' ? (bpm / 60) * p.rate : p.rate;
      if (fract(t * hz) < p.duty) {
        ctx.fillStyle = p.color;
        ctx.fillRect(0, 0, w, h);
      }
    },
  },

  text: {
    label: 'Lauftext', category: 'text', icon: 'T',
    defaults: { text: 'HELLO', color: '#ffffff', size: 0.9, speed: 12, font: 'sans-serif', weight: 'bold', y: 0 },
    params: [
      { key: 'text', label: 'Text', type: 'text' }, color('color', 'Farbe'),
      num('size', 'Größe', 0.2, 2, 0.05), num('speed', 'Tempo (0 = stehend)', -60, 60, 1, { unit: 'px/s' }),
      select('font', 'Schrift', [['sans-serif', 'Sans'], ['serif', 'Serif'], ['monospace', 'Mono'], ['Impact, sans-serif', 'Impact']]),
      select('weight', 'Stärke', [['normal', 'Normal'], ['bold', 'Fett']]),
      num('y', 'Vertikal', -1, 1, 0.01),
    ],
    render(ctx, { w, h, t, p }) {
      ctx.font = `${p.weight} ${Math.max(4, p.size * h)}px ${p.font}`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = p.color;
      const tw = ctx.measureText(p.text).width;
      const y = h / 2 + p.y * h / 2 + h * 0.04;
      let x;
      if (!p.speed) x = (w - tw) / 2;
      else {
        const travel = ((t * Math.abs(p.speed)) % (tw + w));
        x = p.speed > 0 ? w - travel : -tw + travel;
      }
      ctx.fillText(p.text, x, y);
    },
  },

  spectrum: {
    label: 'Spektrum', category: 'audio', icon: '♫',
    defaults: { colorA: '#00ff88', colorB: '#ff0055', mode: 'bars', gain: 1.2 },
    params: [
      color('colorA', 'Farbe tief'), color('colorB', 'Farbe hoch'),
      select('mode', 'Darstellung', [['bars', 'Balken'], ['mirror', 'Gespiegelt'], ['center', 'Von der Mitte']]),
      num('gain', 'Verstärkung', 0.2, 4, 0.05),
    ],
    render(ctx, { w, h, p, audio }) {
      const spec = audio.spectrum;
      if (!spec) return;
      const A = hexToRgb(p.colorA), B = hexToRgb(p.colorB);
      const cols = p.mode === 'mirror' ? Math.ceil(w / 2) : w;
      for (let i = 0; i < cols; i++) {
        const idx = Math.floor(Math.pow(i / cols, 1.7) * spec.length * 0.75);
        const val = clamp((spec[idx] / 255) * p.gain);
        const f = i / Math.max(1, cols - 1);
        ctx.fillStyle = `rgb(${mix(A[0], B[0], f)},${mix(A[1], B[1], f)},${mix(A[2], B[2], f)})`;
        const bh = val * h;
        const draw = (x) => p.mode === 'center'
          ? ctx.fillRect(x, (h - bh) / 2, 1, bh)
          : ctx.fillRect(x, h - bh, 1, bh);
        if (p.mode === 'mirror') { draw(cols - 1 - i); draw(w - cols + i); } else draw(i);
      }
    },
  },

  shader: {
    label: 'GLSL-Shader', category: 'code', icon: '{ }',
    defaults: { code: DEFAULT_SHADER, p1: 0.2, p2: 0.3, p3: 0.5, p4: 0.5 },
    params: [
      { key: 'code', label: 'Shader-Code', type: 'code' },
      num('p1', 'iParam.x', 0, 1, 0.01), num('p2', 'iParam.y', 0, 1, 0.01),
      num('p3', 'iParam.z', 0, 1, 0.01), num('p4', 'iParam.w', 0, 1, 0.01),
    ],
    render(ctx, c) {
      const canvas = c.media.shader(c.clip, c);
      if (canvas) ctx.drawImage(canvas, 0, 0, c.w, c.h);
    },
  },

  image: {
    label: 'Bild', category: 'media', icon: '🖼',
    defaults: { src: '', fit: 'cover', zoom: 0 },
    params: [
      { key: 'src', label: 'Datei', type: 'media', kind: 'image' }, select('fit', 'Anpassung', FIT),
      num('zoom', 'Zoom-Fahrt', -1, 1, 0.01),
    ],
    render(ctx, { w, h, p, progress, media }) {
      const img = media.image(p.src);
      if (!img) return;
      const z = 1 + p.zoom * progress;
      ctx.save();
      ctx.translate(w / 2, h / 2); ctx.scale(z, z); ctx.translate(-w / 2, -h / 2);
      drawFit(ctx, img, img.naturalWidth, img.naturalHeight, w, h, p.fit);
      ctx.restore();
    },
  },

  video: {
    label: 'Video', category: 'media', icon: '🎞',
    defaults: { src: '', fit: 'cover', speed: 1, offset: 0, loop: true },
    params: [
      { key: 'src', label: 'Datei', type: 'media', kind: 'video' }, select('fit', 'Anpassung', FIT),
      num('speed', 'Geschwindigkeit', 0.1, 4, 0.05), num('offset', 'Startpunkt im Video', 0, 3600, 0.1, { unit: 's' }),
      { key: 'loop', label: 'Wiederholen', type: 'bool' },
    ],
    render(ctx, c) {
      const v = c.media.video(c.clip, c.t);
      if (v) drawFit(ctx, v, v.videoWidth, v.videoHeight, c.w, c.h, c.p.fit);
    },
  },

  camera: {
    label: 'Kamera', category: 'live', icon: '◉',
    defaults: { fit: 'cover', mirror: true },
    params: [select('fit', 'Anpassung', FIT), { key: 'mirror', label: 'Spiegeln', type: 'bool' }],
    render(ctx, { w, h, p, media }) {
      const v = media.camera();
      if (v) drawFit(ctx, v, v.videoWidth, v.videoHeight, w, h, p.fit, p.mirror);
    },
  },

  patch: {
    label: 'Node-Patch', category: 'node', icon: '⬡',
    defaults: { graph: DEFAULT_GRAPH, a: 0.5, b: 0.5, c: 0.5, d: 0.5, color: '#00e5ff' },
    params: [
      { key: 'graph', label: 'Nodes', type: 'graph' },
      num('a', 'Regler A', 0, 1, 0.01), num('b', 'Regler B', 0, 1, 0.01),
      num('c', 'Regler C', 0, 1, 0.01), num('d', 'Regler D', 0, 1, 0.01), color('color', 'Farbe'),
    ],
    render(ctx, c) {
      const img = c.media.patch(c);
      if (img) ctx.putImageData(img, 0, 0);
    },
  },
};

export const COMMON_PARAMS = [
  { key: 'name', label: 'Name', type: 'text', common: true },
  num('start', 'Start', 0, 36000, 0.01, { common: true, unit: 's' }),
  num('duration', 'Länge', 0.05, 36000, 0.01, { common: true, unit: 's' }),
  num('fadeIn', 'Einblenden', 0, 60, 0.05, { common: true, unit: 's' }),
  num('fadeOut', 'Ausblenden', 0, 60, 0.05, { common: true, unit: 's' }),
  num('opacity', 'Deckkraft', 0, 1, 0.01, { common: true }),
];
