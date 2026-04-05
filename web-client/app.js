// ============================================
// SIGNALING CLIENT WITH AUTO-RECONNECT
// ============================================
class RawSignalClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.listeners = {};
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 10;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 15000;
    this._shouldReconnect = true;
    this._intentionalClose = false;
    this._reqCounter = 0;
    this._pendingRequests = new Map();
    this.connect();
  }

  normalizedUrl() {
    const baseUrl = this.url
      .replace(/^http:\/\//i, 'ws://')
      .replace(/^https:\/\//i, 'wss://');
    return baseUrl.endsWith('/ws') ? baseUrl : baseUrl + '/ws';
  }

  connect() {
    this._intentionalClose = false;
    const wsUrl = this.normalizedUrl();
    debugConsole.info('Opening WebSocket: ' + wsUrl);
    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this._reconnectAttempts = 0;
        this.fire('connect');
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (!Array.isArray(msg) || msg.length < 2) return;
          const [eventName, payload] = msg;

          // Handle request/response pattern
          if (eventName === 'response' && payload._reqId != null) {
            const pending = this._pendingRequests.get(payload._reqId);
            if (pending) {
              this._pendingRequests.delete(payload._reqId);
              if (payload.error) {
                pending.reject(new Error(payload.error));
              } else {
                pending.resolve(payload);
              }
              return;
            }
          }

          this.fire(eventName, payload);
        } catch (error) {
          debugConsole.error('WebSocket parse error: ' + error.message);
        }
      };

      this.ws.onerror = () => {
        this.fire('connect_error', new Error('websocket error'));
      };

      this.ws.onclose = () => {
        for (const [id, pending] of this._pendingRequests) {
          pending.reject(new Error('Connection closed'));
        }
        this._pendingRequests.clear();
        this.fire('disconnect', 'socket closed');
        if (this._shouldReconnect && !this._intentionalClose) {
          this._scheduleReconnect();
        }
      };
    } catch (err) {
      debugConsole.error('Connection failed: ' + err.message);
      if (this._shouldReconnect) {
        this._scheduleReconnect();
      }
    }
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      debugConsole.error('Max reconnection attempts reached');
      this.fire('reconnect_failed');
      return;
    }
    this._reconnectAttempts++;
    const base = Math.min(this._reconnectDelay * Math.pow(1.5, this._reconnectAttempts - 1), this._maxReconnectDelay);
    const jitter = base * 0.2 * Math.random();
    const delay = Math.round(base + jitter);
    debugConsole.info('Reconnecting in ' + delay + 'ms (attempt ' + this._reconnectAttempts + ')');
    this.fire('reconnecting', { attempt: this._reconnectAttempts, delay });
    setTimeout(() => this.connect(), delay);
  }

  on(eventName, callback) {
    if (!this.listeners[eventName]) {
      this.listeners[eventName] = [];
    }
    this.listeners[eventName].push(callback);
  }

  emit(eventName, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      debugConsole.warn('Cannot send ' + eventName + ': socket not open');
      return;
    }
    this.ws.send(JSON.stringify([eventName, payload || {}]));
  }

  async request(eventName, data = {}) {
    return new Promise((resolve, reject) => {
      const reqId = ++this._reqCounter;
      this._pendingRequests.set(reqId, { resolve, reject });
      this.emit(eventName, { ...data, _reqId: reqId });
      setTimeout(() => {
        if (this._pendingRequests.has(reqId)) {
          this._pendingRequests.delete(reqId);
          reject(new Error('Request timeout: ' + eventName));
        }
      }, 15000);
    });
  }

  disconnect() {
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

  fire(eventName, payload) {
    const callbacks = this.listeners[eventName] || [];
    callbacks.forEach((cb) => cb(payload));
  }
}

// ============================================
// DEBUG CONSOLE
// ============================================
class DebugConsole {
  constructor() {
    this.lines = [];
    this.maxLines = 200;
  }

  write(level, message) {
    const time = new Date().toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    this.lines.push({ level, message, time });
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
    this.render();
  }

  info(message) { console.log(message); this.write('info', message); }
  warn(message) { console.warn(message); this.write('warn', message); }
  error(message) { console.error(message); this.write('error', message); }
  success(message) { console.log(message); this.write('success', message); }

  clear() {
    this.lines = [];
    this.render();
  }

  render() {
    const root = document.getElementById('debugConsole');
    if (!root) return;
    root.innerHTML = this.lines.map((line) =>
      '<div class="debug-line"><span class="debug-time">[' + line.time + ']</span> <span class="debug-' + line.level + '">' + line.message + '</span></div>'
    ).join('');
    root.scrollTop = root.scrollHeight;
  }
}

const debugConsole = new DebugConsole();
const VIEWER_BUILD_ID = 'viewer-sfu-2';

window.addEventListener('error', (event) => {
  debugConsole.error('Window error: ' + event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  const message = event.reason?.message || String(event.reason);
  debugConsole.error('Unhandled rejection: ' + message);
});

// ============================================
// VIEWER APP (SFU MODE)
// ============================================
class ViewerApp {
  constructor() {
    this.socket = null;
    this.device = null;           // mediasoup Device
    this.recvTransport = null;    // mediasoup RecvTransport
    this.consumers = new Map();   // consumerId -> mediasoup Consumer
    this.remoteStream = null;
    this.selectedLumina = null;
    this.selectedLuminaName = '';
    this.signalingSessionInfo = null;
    this._pageLoadedAtIso = new Date().toISOString();
    this.statsInterval = null;
    this.connectTimeout = null;
    this.audioMuted = true;
    this.statsOverlayVisible = true;
    this._socketConnected = false;
    this._pendingStreamRecovery = false;
    this._recoveringActiveStream = false;
    this._transportRecoveryTimer = null;
    this._localTransportClose = false;
    // Stats tracking
    this._prevBytesReceived = 0;
    this._prevFramesDecoded = 0;
    this._prevStatsTimestamp = 0;

    this.prefillServerUrl();
    this.initializeUI();
    debugConsole.info('Viewer app initialized (SFU mode) build=' + VIEWER_BUILD_ID + ' loadedAt=' + this._pageLoadedAtIso);
  }

  prefillServerUrl() {
    const input = document.getElementById('serverUrl');
    if (!input) return;

    const isDefaultLocal = !input.value || /localhost|127\.0\.0\.1/i.test(input.value);
    if (!isDefaultLocal) return;

    const wsScheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const host = window.location.hostname || 'localhost';
    input.value = wsScheme + host + ':4000';
  }

  initializeUI() {
    document.getElementById('connectBtn').addEventListener('click', () => this.connect());
    document.getElementById('refreshStreamsBtn').addEventListener('click', () => this.loadAvailableStreams());
    document.getElementById('disconnectBtn').addEventListener('click', () => this.disconnect());
    document.getElementById('clearDebugBtn').addEventListener('click', () => debugConsole.clear());
    document.getElementById('dismissErrorBtn').addEventListener('click', () => this.hideError());
    document.getElementById('errorModal').addEventListener('click', (event) => {
      if (event.target.id === 'errorModal') this.hideError();
    });
    document.getElementById('playPauseBtn').addEventListener('click', () => this.togglePlayback());
    document.getElementById('muteBtn').addEventListener('click', () => this.toggleMute());
    document.getElementById('fullscreenBtn').addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('statsToggleBtn').addEventListener('click', () => this.toggleStatsOverlay());
    document.getElementById('remoteVideo').addEventListener('dblclick', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => this.syncFullscreenButton());
    document.addEventListener('webkitfullscreenchange', () => this.syncFullscreenButton());
    this.syncStatsOverlay();
  }

  getServerUrl() {
    return document.getElementById('serverUrl').value.trim();
  }

  getHttpUrl() {
    return this.getServerUrl().replace('ws://', 'http://').replace('wss://', 'https://');
  }

  setStatus(status, color = 'gray') {
    const badge = document.getElementById('status');
    badge.textContent = status;
    badge.style.backgroundColor = color;
  }

  hideError() {
    document.body.classList.remove('modal-open');
    document.getElementById('errorModal').style.display = 'none';
  }

  async exitFullscreenIfNeeded() {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fullscreenElement) return;

    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } catch (error) {
      debugConsole.warn('Could not exit fullscreen cleanly: ' + error.message);
    }
  }

  showError(message) {
    debugConsole.error(message);
    document.getElementById('errorMessage').textContent = message;
    this.exitFullscreenIfNeeded().finally(() => {
      document.body.classList.add('modal-open');
      document.getElementById('errorModal').style.display = 'flex';
    });
  }

  setOverlayState(label) {
    const stateNode = document.getElementById('overlayState');
    if (stateNode) stateNode.textContent = label;
  }

  clearTransportRecoveryTimer() {
    if (this._transportRecoveryTimer) {
      clearTimeout(this._transportRecoveryTimer);
      this._transportRecoveryTimer = null;
    }
  }

  scheduleActiveStreamRecovery(reason) {
    if (this._localTransportClose || !this.selectedLumina) return;
    this.clearTransportRecoveryTimer();
    this._pendingStreamRecovery = true;
    this.setOverlayState('Recovering');
    document.getElementById('connectionQuality').textContent = 'Recovering';
    debugConsole.warn('Scheduling stream recovery: ' + reason);
    this._transportRecoveryTimer = setTimeout(() => {
      this.recoverActiveStream(reason);
    }, 1500);
  }

  recoverActiveStream(reason) {
    if (!this.selectedLumina) return;
    if (this._recoveringActiveStream) return;

    this.clearTransportRecoveryTimer();
    this._pendingStreamRecovery = true;
    this._recoveringActiveStream = true;
    this.setStatus('Recovering Stream...', 'orange');
    this.setOverlayState('Recovering');
    document.getElementById('connectionQuality').textContent = 'Recovering';
    debugConsole.warn('Attempting stream recovery: ' + reason);

    this.removeConnection({ preserveSelection: true, keepPlayerVisible: true });

    if (!this.socket || !this._socketConnected) {
      debugConsole.info('Waiting for signaling reconnect before rejoining active stream');
      return;
    }

    const viewerName = document.getElementById('viewerName').value;
    this.socket.emit('join-streamer', {
      streamerId: this.selectedLumina,
      viewerName,
    });
  }

  syncStatsOverlay() {
    const overlay = document.getElementById('statsOverlay');
    const btn = document.getElementById('statsToggleBtn');
    overlay.style.display = this.statsOverlayVisible ? 'block' : 'none';
    btn.textContent = this.statsOverlayVisible ? 'Hide Stats' : 'Stats';
  }

  async connect() {
    const serverUrl = this.getServerUrl();
    const viewerName = document.getElementById('viewerName').value.trim();

    debugConsole.info('Connect requested');
    debugConsole.info('Server: ' + serverUrl);
    this.hideError();

    if (!serverUrl || !viewerName) {
      this.showError('Please fill in all fields');
      return;
    }

    if (this.socket) {
      debugConsole.warn('Closing previous socket');
      this.socket.disconnect();
      this.socket = null;
    }

    this.setStatus('Connecting...', 'blue');
    this.socket = new RawSignalClient(serverUrl);

    clearTimeout(this.connectTimeout);
    this.connectTimeout = setTimeout(() => {
      debugConsole.warn('Connect timeout after 10s');
    }, 10000);

    this.socket.on('connect', () => {
      const wasRecovering = this._pendingStreamRecovery && Boolean(this.selectedLumina);
      this._socketConnected = true;
      clearTimeout(this.connectTimeout);
      debugConsole.success('Connected to signaling server');
      this.setStatus('Connected', 'green');
      this.hideSetupPanel();

      if (wasRecovering) {
        debugConsole.info('Signaling reconnected, rejoining active stream');
        this.recoverActiveStream('signaling reconnected');
        return;
      }

      this.loadAvailableStreams();
    });

    this.socket.on('connect_error', (error) => {
      clearTimeout(this.connectTimeout);
      debugConsole.error('Connect error: ' + error.message);
      this.setStatus('Connection Error', 'red');
    });

    this.socket.on('reconnecting', (info) => {
      this._socketConnected = false;
      if (this.selectedLumina) {
        this._pendingStreamRecovery = true;
        this.setOverlayState('Signal Lost');
      }
      this.setStatus('Reconnecting (' + info.attempt + ')...', 'orange');
    });

    this.socket.on('reconnect_failed', () => {
      this._socketConnected = false;
      this.setStatus('Connection Lost', 'red');
      if (this.selectedLumina) {
        this.handleLuminaDisconnected('Viewer connection lost');
      }
    });

    this.socket.on('streamer-joined', () => {
      this.loadAvailableStreams();
    });

    this.socket.on('streamer-left', (data) => {
      if (this.selectedLumina === data.streamerId) {
        this.handleLuminaDisconnected('Lumina stopped streaming');
      }
      this.loadAvailableStreams();
    });

    // SFU: after joining a streamer, we get router capabilities
    this.socket.on('joined', async (data) => {
      debugConsole.info('[SFU] Joined room — setting up consumer transport');
      try {
        this.signalingSessionInfo = data.signalingSession || null;
        if (this.signalingSessionInfo?.sessionId) {
          debugConsole.info('[SESSION] Bound to signaling session ' + this.signalingSessionInfo.sessionId +
            ' (' + this.signalingSessionInfo.sessionDirName + ')');
        }
        await this.setupMediasoup(data.routerRtpCapabilities);
        await this.startConsuming();
        this._pendingStreamRecovery = false;
        this._recoveringActiveStream = false;
        this.setOverlayState('Live');
        this.setStatus('Connected', 'green');
      } catch (error) {
        this._recoveringActiveStream = false;
        debugConsole.error('SFU setup failed: ' + error.message);
        this.showError('Connection error: ' + error.message);
      }
    });

    // Handle new producers added after we joined (e.g., audio added later)
    this.socket.on('new-producer', async (data) => {
      debugConsole.info('[SFU] New producer available: ' + data.kind);
      if (this.recvTransport && this.device) {
        try {
          await this.consumeNewProducers();
        } catch (error) {
          debugConsole.error('Failed to consume new producer: ' + error.message);
        }
      }
    });

    // Handle consumer closed (producer stopped)
    this.socket.on('consumer-closed', (data) => {
      const consumer = this.consumers.get(data.consumerId);
      if (consumer) {
        // Remove the dead track from remoteStream so the <video> element
        // can switch to any new track that gets added.
        if (this.remoteStream && consumer.track) {
          try { this.remoteStream.removeTrack(consumer.track); } catch (_) {}
        }
        consumer.close();
        this.consumers.delete(data.consumerId);
        debugConsole.info('[SFU] Consumer closed: ' + data.consumerId);
      }
    });

    this.socket.on('streamer-disconnected', () => {
      debugConsole.warn('Lumina disconnected');
      this.handleLuminaDisconnected('Lumina disconnected');
    });

    this.socket.on('disconnect', (reason) => {
      this._socketConnected = false;
      clearTimeout(this.connectTimeout);
      debugConsole.warn('Socket disconnected: ' + reason);
      if (this.selectedLumina) {
        this._pendingStreamRecovery = true;
        this.setStatus('Reconnecting Stream...', 'orange');
        this.setOverlayState('Signal Lost');
        document.getElementById('connectionQuality').textContent = 'Signal lost';
      } else {
        this.setStatus('Reconnecting...', 'orange');
      }
    });

    this.socket.on('error', (error) => {
      debugConsole.error('Socket error: ' + (error?.message || error));
    });
  }

  async loadAvailableStreams() {
    try {
      const streamsUrl = this.getHttpUrl() + '/lumina';
      debugConsole.info('Loading streams from ' + streamsUrl);
      const response = await fetch(streamsUrl);
      const streamers = await response.json();
      debugConsole.success('Loaded ' + streamers.length + ' host(s)');

      const list = document.getElementById('streamsList');
      list.innerHTML = '';

      if (streamers.length === 0) {
        list.innerHTML = '<p>No active streams available. Check back later!</p>';
        document.getElementById('streamsPanel').style.display = 'block';
        return;
      }

      streamers.forEach(streamer => {
        const item = document.createElement('div');
        item.className = 'stream-item';
        item.innerHTML =
          '<div class="stream-info-card">' +
            '<h3>' + (streamer.name || streamer.id.substring(0, 12)) + '</h3>' +
            '<p class="viewer-count">' + streamer.viewerCount + ' watching</p>' +
            '<button class="btn btn-primary btn-small">Watch Stream</button>' +
          '</div>';
        item.querySelector('button').addEventListener('click', () => {
          this.joinLumina(streamer);
        });
        list.appendChild(item);
      });

      document.getElementById('streamsPanel').style.display = 'block';
    } catch (error) {
      debugConsole.error('Error loading streams: ' + error.message);
      document.getElementById('streamsList').innerHTML = '<p>Error loading streams: ' + error.message + '</p>';
    }
  }

  joinLumina(streamer) {
    if (this.selectedLumina) {
      this.removeConnection();
    }
    debugConsole.info('Joining ' + (streamer.name || streamer.id));
    this.selectedLumina = streamer.id;
    this.selectedLuminaName = streamer.name || streamer.id;
    document.getElementById('streamTitle').textContent = this.selectedLuminaName;
    document.getElementById('connectionQuality').textContent = 'Connecting';
    const viewerName = document.getElementById('viewerName').value;

    this.socket.emit('join-streamer', {
      streamerId: streamer.id,
      viewerName
    });

    this.hideStreamsPanel();
  }

  async setupMediasoup(routerRtpCapabilities) {
    if (this.recvTransport || this.consumers.size > 0 || this.remoteStream) {
      this.removeConnection();
    }

    this.device = new mediasoupClient.Device();
    await this.device.load({ routerRtpCapabilities });
    debugConsole.info('[SFU] Device loaded with router capabilities');

    // Create recv transport
    const transportData = await this.socket.request('create-consumer-transport');

    this.recvTransport = this.device.createRecvTransport({
      id: transportData.id,
      iceParameters: transportData.iceParameters,
      iceCandidates: transportData.iceCandidates,
      dtlsParameters: transportData.dtlsParameters,
    });

    this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await this.socket.request('connect-consumer-transport', { dtlsParameters });
        callback();
      } catch (error) {
        errback(error);
      }
    });

    this.recvTransport.on('connectionstatechange', (state) => {
      debugConsole.info('[SFU] Recv transport state: ' + state);
      document.getElementById('connectionQuality').textContent = state;
      if (state === 'connected') {
        this.clearTransportRecoveryTimer();
        this._pendingStreamRecovery = false;
        this._recoveringActiveStream = false;
        this.setOverlayState('Live');
        return;
      }
      if (state === 'disconnected') {
        this.scheduleActiveStreamRecovery('recv transport disconnected');
        return;
      }
      if (state === 'failed') {
        this.recoverActiveStream('recv transport failed');
        return;
      }
      if (state === 'closed' && !this._localTransportClose) {
        this.scheduleActiveStreamRecovery('recv transport closed');
      }
    });

    debugConsole.info('[SFU] Recv transport created');
  }

  async startConsuming() {
    const response = await this.socket.request('consume', {
      rtpCapabilities: this.device.rtpCapabilities,
    });

    this.remoteStream = new MediaStream();

    for (const consumerData of response.consumers) {
      const consumer = await this.recvTransport.consume({
        id: consumerData.id,
        producerId: consumerData.producerId,
        kind: consumerData.kind,
        rtpParameters: consumerData.rtpParameters,
      });

      this.consumers.set(consumer.id, consumer);
      this.remoteStream.addTrack(consumer.track);

      // Resume consumer on the server (they start paused)
      this.socket.emit('consumer-resume', { consumerId: consumer.id });

      debugConsole.info('[SFU] Consuming ' + consumer.kind + ' (id: ' + consumer.id + ')');
    }

    const video = document.getElementById('remoteVideo');
    video.srcObject = this.remoteStream;
    video.muted = this.audioMuted;

    document.getElementById('connectionQuality').textContent = 'Live';
    this.showPlayerPanel();
    this.startStatsCollection();

    video.play().catch((err) => {
      debugConsole.warn('Autoplay blocked: ' + err.message);
    });

    debugConsole.success('[SFU] Stream playing — receiving via SFU');
  }

  async consumeNewProducers() {
    // Re-consume to pick up any new producers
    const response = await this.socket.request('consume', {
      rtpCapabilities: this.device.rtpCapabilities,
    });

    for (const consumerData of response.consumers) {
      // Skip already-consumed producers
      if (this.consumers.has(consumerData.id)) continue;

      const consumer = await this.recvTransport.consume({
        id: consumerData.id,
        producerId: consumerData.producerId,
        kind: consumerData.kind,
        rtpParameters: consumerData.rtpParameters,
      });

      this.consumers.set(consumer.id, consumer);
      if (this.remoteStream) {
        this.remoteStream.addTrack(consumer.track);
      }

      this.socket.emit('consumer-resume', { consumerId: consumer.id });
      debugConsole.info('[SFU] Consuming new ' + consumer.kind + ' (id: ' + consumer.id + ')');
    }
  }

  startStatsCollection() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    this._prevBytesReceived = 0;
    this._prevFramesDecoded = 0;
    this._prevStatsTimestamp = 0;

    this.statsInterval = setInterval(async () => {
      try {
        // Find the video consumer
        let videoConsumer = null;
        for (const consumer of this.consumers.values()) {
          if (consumer.kind === 'video' && !consumer.closed) {
            videoConsumer = consumer;
            break;
          }
        }

        if (!videoConsumer) return;

        const stats = await videoConsumer.getStats();
        let inboundVideo = null;

        stats.forEach(report => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            inboundVideo = report;
          }
        });

        if (!inboundVideo) return;

        const now = inboundVideo.timestamp;
        const frameWidth = inboundVideo.frameWidth || 0;
        const frameHeight = inboundVideo.frameHeight || 0;
        const framesDecoded = inboundVideo.framesDecoded || 0;
        const bytesReceived = inboundVideo.bytesReceived || 0;
        const framesDropped = inboundVideo.framesDropped || 0;
        const packetsLost = inboundVideo.packetsLost || 0;
        const packetsReceived = inboundVideo.packetsReceived || 0;
        const nackCount = inboundVideo.nackCount || 0;
        const pliCount = inboundVideo.pliCount || 0;
        const firCount = inboundVideo.firCount || 0;
        const jitterBufferDelayMs = inboundVideo.jitterBufferDelay != null && inboundVideo.jitterBufferEmittedCount > 0
          ? Number(((inboundVideo.jitterBufferDelay / inboundVideo.jitterBufferEmittedCount) * 1000).toFixed(1)) : null;
        const decodeLatencyMs = inboundVideo.totalDecodeTime != null && framesDecoded > 0
          ? Number(((inboundVideo.totalDecodeTime / framesDecoded) * 1000).toFixed(1)) : null;

        let fps = null;
        let bitrateMbps = null;
        let intervalLossRate = null;

        if (this._prevStatsTimestamp > 0) {
          const elapsed = (now - this._prevStatsTimestamp) / 1000;
          if (elapsed > 0) {
            const bytesDelta = bytesReceived - this._prevBytesReceived;
            const frameDelta = framesDecoded - this._prevFramesDecoded;
            bitrateMbps = Number(((bytesDelta * 8) / elapsed / 1000000).toFixed(2));
            fps = Number((frameDelta / elapsed).toFixed(0));
            document.getElementById('streamBitrate').textContent = bitrateMbps + ' Mbps';
            document.getElementById('streamFps').textContent = fps;

            // Interval-based packet loss (delta since last report, not cumulative)
            const lostDelta = packetsLost - (this._prevPacketsLost || 0);
            const recvDelta = packetsReceived - (this._prevPacketsReceived || 0);
            const totalDelta = lostDelta + recvDelta;
            intervalLossRate = totalDelta > 0 ? Math.max(0, lostDelta) / totalDelta : 0;
          }
        }

        const droppedFramesDelta = Math.max(0, framesDropped - (this._prevFramesDropped || 0));

        this._prevBytesReceived = bytesReceived;
        this._prevFramesDecoded = framesDecoded;
        this._prevFramesDropped = framesDropped;
        this._prevPacketsLost = packetsLost;
        this._prevPacketsReceived = packetsReceived;
        this._prevStatsTimestamp = now;

        if (frameWidth && frameHeight) {
          document.getElementById('resolution').textContent = frameWidth + 'x' + frameHeight;
        }

        const jitterMs = inboundVideo.jitter != null ? Number((inboundVideo.jitter * 1000).toFixed(0)) : null;
        document.getElementById('latency').textContent = (jitterMs != null ? jitterMs : '--') + ' ms';
        const lossPercent = intervalLossRate != null ? Number((intervalLossRate * 100).toFixed(1)) : null;

        // Update stats overlay
        if (this.statsOverlayVisible) {
          document.getElementById('overlayRes').textContent = (frameWidth && frameHeight) ? frameWidth + 'x' + frameHeight : '--';
          document.getElementById('overlayFps').textContent = (fps != null ? fps + ' fps' : '-- fps');
          document.getElementById('overlayBitrate').textContent = (bitrateMbps != null ? bitrateMbps + ' Mbps' : '-- Mbps');
          document.getElementById('overlayJitter').textContent = (jitterMs != null ? jitterMs + ' ms' : '-- ms');
          document.getElementById('overlayLoss').textContent = (lossPercent != null ? lossPercent + ' %' : '-- %');
          document.getElementById('overlayDecode').textContent = (decodeLatencyMs != null ? decodeLatencyMs + ' ms' : '-- ms');
        }

        if (fps !== null && this.socket && this.selectedLumina) {
          const lossRate = intervalLossRate != null ? intervalLossRate : 0;

          // Suppress stale reports — if 3+ consecutive fps=0, stop flooding the server
          if (fps === 0) {
            this._zeroFpsCount = (this._zeroFpsCount || 0) + 1;
            if (this._zeroFpsCount >= 3) return;
          } else {
            this._zeroFpsCount = 0;
          }

          this.socket.emit('viewer-quality-report', {
            streamerId: this.selectedLumina,
            fps, bitrateMbps, frameWidth, frameHeight, jitterMs,
            lossRate: Number(lossRate.toFixed(4)),
            droppedFramesDelta,
            jitterBufferDelayMs,
            decodeLatencyMs,
            signalingSessionId: this.signalingSessionInfo?.sessionId || null,
            reportedAtIso: new Date().toISOString(),
            viewerBuildId: VIEWER_BUILD_ID,
            pageLoadedAtIso: this._pageLoadedAtIso,
          });

          // Detailed diagnostic log every 5 seconds
          if (!this._diagCounter) this._diagCounter = 0;
          this._diagCounter++;
          if (this._diagCounter % 5 === 0) {
            debugConsole.info(
              '[DIAG:INBOUND] ' + frameWidth + 'x' + frameHeight +
              ' fps=' + fps + ' bitrate=' + bitrateMbps + 'Mbps' +
              ' jitter=' + (jitterMs != null ? jitterMs : '--') + 'ms' +
              ' jbuf=' + (jitterBufferDelayMs != null ? jitterBufferDelayMs : '--') + 'ms' +
              ' decode=' + (decodeLatencyMs != null ? decodeLatencyMs : '--') + 'ms' +
              ' dropped=' + framesDropped + ' lost=' + packetsLost +
              '/' + packetsReceived + 'pkts' +
              ' nack=' + nackCount + ' pli=' + pliCount + ' fir=' + firCount
            );
          }
        }
      } catch (error) {
        // Ignore transient stats errors
      }
    }, 1000);
  }

  async handleLuminaDisconnected(message = 'Lumina disconnected') {
    this._pendingStreamRecovery = false;
    this._recoveringActiveStream = false;
    this.clearTransportRecoveryTimer();
    this.removeConnection();
    await this.exitFullscreenIfNeeded();
    this.hidePlayerPanel();
    this.showStreamsPanel();
    document.getElementById('connectionQuality').textContent = '';
    this.selectedLumina = null;
    this.selectedLuminaName = '';
    this.signalingSessionInfo = null;
    this.setOverlayState('Idle');
    this.showError(message);
  }

  async disconnect() {
    this.hideError();
    this._pendingStreamRecovery = false;
    this._recoveringActiveStream = false;
    this.selectedLumina = null;
    this.selectedLuminaName = '';
    await this.exitFullscreenIfNeeded();
    this.removeConnection();
    this.hidePlayerPanel();
    this.showStreamsPanel();
    this.setOverlayState('Idle');
    this.loadAvailableStreams();
  }

  togglePlayback() {
    const video = document.getElementById('remoteVideo');
    const button = document.getElementById('playPauseBtn');
    if (!video.srcObject) {
      debugConsole.warn('No stream loaded');
      return;
    }
    if (video.paused) {
      video.play().then(() => {
        button.textContent = 'Pause';
      }).catch((err) => {
        debugConsole.error('Playback failed: ' + err.message);
      });
    } else {
      video.pause();
      button.textContent = 'Play';
    }
  }

  toggleMute() {
    const video = document.getElementById('remoteVideo');
    const button = document.getElementById('muteBtn');
    this.audioMuted = !this.audioMuted;
    video.muted = this.audioMuted;
    button.textContent = this.audioMuted ? 'Unmute' : 'Mute';
    debugConsole.info(this.audioMuted ? 'Audio muted' : 'Audio unmuted');
  }

  async toggleFullscreen() {
    const container = document.querySelector('.player-container');
    const video = document.getElementById('remoteVideo');

    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
        this.syncFullscreenButton();
        return;
      }

      if (container.requestFullscreen) {
        await container.requestFullscreen();
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      } else if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }

      if (screen.orientation?.lock) {
        screen.orientation.lock('landscape').catch(() => {});
      }
      this.syncFullscreenButton();
    } catch (error) {
      debugConsole.error('Fullscreen error: ' + error.message);
    }
  }

  syncFullscreenButton() {
    const button = document.getElementById('fullscreenBtn');
    const inFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    button.textContent = inFs ? 'Exit Fullscreen' : 'Fullscreen';
  }

  toggleStatsOverlay() {
    this.statsOverlayVisible = !this.statsOverlayVisible;
    this.syncStatsOverlay();
  }

  removeConnection(options = {}) {
    const { preserveSelection = false, keepPlayerVisible = false } = options;
    if (this.statsInterval) clearInterval(this.statsInterval);
    this.statsInterval = null;
    this.clearTransportRecoveryTimer();

    // Close all consumers
    for (const consumer of this.consumers.values()) {
      consumer.close();
    }
    this.consumers.clear();

    // Close transport
    if (this.recvTransport) {
      this._localTransportClose = true;
      this.recvTransport.close();
      this.recvTransport = null;
      this._localTransportClose = false;
    }

    this.device = null;

    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach(track => track.stop());
      this.remoteStream = null;
    }

    const video = document.getElementById('remoteVideo');
    video.srcObject = null;
    video.muted = true;
    document.getElementById('streamTitle').textContent = '';
    document.getElementById('connectionQuality').textContent = '';
    document.getElementById('playPauseBtn').textContent = 'Pause';
    document.getElementById('muteBtn').textContent = 'Unmute';
    this.audioMuted = true;
    this._prevBytesReceived = 0;
    this._prevFramesDecoded = 0;
    this._prevStatsTimestamp = 0;
    this._prevPacketsLost = 0;
    this._prevPacketsReceived = 0;
    this._zeroFpsCount = 0;
    document.getElementById('overlayRes').textContent = '--';
    document.getElementById('overlayFps').textContent = '-- fps';
    document.getElementById('overlayBitrate').textContent = '-- Mbps';
    document.getElementById('overlayJitter').textContent = '-- ms';
    document.getElementById('overlayLoss').textContent = '-- %';
    document.getElementById('overlayDecode').textContent = '-- ms';
    this.setOverlayState(this._pendingStreamRecovery ? 'Recovering' : 'Idle');
    if (!preserveSelection) {
      this.selectedLumina = null;
      this.selectedLuminaName = '';
    }
    if (!keepPlayerVisible) {
      this.hidePlayerPanel();
    }
    this.syncFullscreenButton();
    this.syncStatsOverlay();
  }

  hideSetupPanel() { document.getElementById('setupPanel').style.display = 'none'; }
  showSetupPanel() { document.getElementById('setupPanel').style.display = 'block'; }
  hideStreamsPanel() { document.getElementById('streamsPanel').style.display = 'none'; }
  showStreamsPanel() { document.getElementById('streamsPanel').style.display = 'block'; }
  hidePlayerPanel() { document.getElementById('playerPanel').style.display = 'none'; }
  showPlayerPanel() { document.getElementById('playerPanel').style.display = 'block'; }
}

document.addEventListener('DOMContentLoaded', () => {
  debugConsole.info('DOM loaded');
  window.app = new ViewerApp();
});
