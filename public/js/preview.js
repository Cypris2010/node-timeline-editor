// Vorschau: zeigt das gerenderte Bild als LED-Punkte (oder als Pixel).

export class Preview {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = 'dots';
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.cw = Math.max(1, r.width);
    this.ch = Math.max(1, r.height);
    this.canvas.width = Math.round(this.cw * dpr);
    this.canvas.height = Math.round(this.ch * dpr);
    this.canvas.style.width = this.cw + 'px';
    this.canvas.style.height = this.ch + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(img) {
    const { ctx, cw, ch } = this;
    const { width: w, height: h, data } = img;
    ctx.clearRect(0, 0, cw, ch);
    const cell = Math.min((cw - 24) / w, (ch - 24) / h);
    if (cell <= 0) return;
    const ox = (cw - cell * w) / 2, oy = (ch - cell * h) / 2;
    ctx.fillStyle = '#050507';
    ctx.fillRect(ox - 6, oy - 6, cell * w + 12, cell * h + 12);
    const r = cell * 0.4;
    const dots = this.mode === 'dots' && cell >= 4;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        const R = data[i], G = data[i + 1], B = data[i + 2];
        // Ausgeschaltete LEDs leicht sichtbar lassen, damit man die Matrix erkennt
        ctx.fillStyle = R + G + B < 24 ? '#16161c' : `rgb(${R},${G},${B})`;
        if (dots) {
          ctx.beginPath();
          ctx.arc(ox + (x + 0.5) * cell, oy + (y + 0.5) * cell, r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(ox + x * cell, oy + y * cell, Math.ceil(cell), Math.ceil(cell));
        }
      }
    }
  }
}
