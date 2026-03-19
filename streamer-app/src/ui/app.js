// ============================================
// WEBSOCKET CLIENT WITH SOCKET.IO PROTOCOL
// ============================================
class SocketIOClient {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.ws = null;
    this.listeners = {};
    this.id = Math.random().toString(36).substr(2, 9);
    this.transport = 'websocket';
    this.messageId = 0;
    this.connect();
  }

  connect() {
    logger?.debug?.(`🔌 Connecting to ${this.url}`);
    try {
      this.ws = new WebSocket(this.url + '/ws');

      this.ws.onopen = () => {
        logger?.info?.('✅ WebSocket connected');
        this._fireListeners('connect');
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const [eventName, eventData] = data;
          this._fireListeners(eventName, eventData);
        } catch (err) {
          logger?.error?.(`Parse error: ${err.message}`);
        }
      };

      this.ws.onerror = (error) => {
        logger?.error?.(`WebSocket error`);
        this._fireListeners('error', error);
      };

      this.ws.onclose = () => {
        logger?.warn?.(`⚠️ WebSocket closed`);
        this._fireListeners('disconnect');
      };
    } catch (err) {
      logger?.error?.(`Connection failed: ${err.message}`);
    }
  }

  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  emit(event, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify([event, data || {}]);
      this.ws.send(payload);
    }
  }

  _fireListeners(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => {
        try {
          callback(data);
        } catch (err) {
          logger?.error?.(`Listener error: ${err.message}`);
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
    this.maxLogs = 100;
    console.log('[LOGGER] DebugLogger initialized');
  }

  getTime() {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  log(message, type = 'info') {
    const entry = {
      time: this.getTime(),
      message,
      type
    };
    this.logs.push(entry);
    
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Always log to browser console
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    // Render to debug panel
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
      const debugConsole = document.getElementById('debugConsole');
      if (!debugConsole) {
        console.warn('[LOGGER] debugConsole element not found');
        return;
      }

      debugConsole.innerHTML = this.logs.map(entry => `
        <div class="log-entry">
          <span class="log-time">[${entry.time}]</span>
          <span class="log-${entry.type}">${entry.message}</span>
        </div>
      `).join('');

      // Auto-scroll to bottom
      setTimeout(() => {
        debugConsole.scrollTop = debugConsole.scrollHeight;
      }, 0);
    } catch (err) {
      console.error('[LOGGER] Error rendering:', err);
    }
  }
}

const logger = new DebugLogger();

const QUALITY_PROFILES = {
  smooth: {
    label: 'Smooth FPS',
    hint: '720p with headroom for high motion',
    summary: '1280x720 cap, 60 fps target, 10 Mbps cap',
    maxWidth: 1280,
    maxHeight: 720,
    maxFrameRate: 60,
    maxBitrate: 10_000_000,
    degradationPreference: 'maintain-framerate'
  },
  balanced: {
    label: 'Balanced',
    hint: 'Balanced for most sessions',
    summary: '1920x1080 cap, 60 fps target, 16 Mbps cap',
    maxWidth: 1920,
    maxHeight: 1080,
    maxFrameRate: 60,
    maxBitrate: 16_000_000,
    degradationPreference: 'maintain-framerate'
  },
  quality: {
    label: 'High Quality',
    hint: 'Sharper image for strong links',
    summary: '2560x1440 cap, 60 fps target, 24 Mbps cap',
    maxWidth: 2560,
    maxHeight: 1440,
    maxFrameRate: 60,
    maxBitrate: 24_000_000,
    degradationPreference: 'balanced'
  },
  ultra: {
    label: 'Ultra',
    hint: 'Push quality hard on excellent links',
    summary: 'Native capture cap, 60 fps target, 35 Mbps cap',
    maxWidth: 3840,
    maxHeight: 2160,
    maxFrameRate: 60,
    maxBitrate: 35_000_000,
    degradationPreference: 'balanced'
  }
};

// ============================================
// STREAMER APP
// ============================================
class StreamerApp {
  constructor() {
    try {
      console.log('[APP] StreamerApp constructor called');
      this.socket = null;
      this.peers = new Map();
      this.peerSnapshots = new Map();
      this.localStream = null;
      this.captureProfile = null;
      this.selectedProfileKey = 'balanced';
      this.includeAudio = true;
      this.isBroadcasting = false;
      this.streamerName = '';
      this.statsInterval = null;
      this.adaptationLevels = [
        { label: 'base', bitrateScale: 1, extraScale: 1 },
        { label: 'step-1', bitrateScale: 0.8, extraScale: 1.25 },
        { label: 'step-2', bitrateScale: 0.6, extraScale: 1.6 },
        { label: 'step-3', bitrateScale: 0.45, extraScale: 2.0 }
      ];
      
      logger.info('🚀 StreamerApp initializing...');
      this.attachEventListeners();
      logger.info('✅ Event listeners attached');
    } catch (err) {
      console.error('[APP] Constructor error:', err);
      logger.error(`❌ Init error: ${err.message}`);
    }
  }

  attachEventListeners() {
    console.log('[APP] Attaching event listeners...');
    
    const connectBtn = document.getElementById('connectBtn');
    const refreshBtn = document.getElementById('refreshSourcesBtn');
    const stopBtn = document.getElementById('stopStreamBtn');
    const clearLogsBtn = document.getElementById('toggleDebug');
    const qualityProfile = document.getElementById('qualityProfile');
    const includeAudio = document.getElementById('includeAudio');

    console.log('[APP] Connect button found:', !!connectBtn);
    console.log('[APP] Refresh button found:', !!refreshBtn);
    console.log('[APP] Stop button found:', !!stopBtn);
    console.log('[APP] Clear logs button found:', !!clearLogsBtn);

    if (connectBtn) {
      connectBtn.addEventListener('click', (e) => {
        console.log('[APP] Connect button clicked!', e);
        logger.debug('🔘 Connect button clicked');
        this.connect();
      });
      logger.debug('✅ Connect listener attached');
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        logger.debug('🔘 Refresh button clicked');
        this.loadCaptureSources();
      });
      logger.debug('✅ Refresh listener attached');
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        logger.debug('🔘 Stop button clicked');
        this.stopStreaming();
      });
      logger.debug('✅ Stop listener attached');
    }

    if (clearLogsBtn) {
      clearLogsBtn.addEventListener('click', () => {
        logger.clear();
      });
      logger.debug('✅ Clear logs listener attached');
    }

    if (qualityProfile) {
      qualityProfile.value = this.selectedProfileKey;
      qualityProfile.addEventListener('change', () => {
        this.setQualityProfile(qualityProfile.value);
      });
      this.refreshQualityProfileUi();
      logger.debug('✅ Quality profile listener attached');
    }

    if (includeAudio) {
      includeAudio.checked = this.includeAudio;
      includeAudio.addEventListener('change', () => {
        this.includeAudio = includeAudio.checked;
        logger.info(`🔊 Source audio ${this.includeAudio ? 'enabled' : 'disabled'}`);
      });
      logger.debug('✅ Include audio listener attached');
    }
  }

  getActiveQualityProfile() {
    return QUALITY_PROFILES[this.selectedProfileKey] || QUALITY_PROFILES.balanced;
  }

  setQualityProfile(profileKey) {
    if (!QUALITY_PROFILES[profileKey]) {
      logger.warn(`⚠️ Unknown profile requested: ${profileKey}`);
      return;
    }

    this.selectedProfileKey = profileKey;
    this.refreshQualityProfileUi();
    logger.info(`🎛️ Quality profile set to ${QUALITY_PROFILES[profileKey].label}`);

    if (this.localStream) {
      this.applyLiveProfile().catch((error) => {
        logger.warn(`⚠️ Could not fully apply live profile: ${error.message}`);
      });
    }
  }

  refreshQualityProfileUi() {
    const profile = this.getActiveQualityProfile();
    const hint = document.getElementById('profileHint');
    const summary = document.getElementById('profileSummary');
    const activeProfile = document.getElementById('activeProfile');

    if (hint) {
      hint.textContent = profile.hint;
    }
    if (summary) {
      summary.textContent = profile.summary;
    }
    if (activeProfile) {
      activeProfile.textContent = profile.label;
    }
  }

  setStatus(status, color = 'gray') {
    try {
      const badge = document.getElementById('status');
      if (badge) {
        badge.textContent = status;
        badge.style.backgroundColor = color;
      }
      logger.debug(`📊 Status: ${status} (${color})`);
    } catch (err) {
      logger.error(`Failed to set status: ${err.message}`);
    }
  }

  async connect() {
    try {
      logger.info('═══════════════════════════════════════');
      logger.info('📡 CONNECT INITIATED');
      logger.info('═══════════════════════════════════════');

      const serverUrlInput = document.getElementById('serverUrl');
      const streamerNameInput = document.getElementById('streamerName');

      if (!serverUrlInput || !streamerNameInput) {
        logger.error('❌ Input elements not found');
        return;
      }

      const serverUrl = serverUrlInput.value.trim();
      const streamerName = streamerNameInput.value.trim();
      this.streamerName = streamerName;

      logger.debug(`Server URL input: "${serverUrl}"`);
      logger.debug(`Streamer name input: "${streamerName}"`);

      if (!serverUrl || !streamerName) {
        logger.error('❌ Missing server URL or streamer name');
        alert('Please fill in all fields');
        return;
      }

      this.setStatus('Connecting...', 'blue');
      logger.info(`📡 Connecting to ${serverUrl} as "${streamerName}"`);

      try {
        logger.debug('🔌 Creating Socket.io connection...');
        
        this.socket = new SocketIOClient(serverUrl, {
          reconnection: true,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 5000,
          reconnectionAttempts: 5
        });

        logger.debug('🔌 Socket.io instance created');

        this.socket.on('connect', () => {
          logger.info('═══════════════════════════════════════');
          logger.info('✅ CONNECTED TO SERVER!');
          logger.info('═══════════════════════════════════════');
          this.setStatus('Connected', 'green');
          logger.debug(`📤 Registering streamer: ${streamerName}`);
          this.socket.emit('register-streamer', { name: streamerName });
          this.showCapturePanel();
          this.loadCaptureSources();
        });

        this.socket.on('connect_error', (error) => {
          logger.error(`❌ Connection error: ${error.message || error}`);
          this.setStatus('Connection Error', 'red');
        });

        this.socket.on('disconnect', (reason) => {
          logger.warn(`⚠️ Disconnected: ${reason}`);
          this.setStatus('Disconnected', 'red');
          this.hideCapturePanel();
          this.hideStreamPanel();
        });

        this.socket.on('viewer-joined', (data) => {
          logger.info(`👁️ Viewer joined: ${data.viewerName || 'Unknown'}`);
          this.handleViewerJoined(data);
        });

        this.socket.on('viewer-left', (data) => {
          logger.info(`👋 Viewer left`);
          this.handleViewerLeft(data);
        });

        this.socket.on('answer', (data) => {
          logger.debug('📨 Received WebRTC answer');
          this.handleAnswer(data);
        });

        this.socket.on('ice-candidate', (data) => {
          logger.debug('❄️ Received ICE candidate');
          this.handleIceCandidate(data);
        });

        this.socket.on('viewer-quality-report', (data) => {
          this.handleViewerQualityReport(data);
        });

      } catch (socketErr) {
        logger.error(`❌ Socket.io error: ${socketErr.message}`);
        this.setStatus('Error', 'red');
      }

    } catch (error) {
      logger.error(`❌ Connect error: ${error.message}`);
      logger.debug(`Stack: ${error.stack}`);
      this.setStatus('Error', 'red');
    }
  }

  async loadCaptureSources() {
    logger.info('📷 Loading capture sources...');
    try {
      if (!window.electron) {
        logger.error('❌ window.electron not available');
        return;
      }

      const sources = await window.electron.getCaptureSources();
      logger.info(`✅ Found ${sources.length} capture sources`);
      
      sources.forEach((s, i) => {
        logger.debug(`  ${i + 1}. ${s.name}`);
      });

      const grid = document.getElementById('sourcesGrid');
      if (!grid) {
        logger.error('❌ sourcesGrid element not found');
        return;
      }

      grid.innerHTML = '';

      sources.forEach(source => {
        const sourceEl = document.createElement('div');
        sourceEl.className = 'source-tile';
        sourceEl.innerHTML = `
          <img src="${source.thumbnail}" alt="${source.name}">
          <p>${source.name}</p>
          <button class="btn btn-small">Stream This</button>
        `;
        sourceEl.querySelector('button').addEventListener('click', () => {
          logger.info(`📺 Selected: ${source.name}`);
          this.startStreaming(source.id, source.name);
        });
        grid.appendChild(sourceEl);
      });
    } catch (error) {
      logger.error(`❌ Failed to load sources: ${error.message}`);
      logger.debug(`Stack: ${error.stack}`);
    }
  }

  async startStreaming(sourceId, sourceName) {
    try {
      logger.info(`🎥 Starting stream: ${sourceName}`);
      logger.debug(`Using source ID: ${sourceId}`);

      const stream = await this.captureSourceStream(sourceId);

      logger.info('✅ Display media obtained');
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.contentHint = 'motion';
        const settings = videoTrack.getSettings();
        this.captureProfile = {
          width: settings.width || 1280,
          height: settings.height || 720,
          frameRate: settings.frameRate || 60
        };
        logger.info(`📐 ${settings.width}x${settings.height} @ ${settings.frameRate}fps`);
        logger.info(`⚙️ Active profile: ${this.getActiveQualityProfile().label}`);
      }

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        logger.info(`🔊 Audio capture active (${audioTracks.length} track)`);
        this.updateAudioStatus('Live');
      } else {
        logger.warn('⚠️ Audio capture unavailable for this source');
        this.updateAudioStatus(this.includeAudio ? 'Unavailable' : 'Off');
      }

      this.localStream = stream;
      this.isBroadcasting = true;
      this.showStreamPanel();
      this.updateStreamStatus('Streaming', 'green');
      this.updateStatsDisplay(null, null);
      this.hideCapturePanel();

      // Track when stream ends
      this.localStream.getTracks().forEach(track => {
        track.onended = () => {
          logger.warn('⚠️ Stream ended');
          this.stopStreaming();
        };
      });

      logger.info('✅ Stream ready - waiting for viewers to connect');

    } catch (error) {
      logger.error(`❌ Failed to start stream: ${error.message}`);
      logger.debug(`Error: ${error.name}`);
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
      return navigator.mediaDevices.getUserMedia({
        audio: false,
        video: videoConstraints
      });
    }

    try {
      logger.info('🔊 Attempting to capture source audio');
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
      logger.warn(`⚠️ Audio capture failed, falling back to video-only: ${error.message}`);
      return navigator.mediaDevices.getUserMedia({
        audio: false,
        video: videoConstraints
      });
    }
  }

  handleViewerJoined(data) {
    const { viewerId, viewerName } = data;
    logger.info(`🤝 Viewer connection established: ${viewerName}`);

    if (!this.localStream) {
      logger.error('❌ Cannot create peer connection before stream is ready');
      return;
    }

    try {
      const peerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: ['stun:stun.l.google.com:19302'] },
          { urls: ['stun:stun1.l.google.com:19302'] }
        ]
      });

      this.localStream.getTracks().forEach((track) => {
        const sender = peerConnection.addTrack(track, this.localStream);
        if (track.kind === 'video') {
          this.configureVideoSender(sender, viewerName);
        }
      });

      peerConnection.onicecandidate = (event) => {
        if (!event.candidate) {
          return;
        }

        this.socket.emit('ice-candidate', {
          targetId: viewerId,
          candidate: event.candidate
        });
      };

      peerConnection.onconnectionstatechange = () => {
        logger.info(`🔗 Peer ${viewerName} state: ${peerConnection.connectionState}`);
        if (
          peerConnection.connectionState === 'failed' ||
          peerConnection.connectionState === 'closed' ||
          peerConnection.connectionState === 'disconnected'
        ) {
          this.removePeer(viewerId);
        }
      };

      this.peers.set(viewerId, {
        id: viewerId,
        name: viewerName,
        status: 'connecting',
        connection: peerConnection,
        qualityLevel: 0,
        goodReports: 0,
        lastReportAt: 0,
        videoSender: peerConnection.getSenders().find((item) => item.track?.kind === 'video') || null
      });
      this.updateViewersList();
      this.ensureStatsCollection();

      this.createAndSendOffer(viewerId).catch((error) => {
        logger.error(`❌ Offer creation failed for ${viewerName}: ${error.message}`);
      });
    } catch (error) {
      logger.error(`❌ Viewer join failed: ${error.message}`);
    }
  }

  async createAndSendOffer(viewerId) {
    const peer = this.peers.get(viewerId);
    if (!peer || !peer.connection) {
      logger.error(`❌ Missing peer connection for viewer ${viewerId}`);
      return;
    }

    const offer = await peer.connection.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false
    });

    await peer.connection.setLocalDescription(offer);
    peer.status = 'offer-sent';
    this.updateViewersList();

    logger.info(`📤 Sending offer to ${peer.name}`);
    this.socket.emit('offer', {
      viewerId,
      offer: peer.connection.localDescription
    });
  }

  async configureVideoSender(sender, viewerName) {
    if (!sender) {
      return;
    }

    try {
      const profile = this.getActiveQualityProfile();
      const peer = Array.from(this.peers.values()).find((entry) => entry.videoSender === sender || entry.name === viewerName);
      const adaptation = this.adaptationLevels[peer?.qualityLevel || 0] || this.adaptationLevels[0];
      const sourceWidth = this.captureProfile?.width || 1280;
      const targetWidth = Math.min(sourceWidth, profile.maxWidth);
      const baseScale = sourceWidth > targetWidth ? sourceWidth / targetWidth : 1;
      const scaleResolutionDownBy = baseScale * adaptation.extraScale;

      const parameters = sender.getParameters();
      parameters.degradationPreference = profile.degradationPreference;
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = Math.round(profile.maxBitrate * adaptation.bitrateScale);
      parameters.encodings[0].maxFramerate = profile.maxFrameRate;
      if (scaleResolutionDownBy > 1) {
        parameters.encodings[0].scaleResolutionDownBy = scaleResolutionDownBy;
      } else {
        delete parameters.encodings[0].scaleResolutionDownBy;
      }

      await sender.setParameters(parameters);

      logger.info(
        `⚙️ Sender tuned for ${viewerName}: ${profile.label}/${adaptation.label}, ${targetWidth}w max, ${profile.maxFrameRate}fps target, ${(parameters.encodings[0].maxBitrate / 1000000).toFixed(1)} Mbps cap`
      );
    } catch (error) {
      logger.warn(`⚠️ Could not tune video sender for ${viewerName}: ${error.message}`);
    }
  }

  async handleViewerQualityReport(data) {
    const { viewerId, fps, jitterMs } = data;
    const peer = this.peers.get(viewerId);
    if (!peer || !peer.videoSender) {
      return;
    }

    const now = Date.now();
    if (now - peer.lastReportAt < 900) {
      return;
    }
    peer.lastReportAt = now;

    if (fps != null && fps < 20 && peer.qualityLevel < this.adaptationLevels.length - 1) {
      peer.qualityLevel += 1;
      peer.goodReports = 0;
      logger.warn(`📉 ${peer.name} is falling behind (${fps} fps, ${Math.round(jitterMs || 0)} ms jitter). Lowering quality.`);
      await this.configureVideoSender(peer.videoSender, peer.name);
      return;
    }

    if (fps != null && fps > 48 && (jitterMs || 0) < 80) {
      peer.goodReports += 1;
      if (peer.goodReports >= 5 && peer.qualityLevel > 0) {
        peer.qualityLevel -= 1;
        peer.goodReports = 0;
        logger.info(`📈 ${peer.name} recovered (${fps} fps). Raising quality.`);
        await this.configureVideoSender(peer.videoSender, peer.name);
      }
      return;
    }

    peer.goodReports = 0;
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
        logger.info(`🎚️ Applied capture constraints for ${profile.label}`);
      } catch (error) {
        logger.warn(`⚠️ Could not apply capture constraints: ${error.message}`);
      }
    }

    for (const peer of this.peers.values()) {
      const sender = peer.connection?.getSenders?.().find((item) => item.track?.kind === 'video');
      await this.configureVideoSender(sender, peer.name);
    }
  }

  async handleAnswer(data) {
    const { viewerId, answer } = data;
    const peer = this.peers.get(viewerId);
    if (!peer || !peer.connection) {
      logger.warn(`⚠️ Received answer for unknown viewer ${viewerId}`);
      return;
    }

    try {
      await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
      peer.status = 'connected';
      this.updateViewersList();
      this.ensureStatsCollection();
      logger.info(`✅ Remote answer applied for ${peer.name}`);
    } catch (error) {
      logger.error(`❌ Failed to apply answer for ${peer.name}: ${error.message}`);
    }
  }

  async handleIceCandidate(data) {
    const { from, candidate } = data;
    const peer = this.peers.get(from);
    if (!peer || !peer.connection || !candidate) {
      logger.warn(`⚠️ ICE candidate ignored for unknown viewer ${from}`);
      return;
    }

    try {
      await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
      logger.debug(`✅ ICE candidate added for ${peer.name}`);
    } catch (error) {
      logger.error(`❌ Failed to add ICE candidate for ${peer.name}: ${error.message}`);
    }
  }

  handleViewerLeft(data) {
    const { viewerId } = data;
    this.removePeer(viewerId);
  }

  removePeer(viewerId) {
    const peer = this.peers.get(viewerId);
    if (!peer) {
      return;
    }

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
    }
  }

  updateViewersList() {
    const count = this.peers.size;
    const viewerCount = document.getElementById('viewerCount');
    if (viewerCount) {
      viewerCount.textContent = count;
    }
    logger.debug(`👥 Viewers: ${count}`);

    const list = document.getElementById('viewersList');
    if (list) {
      list.innerHTML = '';
      this.peers.forEach((peer, viewerId) => {
        const item = document.createElement('div');
        item.className = 'viewer-item';
        item.innerHTML = `<span>${peer.name || viewerId.substring(0, 8)} (${peer.status || 'idle'})</span>`;
        list.appendChild(item);
      });
    }
  }

  stopStreaming() {
    logger.info('🛑 Stopping stream...');
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
    logger.info('✅ Stream stopped');

    this.isBroadcasting = false;
    this.hideStreamPanel();
    this.showCapturePanel();
  }

  updateStreamStatus(status, color) {
    const statusEl = document.getElementById('streamStatus');
    if (statusEl) {
      statusEl.textContent = status;
    }
  }

  updateAudioStatus(status) {
    const audioEl = document.getElementById('audioStatus');
    if (audioEl) {
      audioEl.textContent = status;
    }
  }

  ensureStatsCollection() {
    if (this.statsInterval || this.peers.size === 0) {
      return;
    }

    this.statsInterval = setInterval(() => {
      this.collectOutboundStats().catch((error) => {
        logger.error(`❌ Error collecting outbound stats: ${error.message}`);
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
      if (!peer.connection) {
        continue;
      }

      const stats = await peer.connection.getStats();
      stats.forEach((report) => {
        if (report.type !== 'outbound-rtp' || report.kind !== 'video') {
          return;
        }

        const previous = this.peerSnapshots.get(viewerId) || {
          timestamp: report.timestamp,
          bytesSent: report.bytesSent || 0,
          framesEncoded: report.framesEncoded || 0
        };

        const elapsedSeconds = (report.timestamp - previous.timestamp) / 1000;
        if (elapsedSeconds > 0) {
          const bytesDelta = (report.bytesSent || 0) - previous.bytesSent;
          const framesDelta = (report.framesEncoded || 0) - previous.framesEncoded;

          if (bytesDelta >= 0) {
            totalBitrateMbps += (bytesDelta * 8) / elapsedSeconds / 1000000;
          }

          if (framesDelta >= 0) {
            fpsSamples.push(framesDelta / elapsedSeconds);
          }
        }

        this.peerSnapshots.set(viewerId, {
          timestamp: report.timestamp,
          bytesSent: report.bytesSent || 0,
          framesEncoded: report.framesEncoded || 0
        });
      });
    }

    const averageFps = fpsSamples.length > 0
      ? fpsSamples.reduce((sum, value) => sum + value, 0) / fpsSamples.length
      : null;

    this.updateStatsDisplay(totalBitrateMbps, averageFps);
  }

  updateStatsDisplay(bitrateMbps, fps) {
    const bitrateEl = document.getElementById('bitrate');
    const fpsEl = document.getElementById('fps');

    if (bitrateEl) {
      bitrateEl.textContent = bitrateMbps == null ? '-- Mbps' : `${bitrateMbps.toFixed(2)} Mbps`;
    }

    if (fpsEl) {
      fpsEl.textContent = fps == null ? '--' : `${Math.round(fps)}`;
    }
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
    const capturePanel = document.getElementById('capturePanel');
    if (capturePanel) capturePanel.style.display = 'none';
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
    const streamPanel = document.getElementById('streamPanel');
    if (streamPanel) streamPanel.style.display = 'none';
  }
}

// ============================================
// INITIALIZATION
// ============================================

console.log('[INIT] Script loading...');

document.addEventListener('DOMContentLoaded', () => {
  console.log('[INIT] DOM ready');
  logger.info('📄 DOM loaded, initializing app...');
  
  try {
    window.app = new StreamerApp();
    logger.info('🎉 App ready! You can now connect.');
  } catch (err) {
    console.error('[INIT] App initialization failed:', err);
    logger.error(`❌ Init failed: ${err.message}`);
  }
});

// Fallback if DOM already loaded
if (document.readyState === 'loading') {
  console.log('[INIT] Document still loading, waiting for DOMContentLoaded');
} else {
  console.log('[INIT] Document already loaded, initializing immediately');
  setTimeout(() => {
    logger.info('📄 Late init, creating app...');
    if (!window.app) {
      window.app = new StreamerApp();
      logger.info('🎉 App created!');
    }
  }, 100);
}

// Expose logger globally
window.logger = logger;
