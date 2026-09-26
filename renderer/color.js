'use strict';

// Colour maths for Tinge. DDColor is fed a grey SxS image and returns only the
// a and b channels (CIELAB). The lightness (L) always comes from the original
// photo at full resolution, so every bit of detail and sharpness survives; the
// model only supplies "the paint".
//
// Runs in the renderer (window.TingeColor) and in Node (require) for the tests.

(function (root) {
  // sRGB 0..255 -> linear 0..1
  const TO_LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  // linear 0..1 -> sRGB 0..255, as a table with 4096 steps
  const GAMMA_STEPS = 4096;
  const TO_SRGB = new Uint8ClampedArray(GAMMA_STEPS + 1);
  for (let i = 0; i <= GAMMA_STEPS; i++) {
    const c = i / GAMMA_STEPS;
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    TO_SRGB[i] = Math.round(s * 255);
  }

  // D65 white point
  const XN = 0.95047;
  const ZN = 1.08883;
  const EPS = 216 / 24389;
  const KAPPA = 24389 / 27;

  function f(t) {
    return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
  }

  function finv(t) {
    const t3 = t * t * t;
    return t3 > EPS ? t3 : (116 * t - 16) / KAPPA;
  }

  function encode(lin) {
    if (lin <= 0) return 0;
    if (lin >= 1) return 255;
    return TO_SRGB[(lin * GAMMA_STEPS + 0.5) | 0];
  }

  // Just L (0..100) of an sRGB pixel. L depends on Y alone.
  function lightness(r, g, b) {
    const y = 0.2126729 * TO_LIN[r] + 0.7151522 * TO_LIN[g] + 0.072175 * TO_LIN[b];
    return 116 * f(y) - 16;
  }

  function rgbToLab(r, g, b) {
    const R = TO_LIN[r];
    const G = TO_LIN[g];
    const B = TO_LIN[b];
    const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / XN;
    const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
    const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / ZN;
    const fx = f(x);
    const fy = f(y);
    const fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  // Writes the sRGB values of (L, a, b) into out[o..o+2].
  function labToRgbInto(L, a, b, out, o) {
    const fy = (L + 16) / 116;
    const x = finv(fy + a / 500) * XN;
    const y = finv(fy);
    const z = finv(fy - b / 200) * ZN;
    out[o] = encode(3.2404542 * x - 1.5371385 * y - 0.4985314 * z);
    out[o + 1] = encode(-0.969266 * x + 1.8760108 * y + 0.041556 * z);
    out[o + 2] = encode(0.0556434 * x - 0.2040259 * y + 1.0572252 * z);
  }

  // RGBA pixels of SxS -> model input [1,3,S,S], grey from 0..1. Same grey
  // weighting as OpenCV, which DDColor was trained with.
  function toModelInput(rgba, size) {
    const n = size * size;
    const out = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const g = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255;
      out[i] = g;
      out[n + i] = g;
      out[2 * n + i] = g;
    }
    return out;
  }

  // Colours an RGBA image (w x h) using the model's ab grid (S x S).
  // opts.saturation: 0..2 (1 = as the model sees it)
  // opts.warmth: -1..1 (shifts towards yellow/red or blue)
  // The result goes into `out` (may be the same array as `src`).
  function colorize(src, w, h, ab, size, opts, out) {
    const sat = opts && opts.saturation != null ? opts.saturation : 1;
    const warm = opts && opts.warmth ? opts.warmth : 0;
    const shiftA = warm * 3;
    const shiftB = warm * 12;
    const n = size * size;
    const sx = size / w;
    const sy = size / h;
    const max = size - 1;
    out = out || new Uint8ClampedArray(w * h * 4);

    // Horizontal interpolation weights, worked out once per column.
    const x0s = new Int32Array(w);
    const x1s = new Int32Array(w);
    const fxs = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let u = (x + 0.5) * sx - 0.5;
      if (u < 0) u = 0;
      if (u > max) u = max;
      const x0 = u | 0;
      x0s[x] = x0;
      x1s[x] = x0 < max ? x0 + 1 : x0;
      fxs[x] = u - x0;
    }

    for (let y = 0; y < h; y++) {
      let v = (y + 0.5) * sy - 0.5;
      if (v < 0) v = 0;
      if (v > max) v = max;
      const y0 = v | 0;
      const y1 = y0 < max ? y0 + 1 : y0;
      const fy = v - y0;
      const r0 = y0 * size;
      const r1 = y1 * size;

      for (let x = 0; x < w; x++) {
        const x0 = x0s[x];
        const x1 = x1s[x];
        const fx = fxs[x];
        const i00 = r0 + x0;
        const i01 = r0 + x1;
        const i10 = r1 + x0;
        const i11 = r1 + x1;

        const aTop = ab[i00] + (ab[i01] - ab[i00]) * fx;
        const aBot = ab[i10] + (ab[i11] - ab[i10]) * fx;
        const bTop = ab[n + i00] + (ab[n + i01] - ab[n + i00]) * fx;
        const bBot = ab[n + i10] + (ab[n + i11] - ab[n + i10]) * fx;

        const p = (y * w + x) * 4;
        const L = lightness(src[p], src[p + 1], src[p + 2]);
        // Colour fades out in the deepest shadows and brightest highlights, so
        // black and white do not pick up a coloured haze.
        const edge = L < 8 ? L / 8 : L > 96 ? (100 - L) / 4 : 1;
        const k = sat * (edge < 0 ? 0 : edge);
        const a = (aTop + (aBot - aTop) * fy) * k + shiftA * edge;
        const b = (bTop + (bBot - bTop) * fy) * k + shiftB * edge;

        labToRgbInto(L, a, b, out, p);
        out[p + 3] = src[p + 3];
      }
    }
    return out;
  }

  const api = { lightness, rgbToLab, labToRgbInto, toModelInput, colorize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TingeColor = api;
})(typeof self !== 'undefined' ? self : this);
