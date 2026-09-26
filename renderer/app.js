'use strict';

const api = window.tinge;
const C = window.TingeColor;

const SIZE = 512; // DDColor was trained at 512x512
const PREVIEW_MAX = 2400; // longest side of the on-screen preview

const STYLE_HINTS = {
  natural:
    'Calm, believable colours, like a colour photo from the time. The best choice for portraits and family photos.',
  vivid:
    'Richer, bolder colours. Lovely for landscapes, streets and postcards; sometimes a little strong for skin.',
};

const $ = (id) => document.getElementById(id);

const state = {
  items: [],
  current: null,
  model: load('model', 'natural'),
  sat: Number(load('sat', 100)),
  warm: Number(load('warm', 0)),
  split: 0.5,
  status: {},
  queueBusy: false,
  lastMs: 7000,
};

let nextId = 1;

function load(key, fallback) {
  try {
    const v = localStorage.getItem('tinge.' + key);
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem('tinge.' + key, String(value));
  } catch (_) {}
}

// ---------------------------------------------------------------- messages

let toastTimer = null;
function toast(msg, opts = {}) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (opts.error ? ' error' : '');
  if (opts.action) {
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = opts.action.label;
    b.onclick = () => {
      opts.action.run();
      el.hidden = true;
    };
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), opts.error ? 9000 : 4500);
}

const SHOW_LABEL = api.platform === 'darwin' ? 'Show in Finder' : 'Show in folder';

// ---------------------------------------------------------------- images

async function decode(file) {
  const data = await api.read(file);
  if (data && data.error) throw new Error(data.error);
  const blob = new Blob([data]);
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

function pixels(bitmap, w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

// Shrinking in halving steps gives a cleaner model input than going from
// 6000 px to 512 in one go.
function modelPixels(bitmap) {
  let src = bitmap;
  let w = bitmap.width;
  let h = bitmap.height;
  while (w > SIZE * 2 || h > SIZE * 2) {
    w = Math.max(SIZE, Math.round(w / 2));
    h = Math.max(SIZE, Math.round(h / 2));
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    src = c;
  }
  return pixels(src, SIZE, SIZE).data;
}

function fit(w, h, maxW, maxH) {
  const s = Math.min(maxW / w, maxH / h, 1);
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

function opts() {
  return { saturation: state.sat / 100, warmth: state.warm / 100 };
}

async function thumbnail(bitmap, ab) {
  const [w, h] = fit(bitmap.width, bitmap.height, 360, 240);
  const img = pixels(bitmap, w, h);
  if (ab) C.colorize(img.data, w, h, ab, SIZE, opts(), img.data);
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return URL.createObjectURL(blob);
}

// ---------------------------------------------------------------- list

function addItems(files) {
  const known = new Set(state.items.map((i) => i.path.toLowerCase()));
  const fresh = files
    .filter((f) => !known.has(f.path.toLowerCase()))
    .map((f) => ({
      id: nextId++,
      path: f.path,
      name: f.name,
      dir: f.dir,
      width: 0,
      height: 0,
      results: {},
      times: {},
      error: null,
      thumb: null,
      el: null,
    }));
  state.items.push(...fresh);
  if (!fresh.length) {
    if (files.length) toast('Those photos are already in the list.');
    else toast('No usable photos found (jpg, png, webp, bmp, gif, avif).');
    return;
  }
  renderList();
  if (!state.current) select(fresh[0]);
  pump();
}

function renderList() {
  const list = $('list');
  for (const item of state.items) {
    if (!item.el) {
      const el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = '<img alt="" /><span class="state"></span><span class="cap"></span><button class="x" title="Remove">×</button>';
      el.querySelector('.cap').textContent = item.name;
      el.title = item.path;
      el.onclick = (e) => {
        if (e.target.closest('.x')) return removeItem(item);
        select(item);
      };
      item.el = el;
      list.appendChild(el);
      makeThumb(item);
    }
    updateItem(item);
  }
  updateButtons();
}

async function makeThumb(item, ab) {
  try {
    const bmp = await decode(item.path);
    item.width = bmp.width;
    item.height = bmp.height;
    const url = await thumbnail(bmp, ab);
    bmp.close();
    if (item.thumb) URL.revokeObjectURL(item.thumb);
    item.thumb = url;
    if (item.el) item.el.querySelector('img').src = url;
  } catch (err) {
    item.error = 'Cannot open this photo';
    updateItem(item);
  }
}

function updateItem(item) {
  if (!item.el) return;
  item.el.classList.toggle('active', item === state.current);
  const s = item.el.querySelector('.state');
  const done = !!item.results[state.model];
  const working = item.working === state.model;
  s.className = 'state' + (item.error ? ' fail' : done ? ' done' : working ? ' work' : '');
  s.textContent = item.error ? 'Failed' : done ? 'Done' : working ? 'Working…' : 'Waiting';
}

function removeItem(item) {
  const idx = state.items.indexOf(item);
  if (idx < 0) return;
  state.items.splice(idx, 1);
  item.removed = true;
  item.el && item.el.remove();
  if (item.thumb) URL.revokeObjectURL(item.thumb);
  if (state.current === item) {
    const next = state.items[idx] || state.items[idx - 1] || null;
    if (next) select(next);
    else clearViewer();
  }
  updateButtons();
}

function updateButtons() {
  const cur = state.current;
  $('btn-save').disabled = !(cur && cur.results[state.model]);
  $('btn-save-all').disabled = !state.items.some((i) => i.results[state.model]);
}

// ---------------------------------------------------------------- viewer

let view = null; // { item, bitmap, w, h, src(ImageData) }

function clearViewer() {
  state.current = null;
  if (view) view.bitmap.close();
  view = null;
  $('viewer').hidden = true;
  $('empty').hidden = false;
  $('meta-name').textContent = '–';
  $('meta-size').textContent = '–';
  $('meta-time').textContent = '–';
  updateButtons();
}

async function select(item) {
  state.current = item;
  state.items.forEach(updateItem);
  updateButtons();
  $('empty').hidden = true;
  $('viewer').hidden = false;
  $('meta-name').textContent = item.name;
  $('meta-name').title = item.path;

  let bmp;
  try {
    bmp = await decode(item.path);
  } catch (err) {
    if (state.current === item) toast(`Cannot open ${item.name}: ${err.message}`, { error: true });
    return;
  }
  if (state.current !== item) return bmp.close();
  if (view) view.bitmap.close();
  item.width = bmp.width;
  item.height = bmp.height;
  $('meta-size').textContent = `${bmp.width} × ${bmp.height}`;
  view = { item, bitmap: bmp };
  layout();
  showBusy();
}

// Fits the canvases to the available space and draws both halves.
function layout() {
  if (!view) return;
  const box = $('viewer').getBoundingClientRect();
  const [cw, ch] = fit(view.bitmap.width, view.bitmap.height, box.width, box.height);
  const dpr = window.devicePixelRatio || 1;
  const [pw, ph] = fit(view.bitmap.width, view.bitmap.height, Math.min(cw * dpr, PREVIEW_MAX), Math.min(ch * dpr, PREVIEW_MAX));

  const frame = $('frame');
  frame.style.width = cw + 'px';
  frame.style.height = ch + 'px';
  for (const id of ['before', 'after']) {
    const c = $(id);
    c.width = pw;
    c.height = ph;
    c.style.width = cw + 'px';
    c.style.height = ch + 'px';
  }
  view.w = pw;
  view.h = ph;
  view.src = pixels(view.bitmap, pw, ph);
  $('before').getContext('2d').putImageData(view.src, 0, 0);
  paintAfter();
  placeSplit();
}

function paintAfter() {
  if (!view) return;
  const ab = view.item.results[state.model];
  const frame = $('frame');
  frame.classList.toggle('pending', !ab);
  const ctx = $('after').getContext('2d');
  if (!ab) {
    ctx.putImageData(view.src, 0, 0);
    $('meta-time').textContent = view.item.error ? 'failed' : 'in progress';
    return;
  }
  const out = new ImageData(view.w, view.h);
  C.colorize(view.src.data, view.w, view.h, ab, SIZE, opts(), out.data);
  ctx.putImageData(out, 0, 0);
  const ms = view.item.times[state.model];
  $('meta-time').textContent = ms ? `${(ms / 1000).toFixed(1)} s` : '–';
}

let paintQueued = false;
function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paintAfter();
  });
}

function placeSplit() {
  const pct = (state.split * 100).toFixed(3) + '%';
  $('split').style.left = pct;
  $('before').style.clipPath = `inset(0 ${(100 - state.split * 100).toFixed(3)}% 0 0)`;
  $('split').setAttribute('aria-valuenow', Math.round(state.split * 100));
}

// ---------------------------------------------------------------- progress

let busyTimer = null;
function showBusy() {
  const item = state.current;
  const busy = $('busy');
  clearInterval(busyTimer);
  if (!item || item.results[state.model] || item.error) {
    busy.hidden = true;
    return;
  }
  busy.hidden = false;
  const working = item.working === state.model;
  const ready = state.status[state.model] && state.status[state.model].ready;
  $('busy-text').textContent = !ready ? 'Waiting for the colour model…' : working ? 'Colouring…' : 'In the queue…';
  const bar = $('busy-bar');
  if (!working) {
    bar.style.width = '0%';
    return;
  }
  const start = item.startedAt || Date.now();
  const tick = () => {
    // The model reports no progress; we estimate from the previous run and
    // creep asymptotically towards 95%, so the bar never sits 'full' waiting.
    const t = (Date.now() - start) / state.lastMs;
    bar.style.width = (95 * (1 - Math.exp(-2.2 * t))).toFixed(1) + '%';
  };
  tick();
  busyTimer = setInterval(tick, 200);
}

// ---------------------------------------------------------------- queue

async function pump() {
  if (state.queueBusy) return;
  const model = state.model;
  if (!state.status[model] || !state.status[model].ready) return;
  state.queueBusy = true;
  try {
    for (;;) {
      if (state.model !== model) break;
      // The photo you are looking at first, then the rest from top to bottom.
      const todo = state.items.filter((i) => !i.results[model] && !i.error && !i.removed);
      if (!todo.length) break;
      const item = todo.includes(state.current) ? state.current : todo[0];
      await colorItem(item, model);
    }
  } finally {
    state.queueBusy = false;
  }
  if (state.model !== model) pump();
}

async function colorItem(item, model) {
  item.working = model;
  item.startedAt = Date.now();
  updateItem(item);
  if (item === state.current) showBusy();
  try {
    const bmp = await decode(item.path);
    const input = C.toModelInput(modelPixels(bmp), SIZE);
    const res = await api.colorize(model, input, SIZE);
    if (res.error) throw new Error(res.error);
    item.results[model] = res.ab;
    item.times[model] = res.ms;
    state.lastMs = res.ms;
    const url = await thumbnail(bmp, res.ab);
    bmp.close();
    if (item.thumb) URL.revokeObjectURL(item.thumb);
    item.thumb = url;
    if (item.el) item.el.querySelector('img').src = url;
  } catch (err) {
    item.error = err.message;
    if (item === state.current) toast(`${item.name}: ${err.message}`, { error: true });
  } finally {
    item.working = null;
    updateItem(item);
    updateButtons();
    if (item === state.current) {
      showBusy();
      paintAfter();
    }
  }
}

// ---------------------------------------------------------------- saving

function splitName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot).toLowerCase()] : [name, ''];
}

function outputType(ext) {
  if (ext === '.png') return { ext: '.png', mime: 'image/png' };
  if (ext === '.webp') return { ext: '.webp', mime: 'image/webp' };
  return { ext: '.jpg', mime: 'image/jpeg' };
}

async function renderFull(item, model, mime) {
  const bmp = await decode(item.path);
  const w = bmp.width;
  const h = bmp.height;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, w, h);
  C.colorize(img.data, w, h, item.results[model], SIZE, opts(), img.data);
  ctx.putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type: mime, quality: 0.95 });
  return new Uint8Array(await blob.arrayBuffer());
}

async function saveOne() {
  const item = state.current;
  if (!item || !item.results[state.model]) return;
  const [base, ext] = splitName(item.name);
  const type = outputType(ext);
  const suggestion = await api.join(item.dir, `${base} (colour)${type.ext}`);
  const target = await api.saveAs(suggestion);
  if (!target) return;
  const chosen = outputType(splitName(target.name)[1]);
  toast('Saving…');
  const data = await renderFull(item, state.model, chosen.mime);
  const r = await api.write(target.path, data);
  if (r.error) return toast(r.error, { error: true });
  toast(`Saved as ${target.name}`, {
    action: { label: SHOW_LABEL, run: () => api.show(target.path) },
  });
}

async function saveAll() {
  const done = state.items.filter((i) => i.results[state.model]);
  if (!done.length) return;
  const folder = await api.chooseFolder(done[0].dir);
  if (!folder) return;
  const btn = $('btn-save-all');
  btn.disabled = true;
  let ok = 0;
  let last = null;
  try {
    for (const item of done) {
      toast(`Saving ${ok + 1} of ${done.length}…`);
      const [base, ext] = splitName(item.name);
      const type = outputType(ext);
      const target = await api.uniqueName(folder, `${base} (colour)`, type.ext);
      const data = await renderFull(item, state.model, type.mime);
      const r = await api.write(target, data);
      if (r.error) {
        toast(r.error, { error: true });
        return;
      }
      ok++;
      last = target;
    }
    const waiting = state.items.length - done.length;
    toast(`${ok} photo${ok === 1 ? '' : 's'} saved` + (waiting ? ` (${waiting} not ready yet)` : ''), {
      action: { label: SHOW_LABEL, run: () => api.show(last) },
    });
  } finally {
    updateButtons();
  }
}

// ---------------------------------------------------------------- models

function setModel(id) {
  state.model = id;
  store('model', id);
  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.model === id));
  });
  $('style-hint').textContent = STYLE_HINTS[id];
  state.items.forEach(updateItem);
  updateButtons();
  if (view) paintAfter();
  ensureModel(id);
}

async function ensureModel(id) {
  state.status = await api.modelStatus();
  if (state.status[id].ready) {
    showBusy();
    api.warmModel(id);
    pump();
    return;
  }
  showBusy();
  askDownload(id);
}

function askDownload(id) {
  const mb = Math.round(state.status[id].bytes / 1e6);
  const name = id === 'natural' ? 'Natural' : 'Vivid';
  $('modal-title').textContent = `Download the ‘${name}’ colour model`;
  $('modal-text').textContent =
    'Tinge colours photos with an AI model (DDColor) that runs on your own computer. ' +
    `The model has to be downloaded once: ${mb} MB. After that everything works offline.`;
  $('modal-bar').style.width = '0%';
  $('modal-progress').textContent = '';
  $('modal-go').disabled = false;
  $('modal-go').textContent = 'Download';
  $('modal-cancel').textContent = 'Later';
  $('modal').hidden = false;
  $('modal-go').onclick = async () => {
    $('modal-go').disabled = true;
    $('modal-cancel').textContent = 'Hide';
    $('modal-progress').textContent = 'Connecting…';
    const r = await api.downloadModel(id);
    if (r.error) {
      $('modal-progress').textContent = r.error;
      $('modal-go').disabled = false;
      $('modal-go').textContent = 'Try again';
      return;
    }
    $('modal').hidden = true;
    toast('Colour model installed.');
    if (state.model === id) ensureModel(id);
  };
  $('modal-cancel').onclick = () => {
    $('modal').hidden = true;
    if (state.model === id && !state.status[id].ready) {
      // Fall back to a model that is there, if there is one.
      const other = Object.keys(state.status).find((k) => state.status[k].ready);
      if (other && !$('modal-go').disabled) setModel(other);
    }
  };
}

api.onProgress((p) => {
  const pct = (100 * p.done) / p.total;
  $('modal-bar').style.width = pct.toFixed(1) + '%';
  $('modal-progress').textContent = `${Math.round(p.done / 1e6)} of ${Math.round(p.total / 1e6)} MB`;
});

// ---------------------------------------------------------------- input

function wire() {
  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.onclick = () => b.dataset.model !== state.model && setModel(b.dataset.model);
  });

  $('btn-add').onclick = async () => addItems(await api.openFiles());
  $('btn-save').onclick = () => saveOne().catch((e) => toast(e.message, { error: true }));
  $('btn-save-all').onclick = () => saveAll().catch((e) => toast(e.message, { error: true }));

  const sat = $('sat');
  const warm = $('warm');
  const sync = () => {
    $('out-sat').textContent = `${state.sat}%`;
    $('out-warm').textContent = state.warm > 0 ? `+${state.warm}` : String(state.warm);
    sat.value = state.sat;
    warm.value = state.warm;
  };
  sat.oninput = () => {
    state.sat = Number(sat.value);
    store('sat', state.sat);
    sync();
    schedulePaint();
  };
  warm.oninput = () => {
    state.warm = Number(warm.value);
    store('warm', state.warm);
    sync();
    schedulePaint();
  };
  // Once the slider is let go, update the thumbnails too.
  const refreshThumbs = () => state.items.forEach((i) => i.results[state.model] && makeThumb(i, i.results[state.model]));
  sat.onchange = refreshThumbs;
  warm.onchange = refreshThumbs;
  $('btn-reset').onclick = () => {
    state.sat = 100;
    state.warm = 0;
    store('sat', 100);
    store('warm', 0);
    sync();
    paintAfter();
    refreshThumbs();
  };
  sync();

  // Before/after slider
  const frame = $('frame');
  const setFrom = (e) => {
    const r = frame.getBoundingClientRect();
    state.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    placeSplit();
  };
  frame.addEventListener('pointerdown', (e) => {
    frame.setPointerCapture(e.pointerId);
    setFrom(e);
  });
  frame.addEventListener('pointermove', (e) => {
    if (frame.hasPointerCapture(e.pointerId)) setFrom(e);
  });
  $('split').addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') state.split = Math.max(0, state.split - step);
    else if (e.key === 'ArrowRight') state.split = Math.min(1, state.split + step);
    else return;
    e.preventDefault();
    placeSplit();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      frame.classList.add('whole');
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && state.current) {
      e.preventDefault();
      const i = state.items.indexOf(state.current) + (e.key === 'ArrowDown' ? 1 : -1);
      if (state.items[i]) {
        select(state.items[i]);
        state.items[i].el.scrollIntoView({ block: 'nearest' });
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveOne().catch((err) => toast(err.message, { error: true }));
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      $('btn-add').click();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') frame.classList.remove('whole');
  });

  // Drag and drop, whole folders included
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++depth === 1) $('drop').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      $('drop').hidden = true;
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    $('drop').hidden = true;
    const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
    if (paths.length) addItems(await api.expand(paths));
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 120);
  });
}

// ---------------------------------------------------------------- self-test

async function selftest(t) {
  const report = { ok: false, input: t.input, output: t.output, model: t.model };
  try {
    state.status = await api.modelStatus();
    if (!state.status[t.model].ready) throw new Error('model missing');
    const item = { path: t.input, results: {}, times: {} };
    const bmp = await decode(t.input);
    report.size = [bmp.width, bmp.height];
    const input = C.toModelInput(modelPixels(bmp), SIZE);
    bmp.close();
    const res = await api.colorize(t.model, input, SIZE);
    if (res.error) throw new Error(res.error);
    report.inferMs = res.ms;
    let min = Infinity;
    let max = -Infinity;
    for (const v of res.ab) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    report.abRange = [Math.round(min), Math.round(max)];
    item.results[t.model] = res.ab;
    const t0 = performance.now();
    const data = await renderFull(item, t.model, outputType(splitName(t.output)[1]).mime);
    report.renderMs = Math.round(performance.now() - t0);
    const w = await api.write(t.output, data);
    if (w.error) throw new Error(w.error);
    report.bytes = data.length;
    report.ok = true;
  } catch (err) {
    report.error = err.message;
  }
  api.selftestDone(report);
}

// ---------------------------------------------------------------- start

(async function start() {
  const t = await api.selftest();
  if (t) return selftest(t);
  wire();
  setModel(state.model in STYLE_HINTS ? state.model : 'natural');
})();
