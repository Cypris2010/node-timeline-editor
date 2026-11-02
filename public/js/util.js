// Kleine Hilfsfunktionen für Farben, Rauschen und DOM.

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const fract = (v) => v - Math.floor(v);
export const mix = (a, b, t) => a + (b - a) * t;
export const uid = () => Math.random().toString(36).slice(2, 10);

export function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', '').padEnd(6, '0').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// h, s, v in 0..1 → [r, g, b] in 0..255
export function hsv(h, s, v) {
  h = fract(h) * 6;
  const i = Math.floor(h), f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [r * 255, g * 255, b * 255];
}

// Deterministischer Hash → 0..1 (gleiche Eingabe = gleiches Ergebnis, wichtig fürs Scrubben)
export function hash(a, b = 0, c = 0) {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// 3D-Value-Noise, glatt interpoliert, Ergebnis 0..1
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(xf), v = s(yf), w = s(zf);
  const n = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz);
  return mix(
    mix(mix(n(0, 0, 0), n(1, 0, 0), u), mix(n(0, 1, 0), n(1, 1, 0), u), v),
    mix(mix(n(0, 0, 1), n(1, 0, 1), u), mix(n(0, 1, 1), n(1, 1, 1), u), v),
    w,
  );
}

export function fbm(x, y, z, octaves = 3) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(x, y, z) * amp;
    norm += amp;
    x *= 2; y *= 2; z *= 1.5; amp *= 0.5;
  }
  return sum / norm;
}

export function formatTime(t, withFrames = true) {
  const neg = t < 0;
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const str = `${String(m).padStart(2, '0')}:${(withFrames ? s.toFixed(2) : Math.floor(s).toString()).padStart(withFrames ? 5 : 2, '0')}`;
  return neg ? '-' + str : str;
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? e.style.setProperty(sk, sv) : (e.style[sk] = sv);
    }
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

// Wie replaceChildren, überspringt aber null/false (für bedingte Elemente)
export function fill(parent, ...children) {
  parent.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
}

export class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }
}
