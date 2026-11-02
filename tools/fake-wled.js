// Simulierter WLED-Empfänger zum Testen ohne Hardware.
// Lauscht auf DDP (4048), Art-Net (6454) und sACN (5568) und zeigt die Matrix im Terminal.
//
//   node tools/fake-wled.js [breite] [höhe] [--no-serpentine] [--universe=1] [--quiet]
//
// In der Oberfläche als Ziel-IP 127.0.0.1 eintragen.
import dgram from 'node:dgram';

const args = process.argv.slice(2);
const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
const W = nums[0] || 32;
const H = nums[1] || 16;
const SERPENTINE = !args.includes('--no-serpentine');
const QUIET = args.includes('--quiet');
const START_UNI = Number((args.find((a) => a.startsWith('--universe=')) || '=1').split('=')[1]);

const frame = Buffer.alloc(W * H * 3);
const stats = { ddp: 0, artnet: 0, sacn: 0, frames: 0 };
let lastProto = '-';

function listen(port, name, handle) {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('message', (msg) => { stats[name]++; lastProto = name; handle(msg); });
  s.on('error', (e) => console.error(`${name}: ${e.message}`));
  s.bind(port);
}

listen(4048, 'ddp', (m) => {
  if (m.length < 10) return;
  const off = m.readUInt32BE(4);
  const len = m.readUInt16BE(8);
  m.copy(frame, off, 10, 10 + Math.min(len, frame.length - off));
  if (m[0] & 0x01) stats.frames++;
});
listen(6454, 'artnet', (m) => {
  if (m.toString('ascii', 0, 7) !== 'Art-Net' || m.readUInt16LE(8) !== 0x5000) return;
  const uni = m[14] | (m[15] << 8);
  const len = m.readUInt16BE(16);
  const off = (uni - START_UNI) * 510;
  if (off >= 0 && off < frame.length) m.copy(frame, off, 18, 18 + Math.min(len, 510, frame.length - off));
  if (uni === START_UNI) stats.frames++;
});
listen(5568, 'sacn', (m) => {
  if (m.length < 126) return;
  const uni = m.readUInt16BE(113);
  const count = m.readUInt16BE(123) - 1;
  const off = (uni - START_UNI) * 510;
  if (off >= 0 && off < frame.length) m.copy(frame, off, 126, 126 + Math.min(count, 510, frame.length - off));
  if (uni === START_UNI) stats.frames++;
});

const px = (x, y) => {
  const i = (SERPENTINE && y % 2 ? y * W + (W - 1 - x) : y * W + x) * 3;
  return [frame[i], frame[i + 1], frame[i + 2]];
};

function matrix() {
  let out = '';
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px(x, y);
      const [r2, g2, b2] = y + 1 < H ? px(x, y + 1) : [0, 0, 0];
      out += `\x1b[38;2;${r};${g};${b}m\x1b[48;2;${r2};${g2};${b2}m▀`;
    }
    out += '\x1b[0m\n';
  }
  return out;
}

let shown = { ...stats };
setInterval(() => {
  const fps = stats.frames - shown.frames;
  const pk = (k) => stats[k] - shown[k];
  const info = `${lastProto.toUpperCase()}  ${fps} fps  |  Pakete/s  DDP ${pk('ddp')}  Art-Net ${pk('artnet')}  sACN ${pk('sacn')}`;
  shown = { ...stats };
  if (QUIET) return console.log(info);
  process.stdout.write('\x1b[H\x1b[2J' + `Fake-WLED ${W}×${H}${SERPENTINE ? ' (Zickzack)' : ''}\n${info}\n\n` + matrix());
}, 1000);

// Zwischen den Statuszeilen das Bild flüssiger aktualisieren
if (!QUIET) setInterval(() => process.stdout.write('\x1b[4;1H' + matrix()), 100);

console.log(`Fake-WLED lauscht: DDP :4048, Art-Net :6454, sACN :5568 (${W}×${H})`);
