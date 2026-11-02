// Projektdaten, Auswahl und Rückgängig/Wiederholen.
// Struktur: project.tracks[0] ist die oberste Spur und liegt im Bild vorne.
import { CLIP_TYPES, BLEND_MODES } from './clips.js';
import { Emitter, uid } from './util.js';

const AUTOSAVE_KEY = 'led-timeline:project';
const MAX_HISTORY = 100;

export function createClip(type, start = 0, extra = {}) {
  const def = CLIP_TYPES[type];
  return {
    id: uid(), type, name: def.label, start, duration: 8,
    fadeIn: 0, fadeOut: 0, opacity: 1,
    ...extra,
    params: { ...structuredClone(def.defaults), ...(extra.params || {}) },
  };
}

export function createTrack(name = 'Spur') {
  return { id: uid(), name, opacity: 1, blend: 'source-over', muted: false, solo: false, clips: [] };
}

export function blankProject() {
  return {
    version: 1, name: 'Neues Projekt', duration: 60, bpm: 120, loop: true, audio: null,
    tracks: [createTrack('Spur 1'), createTrack('Spur 2'), createTrack('Spur 3')],
  };
}

export function demoProject() {
  const p = blankProject();
  p.name = 'Demo';
  p.duration = 40;
  const [text, fx, bg] = p.tracks;
  text.name = 'Text';
  fx.name = 'Effekte';
  bg.name = 'Hintergrund';
  fx.blend = 'lighter';
  text.clips.push(
    createClip('text', 2, { duration: 12, fadeIn: 0.5, fadeOut: 0.5, params: { text: 'LED TIMELINE', speed: 14 } }),
    createClip('text', 24, { duration: 6, fadeIn: 0.3, params: { text: 'WLED', speed: 0, color: '#000000' } }),
  );
  fx.clips.push(
    createClip('sparkle', 6, { duration: 14, fadeIn: 1, fadeOut: 2 }),
    createClip('strobe', 30, { duration: 2, params: { rate: 2 } }),
  );
  bg.clips.push(
    createClip('plasma', 0, { duration: 12, fadeIn: 1, fadeOut: 2 }),
    createClip('fire', 10, { duration: 12, fadeIn: 2, fadeOut: 2 }),
    createClip('shader', 20, { duration: 12, fadeIn: 2, fadeOut: 0 }),
    createClip('rainbow', 30, { duration: 10, fadeIn: 2, fadeOut: 2 }),
  );
  return p;
}

// Ergänzt fehlende Felder, damit ältere oder handbearbeitete Projekte robust laden
export function normalizeProject(raw) {
  const base = blankProject();
  const p = { ...base, ...raw };
  p.duration = Math.max(1, Number(p.duration) || base.duration);
  p.bpm = Math.max(0, Number(p.bpm) || 0);
  p.tracks = (Array.isArray(raw?.tracks) ? raw.tracks : base.tracks).map((t) => {
    const track = { ...createTrack(), ...t, id: t.id || uid() };
    if (!BLEND_MODES.some(([v]) => v === track.blend)) track.blend = 'source-over';
    track.clips = (t.clips || []).filter((c) => CLIP_TYPES[c.type]).map((c) => {
      const clip = createClip(c.type, Number(c.start) || 0, c);
      clip.id = c.id || uid();
      clip.duration = Math.max(0.05, Number(clip.duration) || 1);
      return clip;
    });
    return track;
  });
  return p;
}

export class Store extends Emitter {
  constructor(project) {
    super();
    this.selectedClip = null;
    this.selectedTrack = null;
    this.load(project);
  }

  load(project) {
    this.project = normalizeProject(project);
    this.snapshot = JSON.stringify(this.project);
    this.undoStack = [];
    this.redoStack = [];
    this.selectedClip = null;
    this.selectedTrack = this.project.tracks[0]?.id || null;
    this.emit('load');
    this.emit('change');
  }

  static restore() {
    try {
      const s = localStorage.getItem(AUTOSAVE_KEY);
      if (s) return JSON.parse(s);
    } catch { /* kein Speicher verfügbar */ }
    return null;
  }

  autosave() {
    try { localStorage.setItem(AUTOSAVE_KEY, this.snapshot); } catch { /* egal */ }
  }

  // Live-Änderung (z. B. beim Ziehen): neu zeichnen, aber noch kein Undo-Schritt
  changed() { this.emit('change'); }

  // Abgeschlossene Änderung: Undo-Schritt anlegen
  commit() {
    this.fitDuration();
    const s = JSON.stringify(this.project);
    if (s !== this.snapshot) {
      this.undoStack.push(this.snapshot);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      this.snapshot = s;
      this.autosave();
    }
    this.emit('change');
    this.emit('commit');
  }

  undo() { this.travel(this.undoStack, this.redoStack); }
  redo() { this.travel(this.redoStack, this.undoStack); }

  travel(from, to) {
    if (!from.length) return;
    to.push(this.snapshot);
    this.snapshot = from.pop();
    this.project = JSON.parse(this.snapshot);
    if (this.selectedClip && !this.findClip(this.selectedClip)) this.selectedClip = null;
    this.autosave();
    this.emit('load');
    this.emit('change');
  }

  fitDuration() {
    let end = 0;
    for (const t of this.project.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
    if (end > this.project.duration) this.project.duration = Math.ceil(end + 4);
  }

  findClip(id) {
    for (const track of this.project.tracks) {
      const index = track.clips.findIndex((c) => c.id === id);
      if (index >= 0) return { clip: track.clips[index], track, index };
    }
    return null;
  }

  findTrack(id) { return this.project.tracks.find((t) => t.id === id) || null; }

  select(clipId) {
    this.selectedClip = clipId;
    const hit = clipId && this.findClip(clipId);
    if (hit) this.selectedTrack = hit.track.id;
    this.emit('select');
  }

  selectTrack(trackId) {
    this.selectedTrack = trackId;
    this.emit('select');
  }

  get clip() { return this.selectedClip ? this.findClip(this.selectedClip)?.clip || null : null; }
  get track() { return this.findTrack(this.selectedTrack) || this.project.tracks[0] || null; }
}
