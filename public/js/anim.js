// Keyframes: Parameter eines Clips über die Zeit verändern.
// Gespeichert als clip.anim = { 'opacity': [...], 'params.speed': [...] }
// Jeder Key: { t: Sekunden ab Clipanfang, v: Wert (Zahl oder '#rrggbb'), ease: 'linear' | 'smooth' | 'hold' }
// ease gilt für den Abschnitt ab diesem Key bis zum nächsten.
import { hexToRgb, mix } from './util.js';

export const EASES = [['linear', 'Linear'], ['smooth', 'Weich'], ['hold', 'Halten']];
export const KEY_EPS = 1 / 60;   // Keys näher als ein Frame gelten als „gleiche Zeit“
const NOT_ANIMATABLE = ['start', 'duration', 'fadeIn', 'fadeOut'];

export const isAnimatable = (def) => (def.type === 'number' || def.type === 'color') && !NOT_ANIMATABLE.includes(def.key);
export const pathOf = (def) => (def.common ? def.key : 'params.' + def.key);
export const keysOf = (clip, path) => clip.anim?.[path] || null;
export const isAnimated = (clip, path) => Boolean(clip.anim?.[path]?.length);

const toHex = (rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

function lerp(a, b, f) {
  if (typeof a === 'string' || typeof b === 'string') {
    const A = hexToRgb(a), B = hexToRgb(b);
    return toHex([mix(A[0], B[0], f), mix(A[1], B[1], f), mix(A[2], B[2], f)]);
  }
  return mix(a, b, f);
}

export function valueAt(keys, t) {
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  if (a.ease === 'hold') return a.v;
  let f = (t - a.t) / (b.t - a.t || 1);
  if (a.ease === 'smooth') f = f * f * (3 - 2 * f);
  return lerp(a.v, b.v, f);
}

// Parameter und Deckkraft eines Clips zur Clipzeit t (unverändert, wenn nichts animiert ist)
export function evalClip(clip, t) {
  if (!clip.anim) return { params: clip.params, opacity: clip.opacity };
  const params = { ...clip.params };
  let opacity = clip.opacity;
  for (const [path, keys] of Object.entries(clip.anim)) {
    if (!keys.length) continue;
    const v = valueAt(keys, t);
    if (path === 'opacity') opacity = v;
    else params[path.slice(7)] = v;
  }
  return { params, opacity };
}

export function findKey(keys, t) {
  return keys ? keys.findIndex((k) => Math.abs(k.t - t) < KEY_EPS) : -1;
}

// Key setzen oder (bei gleicher Zeit) überschreiben
export function setKey(clip, path, t, v) {
  clip.anim ||= {};
  const keys = (clip.anim[path] ||= []);
  const i = findKey(keys, t);
  if (i >= 0) { keys[i].v = v; return keys[i]; }
  // Kurve vom vorherigen Key übernehmen, damit neue Keys sich einfügen wie die Nachbarn
  const prev = [...keys].reverse().find((k) => k.t < t);
  const key = { t: Math.round(t * 1000) / 1000, v, ease: prev?.ease || 'linear' };
  keys.push(key);
  keys.sort((a, b) => a.t - b.t);
  return key;
}

export function removeKey(clip, path, index) {
  const keys = keysOf(clip, path);
  if (!keys) return;
  keys.splice(index, 1);
  if (!keys.length) clearAnim(clip, path);
}

export function clearAnim(clip, path) {
  if (!clip.anim) return;
  delete clip.anim[path];
  if (!Object.keys(clip.anim).length) delete clip.anim;
}

// Der Key, dessen Kurve zur Zeit t gilt (Key genau auf t oder der letzte davor)
export function segmentKey(keys, t) {
  if (!keys?.length) return null;
  let k = keys[0];
  for (const key of keys) if (key.t <= t + KEY_EPS) k = key;
  return k;
}

// Alle Keyframe-Zeiten eines Clips (für die Rauten in der Zeitleiste)
export function keyTimes(clip) {
  if (!clip.anim) return [];
  const times = [];
  for (const keys of Object.values(clip.anim))
    for (const k of keys) if (!times.some((t) => Math.abs(t - k.t) < KEY_EPS)) times.push(k.t);
  return times.sort((a, b) => a - b);
}

// Alle Keys um dt verschieben (z. B. wenn der Clipanfang verschoben wird und der Inhalt stehen bleiben soll)
export function shiftKeys(clip, dt) {
  if (!clip.anim) return;
  for (const keys of Object.values(clip.anim)) for (const k of keys) k.t = Math.round((k.t + dt) * 1000) / 1000;
}

// Alle Keys bei Zeit `from` (über alle Parameter) nach `to` verschieben
export function moveKeysAt(clip, from, to) {
  if (!clip.anim) return;
  for (const keys of Object.values(clip.anim)) {
    for (const k of keys) if (Math.abs(k.t - from) < KEY_EPS) k.t = Math.round(to * 1000) / 1000;
    keys.sort((a, b) => a.t - b.t);
  }
}

export function neighbourKeyTime(keys, t, dir) {
  if (!keys?.length) return null;
  if (dir < 0) {
    for (let i = keys.length - 1; i >= 0; i--) if (keys[i].t < t - KEY_EPS) return keys[i].t;
  } else {
    for (const k of keys) if (k.t > t + KEY_EPS) return k.t;
  }
  return null;
}
