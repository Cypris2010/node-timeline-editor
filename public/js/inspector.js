// Inspektor: zeigt die Eigenschaften des ausgewählten Clips und lässt sie live ändern.
import { CLIP_TYPES, COMMON_PARAMS, CATEGORIES } from './clips.js';
import { el, fill, clamp } from './util.js';
import {
  EASES, isAnimatable, isAnimated, pathOf, keysOf, valueAt, setKey, removeKey, clearAnim,
  findKey, segmentKey, neighbourKeyTime,
} from './anim.js';

const SHORTCUTS = [
  ['Leertaste', 'Abspielen / Pause'], ['S', 'Clip am Abspielkopf teilen'], ['Entf', 'Clip löschen'],
  ['⌘D', 'Clip duplizieren'], ['⌘Z / ⇧⌘Z', 'Rückgängig / Wiederholen'], ['⌘S', 'Projekt speichern'],
  ['← →', 'Einen Beat springen'], ['Pos1', 'Zum Anfang'], ['Alt beim Ziehen', 'Einrasten aus'],
  ['⌘ + Mausrad', 'Zoomen'], ['◇ neben einem Regler', 'Parameter animieren (Keyframe)'],
];

export class Inspector {
  constructor(root, { store, engine, media, actions }) {
    this.root = root;
    this.store = store;
    this.engine = engine;
    this.media = media;
    this.actions = actions;
    this.controls = [];
    store.on('select', () => this.build());
    store.on('load', () => this.build());
    store.on('change', () => this.sync());
    engine.on('errors', (id) => { if (id === store.selectedClip) this.showError(); });
    media.on('change', () => { if (!this.root.contains(document.activeElement)) this.build(); });
    this.build();
  }

  build() {
    this.controls = [];
    const clip = this.store.clip;
    if (!clip) {
      fill(this.root, 
        el('div', { class: 'empty' },
          el('p', {}, 'Kein Clip ausgewählt.'),
          el('p', { class: 'muted' }, 'Zieh einen Baustein aus der Bibliothek auf eine Spur oder klick ihn an, dann landet er am Abspielkopf.'),
        ),
        el('h3', {}, 'Tastenkürzel'),
        el('dl', { class: 'shortcuts' }, ...SHORTCUTS.flatMap(([k, v]) => [el('dt', {}, el('kbd', {}, k)), el('dd', {}, v)])),
      );
      return;
    }
    const def = CLIP_TYPES[clip.type];
    this.errorBox = el('pre', { class: 'error-box', hidden: true });
    fill(this.root, 
      el('div', { class: 'insp-head', style: { '--c': CATEGORIES[def.category].color } },
        el('span', { class: 'badge' }, def.icon, ' ', def.label),
        el('button', { class: 'btn', title: 'Duplizieren', onclick: () => this.actions.duplicate() }, '⧉'),
        el('button', { class: 'btn danger', title: 'Löschen', onclick: () => this.actions.remove() }, '🗑'),
      ),
      this.errorBox,
      el('h3', {}, 'Clip'),
      ...COMMON_PARAMS.map((p) => this.row(p, clip)),
      def.params.length ? el('h3', {}, def.label) : null,
      ...def.params.map((p) => this.row(p, clip.params)),
    );
    this.showError();
  }

  showError() {
    if (!this.errorBox) return;
    const msg = this.engine.errors.get(this.store.selectedClip);
    this.errorBox.hidden = !msg;
    this.errorBox.textContent = msg || '';
  }

  sync() {
    for (const c of this.controls) c.update();
  }

  row(def, target) {
    const { store, engine } = this;
    const clip = store.clip;
    const live = () => store.changed();
    const commit = () => store.commit();
    const anim = isAnimatable(def);
    const path = pathOf(def);
    const localT = () => clamp(engine.time - clip.start, 0, clip.duration);
    const animated = () => anim && isAnimated(clip, path);
    // Animierte Parameter zeigen den Wert am Abspielkopf; Ändern setzt dort einen Keyframe
    const get = () => (animated() ? valueAt(keysOf(clip, path), localT()) : target[def.key]);
    const set = (v) => { if (animated()) setKey(clip, path, localT(), v); else target[def.key] = v; };
    const control = this.control(def, get, set, live, commit);
    const label = el('label', {}, def.label, def.unit ? el('span', { class: 'unit' }, ' ' + def.unit) : null);
    if (def.type === 'bool') {
      return el('label', { class: 'row row-bool' }, control, el('span', {}, def.label));
    }
    if (def.type === 'graph') return el('div', { class: 'row row-code' }, control);
    if (!anim) return el('div', { class: 'row' + (def.type === 'code' ? ' row-code' : '') }, label, control);

    const jump = (dir) => {
      const t = neighbourKeyTime(keysOf(clip, path), localT(), dir);
      if (t != null) engine.seek(clip.start + t);
    };
    const keyBtn = el('button', {
      class: 'key-btn',
      onclick: () => {
        const keys = keysOf(clip, path);
        const t = localT();
        const i = findKey(keys, t);
        if (i >= 0) removeKey(clip, path, i);
        else setKey(clip, path, t, get());
        commit();
      },
    });
    const prevBtn = el('button', { class: 'icon-btn', title: 'Vorheriger Keyframe', onclick: () => jump(-1) }, '◀');
    const nextBtn = el('button', { class: 'icon-btn', title: 'Nächster Keyframe', onclick: () => jump(1) }, '▶');
    const easeSel = el('select', { class: 'sel-sm', title: 'Kurve vom aktuellen bis zum nächsten Keyframe',
      onchange: (e) => {
        const seg = segmentKey(keysOf(clip, path), localT());
        if (seg) { seg.ease = e.target.value; commit(); }
      } }, ...EASES.map(([v, l]) => el('option', { value: v }, l)));
    const clearBtn = el('button', { class: 'icon-btn danger', title: 'Animation entfernen (aktueller Wert bleibt)',
      onclick: () => { const v = get(); clearAnim(clip, path); target[def.key] = v; commit(); } }, '✕ Animation');
    const keyBar = el('div', { class: 'key-bar' }, prevBtn, nextBtn, el('span', { class: 'muted small' }, 'Kurve'), easeSel, el('span', { class: 'grow' }), clearBtn);
    const rowEl = el('div', { class: 'row row-anim' }, el('div', { class: 'row-label' }, keyBtn, label), control);

    const updateKeys = () => {
      const keys = keysOf(clip, path);
      const t = localT();
      const has = Boolean(keys?.length);
      const onKey = findKey(keys, t) >= 0;
      const inside = engine.time >= clip.start && engine.time <= clip.start + clip.duration;
      keyBtn.textContent = onKey ? '◆' : '◇';
      keyBtn.classList.toggle('on', onKey);
      keyBtn.disabled = !inside && !onKey;
      keyBtn.title = !inside ? 'Abspielkopf über den Clip bewegen, um Keyframes zu setzen'
        : onKey ? 'Keyframe entfernen' : has ? 'Keyframe hinzufügen' : 'Animieren: Keyframe an der Abspielposition setzen';
      rowEl.classList.toggle('animated', has);
      keyBar.hidden = !has;
      if (!has) return;
      prevBtn.disabled = neighbourKeyTime(keys, t, -1) == null;
      nextBtn.disabled = neighbourKeyTime(keys, t, 1) == null;
      const seg = segmentKey(keys, t);
      if (seg && document.activeElement !== easeSel) easeSel.value = seg.ease;
    };
    this.controls.push({ update: updateKeys });
    updateKeys();
    return [rowEl, keyBar];
  }

  // Jeden Frame aufrufen: animierte Werte und Keyframe-Knöpfe folgen dem Abspielkopf
  tick() {
    if (!this.store.selectedClip || this.engine.time === this.lastTime) return;
    this.lastTime = this.engine.time;
    this.sync();
  }

  control(def, get, set, live, commit) {
    const reg = (update) => { this.controls.push({ update }); update(); };
    const idle = (input) => document.activeElement !== input;

    switch (def.type) {
      case 'number': {
        const parse = (v) => Math.min(def.max, Math.max(def.min, Number(v) || 0));
        const num = el('input', { type: 'number', min: def.min, max: def.max, step: def.step, class: 'num' });
        const useSlider = def.max - def.min <= 100;
        const range = useSlider ? el('input', { type: 'range', min: def.min, max: def.max, step: def.step }) : null;
        const onInput = (e) => {
          const v = parse(e.target.value);
          set(v);
          if (range && e.target !== range) range.value = v;
          if (e.target !== num) num.value = v;
          live();
        };
        for (const i of [num, range]) if (i) { i.addEventListener('input', onInput); i.addEventListener('change', commit); }
        reg(() => {
          const v = get();
          if (idle(num)) num.value = +Number(v).toFixed(3);
          if (range && idle(range)) range.value = v;
        });
        return el('div', { class: 'num-wrap' }, range, num);
      }
      case 'color': {
        const i = el('input', { type: 'color', oninput: (e) => { set(e.target.value); live(); }, onchange: commit });
        reg(() => { if (idle(i)) i.value = get(); });
        return i;
      }
      case 'bool': {
        const i = el('input', { type: 'checkbox', onchange: (e) => { set(e.target.checked); commit(); } });
        reg(() => { i.checked = Boolean(get()); });
        return i;
      }
      case 'select': {
        const i = el('select', { onchange: (e) => { set(e.target.value); commit(); } },
          ...def.options.map(([v, l]) => el('option', { value: v }, l)));
        reg(() => { if (idle(i)) i.value = get(); });
        return i;
      }
      case 'text': {
        const i = el('input', { type: 'text', spellcheck: false, oninput: (e) => { set(e.target.value); live(); }, onchange: commit });
        reg(() => { if (idle(i)) i.value = get() ?? ''; });
        return i;
      }
      case 'code': {
        let timer;
        const apply = () => { clearTimeout(timer); set(ta.value); live(); };
        const ta = el('textarea', {
          class: 'code', spellcheck: false, rows: 14,
          oninput: () => { clearTimeout(timer); timer = setTimeout(apply, 350); },   // Live-Coding mit kurzer Verzögerung
          onblur: () => { apply(); commit(); },
          onkeydown: (e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
              ta.dispatchEvent(new Event('input'));
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              apply();
              commit();
            }
          },
        });
        reg(() => { if (idle(ta)) ta.value = get(); });
        return el('div', {}, ta, el('div', { class: 'muted small' }, 'Änderungen werden live übernommen · ⌘↵ sofort'));
      }
      case 'graph': {
        const info = el('div', { class: 'muted small' });
        reg(() => { const g = get(); info.textContent = `${g.nodes.length} Nodes · ${g.links.length} Verbindungen · Doppelklick auf den Clip öffnet ebenfalls`; });
        return el('div', { class: 'graph-open' },
          el('button', { class: 'btn btn-big', onclick: () => this.actions.openNodes() }, '⬡ Node-Editor öffnen'), info);
      }
      case 'media': {
        const items = this.media.byKind(def.kind);
        const sel = el('select', { onchange: (e) => { set(e.target.value); applyName(e.target.value); commit(); } },
          el('option', { value: '' }, '— keine Datei —'),
          ...items.map((m) => el('option', { value: m.url }, m.name)));
        const applyName = (url) => {
          const clip = this.store.clip;
          const item = items.find((m) => m.url === url);
          if (clip && item && Object.values(CLIP_TYPES).some((t) => t.label === clip.name)) clip.name = item.name;
        };
        const file = el('input', {
          type: 'file', accept: def.kind + '/*', hidden: true,
          onchange: async (e) => {
            const [up] = await this.actions.uploadFiles([...e.target.files]);
            if (up) { set(up.url); applyName(up.url); commit(); this.build(); }
          },
        });
        reg(() => { if (idle(sel)) sel.value = get() || ''; });
        return el('div', { class: 'media-pick' }, sel, el('button', { class: 'btn', onclick: () => file.click() }, 'Hochladen …'), file);
      }
      default:
        return el('span', {}, '?');
    }
  }
}
