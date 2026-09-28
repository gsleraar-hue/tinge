'use strict';

// Per-frame colour maths for video. Frames travel as yuv420p: a full-size
// luma plane (Y) and two quarter-size chroma planes (U, V). A black-and-white
// film lives entirely in Y, so Tinge passes Y through untouched (every grain of
// the original survives) and only writes new U and V planes from the model's
// a/b colour channels. That is also four times less work than full RGB.

const C = require('./renderer/color.js');

// Studio-range luma (16..235) -> full-range grey (0..255)
function toFull(y) {
  const v = ((y - 16) * 255) / 219;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Lightness per studio-range luma value, as a lookup table.
const L_OF_Y = new Float32Array(256);
for (let y = 0; y < 256; y++) {
  const g = Math.round(toFull(y));
  L_OF_Y[y] = C.lightness(g, g, g);
}

// Box-averages the Y plane (W x H) down to tw x th, in full-range grey.
function downsample(Y, W, H, tw, th) {
  const out = new Float32Array(tw * th);
  const xs = new Int32Array(tw + 1);
  const ys = new Int32Array(th + 1);
  for (let i = 0; i <= tw; i++) xs[i] = Math.min(W, Math.round((i * W) / tw));
  for (let i = 0; i <= th; i++) ys[i] = Math.min(H, Math.round((i * H) / th));
  for (let ty = 0; ty < th; ty++) {
    const y0 = ys[ty];
    const y1 = Math.max(ys[ty + 1], y0 + 1);
    for (let tx = 0; tx < tw; tx++) {
      const x0 = xs[tx];
      const x1 = Math.max(xs[tx + 1], x0 + 1);
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * W;
        for (let x = x0; x < x1; x++) sum += Y[row + x];
      }
      out[ty * tw + tx] = toFull(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return out;
}

// Y plane -> model input [1,3,S,S], grey 0..1 in all three channels.
function modelInput(Y, W, H, size) {
  const grey = downsample(Y, W, H, size, size);
  const n = size * size;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const g = grey[i] / 255;
    out[i] = g;
    out[n + i] = g;
    out[2 * n + i] = g;
  }
  return out;
}

// A small grey thumbnail plus a histogram, used to spot scene cuts.
const THUMB_W = 64;
const THUMB_H = 36;
const BINS = 32;

function signature(Y, W, H) {
  const thumb = downsample(Y, W, H, THUMB_W, THUMB_H);
  const hist = new Float32Array(BINS);
  for (let i = 0; i < thumb.length; i++) hist[Math.min(BINS - 1, (thumb[i] / 256) * BINS) | 0]++;
  for (let i = 0; i < BINS; i++) hist[i] /= thumb.length;
  return { thumb, hist };
}

// True when frame b starts a new shot after frame a. Both the picture and its
// tone distribution have to jump: a flash or a fast pan alone changes only one.
function isCut(a, b) {
  if (!a || !b) return true;
  let diff = 0;
  for (let i = 0; i < a.thumb.length; i++) diff += Math.abs(a.thumb[i] - b.thumb[i]);
  diff /= a.thumb.length;
  let hist = 0;
  for (let i = 0; i < BINS; i++) hist += Math.abs(a.hist[i] - b.hist[i]);
  return diff > 22 && hist > 0.35;
}

// Writes the U and V planes (each W/2 x H/2) for one frame.
// ab: the model's output (2 x S x S), opts: { saturation, warmth } as for photos.
function chroma(Y, W, H, ab, size, opts, U, V) {
  const sat = opts && opts.saturation != null ? opts.saturation : 1;
  const warm = opts && opts.warmth ? opts.warmth : 0;
  const shiftA = warm * 3;
  const shiftB = warm * 12;
  const cw = W >> 1;
  const ch = H >> 1;
  const n = size * size;
  const max = size - 1;
  const rgb = new Uint8ClampedArray(3);

  const x0s = new Int32Array(cw);
  const x1s = new Int32Array(cw);
  const fxs = new Float32Array(cw);
  for (let x = 0; x < cw; x++) {
    let u = ((x + 0.5) * size) / cw - 0.5;
    if (u < 0) u = 0;
    if (u > max) u = max;
    const x0 = u | 0;
    x0s[x] = x0;
    x1s[x] = x0 < max ? x0 + 1 : x0;
    fxs[x] = u - x0;
  }

  for (let y = 0; y < ch; y++) {
    let v = ((y + 0.5) * size) / ch - 0.5;
    if (v < 0) v = 0;
    if (v > max) v = max;
    const y0 = v | 0;
    const y1 = y0 < max ? y0 + 1 : y0;
    const fy = v - y0;
    const r0 = y0 * size;
    const r1 = y1 * size;
    const lumaTop = 2 * y * W;
    const lumaBot = lumaTop + W;

    for (let x = 0; x < cw; x++) {
      const i00 = r0 + x0s[x];
      const i01 = r0 + x1s[x];
      const i10 = r1 + x0s[x];
      const i11 = r1 + x1s[x];
      const fx = fxs[x];
      const aTop = ab[i00] + (ab[i01] - ab[i00]) * fx;
      const aBot = ab[i10] + (ab[i11] - ab[i10]) * fx;
      const bTop = ab[n + i00] + (ab[n + i01] - ab[n + i00]) * fx;
      const bBot = ab[n + i10] + (ab[n + i11] - ab[n + i10]) * fx;

      const lx = 2 * x;
      const yAvg = (Y[lumaTop + lx] + Y[lumaTop + lx + 1] + Y[lumaBot + lx] + Y[lumaBot + lx + 1] + 2) >> 2;
      const L = L_OF_Y[yAvg];
      const edge = L < 8 ? L / 8 : L > 96 ? (100 - L) / 4 : 1;
      const k = sat * (edge < 0 ? 0 : edge);
      const a = (aTop + (aBot - aTop) * fy) * k + shiftA * edge;
      const b = (bTop + (bBot - bTop) * fy) * k + shiftB * edge;
      C.labToRgbInto(L, a, b, rgb, 0);

      // BT.709, studio range
      const R = rgb[0];
      const G = rgb[1];
      const B = rgb[2];
      const luma = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const cb = 128 + ((B - luma) / 1.8556) * (224 / 255);
      const cr = 128 + ((R - luma) / 1.5748) * (224 / 255);
      const o = y * cw + x;
      U[o] = cb < 16 ? 16 : cb > 240 ? 240 : cb + 0.5;
      V[o] = cr < 16 ? 16 : cr > 240 ? 240 : cr + 0.5;
    }
  }
}

// Share of the thumbnail that changed noticeably between two frames: a
// measure of motion. Grain and flicker stay under the threshold.
function motion(a, b) {
  if (!a || !b) return 1;
  let changed = 0;
  for (let i = 0; i < a.thumb.length; i++) if (Math.abs(a.thumb[i] - b.thumb[i]) > 14) changed++;
  return changed / a.thumb.length;
}

// Flicker smoothing that does not smear moving things. Where the picture stayed
// put, the new colour is eased in by `alpha`; where it changed (a car driving
// past), the model's fresh colour is taken as is, so no colour trails behind.
// grey/lastGrey are the model inputs (S x S, 0..1) of both keyframes.
function smooth(lastAb, raw, lastGrey, grey, alpha, out) {
  const n = grey.length;
  out = out || new Float32Array(raw.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(grey[i] - lastGrey[i]);
    const moved = d <= 0.03 ? 0 : d >= 0.11 ? 1 : (d - 0.03) / 0.08;
    const k = alpha + (1 - alpha) * moved;
    out[i] = lastAb[i] + (raw[i] - lastAb[i]) * k;
    out[n + i] = lastAb[n + i] + (raw[n + i] - lastAb[n + i]) * k;
  }
  return out;
}

// Colour for a frame between two keyframes A and B (t = 0 at A, 1 at B).
// A plain blend smears: a car's colour from A lingers on the road it has left.
// So wherever the two keyframes differ (something moved), each spot takes its
// colour from whichever keyframe it looks most like in this frame. Where it
// looks like neither (the car is halfway), colour is toned down rather than
// guessed. Still areas get the ordinary blend.
function between(abA, abB, greyA, greyB, grey, t, out) {
  const n = grey.length;
  out = out || new Float32Array(abA.length);
  for (let i = 0; i < n; i++) {
    const g = grey[i];
    const moved = Math.abs(greyA[i] - greyB[i]);
    const m = moved <= 0.03 ? 0 : moved >= 0.11 ? 1 : (moved - 0.03) / 0.08;
    let w = t;
    let keep = 1;
    if (m > 0) {
      const dA = Math.abs(g - greyA[i]);
      const dB = Math.abs(g - greyB[i]);
      w = t + (dA / (dA + dB + 1e-4) - t) * m;
      const miss = Math.min(dA, dB);
      keep = 1 - m * 0.7 * (miss <= 0.04 ? 0 : miss >= 0.14 ? 1 : (miss - 0.04) / 0.1);
    }
    out[i] = (abA[i] + (abB[i] - abA[i]) * w) * keep;
    out[n + i] = (abA[n + i] + (abB[n + i] - abA[n + i]) * w) * keep;
  }
  return out;
}

// Grey version of a frame at the model's size, for comparing with keyframes.
function grey(Y, W, H, size) {
  const g = downsample(Y, W, H, size, size);
  for (let i = 0; i < g.length; i++) g[i] /= 255;
  return g;
}

// Linear blend of two ab grids.
function mix(a, b, t, out) {
  out = out || new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

module.exports = { modelInput, grey, signature, isCut, motion, smooth, between, chroma, mix, THUMB_W, THUMB_H };
