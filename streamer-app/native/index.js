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

/** @returns {boolean} */
function isSupported() {
  if (addon && typeof addon.isSupported === 'function') {
    return addon.isSupported();
  }
  return false;
}

/**
 * Start capturing a window by HWND using Windows Graphics Capture.
 * @param {number} hwnd
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 */
function startCapture(hwnd, width, height, fps) {
  if (!addon || typeof addon.startCapture !== 'function') {
    throw new Error('Native capture addon not available');
  }
  return addon.startCapture(hwnd, width, height, fps);
}

function stopCapture() {
  if (addon && typeof addon.stopCapture === 'function') {
    return addon.stopCapture();
  }
}

/**
 * Register a callback to receive captured frames.
 * Callback signature: (buffer: Uint8Array, meta: {width, height, frameIndex}) => void
 * Called on the Node.js main thread each time WGC delivers a new frame.
 */
function registerFrameCallback(callback) {
  if (!addon || typeof addon.registerFrameCallback !== 'function') {
    throw new Error('Native capture addon not available');
  }
  return addon.registerFrameCallback(callback);
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

module.exports = {
  enumGameWindows,
  isSupported,
  startCapture,
  stopCapture,
  registerFrameCallback,
  isProcessAudioSupported,
  startProcessAudioCapture,
  stopProcessAudioCapture,
  registerAudioCallback,
  /** True if the compiled .node binary loaded successfully */
  available: !!addon,
};
