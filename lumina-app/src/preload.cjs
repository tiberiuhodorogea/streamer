const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

let nativeCapture = null;
let nativeVideoListener = null;
let nativeVideoCallbackRegistered = false;

try {
  nativeCapture = require(path.join(__dirname, '..', 'native'));
  if (nativeCapture?.available) {
    console.log('[PRELOAD] Native video bridge available in renderer process');
  }
} catch (err) {
  console.warn('[PRELOAD] Native video bridge unavailable:', err.message);
}

function hasNativeVideoBridge() {
  return !!(
    nativeCapture?.available &&
    typeof nativeCapture.startVideoCapture === 'function' &&
    typeof nativeCapture.stopVideoCapture === 'function' &&
    typeof nativeCapture.registerVideoCallback === 'function'
  );
}

function ensureNativeVideoCallback() {
  if (!hasNativeVideoBridge() || nativeVideoCallbackRegistered) {
    return;
  }

  nativeCapture.registerVideoCallback((pixels, meta) => {
    if (typeof nativeVideoListener !== 'function') {
      return;
    }

    const forwardedAtEpochMs = Date.now();
    const forwardedMeta = {
      ...meta,
      mainForwardedAtEpochMs: forwardedAtEpochMs,
      bridgeForwardedAtEpochMs: forwardedAtEpochMs,
      bridgeMode: 'preload-direct',
      captureToBridgeMs: meta?.epochTimestampUs
        ? Math.max(0, forwardedAtEpochMs - (meta.epochTimestampUs / 1000))
        : null,
    };

    try {
      nativeVideoListener(pixels.buffer, forwardedMeta);
    } catch (err) {
      console.warn('[PRELOAD] Direct native video callback failed:', err.message);
    }
  });

  nativeVideoCallbackRegistered = true;
}

function bindNativeLogPathForSession(sessionDirName) {
  if (!sessionDirName) {
    return null;
  }
  const sessionDir = path.join(__dirname, '..', '..', 'logs', 'sessions', sessionDirName);
  const nativeLogPath = path.join(sessionDir, 'native-addon.log');
  process.env.LUMINA_NATIVE_LOG_PATH = nativeLogPath;
  return { sessionDir, nativeLogPath };
}

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
    bindSignalingSessionDir: async (sessionDirName) => {
      const localBinding = bindNativeLogPathForSession(sessionDirName);
      const mainBinding = await ipcRenderer.invoke('bind-signaling-session-dir', { sessionDirName });
      return {
        success: !!mainBinding?.success,
        sessionDirName,
        mainBinding,
        localBinding,
      };
    },

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

    // Native video capture APIs (DXGI Desktop Duplication)
    isNativeVideoCaptureAvailable: () => hasNativeVideoBridge(),
    startNativeVideoCapture: (opts) => {
      if (!hasNativeVideoBridge()) {
        return { success: false, reason: 'preload-native-video-unavailable' };
      }

      ensureNativeVideoCallback();
      const result = nativeCapture.startVideoCapture(opts || {});
      if (result && typeof result === 'object') {
        return {
          ...result,
          bridgeMode: 'preload-direct',
        };
      }
      return result;
    },
    stopNativeVideoCapture: () => {
      if (!hasNativeVideoBridge()) {
        return { success: false, reason: 'preload-native-video-unavailable' };
      }

      const result = nativeCapture.stopVideoCapture();
      return {
        success: !!result,
        bridgeMode: 'preload-direct',
      };
    },

    onGameVideoFrame: (callback) => {
      nativeVideoListener = callback;
    },
    removeGameVideoFrameListener: () => {
      nativeVideoListener = null;
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
