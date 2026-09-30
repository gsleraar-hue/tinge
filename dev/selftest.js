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

check('grids keep the photo proportions, in steps of 32', () => {
  const [w, h] = C.gridFor(3000, 2000);
  assert(w % 32 === 0 && h % 32 === 0, `${w}x${h}`);
  assert(Math.abs(w / h - 1.5) < 0.1, `${w}x${h}`);
  assert(Math.abs(w * h - 512 * 512) < 0.15 * 512 * 512, `${w}x${h}`);
});

check('contrast stretch spreads a faded input to the full range', () => {
  const n = 32 * 32;
  const input = new Float32Array(3 * n).map((_, i) => 0.3 + 0.3 * ((i % n) / n));
  C.stretch(input, 32);
  let lo = 1;
  let hi = 0;
  for (const v of input) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  assert(lo < 0.02 && hi > 0.98, `${lo}..${hi}`);
});

check('purple is toned down; red, blue and skin are not', () => {
  // four pixels: purple, red, blue, skin (a values first, then b values)
  const ab = new Float32Array([40, 40, 0, 20, -40, 0, -40, 25]);
  const g = [4, 1];
  C.tame(ab, g);
  assert(Math.hypot(ab[0], ab[4]) < 0.5 * Math.hypot(40, 40), 'purple toned down');
  assert(ab[1] === 40 && ab[5] === 0, 'red untouched');
  assert(ab[2] === 0 && ab[6] === -40, 'blue untouched');
  assert(ab[3] === 20 && ab[7] === 25, 'skin untouched');
});

check('guided colour stops at an edge instead of bleeding across it', () => {
  // Left half dark, right half light; the model's colour is a soft ramp.
  const size = 32;
  const n = size * size;
  const grey = new Float32Array(n).map((_, i) => (i % size < 16 ? 0.2 : 0.8));
  const ab = new Float32Array(2 * n).map((_, i) => (i < n ? ((i % size) / size) * 60 : 0));
  const { A, B } = C.guide(ab, grey, size);
  const at = (x) => A[8 * size + x] * grey[8 * size + x] + B[8 * size + x];
  const jump = at(16) - at(15);
  const plain = ab[8 * size + 16] - ab[8 * size + 15];
  assert(jump > 3 * plain, `edge jump ${jump.toFixed(1)} vs ${plain.toFixed(1)}`);
});

// ---------------------------------------------------------------- video

const VC = require('../videocolor.js');

check('video: zero chroma gives neutral U and V planes', () => {
  const W = 16;
  const H = 8;
  const size = 4;
  const Y = new Uint8Array(W * H).map((_, i) => 16 + (i % 200));
  const U = new Uint8Array((W / 2) * (H / 2));
  const V = new Uint8Array(U.length);
  VC.chroma(Y, W, H, new Float32Array(2 * size * size), size, {}, U, V);
  for (let i = 0; i < U.length; i++) assert(Math.abs(U[i] - 128) <= 1 && Math.abs(V[i] - 128) <= 1, `${U[i]},${V[i]}`);
});

check('video: red in the model gives red chroma (V above U)', () => {
  const size = 4;
  const ab = new Float32Array(2 * size * size).fill(40, 0, size * size);
  const Y = new Uint8Array(8 * 8).fill(120);
  const U = new Uint8Array(16);
  const V = new Uint8Array(16);
  VC.chroma(Y, 8, 8, ab, size, {}, U, V);
  assert(V[0] > 150 && V[0] - 128 > 4 * (U[0] - 128), `U ${U[0]} V ${V[0]}`);
});

check('video: still areas blend, moved areas follow the matching keyframe', () => {
  const n = 4;
  const abA = new Float32Array(2 * n).fill(0);
  const abB = new Float32Array(2 * n).fill(30);
  const greyA = new Float32Array([0.5, 0.5, 0.2, 0.2]);
  const greyB = new Float32Array([0.5, 0.5, 0.8, 0.8]);
  // pixels 0-1 are still; pixel 2 looks like B, pixel 3 like A
  const grey = new Float32Array([0.5, 0.5, 0.8, 0.2]);
  const out = VC.between(abA, abB, greyA, greyB, grey, 0.25);
  assert(Math.abs(out[0] - 7.5) < 1e-4, 'still: plain blend');
  assert(out[2] > 29, 'moved, looks like B: B colour');
  assert(out[3] < 1, 'moved, looks like A: A colour');
});

check('video: scene cuts are found, grain is not a cut', () => {
  const W = 128;
  const H = 72;
  const dark = new Uint8Array(W * H).fill(40);
  const light = new Uint8Array(W * H).fill(200);
  const grainy = dark.map((v, i) => v + ((i * 7919) % 9) - 4);
  const a = VC.signature(dark, W, H);
  assert(VC.isCut(a, VC.signature(light, W, H)), 'dark -> light is a cut');
  assert(!VC.isCut(a, VC.signature(grainy, W, H)), 'grain is not a cut');
});

console.log(`\n${passed} checks passed`);
