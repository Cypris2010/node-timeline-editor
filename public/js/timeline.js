// Zeitleiste: Lineal, Audiospur mit Wellenform, Spuren mit Clips (verschieben, Länge ändern, Spur wechseln).
import { CLIP_TYPES, CATEGORIES, BLEND_MODES } from './clips.js';
import { el, clamp, formatTime } from './util.js';
import { keyTimes, shiftKeys, moveKeysAt } from './anim.js';

export const HEADER_W = 210;
const RULER_H = 28;
const AUDIO_H = 46;
const SNAP_PX = 8;
const MIN_DUR = 0.05;
const round = (v) => Math.round(v * 1000) / 1000;
const NICE_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export class Timeline {
  constructor(root, { store, engine, actions }) {
    this.root = root;
    this.store = store;
    this.engine = engine;
    this.actions = actions;
    this.pps = 40;            // Pixel pro Sekunde
    this.snapOn = true;
    this.follow = true;
    this.build();
    store.on('change', () => this.render());
    store.on('select', () => this.updateSelection());
    engine.on('waveform', () => this.drawAudio());
    engine.on('errors', (id) => this.markError(id));
    new ResizeObserver(() => this.layoutCanvases()).observe(this.scroll);
    this.scroll.addEventListener('scroll', () => { this.drawRuler(); this.drawAudio(); });
    this.render();
  }

  // ---------- Aufbau ----------

  build() {
    const btn = (label, title, onclick, cls = '') => el('button', { class: 'btn ' + cls, title, onclick }, label);
    this.snapBtn = btn('🧲 Einrasten', 'An Clips, Abspielkopf und Beats einrasten (Alt gedrückt = aus)', () => {
      this.snapOn = !this.snapOn;
      this.snapBtn.classList.toggle('on', this.snapOn);
    }, 'on');
    this.followBtn = btn('⇥ Folgen', 'Ansicht folgt dem Abspielkopf', () => {
      this.follow = !this.follow;
      this.followBtn.classList.toggle('on', this.follow);
    }, 'on');
    this.bpmInput = el('input', { type: 'number', min: 0, max: 300, step: 0.1, class: 'num-sm', title: 'Tempo für Raster und Stroboskop',
      onchange: (e) => { this.store.project.bpm = Math.max(0, Number(e.target.value) || 0); this.store.commit(); } });
    this.durInput = el('input', { type: 'number', min: 1, step: 1, class: 'num-sm', title: 'Gesamtlänge in Sekunden',
      onchange: (e) => { this.store.project.duration = Math.max(1, Number(e.target.value) || 1); this.store.commit(); } });
    this.zoomInput = el('input', { type: 'range', min: Math.log(2), max: Math.log(600), step: 0.01, title: 'Zoom (auch Strg/⌘ + Mausrad)',
      oninput: (e) => this.setZoom(Math.exp(Number(e.target.value))) });

    this.toolbar = el('div', { class: 'tl-toolbar' },
      btn('＋ Spur', 'Neue Spur', () => this.actions.addTrack()),
      el('span', { class: 'sep' }),
      btn('✂ Teilen', 'Clip am Abspielkopf teilen (S)', () => this.actions.split()),
      btn('⧉ Duplizieren', 'Clip duplizieren (⌘D)', () => this.actions.duplicate()),
      btn('🗑 Löschen', 'Clip löschen (Entf)', () => this.actions.remove()),
      el('span', { class: 'sep' }),
      this.snapBtn, this.followBtn,
      el('span', { class: 'sep' }),
      el('label', { class: 'field-inline' }, 'BPM', this.bpmInput),
      el('label', { class: 'field-inline' }, 'Länge', this.durInput, 's'),
      el('span', { class: 'grow' }),
      btn('−', 'Herauszoomen', () => this.setZoom(this.pps / 1.5)),
      this.zoomInput,
      btn('＋', 'Hineinzoomen', () => this.setZoom(this.pps * 1.5)),
    );

    this.ruler = el('canvas', { class: 'tl-ruler' });
    this.audioCanvas = el('canvas', { class: 'tl-wave' });
    this.audioHead = el('div', { class: 'tl-head tl-audio-head' });
    this.audioLane = el('div', { class: 'tl-lane tl-audio-lane' }, this.audioCanvas);
    this.tracksEl = el('div', { class: 'tl-tracks' });
    this.playhead = el('div', { class: 'tl-playhead' });
    this.content = el('div', { class: 'tl-content' },
      el('div', { class: 'tl-row tl-ruler-row' }, el('div', { class: 'tl-head tl-corner' }, 'Spuren'), this.ruler),
      el('div', { class: 'tl-row tl-audio-row' }, this.audioHead, this.audioLane),
      this.tracksEl,
      this.playhead,
    );
    this.scroll = el('div', { class: 'tl-scroll' }, this.content);
    this.root.append(this.toolbar, this.scroll);

    this.bindRuler();
    this.bindTracks();
    this.bindDrop(this.tracksEl);
    this.bindDrop(this.audioLane, true);
    this.scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const vx = e.clientX - this.scroll.getBoundingClientRect().left;
      this.setZoom(this.pps * Math.exp(-e.deltaY * 0.01), this.timeAt(e.clientX), vx);
    }, { passive: false });
  }

  // ---------- Darstellung ----------

  render() {
    const p = this.store.project;
    const laneW = p.duration * this.pps;
    this.content.style.width = HEADER_W + laneW + 'px';

    // Raster: Beats und Takte, ohne BPM Sekunden
    const beat = p.bpm > 0 ? (60 / p.bpm) * this.pps : this.pps;
    this.content.style.setProperty('--beat', (beat >= 7 ? beat : beat * 4) + 'px');
    this.content.style.setProperty('--bar', beat * 4 + 'px');

    this.audioLane.style.width = laneW + 'px';
    this.audioHead.replaceChildren(
      el('span', { class: 'tl-audio-icon' }, '♪'),
      el('span', { class: 'tl-audio-name', title: p.audio?.name || '' }, p.audio ? p.audio.name : 'Kein Audio'),
    );
    this.tracksEl.replaceChildren(...p.tracks.map((t, i) => this.trackRow(t, i, laneW)));

    for (const [input, val] of [[this.bpmInput, p.bpm], [this.durInput, p.duration]]) {
      if (document.activeElement !== input) input.value = val;
    }
    this.zoomInput.value = Math.log(this.pps);
    this.layoutCanvases();
    this.updatePlayhead();
  }

  trackRow(track, index, laneW) {
    const { store } = this;
    const p = store.project;
    const commit = () => store.commit();
    const blend = el('select', { class: 'sel-sm', title: 'Mischmodus der Spur',
      onchange: (e) => { track.blend = e.target.value; commit(); } },
      ...BLEND_MODES.map(([v, l]) => el('option', { value: v, selected: v === track.blend }, l)));
    const head = el('div', { class: 'tl-head', onpointerdown: () => store.selectTrack(track.id) },
      el('div', { class: 'tl-head-row' },
        el('input', { class: 'tl-name', value: track.name, spellcheck: false,
          onchange: (e) => { track.name = e.target.value || 'Spur'; commit(); },
          onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }),
        el('button', { class: 'icon-btn', title: 'Nach oben', disabled: index === 0,
          onclick: () => { p.tracks.splice(index - 1, 0, p.tracks.splice(index, 1)[0]); commit(); } }, '▲'),
        el('button', { class: 'icon-btn', title: 'Nach unten', disabled: index === p.tracks.length - 1,
          onclick: () => { p.tracks.splice(index + 1, 0, p.tracks.splice(index, 1)[0]); commit(); } }, '▼'),
        el('button', { class: 'icon-btn danger', title: 'Spur löschen', onclick: () => this.actions.removeTrack(track.id) }, '✕'),
      ),
      el('div', { class: 'tl-head-row' },
        el('button', { class: 'tog' + (track.muted ? ' on mute' : ''), title: 'Stumm (ausblenden)',
          onclick: () => { track.muted = !track.muted; commit(); } }, 'M'),
        el('button', { class: 'tog' + (track.solo ? ' on solo' : ''), title: 'Solo',
          onclick: () => { track.solo = !track.solo; commit(); } }, 'S'),
        blend,
        el('input', { type: 'range', class: 'tl-opacity', min: 0, max: 1, step: 0.01, value: track.opacity, title: 'Deckkraft der Spur',
          oninput: (e) => { track.opacity = Number(e.target.value); },   // Engine liest live, kein Neuaufbau beim Ziehen
          onchange: commit }),
      ),
    );
    const lane = el('div', { class: 'tl-lane', 'data-track': track.id, style: { width: laneW + 'px' } },
      ...track.clips.map((c) => this.clipEl(c)));
    return el('div', {
      class: 'tl-row tl-track-row' + (track.id === store.selectedTrack ? ' selected' : '') + (track.muted ? ' muted' : ''),
      'data-track': track.id,
    }, head, lane);
  }

  clipEl(clip) {
    const def = CLIP_TYPES[clip.type];
    const w = Math.max(4, clip.duration * this.pps);
    const fade = (cls, d) => d > 0 && el('div', { class: 'tl-fade ' + cls, style: { width: Math.min(w, d * this.pps) + 'px' } });
    return el('div', {
      class: 'tl-clip' + (clip.id === this.store.selectedClip ? ' selected' : '') + (this.engine.errors.has(clip.id) ? ' error' : ''),
      'data-clip': clip.id,
      title: `${clip.name} · ${def.label}\n${formatTime(clip.start)} – ${formatTime(clip.start + clip.duration)}`,
      style: { left: clip.start * this.pps + 'px', width: w + 'px', '--c': CATEGORIES[def.category].color },
    },
      fade('in', clip.fadeIn), fade('out', clip.fadeOut),
      el('div', { class: 'tl-clip-label' }, el('span', { class: 'tl-clip-icon' }, def.icon), clip.name),
      el('div', { class: 'tl-handle l', 'data-handle': 'l' }),
      el('div', { class: 'tl-handle r', 'data-handle': 'r' }),
      ...keyTimes(clip).filter((t) => t >= 0 && t <= clip.duration).map((t) => el('div', {
        class: 'tl-key', 'data-key-t': t, title: `Keyframe bei ${formatTime(clip.start + t)} – ziehen zum Verschieben`,
        style: { left: t * this.pps + 'px' },
      })),
    );
  }

  updateSelection() {
    const { selectedClip, selectedTrack } = this.store;
    for (const c of this.tracksEl.querySelectorAll('.tl-clip')) c.classList.toggle('selected', c.dataset.clip === selectedClip);
    for (const r of this.tracksEl.querySelectorAll('.tl-track-row')) r.classList.toggle('selected', r.dataset.track === selectedTrack);
  }

  markError(id) {
    this.tracksEl.querySelector(`[data-clip="${id}"]`)?.classList.toggle('error', this.engine.errors.has(id));
  }

  setZoom(pps, anchorT = this.engine.time, anchorX = null) {
    this.pps = clamp(pps, 2, 600);
    this.render();
    if (anchorX == null) anchorX = HEADER_W + (this.scroll.clientWidth - HEADER_W) / 2;
    this.scroll.scrollLeft = HEADER_W + anchorT * this.pps - anchorX;
  }

  timeAt(clientX) {
    return Math.max(0, (clientX - this.content.getBoundingClientRect().left - HEADER_W) / this.pps);
  }

  layoutCanvases() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, this.scroll.clientWidth - HEADER_W);
    for (const [c, h] of [[this.ruler, RULER_H], [this.audioCanvas, AUDIO_H]]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    const cs = getComputedStyle(document.documentElement);
    this.colors = {
      bg: cs.getPropertyValue('--panel-2').trim(), text: cs.getPropertyValue('--muted').trim(),
      line: cs.getPropertyValue('--line').trim(), accent: cs.getPropertyValue('--accent').trim(),
      wave: cs.getPropertyValue('--wave').trim(),
    };
    this.drawRuler();
    this.drawAudio();
  }

  updatePlayhead() {
    const x = HEADER_W + this.engine.time * this.pps;
    this.playhead.style.transform = `translateX(${x}px)`;
    if (this.follow && this.engine.playing && !this.dragging) {
      const left = this.scroll.scrollLeft, vw = this.scroll.clientWidth;
      if (x > left + vw - 30 || x < left + HEADER_W) this.scroll.scrollLeft = x - HEADER_W - 30;
    }
    this.drawRuler();
  }

  drawRuler() {
    const c = this.ruler, ctx = c.getContext('2d'), col = this.colors;
    if (!col) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.width / dpr, H = RULER_H;
    const pps = this.pps, t0 = this.scroll.scrollLeft / pps, t1 = t0 + W / pps;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'top';

    const bpm = this.store.project.bpm;
    if (bpm > 0) {
      const bar = (60 / bpm) * 4;
      let every = 1;
      while (bar * every * pps < 26) every *= 2;
      ctx.fillStyle = col.accent;
      ctx.globalAlpha = 0.7;
      for (let k = Math.floor(t0 / bar / every) * every; k * bar <= t1; k += every) {
        ctx.fillText(String(k + 1), (k * bar - t0) * pps + 3, 2);
      }
      ctx.globalAlpha = 1;
    }

    const major = NICE_STEPS.find((s) => s * pps >= 80) || 600;
    const minor = major / 5;
    ctx.strokeStyle = col.line;
    ctx.fillStyle = col.text;
    ctx.beginPath();
    for (let i = Math.floor(t0 / minor); i * minor <= t1; i++) {
      const t = i * minor;
      const x = Math.round((t - t0) * pps) + 0.5;
      const isMajor = i % 5 === 0;
      ctx.moveTo(x, H);
      ctx.lineTo(x, H - (isMajor ? 12 : 5));
      if (isMajor) ctx.fillText(major < 1 ? t.toFixed(2) + 's' : formatTime(t, false), x + 3, 14);
    }
    ctx.stroke();

    const px = (this.engine.time - t0) * pps;
    ctx.fillStyle = col.accent;
    ctx.beginPath();
    ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 9);
    ctx.fill();
    ctx.fillRect(px - 0.5, 0, 1, H);
  }

  drawAudio() {
    const c = this.audioCanvas, ctx = c.getContext('2d'), col = this.colors;
    if (!col) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.width / dpr, H = AUDIO_H;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const wf = this.engine.waveform;
    if (!wf) {
      ctx.fillStyle = col.text;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const msg = this.store.project.audio ? 'Wellenform wird berechnet …' : 'Audiodatei hierher ziehen, um Licht zur Musik zu timen';
      ctx.fillText(msg, 10, H / 2);
      return;
    }
    const t0 = this.scroll.scrollLeft / this.pps;
    ctx.fillStyle = col.wave;
    const mid = H / 2;
    for (let x = 0; x < W; x++) {
      const ta = t0 + x / this.pps;
      if (ta > wf.duration) break;
      const i0 = Math.floor(ta * wf.rate);
      const i1 = Math.max(i0 + 1, Math.ceil((ta + 1 / this.pps) * wf.rate));
      let m = 0;
      for (let i = i0; i < i1 && i < wf.peaks.length; i++) m = Math.max(m, wf.peaks[i]);
      const hh = Math.max(1, m * (H - 6));
      ctx.fillRect(x, mid - hh / 2, 1, hh);
    }
  }

  // ---------- Interaktion ----------

  bindRuler() {
    this.ruler.addEventListener('pointerdown', (e) => {
      this.ruler.setPointerCapture(e.pointerId);
      this.engine.seek(this.timeAt(e.clientX));
    });
    this.ruler.addEventListener('pointermove', (e) => {
      if (e.buttons & 1) this.engine.seek(this.timeAt(e.clientX));
    });
  }

  bindTracks() {
    this.tracksEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.tl-head')) return;
      const lane = e.target.closest('.tl-lane');
      if (!lane) return;
      const clipEl = e.target.closest('.tl-clip');
      if (!clipEl) {
        this.store.select(null);
        this.store.selectTrack(lane.dataset.track);
        this.engine.seek(this.timeAt(e.clientX));
        return;
      }
      e.preventDefault();
      const hit = this.store.findClip(clipEl.dataset.clip);
      if (!hit) return;
      this.store.select(hit.clip.id);
      if (e.target.dataset.keyT != null) return this.startKeyDrag(e, hit.clip, Number(e.target.dataset.keyT));
      const h = e.target.dataset.handle;
      this.startDrag(e, hit.clip, h ? 'resize-' + h : 'move');
    });
    this.tracksEl.addEventListener('dblclick', (e) => {
      const clipEl = e.target.closest('.tl-clip');
      if (!clipEl) return;
      if (this.store.findClip(clipEl.dataset.clip)?.clip.type === 'patch') this.actions.openNodes();
      else this.actions.focusInspector?.();
    });
  }

  startDrag(e, clip, mode) {
    const d = {
      x0: e.clientX, start: clip.start, dur: clip.duration, offset: clip.params.offset ?? 0,
      moved: false, targets: this.snapTargets(clip.id), lastStart: clip.start,
    };
    this.dragging = true;
    document.body.classList.add(mode === 'move' ? 'dragging-move' : 'dragging-resize');

    const move = (ev) => {
      const px = ev.clientX - d.x0;
      const from = this.store.findClip(clip.id);
      const lane = mode === 'move' ? document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.tl-lane[data-track]') : null;
      const switchTrack = lane && from && lane.dataset.track !== from.track.id;
      if (!d.moved && Math.abs(px) < 3 && !switchTrack) return;
      d.moved = true;
      const dx = px / this.pps;
      const snap = this.snapOn && !ev.altKey;

      if (mode === 'move') {
        let s = Math.max(0, d.start + dx);
        if (snap) s = this.snapRange(s, d.dur, d.targets);
        clip.start = round(Math.max(0, s));
        if (switchTrack) {
          from.track.clips.splice(from.index, 1);
          this.store.findTrack(lane.dataset.track).clips.push(clip);
          this.store.selectedTrack = lane.dataset.track;
        }
      } else if (mode === 'resize-l') {
        const end = d.start + d.dur;
        let s = clamp(d.start + dx, 0, end - MIN_DUR);
        if (snap) s = clamp(this.snapTime(s, d.targets), 0, end - MIN_DUR);
        clip.start = round(s);
        clip.duration = round(end - clip.start);
        if (clip.type === 'video') clip.params.offset = round(Math.max(0, d.offset + (clip.start - d.start) * clip.params.speed));
        // Keyframes an ihrer Position im Song lassen
        shiftKeys(clip, d.lastStart - clip.start);
        d.lastStart = clip.start;
      } else {
        let end = Math.max(d.start + MIN_DUR, d.start + d.dur + dx);
        if (snap) end = Math.max(d.start + MIN_DUR, this.snapTime(end, d.targets));
        clip.duration = round(end - d.start);
      }
      this.store.changed();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('dragging-move', 'dragging-resize');
      this.dragging = false;
      if (d.moved) this.store.commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Raute ziehen: alle Keyframes dieser Zeit verschieben; ohne Bewegung zum Keyframe springen
  startKeyDrag(e, clip, keyT) {
    e.stopPropagation();
    const x0 = e.clientX;
    let cur = keyT, moved = false;
    const targets = this.snapTargets(clip.id);
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      let abs = clip.start + keyT + (ev.clientX - x0) / this.pps;
      if (this.snapOn && !ev.altKey) abs = this.snapTime(abs, targets);
      const next = round(clamp(abs - clip.start, 0, clip.duration));
      if (next === cur) return;
      moveKeysAt(clip, cur, next);
      cur = next;
      this.store.changed();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) this.store.commit();
      else this.engine.seek(clip.start + keyT);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  snapTargets(excludeId) {
    const t = [0, this.engine.time];
    for (const track of this.store.project.tracks)
      for (const c of track.clips) if (c.id !== excludeId) t.push(c.start, c.start + c.duration);
    return t;
  }

  snapTime(t, targets) {
    const thr = SNAP_PX / this.pps;
    let best = t, bestD = thr;
    for (const x of targets) {
      const dist = Math.abs(x - t);
      if (dist < bestD) { best = x; bestD = dist; }
    }
    if (best !== t) return best;
    const bpm = this.store.project.bpm;
    if (bpm > 0) {
      const beat = 60 / bpm;
      const g = Math.round(t / beat) * beat;
      if (Math.abs(g - t) < thr) return g;
    }
    return t;
  }

  // Verschieben: Anfang oder Ende einrasten, je nachdem was näher liegt
  snapRange(s, dur, targets) {
    const a = this.snapTime(s, targets);
    const b = this.snapTime(s + dur, targets) - dur;
    const da = a !== s ? Math.abs(a - s) : Infinity;
    const db = b !== s ? Math.abs(b - s) : Infinity;
    return da <= db ? (da === Infinity ? s : a) : b;
  }

  bindDrop(target, audioOnly = false) {
    const laneOf = (e) => audioOnly ? this.audioLane : e.target.closest('.tl-lane');
    target.addEventListener('dragover', (e) => {
      const lane = laneOf(e);
      if (!lane) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      lane.classList.add('drop');
    });
    target.addEventListener('dragleave', (e) => laneOf(e)?.classList.remove('drop'));
    target.addEventListener('drop', (e) => {
      const lane = laneOf(e);
      if (!lane) return;
      e.preventDefault();
      lane.classList.remove('drop');
      let time = this.timeAt(e.clientX);
      if (this.snapOn) time = this.snapTime(time, this.snapTargets(null));
      const trackId = audioOnly ? null : lane.dataset.track;
      const payload = e.dataTransfer.getData('application/x-led-clip');
      if (payload && !audioOnly) {
        const { type, extra } = JSON.parse(payload);
        this.actions.addClip(type, extra, trackId, time);
      } else if (payload && audioOnly) {
        const { audio } = JSON.parse(payload);
        if (audio) this.actions.setAudio(audio);
      } else if (e.dataTransfer.files.length) {
        this.actions.dropFiles([...e.dataTransfer.files], trackId, time);
      }
    });
  }
}
