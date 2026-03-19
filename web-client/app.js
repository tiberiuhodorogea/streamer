class RawSignalClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.listeners = {};
    this.connect();
  }

  normalizedUrl() {
    const baseUrl = this.url
      .replace(/^http:\/\//i, 'ws://')
      .replace(/^https:\/\//i, 'wss://');
    return baseUrl.endsWith('/ws') ? baseUrl : `${baseUrl}/ws`;
  }

  connect() {
    const wsUrl = this.normalizedUrl();
    debugConsole.info(`Opening raw WebSocket: ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.fire('connect');
    };

    this.ws.onmessage = (event) => {
      try {
        const [eventName, payload] = JSON.parse(event.data);
        this.fire(eventName, payload);
      } catch (error) {
        debugConsole.error(`WebSocket parse error: ${error.message}`);
      }
    };

    this.ws.onerror = () => {
      this.fire('connect_error', new Error('websocket error'));
    };

    this.ws.onclose = () => {
      this.fire('disconnect', 'socket closed');
    };
  }

  on(eventName, callback) {
    if (!this.listeners[eventName]) {
      this.listeners[eventName] = [];
    }
    this.listeners[eventName].push(callback);
  }

  emit(eventName, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      debugConsole.warn(`Cannot send ${eventName}: socket not open`);
      return;
    }
    this.ws.send(JSON.stringify([eventName, payload]));
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  fire(eventName, payload) {
    const callbacks = this.listeners[eventName] || [];
    callbacks.forEach((callback) => callback(payload));
  }
}

class DebugConsole {
  constructor() {
    this.lines = [];
    this.maxLines = 200;
  }

  write(level, message) {
    const time = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    this.lines.push({ level, message, time });
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
    this.render();
  }

  info(message) {
    console.log(message);
    this.write('info', message);
  }

  warn(message) {
    console.warn(message);
    this.write('warn', message);
  }

  error(message) {
    console.error(message);
    this.write('error', message);
  }

  success(message) {
    console.log(message);
    this.write('success', message);
  }

  clear() {
    this.lines = [];
    this.render();
  }

  render() {
    const root = document.getElementById('debugConsole');
    if (!root) {
      return;
    }

    root.innerHTML = this.lines.map((line) => `
      <div class="debug-line">
        <span class="debug-time">[${line.time}]</span>
        <span class="debug-${line.level}">${line.message}</span>
      </div>
    `).join('');
    root.scrollTop = root.scrollHeight;
  }
}

const debugConsole = new DebugConsole();

window.addEventListener('error', (event) => {
  debugConsole.error(`Window error: ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const message = event.reason?.message || String(event.reason);
  debugConsole.error(`Unhandled promise rejection: ${message}`);
});

class ViewerApp {
  constructor() {
    this.socket = null;
    this.peerConnection = null;
    this.remoteStream = null;
    this.selectedStreamer = null;
    this.selectedStreamerName = '';
    this.statsInterval = null;
    this.connectTimeout = null;
    this.audioMuted = false;
    this.receiverSyncHintSeconds = 0.25;

    this.initializeUI();
    this.checkServerAvailability();
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

  async checkServerAvailability() {
    try {
      const response = await fetch('http://localhost:4000/health', { method: 'GET' });
      if (response.ok) {
        debugConsole.success('Initial health check succeeded');
      }
    } catch (error) {
      debugConsole.warn(`Initial health check failed: ${error.message}`);
    }
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
    const serverUrl = document.getElementById('serverUrl').value.trim();
    const viewerName = document.getElementById('viewerName').value.trim();

    debugConsole.info('Connect requested');
    debugConsole.info(`Server URL: ${serverUrl}`);
    debugConsole.info(`Viewer name: ${viewerName}`);

    if (!serverUrl || !viewerName) {
      this.showError('Please fill in all fields');
      return;
    }

    if (this.socket) {
      debugConsole.warn('Closing previous socket before reconnecting');
      this.socket.disconnect();
      this.socket = null;
    }

    this.setStatus('Connecting...', 'blue');
    debugConsole.info('Creating raw signaling client');
    this.socket = new RawSignalClient(serverUrl);

    clearTimeout(this.connectTimeout);
    this.connectTimeout = setTimeout(() => {
      debugConsole.warn('Connect timeout reached after 10 seconds');
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
      debugConsole.error(`Connect error: ${error.message}`);
      this.setStatus('Connection Error', 'red');
    });

    this.socket.on('streamer-joined', (data) => {
      debugConsole.info(`Streamer joined: ${data.streamerId}`);
      this.loadAvailableStreams();
    });

    this.socket.on('streamer-left', (data) => {
      debugConsole.warn(`Streamer left: ${data.streamerId}`);
      if (this.selectedStreamer === data.streamerId) {
        this.handleStreamerDisconnected();
      }
      this.loadAvailableStreams();
    });

    this.socket.on('offer', async (data) => {
      debugConsole.info('Received WebRTC offer from streamer');
      await this.handleOffer(data);
    });

    this.socket.on('ice-candidate', (data) => {
      const { candidate } = data;
      if (this.peerConnection && candidate) {
        this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
          .catch(err => debugConsole.error(`Error adding ICE candidate: ${err.message}`));
      }
    });

    this.socket.on('streamer-disconnected', () => {
      debugConsole.warn('Streamer disconnected');
      this.handleStreamerDisconnected();
    });

    this.socket.on('disconnect', (reason) => {
      clearTimeout(this.connectTimeout);
      debugConsole.warn(`Socket disconnected: ${reason}`);
      this.setStatus('Disconnected', 'red');
      this.hidePlayerPanel();
      this.showSetupPanel();
    });

    this.socket.on('error', (error) => {
      debugConsole.error(`Socket error: ${error?.message || error}`);
      this.showError(`Connection error: ${error?.message || error}`);
    });
  }

  async loadAvailableStreams() {
    try {
      const streamsUrl = `${document.getElementById('serverUrl').value}/streamers`
        .replace('ws://', 'http://')
        .replace('wss://', 'https://');
      debugConsole.info(`Loading streams from ${streamsUrl}`);
      const response = await fetch(streamsUrl);
      const streamers = await response.json();
      debugConsole.success(`Loaded ${streamers.length} streamer(s)`);

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
        item.innerHTML = `
          <div class="stream-info-card">
            <h3>${streamer.name || streamer.id.substring(0, 12)}</h3>
            <p class="viewer-count">👥 ${streamer.viewerCount} watching</p>
            <button class="btn btn-primary btn-small">Watch Stream</button>
          </div>
        `;
        item.querySelector('button').addEventListener('click', () => {
          this.joinStreamer(streamer);
        });
        list.appendChild(item);
      });

      document.getElementById('streamsPanel').style.display = 'block';
    } catch (error) {
      debugConsole.error(`Error loading streams: ${error.message}`);
      document.getElementById('streamsList').innerHTML = `<p>Error loading streams: ${error.message}</p>`;
    }
  }

  joinStreamer(streamer) {
    debugConsole.info(`Joining streamer ${streamer.name || streamer.id}`);
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
    const config = {
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302'] },
        { urls: ['stun:stun1.l.google.com:19302'] }
      ]
    };

    this.peerConnection = new RTCPeerConnection(config);

    this.peerConnection.ontrack = (event) => {
      debugConsole.info(`Received remote track: ${event.track.kind}`);
      if (event.streams[0]) {
        this.remoteStream = event.streams[0];
        const remoteVideo = document.getElementById('remoteVideo');
        remoteVideo.srcObject = this.remoteStream;
        remoteVideo.muted = this.audioMuted;
        document.getElementById('connectionQuality').textContent = 'Live';
        this.showPlayerPanel();
        this.applyReceiverSyncPolicy();
        this.startStatsCollection();
        remoteVideo.play().catch((error) => {
          debugConsole.warn(`Autoplay required another tap: ${error.message}`);
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
      debugConsole.info(`Peer connection state: ${this.peerConnection.connectionState}`);
      document.getElementById('connectionQuality').textContent = this.peerConnection.connectionState;
      if (this.peerConnection.connectionState === 'failed' ||
        this.peerConnection.connectionState === 'disconnected' ||
        this.peerConnection.connectionState === 'closed') {
        this.handleStreamerDisconnected();
      }
    };

    this.peerConnection.onicegatheringstatechange = () => {
      debugConsole.info(`ICE gathering state: ${this.peerConnection.iceGatheringState}`);
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
      debugConsole.success('Created and set local answer');

      this.socket.emit('answer', {
        streamerId: this.selectedStreamer,
        answer: answer
      });
    } catch (error) {
      debugConsole.error(`Error handling offer: ${error.message}`);
      this.showError(`Error establishing connection: ${error.message}`);
    }
  }

  startStatsCollection() {
    if (this.statsInterval) clearInterval(this.statsInterval);

    this.statsInterval = setInterval(async () => {
      try {
        const stats = await this.peerConnection.getStats();
        let inboundStats = null;

        stats.forEach(report => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            inboundStats = report;
          }
        });

        if (inboundStats) {
          const frameWidth = inboundStats.frameWidth || 0;
          const frameHeight = inboundStats.frameHeight || 0;
          const framesDecoded = inboundStats.framesDecoded || 0;
          const bytesReceived = inboundStats.bytesReceived || 0;
          let fps = null;
          let bitrateMbps = null;

          // Calculate bitrate (bytes/sec to Mbps)
          if (this.lastBytesReceived) {
            const bytesDelta = bytesReceived - this.lastBytesReceived;
            bitrateMbps = Number((bytesDelta * 8 / 1000000).toFixed(2));
            document.getElementById('streamBitrate').textContent = `${bitrateMbps} Mbps`;
          }
          this.lastBytesReceived = bytesReceived;

          if (frameWidth && frameHeight) {
            document.getElementById('resolution').textContent = `${frameWidth}x${frameHeight}`;
          }

          // Estimate FPS
          if (this.lastFramesDecoded !== undefined) {
            const frameDelta = framesDecoded - this.lastFramesDecoded;
            fps = Number((frameDelta / 1).toFixed(0));
            document.getElementById('streamFps').textContent = fps;
          }
          this.lastFramesDecoded = framesDecoded;

          // Latency (simplified)
          const jitterMs = inboundStats.jitter ? Number((inboundStats.jitter * 1000).toFixed(0)) : null;
          document.getElementById('latency').textContent = `${jitterMs ?? '--'} ms`;

          if (fps !== null && this.socket && this.selectedStreamer) {
            this.socket.emit('viewer-quality-report', {
              streamerId: this.selectedStreamer,
              fps,
              bitrateMbps,
              frameWidth,
              frameHeight,
              jitterMs
            });
          }
        }
      } catch (error) {
        debugConsole.error(`Error collecting stats: ${error.message}`);
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
      debugConsole.warn('Cannot change playback state before a stream is loaded');
      return;
    }

    if (video.paused) {
      video.play().then(() => {
        button.textContent = 'Pause';
        debugConsole.info('Playback resumed');
      }).catch((error) => {
        debugConsole.error(`Failed to resume playback: ${error.message}`);
      });
      return;
    }

    video.pause();
    button.textContent = 'Play';
    debugConsole.info('Playback paused');
  }

  toggleMute() {
    const video = document.getElementById('remoteVideo');
    const button = document.getElementById('muteBtn');
    this.audioMuted = !this.audioMuted;
    video.muted = this.audioMuted;
    button.textContent = this.audioMuted ? 'Unmute' : 'Mute';
    debugConsole.info(this.audioMuted ? 'Viewer muted audio' : 'Viewer unmuted audio');
  }

  applyReceiverSyncPolicy() {
    if (!this.peerConnection) {
      return;
    }

    this.peerConnection.getReceivers().forEach((receiver) => {
      if (!receiver.track || (receiver.track.kind !== 'audio' && receiver.track.kind !== 'video')) {
        return;
      }

      try {
        if ('playoutDelayHint' in receiver) {
          receiver.playoutDelayHint = this.receiverSyncHintSeconds;
        }
      } catch (error) {
        debugConsole.warn(`Receiver sync hint unavailable for ${receiver.track.kind}: ${error.message}`);
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
      debugConsole.info('Entered fullscreen mode');
    } catch (error) {
      debugConsole.error(`Failed to toggle fullscreen: ${error.message}`);
    }
  }

  syncFullscreenButton() {
    const button = document.getElementById('fullscreenBtn');
    const inFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    button.textContent = inFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
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
    document.getElementById('remoteVideo').srcObject = null;
    document.getElementById('remoteVideo').muted = this.audioMuted;
    document.getElementById('streamTitle').textContent = '';
    document.getElementById('connectionQuality').textContent = '';
    document.getElementById('playPauseBtn').textContent = 'Pause';
    document.getElementById('muteBtn').textContent = 'Mute';
    this.audioMuted = false;
    this.syncFullscreenButton();
  }

  // UI management
  hideSetupPanel() {
    document.getElementById('setupPanel').style.display = 'none';
  }

  showSetupPanel() {
    document.getElementById('setupPanel').style.display = 'block';
  }

  hideStreamsPanel() {
    document.getElementById('streamsPanel').style.display = 'none';
  }

  showStreamsPanel() {
    document.getElementById('streamsPanel').style.display = 'block';
  }

  hidePlayerPanel() {
    document.getElementById('playerPanel').style.display = 'none';
  }

  showPlayerPanel() {
    document.getElementById('playerPanel').style.display = 'block';
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  debugConsole.info('DOM content loaded');
  window.app = new ViewerApp();
});
