// Renders the extension icon into static/icons/icon-{16,32,48,128}.png.
// Dependency-free: rounded rectangles rasterised with supersampling, PNG encoded by hand.
// Run with `node scripts/make-icons.mjs` after changing the design; the PNGs are committed.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const SAMPLES = 8; // per axis

// Catppuccin Mocha (https://catppuccin.com/palette/).
const BASE = [0x1e, 0x1e, 0x2e];
const MAUVE = [0xcb, 0xa6, 0xf7];
const PEACH = [0xfa, 0xb3, 0x87];
const GREEN = [0xa6, 0xe3, 0xa1];

// Design on a 128-unit canvas, painted in order: [x0, y0, x1, y1, radius, colour].
// A dark tile; the focused group is expanded (wide block), the others collapsed (short pills).
const SHAPES = [
  [0, 0, 128, 128, 26, BASE],
  [18, 18, 110, 68, 12, MAUVE],
  [18, 80, 72, 96, 8, PEACH],
  [18, 104, 72, 120, 8, GREEN],
];

function inRoundedRect(x, y, [x0, y0, x1, y1, r]) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}

function render(size) {
  const px = new Uint8Array(size * size * 4);
  const scale = 128 / size;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (pxl + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          let hit = null;
          for (const s of SHAPES) if (inRoundedRect(x, y, s)) hit = s[5];
          if (hit) { r += hit[0]; g += hit[1]; b += hit[2]; a++; }
        }
      }
      const i = (py * size + pxl) * 4;
      if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; }
      px[i + 3] = Math.round((a / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir('static/icons', { recursive: true });
for (const size of SIZES) {
  await writeFile(`static/icons/icon-${size}.png`, encodePng(size, render(size)));
}
console.log(`wrote static/icons/icon-{${SIZES.join(',')}}.png`);
