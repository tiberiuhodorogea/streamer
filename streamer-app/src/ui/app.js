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
    // Exponential backoff with jitter
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

  close() {
    this._intentionalClose = true;
    this._shouldReconnect = false;
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
    degradationPreference: 'balanced'
  },
  balanced: {
    label: 'Balanced',
    hint: 'Best effort 1080p, targets 30+ fps',
    summary: '1080p, 60 fps target, 16 Mbps cap',
    maxWidth: 1920,
    maxHeight: 1080,
    maxFrameRate: 60,
    maxBitrate: 16_000_000,
    degradationPreference: 'balanced'
  },
  quality: {
    label: 'Quality',
    hint: 'Push bitrate for sharp 1080p',
    summary: '1080p, 60 fps target, 24 Mbps cap',
    maxWidth: 1920,
    maxHeight: 1080,
    maxFrameRate: 60,
    maxBitrate: 24_000_000,
    degradationPreference: 'balanced'
  }
};

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: ['stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302'] },
  { urls: ['stun:stun4.l.google.com:19302'] }
];

// ============================================
// STREAMER APP
// ============================================
class StreamerApp {
  constructor() {
    try {
      this.socket = null;
      this.peers = new Map();
      this.peerSnapshots = new Map();
      this.localStream = null;
      this.captureProfile = null;
      this.selectedProfileKey = 'balanced';
      this.includeAudio = true;
      this.isBroadcasting = false;
      this.streamerName = '';
      this.serverUrl = '';
      this.statsInterval = null;

      logger.info('StreamerApp initializing...');
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

    if (this.localStream) {
      this.applyLiveProfile().catch((error) => {
        logger.warn('Could not fully apply live profile: ' + error.message);
      });
    }
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

    // Close existing connection if any
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
      this.showCapturePanel();
      this.loadCaptureSources();
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
      logger.info('Viewer joined: ' + (data.viewerName || 'Unknown'));
      this.handleViewerJoined(data);
    });

    this.socket.on('viewer-left', (data) => {
      logger.info('Viewer left');
      this.handleViewerLeft(data);
    });

    this.socket.on('answer', (data) => {
      this.handleAnswer(data);
    });

    this.socket.on('ice-candidate', (data) => {
      this.handleIceCandidate(data);
    });

    this.socket.on('viewer-quality-report', (data) => {
      this.handleViewerQualityReport(data);
    });
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
          ' maxBitrate=' + (prof.maxBitrate / 1000000) + 'Mbps degradPref=' + prof.degradationPreference
        );
      }

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        logger.info('Audio capture active (' + audioTracks.length + ' track)');
        this.updateAudioStatus('Live');
      } else {
        logger.warn('Audio capture unavailable for this source');
        this.updateAudioStatus(this.includeAudio ? 'Unavailable' : 'Off');
      }

      this.localStream = stream;
      this.isBroadcasting = true;
      this.showStreamPanel();
      this.updateStreamStatus('Streaming', 'green');
      this.updateStatsDisplay(null, null);
      this.hideCapturePanel();

      this.localStream.getTracks().forEach(track => {
        track.onended = () => {
          logger.warn('Stream track ended');
          this.stopStreaming();
        };
      });

      logger.info('Stream ready - waiting for viewers');

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

  handleViewerJoined(data) {
    const { viewerId, viewerName } = data;
    logger.info('Setting up peer connection for: ' + viewerName);

    if (!this.localStream) {
      logger.error('Cannot create peer before stream is ready');
      return;
    }

    try {
      const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS,
        bundlePolicy: 'max-bundle',
        sdpSemantics: 'unified-plan'
      });

      this.localStream.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, this.localStream);
        if (track.kind === 'video') {
          this.configureVideoSender(sender, viewerName);
        }
      });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.socket.emit('ice-candidate', { targetId: viewerId, candidate: event.candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        logger.info('Peer ' + viewerName + ' state: ' + state);

        if (state === 'failed') {
          // Attempt ICE restart before dropping
          this.attemptIceRestart(viewerId);
        } else if (state === 'closed') {
          this.removePeer(viewerId);
        } else if (state === 'disconnected') {
          // Give it a few seconds to recover before acting
          setTimeout(() => {
            const peer = this.peers.get(viewerId);
            if (peer && peer.connection.connectionState === 'disconnected') {
              this.attemptIceRestart(viewerId);
            }
          }, 3000);
        }
      };

      this.peers.set(viewerId, {
        id: viewerId,
        name: viewerName,
        status: 'connecting',
        connection: pc,
        lastReportAt: 0,
        iceRestarts: 0,
        videoSender: pc.getSenders().find((s) => s.track?.kind === 'video') || null
      });
      this.updateViewersList();
      this.ensureStatsCollection();

      // When a new peer joins, reconfigure ALL existing peers with adjusted bitrate budgets
      this.reconfigureAllSenders();

      this.createAndSendOffer(viewerId).catch((error) => {
        logger.error('Offer creation failed for ' + viewerName + ': ' + error.message);
      });
    } catch (error) {
      logger.error('Viewer join failed: ' + error.message);
    }
  }

  async attemptIceRestart(viewerId) {
    const peer = this.peers.get(viewerId);
    if (!peer || !peer.connection) return;

    if (peer.iceRestarts >= 2) {
      logger.warn('Max ICE restarts reached for ' + peer.name + ', dropping peer');
      this.removePeer(viewerId);
      return;
    }

    peer.iceRestarts++;
    logger.info('Attempting ICE restart for ' + peer.name + ' (attempt ' + peer.iceRestarts + ')');

    try {
      const offer = await peer.connection.createOffer({ iceRestart: true });
      await peer.connection.setLocalDescription(offer);
      this.socket.emit('offer', { viewerId, offer: peer.connection.localDescription });
    } catch (error) {
      logger.error('ICE restart failed for ' + peer.name + ': ' + error.message);
      this.removePeer(viewerId);
    }
  }

  async createAndSendOffer(viewerId) {
    const peer = this.peers.get(viewerId);
    if (!peer || !peer.connection) return;

    const offer = await peer.connection.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false
    });

    await peer.connection.setLocalDescription(offer);
    peer.status = 'offer-sent';
    this.updateViewersList();

    logger.info('Sending offer to ' + peer.name);
    this.socket.emit('offer', { viewerId, offer: peer.connection.localDescription });
  }

  async configureVideoSender(sender, viewerName) {
    if (!sender) return;

    try {
      const profile = this.getActiveQualityProfile();
      const sourceWidth = this.captureProfile?.width || 1280;
      const targetWidth = Math.min(sourceWidth, profile.maxWidth);
      const scaleResolutionDownBy = sourceWidth > targetWidth ? sourceWidth / targetWidth : 1;

      // Give each peer the full bitrate budget — Chrome's BWE will handle actual throughput.
      // Dividing bitrate per peer just hurts quality without reducing encoder load.
      const parameters = sender.getParameters();
      parameters.degradationPreference = profile.degradationPreference;
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = profile.maxBitrate;
      parameters.encodings[0].maxFramerate = profile.maxFrameRate;
      parameters.encodings[0].priority = 'high';
      parameters.encodings[0].networkPriority = 'high';

      if (scaleResolutionDownBy > 1) {
        parameters.encodings[0].scaleResolutionDownBy = scaleResolutionDownBy;
      } else {
        delete parameters.encodings[0].scaleResolutionDownBy;
      }

      await sender.setParameters(parameters);

      const enc = parameters.encodings[0];
      logger.info(
        '[DIAG:SENDER] ' + viewerName + ' | profile=' + profile.label +
        ' peers=' + this.peers.size + ' | maxBitrate=' + (enc.maxBitrate / 1000000).toFixed(1) + 'Mbps' +
        ' maxFps=' + enc.maxFramerate +
        ' scaleDown=' + (enc.scaleResolutionDownBy || 1).toFixed(2) +
        ' degradPref=' + (parameters.degradationPreference || 'none')
      );
    } catch (error) {
      logger.warn('Could not tune sender for ' + viewerName + ': ' + error.message);
    }
  }

  async handleViewerQualityReport(data) {
    const { viewerId, fps, jitterMs } = data;
    const peer = this.peers.get(viewerId);
    if (!peer) return;

    // No custom adaptation — WebRTC's built-in BWE handles congestion.
    // Just log for diagnostics.
    const now = Date.now();
    if (now - peer.lastReportAt < 900) return;
    peer.lastReportAt = now;

    if (!this._qrLogCounter) this._qrLogCounter = 0;
    this._qrLogCounter++;
    if (this._qrLogCounter % 5 === 0) {
      logger.debug('[DIAG:QR] ' + peer.name + ' | fps=' + fps + ' jitter=' + Math.round(jitterMs || 0) + 'ms');
    }
  }

  reconfigureAllSenders() {
    const peerCount = this.peers.size;
    logger.info('Reconfiguring all senders for ' + peerCount + ' peer(s)');
    for (const peer of this.peers.values()) {
      if (peer.videoSender) {
        this.configureVideoSender(peer.videoSender, peer.name).catch((err) => {
          logger.warn('Reconfigure failed for ' + peer.name + ': ' + err.message);
        });
      }
    }
  }

  async applyLiveProfile() {
    const profile = this.getActiveQualityProfile();
    const videoTrack = this.localStream?.getVideoTracks?.()[0];

    if (videoTrack) {
      try {
        await videoTrack.applyConstraints({
          width: { max: profile.maxWidth },
          height: { max: profile.maxHeight },
          frameRate: { max: profile.maxFrameRate }
        });
        logger.info('Applied capture constraints for ' + profile.label);
      } catch (error) {
        logger.warn('Could not apply capture constraints: ' + error.message);
      }
    }

    for (const peer of this.peers.values()) {
      const sender = peer.connection?.getSenders?.().find((s) => s.track?.kind === 'video');
      await this.configureVideoSender(sender, peer.name);
    }
  }

  async handleAnswer(data) {
    const { viewerId, answer } = data;
    const peer = this.peers.get(viewerId);
    if (!peer || !peer.connection) {
      logger.warn('Answer for unknown viewer ' + viewerId);
      return;
    }

    try {
      await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
      peer.status = 'connected';
      peer.iceRestarts = 0; // Reset restart counter on successful connection
      this.updateViewersList();
      this.ensureStatsCollection();
      logger.info('Remote answer applied for ' + peer.name);
    } catch (error) {
      logger.error('Failed to apply answer for ' + peer.name + ': ' + error.message);
    }
  }

  async handleIceCandidate(data) {
    const { from, candidate } = data;
    const peer = this.peers.get(from);
    if (!peer || !peer.connection || !candidate) return;

    try {
      await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      logger.error('Failed to add ICE candidate for ' + peer.name + ': ' + error.message);
    }
  }

  handleViewerLeft(data) {
    this.removePeer(data.viewerId);
  }

  removePeer(viewerId) {
    const peer = this.peers.get(viewerId);
    if (!peer) return;

    if (peer.connection) {
      peer.connection.onicecandidate = null;
      peer.connection.onconnectionstatechange = null;
      peer.connection.close();
    }

    this.peers.delete(viewerId);
    this.peerSnapshots.delete(viewerId);
    this.updateViewersList();

    if (this.peers.size === 0) {
      this.stopStatsCollection();
      this.updateStatsDisplay(null, null);
    } else {
      // Remaining peers get more bitrate budget now
      this.reconfigureAllSenders();
    }
  }

  updateViewersList() {
    const count = this.peers.size;
    const viewerCount = document.getElementById('viewerCount');
    if (viewerCount) viewerCount.textContent = count;

    const list = document.getElementById('viewersList');
    if (list) {
      list.innerHTML = '';
      this.peers.forEach((peer, viewerId) => {
        const item = document.createElement('div');
        item.className = 'viewer-item';
        item.innerHTML = '<span>' + (peer.name || viewerId.substring(0, 8)) + ' (' + (peer.status || 'idle') + ')</span>';
        list.appendChild(item);
      });
    }
  }

  stopStreaming() {
    logger.info('Stopping stream...');
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    this.captureProfile = null;
    this.updateAudioStatus('Off');

    this.stopStatsCollection();
    this.updateStatsDisplay(null, null);

    this.peers.forEach((peer, viewerId) => {
      this.removePeer(viewerId);
    });
    this.peers.clear();
    logger.info('Stream stopped');

    this.isBroadcasting = false;
    this.hideStreamPanel();
    this.showCapturePanel();
  }

  updateStreamStatus(status) {
    const el = document.getElementById('streamStatus');
    if (el) el.textContent = status;
  }

  updateAudioStatus(status) {
    const el = document.getElementById('audioStatus');
    if (el) el.textContent = status;
  }

  ensureStatsCollection() {
    if (this.statsInterval || this.peers.size === 0) return;
    this.statsInterval = setInterval(() => {
      this.collectOutboundStats().catch((error) => {
        logger.error('Stats collection error: ' + error.message);
      });
    }, 1000);
  }

  stopStatsCollection() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  async collectOutboundStats() {
    let totalBitrateMbps = 0;
    let fpsSamples = [];

    for (const [viewerId, peer] of this.peers.entries()) {
      if (!peer.connection) continue;

      const stats = await peer.connection.getStats();
      stats.forEach((report) => {
        if (report.type !== 'outbound-rtp' || report.kind !== 'video') return;

        const previous = this.peerSnapshots.get(viewerId) || {
          timestamp: report.timestamp,
          bytesSent: report.bytesSent || 0,
          framesEncoded: report.framesEncoded || 0
        };

        const elapsed = (report.timestamp - previous.timestamp) / 1000;
        if (elapsed > 0) {
          const bytesDelta = (report.bytesSent || 0) - previous.bytesSent;
          const frameDelta = (report.framesEncoded || 0) - previous.framesEncoded;
          if (bytesDelta >= 0) totalBitrateMbps += (bytesDelta * 8) / elapsed / 1000000;
          if (frameDelta >= 0) fpsSamples.push(frameDelta / elapsed);
        }

        this.peerSnapshots.set(viewerId, {
          timestamp: report.timestamp,
          bytesSent: report.bytesSent || 0,
          framesEncoded: report.framesEncoded || 0
        });
      });
    }

    const avgFps = fpsSamples.length > 0
      ? fpsSamples.reduce((sum, v) => sum + v, 0) / fpsSamples.length
      : null;

    // Log full outbound stats every 5 seconds
    if (!this._diagStatsCounter) this._diagStatsCounter = 0;
    this._diagStatsCounter++;
    if (this._diagStatsCounter % 5 === 0) {
      const peerSummaries = [];
      for (const [vid, p] of this.peers.entries()) {
        peerSummaries.push(p.name + ':L' + p.qualityLevel);
      }
      logger.info(
        '[DIAG:OUTBOUND] bitrate=' + totalBitrateMbps.toFixed(2) + 'Mbps fps=' +
        (avgFps != null ? Math.round(avgFps) : '--') +
        ' peers=[' + peerSummaries.join(', ') + ']'
      );
    }

    this.updateStatsDisplay(totalBitrateMbps, avgFps);
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
    logger.info('App ready');
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
