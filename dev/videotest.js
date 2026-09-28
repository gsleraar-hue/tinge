'use strict';

// Colours a video without the app window: node dev/videotest.js in.mp4 out.mp4 [preset] [pauseAfterSeconds]
// Uses the models already downloaded by Tinge (in its data folder).

const path = require('path');
const os = require('os');
const models = require('../models');
const video = require('../video');

const [input, output, preset = 'fast', pauseAfter] = process.argv.slice(2);
const data = process.env.APPDATA || path.join(os.homedir(), 'Library', 'Application Support');
models.init(path.join(data, 'Tinge', 'models'));

let finished;
const done = new Promise((r) => (finished = r));
let last = '';
video.init({
  workDir: path.join(os.tmpdir(), 'tinge-videotest'),
  onProgress: (s) => {
    const line = `${s.state} ${s.phase || ''} ${s.done}/${s.total}${s.fps ? ` ${s.fps.toFixed(2)} f/s` : ''}${s.error ? ' ' + s.error : ''}`;
    if (line !== last) console.log(line);
    last = line;
    if (s.state !== 'running') finished(s);
  },
});

(async () => {
  const info = await video.probe(input);
  console.log('probe', JSON.stringify(info));
  const settings = { model: 'natural', preset, flicker: 'normal', saturation: 1, warmth: 0 };
  const t0 = Date.now();
  await video.start(input, settings, output);
  if (pauseAfter) {
    setTimeout(() => video.pause(input), Number(pauseAfter) * 1000);
    const s = await done;
    console.log('paused at', s.done, 'frames; resuming');
    const again = new Promise((r) => (finished = r));
    video.resume(input);
    await again;
  } else {
    await done;
  }
  console.log('total', ((Date.now() - t0) / 1000).toFixed(1), 's');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
