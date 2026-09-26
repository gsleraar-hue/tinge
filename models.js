'use strict';

// Looks after the DDColor models: downloads them once (~1 GB each) into the
// user's data folder and loads them into onnxruntime. Only one model sits in
// memory at a time; switching costs a few seconds of loading.

const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');

const BASE = 'https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/';

const MODELS = {
  natural: { file: 'ddcolor.onnx', bytes: 980103562 },
  vivid: { file: 'ddcolor_artistic.onnx', bytes: 980103562 },
};

let dir = null;
let loaded = { id: null, session: null, promise: null };
const downloads = new Map();

function init(modelDir) {
  dir = modelDir;
  fs.mkdirSync(dir, { recursive: true });
}

function fileOf(id) {
  const m = MODELS[id];
  if (!m) throw new Error(`Unknown model: ${id}`);
  return path.join(dir, m.file);
}

function isReady(id) {
  try {
    return fs.statSync(fileOf(id)).size === MODELS[id].bytes;
  } catch (_) {
    return false;
  }
}

function status() {
  const out = {};
  for (const id of Object.keys(MODELS)) {
    out[id] = { ready: isReady(id), downloading: downloads.has(id), bytes: MODELS[id].bytes };
  }
  return out;
}

// Downloads a model with progress. A second call for the same model hooks into
// the download that is already running.
function download(id, onProgress) {
  if (isReady(id)) return Promise.resolve();
  if (downloads.has(id)) return downloads.get(id);

  const target = fileOf(id);
  const part = target + '.part';
  const job = (async () => {
    const res = await fetch(BASE + MODELS[id].file, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || MODELS[id].bytes;
    const out = fs.createWriteStream(part);
    let done = 0;
    let last = 0;
    try {
      for await (const chunk of res.body) {
        done += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        const now = Date.now();
        if (now - last > 150) {
          last = now;
          onProgress && onProgress({ id, done, total });
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (done !== MODELS[id].bytes) {
      fs.rmSync(part, { force: true });
      throw new Error('Download incomplete, please try again');
    }
    fs.renameSync(part, target);
    onProgress && onProgress({ id, done, total });
  })();

  downloads.set(id, job);
  job.finally(() => downloads.delete(id)).catch(() => {});
  return job;
}

async function session(id) {
  if (loaded.id === id && loaded.session) return loaded.session;
  if (loaded.id === id && loaded.promise) return loaded.promise;
  if (!isReady(id)) throw new Error('The model has not been downloaded yet');

  const previous = loaded.session;
  const promise = ort.InferenceSession.create(fileOf(id), {
    // On integrated graphics the GPU (DirectML) turned out slower than the
    // processor and fell over at some sizes, so we simply use the CPU.
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  loaded = { id, session: null, promise };
  const s = await promise;
  if (loaded.promise === promise) loaded = { id, session: s, promise: null };
  if (previous) previous.release().catch(() => {});
  return s;
}

// input: Float32Array [1,3,S,S] -> Float32Array [2,S,S] (a and b)
async function run(id, input, size) {
  const s = await session(id);
  const tensor = new ort.Tensor('float32', input, [1, 3, size, size]);
  const result = await s.run({ [s.inputNames[0]]: tensor });
  const out = result[s.outputNames[0]];
  return out.data;
}

module.exports = { MODELS, init, status, download, session, run, isReady };
