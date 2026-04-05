/**
 * game-capture-native — JavaScript wrapper with graceful degradation.
 *
 * If the native addon is built, exports its full API.
 * If not (missing build tools, wrong platform), exports null-safe stubs
 * so the rest of the app keeps working with the PowerShell fallback.
 */

let addon = null;

try {
  addon = require('./build/Release/game_capture.node');
} catch (_) {
  try {
    addon = require('./build/Debug/game_capture.node');
  } catch (__) {
    // Native addon not built — all exports will be stubs
  }
}

/** @returns {{ hwnd: number, pid: number, name: string }[]} */
function enumGameWindows() {
  if (addon && typeof addon.enumGameWindows === 'function') {
    return addon.enumGameWindows();
  }
  return [];
}

function isProcessAudioSupported() {
  return !!(addon && typeof addon.isProcessAudioSupported === 'function' && addon.isProcessAudioSupported());
}

function startProcessAudioCapture(pid) {
  if (!addon || typeof addon.startProcessAudioCapture !== 'function') {
    throw new Error('Native process audio capture not available');
  }
  return addon.startProcessAudioCapture(pid);
}

function stopProcessAudioCapture() {
  if (addon && typeof addon.stopProcessAudioCapture === 'function') {
    return addon.stopProcessAudioCapture();
  }
}

function registerAudioCallback(callback) {
  if (!addon || typeof addon.registerAudioCallback !== 'function') {
    throw new Error('Native process audio capture not available');
  }
  return addon.registerAudioCallback(callback);
}

// ── Native video capture (DXGI Desktop Duplication) ──

function startVideoCapture(opts) {
  if (!addon || typeof addon.startVideoCapture !== 'function') {
    throw new Error('Native video capture not available');
  }
  return addon.startVideoCapture(opts || {});
}

function stopVideoCapture() {
  if (addon && typeof addon.stopVideoCapture === 'function') {
    return addon.stopVideoCapture();
  }
}

function registerVideoCallback(callback) {
  if (!addon || typeof addon.registerVideoCallback !== 'function') {
    throw new Error('Native video capture not available');
  }
  return addon.registerVideoCallback(callback);
}

function isVideoCapturing() {
  return !!(addon && typeof addon.isVideoCapturing === 'function' && addon.isVideoCapturing());
}

module.exports = {
  enumGameWindows,
  isProcessAudioSupported,
  startProcessAudioCapture,
  stopProcessAudioCapture,
  registerAudioCallback,
  startVideoCapture,
  stopVideoCapture,
  registerVideoCallback,
  isVideoCapturing,
  /** True if the compiled .node binary loaded successfully */
  available: !!addon,
};
