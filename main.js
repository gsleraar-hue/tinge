'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const models = require('./models');

const EXTS = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.bmp', '.gif', '.avif']);

// Self-test without a screen: TINGE_SELFTEST="in.jpg|out.jpg[|model]" colours
// one photo along exactly the same path as the buttons, then quits.
const SELFTEST = process.env.TINGE_SELFTEST || null;

let win = null;

function isImage(file) {
  return EXTS.has(path.extname(file).toLowerCase());
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
          if (isImage(full)) out.push(full);
        });
    } else if (isImage(p)) {
      out.push(p);
    }
  }
  return out.map((p) => ({ path: p, name: path.basename(p), dir: path.dirname(p) }));
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
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose photos',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: [...EXTS].map((x) => x.slice(1)) }],
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
    createWindow();
  });

  // On a Mac, clicking the Dock icon with no window open brings one back.
  app.on('activate', () => {
    if (!win && app.isReady()) createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
