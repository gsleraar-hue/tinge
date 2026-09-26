'use strict';

// Draws the Tinge icon (a round window: grey on the left, colour on the right)
// and writes build/icon.ico, build/icon.png and build/icon.icns. All by hand:
// a PNG encoder on top of zlib with ICO and ICNS containers around it, so no
// extra packages are needed on any platform.
// Run with: npm run icon

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUB = 4; // 4x4 subsamples per pixel for smooth edges

// ---------------------------------------------------------------- drawing

function sdRoundedBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function lerp(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return a.map((v, i) => v + (b[i] - v) * k);
}

// The brand gradient: gold -> orange -> rose -> blue
const STOPS = [[240, 194, 106], [233, 136, 92], [196, 90, 122], [107, 143, 214]];
function grad(t) {
  const s = Math.min(Math.max(t, 0), 0.9999) * (STOPS.length - 1);
  const i = Math.floor(s);
  return lerp(STOPS[i], STOPS[i + 1], s - i);
}

function color(px, py) {
  if (sdRoundedBox(px, py, 0.5, 0.5, 0.5, 0.5, 0.215) > 0) return null;
  const d = Math.hypot(px - 0.5, py - 0.5);
  if (d > 0.3) return lerp([36, 38, 43], [20, 21, 24], py);
  if (px < 0.5) {
    const g = 70 + 120 * (1 - py);
    return [g, g, g];
  }
  return grad(((px - 0.5) / 0.3) * 0.35 + py * 0.65);
}

// `pad` shrinks the tile inside the canvas: macOS icons leave a margin
// around the rounded square (Apple's grid puts it at about 10%).
function render(size, pad = 0) {
  const rgba = Buffer.alloc(size * size * 4);
  const inner = 1 - 2 * pad;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const u = ((x + (sx + 0.5) / SUB) / size - pad) / inner;
          const v = ((y + (sy + 0.5) / SUB) / size - pad) / inner;
          const c = u < 0 || u > 1 || v < 0 || v > 1 ? null : color(u, v);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      if (!a) continue;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / a);
      rgba[i + 1] = Math.round(g / a);
      rgba[i + 2] = Math.round(b / a);
      rgba[i + 3] = Math.round((a / (SUB * SUB)) * 255);
    }
  }
  return rgba;
}

// ---------------------------------------------------------------- png

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ico (Windows)

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;

  images.forEach((img, i) => {
    const e = 16 * i;
    entries[e] = img.size >= 256 ? 0 : img.size; // 0 means 256
    entries[e + 1] = img.size >= 256 ? 0 : img.size;
    entries.writeUInt16LE(1, e + 4); // colour planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(img.png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.png)]);
}

// ---------------------------------------------------------------- icns (macOS)
//
// An .icns is a box of images like an .ico, laid out differently: four
// letters as the type, then the length, then a PNG.

const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32], // 16 on a double-density screen
  ['ic12', 64], // 32 likewise
  ['ic07', 128],
  ['ic13', 256], // 128 likewise
  ['ic08', 256],
  ['ic14', 512], // 256 likewise
  ['ic09', 512],
  ['ic10', 1024], // 512 likewise
];

function buildIcns(pngOf) {
  const parts = [];
  for (const [kind, size] of ICNS_TYPES) {
    const png = pngOf(size);
    const head = Buffer.alloc(8);
    head.write(kind, 0, 4, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    parts.push(head, png);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------- writing

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const icoImages = ICO_SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }));
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(icoImages));

const macPngs = new Map();
const macPng = (size) => {
  if (!macPngs.has(size)) macPngs.set(size, encodePng(size, render(size, 0.1)));
  return macPngs.get(size);
};
fs.writeFileSync(path.join(outDir, 'icon.icns'), buildIcns(macPng));
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePng(512, render(512)));

console.log('wrote build/icon.ico, build/icon.icns and build/icon.png');
