'use strict';

// Colours whole films. ffmpeg decodes the film into raw frames, Tinge colours
// them and a second ffmpeg encodes them again. Three things make a feature
// film doable on an ordinary computer:
//
// 1. Keyframes. The model only looks at every Nth frame; the colour of the
//    frames in between is blended from the keyframes on either side. Colour
//    changes far more slowly than the picture, so this is hardly visible.
// 2. Scene cuts. Blending across a cut would smear the colours of one shot
//    into the next, so every cut gets fresh keyframes on both sides.
// 3. Chunks. The film is encoded in pieces of about 30 seconds, kept in a work
//    folder. Pausing (or closing Tinge, or a crash) loses at most the chunk in
//    progress; continuing picks up at the next one. At the end the pieces are
//    joined and the original sound is added back.
//
// Flicker is the other enemy: the model judges every keyframe on its own, so a
// coat can be blue in one and grey-blue in the next. The colour is therefore
// smoothed over time (an exponential moving average, reset at every cut).

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const models = require('./models');
const VC = require('./videocolor');
const C = require('./renderer/color.js');

const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.mpg', '.mpeg', '.wmv', '.flv', '.3gp', '.ts', '.mts', '.m2ts', '.ogv', '.vob',
]);

// Model size and keyframe interval per quality setting.
const PRESETS = {
  best: { size: 512, every: 1 },
  balanced: { size: 384, every: 4 },
  fast: { size: 256, every: 8 },
};

// How long (in seconds) colour takes to settle, per flicker setting.
const FLICKER = { off: 0, normal: 0.25, strong: 0.6 };

const CHUNK_SECONDS = Number(process.env.TINGE_CHUNK_SECONDS) || 30;

let ffmpegPath = null;
let workRoot = null;
let emit = () => {};
let running = null; // the job being processed, if any
const jobs = new Map(); // key -> job

function init(opts) {
  workRoot = opts.workDir;
  emit = opts.onProgress;
  fs.mkdirSync(workRoot, { recursive: true });
  let p = require('ffmpeg-static');
  // Inside a packaged app the binary lives next to the asar archive, not in it.
  if (p) p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  ffmpegPath = p;
}

function isVideo(file) {
  return VIDEO_EXTS.has(path.extname(file).toLowerCase());
}

function ffmpeg(args, opts = {}) {
  return spawn(ffmpegPath, ['-hide_banner', '-nostdin', ...args], { windowsHide: true, ...opts });
}

// Runs ffmpeg to completion and returns { code, stdout (Buffer), stderr (text) }.
function run(args) {
  return new Promise((resolve, reject) => {
    const p = ffmpeg(args);
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
  });
}

// ---------------------------------------------------------------- probing

// Common NTSC-style rates are really fractions; writing 29.97 would make the
// picture drift from the sound by a frame every few minutes.
function exactRate(fps) {
  const ntsc = { 23.98: 24, 23.976: 24, 29.97: 30, 47.95: 48, 59.94: 60 };
  if (ntsc[fps]) return { rate: `${ntsc[fps] * 1000}/1001`, value: (ntsc[fps] * 1000) / 1001 };
  return { rate: String(fps), value: fps };
}

async function probe(file) {
  const { stderr } = await run(['-i', file]);
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const lines = stderr.split(/\r?\n/).filter((l) => /Stream #.*: Video:/.test(l) && !/attached pic/.test(l));
  if (!lines.length) throw new Error('No video found in this file');
  const line = lines[0];
  const size = /, (\d{2,5})x(\d{2,5})[, \[]/.exec(line);
  if (!size) throw new Error('Could not read the size of this video');
  const fpsMatch = /(\d+(?:\.\d+)?) fps/.exec(line) || /(\d+(?:\.\d+)?) tbr/.exec(line);
  const fps = fpsMatch ? Number(fpsMatch[1]) : 25;
  const sar = /SAR (\d+):(\d+)/.exec(line);
  const rot = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(stderr);
  let width = Number(size[1]);
  let height = Number(size[2]);
  if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [width, height] = [height, width];
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  const { rate, value } = exactRate(fps);
  return {
    duration,
    fps: value,
    rate,
    width,
    height,
    // yuv420p needs even sizes
    outWidth: width - (width % 2),
    outHeight: height - (height % 2),
    sar: sar && sar[1] !== '0' && !(sar[1] === '1' && sar[2] === '1') ? `${sar[1]}/${sar[2]}` : null,
    frames: Math.max(1, Math.round(duration * value)),
    audio: /Stream #.*: Audio:/.test(stderr),
  };
}

// One frame as a PNG, for the preview.
async function frame(file, t) {
  const { code, stdout, stderr } = await run([
    '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', file,
    '-map', '0:v:0', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-',
  ]);
  if (code !== 0 || !stdout.length) throw new Error(stderr.trim().split('\n').pop() || 'Could not read a frame');
  return stdout;
}

// ---------------------------------------------------------------- jobs

function keyOf(file) {
  return crypto.createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 16);
}

function dirOf(key) {
  return path.join(workRoot, key);
}

function fileStamp(file) {
  const st = fs.statSync(file);
  return { size: st.size, mtime: Math.round(st.mtimeMs) };
}

function load(file) {
  const key = keyOf(file);
  if (jobs.has(key)) return jobs.get(key);
  try {
    const job = JSON.parse(fs.readFileSync(path.join(dirOf(key), 'job.json'), 'utf8'));
    job.key = key;
    job.state = job.state === 'done' ? 'done' : 'paused';
    jobs.set(key, job);
    return job;
  } catch (_) {
    return null;
  }
}

function save(job) {
  // Only the plain facts; processes and timers stay out of the file.
  const { key, procs, speed, stopping, lastEmit, keyMs, phase, ...rest } = job; // eslint-disable-line no-unused-vars
  fs.writeFileSync(path.join(dirOf(key), 'job.json'), JSON.stringify(rest, null, 2));
}

function summary(job) {
  if (!job) return null;
  return {
    input: job.input,
    output: job.output,
    state: job.state, // running | paused | done | failed
    error: job.error || null,
    settings: job.settings,
    done: job.done,
    total: job.info.frames,
    fps: job.speed ? job.speed.fps : null,
    eta: job.speed && job.speed.fps ? (job.info.frames - job.done) / job.speed.fps : null,
    phase: job.phase || null,
  };
}

function status(file) {
  return summary(load(file));
}

function report(job, force) {
  const now = Date.now();
  if (!force && job.lastEmit && now - job.lastEmit < 400) return;
  job.lastEmit = now;
  emit(summary(job));
}

async function start(file, settings, output) {
  if (running) throw new Error('Another video is being coloured. Pause that one first.');
  const info = await probe(file);
  const key = keyOf(file);
  const dir = dirOf(key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const chunkFrames = Math.max(1, Math.round(CHUNK_SECONDS * info.fps));
  const job = {
    key,
    input: file,
    output,
    stamp: fileStamp(file),
    settings,
    info,
    chunkFrames,
    chunks: 0, // chunks finished
    done: 0, // frames finished
    state: 'running',
    created: Date.now(),
  };
  jobs.set(key, job);
  save(job);
  launch(job);
  return summary(job);
}

function resume(file) {
  if (running) throw new Error('Another video is being coloured. Pause that one first.');
  const job = load(file);
  if (!job) throw new Error('Nothing to continue');
  if (job.state === 'done') return summary(job);
  let stamp;
  try {
    stamp = fileStamp(file);
  } catch (_) {
    throw new Error('The original video cannot be found any more');
  }
  if (stamp.size !== job.stamp.size || stamp.mtime !== job.stamp.mtime) {
    discard(file);
    throw new Error('The video has changed since it was started; start again');
  }
  job.state = 'running';
  job.error = null;
  launch(job);
  return summary(job);
}

function pause(file) {
  const job = load(file);
  if (!job || job !== running) return summary(job);
  job.stopping = true;
  for (const p of job.procs || []) p.kill();
  return summary(job);
}

function pauseAll() {
  if (running) pause(running.input);
}

function discard(file) {
  const job = load(file);
  if (!job) return null;
  if (job === running) pause(file);
  jobs.delete(job.key);
  fs.rmSync(dirOf(job.key), { recursive: true, force: true });
  return null;
}

function isRunning() {
  return !!running;
}

// ---------------------------------------------------------------- the work

// Reads fixed-size frames from a stream, with backpressure.
function frameReader(stream, frameBytes) {
  let buf = Buffer.alloc(0);
  const ready = [];
  let ended = false;
  let failed = null;
  let wake = null;
  const poke = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  stream.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length >= frameBytes) {
      ready.push(Buffer.from(buf.subarray(0, frameBytes)));
      buf = buf.subarray(frameBytes);
    }
    if (ready.length > 4) stream.pause();
    poke();
  });
  stream.on('end', () => {
    ended = true;
    poke();
  });
  stream.on('error', (e) => {
    failed = e;
    poke();
  });
  return async function next() {
    for (;;) {
      if (ready.length) {
        const f = ready.shift();
        if (ready.length <= 2) stream.resume();
        return f;
      }
      if (failed) throw failed;
      if (ended) return null;
      await new Promise((r) => (wake = r));
    }
  };
}

function write(stream, data) {
  return new Promise((resolve, reject) => {
    const ok = stream.write(data, (err) => err && reject(err));
    if (ok) return resolve();
    // When the encoder is stopped mid-write, 'drain' never comes; 'close' does.
    const done = () => {
      stream.off('drain', done);
      stream.off('close', done);
      resolve();
    };
    stream.once('drain', done);
    stream.once('close', done);
  });
}

function closed(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    proc.once('close', (code) => resolve(code));
  });
}

function stderrTail(proc) {
  let text = '';
  proc.stderr.on('data', (d) => (text = (text + d).slice(-2000)));
  return () => text.trim().split('\n').pop() || '';
}

function chunkName(i) {
  return `chunk-${String(i).padStart(5, '0')}.mp4`;
}

function launch(job) {
  process_(job).catch((err) => {
    running = null;
    job.state = 'failed';
    job.error = err.message;
    report(job, true);
  });
}

async function process_(job) {
  running = job;
  job.stopping = false;
  job.procs = [];
  job.phase = 'colouring';
  job.speed = { fps: null, samples: [] };
  report(job, true);

  const dir = dirOf(job.key);
  const { info, settings } = job;
  const preset = PRESETS[settings.preset] || PRESETS.balanced;
  const tau = FLICKER[settings.flicker] != null ? FLICKER[settings.flicker] : FLICKER.normal;
  const opts = { saturation: settings.saturation, warmth: settings.warmth };
  const W = info.outWidth;
  const H = info.outHeight;
  const ySize = W * H;
  const cSize = (W >> 1) * (H >> 1);
  // About preset.size^2 pixels, in the film's own proportions (as for photos).
  const S = C.gridFor(W, H, preset.size * preset.size);
  const gridCells = S[0] * S[1];

  // Carry-over between chunks: the last keyframe's colour, grey and signature.
  let last = null; // { idx, ab, grey, sig }
  const statePath = path.join(dir, 'state.bin');
  if (job.chunks > 0 && fs.existsSync(statePath)) {
    const raw = fs.readFileSync(statePath);
    const f = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const abLen = 2 * gridCells;
    const greyLen = gridCells;
    const thumbLen = VC.THUMB_W * VC.THUMB_H;
    let o = 0;
    const take = (len) => f.slice(o, (o += len));
    last = {
      idx: job.done - 1,
      ab: take(abLen),
      grey: take(greyLen),
      sig: { thumb: take(thumbLen), hist: f.slice(o) },
    };
  }

  const startFrame = job.chunks * job.chunkFrames;
  const decoder = ffmpeg([
    '-loglevel', 'error',
    ...(startFrame > 0 ? ['-ss', (startFrame / info.fps).toFixed(6)] : []),
    '-i', job.input,
    '-map', '0:v:0',
    '-vf', `fps=${info.rate},scale=${W}:${H}:flags=bicubic,format=yuv420p`,
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-',
  ]);
  job.procs.push(decoder);
  const decoderError = stderrTail(decoder);
  const next = frameReader(decoder.stdout, ySize + 2 * cSize);

  let encoder = null;
  let encoderError = null;
  let chunkIndex = job.chunks;
  let inChunk = 0;

  const openEncoder = () => {
    encoder = ffmpeg([
      '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${W}x${H}`, '-r', info.rate, '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      ...(info.sar ? ['-vf', `setsar=${info.sar}`] : []),
      '-video_track_timescale', '90000',
      path.join(dir, chunkName(chunkIndex + 1)),
    ]);
    encoder.stdin.on('error', () => {}); // reported through the exit code instead
    encoderError = stderrTail(encoder);
    job.procs.push(encoder);
  };

  const closeChunk = async () => {
    encoder.stdin.end();
    const code = await closed(encoder);
    job.procs = job.procs.filter((p) => p !== encoder);
    if (job.stopping) return false;
    if (code !== 0) throw new Error('Encoding failed: ' + encoderError());
    chunkIndex++;
    job.chunks = chunkIndex;
    // Save what the next chunk needs to carry on seamlessly.
    const parts = [last.ab, last.grey, last.sig.thumb, last.sig.hist];
    fs.writeFileSync(statePath, Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
    save(job);
    encoder = null;
    inChunk = 0;
    return true;
  };

  const colour = async (Y) => {
    const t0 = Date.now();
    const input = VC.modelInput(Y, W, H, S);
    const grey = input.slice(0, gridCells); // before stretching: what the frames are compared on
    const ab = C.tame(await models.run(settings.model, C.stretch(input, S), S), S);
    job.keyMs = Date.now() - t0;
    return { ab, grey };
  };

  const emitFrame = async (f, ab) => {
    if (!encoder) openEncoder();
    const out = Buffer.allocUnsafe(ySize + 2 * cSize);
    f.data.copy(out, 0, 0, ySize);
    const U = out.subarray(ySize, ySize + cSize);
    const V = out.subarray(ySize + cSize);
    VC.chroma(f.data.subarray(0, ySize), W, H, ab, S, opts, U, V);
    await write(encoder.stdin, out);
    job.done++;
    inChunk++;
    const s = job.speed.samples;
    s.push(Date.now());
    while (s.length > 2 && s[s.length - 1] - s[0] > 90000) s.shift();
    if (s.length > 5) job.speed.fps = ((s.length - 1) * 1000) / (s[s.length - 1] - s[0]);
    report(job);
  };

  // Blending between keyframes smears colour behind anything that moves, so
  // when enough of the picture has changed since the last keyframe, take a new
  // one early. Still shots stay cheap; motion gets the model's attention.
  const minGap = Math.max(1, Math.round(preset.every / 4));
  const moving = (f) => f.idx - last.idx >= minGap && VC.motion(last.sig, f.sig) > 0.2;

  // Frames waiting for the next keyframe, so their colour can be blended.
  let pending = [];

  // Turns frame `key` into a keyframe and writes out everything before it.
  const keyframe = async (key, cut) => {
    const { ab: raw, grey } = await colour(key.data.subarray(0, ySize));
    let ab = raw;
    if (last && !cut && tau > 0) {
      const dt = (key.idx - last.idx) / info.fps;
      const alpha = 1 - Math.exp(-dt / tau);
      ab = VC.smooth(last.ab, raw, last.grey, grey, alpha);
    }
    for (const f of pending) {
      const t = (f.idx - last.idx) / (key.idx - last.idx);
      const g = VC.grey(f.data.subarray(0, ySize), W, H, S);
      await emitFrame(f, VC.between(last.ab, ab, last.grey, grey, g, t));
    }
    pending = [];
    await emitFrame(key, ab);
    last = { idx: key.idx, ab, grey, sig: key.sig };
  };

  // Writes out the waiting frames of a shot that has just ended.
  const closeShot = async () => {
    if (!pending.length) return;
    const end = pending.pop();
    await keyframe(end, false);
  };

  try {
    let idx = job.done;
    let prevSig = last ? last.sig : null;
    for (;;) {
      if (job.stopping) break;
      const data = await next();
      if (!data) break;
      const sig = VC.signature(data.subarray(0, ySize), W, H);
      const f = { idx, data, sig };
      const cut = VC.isCut(prevSig, sig);
      prevSig = sig;
      idx++;

      const chunkEnd = inChunk + pending.length + 1 >= job.chunkFrames;
      if (cut) {
        await closeShot();
        await keyframe(f, true);
      } else if (!last || f.idx - last.idx >= preset.every || chunkEnd || moving(f)) {
        await keyframe(f, false);
      } else {
        pending.push(f);
      }
      if (inChunk >= job.chunkFrames && !(await closeChunk())) break;
    }

    if (!job.stopping) {
      await closeShot();
      if (encoder && !(await closeChunk())) throw new Error('stopped');
      const code = await closed(decoder);
      if (code !== 0 && !job.stopping) throw new Error('Decoding failed: ' + decoderError());
    }

    if (job.stopping) {
      if (encoder) {
        encoder.kill();
        await closed(encoder);
      }
      decoder.kill();
      // The half-finished chunk is thrown away; its frames will be redone.
      fs.rmSync(path.join(dir, chunkName(job.chunks + 1)), { force: true });
      job.done = job.chunks * job.chunkFrames;
      job.state = 'paused';
      save(job);
      return;
    }

    await finish(job);
  } catch (err) {
    for (const p of job.procs) p.kill();
    job.done = job.chunks * job.chunkFrames;
    job.state = job.stopping ? 'paused' : 'failed';
    job.error = job.stopping ? null : err.message;
    save(job);
  } finally {
    job.procs = [];
    job.phase = null;
    running = null;
    report(job, true);
  }
}

// Joins the chunks, adds the sound back and moves the film into place.
async function finish(job) {
  job.phase = 'joining';
  report(job, true);
  const dir = dirOf(job.key);
  const list = path.join(dir, 'chunks.txt');
  const names = [];
  for (let i = 1; i <= job.chunks; i++) names.push(`file '${chunkName(i)}'`);
  fs.writeFileSync(list, names.join('\n') + '\n');
  const joined = path.join(dir, 'joined.mp4');
  const { code, stderr } = await run([
    '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-i', job.input,
    '-map', '0:v:0', '-map', '1:a:0?',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    joined,
  ]);
  if (code !== 0) throw new Error('Joining failed: ' + stderr.trim().split('\n').pop());

  // ffmpeg is an outside program; on Windows, Controlled folder access may
  // refuse it where it would allow Tinge. So Tinge itself does the last move.
  try {
    try {
      fs.renameSync(joined, job.output);
    } catch (_) {
      fs.copyFileSync(joined, job.output);
    }
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      throw new Error(
        `Tinge is not allowed to save in ${path.dirname(job.output)}` +
          (process.platform === 'win32' ? ' (Controlled folder access?). ' : '. ') +
          'The coloured film is finished; choose Continue after allowing Tinge, or start it again with another folder.',
      );
    }
    throw err;
  }
  job.state = 'done';
  job.done = job.info.frames;
  job.phase = null;
  save(job);
  // Keep only job.json, so Tinge still knows where the result went.
  for (const name of fs.readdirSync(dir)) if (name !== 'job.json') fs.rmSync(path.join(dir, name), { force: true });
}

// Rough time per frame in seconds, for the estimate before starting.
function estimate(preset, msAt512) {
  const p = PRESETS[preset] || PRESETS.balanced;
  const model = (msAt512 / 1000) * (p.size / 512) ** 2;
  return model / p.every + 0.03;
}

module.exports = {
  init, isVideo, probe, frame, status, start, resume, pause, pauseAll, discard, isRunning, estimate, PRESETS, VIDEO_EXTS,
};
