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
    this.goodHealthStart = 0;
    this._streamStartTime = 0;        // set when stream begins
    this._stuckAtMinSince = 0;        // for periodic recovery probe

    // Tuning — designed for internet/Tailscale connections (30-50ms baseline jitter)
    this.degradeCooldownMs = 4000;    // 4s between degrade steps (prevent cascade)
    this.recoverCooldownMs = 5000;    // 5s between recover steps
    this.recoverWaitMs = 5000;        // 5s continuous good health before step-up
    this.startupGraceMs = 12000;      // 12s grace after stream start — encoder ramps up

    // Jitter thresholds — internet has 30-50ms baseline, only react to real congestion
    this.jitterWarnMs = 65;
    this.jitterCriticalMs = 100;

    // Loss thresholds — some connections have 2-4% baseline
    this.lossWarnRate = 0.05;
    this.lossCriticalRate = 0.10;

    // Recovery probe: if stuck at MIN for this long, force a step-up attempt
    this.recoveryProbeMs = 30000;     // 30s at MIN → try stepping up
  }

  get tiers() { return DEGRADATION_TIERS; }

  get currentTier() { return this.tiers[this.tierIndex]; }

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
    this._streamStartTime = Date.now();
    this._stuckAtMinSince = 0;
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

    // Startup grace: don't degrade while encoder is ramping up
    const inGrace = (now - this._streamStartTime) < this.startupGraceMs;

    if (assessment === 'source-stall') {
      // Source stopped producing — don't degrade, just log
      if (this._evalCounter % 3 === 0) {
        logger.warn('[ABR] Source stall detected (all viewers 0fps/0bps) — holding tier ' + this.currentTier.label);
      }
    } else if (!inGrace && assessment === 'critical') {
      if (now - this.lastDegradeTime >= this.degradeCooldownMs) {
        this._stepDown(2); // emergency: skip 2 tiers
        this._stuckAtMinSince = 0;
      }
    } else if (!inGrace && assessment === 'warning') {
      if (now - this.lastDegradeTime >= this.degradeCooldownMs) {
        this._stepDown(1);
        this._stuckAtMinSince = 0;
      }
    } else if (assessment === 'good') {
      if (this.tierIndex > 0) {
        if (!this.goodHealthStart) {
          this.goodHealthStart = now;
        } else if (now - this.goodHealthStart >= this.recoverWaitMs &&
                   now - this.lastRecoverTime >= this.recoverCooldownMs) {
          // Gate: only step up if actual bitrate can support the next tier
          const nextTier = this.tiers[this.tierIndex - 1];
          const neededMbps = (this.profileMaxBitrate * nextTier.bitratePct) / 1e6;
          const currentMbps = this._getMinViewerBitrate();
          if (currentMbps >= neededMbps * 0.35) {
            const veryGood = this._isVeryGoodHealth();
            this._stepUp(veryGood ? 2 : 1);
          } else {
            if (this._evalCounter % 3 === 0) {
              logger.debug('[ABR] Recovery gated: need ' + neededMbps.toFixed(1) + 'Mbps, actual=' + currentMbps.toFixed(1) + 'Mbps');
            }
          }
        }
      } else {
        this.goodHealthStart = 0;
        this._stuckAtMinSince = 0;
      }
    }

    // Recovery probe: if stuck at bottom tier too long, force a step-up attempt
    if (this.tierIndex === this.tiers.length - 1) {
      if (!this._stuckAtMinSince) {
        this._stuckAtMinSince = now;
      } else if (now - this._stuckAtMinSince >= this.recoveryProbeMs &&
                 assessment !== 'critical') {
        logger.info('[ABR] Recovery probe — stuck at MIN for ' +
          ((now - this._stuckAtMinSince) / 1000).toFixed(0) + 's, trying step up');
        this._stepUp(1);
        this._stuckAtMinSince = now; // reset so we don't probe again immediately
      }
    } else {
      this._stuckAtMinSince = 0;
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

      const crashThreshold = 0.3;
      const warnThreshold = 0.6;

      if (recent.some(f => f === 0)) hasZeroFps = true;
      if (baseline > 5 && recentAvg < baseline * crashThreshold) hasFpsCrash = true;
      if (baseline > 5 && recentAvg < baseline * warnThreshold) hasFpsDrop = true;

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
    // Loss alone only triggers warning if combined with elevated jitter (>40ms)
    if (hasFpsDrop || worstJitter > this.jitterWarnMs ||
        (worstLoss > this.lossWarnRate && worstJitter > 40)) {
      return 'warning';
    }
    return 'good';
  }

  _isVeryGoodHealth() {
    if (this.viewerHealth.size === 0) return false;

    for (const [, health] of this.viewerHealth) {
      if (health.fpsSamples.length < 3) return false;
      const recent = health.fpsSamples.slice(-3);
      const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const baseline = health.baselineSamples >= 3 ? health.baselineFps : recentAvg;
      const jRecent = health.jitterSamples.slice(-3);
      const jAvg = jRecent.reduce((a, b) => a + b, 0) / jRecent.length;
      if (baseline > 5 && recentAvg < baseline * 0.95) return false;
      if (jAvg > 30) return false;
      if (health.lossRate > 0.01) return false;
    }

    return true;
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
    this.tierIndex = Math.min(this.tiers.length - 1, this.tierIndex + steps);
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
      // Session log for ABR analysis
      if (window.electron?.sessionLog) {
        window.electron.sessionLog('abr-degrade', {
          from: prevTier, to: this.tierIndex, label: t.label,
          bitrateMbps: (this.effectiveBitrate / 1e6).toFixed(1),
          fps: this.effectiveFps, scaleDown: t.scaleDown,
        });
      }
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
      // Session log for ABR analysis
      if (window.electron?.sessionLog) {
        window.electron.sessionLog('abr-recover', {
          from: prevTier, to: this.tierIndex, label: t.label,
          bitrateMbps: (this.effectiveBitrate / 1e6).toFixed(1),
          fps: this.effectiveFps, scaleDown: t.scaleDown,
        });
      }
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
      this._nativeGamePid = null;
      this._nativeGameAudioTrack = null;
      this._nativeGameAudioContext = null;
      this._nativeGameAudioNode = null;
      this._nativeGameAudioDestination = null;
      this._nativeGameAudioQueue = [];
      this.abr = new AdaptiveQualityController(this);
      this._bitrateCapMbps = null; // null = use profile default

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

    const bitrateSlider = document.getElementById('bitrateSlider');
    const bitrateValue = document.getElementById('bitrateValue');
    if (bitrateSlider) {
      // Init from profile default
      const defaultMbps = Math.round(this.getActiveQualityProfile().maxBitrate / 1_000_000);
      bitrateSlider.value = defaultMbps;
      if (bitrateValue) bitrateValue.textContent = defaultMbps + ' Mbps';

      bitrateSlider.addEventListener('input', () => {
        const mbps = parseInt(bitrateSlider.value, 10);
        if (bitrateValue) bitrateValue.textContent = mbps + ' Mbps';
        this._bitrateCapMbps = mbps;
        this._updateProfileSummary();
        logger.info('Bitrate cap set to ' + mbps + ' Mbps');
      });
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
    const base = QUALITY_PROFILES[this.selectedProfileKey] || QUALITY_PROFILES.quality;
    if (this._bitrateCapMbps) {
      return Object.assign({}, base, {
        maxBitrate: this._bitrateCapMbps * 1_000_000,
        summary: base.maxWidth + 'x' + base.maxHeight + ' / ' + base.maxFrameRate + ' fps / ' + this._bitrateCapMbps + ' Mbps cap',
      });
    }
    return base;
  }

  _updateProfileSummary() {
    const profile = this.getActiveQualityProfile();
    const summary = document.getElementById('profileSummary');
    if (summary) summary.textContent = profile.summary;
  }

  setQualityProfile(profileKey) {
    if (!QUALITY_PROFILES[profileKey]) {
      logger.warn('Unknown profile: ' + profileKey);
      return;
    }
    this.selectedProfileKey = profileKey;

    // Sync slider to new profile default if user hasn't manually set it yet
    const slider = document.getElementById('bitrateSlider');
    const valEl = document.getElementById('bitrateValue');
    if (!this._bitrateCapMbps && slider) {
      const defaultMbps = Math.round(QUALITY_PROFILES[profileKey].maxBitrate / 1_000_000);
      slider.value = defaultMbps;
      if (valEl) valEl.textContent = defaultMbps + ' Mbps';
    }

    this.refreshQualityProfileUi();
    this._updateProfileSummary();
    logger.info('Quality profile set to ' + QUALITY_PROFILES[profileKey].label);

    // Update ABR — resets to max quality tier for the new profile
    const prof = this.getActiveQualityProfile();
    this.abr.setProfile(prof.maxBitrate, prof.maxFrameRate);
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

      // Cache sources for later lookup (e.g. auto screen-capture for games)
      this._cachedSources = sources;

      const gameCount = sources.filter(s => s.isGame).length;
      if (gameCount > 0) {
        logger.info('[GAME] Detected ' + gameCount + ' game source(s)');
      }

      const grid = document.getElementById('sourcesGrid');
      if (!grid) return;

      grid.innerHTML = '';

      sources
        .sort((left, right) => {
          // Games first, then windows, then screens
          if (left.isGame !== right.isGame) return left.isGame ? -1 : 1;
          if (left.kind === right.kind) return left.name.localeCompare(right.name);
          return left.kind === 'window' ? -1 : 1;
        })
        .forEach(source => {
        const sourceEl = document.createElement('div');
        sourceEl.className = 'source-tile' + (source.isGame ? ' source-tile-game' : '');

        let badges = '';
        if (source.isGame) {
          badges += '<span class="source-badge source-game">\uD83C\uDFAE GAME</span>';
        }
        badges += '<span class="source-badge source-kind">' + source.kind + '</span>';

        sourceEl.innerHTML =
          '<img src="' + source.thumbnail + '" alt="' + source.name + '">' +
          '<p>' + source.name + '</p>' +
          '<div class="source-badges">' + badges + '</div>' +
          '<button class="btn btn-small">Stream This</button>';
        sourceEl.querySelector('button').addEventListener('click', () => {
          logger.info('Selected: ' + source.name + (source.isGame ? ' [GAME]' : ''));
          this.startStreaming(source.id, source.name, source.isGame, source.gameHwnd, source.gamePid);
        });
        grid.appendChild(sourceEl);
      });
    } catch (error) {
      logger.error('Failed to load sources: ' + error.message);
    }
  }

  async startStreaming(sourceId, sourceName, isGame = false, gameHwnd = null, gamePid = null) {
    try {
      logger.info('Starting stream: ' + sourceName + (isGame ? ' [GAME MODE]' : ''));

      this._isGameCapture = isGame;
      this._nativeGamePid = gamePid;
      const isWindowCapture = sourceId.startsWith('window:');

      // For games detected as window sources, switch to screen capture (DXGI)
      // immediately. Chromium's WGC window capture cannot reliably grab
      // DirectX/Vulkan game surfaces — it often captures the window behind
      // the game instead.
      if (isGame && isWindowCapture) {
        logger.info('[GAME] Window capture unreliable for DX/Vulkan games — switching to screen capture (DXGI)');
        const screenId = await this._findScreenSource();
        if (screenId) {
          sourceId = screenId;
          this._gameUsedScreenFallback = true;
        } else {
          logger.warn('[GAME] No screen source found, falling back to window capture');
        }
      }

      this._lastSourceId = sourceId;
      if (!this._gameUsedScreenFallback) this._gameUsedScreenFallback = false;

      if (sourceId.startsWith('window:') && window.electron?.prepareForCapture) {
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
          ' maxBitrate=' + (prof.maxBitrate / 1000000) + 'Mbps' +
          (isGame ? ' | GAME-OPTIMISED' : '')
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
            videoGoogleStartBitrate: 10000,
          },
        });

        logger.info('[SFU] Video producer created (id: ' + this.videoProducer.id + ')');

        // ── GAME ENCODER OPTIMIZATIONS ─────────────────────
        // Tell WebRTC to sacrifice resolution, not framerate, when under load.
        // This keeps game motion smooth — the viewer would rather see a slightly
        // lower-res image than stuttery 60 fps.
        if (isGame && this.videoProducer.rtpSender) {
          try {
            const params = this.videoProducer.rtpSender.getParameters();
            params.degradationPreference = 'maintain-framerate';
            await this.videoProducer.rtpSender.setParameters(params);
            logger.info('[GAME] Encoder set to maintain-framerate (smooth motion > resolution)');
          } catch (e) {
            logger.warn('[GAME] Could not set degradationPreference: ' + e.message);
          }
        }

        // For game window captures, schedule an early frame-production check.
        // If the window capture isn't producing frames (e.g. exclusive fullscreen),
        // automatically fall back to screen capture while keeping process-isolated audio.
        if (isGame && isWindowCapture && this.videoProducer) {
          this._scheduleGameCaptureFallbackCheck();
        }

        this.videoProducer.on('transportclose', () => {
          logger.warn('[SFU] Video producer transport closed');
          this.videoProducer = null;
        });
      }

      // Produce audio
      let producedAudioTrack = null;
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        producedAudioTrack = audioTracks[0];
      }

      if (producedAudioTrack) {
        if (!stream.getAudioTracks().includes(producedAudioTrack)) {
          stream.addTrack(producedAudioTrack);
        }
        this.audioProducer = await this.sendTransport.produce({
          track: producedAudioTrack,
        });
        logger.info('[SFU] Audio producer created (id: ' + this.audioProducer.id + ')');
        this.updateAudioStatus('Live');

        this.audioProducer.on('transportclose', () => {
          logger.warn('[SFU] Audio producer transport closed');
          this.audioProducer = null;
        });
      } else if (this.includeAudio && isGame && isWindowCapture && gamePid) {
        // Kick off native game audio in the background so the video stream
        // is NOT blocked by the 5-second WASAPI activation timeout.
        this._startNativeGameAudioAsync(gamePid);
        this.updateAudioStatus('Starting...');
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
      this._startSourceHealthCheck();
      logger.info('[SFU] Stream live — server forwards to all viewers (single encoder!)');

      if (window.electron?.sessionLog) {
        window.electron.sessionLog('stream-start', {
          sourceId, sourceName, isGame, gameHwnd, gamePid,
          profile: this.captureProfile,
          captureMethod: this._gameUsedScreenFallback ? 'screen-dxgi' : (sourceId.startsWith('window:') ? 'window-wgc' : 'screen'),
        });
      }

    } catch (error) {
      logger.error('Failed to start stream: ' + error.message);
      this.setStatus('Stream Error', 'red');
    }
  }

  async captureSourceStream(sourceId) {
    const profile = this.getActiveQualityProfile();
    const isWindowCapture = sourceId.startsWith('window:');
    const allowAudioCapture = this.includeAudio && !(this._isGameCapture && isWindowCapture);
    const mandatory = {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      maxWidth: profile.maxWidth,
      maxHeight: profile.maxHeight,
      maxFrameRate: profile.maxFrameRate
    };

    // NOTE: Do NOT add cursor constraints to the mandatory block here.
    // Unknown mandatory properties (like cursor: 'never') can cause Chromium
    // to fall back from WGC to GDI-based capture, which cannot capture
    // DirectX/Vulkan game surfaces.

    const videoConstraints = { mandatory };

    if (!allowAudioCapture) {
      if (this.includeAudio && this._isGameCapture && isWindowCapture) {
        logger.info('[GAME] Window audio capture disabled to avoid leaking unrelated desktop audio into the game stream');
      }
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

  /**
   * Finds the primary screen source from the cached source list.
   * Used for game capture — screen capture (DXGI Desktop Duplication)
   * is far more reliable than window capture for DirectX/Vulkan games.
   */
  async _findScreenSource() {
    try {
      const sources = this._cachedSources || await window.electron.getCaptureSources();
      const screens = sources.filter(s => s.kind === 'screen');
      if (screens.length === 0) return null;
      if (screens.length > 1) {
        logger.info('[GAME] Multiple screens detected (' + screens.length + ') — using primary');
      }
      return screens[0].id;
    } catch (e) {
      logger.warn('[GAME] Screen source lookup failed: ' + e.message);
      return null;
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

        // Periodic stats snapshot (every 5s)
        if (bitrateMbps !== null && window.electron?.sessionLog) {
          this._statsTickCount = (this._statsTickCount || 0) + 1;
          if (this._statsTickCount % 5 === 0) {
            window.electron.sessionLog('stats-snapshot', {
              bitrateMbps: +bitrateMbps.toFixed(2), fps,
              abrTier: this.abr.tierIndex,
              abrLabel: this.abr.tiers?.[this.abr.tierIndex]?.label,
              viewers: this.viewers.size,
            });
          }
        }

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

  /**
   * Monitors encoded-frame count. If no new frames for ~2s,
   * automatically re-acquires the capture source (handles alt-tab / minimise).
   */
  _startSourceHealthCheck() {
    if (this._healthInterval) clearInterval(this._healthInterval);
    this._healthStalls = 0;

    this._healthInterval = setInterval(async () => {
      if (!this.videoProducer || !this.videoProducer.rtpSender) return;

      try {
        const stats = await this.videoProducer.getStats();
        let framesEncoded = 0;
        stats.forEach(r => {
          if (r.type === 'outbound-rtp' && r.kind === 'video') {
            framesEncoded = r.framesEncoded || 0;
          }
        });

        if (this._healthPrevFrames !== undefined && framesEncoded === this._healthPrevFrames) {
          this._healthStalls++;
          if (this._healthStalls >= 2) {
            logger.warn('[HEALTH] No new frames for ~' + this._healthStalls + 's — re-acquiring source');
            await this._reacquireCaptureSource();
            this._healthStalls = 0;
          }
        } else {
          this._healthStalls = 0;
        }
        this._healthPrevFrames = framesEncoded;
      } catch (_) { /* ignore */ }
    }, 1000);
  }

  _stopSourceHealthCheck() {
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
      this._healthInterval = null;
    }
  }

  async _reacquireCaptureSource() {
    if (!this.videoProducer || !this.videoProducer.rtpSender) return;

    try {
      // Re-acquire the same original source. For games this keeps us on the
      // actual game window instead of silently drifting into full-screen capture.
      const sourceId = this._lastSourceId;
      if (!sourceId) return;

      const newStream = await this.captureSourceStream(sourceId);
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;

      newTrack.contentHint = 'motion';
      await this.videoProducer.rtpSender.replaceTrack(newTrack);

      // Stop old tracks
      if (this.localStream) {
        this.localStream.getVideoTracks().forEach(t => t.stop());
      }
      this.localStream = newStream;

      logger.info('[HEALTH] Capture source re-acquired successfully');
    } catch (e) {
      logger.warn('[HEALTH] Re-acquire failed: ' + e.message);
    }
  }

  /**
   * After starting a game window capture, checks if frames are actually being
   * encoded. If the encoder hasn't produced any frames after 2 seconds, the
   * game window is likely in exclusive fullscreen (not capturable by WGC / GDI).
   * In that case, silently switch to screen capture (DXGI Desktop Duplication)
   * while keeping process-isolated audio.
   */
  _scheduleGameCaptureFallbackCheck() {
    if (this._gameFallbackTimer) clearTimeout(this._gameFallbackTimer);
    this._gameFallbackTimer = setTimeout(async () => {
      this._gameFallbackTimer = null;
      if (!this.videoProducer || !this.isBroadcasting) return;

      try {
        const stats = await this.videoProducer.getStats();
        let framesEncoded = 0;
        stats.forEach(r => {
          if (r.type === 'outbound-rtp' && r.kind === 'video') {
            framesEncoded = r.framesEncoded || 0;
          }
        });

        if (framesEncoded < 5) {
          logger.warn('[GAME] Only ' + framesEncoded + ' frames encoded in 2s — window capture failing (exclusive fullscreen?)');
          await this._fallbackToScreenCapture();
        } else {
          logger.info('[GAME] Window capture producing frames normally (' + framesEncoded + ' in 2s)');
        }
      } catch (e) {
        logger.warn('[GAME] Fallback check failed: ' + e.message);
      }
    }, 2000);
  }

  /**
   * Switches from a failing window capture to screen capture (DXGI Desktop
   * Duplication). Used when a game is in exclusive fullscreen and window capture
   * can't see the DirectX surface. Audio stays on process-loopback.
   */
  async _fallbackToScreenCapture() {
    if (!this.videoProducer?.rtpSender) return;

    const screenId = await this._findScreenSource();
    if (!screenId) {
      logger.error('[GAME] No screen source found for fallback');
      return;
    }

    try {
      // Get screen capture stream (video only — audio via process loopback)

      // Get screen capture stream (video only — audio via process loopback)
      const savedGameFlag = this._isGameCapture;
      this._isGameCapture = false; // temporarily clear so captureSourceStream doesn't block audio
      const screenStream = await this.captureSourceStream(screenId);
      this._isGameCapture = savedGameFlag;

      const newTrack = screenStream.getVideoTracks()[0];
      if (!newTrack) {
        logger.error('[GAME] Screen capture returned no video track');
        return;
      }

      newTrack.contentHint = 'motion';
      await this.videoProducer.rtpSender.replaceTrack(newTrack);

      // Stop old window capture tracks
      if (this.localStream) {
        this.localStream.getVideoTracks().forEach(t => t.stop());
      }
      this.localStream = screenStream;
      this._lastSourceId = screenId;
      this._gameUsedScreenFallback = true;

      logger.info('[GAME] Switched to screen capture (DXGI) — game in exclusive fullscreen. Audio stays on process loopback.');
      if (window.electron?.sessionLog) {
        window.electron.sessionLog('game-fallback-screen', { screenId });
      }
    } catch (e) {
      logger.error('[GAME] Screen capture fallback failed: ' + e.message);
    }
  }

  stopStreaming() {
    logger.info('Stopping stream...');

    // Stop health check, fallback timer, and native game audio
    this._stopSourceHealthCheck();
    if (this._gameFallbackTimer) { clearTimeout(this._gameFallbackTimer); this._gameFallbackTimer = null; }
    this._teardownNativeGameAudio();
    this._isGameCapture = false;
    this._nativeGamePid = null;
    this.abr.tierIndex = 0;

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

    if (window.electron?.sessionLog) {
      window.electron.sessionLog('stream-stop', {});
    }

    if (window.electron?.restoreAfterCapture) {
      window.electron.restoreAfterCapture().catch((error) => {
        logger.warn('Could not restore streamer window: ' + error.message);
      });
    }

    this.hideStreamPanel();
    this.showCapturePanel();
  }

  /**
   * Fire-and-forget wrapper: starts native game audio in the background
   * and attaches the audio producer once it's ready, so the video stream
   * isn't blocked by the WASAPI activation wait.
   */
  async _startNativeGameAudioAsync(gamePid) {
    try {
      logger.info('[GAME-AUDIO] Starting native game audio pipeline for pid=' + gamePid);
      const audioTrack = await this._startNativeGameAudio(gamePid);
      if (!audioTrack) {
        logger.warn('[GAME-AUDIO] _startNativeGameAudio returned null — no track produced');
        this.updateAudioStatus(this.includeAudio ? 'Unavailable' : 'Off');
        return;
      }
      logger.info('[GAME-AUDIO] Got audio track: id=' + audioTrack.id + ' enabled=' + audioTrack.enabled + ' readyState=' + audioTrack.readyState);
      if (!this.isBroadcasting || !this.sendTransport) {
        logger.warn('[GAME-AUDIO] Stream stopped before audio was ready');
        return;
      }
      logger.info('[GAME-AUDIO] Producing audio track via SFU transport...');
      this.audioProducer = await this.sendTransport.produce({ track: audioTrack });
      logger.info('[SFU] Audio producer created (id: ' + this.audioProducer.id + ')');
      this.updateAudioStatus('Live');
      this.audioProducer.on('transportclose', () => {
        logger.warn('[SFU] Audio producer transport closed');
        this.audioProducer = null;
      });
    } catch (err) {
      logger.warn('[GAME-AUDIO] Background audio start failed: ' + err.message + ' stack: ' + (err.stack || 'n/a'));
      this.updateAudioStatus('Unavailable');
    }
  }

  async _startNativeGameAudio(gamePid) {
    logger.info('[GAME-AUDIO] _startNativeGameAudio: checking API availability...');
    if (!window.electron?.isNativeProcessAudioAvailable || !window.electron?.startNativeProcessAudio) {
      logger.warn('[GAME-AUDIO] Native game audio capture API unavailable (isAvailFn=' + !!window.electron?.isNativeProcessAudioAvailable + ' startFn=' + !!window.electron?.startNativeProcessAudio + ')');
      return null;
    }

    const available = await window.electron.isNativeProcessAudioAvailable();
    logger.info('[GAME-AUDIO] isNativeProcessAudioAvailable=' + available);
    if (!available) {
      logger.warn('[GAME-AUDIO] Native process-loopback audio not supported on this system');
      return null;
    }

    this._teardownNativeGameAudio();
    logger.info('[GAME-AUDIO] Previous audio state torn down, calling startNativeProcessAudio({pid: ' + gamePid + '})...');

    const startResult = await window.electron.startNativeProcessAudio({ pid: gamePid });
    logger.info('[GAME-AUDIO] startNativeProcessAudio result: ' + JSON.stringify(startResult));
    if (!startResult?.success) {
      logger.warn('[GAME-AUDIO] Native game audio start failed: ' + (startResult?.reason || 'unknown'));
      return null;
    }

    const format = startResult.format || {};
    const sampleRate = format.sampleRate || 48000;
    const channels = format.channels || 2;
    logger.info('[GAME-AUDIO] Format: sampleRate=' + sampleRate + ' channels=' + channels);

    this._nativeGameAudioQueue = [];
    this._nativeGameAudioContext = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    this._nativeGameAudioNode = this._nativeGameAudioContext.createScriptProcessor(2048, 0, channels);
    this._nativeGameAudioDestination = this._nativeGameAudioContext.createMediaStreamDestination();

    this._nativeGameAudioNode.onaudioprocess = (event) => {
      const frameCount = event.outputBuffer.length;
      const outputChannels = [];
      for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
        const channelData = event.outputBuffer.getChannelData(channelIndex);
        channelData.fill(0);
        outputChannels.push(channelData);
      }

      let outputOffset = 0;
      while (outputOffset < frameCount && this._nativeGameAudioQueue.length > 0) {
        const chunk = this._nativeGameAudioQueue[0];
        const availableFrames = chunk.frameCount - chunk.offsetFrames;
        const framesToCopy = Math.min(frameCount - outputOffset, availableFrames);

        for (let frameIndex = 0; frameIndex < framesToCopy; frameIndex++) {
          const srcFrame = chunk.offsetFrames + frameIndex;
          for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
            outputChannels[channelIndex][outputOffset + frameIndex] = chunk.samples[(srcFrame * channels) + channelIndex] || 0;
          }
        }

        chunk.offsetFrames += framesToCopy;
        outputOffset += framesToCopy;
        if (chunk.offsetFrames >= chunk.frameCount) {
          this._nativeGameAudioQueue.shift();
        }
      }
    };

    this._nativeGameAudioNode.connect(this._nativeGameAudioDestination);
    await this._nativeGameAudioContext.resume();
    logger.info('[GAME-AUDIO] AudioContext state=' + this._nativeGameAudioContext.state + ' sampleRate=' + this._nativeGameAudioContext.sampleRate);

    let chunkCount = 0;
    window.electron.onGameAudioChunk((buffer, meta) => {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      chunkCount++;
      if (chunkCount === 1) {
        logger.info('[GAME-AUDIO] First chunk received in renderer: frames=' + meta.frameCount + ' bytes=' + bytes.byteLength + ' samplesLen=' + samples.length);
      } else if (chunkCount % 500 === 0) {
        logger.info('[GAME-AUDIO] Chunk #' + chunkCount + ', queueLen=' + this._nativeGameAudioQueue.length);
      }
      this._nativeGameAudioQueue.push({
        samples,
        frameCount: meta.frameCount,
        offsetFrames: 0,
      });

      if (this._nativeGameAudioQueue.length > 64) {
        this._nativeGameAudioQueue.splice(0, this._nativeGameAudioQueue.length - 64);
      }
    });

    this._nativeGameAudioTrack = this._nativeGameAudioDestination.stream.getAudioTracks()[0] || null;
    if (this._nativeGameAudioTrack) {
      this._nativeGameAudioTrack.contentHint = 'music';
      logger.info('[GAME-AUDIO] Native game-only audio attached from process ' + gamePid);
    }

    return this._nativeGameAudioTrack;
  }

  _teardownNativeGameAudio() {
    if (window.electron?.removeGameAudioChunkListener) {
      window.electron.removeGameAudioChunkListener();
    }
    if (window.electron?.stopNativeProcessAudio) {
      window.electron.stopNativeProcessAudio().catch(() => {});
    }
    if (this._nativeGameAudioNode) {
      try { this._nativeGameAudioNode.disconnect(); } catch (_) {}
      this._nativeGameAudioNode.onaudioprocess = null;
      this._nativeGameAudioNode = null;
    }
    if (this._nativeGameAudioTrack) {
      try { this._nativeGameAudioTrack.stop(); } catch (_) {}
      this._nativeGameAudioTrack = null;
    }
    if (this._nativeGameAudioContext) {
      this._nativeGameAudioContext.close().catch(() => {});
      this._nativeGameAudioContext = null;
    }
    this._nativeGameAudioDestination = null;
    this._nativeGameAudioQueue = [];
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
