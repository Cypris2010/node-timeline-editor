// Node-Editor: Knoten eines Patch-Clips anordnen und verbinden. Liegt über Bibliothek, Vorschau und Inspektor,
// die Zeitleiste bleibt sichtbar, damit man beim Bauen scrubben und abspielen kann.
import { NODE_TYPES, NODE_CATEGORIES, PORT_TYPES, isPort, createNode, createsCycle } from './nodes.js';
import { el, fill, clamp } from './util.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const fmt = (v) => (typeof v === 'number' ? String(+v.toFixed(Math.abs(v) >= 100 ? 0 : 2)) : '');

export class NodeEditor {
  constructor(root, { store, engine, media }) {
    this.store = store;
    this.engine = engine;
    this.media = media;
    this.clipId = null;
    this.pan = { x: 40, y: 40 };
    this.zoom = 1;
    this.el = el('div', { class: 'node-editor', hidden: true });
    root.append(this.el);
    // Rückgängig/Laden ersetzt das Projekt: Clip neu suchen
    store.on('load', () => { if (this.clipId) (this.clip ? this.build() : this.close()); });
    media.on('change', () => { if (this.clipId && !this.busy) this.build(); });
  }

  get isOpen() { return Boolean(this.clipId); }
  get clip() { return this.clipId ? this.store.findClip(this.clipId)?.clip || null : null; }
  get graph() { return this.clip?.params.graph; }

  open(clipId) {
    const hit = this.store.findClip(clipId);
    if (!hit || hit.clip.type !== 'patch') return;
    this.clipId = clipId;
    this.selected = null;
    this.engine.inspectPatch = clipId;
    const { clip } = hit;
    const T = this.engine.time;
    if (T < clip.start || T >= clip.start + clip.duration) this.engine.seek(clip.start);
    this.el.hidden = false;
    this.build();
    requestAnimationFrame(() => this.fitView());
  }

  close() {
    this.clipId = null;
    this.engine.inspectPatch = null;
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  commit() { this.store.commit(); }

  // ---------- Aufbau ----------

  build() {
    const clip = this.clip;
    if (!clip) return;
    this.controls = [];
    this.thumbs = [];
    this.ports = new Map();     // 'nodeId.in.key' / 'nodeId.out.key' → Element
    this.nodeEls = new Map();
    this.outLabels = [];

    this.wires = svg('svg', { class: 'ne-wires' });
    this.world = el('div', { class: 'ne-world' }, this.wires, ...this.graph.nodes.map((n) => this.nodeEl(n)));
    this.view = el('div', { class: 'ne-view' }, this.world);
    this.inactive = el('div', { class: 'ne-inactive', hidden: true }, 'Abspielkopf steht außerhalb des Clips, die Vorschau ist eingefroren.');
    fill(this.el,
      el('div', { class: 'ne-bar' },
        el('b', {}, '⬡ ', clip.name),
        el('span', { class: 'muted small' }, 'Von einem Ausgang (●, rechts) auf einen Eingang (links) ziehen · Kabel anklicken trennt · Mausrad schiebt, ⌘ + Mausrad zoomt'),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn btn-xs', onclick: () => this.fitView() }, 'Einpassen'),
        el('button', { class: 'btn btn-xs on', onclick: () => this.close() }, 'Fertig (Esc)'),
      ),
      el('div', { class: 'ne-main' }, this.palette(), el('div', { class: 'ne-view-wrap' }, this.view, this.inactive)),
    );
    this.applyView();
    this.bindView();
    requestAnimationFrame(() => this.drawWires());
  }

  palette() {
    const groups = {};
    for (const [type, def] of Object.entries(NODE_TYPES)) {
      if (def.unique && this.graph.nodes.some((n) => n.type === type)) continue;
      (groups[def.cat] ||= []).push(el('div', {
        class: 'ne-pal-item', draggable: true, title: def.hint || '', style: { '--c': NODE_CATEGORIES[def.cat].color },
        onclick: () => {
          const r = this.view.getBoundingClientRect();
          this.addNode(type, (r.width / 2 - this.pan.x) / this.zoom - 90, (r.height / 2 - this.pan.y) / this.zoom - 40);
        },
        ondragstart: (e) => e.dataTransfer.setData('application/x-led-node', type),
      }, el('span', { class: 'lib-icon' }, def.icon || '•'), el('span', { class: 'lib-label' }, def.label)));
    }
    return el('aside', { class: 'ne-palette' },
      ...Object.entries(NODE_CATEGORIES).filter(([k]) => groups[k]).map(([k, c]) => [el('h3', {}, c.label), ...groups[k]]).flat());
  }

  thumb(cls) {
    // Gleich in Matrixgröße anlegen, sonst verspringt das Layout beim ersten Frame und die Kabel sitzen schief
    return el('canvas', { class: cls, width: this.engine.w, height: this.engine.h });
  }

  nodeEl(node) {
    const def = NODE_TYPES[node.type];
    if (!def) return el('div', { class: 'ne-node broken', style: { left: node.x + 'px', top: node.y + 'px' } }, `Unbekannt: ${node.type}`);
    const linked = (key) => this.graph.links.some((l) => l.to === node.id && l.in === key);
    const rows = [];

    for (const o of def.outputs) {
      const port = this.port(node, 'out', o);
      const val = el('span', { class: 'ne-out-val' });
      if (o.type !== 'image') this.outLabels.push({ node: node.id, key: o.key, el: val, type: o.type });
      rows.push(el('div', { class: 'ne-row out' }, val, el('span', { class: 'ne-label' }, o.label), port));
      if (o.type === 'image') {
        const cv = this.thumb('ne-thumb');
        this.thumbs.push({ node: node.id, key: o.key, canvas: cv, ctx: cv.getContext('2d') });
        rows.push(cv);
      }
    }
    if (node.type === 'output') {
      const cv = this.thumb('ne-thumb big');
      this.thumbs.push({ node: node.id, key: 'image', input: true, canvas: cv, ctx: cv.getContext('2d') });
      rows.push(cv);
    }
    for (const p of def.inputs) {
      if (isPort(p)) {
        const isLinked = linked(p.key);
        rows.push(el('div', { class: 'ne-row in' + (isLinked ? ' linked' : '') },
          this.port(node, 'in', p), el('span', { class: 'ne-label' }, p.label),
          p.type === 'image' ? null : this.field(node, p, isLinked)));
      } else {
        rows.push(el('div', { class: 'ne-row set' }, el('span', { class: 'ne-label' }, p.label), this.field(node, p, false)));
      }
    }

    const head = el('div', { class: 'ne-head', title: def.hint || '' },
      el('span', {}, def.icon || '', ' ', def.label),
      def.unique ? null : el('button', { class: 'icon-btn', title: 'Node löschen (Entf)', onclick: (e) => { e.stopPropagation(); this.removeNode(node.id); } }, '✕'));
    head.addEventListener('pointerdown', (e) => this.startNodeDrag(e, node));
    const box = el('div', {
      class: 'ne-node' + (this.selected === node.id ? ' selected' : '') + (node.type.startsWith('gen:') && NODE_TYPES[node.type].inputs.some((p) => p.type === 'code') ? ' wide' : ''),
      style: { left: node.x + 'px', top: node.y + 'px', '--c': NODE_CATEGORIES[def.cat].color },
    }, head, el('div', { class: 'ne-body' }, ...rows));
    this.nodeEls.set(node.id, box);
    return box;
  }

  port(node, dir, def) {
    const p = el('span', { class: `ne-port ${dir}`, title: PORT_TYPES[def.type].label, style: { '--pc': PORT_TYPES[def.type].color } });
    p.dataset.node = node.id;
    p.dataset.dir = dir;
    p.dataset.key = def.key;
    p.dataset.type = def.type;
    p.addEventListener('pointerdown', (e) => this.startWire(e, node.id, dir, def.key, def.type));
    this.ports.set(`${node.id}.${dir}.${def.key}`, p);
    return p;
  }

  // Bedienelement für einen Knoten-Parameter. Verbundene Eingänge zeigen nur den ankommenden Wert.
  field(node, def, isLinked) {
    node.params ||= {};
    const get = () => node.params[def.key] ?? def.default;
    const set = (v) => { node.params[def.key] = v; this.store.changed(); };
    const reg = (update) => this.controls.push({ update });
    const idle = (i) => document.activeElement !== i;

    switch (def.type) {
      case 'number': {
        const bar = el('div', { class: 'ne-fill' });
        const txt = el('span', { class: 'ne-val' });
        const box = el('div', { class: 'ne-scrub' + (isLinked ? ' linked' : ''), title: isLinked ? 'Wird über das Kabel gesteuert' : 'Ziehen ändert den Wert (⇧ fein) · Klick zum Eintippen' }, bar, txt);
        const show = (v) => {
          txt.textContent = fmt(v) + (def.unit ? ' ' + def.unit : '');
          bar.style.width = clamp((v - def.min) / (def.max - def.min)) * 100 + '%';
        };
        reg((res) => show(isLinked ? res?.values.get(node.id)?.in[def.key] ?? get() : get()));
        if (isLinked) return box;
        box.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          const x0 = e.clientX, v0 = Number(get());
          let moved = false;
          box.setPointerCapture(e.pointerId);
          const move = (ev) => {
            const dx = ev.clientX - x0;
            if (!moved && Math.abs(dx) < 3) return;
            moved = true;
            const sens = (def.max - def.min) / 240 * (ev.shiftKey ? 0.1 : 1);
            const v = clamp(Math.round((v0 + dx * sens) / def.step) * def.step, def.min, def.max);
            set(+v.toFixed(4));
            show(v);
          };
          const up = () => {
            box.removeEventListener('pointermove', move);
            box.removeEventListener('pointerup', up);
            if (moved) return this.commit();
            // Klick ohne Ziehen: Wert eintippen
            const input = el('input', { type: 'number', class: 'ne-num', step: def.step, value: fmt(get()) });
            const done = (apply) => {
              if (apply) set(clamp(Number(input.value) || 0, def.min, def.max));
              input.replaceWith(box);
              show(get());
              if (apply) this.commit();
            };
            input.addEventListener('keydown', (ev) => {
              if (ev.key === 'Enter') input.blur();
              else if (ev.key === 'Escape') { ev.stopPropagation(); input.onblur = null; done(false); }
            });
            input.onblur = () => done(true);
            box.replaceWith(input);
            input.focus();
            input.select();
          };
          box.addEventListener('pointermove', move);
          box.addEventListener('pointerup', up);
        });
        return box;
      }
      case 'color': {
        if (isLinked) {
          const sw = el('span', { class: 'ne-swatch' });
          reg((res) => { sw.style.background = res?.values.get(node.id)?.in[def.key] ?? get(); });
          return sw;
        }
        const i = el('input', { type: 'color', class: 'ne-color', oninput: (e) => set(e.target.value), onchange: () => this.commit() });
        reg(() => { if (idle(i)) i.value = get(); });
        return i;
      }
      case 'select': {
        const i = el('select', { class: 'ne-sel', onchange: (e) => { set(e.target.value); this.commit(); } },
          ...def.options.map(([v, l]) => el('option', { value: v }, l)));
        i.value = get();
        return i;
      }
      case 'bool': {
        return el('input', { type: 'checkbox', checked: Boolean(get()), onchange: (e) => { set(e.target.checked); this.commit(); } });
      }
      case 'text': {
        return el('input', { type: 'text', class: 'ne-text', value: get() ?? '', spellcheck: false, oninput: (e) => set(e.target.value), onchange: () => this.commit() });
      }
      case 'code': {
        let timer;
        const ta = el('textarea', {
          class: 'code ne-code', spellcheck: false, rows: 8,
          oninput: () => { clearTimeout(timer); timer = setTimeout(() => set(ta.value), 350); },
          onblur: () => { clearTimeout(timer); set(ta.value); this.commit(); },
        });
        ta.value = get();
        ta.addEventListener('pointerdown', (e) => e.stopPropagation());
        return ta;
      }
      case 'media': {
        const items = this.media.byKind(def.kind);
        const i = el('select', { class: 'ne-sel', onchange: (e) => { set(e.target.value); this.commit(); } },
          el('option', { value: '' }, '— keine Datei —'), ...items.map((m) => el('option', { value: m.url }, m.name)));
        i.value = get() || '';
        return i;
      }
      default:
        return el('span', { class: 'muted' }, '?');
    }
  }

  // ---------- Ansicht (Verschieben, Zoomen) ----------

  applyView() {
    this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
  }

  fitView() {
    if (!this.view || !this.nodeEls.size) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.graph.nodes) {
      const e = this.nodeEls.get(n.id);
      if (!e) continue;
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + e.offsetWidth); y1 = Math.max(y1, n.y + e.offsetHeight);
    }
    const r = this.view.getBoundingClientRect();
    const pad = 40;
    this.zoom = clamp(Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0)), 0.3, 1);
    this.pan.x = (r.width - (x1 - x0) * this.zoom) / 2 - x0 * this.zoom;
    this.pan.y = (r.height - (y1 - y0) * this.zoom) / 2 - y0 * this.zoom;
    this.applyView();
  }

  // Bildschirmkoordinaten → Graph-Koordinaten
  toWorld(cx, cy) {
    const r = this.view.getBoundingClientRect();
    return { x: (cx - r.left - this.pan.x) / this.zoom, y: (cy - r.top - this.pan.y) / this.zoom };
  }

  bindView() {
    const view = this.view;
    view.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const before = this.toWorld(e.clientX, e.clientY);
        this.zoom = clamp(this.zoom * Math.exp(-e.deltaY * 0.01), 0.25, 2);
        const r = view.getBoundingClientRect();
        this.pan.x = e.clientX - r.left - before.x * this.zoom;
        this.pan.y = e.clientY - r.top - before.y * this.zoom;
      } else {
        this.pan.x -= e.deltaX;
        this.pan.y -= e.deltaY;
      }
      this.applyView();
    }, { passive: false });

    view.addEventListener('pointerdown', (e) => {
      if (e.target !== view && e.target !== this.world && e.target !== this.wires) return;
      this.select(null);
      const x0 = e.clientX - this.pan.x, y0 = e.clientY - this.pan.y;
      view.setPointerCapture(e.pointerId);
      view.classList.add('panning');
      const move = (ev) => { this.pan.x = ev.clientX - x0; this.pan.y = ev.clientY - y0; this.applyView(); };
      const up = () => { view.classList.remove('panning'); view.removeEventListener('pointermove', move); view.removeEventListener('pointerup', up); };
      view.addEventListener('pointermove', move);
      view.addEventListener('pointerup', up);
    });

    view.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-led-node')) e.preventDefault(); });
    view.addEventListener('drop', (e) => {
      const type = e.dataTransfer.getData('application/x-led-node');
      if (!type) return;
      e.preventDefault();
      const p = this.toWorld(e.clientX, e.clientY);
      this.addNode(type, p.x - 20, p.y - 14);
    });
  }

  // ---------- Kabel ----------

  portPos(nodeId, dir, key) {
    const p = this.ports.get(`${nodeId}.${dir}.${key}`);
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  curve(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }

  drawWires() {
    if (!this.wires?.isConnected) return;
    const parts = [];
    for (const l of this.graph.links) {
      const a = this.portPos(l.from, 'out', l.out), b = this.portPos(l.to, 'in', l.in);
      if (!a || !b) continue;
      const type = this.ports.get(`${l.from}.out.${l.out}`).dataset.type;
      const d = this.curve(a, b);
      const hit = svg('path', { d, class: 'ne-wire-hit' });
      hit.appendChild(svg('title')).textContent = 'Klicken zum Trennen';
      hit.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.graph.links = this.graph.links.filter((x) => x !== l);
        this.commit();
        this.build();
      });
      parts.push(svg('path', { d, class: 'ne-wire', stroke: PORT_TYPES[type].color }), hit);
    }
    if (this.tempWire) parts.push(this.tempWire);
    this.wires.replaceChildren(...parts);
  }

  startWire(e, nodeId, dir, key, type) {
    e.preventDefault();
    e.stopPropagation();
    const graph = this.graph;
    let anchor = { node: nodeId, dir, key, type };
    let detached = false;
    // Ein belegter Eingang wird beim Ziehen abgezogen, das Kabel hängt dann am ursprünglichen Ausgang
    if (dir === 'in') {
      const existing = graph.links.find((l) => l.to === nodeId && l.in === key);
      if (existing) {
        graph.links = graph.links.filter((l) => l !== existing);
        anchor = { node: existing.from, dir: 'out', key: existing.out, type };
        detached = true;
      }
    }
    this.busy = true;
    this.tempWire = svg('path', { class: 'ne-wire temp', stroke: PORT_TYPES[type].color });
    const from = this.portPos(anchor.node, anchor.dir, anchor.key);
    let hover = null;
    const valid = (t) => t && t.dataset.dir !== anchor.dir && t.dataset.type === anchor.type && t.dataset.node !== anchor.node;
    const move = (ev) => {
      const p = this.toWorld(ev.clientX, ev.clientY);
      this.tempWire.setAttribute('d', anchor.dir === 'out' ? this.curve(from, p) : this.curve(p, from));
      const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.ne-port');
      if (hover && hover !== t) hover.classList.remove('target', 'bad');
      hover = t;
      if (t && t !== e.target) t.classList.add(valid(t) ? 'target' : 'bad');
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.tempWire = null;
      this.busy = false;
      const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.ne-port');
      if (valid(t)) {
        const out = anchor.dir === 'out' ? anchor : { node: t.dataset.node, key: t.dataset.key };
        const inp = anchor.dir === 'in' ? anchor : { node: t.dataset.node, key: t.dataset.key };
        if (createsCycle(graph, out.node, inp.node)) this.flash('Diese Verbindung würde einen Kreis bilden.');
        else {
          graph.links = graph.links.filter((l) => !(l.to === inp.node && l.in === inp.key));
          graph.links.push({ from: out.node, out: out.key, to: inp.node, in: inp.key });
          detached = true;
        }
      }
      if (detached) this.commit();
      this.build();
    };
    this.drawWires();
    move(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  flash(msg) {
    const n = el('div', { class: 'ne-flash' }, msg);
    this.view.parentElement.append(n);
    setTimeout(() => n.remove(), 2200);
  }

  // ---------- Knoten ----------

  startNodeDrag(e, node) {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    this.select(node.id);
    const box = this.nodeEls.get(node.id);
    const x0 = e.clientX, y0 = e.clientY, nx = node.x, ny = node.y;
    let moved = false;
    const move = (ev) => {
      const dx = (ev.clientX - x0) / this.zoom, dy = (ev.clientY - y0) / this.zoom;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      node.x = Math.round(nx + dx);
      node.y = Math.round(ny + dy);
      box.style.left = node.x + 'px';
      box.style.top = node.y + 'px';
      this.drawWires();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) this.commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  select(id) {
    this.selected = id;
    for (const [nid, e] of this.nodeEls) e.classList.toggle('selected', nid === id);
  }

  addNode(type, x, y) {
    const node = createNode(type, x, y);
    this.graph.nodes.push(node);
    this.selected = node.id;
    this.commit();
    this.build();
  }

  removeNode(id) {
    const g = this.graph;
    const node = g.nodes.find((n) => n.id === id);
    if (!node || NODE_TYPES[node.type]?.unique) return;
    g.nodes = g.nodes.filter((n) => n.id !== id);
    g.links = g.links.filter((l) => l.from !== id && l.to !== id);
    for (const key of this.engine.nodeState.keys()) if (key === this.clipId + '/' + id) this.engine.nodeState.delete(key);
    this.selected = null;
    this.commit();
    this.build();
  }

  // Tastatur, solange der Editor offen ist. true = erledigt.
  onKey(e) {
    if (e.key === 'Escape') { this.close(); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { this.removeNode(this.selected); return true; }
    if (e.key === 'Delete' || e.key === 'Backspace') return true;   // nicht versehentlich den Clip löschen
    return false;
  }

  // ---------- Jeder Frame: Vorschaubilder und Live-Werte ----------

  tick() {
    if (!this.clipId || !this.thumbs) return;
    const clip = this.clip;
    if (!clip) return this.close();
    const T = this.engine.time;
    this.inactive.hidden = T >= clip.start && T < clip.start + clip.duration;
    const res = this.engine.patchResults.get(this.clipId);
    const { w, h } = this.engine;
    for (const th of this.thumbs) {
      const v = res?.values.get(th.node);
      const img = th.input ? v?.in[th.key] : v?.out[th.key];
      if (th.canvas.width !== w || th.canvas.height !== h) { th.canvas.width = w; th.canvas.height = h; }
      if (img && img.width === w && img.height === h) th.ctx.putImageData(img, 0, 0);
      else th.ctx.clearRect(0, 0, w, h);
    }
    for (const o of this.outLabels) {
      const v = res?.values.get(o.node)?.out[o.key];
      if (o.type === 'color') o.el.style.background = v || 'transparent';
      else o.el.textContent = fmt(v);
      o.el.classList.toggle('swatch', o.type === 'color');
    }
    for (const c of this.controls) c.update(res);
    for (const [id, e] of this.nodeEls) {
      const err = res?.values.get(id)?.error;
      e.classList.toggle('error', Boolean(err));
      e.title = err || '';
    }
  }
}
