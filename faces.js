'use strict';

// Finds faces and tells skin, lips and eyes apart, so Tinge can give skin one
// even, natural tone instead of the patchy guess a colouriser makes.
//
// Two small models from the FaceFusion asset set, run with ONNX Runtime:
// - yoloface_8n: a YOLOv8 face detector (640 x 640 input);
// - bisenet_resnet_34: a face parser trained on CelebAMask-HQ (512 x 512),
//   which labels every pixel: skin, nose, lips, eyes, hair, neck, and so on.
//
// Works on a grey image ({ data: Uint8Array, w, h }); colour is not needed to
// find a face, and the photos are black and white anyway.

const ort = require('onnxruntime-node');

const DETECT = 640;
const PARSE = 512;
const MAX_FACES = 12;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// CelebAMask-HQ classes. Labels returned by labels() are face * 20 + class,
// so each face keeps its own tone.
const CLASS = { skin: 1, lBrow: 2, rBrow: 3, lEye: 4, rEye: 5, glasses: 6, lEar: 7, rEar: 8, earring: 9, nose: 10, mouth: 11, upperLip: 12, lowerLip: 13, neck: 14 };

let detector = null;
let parser = null;

async function load(detectorFile, parserFile) {
  const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
  if (!detector) detector = await ort.InferenceSession.create(detectorFile, opts);
  if (!parser) parser = await ort.InferenceSession.create(parserFile, opts);
}

function sample(img, x, y) {
  if (x < 0 || y < 0 || x > img.w - 1 || y > img.h - 1) return 0;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = Math.min(img.w - 1, x0 + 1);
  const y1 = Math.min(img.h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const d = img.data;
  const top = d[y0 * img.w + x0] + (d[y0 * img.w + x1] - d[y0 * img.w + x0]) * fx;
  const bot = d[y1 * img.w + x0] + (d[y1 * img.w + x1] - d[y1 * img.w + x0]) * fx;
  return top + (bot - top) * fy;
}

function iou(a, b) {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
  return inter / (area(a) + area(b) - inter + 1e-6);
}

// Face boxes in image pixels, best first.
async function detect(img) {
  const scale = Math.min(DETECT / img.w, DETECT / img.h);
  const n = DETECT * DETECT;
  const input = new Float32Array(3 * n);
  const sw = Math.round(img.w * scale);
  const sh = Math.round(img.h * scale);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const v = sample(img, (x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5) / 255;
      const i = y * DETECT + x;
      input[i] = v;
      input[n + i] = v;
      input[2 * n + i] = v;
    }
  }
  const out = await detector.run({ [detector.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, DETECT, DETECT]) });
  const det = out[detector.outputNames[0]].data; // [20, 8400]
  const count = det.length / 20;
  const boxes = [];
  for (let i = 0; i < count; i++) {
    const score = det[4 * count + i];
    if (score < 0.45) continue;
    const cx = det[i] / scale;
    const cy = det[count + i] / scale;
    const w = det[2 * count + i] / scale;
    const h = det[3 * count + i] / scale;
    if (w < 12 || h < 12) continue; // too small to colour sensibly
    boxes.push({ score, x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 });
  }
  boxes.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const b of boxes) if (!kept.some((k) => iou(k, b) > 0.4)) kept.push(b);
  // The biggest faces matter most when there are many.
  kept.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  return kept.slice(0, MAX_FACES);
}

// Labels one face: a square crop around the box, roomy enough to include hair,
// ears and neck (the parser was trained on such crops).
async function parse(img, box) {
  const side = Math.max(box.x1 - box.x0, box.y1 - box.y0) * 1.75;
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2 + side * 0.03;
  const ox = cx - side / 2;
  const oy = cy - side / 2;
  const step = side / PARSE;
  const n = PARSE * PARSE;
  const input = new Float32Array(3 * n);
  for (let y = 0; y < PARSE; y++) {
    for (let x = 0; x < PARSE; x++) {
      const v = sample(img, ox + (x + 0.5) * step - 0.5, oy + (y + 0.5) * step - 0.5) / 255;
      const i = y * PARSE + x;
      for (let c = 0; c < 3; c++) input[c * n + i] = (v - MEAN[c]) / STD[c];
    }
  }
  const out = await parser.run({ [parser.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, PARSE, PARSE]) });
  const logits = out[parser.outputNames[0]];
  const classes = logits.dims[1];
  const d = logits.data;
  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let best = 0;
    let bestV = -Infinity;
    for (let c = 0; c < classes; c++) {
      const v = d[c * n + i];
      if (v > bestV) {
        bestV = v;
        best = c;
      }
    }
    labels[i] = best;
  }
  return { labels, ox, oy, step };
}

// One label per cell of a gw x gh grid laid over the whole image:
// 0 = no face, otherwise face * 20 + class (classes as in CLASS).
async function labels(img, gw, gh) {
  const out = new Uint8Array(gw * gh);
  const faces = await detect(img);
  const sx = img.w / gw;
  const sy = img.h / gh;
  for (let f = 0; f < faces.length; f++) {
    const p = await parse(img, faces[f]);
    const base = f * 20; // 12 faces x 20 stays below 256
    const gx0 = Math.max(0, Math.floor(p.ox / sx));
    const gy0 = Math.max(0, Math.floor(p.oy / sy));
    const gx1 = Math.min(gw, Math.ceil((p.ox + p.step * PARSE) / sx));
    const gy1 = Math.min(gh, Math.ceil((p.oy + p.step * PARSE) / sy));
    for (let gy = gy0; gy < gy1; gy++) {
      for (let gx = gx0; gx < gx1; gx++) {
        if (out[gy * gw + gx]) continue; // a nearer, bigger face got here first
        const px = Math.floor(((gx + 0.5) * sx - p.ox) / p.step);
        const py = Math.floor(((gy + 0.5) * sy - p.oy) / p.step);
        if (px < 0 || py < 0 || px >= PARSE || py >= PARSE) continue;
        const c = p.labels[py * PARSE + px];
        if (c > 0 && c <= CLASS.neck) out[gy * gw + gx] = base + c;
      }
    }
  }
  return { labels: out, faces: faces.length };
}

module.exports = { load, detect, labels, CLASS };
