// ============================================
// SIGNALING CLIENT WITH AUTO-RECONNECT
// ============================================
class SignalClient {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.ws = null;
    this.listeners = {};
    this.id = Math.random().toString(36).substr(2, 9);
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = options.reconnectionAttempts || 10;
    this._reconnectDelay = options.reconnectionDelay || 1000;
    this._maxReconnectDelay = options.reconnectionDelayMax || 15000;
    this._shouldReconnect = options.reconnection !== false;
    this._intentionalClose = false;
    this._reqCounter = 0;
    this._pendingRequests = new Map();
    this.connect();
  }

  connect() {
    logger?.debug?.('Connecting to ' + this.url);
    this._intentionalClose = false;
    try {
      this.ws = new WebSocket(this.url + '/ws');

      this.ws.onopen = () => {
        logger?.info?.('WebSocket connected');
        this._reconnectAttempts = 0;
        this._fireListeners('connect');
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (!Array.isArray(data) || data.length < 2) return;
          const [eventName, eventData] = data;

          // Handle request/response pattern
          if (eventName === 'response' && eventData._reqId != null) {
            const pending = this._pendingRequests.get(eventData._reqId);
            if (pending) {
              this._pendingRequests.delete(eventData._reqId);
              if (eventData.error) {
                pending.reject(new Error(eventData.error));
              } else {
                pending.resolve(eventData);
              }
              return;
            }
          }

          this._fireListeners(eventName, eventData);
        } catch (err) {
          logger?.error?.('Parse error: ' + err.message);
        }
      };

      this.ws.onerror = (error) => {
        logger?.error?.('WebSocket error');
        this._fireListeners('error', error);
      };

      this.ws.onclose = () => {
        logger?.warn?.('WebSocket closed');
        for (const [id, pending] of this._pendingRequests) {
          pending.reject(new Error('Connection closed'));
        }
        this._pendingRequests.clear();
        this._fireListeners('disconnect');
        if (this._shouldReconnect && !this._intentionalClose) {
          this._scheduleReconnect();
        }
      };
    } catch (err) {
      logger?.error?.('Connection failed: ' + err.message);
      if (this._shouldReconnect) {
        this._scheduleReconnect();
      }
    }
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      logger?.error?.('Max reconnection attempts reached (' + this._maxReconnectAttempts + ')');
      this._fireListeners('reconnect_failed');
      return;
    }
    this._reconnectAttempts++;
    const base = Math.min(this._reconnectDelay * Math.pow(1.5, this._reconnectAttempts - 1), this._maxReconnectDelay);
    const jitter = base * 0.2 * Math.random();
    const delay = Math.round(base + jitter);
    logger?.info?.('Reconnecting in ' + delay + 'ms (attempt ' + this._reconnectAttempts + '/' + this._maxReconnectAttempts + ')');
    this._fireListeners('reconnecting', { attempt: this._reconnectAttempts, delay });
    setTimeout(() => this.connect(), delay);
  }

  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  emit(event, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify([event, data || {}]));
    }
  }

  async request(event, data = {}) {
    return new Promise((resolve, reject) => {
      const reqId = ++this._reqCounter;
      this._pendingRequests.set(reqId, { resolve, reject });
      this.emit(event, { ...data, _reqId: reqId });
      setTimeout(() => {
        if (this._pendingRequests.has(reqId)) {
          this._pendingRequests.delete(reqId);
          reject(new Error('Request timeout: ' + event));
        }
      }, 15000);
    });
  }

  close() {
    this._intentionalClose = true;
    this._shouldReconnect = false;
    for (const [id, pending] of this._pendingRequests) {
      pending.reject(new Error('Client closing'));
    }
    this._pendingRequests.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  _fireListeners(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => {
        try {
          callback(data);
        } catch (err) {
          logger?.error?.('Listener error: ' + err.message);
        }
      });
    }
  }
}

// ============================================
// DEBUG LOGGER UTILITY
// ============================================
class DebugLogger {
  constructor() {
    this.logs = [];
    this.maxLogs = 200;
  }

  getTime() {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  log(message, type = 'info') {
    const entry = { time: this.getTime(), message, type };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    console.log('[' + type.toUpperCase() + '] ' + message);
    this.render();
  }

  info(message) { this.log(message, 'info'); }
  warn(message) { this.log(message, 'warn'); }
  error(message) { this.log(message, 'error'); }
  debug(message) { this.log(message, 'debug'); }

  clear() {
    this.logs = [];
    this.render();
    this.log('Logs cleared', 'info');
  }

  render() {
    try {
      const el = document.getElementById('debugConsole');
      if (!el) return;
      el.innerHTML = this.logs.map(e =>
        '<div class="log-entry"><span class="log-time">[' + e.time + ']</span> <span class="log-' + e.type + '">' + e.message + '</span></div>'
      ).join('');
      setTimeout(() => { el.scrollTop = el.scrollHeight; }, 0);
    } catch (err) {
      console.error('[LOGGER] Render error:', err);
    }
  }
}

const logger = new DebugLogger();

// ============================================
// QUALITY PROFILES
// ============================================
const QUALITY_PROFILES = {
  performance: {
    label: 'Performance',
    hint: 'Lower resolution, smooth framerate',
    summary: '720p, 60 fps target, 8 Mbps cap',
    maxWidth: 1280,
    maxHeight: 720,
    maxFrameRate: 60,
    maxBitrate: 8_000_000,
  },
  balanced: {
    label: 'Balanced',
    hint: 'Best effort 1080p, targets 30+ fps',
    summary: '1080p, 60 fps target, 16 Mbps cap',
    maxWidth: 1920,
    maxHeight: 1080,
    maxFrameRate: 60,
    maxBitrate: 16_000_000,
  },
  quality: {
    label: 'Quality',
    hint: 'Push bitrate for sharp 1080p',
    summary: '1080p, 60 fps target, 24 Mbps cap',
    maxWidth: 1920,
    maxHeight: 1080,
    maxFrameRate: 60,
    maxBitrate: 24_000_000,
  }
};

// ============================================
// STREAMER APP (SFU MODE)
// ============================================
class StreamerApp {
  constructor() {
    try {
      this.socket = null;
      this.device = null;          // mediasoup Device
      this.sendTransport = null;   // mediasoup SendTransport
      this.videoProducer = null;   // mediasoup Producer (video)
      this.audioProducer = null;   // mediasoup Producer (audio)
      this.localStream = null;
      this.captureProfile = null;
      this.selectedProfileKey = 'balanced';
      this.includeAudio = true;
      this.isBroadcasting = false;
      this.streamerName = '';
      this.serverUrl = '';
      this.statsInterval = null;
      this.viewers = new Map();    // viewerId -> { name }
      this._prevBytesSent = 0;
      this._prevFramesEncoded = 0;
      this._prevStatsTimestamp = 0;

      logger.info('StreamerApp initializing (SFU mode)...');
      this.attachEventListeners();
      logger.info('Event listeners attached');
    } catch (err) {
      console.error('[APP] Constructor error:', err);
      logger.error('Init error: ' + err.message);
    }
  }

  attachEventListeners() {
    const connectBtn = document.getElementById('connectBtn');
    const refreshBtn = document.getElementById('refreshSourcesBtn');
    const stopBtn = document.getElementById('stopStreamBtn');
    const clearLogsBtn = document.getElementById('toggleDebug');
    const qualityProfile = document.getElementById('qualityProfile');
    const includeAudio = document.getElementById('includeAudio');

    if (connectBtn) connectBtn.addEventListener('click', () => this.connect());
    if (refreshBtn) refreshBtn.addEventListener('click', () => this.loadCaptureSources());
    if (stopBtn) stopBtn.addEventListener('click', () => this.stopStreaming());
    if (clearLogsBtn) clearLogsBtn.addEventListener('click', () => logger.clear());

    if (qualityProfile) {
      qualityProfile.value = this.selectedProfileKey;
      qualityProfile.addEventListener('change', () => this.setQualityProfile(qualityProfile.value));
      this.refreshQualityProfileUi();
    }

    if (includeAudio) {
      includeAudio.checked = this.includeAudio;
      includeAudio.addEventListener('change', () => {
        this.includeAudio = includeAudio.checked;
        logger.info('Source audio ' + (this.includeAudio ? 'enabled' : 'disabled'));
      });
    }
  }

  getActiveQualityProfile() {
    return QUALITY_PROFILES[this.selectedProfileKey] || QUALITY_PROFILES.balanced;
  }

  setQualityProfile(profileKey) {
    if (!QUALITY_PROFILES[profileKey]) {
      logger.warn('Unknown profile: ' + profileKey);
      return;
    }
    this.selectedProfileKey = profileKey;
    this.refreshQualityProfileUi();
    logger.info('Quality profile set to ' + QUALITY_PROFILES[profileKey].label);

    if (this.videoProducer) {
      this.updateProducerEncoding().catch((error) => {
        logger.warn('Could not update producer encoding: ' + error.message);
      });
    }
  }

  async updateProducerEncoding() {
    if (!this.videoProducer || !this.videoProducer.rtpSender) return;

    const profile = this.getActiveQualityProfile();
    const sender = this.videoProducer.rtpSender;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;

    params.encodings[0].maxBitrate = profile.maxBitrate;
    params.encodings[0].maxFramerate = profile.maxFrameRate;

    await sender.setParameters(params);
    logger.info('[SFU] Updated producer encoding: maxBitrate=' + (profile.maxBitrate / 1000000) + 'Mbps maxFps=' + profile.maxFrameRate);
  }

  refreshQualityProfileUi() {
    const profile = this.getActiveQualityProfile();
    const hint = document.getElementById('profileHint');
    const summary = document.getElementById('profileSummary');
    const activeProfile = document.getElementById('activeProfile');
    if (hint) hint.textContent = profile.hint;
    if (summary) summary.textContent = profile.summary;
    if (activeProfile) activeProfile.textContent = profile.label;
  }

  setStatus(status, color = 'gray') {
    const badge = document.getElementById('status');
    if (badge) {
      badge.textContent = status;
      badge.style.backgroundColor = color;
    }
  }

  async connect() {
    const serverUrlInput = document.getElementById('serverUrl');
    const streamerNameInput = document.getElementById('streamerName');

    if (!serverUrlInput || !streamerNameInput) {
      logger.error('Input elements not found');
      return;
    }

    const serverUrl = serverUrlInput.value.trim();
    const streamerName = streamerNameInput.value.trim();
    this.streamerName = streamerName;
    this.serverUrl = serverUrl;

    if (!serverUrl || !streamerName) {
      logger.error('Missing server URL or streamer name');
      alert('Please fill in all fields');
      return;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.setStatus('Connecting...', 'blue');
    logger.info('Connecting to ' + serverUrl + ' as "' + streamerName + '"');

    this.socket = new SignalClient(serverUrl, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      reconnectionAttempts: 10
    });

    this.socket.on('connect', () => {
      logger.info('CONNECTED TO SERVER');
      this.setStatus('Connected', 'green');
      this.socket.emit('register-streamer', { name: streamerName });
    });

    this.socket.on('registered', async (data) => {
      logger.info('Registered as streamer — setting up SFU transport');
      try {
        await this.setupMediasoup(data.routerRtpCapabilities);
        this.showCapturePanel();
        this.loadCaptureSources();
      } catch (error) {
        logger.error('SFU setup failed: ' + error.message);
        this.setStatus('SFU Error', 'red');
      }
    });

    this.socket.on('reconnecting', (info) => {
      this.setStatus('Reconnecting (' + info.attempt + ')...', 'orange');
    });

    this.socket.on('reconnect_failed', () => {
      this.setStatus('Connection Lost', 'red');
      logger.error('Could not reconnect to server');
    });

    this.socket.on('connect_error', (error) => {
      const msg = error && error.message ? error.message : String(error);
      logger.error('Connection error: ' + msg);
      this.setStatus('Connection Error', 'red');
    });

    this.socket.on('disconnect', () => {
      logger.warn('Disconnected from server');
      this.setStatus('Reconnecting...', 'orange');
    });

    this.socket.on('viewer-joined', (data) => {
      logger.info('Viewer joined: ' + (data.viewerName || 'Unknown') + ' (SFU handles connection)');
      this.viewers.set(data.viewerId, { name: data.viewerName || 'Unknown' });
      this.updateViewersList();
    });

    this.socket.on('viewer-left', (data) => {
      logger.info('Viewer left');
      this.viewers.delete(data.viewerId);
      this.updateViewersList();
    });

    this.socket.on('viewer-quality-report', (data) => {
      // Just log for diagnostics — no adaptation needed, SFU handles forwarding
      if (!this._qrLogCounter) this._qrLogCounter = 0;
      this._qrLogCounter++;
      if (this._qrLogCounter % 5 === 0) {
        const viewer = this.viewers.get(data.viewerId);
        const name = viewer ? viewer.name : data.viewerId;
        logger.debug('[DIAG:QR] ' + name + ' | fps=' + data.fps + ' bitrate=' + data.bitrateMbps + 'Mbps res=' + data.frameWidth + 'x' + data.frameHeight);
      }
    });
  }

  async setupMediasoup(routerRtpCapabilities) {
    this.device = new mediasoupClient.Device();
    await this.device.load({ routerRtpCapabilities });
    logger.info('[SFU] Device loaded with router capabilities');

    // Create send transport
    const transportData = await this.socket.request('create-producer-transport');

    this.sendTransport = this.device.createSendTransport({
      id: transportData.id,
      iceParameters: transportData.iceParameters,
      iceCandidates: transportData.iceCandidates,
      dtlsParameters: transportData.dtlsParameters,
    });

    this.sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await this.socket.request('connect-producer-transport', { dtlsParameters });
        callback();
      } catch (error) {
        errback(error);
      }
    });

    this.sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
      try {
        const response = await this.socket.request('produce', { kind, rtpParameters });
        callback({ id: response.producerId });
      } catch (error) {
        errback(error);
      }
    });

    this.sendTransport.on('connectionstatechange', (state) => {
      logger.info('[SFU] Send transport state: ' + state);
      if (state === 'failed') {
        logger.error('[SFU] Send transport failed — stream may be interrupted');
      }
    });

    logger.info('[SFU] Send transport created — ready to produce');
  }

  async loadCaptureSources() {
    logger.info('Loading capture sources...');
    try {
      if (!window.electron) {
        logger.error('window.electron not available');
        return;
      }

      const sources = await window.electron.getCaptureSources();
      logger.info('Found ' + sources.length + ' capture sources');

      const grid = document.getElementById('sourcesGrid');
      if (!grid) return;

      grid.innerHTML = '';

      sources.forEach(source => {
        const sourceEl = document.createElement('div');
        sourceEl.className = 'source-tile';
        sourceEl.innerHTML =
          '<img src="' + source.thumbnail + '" alt="' + source.name + '">' +
          '<p>' + source.name + '</p>' +
          '<button class="btn btn-small">Stream This</button>';
        sourceEl.querySelector('button').addEventListener('click', () => {
          logger.info('Selected: ' + source.name);
          this.startStreaming(source.id, source.name);
        });
        grid.appendChild(sourceEl);
      });
    } catch (error) {
      logger.error('Failed to load sources: ' + error.message);
    }
  }

  async startStreaming(sourceId, sourceName) {
    try {
      logger.info('Starting stream: ' + sourceName);

      const stream = await this.captureSourceStream(sourceId);

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.contentHint = 'motion';
        const settings = videoTrack.getSettings();
        this.captureProfile = {
          width: settings.width || 1280,
          height: settings.height || 720,
          frameRate: settings.frameRate || 60
        };
        const prof = this.getActiveQualityProfile();
        logger.info(
          '[DIAG:CAPTURE] actual=' + settings.width + 'x' + settings.height + '@' + Math.round(settings.frameRate || 60) + 'fps' +
          ' | profile=' + prof.label + ' maxRes=' + prof.maxWidth + 'x' + prof.maxHeight +
          ' maxBitrate=' + (prof.maxBitrate / 1000000) + 'Mbps'
        );

        // Produce video via SFU transport (single encoder for ALL viewers!)
        this.videoProducer = await this.sendTransport.produce({
          track: videoTrack,
          encodings: [{
            maxBitrate: prof.maxBitrate,
            maxFramerate: prof.maxFrameRate,
          }],
          codecOptions: {
            videoGoogleStartBitrate: 1000,
          },
        });

        logger.info('[SFU] Video producer created (id: ' + this.videoProducer.id + ')');

        this.videoProducer.on('transportclose', () => {
          logger.warn('[SFU] Video producer transport closed');
          this.videoProducer = null;
        });
      }

      // Produce audio
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        this.audioProducer = await this.sendTransport.produce({
          track: audioTracks[0],
        });
        logger.info('[SFU] Audio producer created (id: ' + this.audioProducer.id + ')');
        this.updateAudioStatus('Live');

        this.audioProducer.on('transportclose', () => {
          logger.warn('[SFU] Audio producer transport closed');
          this.audioProducer = null;
        });
      } else {
        logger.warn('Audio capture unavailable for this source');
        this.updateAudioStatus(this.includeAudio ? 'Unavailable' : 'Off');
      }

      this.localStream = stream;
      this.isBroadcasting = true;
      this.showStreamPanel();
      this.updateStreamStatus('Streaming (SFU)', 'green');
      this.updateStatsDisplay(null, null);
      this.hideCapturePanel();

      this.localStream.getTracks().forEach(track => {
        track.onended = () => {
          logger.warn('Stream track ended');
          this.stopStreaming();
        };
      });

      this.startStatsCollection();
      logger.info('[SFU] Stream live — server forwards to all viewers (single encoder!)');

    } catch (error) {
      logger.error('Failed to start stream: ' + error.message);
      this.setStatus('Stream Error', 'red');
    }
  }

  async captureSourceStream(sourceId) {
    const profile = this.getActiveQualityProfile();
    const videoConstraints = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: profile.maxWidth,
        maxHeight: profile.maxHeight,
        maxFrameRate: profile.maxFrameRate
      }
    };

    if (!this.includeAudio) {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
    }

    try {
      logger.info('Attempting audio + video capture');
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
          }
        },
        video: videoConstraints
      });
    } catch (error) {
      logger.warn('Audio capture failed, falling back to video-only: ' + error.message);
      return navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
    }
  }

  startStatsCollection() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    this._prevBytesSent = 0;
    this._prevFramesEncoded = 0;
    this._prevStatsTimestamp = 0;

    this.statsInterval = setInterval(async () => {
      if (!this.videoProducer) return;

      try {
        const stats = await this.videoProducer.getStats();
        let bitrateMbps = null;
        let fps = null;

        stats.forEach((report) => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            const now = report.timestamp;
            const bytesSent = report.bytesSent || 0;
            const framesEncoded = report.framesEncoded || 0;

            if (this._prevStatsTimestamp > 0) {
              const elapsed = (now - this._prevStatsTimestamp) / 1000;
              if (elapsed > 0) {
                bitrateMbps = ((bytesSent - this._prevBytesSent) * 8) / elapsed / 1000000;
                fps = Math.round((framesEncoded - this._prevFramesEncoded) / elapsed);
              }
            }

            this._prevBytesSent = bytesSent;
            this._prevFramesEncoded = framesEncoded;
            this._prevStatsTimestamp = now;
          }
        });

        this.updateStatsDisplay(bitrateMbps, fps);
      } catch (error) {
        // Ignore transient stats errors
      }
    }, 1000);
  }

  stopStatsCollection() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  stopStreaming() {
    logger.info('Stopping stream...');

    if (this.videoProducer) {
      this.videoProducer.close();
      this.videoProducer = null;
    }
    if (this.audioProducer) {
      this.audioProducer.close();
      this.audioProducer = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    this.captureProfile = null;
    this.updateAudioStatus('Off');

    this.stopStatsCollection();
    this.updateStatsDisplay(null, null);

    this.isBroadcasting = false;
    this.viewers.clear();
    this.updateViewersList();
    logger.info('Stream stopped');

    this.hideStreamPanel();
    this.showCapturePanel();
  }

  updateViewersList() {
    const viewerCount = document.getElementById('viewerCount');
    if (viewerCount) viewerCount.textContent = this.viewers.size;

    const list = document.getElementById('viewersList');
    if (list) {
      list.innerHTML = '';
      this.viewers.forEach((viewer, viewerId) => {
        const item = document.createElement('div');
        item.className = 'viewer-item';
        item.innerHTML = '<span>' + viewer.name + ' (SFU)</span>';
        list.appendChild(item);
      });
    }
  }

  updateStreamStatus(status) {
    const el = document.getElementById('streamStatus');
    if (el) el.textContent = status;
  }

  updateAudioStatus(status) {
    const el = document.getElementById('audioStatus');
    if (el) el.textContent = status;
  }

  updateStatsDisplay(bitrateMbps, fps) {
    const bitrateEl = document.getElementById('bitrate');
    const fpsEl = document.getElementById('fps');
    if (bitrateEl) bitrateEl.textContent = bitrateMbps == null ? '-- Mbps' : bitrateMbps.toFixed(2) + ' Mbps';
    if (fpsEl) fpsEl.textContent = fps == null ? '--' : String(Math.round(fps));
  }

  showCapturePanel() {
    const setupPanel = document.getElementById('setupPanel');
    const capturePanel = document.getElementById('capturePanel');
    const streamPanel = document.getElementById('streamPanel');
    if (setupPanel) setupPanel.style.display = 'block';
    if (capturePanel) capturePanel.style.display = 'block';
    if (streamPanel) streamPanel.style.display = 'none';
  }

  hideCapturePanel() {
    const el = document.getElementById('capturePanel');
    if (el) el.style.display = 'none';
  }

  showStreamPanel() {
    const setupPanel = document.getElementById('setupPanel');
    const capturePanel = document.getElementById('capturePanel');
    const streamPanel = document.getElementById('streamPanel');
    if (setupPanel) setupPanel.style.display = 'none';
    if (capturePanel) capturePanel.style.display = 'none';
    if (streamPanel) streamPanel.style.display = 'block';
  }

  hideStreamPanel() {
    const el = document.getElementById('streamPanel');
    if (el) el.style.display = 'none';
  }
}

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  logger.info('DOM loaded, initializing...');
  try {
    window.app = new StreamerApp();
    logger.info('App ready (SFU mode)');
  } catch (err) {
    console.error('[INIT] Failed:', err);
    logger.error('Init failed: ' + err.message);
  }
});

if (document.readyState !== 'loading' && !window.app) {
  setTimeout(() => {
    if (!window.app) {
      window.app = new StreamerApp();
      logger.info('App created (late init)');
    }
  }, 100);
}

window.logger = logger;
