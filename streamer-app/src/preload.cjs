const { contextBridge, ipcRenderer } = require('electron');

console.log('[PRELOAD] Loading preload script');

try {
  contextBridge.exposeInMainWorld('electron', {
    getCaptureSources: () => ipcRenderer.invoke('get-capture-sources'),
    startCapture: (sourceId) => ipcRenderer.invoke('start-capture', sourceId),
    on: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
    once: (channel, func) => ipcRenderer.once(channel, (event, ...args) => func(...args)),
  });

  contextBridge.exposeInMainWorld('api', {
    versions: process.versions,
  });

  console.log('[PRELOAD] APIs exposed successfully');
} catch (err) {
  console.error('[PRELOAD] Error:', err.message);
}
