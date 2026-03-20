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
  quality: {
    label: 'Quality 1080p',
    hint: 'Full HD target with adaptive headroom for cleaner motion',
    summary: '1080p / 60 fps / 18 Mbps cap',
    maxWidth: 1920,
    maxHeight: 1080,
    maxFrameRate: 60,
    maxBitrate: 18_000_000,
  },
  ultra: {
    label: 'Ultra 2K',
    hint: 'Maximum resolution with the same adaptive quality stack',
    summary: '2K (1440p) / 60 fps / 20 Mbps cap',
    maxWidth: 2560,
    maxHeight: 1440,
    maxFrameRate: 60,
    maxBitrate: 20_000_000,
  }
};

// ============================================
// DEGRADATION TIERS
// Combines bitrate, FPS, and resolution scaling for optimal quality at each level.
// Order: first cut bitrate → then halve FPS → then scale down resolution.
// ============================================
const DEGRADATION_TIERS = [
  { bitratePct: 1.00, scaleDown: 1.0, fpsFraction: 1.0, label: 'MAX'  },  // full profile quality
  { bitratePct: 0.75, scaleDown: 1.0, fpsFraction: 1.0, label: 'HIGH' },  // mild bitrate cut, encoder absorbs
  { bitratePct: 0.55, scaleDown: 1.0, fpsFraction: 0.5, label: 'MID'  },  // halve FPS → doubles per-frame budget
  { bitratePct: 0.40, scaleDown: 1.5, fpsFraction: 0.5, label: 'LOW'  },  // scale down res → crisper pixels
  { bitratePct: 0.25, scaleDown: 2.0, fpsFraction: 0.5, label: 'MIN'  },  // heavy downscale, last resort
];

// ============================================
// ADAPTIVE QUALITY CONTROLLER
// Navigates tiers based on viewer health signals.
// Degrades fast (2s cooldown), recovers aggressively (3s of good health).
// ============================================
class AdaptiveQualityController {
  constructor(streamerApp) {
    this.app = streamerApp;
    this.enabled = true;
    this.tierIndex = 0;               // current tier (0 = max quality)
    this.profileMaxBitrate = 0;
    this.profileMaxFps = 60;
    this.floor = 1_500_000;           // absolute minimum bitrate

    // Viewer health tracking
    this.viewerHealth = new Map();

    // Timing
    this.lastDegradeTime = 0;
    this.lastRecoverTime = 0;
    this.degradeCooldownMs = 2000;    // react fast to congestion
    this.recoverCooldownMs = 3000;    // recover aggressively
    this.goodHealthStart = 0;
    this.recoverWaitMs = 3000;        // 3s good health → step up

    // Thresholds — loss is SECONDARY (some connections have baseline loss)
    this.jitterWarnMs = 35;
    this.jitterCriticalMs = 50;
    this.lossWarnRate = 0.05;         // raised to 5% — Tailscale/DERP can have 2-4% baseline
    this.lossCriticalRate = 0.10;     // >10% packet loss = critical
  }

  get currentTier() { return DEGRADATION_TIERS[this.tierIndex]; }

  get effectiveBitrate() {
    return Math.max(this.floor, Math.round(this.profileMaxBitrate * this.currentTier.bitratePct));
  }

  get effectiveFps() {
    return Math.max(15, Math.round(this.profileMaxFps * this.currentTier.fpsFraction));
  }

  setProfile(bitrate, fps) {
    this.profileMaxBitrate = bitrate;
    this.profileMaxFps = fps || 60;
    this.tierIndex = 0; // reset to max quality on profile change
    this._applyTier();
  }

  onViewerReport(viewerId, report) {
    if (!this.enabled) return;

    let health = this.viewerHealth.get(viewerId);
    if (!health) {
      health = {
        fpsSamples: [],
        jitterSamples: [],
        lossRate: 0,
        baselineFps: 0,
        baselineSamples: 0,
        bitrateMbps: 0,
      };
      this.viewerHealth.set(viewerId, health);
    }

    const fps = report.fps || 0;
    health.fpsSamples.push(fps);
    if (health.fpsSamples.length > 8) health.fpsSamples.shift();

    health.jitterSamples.push(report.jitterMs || 0);
    if (health.jitterSamples.length > 8) health.jitterSamples.shift();

    health.lossRate = report.lossRate || 0;
    health.bitrateMbps = report.bitrateMbps || 0;

    // Learn baseline FPS via EMA (only healthy samples > 5fps)
    if (fps > 5) {
      if (health.baselineSamples < 5) {
        health.baselineFps = ((health.baselineFps * health.baselineSamples) + fps) / (health.baselineSamples + 1);
        health.baselineSamples++;
      } else {
        health.baselineFps = health.baselineFps * 0.9 + fps * 0.1;
      }
    }
  }

  removeViewer(viewerId) {
    this.viewerHealth.delete(viewerId);
  }

  // Called every stats tick (~1s)
  evaluate() {
    if (!this.enabled || this.viewerHealth.size === 0) return;

    const now = Date.now();
    const assessment = this._assessHealth();

    // Detailed per-tick diagnostics (every tick for tuning)
    if (!this._evalCounter) this._evalCounter = 0;
    this._evalCounter++;
    if (this._evalCounter % 3 === 0) { // every 3s to avoid spam
      let diag = '[ABR:TICK] tier=' + this.currentTier.label + ' health=' + assessment;
      for (const [viewerId, health] of this.viewerHealth) {
        const recent = health.fpsSamples.slice(-3);
        const recentAvg = recent.length ? (recent.reduce((a, b) => a + b, 0) / recent.length).toFixed(1) : '?';
        const baseline = health.baselineSamples >= 3 ? health.baselineFps.toFixed(1) : '(learning)';
        const jRecent = health.jitterSamples.slice(-3);
        const jAvg = jRecent.length ? (jRecent.reduce((a, b) => a + b, 0) / jRecent.length).toFixed(1) : '?';
        diag += ' | v=' + viewerId.substring(0, 6) + ' fps=' + recentAvg + '/' + baseline + ' jitter=' + jAvg + 'ms loss=' + (health.lossRate * 100).toFixed(1) + '%';
      }
      if (this.goodHealthStart) {
        diag += ' | goodFor=' + ((now - this.goodHealthStart) / 1000).toFixed(1) + 's';
      }
      logger.debug(diag);
    }

    if (assessment === 'source-stall') {
      // Source stopped producing — don't degrade, just log
      if (this._evalCounter % 3 === 0) {
        logger.warn('[ABR] Source stall detected (all viewers 0fps/0bps) — holding tier ' + this.currentTier.label);
      }
    } else if (assessment === 'critical') {
      if (now - this.lastDegradeTime >= this.degradeCooldownMs) {
        this._stepDown(2); // emergency: skip 2 tiers
      }
    } else if (assessment === 'warning') {
      if (now - this.lastDegradeTime >= this.degradeCooldownMs) {
        this._stepDown(1);
      }
    } else if (assessment === 'good') {
      if (this.tierIndex > 0) {
        if (!this.goodHealthStart) {
          this.goodHealthStart = now;
        } else if (now - this.goodHealthStart >= this.recoverWaitMs &&
                   now - this.lastRecoverTime >= this.recoverCooldownMs) {
          // Gate: only step up if actual bitrate can support the next tier
          const nextTier = DEGRADATION_TIERS[this.tierIndex - 1];
          const neededMbps = (this.profileMaxBitrate * nextTier.bitratePct) / 1e6;
          const currentMbps = this._getMinViewerBitrate();
          if (currentMbps >= neededMbps * 0.5) {
            // Viewers are delivering at least 50% of next tier's bitrate — safe to step up
            this._stepUp(1);
          } else {
            // Not enough bandwidth headroom — hold position, don't reset goodHealthStart
            if (this._evalCounter % 3 === 0) {
              logger.debug('[ABR] Recovery gated: need ' + neededMbps.toFixed(1) + 'Mbps, actual=' + currentMbps.toFixed(1) + 'Mbps');
            }
          }
        }
      } else {
        this.goodHealthStart = 0;
      }
    }
  }

  _assessHealth() {
    let worstJitter = 0;
    let worstLoss = 0;
    let hasZeroFps = false;
    let hasFpsCrash = false;
    let hasFpsDrop = false;
    let allZeroBitrate = true;  // source-freeze detection
    let viewerCount = 0;

    for (const [, health] of this.viewerHealth) {
      if (health.fpsSamples.length < 2) continue;
      viewerCount++;

      const recent = health.fpsSamples.slice(-3);
      const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const baseline = health.baselineSamples >= 3 ? health.baselineFps : recentAvg;
      const avgJitter = health.jitterSamples.slice(-3).reduce((a, b) => a + b, 0) / Math.min(health.jitterSamples.length, 3);

      if (recent.some(f => f === 0)) hasZeroFps = true;
      if (baseline > 5 && recentAvg < baseline * 0.3) hasFpsCrash = true;
      if (baseline > 5 && recentAvg < baseline * 0.6) hasFpsDrop = true;

      worstJitter = Math.max(worstJitter, avgJitter);
      worstLoss = Math.max(worstLoss, health.lossRate);

      // Track if any viewer has non-zero bitrate (to detect source freeze)
      if (recentAvg > 0) allZeroBitrate = false;
    }

    // SOURCE FREEZE: all viewers at 0fps simultaneously = encoder stopped, not network
    // Don't degrade — degrading won't help; just hold current tier
    if (viewerCount > 0 && hasZeroFps && allZeroBitrate) {
      return 'source-stall';  // special: no action taken
    }

    // Critical: zero fps OR fps crash OR extreme jitter OR extreme loss
    if (hasZeroFps || hasFpsCrash || worstJitter > this.jitterCriticalMs || worstLoss > this.lossCriticalRate) {
      return 'critical';
    }
    // Warning: fps drop OR high jitter OR notable loss  
    // Loss alone only triggers warning if combined with elevated jitter (>20ms)
    if (hasFpsDrop || worstJitter > this.jitterWarnMs ||
        (worstLoss > this.lossWarnRate && worstJitter > 20)) {
      return 'warning';
    }
    return 'good';
  }

  _getMinViewerBitrate() {
    let minMbps = Infinity;
    for (const [, health] of this.viewerHealth) {
      if (health.bitrateMbps < minMbps) minMbps = health.bitrateMbps;
    }
    return minMbps === Infinity ? 0 : minMbps;
  }

  _stepDown(steps) {
    const prevTier = this.tierIndex;
    this.tierIndex = Math.min(DEGRADATION_TIERS.length - 1, this.tierIndex + steps);
    if (this.tierIndex !== prevTier) {
      // Reset baselines since FPS target changed — prevents cross-tier confusion
      for (const [, health] of this.viewerHealth) {
        health.baselineSamples = 0;
        health.baselineFps = 0;
      }
      this._applyTier();
      const t = this.currentTier;
      logger.warn('[ABR] DEGRADE tier ' + prevTier + '->' + this.tierIndex + ' (' + t.label + ') ' +
        (this.effectiveBitrate / 1e6).toFixed(1) + 'Mbps @' + this.effectiveFps + 'fps' +
        (t.scaleDown > 1 ? ' scale=' + t.scaleDown + 'x' : ''));
    }
    this.lastDegradeTime = Date.now();
    this.goodHealthStart = 0;
  }

  _stepUp(steps) {
    const prevTier = this.tierIndex;
    this.tierIndex = Math.max(0, this.tierIndex - steps);
    if (this.tierIndex !== prevTier) {
      // Reset baselines since FPS target changed
      for (const [, health] of this.viewerHealth) {
        health.baselineSamples = 0;
        health.baselineFps = 0;
      }
      this._applyTier();
      const t = this.currentTier;
      logger.info('[ABR] RECOVER tier ' + prevTier + '->' + this.tierIndex + ' (' + t.label + ') ' +
        (this.effectiveBitrate / 1e6).toFixed(1) + 'Mbps @' + this.effectiveFps + 'fps' +
        (t.scaleDown > 1 ? ' scale=' + t.scaleDown + 'x' : ''));
    }
    this.lastRecoverTime = Date.now();
    this.goodHealthStart = 0;
  }

  _applyTier() {
    const producer = this.app.videoProducer;
    if (!producer || !producer.rtpSender) return;

    const sender = producer.rtpSender;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;

    const tier = this.currentTier;
    params.encodings[0].maxBitrate = this.effectiveBitrate;
    params.encodings[0].maxFramerate = this.effectiveFps;
    params.encodings[0].scaleResolutionDownBy = tier.scaleDown;

    sender.setParameters(params).catch(err => {
      logger.warn('[ABR] setParameters failed: ' + err.message);
    });
  }

  getStatusText() {
    if (!this.profileMaxBitrate) return '--';
    const t = this.currentTier;
    return t.label + ' ' + (this.effectiveBitrate / 1e6).toFixed(1) + 'Mbps @' + this.effectiveFps + 'fps' +
      (t.scaleDown > 1 ? ' /' + t.scaleDown + 'x' : '');
  }
}

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
      this.selectedProfileKey = 'quality';
      this.includeAudio = true;
      this.isBroadcasting = false;
      this.streamerName = '';
      this.serverUrl = '';
      this.statsInterval = null;
      this.viewers = new Map();    // viewerId -> { name }
      this._prevBytesSent = 0;
      this._prevFramesEncoded = 0;
      this._prevStatsTimestamp = 0;
      this.abr = new AdaptiveQualityController(this);

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
    return QUALITY_PROFILES[this.selectedProfileKey] || QUALITY_PROFILES.quality;
  }

  setQualityProfile(profileKey) {
    if (!QUALITY_PROFILES[profileKey]) {
      logger.warn('Unknown profile: ' + profileKey);
      return;
    }
    this.selectedProfileKey = profileKey;
    this.refreshQualityProfileUi();
    logger.info('Quality profile set to ' + QUALITY_PROFILES[profileKey].label);

    // Update ABR — resets to max quality tier for the new profile
    this.abr.setProfile(QUALITY_PROFILES[profileKey].maxBitrate, QUALITY_PROFILES[profileKey].maxFrameRate);
  }

  async updateProducerEncoding() {
    // Delegate to ABR — resets to max quality tier for active profile
    const profile = this.getActiveQualityProfile();
    this.abr.setProfile(profile.maxBitrate, profile.maxFrameRate);
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
      this.abr.removeViewer(data.viewerId);
      this.updateViewersList();
    });

    this.socket.on('viewer-quality-report', (data) => {
      // Feed quality reports to adaptive bitrate controller
      this.abr.onViewerReport(data.viewerId, {
        fps: data.fps,
        jitterMs: data.jitterMs,
        lossRate: data.lossRate || 0,
        bitrateMbps: data.bitrateMbps || 0,
      });

      if (!this._qrLogCounter) this._qrLogCounter = 0;
      this._qrLogCounter++;
      if (this._qrLogCounter % 5 === 0) {
        const viewer = this.viewers.get(data.viewerId);
        const name = viewer ? viewer.name : data.viewerId;
        logger.debug('[DIAG:QR] ' + name + ' | fps=' + data.fps + ' bitrate=' + data.bitrateMbps + 'Mbps res=' + data.frameWidth + 'x' + data.frameHeight + ' jitter=' + (data.jitterMs != null ? data.jitterMs : '--') + 'ms [ABR:' + this.abr.getStatusText() + ']');
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

      sources
        .sort((left, right) => {
          if (left.kind === right.kind) return left.name.localeCompare(right.name);
          return left.kind === 'window' ? -1 : 1;
        })
        .forEach(source => {
        const sourceEl = document.createElement('div');
        sourceEl.className = 'source-tile';
        sourceEl.innerHTML =
          '<img src="' + source.thumbnail + '" alt="' + source.name + '">' +
          '<p>' + source.name + '</p>' +
          '<span class="source-kind">' + source.kind + '</span>' +
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

      const isWindowCapture = sourceId.startsWith('window:');
      if (isWindowCapture && window.electron?.prepareForCapture) {
        logger.info('Minimizing streamer window before window capture');
        await window.electron.prepareForCapture();
        await new Promise(resolve => setTimeout(resolve, 300));
      }

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

        // Init ABR with profile ceiling
        this.abr.setProfile(prof.maxBitrate, prof.maxFrameRate);

        // Produce video via SFU transport (single encoder for ALL viewers!)
        this.videoProducer = await this.sendTransport.produce({
          track: videoTrack,
          encodings: [{
            maxBitrate: prof.maxBitrate,
            maxFramerate: prof.maxFrameRate,
            scaleResolutionDownBy: 1.0,
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

        // Run ABR evaluation every stats tick
        this.abr.evaluate();

        // Show ABR state in the UI
        const abrEl = document.getElementById('abrStatus');
        if (abrEl) abrEl.textContent = this.abr.getStatusText();
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

    if (window.electron?.restoreAfterCapture) {
      window.electron.restoreAfterCapture().catch((error) => {
        logger.warn('Could not restore streamer window: ' + error.message);
      });
    }

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
