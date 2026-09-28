'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tinge', {
  modelStatus: () => ipcRenderer.invoke('models:status'),
  downloadModel: (id) => ipcRenderer.invoke('models:download', id),
  warmModel: (id) => ipcRenderer.invoke('models:warm', id),
  onProgress: (fn) => ipcRenderer.on('models:progress', (_e, p) => fn(p)),
  colorize: (id, input, size) => ipcRenderer.invoke('colorize', id, input, size),

  openFiles: () => ipcRenderer.invoke('files:open'),
  expand: (paths) => ipcRenderer.invoke('files:expand', paths),
  pathFor: (file) => webUtils.getPathForFile(file),
  read: (file) => ipcRenderer.invoke('files:read', file),
  join: (dir, name) => ipcRenderer.invoke('files:join', dir, name),
  platform: process.platform,
  saveAs: (defaultPath) => ipcRenderer.invoke('files:saveAs', defaultPath),
  chooseFolder: (defaultPath) => ipcRenderer.invoke('files:chooseFolder', defaultPath),
  uniqueName: (dir, base, ext) => ipcRenderer.invoke('files:uniqueName', dir, base, ext),
  write: (file, data) => ipcRenderer.invoke('files:write', file, data),
  show: (file) => ipcRenderer.invoke('shell:show', file),

  video: {
    probe: (file) => ipcRenderer.invoke('video:probe', file),
    frame: (file, t) => ipcRenderer.invoke('video:frame', file, t),
    status: (file) => ipcRenderer.invoke('video:status', file),
    start: (file, settings, output) => ipcRenderer.invoke('video:start', file, settings, output),
    resume: (file) => ipcRenderer.invoke('video:resume', file),
    pause: (file) => ipcRenderer.invoke('video:pause', file),
    discard: (file) => ipcRenderer.invoke('video:discard', file),
    estimate: (preset, msAt512) => ipcRenderer.invoke('video:estimate', preset, msAt512),
    saveAs: (defaultPath) => ipcRenderer.invoke('video:saveAs', defaultPath),
    onProgress: (fn) => ipcRenderer.on('video:progress', (_e, s) => fn(s)),
  },

  selftest: () => ipcRenderer.invoke('selftest:get'),
  selftestDone: (report) => ipcRenderer.invoke('selftest:done', report),
});
