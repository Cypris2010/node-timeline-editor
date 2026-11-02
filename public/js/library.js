// Bibliothek (linke Spalte): Bausteine und hochgeladene Medien, per Klick oder Drag & Drop in die Zeitleiste.
import { CLIP_TYPES, CATEGORIES } from './clips.js';
import { el, Emitter } from './util.js';

export class MediaLibrary extends Emitter {
  constructor() {
    super();
    this.items = [];
  }

  async refresh() {
    try {
      this.items = await (await fetch('/api/media')).json();
    } catch {
      this.items = [];
    }
    this.emit('change');
  }

  async upload(file) {
    const res = await fetch('/api/media?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload fehlgeschlagen');
    await this.refresh();
    return data;
  }

  byKind(kind) { return this.items.filter((m) => m.kind === kind); }
}

const KIND_ICON = { video: '🎞', image: '🖼', audio: '♪' };

export class Library {
  constructor(root, { media, actions }) {
    this.root = root;
    this.media = media;
    this.actions = actions;
    media.on('change', () => this.render());
    root.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); root.classList.add('drop'); }
    });
    root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('drop'); });
    root.addEventListener('drop', (e) => {
      root.classList.remove('drop');
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      actions.uploadFiles([...e.dataTransfer.files]);
    });
    this.render();
  }

  item({ icon, label, color, title, payload, onclick }) {
    return el('div', {
      class: 'lib-item', draggable: true, title, style: { '--c': color },
      onclick,
      ondragstart: (e) => {
        e.dataTransfer.setData('application/x-led-clip', JSON.stringify(payload));
        e.dataTransfer.effectAllowed = 'copy';
      },
    }, el('span', { class: 'lib-icon' }, icon), el('span', { class: 'lib-label' }, label));
  }

  render() {
    const groups = {};
    for (const [type, def] of Object.entries(CLIP_TYPES)) {
      if (def.category === 'media') continue;
      (groups[def.category] ||= []).push(this.item({
        icon: def.icon, label: def.label, color: CATEGORIES[def.category].color,
        title: 'Klicken: am Abspielkopf einfügen · Ziehen: auf eine Spur legen',
        payload: { type },
        onclick: () => this.actions.addClip(type),
      }));
    }

    const fileInput = el('input', {
      type: 'file', multiple: true, hidden: true, accept: 'video/*,image/*,audio/*',
      onchange: (e) => { this.actions.uploadFiles([...e.target.files]); e.target.value = ''; },
    });
    const mediaItems = this.media.items.map((m) => {
      const color = m.kind === 'audio' ? CATEGORIES.audio.color : CATEGORIES.media.color;
      if (m.kind === 'audio') {
        return this.item({
          icon: KIND_ICON.audio, label: m.name, color, title: 'Klicken oder auf die Audiospur ziehen: als Musik verwenden',
          payload: { audio: { url: m.url, name: m.name } },
          onclick: () => this.actions.setAudio({ url: m.url, name: m.name }),
        });
      }
      const type = m.kind === 'video' ? 'video' : 'image';
      return this.item({
        icon: KIND_ICON[m.kind], label: m.name, color, title: m.name,
        payload: { type, extra: { name: m.name, params: { src: m.url } } },
        onclick: () => this.actions.addClip(type, { name: m.name, params: { src: m.url } }),
      });
    });

    this.root.replaceChildren(
      ...Object.entries(groups).map(([cat, items]) => el('section', {},
        el('h3', {}, CATEGORIES[cat].label), el('div', { class: 'lib-grid' }, ...items))),
      el('section', {},
        el('h3', {}, 'Medien', el('button', { class: 'btn btn-xs', onclick: () => fileInput.click() }, '＋ Hochladen')),
        fileInput,
        mediaItems.length
          ? el('div', { class: 'lib-list' }, ...mediaItems)
          : el('p', { class: 'muted small drop-hint' }, 'Videos, Bilder oder Musik hierher ziehen.'),
      ),
    );
  }
}
