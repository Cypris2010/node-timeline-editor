// Node-Graph für Patch-Clips: Knoten mit Ein- und Ausgängen, die jeden Frame ausgewertet werden.
// Graph: { nodes: [{ id, type, x, y, params }], links: [{ from, out, to, in }] }
// Anschlusstypen: 'image' (ImageData in Matrixgröße, RGBA), 'number', 'color' ('#rrggbb').
// Andere Eingänge (Auswahl, Text, Schalter …) sind reine Einstellungen ohne Anschluss.
import { CLIP_TYPES } from './clips.js';
import { clamp, fract, mix, hexToRgb, hsv, hash, noise3, uid } from './util.js';

export const PORT_TYPES = {
  image:  { label: 'Bild',  color: '#4fb3ff' },
  number: { label: 'Zahl',  color: '#f2c94c' },
  color:  { label: 'Farbe', color: '#ff6bd6' },
};
export const isPort = (def) => def.type in PORT_TYPES;

export const NODE_CATEGORIES = {
  in:  { label: 'Eingänge',        color: '#27ae60' },
  gen: { label: 'Generatoren',     color: '#7c5cff' },
  fx:  { label: 'Bild bearbeiten', color: '#2d9cdb' },
  num: { label: 'Zahlen & Farben', color: '#f2994a' },
  out: { label: 'Ausgang',         color: '#ff2a6d' },
};

const num = (key, label, min, max, step, def, extra = {}) => ({ key, label, type: 'number', min, max, step, default: def, ...extra });
const img = (key = 'image', label = 'Bild') => ({ key, label, type: 'image' });
const col = (key, label, def) => ({ key, label, type: 'color', default: def });
const sel = (key, label, options, def = options[0][0]) => ({ key, label, type: 'select', options, default: def });
const bool = (key, label, def = false) => ({ key, label, type: 'bool', default: def });
const out = (key, label, type) => ({ key, label, type });
const IMAGE_OUT = [out('image', 'Bild', 'image')];

const toHex = (r, g, b) => '#' + [r, g, b].map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')).join('');
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };
const lumAt = (d, i) => (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;

// Ausgabepuffer eines Knotens, wird jeden Frame wiederverwendet
function buffer(state, w, h, key = 'buf') {
  let b = state[key];
  if (!b || b.width !== w || b.height !== h) b = state[key] = new ImageData(w, h);
  return b;
}

// Bilinear abtasten. edge: 'none' (außen transparent), 'clamp' (Randpixel), 'wrap' (kacheln)
function sample(src, x, y, edge, o) {
  const { width: w, height: h, data: d } = src;
  x -= 0.5; y -= 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  o[0] = o[1] = o[2] = o[3] = 0;
  for (let j = 0; j < 4; j++) {
    const wt = (j & 1 ? fx : 1 - fx) * (j & 2 ? fy : 1 - fy);
    if (wt <= 0) continue;
    let xi = x0 + (j & 1), yi = y0 + (j >> 1);
    if (edge === 'wrap') { xi = ((xi % w) + w) % w; yi = ((yi % h) + h) % h; }
    else if (edge === 'clamp') { xi = clamp(xi, 0, w - 1); yi = clamp(yi, 0, h - 1); }
    else if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
    const i = (yi * w + xi) * 4, a = d[i + 3] * wt;
    o[0] += d[i] * a; o[1] += d[i + 1] * a; o[2] += d[i + 2] * a; o[3] += a;
  }
  if (o[3] > 0) { o[0] /= o[3]; o[1] /= o[3]; o[2] /= o[3]; }
}

// Für jedes Ausgabepixel eine Quellposition berechnen: fn(x, y, p) setzt p[0], p[1]
function remap(src, dst, edge, fn) {
  const { width: w, height: h } = dst, d = dst.data;
  const p = [0, 0], o = [0, 0, 0, 0];
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      fn(x + 0.5, y + 0.5, p);
      sample(src, p[0], p[1], edge, o);
      d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; d[i + 3] = o[3];
    }
  }
  return dst;
}

const BLENDS = [
  ['fade', 'Überblenden'], ['over', 'B darüber'], ['add', 'Addieren'], ['screen', 'Negativ multipl.'],
  ['multiply', 'Multiplizieren'], ['difference', 'Differenz'], ['max', 'Aufhellen'], ['min', 'Abdunkeln'],
];

const LFO_SHAPES = [['sine', 'Sinus'], ['tri', 'Dreieck'], ['saw', 'Sägezahn'], ['square', 'Rechteck'], ['random', 'Zufall (Stufen)']];
const lfoShape = (shape, ph) => {
  switch (shape) {
    case 'tri': return 1 - Math.abs(fract(ph) * 2 - 1);
    case 'saw': return fract(ph);
    case 'square': return fract(ph) < 0.5 ? 1 : 0;
    case 'random': return hash(Math.floor(ph), 91);
    default: return 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
  }
};

export const NODE_TYPES = {
  // ---------- Eingänge ----------
  time: {
    label: 'Zeit', cat: 'in', icon: '⏱', inputs: [],
    outputs: [out('t', 'Sekunden im Clip', 'number'), out('progress', 'Fortschritt 0..1', 'number'),
      out('beat', 'Beat-Phase 0..1', 'number'), out('bar', 'Takt-Phase 0..1', 'number'), out('count', 'Beat-Nummer', 'number')],
    run(I, { env }) {
      const b = env.T * env.bpm / 60;   // Projektzeit, damit Beats zum Song-Raster passen
      return { t: env.t, progress: env.progress, beat: fract(b), bar: fract(b / 4), count: Math.floor(b) };
    },
  },
  audio: {
    label: 'Audio', cat: 'in', icon: '♪', inputs: [],
    outputs: [out('level', 'Pegel', 'number'), out('bass', 'Bass', 'number'), out('mid', 'Mitten', 'number'), out('high', 'Höhen', 'number')],
    run(I, { env }) {
      const a = env.audio;
      return { level: a.level, bass: a.bass, mid: a.mid, high: a.high };
    },
  },
  params: {
    label: 'Clip-Regler', cat: 'in', icon: '🎚', inputs: [],
    hint: 'Die Regler A–D und die Farbe stehen im Inspektor und lassen sich dort mit Keyframes animieren.',
    outputs: [out('a', 'A', 'number'), out('b', 'B', 'number'), out('c', 'C', 'number'), out('d', 'D', 'number'), out('color', 'Farbe', 'color')],
    run(I, { env }) {
      const p = env.p;
      return { a: p.a, b: p.b, c: p.c, d: p.d, color: p.color };
    },
  },
  below: {
    label: 'Darunter', cat: 'in', icon: '⬓', inputs: [],
    hint: 'Alles, was die tieferen Spuren gerade zeigen. So wird der Patch zum Effekt für andere Clips.',
    outputs: IMAGE_OUT,
    run(I, { env }) { return { image: env.below() }; },
  },

  // ---------- Generatoren (werden unten aus den Clip-Typen erzeugt) ----------

  // ---------- Bild bearbeiten ----------
  mix: {
    label: 'Mischen', cat: 'fx', icon: '◑',
    inputs: [img('a', 'A'), img('b', 'B'), num('amount', 'Anteil B', 0, 1, 0.01, 0.5), sel('mode', 'Modus', BLENDS)],
    outputs: IMAGE_OUT,
    run(I, { env, state }) {
      const A = I.a?.data, B = I.b?.data, f = clamp(I.amount), mode = I.mode;
      if (!A && !B) return { image: null };
      const o = buffer(state, env.w, env.h), d = o.data;
      for (let i = 0; i < d.length; i += 4) {
        const xa = A ? A[i + 3] / 255 : 0, ya = B ? B[i + 3] / 255 : 0;
        const yf = ya * f;
        let alpha;
        switch (mode) {
          case 'fade': alpha = mix(xa, ya, f); break;
          case 'over': alpha = xa + yf * (1 - xa); break;
          case 'multiply': alpha = xa; break;
          default: alpha = Math.max(xa, yf);
        }
        for (let k = 0; k < 3; k++) {
          const x = A ? A[i + k] * xa : 0, y = B ? B[i + k] * ya : 0;   // vormultipliziert
          let r;
          switch (mode) {
            case 'fade': r = mix(x, y, f); break;
            case 'over': r = x * (1 - yf) + y * f; break;
            case 'add': r = x + y * f; break;
            case 'screen': r = mix(x, x + y - (x * y) / 255, f); break;
            case 'multiply': r = mix(x, (x * (B ? B[i + k] : 0)) / 255, yf); break;
            case 'difference': r = mix(x, Math.abs(x - y), f); break;
            case 'max': r = mix(x, Math.max(x, y), f); break;
            default: r = mix(x, Math.min(x, y), f);
          }
          d[i + k] = alpha > 0 ? r / alpha : 0;
        }
        d[i + 3] = alpha * 255;
      }
      return { image: o };
    },
  },
  mask: {
    label: 'Maske', cat: 'fx', icon: '◧',
    hint: 'Helle Stellen der Maske lassen das Bild durch, dunkle blenden es aus.',
    inputs: [img(), img('mask', 'Maske'), bool('invert', 'Umkehren')],
    outputs: IMAGE_OUT,
    run(I, { env, state }) {
      if (!I.image) return { image: null };
      const s = I.image.data, m = I.mask?.data, o = buffer(state, env.w, env.h), d = o.data;
      for (let i = 0; i < d.length; i += 4) {
        let k = m ? lumAt(m, i) * (m[i + 3] / 255) : 1;
        if (I.invert) k = 1 - k;
        d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = s[i + 3] * k;
      }
      return { image: o };
    },
  },
  adjust: {
    label: 'Farbe anpassen', cat: 'fx', icon: '◐',
    inputs: [img(), num('brightness', 'Helligkeit', 0, 3, 0.01, 1), num('contrast', 'Kontrast', 0, 3, 0.01, 1),
      num('saturation', 'Sättigung', 0, 3, 0.01, 1), num('hue', 'Farbton drehen', -1, 1, 0.01, 0), bool('invert', 'Invertieren')],
    outputs: IMAGE_OUT,
    run(I, { env, state }) {
      if (!I.image) return { image: null };
      const s = I.image.data, o = buffer(state, env.w, env.h), d = o.data;
      // Farbton-Drehung als Matrix (wie CSS hue-rotate)
      const a = I.hue * Math.PI * 2, c = Math.cos(a), n = Math.sin(a);
      const M = [
        0.213 + c * 0.787 - n * 0.213, 0.715 - c * 0.715 - n * 0.715, 0.072 - c * 0.072 + n * 0.928,
        0.213 - c * 0.213 + n * 0.143, 0.715 + c * 0.285 + n * 0.140, 0.072 - c * 0.072 - n * 0.283,
        0.213 - c * 0.213 - n * 0.787, 0.715 - c * 0.715 + n * 0.715, 0.072 + c * 0.928 + n * 0.072,
      ];
      for (let i = 0; i < d.length; i += 4) {
        let r = s[i], g = s[i + 1], b = s[i + 2];
        if (I.invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
        if (I.hue) [r, g, b] = [M[0] * r + M[1] * g + M[2] * b, M[3] * r + M[4] * g + M[5] * b, M[6] * r + M[7] * g + M[8] * b];
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = L + (r - L) * I.saturation; g = L + (g - L) * I.saturation; b = L + (b - L) * I.saturation;
        d[i] = ((r - 128) * I.contrast + 128) * I.brightness;
        d[i + 1] = ((g - 128) * I.contrast + 128) * I.brightness;
        d[i + 2] = ((b - 128) * I.contrast + 128) * I.brightness;
        d[i + 3] = s[i + 3];
      }
      return { image: o };
    },
  },
  tint: {
    label: 'Einfärben', cat: 'fx', icon: '🎨',
    hint: 'Ersetzt die Helligkeit des Bildes durch einen Verlauf von Farbe A (dunkel) nach B (hell).',
    inputs: [img(), col('dark', 'Dunkel', '#000000'), col('light', 'Hell', '#00e5ff')],
    outputs: IMAGE_OUT,
    run(I, { env, state }) {
      if (!I.image) return { image: null };
      const s = I.image.data, o = buffer(state, env.w, env.h), d = o.data;
      const A = hexToRgb(I.dark), B = hexToRgb(I.light);
      for (let i = 0; i < d.length; i += 4) {
        const f = lumAt(s, i);
        d[i] = mix(A[0], B[0], f); d[i + 1] = mix(A[1], B[1], f); d[i + 2] = mix(A[2], B[2], f); d[i + 3] = s[i + 3];
      }
      return { image: o };
    },
  },
  transform: {
    label: 'Transformieren', cat: 'fx', icon: '⤧',
    inputs: [img(), num('x', 'Versatz X', -2, 2, 0.01, 0), num('y', 'Versatz Y', -2, 2, 0.01, 0),
      num('rotate', 'Drehung', -360, 360, 1, 0, { unit: '°' }), num('zoom', 'Zoom', 0.1, 8, 0.01, 1), bool('repeat', 'Kacheln')],
    outputs: IMAGE_OUT,
    run(I, { env, state }) {
      if (!I.image) return { image: null };
      const { w, h } = env, cx = w / 2, cy = h / 2;
      const a = -I.rotate * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), z = 1 / (I.zoom || 1e-3);
      const ox = I.x * w, oy = I.y * h;
      return { image: remap(I.image, buffer(state, w, h), I.repeat ? 'wrap' : 'none', (x, y, p) => {
        const dx = (x - cx - ox) * z, dy = (y - cy - oy) * z;
        p[0] = cx + dx * c - dy * s; p[1] = cy + dx * s + dy * c;
      }) };
    },
  },
  mirror: {
    label: 'Spiegeln', cat: 'fx', icon: '⧓',
    inputs: [img(), sel('mode', 'Art', [['h', 'Links → rechts'], ['v', 'Oben → unten'], ['both', 'Beides'], ['kaleido', 'Kaleidoskop']]),
      num('segments', 'Segmente', 2, 16, 1, 6), num('rotate', 'Drehung', -360, 360, 1, 0, { unit: '°' })],
    outputs: IMAGE_OUT,
    run(I, { env, state }) {
      if (!I.image) return { image: null };
      const { w, h } = env, cx = w / 2, cy = h / 2, mode = I.mode;
      const seg = (Math.PI * 2) / Math.max(2, Math.round(I.segments)), rot = I.rotate * Math.PI / 180;
      return { image: remap(I.image, buffer(state, w, h), 'clamp', (x, y, p) => {
        if (mode === 'kaleido') {
          const dx = x - cx, dy = (y - cy) * (w / h);
          let a = Math.atan2(dy, dx) + rot;
          a = ((a % seg) + seg) % seg;
          if (a > seg / 2) a = seg - a;
          const r = Math.hypot(dx, dy);
          p[0] = cx + Math.cos(a) * r; p[1] = cy + Math.sin(a) * r * (h / w);
          return;
        }
        p[0] = (mode === 'h' || mode === 'both') && x > cx ? w - x : x;
        p[1] = (mode === 'v' || mode === 'both') && y > cy ? h - y : y;
      }) };
    },
  },
  blur: {
    label: 'Weichzeichnen', cat: 'fx', icon: '◌',
    inputs: [img(), num('radius', 'Radius', 0, 10, 1, 1, { unit: 'px' })],
    outputs: IMAGE_OUT,
    run(I, { env, state }) {
      if (!I.image) return { image: null };
      const { w, h } = env, r = Math.round(clamp(I.radius, 0, 20)), s = I.image.data;
      const o = buffer(state, w, h), d = o.data, n = w * h * 4;
      if (!r) { d.set(s); return { image: o }; }
      if (state.tmp?.length !== n) { state.tmp = new Float32Array(n); state.tmp2 = new Float32Array(n); }
      const a = state.tmp, b = state.tmp2;
      for (let i = 0; i < n; i += 4) { const al = s[i + 3] / 255; a[i] = s[i] * al; a[i + 1] = s[i + 1] * al; a[i + 2] = s[i + 2] * al; a[i + 3] = s[i + 3]; }
      // Zwei Box-Durchgänge (waagerecht, senkrecht) auf vormultiplizierten Werten
      const pass = (from, to, horizontal) => {
        const len = horizontal ? w : h, lines = horizontal ? h : w;
        for (let l = 0; l < lines; l++) {
          for (let k = 0; k < len; k++) {
            let r0 = 0, g0 = 0, b0 = 0, a0 = 0, cnt = 0;
            for (let q = Math.max(0, k - r); q <= Math.min(len - 1, k + r); q++) {
              const i = (horizontal ? l * w + q : q * w + l) * 4;
              r0 += from[i]; g0 += from[i + 1]; b0 += from[i + 2]; a0 += from[i + 3]; cnt++;
            }
            const i = (horizontal ? l * w + k : k * w + l) * 4;
            to[i] = r0 / cnt; to[i + 1] = g0 / cnt; to[i + 2] = b0 / cnt; to[i + 3] = a0 / cnt;
          }
        }
      };
      pass(a, b, true);
      pass(b, a, false);
      for (let i = 0; i < n; i += 4) {
        const al = a[i + 3] / 255;
        d[i] = al ? a[i] / al : 0; d[i + 1] = al ? a[i + 1] / al : 0; d[i + 2] = al ? a[i + 2] / al : 0; d[i + 3] = a[i + 3];
      }
      return { image: o };
    },
  },
  threshold: {
    label: 'Schwelle', cat: 'fx', icon: '◒',
    hint: 'Nur Stellen heller als die Schwelle bleiben sichtbar. Gut als Maske.',
    inputs: [img(), num('level', 'Schwelle', 0, 1, 0.01, 0.5), num('soft', 'Weichheit', 0, 1, 0.01, 0.1)],
    outputs: IMAGE_OUT,
    run(I, { env, state }) {
      if (!I.image) return { image: null };
      const s = I.image.data, o = buffer(state, env.w, env.h), d = o.data;
      const lo = I.level - I.soft / 2, hi = I.level + I.soft / 2;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = s[i + 3] * smooth(lo, hi, lumAt(s, i));
      }
      return { image: o };
    },
  },
  pixelate: {
    label: 'Verpixeln', cat: 'fx', icon: '▦',
    inputs: [img(), num('size', 'Blockgröße', 1, 16, 1, 2, { unit: 'px' })],
    outputs: IMAGE_OUT,
    run(I, { env, state }) {
      if (!I.image) return { image: null };
      const { w, h } = env, s = I.image.data, o = buffer(state, w, h), d = o.data, k = Math.max(1, Math.round(I.size));
      for (let y = 0, i = 0; y < h; y++) {
        const sy = Math.min(h - 1, Math.floor(y / k) * k + (k >> 1));
        for (let x = 0; x < w; x++, i += 4) {
          const j = (sy * w + Math.min(w - 1, Math.floor(x / k) * k + (k >> 1))) * 4;
          d[i] = s[j]; d[i + 1] = s[j + 1]; d[i + 2] = s[j + 2]; d[i + 3] = s[j + 3];
        }
      }
      return { image: o };
    },
  },
  feedback: {
    label: 'Nachleuchten', cat: 'fx', icon: '☄',
    hint: 'Feedback: zieht Spuren hinter allem her. Hängt vom vorherigen Frame ab, beim Springen in der Zeit startet es neu.',
    inputs: [img(), num('decay', 'Nachleuchten', 0, 0.99, 0.01, 0.85), num('dx', 'Drift X', -40, 40, 0.5, 0, { unit: 'px/s' }),
      num('dy', 'Drift Y', -40, 40, 0.5, 0, { unit: 'px/s' }), num('zoom', 'Zoom', -2, 2, 0.01, 0, { unit: '/s' })],
    outputs: IMAGE_OUT,
    run(I, { env, state }) {
      const { w, h } = env, o = buffer(state, w, h), d = o.data;
      const prev = buffer(state, w, h, 'prev');
      const gap = env.T - (state.lastT ?? -1);
      if (gap < 0 || gap > 0.25) prev.data.fill(0);
      const dt = clamp(gap, 0, 0.1);
      state.lastT = env.T;
      const keep = Math.pow(I.decay, dt * 30), cx = w / 2, cy = h / 2, z = 1 / (1 + I.zoom * dt);
      remap(prev, o, 'none', (x, y, p) => {
        p[0] = cx + (x - cx) * z - I.dx * dt; p[1] = cy + (y - cy) * z - I.dy * dt;
      });
      const s = I.image?.data;
      for (let i = 0; i < d.length; i += 4) {
        const pa = (d[i + 3] / 255) * keep, sa = s ? s[i + 3] / 255 : 0;
        const a = Math.max(pa, sa);
        for (let k = 0; k < 3; k++) {
          const v = Math.max(d[i + k] * pa, s ? s[i + k] * sa : 0);
          d[i + k] = a > 0 ? v / a : 0;
        }
        d[i + 3] = a * 255;
      }
      prev.data.set(d);
      return { image: o };
    },
  },

  // ---------- Zahlen & Farben ----------
  lfo: {
    label: 'LFO', cat: 'num', icon: '∿',
    hint: 'Schwingt zwischen Min und Max. Im Beat-Modus passend zum Takt des Projekts.',
    inputs: [sel('shape', 'Form', LFO_SHAPES), sel('sync', 'Takt', [['beat', 'Beats pro Zyklus'], ['hz', 'Hertz']]),
      num('rate', 'Länge / Tempo', 0.05, 64, 0.05, 4), num('phase', 'Phase', 0, 1, 0.01, 0),
      num('min', 'Min', -10, 10, 0.01, 0), num('max', 'Max', -10, 10, 0.01, 1)],
    outputs: [out('value', 'Wert', 'number')],
    run(I, { env }) {
      const ph = (I.sync === 'hz' ? env.t * I.rate : (env.T * env.bpm / 60) / Math.max(0.01, I.rate)) + I.phase;
      return { value: mix(I.min, I.max, lfoShape(I.shape, ph)) };
    },
  },
  pulse: {
    label: 'Beat-Impuls', cat: 'num', icon: '♩',
    hint: 'Springt auf jedem Beat auf 1 und klingt dann ab.',
    inputs: [num('every', 'Alle … Beats', 0.25, 16, 0.25, 1), num('sharp', 'Abklingen', 0.2, 12, 0.1, 3)],
    outputs: [out('value', 'Wert', 'number')],
    run(I, { env }) {
      const b = (env.T * env.bpm / 60) / Math.max(0.01, I.every);
      return { value: Math.pow(1 - fract(b), I.sharp) };
    },
  },
  noise: {
    label: 'Rauschen', cat: 'num', icon: '≈',
    inputs: [num('speed', 'Tempo', 0, 10, 0.05, 1), num('seed', 'Variante', 0, 100, 1, 1),
      num('min', 'Min', -10, 10, 0.01, 0), num('max', 'Max', -10, 10, 0.01, 1)],
    outputs: [out('value', 'Wert', 'number')],
    run(I, { env }) {
      return { value: mix(I.min, I.max, noise3(env.t * I.speed, I.seed * 7.13, 0.5)) };
    },
  },
  math: {
    label: 'Rechnen', cat: 'num', icon: '±',
    inputs: [num('a', 'A', -10, 10, 0.01, 0), num('b', 'B', -10, 10, 0.01, 1),
      sel('op', 'Operation', [['add', 'A + B'], ['sub', 'A − B'], ['mul', 'A × B'], ['div', 'A ÷ B'], ['min', 'Minimum'], ['max', 'Maximum'], ['pow', 'A hoch B'], ['mod', 'A mod B']], 'mul')],
    outputs: [out('value', 'Ergebnis', 'number')],
    run({ a, b, op }) {
      const v = { add: a + b, sub: a - b, mul: a * b, div: b ? a / b : 0, min: Math.min(a, b), max: Math.max(a, b), pow: Math.pow(Math.abs(a), b), mod: b ? ((a % b) + b) % b : 0 }[op];
      return { value: Number.isFinite(v) ? v : 0 };
    },
  },
  map: {
    label: 'Umrechnen', cat: 'num', icon: '↦',
    hint: 'Bildet einen Wertebereich auf einen anderen ab, z. B. Bass 0..1 auf Zoom 1..3.',
    inputs: [num('value', 'Wert', -10, 10, 0.01, 0), num('inMin', 'Von min', -10, 10, 0.01, 0), num('inMax', 'Von max', -10, 10, 0.01, 1),
      num('outMin', 'Nach min', -100, 100, 0.01, 0), num('outMax', 'Nach max', -100, 100, 0.01, 1), bool('clamp', 'Begrenzen', true)],
    outputs: [out('value', 'Ergebnis', 'number')],
    run(I) {
      let f = (I.value - I.inMin) / (I.inMax - I.inMin || 1e-6);
      if (I.clamp) f = clamp(f);
      return { value: mix(I.outMin, I.outMax, f) };
    },
  },
  hsv: {
    label: 'Farbe aus HSV', cat: 'num', icon: '🌈',
    inputs: [num('h', 'Farbton', 0, 1, 0.01, 0), num('s', 'Sättigung', 0, 1, 0.01, 1), num('v', 'Helligkeit', 0, 1, 0.01, 1)],
    outputs: [out('color', 'Farbe', 'color')],
    run(I) { return { color: toHex(...hsv(I.h, clamp(I.s), clamp(I.v))) }; },
  },
  colormix: {
    label: 'Farben mischen', cat: 'num', icon: '◑',
    inputs: [col('a', 'Farbe A', '#ff2a6d'), col('b', 'Farbe B', '#00e5ff'), num('amount', 'Anteil B', 0, 1, 0.01, 0.5)],
    outputs: [out('color', 'Farbe', 'color')],
    run(I) {
      const A = hexToRgb(I.a), B = hexToRgb(I.b), f = clamp(I.amount);
      return { color: toHex(mix(A[0], B[0], f), mix(A[1], B[1], f), mix(A[2], B[2], f)) };
    },
  },

  // ---------- Ausgang ----------
  output: {
    label: 'Ausgang', cat: 'out', icon: '▶', unique: true,
    hint: 'Was hier ankommt, zeigt der Clip auf der Zeitleiste.',
    inputs: [img()], outputs: [],
    run() { return {}; },
  },
};

// Jeder Clip-Typ ist auch als Generator-Knoten verfügbar; Zahlen- und Farbparameter werden zu Eingängen
for (const [type, def] of Object.entries(CLIP_TYPES)) {
  if (type === 'patch') continue;
  NODE_TYPES['gen:' + type] = {
    label: def.label, cat: 'gen', icon: def.icon,
    inputs: def.params.map((p) => ({ ...p, default: def.defaults[p.key] })),
    outputs: IMAGE_OUT,
    run(I, { env, node, state }) {
      const { w, h } = env;
      if (!state.ctx) {
        state.canvas = document.createElement('canvas');
        state.ctx = state.canvas.getContext('2d', { willReadFrequently: true });
      }
      const c = state.canvas, ctx = state.ctx;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);
      // Eigene Clip-Kennung pro Knoten, damit z. B. zwei Video-Knoten eigene Player bekommen
      const clip = { id: env.clip.id + '/' + node.id, start: env.clip.start, duration: env.clip.duration, params: I };
      def.render(ctx, { ...env, p: I, clip });
      return { image: ctx.getImageData(0, 0, w, h) };
    },
  };
}

export function createNode(type, x, y) {
  const def = NODE_TYPES[type];
  const params = {};
  for (const p of def.inputs) if (p.type !== 'image') params[p.key] = structuredClone(p.default);
  return { id: uid(), type, x: Math.round(x), y: Math.round(y), params };
}

// Würde die Verbindung from → to einen Kreis bilden? (to liegt schon stromaufwärts von from)
export function createsCycle(graph, from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop();
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const l of graph.links) if (l.to === id) stack.push(l.from);
  }
  return false;
}

// Wertet den Graphen für einen Frame aus.
// env: { w, h, t, T, progress, p (Clip-Regler), audio, bpm, media, clip, below(), state(nodeId), all }
// Liefert { image (für den Ausgang), values (nodeId → { in, out, error }), errors }
export function runGraph(graph, env) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const links = new Map(graph.links.map((l) => [l.to + '.' + l.in, l]));
  const values = new Map();
  const errors = [];
  const visiting = new Set();

  const evalNode = (node) => {
    const done = values.get(node.id);
    if (done) return done;
    const def = NODE_TYPES[node.type];
    const v = { in: {}, out: {}, error: null };
    if (!def || visiting.has(node.id)) return v;
    visiting.add(node.id);
    for (const p of def.inputs) {
      const l = links.get(node.id + '.' + p.key);
      const src = l && nodes.get(l.from);
      let val = src ? evalNode(src).out[l.out] : undefined;
      if (val == null) val = p.type === 'image' ? null : (node.params?.[p.key] ?? p.default);
      if (p.type === 'number') { val = Number(val); if (!Number.isFinite(val)) val = p.default ?? 0; }
      v.in[p.key] = val;
    }
    try {
      v.out = def.run(v.in, { env, node, state: env.state(node.id) }) || {};
    } catch (e) {
      v.error = e.message;
      errors.push(`${def.label}: ${e.message}`);
    }
    visiting.delete(node.id);
    values.set(node.id, v);
    return v;
  };

  const output = graph.nodes.find((n) => n.type === 'output');
  const image = output ? evalNode(output).in.image : null;
  // Im offenen Editor auch Knoten auswerten, die (noch) nicht am Ausgang hängen, für die Vorschaubilder
  if (env.all) for (const n of graph.nodes) evalNode(n);
  return { image, values, errors };
}
