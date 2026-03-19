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
          this.fire(eventName, payload);
        } catch (error) {
          debugConsole.error('WebSocket parse error: ' + error.message);
        }
      };

      this.ws.onerror = () => {
        this.fire('connect_error', new Error('websocket error'));
      };

      this.ws.onclose = () => {
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

  disconnect() {
    this._intentionalClose = true;
    this._shouldReconnect = false;
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

window.addEventListener('error', (event) => {
  debugConsole.error('Window error: ' + event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  const message = event.reason?.message || String(event.reason);
  debugConsole.error('Unhandled rejection: ' + message);
});

// ============================================
// ICE SERVERS
// ============================================
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: ['stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302'] },
  { urls: ['stun:stun4.l.google.com:19302'] }
];

// ============================================
// VIEWER APP
// ============================================
class ViewerApp {
  constructor() {
    this.socket = null;
    this.peerConnection = null;
    this.remoteStream = null;
    this.selectedStreamer = null;
    this.selectedStreamerName = '';
    this.statsInterval = null;
    this.connectTimeout = null;
    this.audioMuted = true;
    this.receiverSyncHintSeconds = 0.15;
    // Stats tracking
    this._prevBytesReceived = 0;
    this._prevFramesDecoded = 0;
    this._prevStatsTimestamp = 0;

    this.initializeUI();
    debugConsole.info('Viewer app initialized');
  }

  initializeUI() {
    document.getElementById('connectBtn').addEventListener('click', () => this.connect());
    document.getElementById('refreshStreamsBtn').addEventListener('click', () => this.loadAvailableStreams());
    document.getElementById('disconnectBtn').addEventListener('click', () => this.disconnect());
    document.getElementById('clearDebugBtn').addEventListener('click', () => debugConsole.clear());
    document.getElementById('playPauseBtn').addEventListener('click', () => this.togglePlayback());
    document.getElementById('muteBtn').addEventListener('click', () => this.toggleMute());
    document.getElementById('fullscreenBtn').addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('remoteVideo').addEventListener('dblclick', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => this.syncFullscreenButton());
    document.addEventListener('webkitfullscreenchange', () => this.syncFullscreenButton());
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

  showError(message) {
    debugConsole.error(message);
    document.getElementById('errorMessage').textContent = message;
    document.getElementById('errorModal').style.display = 'flex';
  }

  async connect() {
    const serverUrl = this.getServerUrl();
    const viewerName = document.getElementById('viewerName').value.trim();

    debugConsole.info('Connect requested');
    debugConsole.info('Server: ' + serverUrl);

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
      clearTimeout(this.connectTimeout);
      debugConsole.success('Connected to signaling server');
      this.setStatus('Connected', 'green');
      this.hideSetupPanel();
      this.loadAvailableStreams();
    });

    this.socket.on('connect_error', (error) => {
      clearTimeout(this.connectTimeout);
      debugConsole.error('Connect error: ' + error.message);
      this.setStatus('Connection Error', 'red');
    });

    this.socket.on('reconnecting', (info) => {
      this.setStatus('Reconnecting (' + info.attempt + ')...', 'orange');
    });

    this.socket.on('reconnect_failed', () => {
      this.setStatus('Connection Lost', 'red');
    });

    this.socket.on('streamer-joined', () => {
      this.loadAvailableStreams();
    });

    this.socket.on('streamer-left', (data) => {
      if (this.selectedStreamer === data.streamerId) {
        this.handleStreamerDisconnected();
      }
      this.loadAvailableStreams();
    });

    this.socket.on('offer', async (data) => {
      debugConsole.info('Received WebRTC offer');
      await this.handleOffer(data);
    });

    this.socket.on('ice-candidate', (data) => {
      const { candidate } = data;
      if (this.peerConnection && candidate) {
        this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
          .catch(err => debugConsole.error('ICE candidate error: ' + err.message));
      }
    });

    this.socket.on('streamer-disconnected', () => {
      debugConsole.warn('Streamer disconnected');
      this.handleStreamerDisconnected();
    });

    this.socket.on('disconnect', (reason) => {
      clearTimeout(this.connectTimeout);
      debugConsole.warn('Socket disconnected: ' + reason);
      this.setStatus('Reconnecting...', 'orange');
    });

    this.socket.on('error', (error) => {
      debugConsole.error('Socket error: ' + (error?.message || error));
    });
  }

  async loadAvailableStreams() {
    try {
      const streamsUrl = this.getHttpUrl() + '/streamers';
      debugConsole.info('Loading streams from ' + streamsUrl);
      const response = await fetch(streamsUrl);
      const streamers = await response.json();
      debugConsole.success('Loaded ' + streamers.length + ' streamer(s)');

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
          this.joinStreamer(streamer);
        });
        list.appendChild(item);
      });

      document.getElementById('streamsPanel').style.display = 'block';
    } catch (error) {
      debugConsole.error('Error loading streams: ' + error.message);
      document.getElementById('streamsList').innerHTML = '<p>Error loading streams: ' + error.message + '</p>';
    }
  }

  joinStreamer(streamer) {
    debugConsole.info('Joining ' + (streamer.name || streamer.id));
    this.selectedStreamer = streamer.id;
    this.selectedStreamerName = streamer.name || streamer.id;
    document.getElementById('streamTitle').textContent = this.selectedStreamerName;
    document.getElementById('connectionQuality').textContent = 'Connecting';
    const viewerName = document.getElementById('viewerName').value;

    this.socket.emit('join-streamer', {
      streamerId: streamer.id,
      viewerName
    });

    this.hideStreamsPanel();
    this.setupPeerConnection();
  }

  setupPeerConnection() {
    this.peerConnection = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      bundlePolicy: 'max-bundle',
      sdpSemantics: 'unified-plan'
    });

    this.peerConnection.ontrack = (event) => {
      debugConsole.info('Received track: ' + event.track.kind);
      if (event.streams[0]) {
        this.remoteStream = event.streams[0];
        const video = document.getElementById('remoteVideo');
        video.srcObject = this.remoteStream;
        video.muted = this.audioMuted;
        document.getElementById('connectionQuality').textContent = 'Live';
        this.showPlayerPanel();
        this.applyReceiverSyncPolicy();
        this.startStatsCollection();
        video.play().catch((err) => {
          debugConsole.warn('Autoplay blocked: ' + err.message);
        });
      }
    };

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('ice-candidate', {
          targetId: this.selectedStreamer,
          candidate: event.candidate
        });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      debugConsole.info('Peer state: ' + state);
      document.getElementById('connectionQuality').textContent = state;
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this.handleStreamerDisconnected();
      }
    };
  }

  async handleOffer(data) {
    const { offer } = data;
    try {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      debugConsole.success('Remote description set');
      this.applyReceiverSyncPolicy();

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      debugConsole.success('Answer created');

      this.socket.emit('answer', {
        streamerId: this.selectedStreamer,
        answer: answer
      });
    } catch (error) {
      debugConsole.error('Error handling offer: ' + error.message);
      this.showError('Connection error: ' + error.message);
    }
  }

  startStatsCollection() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    // Reset tracking
    this._prevBytesReceived = 0;
    this._prevFramesDecoded = 0;
    this._prevStatsTimestamp = 0;

    this.statsInterval = setInterval(async () => {
      try {
        const stats = await this.peerConnection.getStats();
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

        let fps = null;
        let bitrateMbps = null;

        if (this._prevStatsTimestamp > 0) {
          const elapsed = (now - this._prevStatsTimestamp) / 1000;
          if (elapsed > 0) {
            const bytesDelta = bytesReceived - this._prevBytesReceived;
            const frameDelta = framesDecoded - this._prevFramesDecoded;
            bitrateMbps = Number(((bytesDelta * 8) / elapsed / 1000000).toFixed(2));
            fps = Number((frameDelta / elapsed).toFixed(0));
            document.getElementById('streamBitrate').textContent = bitrateMbps + ' Mbps';
            document.getElementById('streamFps').textContent = fps;
          }
        }

        this._prevBytesReceived = bytesReceived;
        this._prevFramesDecoded = framesDecoded;
        this._prevStatsTimestamp = now;

        if (frameWidth && frameHeight) {
          document.getElementById('resolution').textContent = frameWidth + 'x' + frameHeight;
        }

        const jitterMs = inboundVideo.jitter ? Number((inboundVideo.jitter * 1000).toFixed(0)) : null;
        document.getElementById('latency').textContent = (jitterMs != null ? jitterMs : '--') + ' ms';

        if (fps !== null && this.socket && this.selectedStreamer) {
          this.socket.emit('viewer-quality-report', {
            streamerId: this.selectedStreamer,
            fps, bitrateMbps, frameWidth, frameHeight, jitterMs
          });
        }
      } catch (error) {
        debugConsole.error('Stats error: ' + error.message);
      }
    }, 1000);
  }

  handleStreamerDisconnected() {
    this.removeConnection();
    this.showError('Streamer disconnected');
    this.hidePlayerPanel();
    this.showStreamsPanel();
    document.getElementById('connectionQuality').textContent = '';
  }

  disconnect() {
    this.removeConnection();
    this.hidePlayerPanel();
    this.showStreamsPanel();
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

  applyReceiverSyncPolicy() {
    if (!this.peerConnection) return;
    this.peerConnection.getReceivers().forEach((receiver) => {
      if (!receiver.track) return;
      try {
        if ('playoutDelayHint' in receiver) {
          receiver.playoutDelayHint = this.receiverSyncHintSeconds;
        }
      } catch (error) {
        debugConsole.warn('Sync hint unavailable for ' + receiver.track.kind);
      }
    });
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

  removeConnection() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
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
    this.syncFullscreenButton();
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
