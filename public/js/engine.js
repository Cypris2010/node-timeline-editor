// Engine: Transport (Abspielzeit), Audio-Analyse, Medienverwaltung und das Zusammensetzen aller Spuren.
import { CLIP_TYPES } from './clips.js';
import { ShaderRenderer } from './shader.js';
import { evalClip } from './anim.js';
import { runGraph } from './nodes.js';
import { Emitter, clamp } from './util.js';

const PRELOAD_AHEAD = 2;   // Sekunden: Videos so früh vorbereiten

export class Engine extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.layer = document.createElement('canvas');
    this.lctx = this.layer.getContext('2d');
    this.setSize(32, 16);

    this.shaders = new ShaderRenderer();
    this.errors = new Map();      // clipId → Fehlermeldung
    this.videos = new Map();      // clipId → { el, src, error }
    this.images = new Map();      // url → Image
    this.activeVideos = new Set();
    this.camera = { state: 'idle', el: null, error: null };
    this.nodeState = new Map();   // 'clipId/nodeId' → Puffer und Zustand eines Knotens
    this.patchResults = new Map(); // clipId → Ergebnis der letzten Auswertung (für den Node-Editor)
    this.inspectPatch = null;      // Clip, dessen Editor offen ist: dann alle Knoten auswerten

    this.time = 0;
    this.playing = false;
    this.timeBase = 0;
    this.clockBase = performance.now();

    this.audioEl = new Audio();
    this.audioEl.preload = 'auto';
    this.audioCtx = null;
    this.analyser = null;
    this.audio = { level: 0, bass: 0, mid: 0, high: 0, spectrum: null };
    this.waveform = null;

    this.media = {
      video: (clip, t) => this.video(clip, t),
      image: (src) => this.image(src),
      camera: () => this.cameraFrame(),
      shader: (clip, c) => this.shader(clip, c),
      patch: (c) => this.patch(c),
    };
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    for (const c of [this.canvas, this.layer]) { c.width = w; c.height = h; }
  }

  get duration() { return this.store.project.duration; }

  // ---------- Transport ----------

  hasAudio() {
    return Boolean(this.store.project.audio && this.audioEl.src && Number.isFinite(this.audioEl.duration));
  }

  play() {
    this.ensureAudioGraph();
    if (this.time >= this.duration) this.time = 0;
    this.playing = true;
    this.timeBase = this.time;
    this.clockBase = performance.now();
    this.syncAudio(true);
    this.emit('transport');
  }

  pause() {
    this.playing = false;
    this.audioEl.pause();
    this.emit('transport');
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    this.time = clamp(t, 0, this.duration);
    this.timeBase = this.time;
    this.clockBase = performance.now();
    this.syncAudio(true);
    this.emit('transport');
  }

  syncAudio(force) {
    if (!this.hasAudio()) return;
    const a = this.audioEl;
    const inside = this.time < a.duration;
    if (force && inside) a.currentTime = this.time;
    if (this.playing && inside && a.paused) a.play().catch(() => {});
    if ((!this.playing || !inside) && !a.paused) a.pause();
  }

  // Einmal pro Frame aufrufen
  tick() {
    const now = performance.now();
    if (this.playing) {
      const a = this.audioEl;
      if (this.hasAudio() && !a.paused && !a.ended) {
        // Audio ist die Master-Uhr, damit Licht und Musik synchron bleiben
        this.time = a.currentTime;
        this.timeBase = this.time;
        this.clockBase = now;
      } else {
        this.time = this.timeBase + (now - this.clockBase) / 1000;
      }
      if (this.time >= this.duration) {
        if (this.store.project.loop) this.seek(0);
        else { this.time = this.duration; this.pause(); }
      }
    }
    this.analyseAudio();
  }

  // ---------- Audio ----------

  setAudio(url) {
    this.waveform = null;
    this.emit('waveform');
    if (!url) {
      this.audioEl.pause();
      this.audioEl.removeAttribute('src');
      this.audioEl.load();
      return;
    }
    if (this.audioEl.src.endsWith(url)) return;
    this.audioEl.src = url;
    this.audioEl.addEventListener('loadedmetadata', () => this.syncAudio(true), { once: true });
    this.loadWaveform(url);
  }

  ensureAudioGraph() {
    if (this.audioCtx) {
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      return;
    }
    try {
      this.audioCtx = new AudioContext();
      const src = this.audioCtx.createMediaElementSource(this.audioEl);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.6;
      src.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    } catch (e) {
      console.warn('Audio-Analyse nicht verfügbar', e);
    }
  }

  analyseAudio() {
    const a = this.audio;
    if (!this.analyser || !this.playing || this.audioEl.paused) {
      a.level = a.bass = a.mid = a.high = 0;
      a.spectrum = this.freq ? this.freq.fill(0) : null;
      return;
    }
    this.analyser.getByteFrequencyData(this.freq);
    const avg = (from, to) => {
      let s = 0;
      for (let i = from; i < to; i++) s += this.freq[i];
      return s / ((to - from) * 255);
    };
    a.level = avg(0, 64);
    a.bass = avg(0, 3);
    a.mid = avg(3, 24);
    a.high = avg(24, 80);
    a.spectrum = this.freq;
  }

  async loadWaveform(url) {
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
      const rate = 100;   // Spitzenwerte pro Sekunde
      const data = audio.getChannelData(0);
      const step = Math.max(1, Math.floor(audio.sampleRate / rate));
      const peaks = new Float32Array(Math.ceil(data.length / step));
      for (let i = 0; i < peaks.length; i++) {
        let m = 0;
        for (let j = i * step, end = Math.min(data.length, j + step); j < end; j++) m = Math.max(m, Math.abs(data[j]));
        peaks[i] = m;
      }
      this.waveform = { peaks, rate, duration: audio.duration };
      this.emit('waveform');
    } catch (e) {
      console.warn('Wellenform konnte nicht berechnet werden', e);
    }
  }

  // ---------- Medien ----------

  video(clip, t, prepare = false) {
    const p = clip.params;
    if (!p.src) return null;
    let entry = this.videos.get(clip.id);
    if (!entry || entry.src !== p.src) {
      if (entry) this.dropVideo(clip.id);
      const el = document.createElement('video');
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      entry = { el, src: p.src, error: null };
      el.onerror = () => { entry.error = 'Video konnte nicht geladen werden'; };
      el.src = p.src;
      this.videos.set(clip.id, entry);
    }
    if (entry.error) throw new Error(entry.error);
    const el = entry.el;
    el.loop = Boolean(p.loop);
    let target = p.offset + t * p.speed;
    const dur = el.duration;
    if (Number.isFinite(dur) && dur > 0) target = p.loop ? target % dur : Math.min(target, dur - 0.04);

    if (this.playing && !prepare) {
      this.activeVideos.add(clip.id);
      if (el.playbackRate !== p.speed) el.playbackRate = p.speed;
      if (el.paused) el.play().catch(() => {});
      if (Math.abs(el.currentTime - target) > 0.3 && !el.seeking) el.currentTime = target;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.04 && !el.seeking) el.currentTime = target;
    }
    return el.readyState >= 2 ? el : null;
  }

  dropVideo(id) {
    const e = this.videos.get(id);
    if (!e) return;
    e.el.pause();
    e.el.removeAttribute('src');
    e.el.load();
    this.videos.delete(id);
  }

  image(src) {
    if (!src) return null;
    let img = this.images.get(src);
    if (!img) {
      img = new Image();
      img.src = src;
      this.images.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  cameraFrame() {
    const cam = this.camera;
    if (cam.state === 'idle') {
      cam.state = 'pending';
      navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } }).then((stream) => {
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.srcObject = stream;
        v.play();
        cam.el = v;
        cam.state = 'ready';
      }).catch((e) => { cam.state = 'error'; cam.error = e.message; });
    }
    if (cam.state === 'error') throw new Error('Kamera: ' + cam.error);
    return cam.el && cam.el.readyState >= 2 ? cam.el : null;
  }

  shader(clip, c) {
    const p = c.p;   // bereits mit Keyframes ausgewertet
    const r = this.shaders.render(p.code, c.w, c.h, {
      time: c.t, progress: c.progress, audio: this.audio, params: [p.p1, p.p2, p.p3, p.p4],
    });
    if (r.error) throw new Error(r.error);
    return r.canvas;
  }

  patch(c) {
    const { clip } = c;
    const res = runGraph(c.p.graph, {
      ...c,
      below: () => this.ctx.getImageData(0, 0, this.w, this.h),
      state: (nodeId) => {
        const key = clip.id + '/' + nodeId;
        let s = this.nodeState.get(key);
        if (!s) this.nodeState.set(key, (s = {}));
        return s;
      },
      all: this.inspectPatch === clip.id,
    });
    res.time = c.T;
    this.patchResults.set(clip.id, res);
    if (res.errors.length) c.error = res.errors.join('\n');
    return res.image;
  }

  // Medien von gelöschten Clips freigeben (Knoten-Kennungen haben die Form 'clipId/nodeId')
  gc() {
    const gone = (id) => !this.store.findClip(id.split('/')[0]);
    for (const id of this.videos.keys()) if (gone(id)) this.dropVideo(id);
    for (const id of this.errors.keys()) if (gone(id)) this.errors.delete(id);
    for (const id of this.nodeState.keys()) if (gone(id)) this.nodeState.delete(id);
    for (const id of this.patchResults.keys()) if (gone(id)) this.patchResults.delete(id);
  }

  setError(id, msg) {
    if ((this.errors.get(id) || null) === msg) return;
    if (msg) this.errors.set(id, msg); else this.errors.delete(id);
    this.emit('errors', id);
  }

  // ---------- Rendern ----------

  // Ein Pixel wandert in Leserichtung über die Matrix; Ecken markiert (rot = oben links, blau = unten rechts)
  drawTestPattern() {
    const { ctx, w, h } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const i = Math.floor(performance.now() / 1000 * 12) % (w * h);
    ctx.fillStyle = '#333';
    ctx.fillRect(0, Math.floor(i / w), w, 1);
    ctx.fillStyle = '#fff';
    ctx.fillRect(i % w, Math.floor(i / w), 1, 1);
    ctx.fillStyle = '#f00';
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = '#00f';
    ctx.fillRect(w - 1, h - 1, 1, 1);
  }

  render() {
    const { w, h, ctx, lctx, layer } = this;
    const project = this.store.project;
    const T = this.time;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    this.activeVideos.clear();

    const anySolo = project.tracks.some((t) => t.solo);
    // Unterste Spur zuerst, oberste zuletzt (liegt vorne)
    for (let i = project.tracks.length - 1; i >= 0; i--) {
      const track = project.tracks[i];
      if (track.muted || (anySolo && !track.solo)) continue;
      for (const clip of track.clips) {
        const t = T - clip.start;
        if (clip.type === 'video' && t < 0 && t > -PRELOAD_AHEAD) {
          try { this.video(clip, 0, true); } catch { /* Fehler zeigt der Clip selbst */ }
        }
        if (t < 0 || t >= clip.duration) continue;
        let fade = 1;
        if (clip.fadeIn > 0) fade = Math.min(fade, t / clip.fadeIn);
        if (clip.fadeOut > 0) fade = Math.min(fade, (clip.duration - t) / clip.fadeOut);
        const { params, opacity } = evalClip(clip, t);
        const alpha = clamp(fade) * opacity * track.opacity;
        if (alpha <= 0) continue;

        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.globalAlpha = 1;
        lctx.globalCompositeOperation = 'source-over';
        lctx.clearRect(0, 0, w, h);
        try {
          const c = {
            w, h, t, T, progress: t / clip.duration, p: params,
            audio: this.audio, bpm: project.bpm || 120, media: this.media, clip, error: null,
          };
          CLIP_TYPES[clip.type].render(lctx, c);
          this.setError(clip.id, c.error);   // render kann eine Warnung setzen und trotzdem zeichnen
        } catch (e) {
          this.setError(clip.id, e.message);
          continue;
        }
        ctx.globalAlpha = alpha;
        ctx.globalCompositeOperation = track.blend;
        ctx.drawImage(layer, 0, 0);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (this.testPattern) this.drawTestPattern();

    for (const [id, e] of this.videos) if (!this.activeVideos.has(id) && this.playing && !e.el.paused) e.el.pause();
    this.frame = ctx.getImageData(0, 0, w, h);
    return this.frame;
  }
}
