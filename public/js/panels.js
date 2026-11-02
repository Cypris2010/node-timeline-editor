// Verbindung zum Server (Frames senden) sowie die Panels „Ausgabe“ und „Projekt“.
import { el, fill, Emitter } from './util.js';

export class OutputLink extends Emitter {
  constructor() {
    super();
    this.connected = false;
    this.master = false;
    this.stats = null;
    this.sentFrames = 0;
    this.connect();
  }

  connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.connected = true; this.emit('status'); };
    ws.onclose = () => {
      this.connected = false;
      this.master = false;
      this.emit('status');
      setTimeout(() => this.connect(), 1000);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'role') { this.master = msg.master; this.emit('status'); }
      else if (msg.type === 'stats') { this.stats = { ...msg, sent: this.sentFrames }; this.sentFrames = 0; this.emit('status'); }
      else if (msg.type === 'output') this.emit('config', msg.config);
    };
    this.ws = ws;
  }

  claim() {
    if (this.connected) this.ws.send(JSON.stringify({ type: 'claim' }));
  }

  send(img) {
    if (!this.connected || !this.master || this.ws.bufferedAmount > 1 << 20) return;
    const { width: w, height: h, data } = img;
    const buf = new Uint8Array(4 + w * h * 3);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, w, true);
    dv.setUint16(2, h, true);
    for (let i = 0, j = 4, n = w * h * 4; i < n; i += 4) {
      buf[j++] = data[i]; buf[j++] = data[i + 1]; buf[j++] = data[i + 2];
    }
    this.ws.send(buf);
    this.sentFrames++;
  }
}

const HINTS = {
  ddp: (c, n) => [
    'WLED → Einstellungen → Sync-Schnittstellen: „Receive UDP realtime“ aktivieren. DDP braucht sonst keine Einstellung (Port 4048).',
    `Pakete pro Frame: ${Math.ceil(n / 480)} (max. 480 Pixel pro Paket).`,
  ],
  artnet: (c, n) => [
    `WLED → Sync-Schnittstellen → Echtzeit: Typ „Art-Net“, DMX-Modus „Multi RGB“, Start-Universe ${c.universe}, DMX-Startadresse 1.`,
    `Benötigte Universes: ${Math.ceil(n / 170)} (${c.universe} – ${c.universe + Math.ceil(n / 170) - 1}), je 170 Pixel.`,
  ],
  sacn: (c, n) => [
    `WLED → Sync-Schnittstellen → Echtzeit: Typ „E1.31 (sACN)“, Multicast aus, DMX-Modus „Multi RGB“, Start-Universe ${c.universe}.`,
    `Benötigte Universes: ${Math.ceil(n / 170)}, je 170 Pixel.`,
  ],
};

export class OutputPanel extends Emitter {
  constructor(root, { link, engine }) {
    super();
    this.root = root;
    this.link = link;
    this.engine = engine;
    this.config = null;
    link.on('status', () => this.renderStatus());
    link.on('config', (c) => { this.config = c; this.emit('config', c); this.render(); });
    this.load();
  }

  async load() {
    try {
      const { config } = await (await fetch('/api/output')).json();
      this.config = config;
      this.emit('config', config);
    } catch (e) {
      fill(this.root, el('p', { class: 'error-box' }, 'Server nicht erreichbar: ' + e.message));
      return;
    }
    this.render();
  }

  save(patch) {
    Object.assign(this.config, patch);
    this.emit('config', this.config);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => fetch('/api/output', { method: 'PUT', body: JSON.stringify(this.config) }), 150);
    this.renderHints();
  }

  render(force = false) {
    const c = this.config;
    if (!c) return;
    if (!force && this.root.contains(document.activeElement)) { this.renderHints(); return; }
    const field = (label, input, hint) => el('div', { class: 'row' }, el('label', {}, label, hint ? el('span', { class: 'unit' }, ' ' + hint) : null), input);
    const text = (key, attrs = {}) => el('input', { type: 'text', value: c[key], spellcheck: false, ...attrs, onchange: (e) => this.save({ [key]: e.target.value.trim() }) });
    const number = (key, min, max, step = 1) => el('input', { type: 'number', class: 'num', min, max, step, value: c[key],
      onchange: (e) => this.save({ [key]: Number(e.target.value) }) });
    const check = (key, label) => el('label', { class: 'row row-bool' },
      el('input', { type: 'checkbox', checked: c[key], onchange: (e) => this.save({ [key]: e.target.checked }) }), el('span', {}, label));
    const slider = (key, min, max, step) => {
      const out = el('span', { class: 'num-out' }, String(c[key]));
      return el('div', { class: 'num-wrap' },
        el('input', { type: 'range', min, max, step, value: c[key],
          oninput: (e) => { out.textContent = e.target.value; this.save({ [key]: Number(e.target.value) }); } }),
        out);
    };

    this.statusEl = el('div', { class: 'status-box' });
    this.hintsEl = el('div', { class: 'hints' });
    fill(this.root, 
      this.statusEl,
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn ' + (c.enabled ? 'on' : 'danger'), onclick: () => { this.save({ enabled: !c.enabled }); this.render(true); } },
          c.enabled ? '● Ausgabe aktiv' : '○ Ausgabe aus (Blackout)'),
        el('button', { class: 'btn' + (this.engine.testPattern ? ' on' : ''), title: 'Wanderndes Pixel zum Prüfen von Verkabelung und Ausrichtung',
          onclick: (e) => { this.engine.testPattern = !this.engine.testPattern; e.target.classList.toggle('on', this.engine.testPattern); } }, 'Testbild'),
      ),
      el('h3', {}, 'Ziel'),
      field('Protokoll', el('select', { onchange: (e) => { this.save({ protocol: e.target.value, port: 0 }); this.render(true); } },
        ...[['ddp', 'DDP (empfohlen für WLED)'], ['artnet', 'Art-Net'], ['sacn', 'sACN / E1.31']]
          .map(([v, l]) => el('option', { value: v, selected: v === c.protocol }, l)))),
      field('WLED-IP', text('host', { placeholder: '192.168.1.50' })),
      field('Port', number('port', 0, 65535), '0 = Standard'),
      c.protocol !== 'ddp' ? field('Start-Universe', number('universe', 0, 63999)) : null,
      el('h3', {}, 'Matrix'),
      el('div', { class: 'row-pair' }, field('Breite', number('width', 1, 512)), field('Höhe', number('height', 1, 512))),
      field('Verkabelung', el('select', { onchange: (e) => this.save({ wiring: e.target.value }) },
        el('option', { value: 'rows', selected: c.wiring === 'rows' }, 'Zeilenweise'),
        el('option', { value: 'columns', selected: c.wiring === 'columns' }, 'Spaltenweise'))),
      check('serpentine', 'Zickzack (jede 2. Reihe rückwärts)'),
      check('flipX', 'Horizontal spiegeln (Start rechts)'),
      check('flipY', 'Vertikal spiegeln (Start unten)'),
      el('h3', {}, 'Bild'),
      field('Helligkeit', slider('brightness', 0, 1, 0.01)),
      field('Gamma', slider('gamma', 1, 3.5, 0.05)),
      field('Bilder pro Sekunde', slider('fps', 10, 60, 1)),
      el('h3', {}, 'WLED einrichten'),
      this.hintsEl,
    );
    this.renderStatus();
    this.renderHints();
  }

  renderHints() {
    if (!this.hintsEl || !this.config) return;
    const c = this.config;
    const n = c.width * c.height;
    fill(this.hintsEl, 
      el('p', {}, `WLED → LED-Einstellungen: LED-Anzahl auf ${n} setzen.`),
      ...HINTS[c.protocol](c, n).map((t) => el('p', {}, t)),
      el('p', { class: 'muted' }, 'Zickzack und Spiegeln erledigt dieses Programm. In WLED die 2D-Matrix daher nicht zusätzlich mit Zickzack einstellen, sonst wird doppelt umsortiert.'),
    );
  }

  renderStatus() {
    if (!this.statusEl) return;
    const { link } = this;
    const s = link.stats;
    let state, cls;
    if (!link.connected) { state = 'Keine Verbindung zum Server'; cls = 'bad'; }
    else if (!link.master) { state = 'Ein anderer Tab sendet gerade'; cls = 'warn'; }
    else if (s?.error) { state = s.error; cls = 'bad'; }
    else if (!this.config?.enabled) { state = 'Ausgabe ausgeschaltet'; cls = 'warn'; }
    else { state = `Sendet an ${s?.target || '…'}`; cls = 'ok'; }
    this.statusEl.className = 'status-box ' + cls;
    fill(this.statusEl, 
      el('div', { class: 'status-line' }, el('span', { class: 'dot' }), state),
      s ? el('div', { class: 'muted small' }, `${s.frames} fps · ${s.packets} Pakete/s · ${(s.bytes / 1024).toFixed(1)} KB/s`) : null,
      link.connected && !link.master ? el('button', { class: 'btn btn-xs', onclick: () => link.claim() }, 'Diesen Tab senden lassen') : null,
    );
    this.emit('status', { cls, state, stats: s });
  }
}

export class ProjectPanel {
  constructor(root, { store, media, actions }) {
    this.root = root;
    this.store = store;
    this.media = media;
    this.actions = actions;
    store.on('load', () => this.render());
    store.on('commit', () => this.render());
    media.on('change', () => this.render());
    this.render();
  }

  async render(force = false) {
    if (!force && this.root.contains(document.activeElement)) return;
    const p = this.store.project;
    const commit = () => this.store.commit();
    const field = (label, input) => el('div', { class: 'row' }, el('label', {}, label), input);
    const audioItems = this.media.byKind('audio');
    const importInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true,
      onchange: async (e) => {
        try { this.actions.loadProject(JSON.parse(await e.target.files[0].text())); }
        catch (err) { this.actions.toast('Datei ist kein gültiges Projekt: ' + err.message, 'bad'); }
      } });

    this.listEl = el('div', { class: 'lib-list' });
    fill(this.root, 
      el('h3', {}, 'Projekt'),
      field('Name', el('input', { type: 'text', value: p.name, onchange: (e) => { p.name = e.target.value || 'Projekt'; commit(); } })),
      el('div', { class: 'row-pair' },
        field('Länge (s)', el('input', { type: 'number', class: 'num', min: 1, value: p.duration,
          onchange: (e) => { p.duration = Math.max(1, Number(e.target.value) || 1); commit(); } })),
        field('BPM', el('input', { type: 'number', class: 'num', min: 0, max: 300, step: 0.1, value: p.bpm,
          onchange: (e) => { p.bpm = Math.max(0, Number(e.target.value) || 0); commit(); } }))),
      el('label', { class: 'row row-bool' },
        el('input', { type: 'checkbox', checked: p.loop, onchange: (e) => { p.loop = e.target.checked; commit(); } }),
        el('span', {}, 'Am Ende von vorn beginnen')),
      el('h3', {}, 'Musik'),
      field('Audiodatei', el('select', { onchange: (e) => {
        const m = audioItems.find((a) => a.url === e.target.value);
        this.actions.setAudio(m ? { url: m.url, name: m.name } : null);
      } },
        el('option', { value: '' }, '— keine —'),
        ...audioItems.map((m) => el('option', { value: m.url, selected: p.audio?.url === m.url }, m.name)))),
      el('p', { class: 'muted small' }, 'Die Musik ist die Uhr: Clips laufen exakt synchron zur Audiodatei. Mit BPM rasten Clips auf Beats ein.'),
      el('h3', {}, 'Speichern & Laden'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn on', onclick: () => this.actions.save() }, 'Auf Server speichern'),
        el('button', { class: 'btn', onclick: () => this.actions.newProject() }, 'Neu'),
      ),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn', onclick: () => this.actions.exportProject() }, 'Als JSON exportieren'),
        el('button', { class: 'btn', onclick: () => importInput.click() }, 'JSON importieren'),
        importInput,
      ),
      el('h3', {}, 'Gespeicherte Projekte'),
      this.listEl,
    );

    try {
      const names = await (await fetch('/api/projects')).json();
      this.listEl.replaceChildren(...(names.length ? names.map((n) => el('div', { class: 'proj-item' },
        el('button', { class: 'link', onclick: () => this.actions.openProject(n) }, n),
        el('button', { class: 'icon-btn danger', title: 'Löschen', onclick: async () => {
          if (!confirm(`Projekt „${n}“ löschen?`)) return;
          await fetch('/api/projects/' + encodeURIComponent(n), { method: 'DELETE' });
          this.render(true);
        } }, '✕'),
      )) : [el('p', { class: 'muted small' }, 'Noch keine gespeicherten Projekte.')]));
    } catch { /* Server offline */ }
  }
}
