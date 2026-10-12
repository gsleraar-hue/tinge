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

  // Model grids may be square (a number) or [width, height].
  function dims(size) {
    return typeof size === 'number' ? [size, size] : size;
  }

  // Grid size for a photo of w x h: about 512 x 512 worth of pixels, in the
  // photo's own proportions, both sides a multiple of 32. Squashing a portrait
  // into a square makes faces and buildings look wrong to the model.
  function gridFor(w, h, area) {
    const a = area || 512 * 512;
    const s = Math.sqrt(a / (w * h));
    const round = (v) => Math.max(256, Math.min(1024, Math.round(v / 32) * 32));
    return [round(w * s), round(h * s)];
  }

  // RGBA pixels of a grid -> model input [1,3,H,W], grey from 0..1. Same grey
  // weighting as OpenCV, which DDColor was trained with.
  function toModelInput(rgba, size) {
    const [gw, gh] = dims(size);
    const n = gw * gh;
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
  function colorize(src, w, h, grid, size, opts, out) {
    // `grid` is either the model's raw ab (Float32Array) or the coefficients
    // from guide(), which make the colour follow the edges of the original.
    const guided = !!(grid && grid.A);
    const ab = guided ? grid.B : grid;
    const A = guided ? grid.A : null;
    const sat = opts && opts.saturation != null ? opts.saturation : 1;
    const warm = opts && opts.warmth ? opts.warmth : 0;
    const shiftA = warm * 3;
    const shiftB = warm * 12;
    const [gw, gh] = dims(size);
    const n = gw * gh;
    const sx = gw / w;
    const sy = gh / h;
    const maxX = gw - 1;
    const maxY = gh - 1;
    out = out || new Uint8ClampedArray(w * h * 4);

    // Horizontal interpolation weights, worked out once per column.
    const x0s = new Int32Array(w);
    const x1s = new Int32Array(w);
    const fxs = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let u = (x + 0.5) * sx - 0.5;
      if (u < 0) u = 0;
      if (u > maxX) u = maxX;
      const x0 = u | 0;
      x0s[x] = x0;
      x1s[x] = x0 < maxX ? x0 + 1 : x0;
      fxs[x] = u - x0;
    }

    for (let y = 0; y < h; y++) {
      let v = (y + 0.5) * sy - 0.5;
      if (v < 0) v = 0;
      if (v > maxY) v = maxY;
      const y0 = v | 0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const fy = v - y0;
      const r0 = y0 * gw;
      const r1 = y1 * gw;

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
        let av = aTop + (aBot - aTop) * fy;
        let bv = bTop + (bBot - bTop) * fy;
        if (guided) {
          const g = L / 100;
          const aaTop = A[i00] + (A[i01] - A[i00]) * fx;
          const aaBot = A[i10] + (A[i11] - A[i10]) * fx;
          const baTop = A[n + i00] + (A[n + i01] - A[n + i00]) * fx;
          const baBot = A[n + i10] + (A[n + i11] - A[n + i10]) * fx;
          av += (aaTop + (aaBot - aaTop) * fy) * g;
          bv += (baTop + (baBot - baTop) * fy) * g;
        }
        // Colour fades out in the deepest shadows and brightest highlights, so
        // black and white do not pick up a coloured haze.
        const edge = L < 8 ? L / 8 : L > 96 ? (100 - L) / 4 : 1;
        const k = sat * (edge < 0 ? 0 : edge);
        const a = av * k + shiftA * edge;
        const b = bv * k + shiftB * edge;

        labToRgbInto(L, a, b, out, p);
        out[p + 3] = src[p + 3];
      }
    }
    return out;
  }

  // Mean over a (2r+1)^2 window for every cell of a grid, using a summed-area
  // table; windows are cut off at the borders.
  function boxMean(src, size, r, out) {
    const [gw, gh] = dims(size);
    const s1 = gw + 1;
    const sat = new Float64Array(s1 * (gh + 1));
    for (let y = 0; y < gh; y++) {
      let row = 0;
      for (let x = 0; x < gw; x++) {
        row += src[y * gw + x];
        sat[(y + 1) * s1 + x + 1] = sat[y * s1 + x + 1] + row;
      }
    }
    out = out || new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(gh, y + r + 1);
      for (let x = 0; x < gw; x++) {
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(gw, x + r + 1);
        const sum = sat[y1 * s1 + x1] - sat[y0 * s1 + x1] - sat[y1 * s1 + x0] + sat[y0 * s1 + x0];
        out[y * gw + x] = sum / ((y1 - y0) * (x1 - x0));
      }
    }
    return out;
  }

  // Guided filter (He, Sun & Tang). The model's colour is only 512 x 512; scaled
  // up plainly it bleeds across edges (lipstick onto skin, sky onto a roof).
  // This fits, in every small window, colour as a straight-line function of
  // brightness: colour = A * L + B. A and B vary slowly, so they can be scaled
  // up to full size, and multiplying by the full-size L puts colour edges
  // exactly where the edges in the original photo are.
  // grey: L/100 of the model's input grid (size x size). Returns { A, B }.
  function guide(ab, grey, size, opts) {
    const r = (opts && opts.radius) || 4;
    const eps = (opts && opts.eps) || 0.002;
    const [gw, gh] = dims(size);
    const n = gw * gh;
    const meanI = boxMean(grey, size, r);
    const sq = new Float32Array(n);
    for (let i = 0; i < n; i++) sq[i] = grey[i] * grey[i];
    const corrI = boxMean(sq, size, r);
    const A = new Float32Array(2 * n);
    const B = new Float32Array(2 * n);
    const tmp = new Float32Array(n);
    const prod = new Float32Array(n);
    const a = new Float32Array(n);
    const b = new Float32Array(n);
    for (let c = 0; c < 2; c++) {
      const p = ab.subarray(c * n, (c + 1) * n);
      const meanP = boxMean(p, size, r);
      for (let i = 0; i < n; i++) prod[i] = grey[i] * p[i];
      const corrIP = boxMean(prod, size, r, tmp);
      for (let i = 0; i < n; i++) {
        const varI = corrI[i] - meanI[i] * meanI[i];
        const cov = corrIP[i] - meanI[i] * meanP[i];
        a[i] = cov / (varI + eps);
        b[i] = meanP[i] - a[i] * meanI[i];
      }
      boxMean(a, size, r, A.subarray(c * n, (c + 1) * n));
      boxMean(b, size, r, B.subarray(c * n, (c + 1) * n));
    }
    return { A, B };
  }

  // L/100 of each pixel of an RGBA grid: the guide for guide().
  function greyGrid(rgba, size) {
    const [gw, gh] = dims(size);
    const n = gw * gh;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = lightness(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) / 100;
    return out;
  }

  // Faded prints have grey blacks and dull whites. The model recognises things
  // better at full contrast, so its input is stretched (the photo itself is not).
  function stretch(input, size) {
    const [gw, gh] = dims(size);
    const n = gw * gh;
    const hist = new Uint32Array(1024);
    for (let i = 0; i < n; i++) hist[Math.min(1023, (input[i] * 1023) | 0)]++;
    const pick = (q) => {
      let acc = 0;
      for (let v = 0; v < 1024; v++) if ((acc += hist[v]) >= q * n) return v / 1023;
      return 1;
    };
    const lo = pick(0.005);
    const hi = pick(0.995);
    if (hi - lo < 0.05) return input;
    const k = 1 / (hi - lo);
    for (let i = 0; i < 3 * n; i++) {
      const v = (input[i] - lo) * k;
      input[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    return input;
  }

  // DDColor falls back on magenta and purple where it is unsure (a cloth, a
  // sky, a shadow), and real purple was rare in old photographs. So colour in
  // that corner of the colour wheel is toned down, the more the purpler.
  // Reds (lips, roses) and blues (sky, denim) sit outside it and are untouched.
  function tame(ab, size, strength) {
    const [gw, gh] = dims(size);
    const n = gw * gh;
    const k = strength == null ? 0.75 : strength;
    for (let i = 0; i < n; i++) {
      const a = ab[i];
      const b = ab[n + i];
      if (a <= 0 || b >= 0) continue;
      // angle 0 = pure red (+a), 90 degrees = pure blue-violet (-b)
      const t = Math.atan2(-b, a) / (Math.PI / 2);
      const w = Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.1) / 0.8))); // peaks at magenta
      const f = 1 - k * w;
      ab[i] = a * f;
      ab[n + i] = b * f;
    }
    return ab;
  }

  // ---------------------------------------------------------------- skin

  const DEG = Math.PI / 180;
  const SKIN = [1, 7, 8, 10, 14]; // skin, ears, nose, neck
  const LIPS = [12, 13];
  const EYES = [4, 5];
  const MOUTH = 11;

  function median(values) {
    if (!values.length) return 0;
    const s = Float32Array.from(values).sort();
    return s[s.length >> 1];
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // Soft 0..1 mask of the cells whose label passes `test`, so corrections fade
  // in over a few cells instead of ending in a hard line.
  function softMask(labels, size, test) {
    const [gw, gh] = dims(size);
    const m = new Float32Array(gw * gh);
    for (let i = 0; i < m.length; i++) if (labels[i] && test(labels[i])) m[i] = 1;
    return boxMean(m, size, 2);
  }

  // Gives every face one even, believable skin tone. A colouriser judges each
  // patch of a face on its own, which gives red blotches on cheeks and chin,
  // orange foreheads or grey necks. Per face this takes the model's own skin
  // colour (the median, so blotches do not count), keeps it inside the range
  // real skin falls in, and lays it evenly over all skin, keeping a little of
  // the model's variation (rosy cheeks). Lips get a clear red, eyes and the
  // inside of the mouth lose most of their colour.
  // labels: from the face parser, one per grid cell: face * 20 + class.
  function skinFix(ab, labels, size) {
    const [gw, gh] = dims(size);
    const n = gw * gh;
    const faces = new Set();
    for (let i = 0; i < n; i++) if (labels[i]) faces.add((labels[i] / 20) | 0);

    for (const f of faces) {
      const cls = (l) => (l && ((l / 20) | 0) === f ? l % 20 : 0);
      const skinA = [];
      const skinB = [];
      const lipA = [];
      const lipB = [];
      for (let i = 0; i < n; i++) {
        const c = cls(labels[i]);
        if (SKIN.includes(c)) {
          skinA.push(ab[i]);
          skinB.push(ab[n + i]);
        } else if (LIPS.includes(c)) {
          lipA.push(ab[i]);
          lipB.push(ab[n + i]);
        }
      }
      if (skinA.length < 20) continue;

      // Real skin sits in a narrow wedge of the colour wheel: between red and
      // yellow, never strongly saturated.
      const ma = median(skinA);
      const mb = median(skinB);
      const hue = clamp(Math.atan2(mb, ma), 40 * DEG, 60 * DEG);
      const chroma = clamp(Math.hypot(ma, mb), 14, 30);
      const ta = chroma * Math.cos(hue);
      const tb = chroma * Math.sin(hue);

      // Lips: redder and stronger than the skin around them.
      let la = ta;
      let lb = tb;
      if (lipA.length) {
        const lh = clamp(Math.atan2(median(lipB), median(lipA)), 12 * DEG, 32 * DEG);
        const lc = clamp(Math.hypot(median(lipA), median(lipB)), chroma * 1.6, 48);
        la = lc * Math.cos(lh);
        lb = lc * Math.sin(lh);
      }

      const skinW = softMask(labels, size, (l) => SKIN.includes(cls(l)));
      const lipW = softMask(labels, size, (l) => LIPS.includes(cls(l)));
      const dullW = softMask(labels, size, (l) => EYES.includes(cls(l)) || cls(l) === MOUTH);
      for (let i = 0; i < n; i++) {
        let a = ab[i];
        let b = ab[n + i];
        if (skinW[i] > 0) {
          // 30% of the model's own variation, but never more than a few units.
          const va = clamp((a - ma) * 0.3, -4, 4);
          const vb = clamp((b - mb) * 0.3, -4, 4);
          a += (ta + va - a) * skinW[i];
          b += (tb + vb - b) * skinW[i];
        }
        if (lipW[i] > 0) {
          a += (la - a) * lipW[i];
          b += (lb - b) * lipW[i];
        }
        if (dullW[i] > 0) {
          a *= 1 - 0.6 * dullW[i];
          b *= 1 - 0.6 * dullW[i];
        }
        ab[i] = a;
        ab[n + i] = b;
      }
    }
    return ab;
  }

  // Edge-aware smoothing against blotches, then the colour strength that the
  // smoothing took away given back, so the result is even but not duller.
  // labels (optional): faces keep the fine radius, because skinFix() has
  // already evened out their skin and strong smoothing would smear the lips.
  function guideEven(ab, grey, size, labels) {
    const [gw, gh] = dims(size);
    const n = gw * gh;
    const coef = guide(ab, grey, size, { radius: 12, eps: 0.0005 });
    if (labels) {
      const fine = guide(ab, grey, size, { radius: 4, eps: 0.002 });
      const w = softMask(labels, size, () => true);
      for (let i = 0; i < n; i++) {
        if (!(w[i] > 0)) continue;
        for (const o of [i, n + i]) {
          coef.A[o] += (fine.A[o] - coef.A[o]) * w[i];
          coef.B[o] += (fine.B[o] - coef.B[o]) * w[i];
        }
      }
    }
    let before = 0;
    let after = 0;
    for (let i = 0; i < n; i++) {
      before += Math.hypot(ab[i], ab[n + i]);
      after += Math.hypot(coef.A[i] * grey[i] + coef.B[i], coef.A[n + i] * grey[i] + coef.B[n + i]);
    }
    const k = Math.min(1.5, before / Math.max(1e-6, after));
    for (let i = 0; i < 2 * n; i++) {
      coef.A[i] *= k;
      coef.B[i] *= k;
    }
    return coef;
  }

  // ---------------------------------------------------------------- brush

  // The a/b of a colour picked in the brush palette (hex like '#a33b2f').
  // Only the colour is used; the lightness always comes from the photo.
  function hexAb(hex) {
    const v = parseInt(hex.slice(1), 16);
    const [, a, b] = rgbToLab((v >> 16) & 255, (v >> 8) & 255, v & 255);
    return [a, b];
  }

  // Binary min-heap of (distance, cell) for paint().
  function Heap() {
    let d = new Float32Array(1024);
    let c = new Int32Array(1024);
    let size = 0;
    return {
      get size() {
        return size;
      },
      push(dist, cell) {
        if (size === d.length) {
          const nd = new Float32Array(size * 2);
          const nc = new Int32Array(size * 2);
          nd.set(d);
          nc.set(c);
          d = nd;
          c = nc;
        }
        let i = size++;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (d[p] <= dist) break;
          d[i] = d[p];
          c[i] = c[p];
          i = p;
        }
        d[i] = dist;
        c[i] = cell;
      },
      pop() {
        const top = c[0];
        const topD = d[0];
        const lastD = d[--size];
        const lastC = c[size];
        let i = 0;
        for (;;) {
          let k = 2 * i + 1;
          if (k >= size) break;
          if (k + 1 < size && d[k + 1] < d[k]) k++;
          if (d[k] >= lastD) break;
          d[i] = d[k];
          c[i] = c[k];
          i = k;
        }
        d[i] = lastD;
        c[i] = lastC;
        return [topD, top];
      },
    };
  }

  // Lays brush strokes over the model's colour. A stroke is { points: [[x, y]
  // in 0..1 of the photo], radius (0..1 of the photo's width), colour: [a, b] }.
  // Colour spreads from the stroke over everything that looks like one surface
  // in the original: each step costs more where the brightness jumps, so it
  // runs on through a dress but stops at the edge between dress and arm.
  // Later strokes paint over earlier ones. Returns a new ab grid.
  function paint(base, grey, size, strokes) {
    const [gw, gh] = dims(size);
    const n = gw * gh;
    const ab = Float32Array.from(base);
    if (!strokes || !strokes.length) return ab;
    const g = boxMean(grey, size, 1); // grain and print noise should not count as edges
    // Brightness steps under 0.04 (texture, folds, grain) cost nothing extra;
    // anything above is a real edge and all but blocks the colour.
    const EDGE = 400;
    const FREE = 0.04;
    const dist = new Float32Array(n);

    for (const s of strokes) {
      const r = Math.max(1, s.radius * gw);
      const reach = r * 1.5 + 14;
      dist.fill(Infinity);
      const heap = Heap();
      // Seeds: the cells under the brush along the stroke that look like the
      // surface the stroke started on. Sweeping a bit over a hand while
      // painting a glove leaves the hand alone.
      const [sx0, sy0] = s.points[0];
      const ref = g[Math.min(gh - 1, Math.floor(sy0 * gh)) * gw + Math.min(gw - 1, Math.floor(sx0 * gw))];
      for (const [px, py] of s.points) {
        const cx = px * gw;
        const cy = py * gh;
        for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(gh - 1, Math.ceil(cy + r)); y++) {
          for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(gw - 1, Math.ceil(cx + r)); x++) {
            if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
            const i = y * gw + x;
            if (Math.abs(g[i] - ref) > 0.15) continue;
            if (dist[i] !== 0) {
              dist[i] = 0;
              heap.push(0, i);
            }
          }
        }
      }
      // Dijkstra over the grid, stopping at the reach.
      while (heap.size) {
        const [d, i] = heap.pop();
        if (d > dist[i] || d > reach) continue;
        const x = i % gw;
        const y = (i / gw) | 0;
        const step = (j) => {
          const nd = d + 1 + EDGE * Math.max(0, Math.abs(g[j] - g[i]) - FREE);
          if (nd < dist[j] && nd <= reach) {
            dist[j] = nd;
            heap.push(nd, j);
          }
        };
        if (x > 0) step(i - 1);
        if (x < gw - 1) step(i + 1);
        if (y > 0) step(i - gw);
        if (y < gh - 1) step(i + gw);
      }
      const [ta, tb] = s.colour;
      for (let i = 0; i < n; i++) {
        const d = dist[i];
        if (d === Infinity) continue;
        // Full strength near the stroke, fading out towards the reach.
        const t = d <= reach * 0.5 ? 1 : 1 - (d - reach * 0.5) / (reach * 0.5);
        const w = t * t * (3 - 2 * t);
        ab[i] += (ta - ab[i]) * w;
        ab[n + i] += (tb - ab[n + i]) * w;
      }
    }
    return ab;
  }

  // Mirrors a model input or output ([channels, size, size]) left to right.
  function flip(data, size) {
    const [gw, gh] = dims(size);
    const out = new Float32Array(data.length);
    const planes = data.length / (gw * gh);
    for (let c = 0; c < planes; c++) {
      const o = c * gw * gh;
      for (let y = 0; y < gh; y++) {
        const row = o + y * gw;
        for (let x = 0; x < gw; x++) out[row + x] = data[row + gw - 1 - x];
      }
    }
    return out;
  }

  const api = { lightness, rgbToLab, labToRgbInto, dims, gridFor, toModelInput, colorize, guide, guideEven, skinFix, paint, hexAb, greyGrid, stretch, tame, flip, boxMean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TingeColor = api;
})(typeof self !== 'undefined' ? self : this);
