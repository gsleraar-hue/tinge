'use strict';

// Side-by-side comparison of colouring variants, without the app window.
//   node dev/bench.js <folder with photos> <output folder> [model]
// Uses FFmpeg (from ffmpeg-static) to read and write images and the models
// Tinge has downloaded. Writes one sheet per photo: the variants left to right.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../renderer/color.js');
const models = require('../models');

const FF = require('ffmpeg-static');
const SIZE = 512;
const [inDir, outDir, model = 'natural'] = process.argv.slice(2);
const data = process.env.APPDATA || path.join(os.homedir(), 'Library', 'Application Support');
models.init(path.join(data, 'Tinge', 'models'));
fs.mkdirSync(outDir, { recursive: true });

function ff(args, input) {
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', ...args], { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return r.stdout;
}

function size(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = /, (\d{2,5})x(\d{2,5})[, \[]/.exec(r.stderr);
  return [Number(m[1]), Number(m[2])];
}

function rgba(file, w, h) {
  return new Uint8ClampedArray(ff(['-i', file, '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']));
}

function writeJpg(pixels, w, h, file) {
  ff(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', '-', '-q:v', '2', file], Buffer.from(pixels.buffer));
}

// The variants to compare. Each gets the model input and returns a grid for colorize().
const VARIANTS = {
  'aspect+tame': async (px, cache) => {
    const g = cache.grid;
    const ab = C.tame((await cache.aspectAb('natural')).slice(), g);
    return C.guide(ab, C.greyGrid(cache.apx, g), g);
  },
  // In the photo's own proportions (grid from gridFor), contrast stretched, edge-guided.
  aspect: async (px, cache) => {
    const g = cache.grid;
    return C.guide(await models.run(model, C.stretch(C.toModelInput(cache.apx, g), g), g), C.greyGrid(cache.apx, g), g);
  },
  'aspect+flip': async (px, cache) => {
    const g = cache.grid;
    const input = C.stretch(C.toModelInput(cache.apx, g), g);
    const a = await models.run(model, input, g);
    const b = C.flip(await models.run(model, C.flip(input, g), g), g);
    const avg = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) avg[i] = (a[i] + b[i]) / 2;
    return C.guide(avg, C.greyGrid(cache.apx, g), g);
  },
  current: async (px) => models.run(model, C.toModelInput(px, SIZE), SIZE),
  guided: async (px, cache) => C.guide(await cache.plain(), C.greyGrid(px, SIZE), SIZE),
  'guided+stretch': async (px) => C.guide(await models.run(model, C.stretch(C.toModelInput(px, SIZE), SIZE), SIZE), C.greyGrid(px, SIZE), SIZE),
  'guided+flip': async (px, cache) => {
    const a = await cache.plain();
    const b = C.flip(await models.run(model, C.flip(C.toModelInput(px, SIZE), SIZE), SIZE), SIZE);
    const avg = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) avg[i] = (a[i] + b[i]) / 2;
    return C.guide(avg, C.greyGrid(px, SIZE), SIZE);
  },
};

(async () => {
  const only = process.env.VARIANTS ? process.env.VARIANTS.split(',') : Object.keys(VARIANTS);
  for (const name of fs.readdirSync(inDir).filter((n) => /\.(jpe?g|png)$/i.test(n))) {
    const file = path.join(inDir, name);
    const [w0, h0] = size(file);
    const s = Math.min(1, 1200 / Math.max(w0, h0));
    const w = Math.round(w0 * s);
    const h = Math.round(h0 * s);
    const full = rgba(file, w, h);
    const px = rgba(file, SIZE, SIZE);
    let plain = null;
    const grid = C.gridFor(w0, h0);
    const abs = {};
    const aspectAb = (m) => (abs[m] = abs[m] || models.run(m, C.stretch(C.toModelInput(cache.apx, grid), grid), grid).then((x) => x.slice()));
    const cache = { aspectAb, plain: () => (plain = plain || models.run(model, C.toModelInput(px, SIZE), SIZE)), grid, apx: rgba(file, grid[0], grid[1]) };
    const parts = [];
    for (const v of only) {
      const t0 = Date.now();
      const grid = await VARIANTS[v](px, cache);
      const out = C.colorize(full, w, h, grid, v.startsWith('aspect') ? cache.grid : SIZE, {});
      const part = path.join(outDir, `${path.parse(name).name}--${v}.jpg`);
      writeJpg(out, w, h, part);
      parts.push(part);
      console.log(name, v, Date.now() - t0, 'ms');
    }
    // One sheet: the variants next to each other, each 600 px wide.
    const inputs = parts.flatMap((p) => ['-i', p]);
    const filter = parts.map((_, i) => `[${i}:v]scale=600:-2[v${i}]`).join(';') + ';' + parts.map((_, i) => `[v${i}]`).join('') + `hstack=inputs=${parts.length}`;
    ff(['-y', ...inputs, '-filter_complex', filter, '-q:v', '3', path.join(outDir, `${path.parse(name).name}--sheet.jpg`)]);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
