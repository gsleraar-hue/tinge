'use strict';

// Checks the colour maths without a model or a screen: run with npm test.
// (The full pipeline, model included, is tested by starting the app with
// TINGE_SELFTEST="in.jpg|out.jpg" - see the README.)

const assert = require('assert');
const C = require('../renderer/color.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('ok  ' + name);
}

check('sRGB -> Lab -> sRGB round trip stays within 1 step', () => {
  const out = new Uint8ClampedArray(3);
  for (let i = 0; i < 20000; i++) {
    const r = (Math.random() * 256) | 0;
    const g = (Math.random() * 256) | 0;
    const b = (Math.random() * 256) | 0;
    const [L, A, B] = C.rgbToLab(r, g, b);
    C.labToRgbInto(L, A, B, out, 0);
    assert(Math.abs(out[0] - r) <= 1 && Math.abs(out[1] - g) <= 1 && Math.abs(out[2] - b) <= 1, `${r},${g},${b} -> ${[...out]}`);
  }
});

check('lightness() matches the L of rgbToLab()', () => {
  for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [128, 64, 200], [12, 250, 90]]) {
    assert(Math.abs(C.lightness(r, g, b) - C.rgbToLab(r, g, b)[0]) < 1e-3);
  }
});

check('model input is grey, three equal channels, 0..1', () => {
  const size = 4;
  const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
  rgba[0] = 0;
  const x = C.toModelInput(rgba, size);
  assert.strictEqual(x.length, 3 * size * size);
  const n = size * size;
  for (let i = 0; i < n; i++) {
    assert(x[i] >= 0 && x[i] <= 1);
    assert.strictEqual(x[i], x[n + i]);
    assert.strictEqual(x[i], x[2 * n + i]);
  }
});

check('zero chroma leaves a grey photo grey, with its tones intact', () => {
  const w = 7;
  const h = 5;
  const size = 8;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) src.set([i * 7, i * 7, i * 7, 255], i * 4);
  const out = C.colorize(src, w, h, new Float32Array(2 * size * size), size, {});
  for (let i = 0; i < w * h * 4; i += 4) {
    assert(Math.abs(out[i] - src[i]) <= 1 && out[i] === out[i + 1] && out[i + 1] === out[i + 2]);
  }
});

check('colour follows the model, and strength 0 removes it again', () => {
  const size = 4;
  const ab = new Float32Array(2 * size * size);
  ab.fill(40, 0, size * size); // a: towards red
  const src = new Uint8ClampedArray(4 * 4 * 4).fill(128);
  const red = C.colorize(src, 4, 4, ab, size, { saturation: 1 });
  assert(red[0] > red[1] + 20, 'expected a reddish pixel');
  const none = C.colorize(src, 4, 4, ab, size, { saturation: 0 });
  assert(none[0] === none[1] && none[1] === none[2], 'expected grey');
});

console.log(`\n${passed} checks passed`);
