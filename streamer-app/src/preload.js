import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  getCaptureSources: () => ipcRenderer.invoke('get-capture-sources'),
  startCapture: (sourceId) => ipcRenderer.invoke('start-capture', sourceId),
  on: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
  once: (channel, func) => ipcRenderer.once(channel, (event, ...args) => func(...args)),
});

contextBridge.exposeInMainWorld('api', {
  versions: process.versions,
});
