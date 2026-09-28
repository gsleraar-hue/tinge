'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const models = require('./models');
const video = require('./video');

const EXTS = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.bmp', '.gif', '.avif']);

// Self-test without a screen: TINGE_SELFTEST="in.jpg|out.jpg[|model]" colours
// one photo along exactly the same path as the buttons, then quits.
const SELFTEST = process.env.TINGE_SELFTEST || null;

let win = null;

function isImage(file) {
  return EXTS.has(path.extname(file).toLowerCase());
}

function kindOf(file) {
  if (isImage(file)) return 'photo';
  if (video.isVideo(file)) return 'video';
  return null;
}

function expand(paths) {
  const out = [];
  for (const p of paths) {
    let st;
    try {
      st = fs.statSync(p);
    } catch (_) {
      continue;
    }
    if (st.isDirectory()) {
      let names = [];
      try {
        names = fs.readdirSync(p);
      } catch (_) {}
      names
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .forEach((n) => {
          const full = path.join(p, n);
          if (kindOf(full)) out.push(full);
        });
    } else if (kindOf(p)) {
      out.push(p);
    }
  }
  return out.map((p) => ({ path: p, name: path.basename(p), dir: path.dirname(p), kind: kindOf(p) }));
}

function explainWriteError(err, file) {
  if (err.code === 'EPERM' || err.code === 'EACCES') {
    if (process.platform === 'win32') {
      return (
        `Windows did not let Tinge write to ${path.dirname(file)}. ` +
        'Controlled folder access is probably switched on (Windows Security > ' +
        'Ransomware protection). Pick another folder, or allow Tinge there.'
      );
    }
    return `Tinge is not allowed to write to ${path.dirname(file)}. Pick another folder.`;
  }
  return err.message;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#111214',
    title: 'Tinge',
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: !SELFTEST && !process.env.TINGE_HIDDEN,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));

  // Closing mid-film pauses it; the work done so far is kept.
  win.on('close', (e) => {
    if (!video.isRunning()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Keep colouring', 'Pause and close'],
      defaultId: 0,
      cancelId: 0,
      message: 'Tinge is colouring a video.',
      detail: 'If you close now, the video pauses. Everything finished so far is kept, and you can continue next time.',
    });
    if (choice === 0) e.preventDefault();
    else video.pauseAll();
  });
}

// ---------------------------------------------------------------- ipc

ipcMain.handle('models:status', () => models.status());

ipcMain.handle('models:download', async (e, id) => {
  try {
    await models.download(id, (p) => {
      if (!e.sender.isDestroyed()) e.sender.send('models:progress', p);
    });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('models:warm', async (_e, id) => {
  try {
    await models.session(id);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('colorize', async (_e, id, input, size) => {
  try {
    const t0 = Date.now();
    const ab = await models.run(id, input, size);
    return { ab, ms: Date.now() - t0 };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('files:open', async () => {
  const images = [...EXTS].map((x) => x.slice(1));
  const videos = [...video.VIDEO_EXTS].map((x) => x.slice(1));
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose photos or videos',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Photos and videos', extensions: [...images, ...videos] },
      { name: 'Photos', extensions: images },
      { name: 'Videos', extensions: videos },
    ],
  });
  return r.canceled ? [] : expand(r.filePaths);
});

ipcMain.handle('files:expand', (_e, paths) => expand(paths || []));

ipcMain.handle('files:read', async (_e, file) => {
  try {
    return await fs.promises.readFile(file);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('files:join', (_e, dir, name) => path.join(dir, name));

ipcMain.handle('files:saveAs', async (_e, defaultPath) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save coloured photo',
    defaultPath,
    filters: [
      { name: 'JPEG', extensions: ['jpg'] },
      { name: 'PNG', extensions: ['png'] },
      { name: 'WebP', extensions: ['webp'] },
    ],
  });
  if (r.canceled || !r.filePath) return null;
  return { path: r.filePath, name: path.basename(r.filePath) };
});

ipcMain.handle('files:chooseFolder', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Folder for the coloured photos',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('files:uniqueName', (_e, dir, base, ext) => {
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base} ${i}${ext}`;
  return path.join(dir, name);
});

ipcMain.handle('files:write', async (_e, file, data) => {
  try {
    await fs.promises.writeFile(file, Buffer.from(data));
    return { ok: true, path: file };
  } catch (err) {
    return { error: explainWriteError(err, file) };
  }
});

ipcMain.handle('shell:show', (_e, file) => shell.showItemInFolder(file));

// ---------------------------------------------------------------- video

const wrap = (fn) => async (_e, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return { error: err.message };
  }
};

ipcMain.handle('video:probe', wrap((file) => video.probe(file)));
ipcMain.handle('video:frame', wrap((file, t) => video.frame(file, t)));
ipcMain.handle('video:status', wrap((file) => video.status(file)));
ipcMain.handle('video:start', wrap((file, settings, output) => video.start(file, settings, output)));
ipcMain.handle('video:resume', wrap((file) => video.resume(file)));
ipcMain.handle('video:pause', wrap((file) => video.pause(file)));
ipcMain.handle('video:discard', wrap((file) => video.discard(file)));
ipcMain.handle('video:estimate', (_e, preset, msAt512) => video.estimate(preset, msAt512));

ipcMain.handle('video:saveAs', async (_e, defaultPath) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save coloured video',
    defaultPath,
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
});

// A film can take all night; the computer must not doze off halfway.
let sleepBlock = null;
function onVideoProgress(s) {
  const busy = s && s.state === 'running';
  if (busy && sleepBlock === null) sleepBlock = powerSaveBlocker.start('prevent-app-suspension');
  if (!busy && sleepBlock !== null) {
    powerSaveBlocker.stop(sleepBlock);
    sleepBlock = null;
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('video:progress', s);
    if (process.platform === 'win32' || process.platform === 'darwin') {
      win.setProgressBar(busy && s.total ? s.done / s.total : -1);
    }
  }
}

ipcMain.handle('selftest:get', () => {
  if (!SELFTEST) return null;
  const [input, output, model] = SELFTEST.split('|');
  return { input, output, model: model || 'natural' };
});

ipcMain.handle('selftest:done', (_e, report) => {
  const file = path.join(app.getPath('userData'), 'selftest.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  app.exit(report && report.ok ? 0 : 1);
});

// ---------------------------------------------------------------- app

// Test runs (see above) may run next to a Tinge that is already open.
if (!SELFTEST && !process.env.TINGE_HIDDEN && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    models.init(path.join(app.getPath('userData'), 'models'));
    video.init({ workDir: path.join(app.getPath('userData'), 'video'), onProgress: onVideoProgress });
    createWindow();
  });

  // On a Mac, clicking the Dock icon with no window open brings one back.
  app.on('activate', () => {
    if (!win && app.isReady()) createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
