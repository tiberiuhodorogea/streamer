const { contextBridge, ipcRenderer } = require('electron');

console.log('[PRELOAD] Loading preload script');

try {
  contextBridge.exposeInMainWorld('electron', {
    getCaptureSources: () => ipcRenderer.invoke('get-capture-sources'),
    startCapture: (sourceId) => ipcRenderer.invoke('start-capture', sourceId),
    prepareForCapture: () => ipcRenderer.invoke('prepare-for-capture'),
    restoreAfterCapture: () => ipcRenderer.invoke('restore-after-capture'),

    // Session logging — writes structured entries to session JSONL on disk
    sessionLog: (type, payload) => ipcRenderer.invoke('session-log', { type, payload }),
    getSessionDir: () => ipcRenderer.invoke('get-session-dir'),

    // Process audio APIs
    isNativeProcessAudioAvailable: () => ipcRenderer.invoke('native-process-audio-available'),
    startNativeProcessAudio: (opts) => ipcRenderer.invoke('start-native-process-audio', opts),
    stopNativeProcessAudio: () => ipcRenderer.invoke('stop-native-process-audio'),

    onGameAudioChunk: (callback) => {
      ipcRenderer.removeAllListeners('game-audio-chunk');
      ipcRenderer.on('game-audio-chunk', (_event, buffer, meta) => {
        callback(buffer, meta);
      });
    },
    removeGameAudioChunkListener: () => {
      ipcRenderer.removeAllListeners('game-audio-chunk');
    },

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
