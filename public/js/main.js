// Einstieg: verbindet Projekt, Engine, Zeitleiste, Panels und die Render-Schleife.
import { CLIP_TYPES } from './clips.js';
import { Store, createClip, createTrack, blankProject, demoProject } from './store.js';
import { Engine } from './engine.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { Library, MediaLibrary } from './library.js';
import { OutputLink, OutputPanel, ProjectPanel } from './panels.js';
import { Preview } from './preview.js';
import { NodeEditor } from './nodeeditor.js';
import { el, uid, formatTime } from './util.js';
import { shiftKeys } from './anim.js';

const $ = (sel) => document.querySelector(sel);
const round = (v) => Math.round(v * 1000) / 1000;

const store = new Store(Store.restore() || demoProject());
const engine = new Engine(store);
const media = new MediaLibrary();
const link = new OutputLink();

function toast(msg, kind = 'ok') {
  const t = el('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

function probeDuration(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    const done = (d) => { v.removeAttribute('src'); resolve(d); };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : 10);
    v.onerror = () => done(10);
    setTimeout(() => done(10), 4000);
    v.src = url;
  });
}

// ---------- Aktionen (von Zeitleiste, Bibliothek, Tastatur genutzt) ----------

const actions = {
  toast,

  addTrack() {
    const p = store.project;
    const track = createTrack(`Spur ${p.tracks.length + 1}`);
    const idx = Math.max(0, p.tracks.findIndex((t) => t.id === store.selectedTrack));
    p.tracks.splice(idx, 0, track);
    store.selectedTrack = track.id;
    store.commit();
  },

  removeTrack(id) {
    const p = store.project;
    const track = store.findTrack(id);
    if (!track) return;
    if (track.clips.length && !confirm(`Spur „${track.name}“ mit ${track.clips.length} Clip(s) löschen?`)) return;
    p.tracks = p.tracks.filter((t) => t.id !== id);
    if (store.clip && !store.findClip(store.selectedClip)) store.selectedClip = null;
    store.selectedTrack = p.tracks[0]?.id || null;
    store.commit();
  },

  addClip(type, extra = {}, trackId = null, time = null) {
    if (!store.project.tracks.length) actions.addTrack();
    const track = store.findTrack(trackId) || store.track;
    const clip = createClip(type, round(time ?? engine.time), extra);
    track.clips.push(clip);
    store.commit();
    store.select(clip.id);
    return clip;
  },

  split() {
    const hit = store.selectedClip && store.findClip(store.selectedClip);
    const T = engine.time;
    // Ausgewählten Clip teilen, sonst den obersten Clip unter dem Abspielkopf auf der aktiven Spur
    const target = hit && T > hit.clip.start && T < hit.clip.start + hit.clip.duration ? hit
      : (() => {
        const track = store.track;
        const i = track?.clips.findIndex((c) => T > c.start && T < c.start + c.duration);
        return i >= 0 ? { clip: track.clips[i], track, index: i } : null;
      })();
    if (!target) return toast('Kein Clip unter dem Abspielkopf', 'warn');
    const { clip, track, index } = target;
    const cut = round(T - clip.start);
    const right = structuredClone(clip);
    right.id = uid();
    right.start = round(T);
    right.duration = round(clip.duration - cut);
    right.fadeIn = 0;
    if (clip.type === 'video') right.params.offset = round(clip.params.offset + cut * clip.params.speed);
    shiftKeys(right, -cut);   // Keyframes bleiben an derselben Stelle im Song
    clip.duration = cut;
    clip.fadeOut = 0;
    track.clips.splice(index + 1, 0, right);
    store.commit();
    store.select(right.id);
  },

  duplicate() {
    const hit = store.selectedClip && store.findClip(store.selectedClip);
    if (!hit) return;
    const copy = structuredClone(hit.clip);
    copy.id = uid();
    copy.start = round(hit.clip.start + hit.clip.duration);
    hit.track.clips.push(copy);
    store.commit();
    store.select(copy.id);
  },

  remove() {
    const hit = store.selectedClip && store.findClip(store.selectedClip);
    if (!hit) return;
    hit.track.clips.splice(hit.index, 1);
    store.select(null);
    store.commit();
    engine.gc();
  },

  setAudio(audio) {
    store.project.audio = audio ? { url: audio.url, name: audio.name } : null;
    engine.setAudio(audio?.url || null);
    if (audio) {
      engine.audioEl.addEventListener('loadedmetadata', () => {
        if (engine.audioEl.duration > store.project.duration) {
          store.project.duration = Math.ceil(engine.audioEl.duration);
          store.commit();
        }
      }, { once: true });
    }
    store.commit();
  },

  async uploadFiles(files) {
    const done = [];
    for (const f of files) {
      try {
        toast(`Lade ${f.name} hoch …`);
        done.push(await media.upload(f));
      } catch (e) {
        toast(`${f.name}: ${e.message}`, 'bad');
      }
    }
    return done;
  },

  async dropFiles(files, trackId, time) {
    const uploaded = await actions.uploadFiles(files);
    let t = time ?? engine.time;
    for (const m of uploaded) {
      if (m.kind === 'audio') { actions.setAudio(m); continue; }
      const type = m.kind === 'video' ? 'video' : 'image';
      const duration = type === 'video' ? Math.min(600, await probeDuration(m.url)) : 8;
      const clip = actions.addClip(type, { name: m.name, duration: round(duration), params: { src: m.url } }, trackId, t);
      t = clip.start + clip.duration;
    }
  },

  async save() {
    const p = store.project;
    const res = await fetch('/api/projects/' + encodeURIComponent(p.name), { method: 'PUT', body: JSON.stringify(p) });
    if (res.ok) toast(`„${p.name}“ gespeichert`);
    else toast('Speichern fehlgeschlagen', 'bad');
    projectPanel.render(true);
  },

  async openProject(name) {
    const res = await fetch('/api/projects/' + encodeURIComponent(name));
    if (!res.ok) return toast('Projekt nicht gefunden', 'bad');
    actions.loadProject(await res.json());
  },

  loadProject(data) {
    engine.pause();
    store.load(data);
    store.autosave();
    engine.seek(0);
    toast(`„${store.project.name}“ geladen`);
  },

  newProject() {
    if (!confirm('Neues, leeres Projekt anlegen? Nicht gespeicherte Änderungen bleiben nur im Browser erhalten.')) return;
    actions.loadProject(blankProject());
  },

  exportProject() {
    const blob = new Blob([JSON.stringify(store.project, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: (store.project.name || 'projekt') + '.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },

  focusInspector() { showTab('clip'); },

  openNodes(id = store.selectedClip) { nodeEditor.open(id); },
};

// ---------- Oberfläche ----------

const preview = new Preview($('#preview'));
const timeline = new Timeline($('#timeline'), { store, engine, actions });
const inspector = new Inspector($('#tab-clip'), { store, engine, media, actions });
new Library($('#library'), { media, actions });
const outputPanel = new OutputPanel($('#tab-output'), { link, engine });
const projectPanel = new ProjectPanel($('#tab-project'), { store, media, actions });
const nodeEditor = new NodeEditor($('.workspace'), { store, engine, media });

let outputFps = 40;

// Hintergrund-Tabs bekommen kein requestAnimationFrame mehr.
// Ein Worker-Timer hält die Ausgabe dann trotzdem am Laufen.
const ticker = new Worker(URL.createObjectURL(new Blob(
  ['let id; onmessage = (e) => { clearInterval(id); id = setInterval(() => postMessage(0), e.data); };'],
  { type: 'text/javascript' },
)));
ticker.onmessage = () => { if (document.hidden) frame(); };
ticker.postMessage(1000 / 40);

outputPanel.on('config', (c) => {
  if (c.width !== engine.w || c.height !== engine.h) engine.setSize(c.width, c.height);
  outputFps = c.fps;
  ticker.postMessage(1000 / outputFps);
  $('#res').textContent = `${c.width} × ${c.height} · ${c.width * c.height} LEDs`;
});
outputPanel.on('status', ({ cls, state, stats }) => {
  const pill = $('#out-pill');
  pill.className = 'pill ' + cls;
  pill.title = state;
  pill.querySelector('.txt').textContent = cls === 'ok' ? `${stats?.frames ?? 0} fps → ${stats?.target ?? ''}` : state;
});

function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.id !== 'tab-' + name;
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
store.on('select', () => { if (store.selectedClip) showTab('clip'); });
$('#out-pill').addEventListener('click', () => showTab('output'));

$('#btn-play').addEventListener('click', () => engine.toggle());
$('#btn-start').addEventListener('click', () => engine.seek(0));
$('#btn-loop').addEventListener('click', () => { store.project.loop = !store.project.loop; store.commit(); });
$('#btn-save').addEventListener('click', () => actions.save());
$('#btn-undo').addEventListener('click', () => store.undo());
$('#btn-redo').addEventListener('click', () => store.redo());
$('#preview-mode').addEventListener('click', (e) => {
  preview.mode = preview.mode === 'dots' ? 'pixels' : 'dots';
  e.target.textContent = preview.mode === 'dots' ? '● Punkte' : '■ Pixel';
});
const nameInput = $('#project-name');
nameInput.addEventListener('change', () => { store.project.name = nameInput.value || 'Projekt'; store.commit(); });

engine.on('transport', () => {
  $('#btn-play').textContent = engine.playing ? '⏸' : '▶';
  $('#btn-play').classList.toggle('on', engine.playing);
});
store.on('change', () => {
  $('#btn-loop').classList.toggle('on', store.project.loop);
  if (document.activeElement !== nameInput) nameInput.value = store.project.name;
  $('#btn-undo').disabled = !store.undoStack.length;
  $('#btn-redo').disabled = !store.redoStack.length;
});
store.on('load', () => { engine.setAudio(store.project.audio?.url || null); engine.gc(); });
store.on('commit', () => engine.gc());
store.emit('load');
store.emit('change');

// Zeitleisten-Höhe per Trenner verstellen
$('#splitter').addEventListener('pointerdown', (e) => {
  const startY = e.clientY;
  const startH = $('#timeline').getBoundingClientRect().height;
  const move = (ev) => document.body.style.setProperty('--tl-h', Math.max(160, Math.min(window.innerHeight - 220, startH - (ev.clientY - startY))) + 'px');
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// ---------- Tastatur ----------

window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  const typing = (tag === 'INPUT' && !['range', 'checkbox', 'color', 'button'].includes(document.activeElement.type))
    || tag === 'TEXTAREA' || tag === 'SELECT';
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); actions.save(); return; }
  if (typing) return;
  if (nodeEditor.isOpen && !mod && nodeEditor.onKey(e)) { e.preventDefault(); return; }
  const beat = store.project.bpm > 0 ? 60 / store.project.bpm : 1;

  if (e.code === 'Space') { e.preventDefault(); document.activeElement?.blur(); engine.toggle(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); actions.remove(); }
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); }
  else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); actions.duplicate(); }
  else if (!mod && e.key.toLowerCase() === 's') actions.split();
  else if (e.key === 'Home') engine.seek(0);
  else if (e.key === 'End') engine.seek(store.project.duration);
  else if (e.key === 'ArrowLeft') { e.preventDefault(); engine.seek(engine.time - (e.shiftKey ? beat * 4 : beat)); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); engine.seek(engine.time + (e.shiftKey ? beat * 4 : beat)); }
  else if (e.key === 'Escape') store.select(null);
});

// ---------- Render-Schleife ----------

let lastSend = 0;
const timeEl = $('#time');
const beatEl = $('#beat');

function frame() {
  engine.tick();
  const img = engine.render();
  const now = performance.now();
  const interval = 1000 / outputFps;
  if (now - lastSend >= interval - 1) {
    link.send(img);
    // Takt halten statt auf den letzten Frame zu setzen, sonst landet man bei 60-Hz-Bildschirmen auf 30 fps
    lastSend = Math.max(lastSend + interval, now - interval);
  }
  if (document.hidden) return;
  preview.draw(img);
  timeline.updatePlayhead();
  inspector.tick();
  nodeEditor.tick();
  timeEl.textContent = formatTime(engine.time);
  const bpm = store.project.bpm;
  if (bpm > 0) {
    const b = Math.floor(engine.time / (60 / bpm));
    beatEl.textContent = `Takt ${Math.floor(b / 4) + 1}.${(b % 4) + 1}`;
  } else beatEl.textContent = '';
}

function loop() {
  frame();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

media.refresh();
window.ledTimeline = { store, engine, media, link, actions, nodeEditor, CLIP_TYPES };   // für Experimente in der Konsole
