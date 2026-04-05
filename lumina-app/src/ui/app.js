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

const KNOWN_GAME_TITLE_ALIASES = [
  {
    canonical: 'deadbydaylight',
    processName: 'DeadByDaylight-Win64-Shipping',
    aliases: [
      'deadbydaylight',
      'dead by daylight',
      'deadbydaylightwin64shipping',
      'deadbydaylightwin64',
      'deadbydaylightshipping',
    ],
  },
];

function normalizeGameTitle(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function stripKnownGameSuffixes(name) {
  return normalizeGameTitle(name)
    .replace(/win64shipping|win32shipping|shipping|launcher|bootstrapper|exe|x64|x86/g, '');
}

function inferKnownGameFromTitle(name) {
  const sourceKey = normalizeGameTitle(name);
  const sourceBase = stripKnownGameSuffixes(name);
  if (!sourceKey && !sourceBase) return null;

  for (const entry of KNOWN_GAME_TITLE_ALIASES) {
    for (const alias of entry.aliases) {
      const aliasKey = normalizeGameTitle(alias);
      const aliasBase = stripKnownGameSuffixes(alias);
      if (!aliasKey && !aliasBase) continue;
      if (sourceKey === aliasKey || sourceBase === aliasBase) return entry;
      if (aliasBase && (sourceKey.includes(aliasBase) || sourceBase.includes(aliasBase))) return entry;
      if (sourceBase && (aliasKey.includes(sourceBase) || aliasBase.includes(sourceBase))) return entry;
    }
  }

  return null;
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
// SMOOTHNESS-FIRST STREAMING PROFILE
// ============================================
const SMOOTHNESS_PROFILE = {
  label: 'Auto Smoothness',
  hint: 'Starts games at 720p/60 and only recovers upward after a stable window',
  summary: 'Smoothness-first game profile with a 1600x900 / 60 ceiling and conservative warm-up',
  maxWidth: 1600,
  maxHeight: 900,
  maxFrameRate: 60,
  maxBitrate: 12_000_000,
  startBitrate: 5_500_000,
  minBitrate: 2_500_000,
  startTierIndex: 1,
  recoverWaitMs: 12_000,
  recoverCooldownMs: 6_000,
  startupRampMs: 15_000,
  nativeMaxWidth: 1600,
  nativeMaxHeight: 900,
};

// ============================================
// ADAPTIVE LADDER
// Order: cut bitrate first, then shave resolution, and only reduce FPS as a late emergency action.
// ============================================
const DEGRADATION_TIERS = [
  { bitratePct: 1.00, scaleDown: 1.0, fpsFraction: 1.0, label: 'FULL' },
  { bitratePct: 0.72, scaleDown: 1.25, fpsFraction: 1.0, label: 'FLOW' },
  { bitratePct: 0.58, scaleDown: 1.5, fpsFraction: 1.0, label: 'SAFE' },
  { bitratePct: 0.46, scaleDown: 1.75, fpsFraction: 1.0, label: 'SHIELD' },
  { bitratePct: 0.34, scaleDown: 2.0, fpsFraction: 0.92, label: 'RESCUE' },
  { bitratePct: 0.24, scaleDown: 2.5, fpsFraction: 0.75, label: 'LAST' },
];

// ============================================
// ADAPTIVE QUALITY CONTROLLER
// Prioritizes frame pacing, fast recovery, and multi-viewer fairness.
// ============================================
class AdaptiveQualityController {
  constructor(luminaApp) {
    this.app = luminaApp;
    this.enabled = true;
    this.defaultStartupTierIndex = 1;
    this.startupTierIndex = this.defaultStartupTierIndex;
    this.tierIndex = this.startupTierIndex;
    this.profileMaxBitrate = SMOOTHNESS_PROFILE.maxBitrate;
    this.profileMaxFps = SMOOTHNESS_PROFILE.maxFrameRate;
    this.floor = SMOOTHNESS_PROFILE.minBitrate;

    this.viewerHealth = new Map();
    this._producerStats = {
      bitrateMbps: 0,
      fps: 0,
      sourceFps: 0,
      stallSeconds: 0,
      stressSeconds: 0,
      stressReason: null,
      headroomHealthy: false,
      availableOutgoingBitrateMbps: null,
      qualityLimitationReason: null,
      degradationPreference: null,
      nativeDroppedFrames: 0,
      droppedFramesDelta: 0,
      severeLagEvents: 0,
      severeLagEventsDelta: 0,
      submitMs: null,
      captureToRendererMs: null,
      frameAgeMs: null,
      lastUpdatedAt: 0,
      lastLoggedStallSeconds: 0,
      lastLoggedStressSeconds: 0,
    };

    this.lastDegradeTime = 0;
    this.lastRecoverTime = 0;
    this.goodHealthStart = 0;
    this._streamStartTime = 0;
    this._stuckAtMinSince = 0;
    this._lastHealthState = 'starting';
    this._warningStreak = 0;
    this._isolatedStreak = 0;

    this.degradeCooldownMs = 2500;
    this.warningDegradeCooldownMs = 6000;
    this.defaultRecoverCooldownMs = 1500;
    this.defaultRecoverWaitMs = 2500;
    this.defaultStartupRampMs = 4000;
    this.recoverCooldownMs = this.defaultRecoverCooldownMs;
    this.recoverWaitMs = this.defaultRecoverWaitMs;
    this.startupRampMs = this.defaultStartupRampMs;

    this.jitterWarnMs = 55;
    this.jitterCriticalMs = 85;
    // Native DXGI capture produces avg ~100 ms jitter-buffer at the receiver
    // (vs ~50 ms for screen-capture streams). Thresholds are calibrated for
    // native DXGI so the ABR doesn't false-warn on normal operation.
    this.jitterBufferWarnMs = 145;
    this.jitterBufferCriticalMs = 200;
    this.jitterBufferGrowthWarnMs = 4.0;
    this.jitterBufferGrowthCriticalMs = 10.0;
    this.sustainedJitterBufferWarnMs = 110;
    this.sustainedJitterBufferCriticalMs = 155;
    this.decodeLatencyWarnMs = 18;
    this.decodeLatencyCriticalMs = 30;
    this.lossWarnRate = 0.03;
    this.lossCriticalRate = 0.06;
    this.recoveryProbeMs = 12000;
    this.recoveryJitterBufferMaxMs = 135; // native DXGI steady-state ~100 ms
    this.fullRecoveryJitterBufferMaxMs = 120; // native DXGI steady-state ~100 ms
    this.fullRecoveryJitterBufferDeltaMaxMs = 0.75;
    this.playoutDeltaWarnToleranceMs = 180;
    this.playoutDeltaCriticalToleranceMs = 260;
    this.fullRecoveryPlayoutDeltaToleranceMs = 160;
    this.fullRecoveryHoldMs = 8000;
    this.receiverSettleGraceMs = 10000;
    this.senderStressEncodeWarnRatio = 0.82;
    this.senderStressSourceWarnRatio = 0.85;
    this.senderStressSevereRatio = 0.65;
    this.senderStressFrameAgeWarnMs = 45;
    this.senderStressSubmitWarnMs = 28;
    this.senderStressPipelineWarnMs = 32;
    this.senderStressDropWarnFrames = 6;
    this._serverBwe = null;
    this._serverBweTime = 0;

    this.rttWarnMs = 130;
    this.rttCriticalMs = 220;
    this.nackRateWarn = 0.03;
    this.nackRateCritical = 0.08;
    this.scoreWarn = 7;
    this.scoreCritical = 4;
  }

  get tiers() { return DEGRADATION_TIERS; }

  get currentTier() { return this.tiers[this.tierIndex]; }

  get effectiveBitrate() {
    return Math.max(this.floor, Math.round(this.profileMaxBitrate * this.currentTier.bitratePct));
  }

  get effectiveFps() {
    return Math.max(24, Math.round(this.profileMaxFps * this.currentTier.fpsFraction));
  }

  setProfile(bitrate, fps, options = {}) {
    this.profileMaxBitrate = bitrate;
    this.profileMaxFps = fps || 60;
    this.floor = Math.max(SMOOTHNESS_PROFILE.minBitrate, Math.round(this.profileMaxBitrate * 0.18));
    this.startupTierIndex = Math.min(
      options.startTierIndex ?? this.defaultStartupTierIndex,
      this.tiers.length - 1
    );
    this.recoverCooldownMs = options.recoverCooldownMs ?? this.defaultRecoverCooldownMs;
    this.recoverWaitMs = options.recoverWaitMs ?? this.defaultRecoverWaitMs;
    this.startupRampMs = options.startupRampMs ?? this.defaultStartupRampMs;
    this.tierIndex = Math.min(this.startupTierIndex, this.tiers.length - 1);
    this._streamStartTime = Date.now();
    this._stuckAtMinSince = 0;
    this._warningStreak = 0;
    this._isolatedStreak = 0;
    this._lastHealthState = 'starting';
    this._applyTier();
  }

  onViewerReport(viewerId, report) {
    if (!this.enabled) return;

    let health = this.viewerHealth.get(viewerId);
    if (!health) {
      health = {
        fpsSamples: [],
        jitterSamples: [],
        droppedFramesSamples: [],
        jitterBufferSamples: [],
        jitterBufferDeltaSamples: [],
        decodeLatencySamples: [],
        videoCurrentTimeDeltaSamples: [],
        lossRate: 0,
        baselineFps: 0,
        baselineSamples: 0,
        bitrateMbps: 0,
        lastReportAt: 0,
        firstReportAt: 0,
        settleGraceUntil: 0,
      };
      this.viewerHealth.set(viewerId, health);
    }

    const now = Date.now();
    if (!health.firstReportAt) {
      health.firstReportAt = now;
      health.settleGraceUntil = now + this.receiverSettleGraceMs;
    }

    const fps = report.fps || 0;
    health.fpsSamples.push(fps);
    if (health.fpsSamples.length > 8) health.fpsSamples.shift();

    health.jitterSamples.push(report.jitterMs || 0);
    if (health.jitterSamples.length > 8) health.jitterSamples.shift();

    health.droppedFramesSamples.push(report.droppedFramesDelta || 0);
    if (health.droppedFramesSamples.length > 8) health.droppedFramesSamples.shift();

    health.jitterBufferSamples.push(report.jitterBufferDelayMs || 0);
    if (health.jitterBufferSamples.length > 8) health.jitterBufferSamples.shift();

    health.jitterBufferDeltaSamples.push(report.jitterBufferDeltaMs || 0);
    if (health.jitterBufferDeltaSamples.length > 8) health.jitterBufferDeltaSamples.shift();

    health.decodeLatencySamples.push(report.decodeLatencyMs || 0);
    if (health.decodeLatencySamples.length > 8) health.decodeLatencySamples.shift();

    if (report.videoCurrentTimeDeltaMs > 0) {
      health.videoCurrentTimeDeltaSamples.push(report.videoCurrentTimeDeltaMs);
      if (health.videoCurrentTimeDeltaSamples.length > 8) health.videoCurrentTimeDeltaSamples.shift();
    }

    health.lossRate = report.lossRate || 0;
    health.bitrateMbps = report.bitrateMbps || 0;
    health.lastReportAt = now;

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

  onServerBwe(bweData) {
    this._serverBwe = bweData;
    this._serverBweTime = Date.now();
  }

  updateProducerStats(stats) {
    this._producerStats.bitrateMbps = stats.bitrateMbps || 0;
    this._producerStats.fps = stats.fps || 0;
    this._producerStats.sourceFps = stats.sourceFps || 0;
    this._producerStats.availableOutgoingBitrateMbps = stats.availableOutgoingBitrateMbps ?? null;
    this._producerStats.qualityLimitationReason = stats.qualityLimitationReason || null;
    this._producerStats.degradationPreference = stats.degradationPreference || null;
    this._producerStats.submitMs = stats.submitMs ?? null;
    this._producerStats.captureToRendererMs = stats.captureToRendererMs ?? null;
    this._producerStats.frameAgeMs = stats.frameAgeMs ?? null;

    const previousDroppedFrames = this._producerStats.nativeDroppedFrames || 0;
    const nextDroppedFrames = stats.nativeDroppedFrames ?? previousDroppedFrames;
    this._producerStats.nativeDroppedFrames = nextDroppedFrames;
    this._producerStats.droppedFramesDelta = Math.max(0, nextDroppedFrames - previousDroppedFrames);

    const previousSevereLagEvents = this._producerStats.severeLagEvents || 0;
    const nextSevereLagEvents = stats.severeLagEvents ?? previousSevereLagEvents;
    this._producerStats.severeLagEvents = nextSevereLagEvents;
    this._producerStats.severeLagEventsDelta = Math.max(0, nextSevereLagEvents - previousSevereLagEvents);
    this._producerStats.lastUpdatedAt = Date.now();

    const targetFps = this.effectiveFps;
    const severeEncodeDip = stats.fps != null && stats.fps < Math.max(12, targetFps * 0.4);
    const severeBitrateDip = stats.bitrateMbps != null && stats.bitrateMbps < Math.max(0.75, (this.effectiveBitrate / 1e6) * 0.22);

    if (severeEncodeDip && severeBitrateDip) {
      this._producerStats.stallSeconds += 1;
      if (this._producerStats.stallSeconds >= 3 &&
          this._producerStats.lastLoggedStallSeconds !== this._producerStats.stallSeconds) {
        this._producerStats.lastLoggedStallSeconds = this._producerStats.stallSeconds;
        this._logSession('encoder-stall', {
          stallSeconds: this._producerStats.stallSeconds,
          bitrateMbps: Number((stats.bitrateMbps || 0).toFixed(2)),
          fps: stats.fps || 0,
          tier: this.currentTier.label,
        });
      }
    } else {
      this._producerStats.stallSeconds = Math.max(0, this._producerStats.stallSeconds - 1);
      if (this._producerStats.stallSeconds === 0) {
        this._producerStats.lastLoggedStallSeconds = 0;
      }
    }

    const effectiveBitrateMbps = this.effectiveBitrate / 1e6;
    const qualityLimitationReason = (stats.qualityLimitationReason || '').toLowerCase();
    const availableOutgoingBitrateMbps = stats.availableOutgoingBitrateMbps;
    const headroomHealthy = qualityLimitationReason !== 'bandwidth' && (
      availableOutgoingBitrateMbps == null ||
      availableOutgoingBitrateMbps + 0.35 >= effectiveBitrateMbps * 0.92
    );
    this._producerStats.headroomHealthy = headroomHealthy;

    const encodeWarnFps = Math.max(20, targetFps * this.senderStressEncodeWarnRatio);
    const sourceWarnFps = Math.max(20, targetFps * this.senderStressSourceWarnRatio);
    const severeWarnFps = Math.max(14, targetFps * this.senderStressSevereRatio);
    const encodeDip = stats.fps != null && stats.fps < encodeWarnFps;
    const sourceDip = stats.sourceFps != null && stats.sourceFps > 0 && stats.sourceFps < sourceWarnFps;
    const severeEncodeStress = stats.fps != null && stats.fps < severeWarnFps;
    const severeSourceStress = stats.sourceFps != null && stats.sourceFps > 0 && stats.sourceFps < severeWarnFps;
    const bitrateDip = stats.bitrateMbps != null && stats.bitrateMbps < Math.max(1.5, effectiveBitrateMbps * 0.68);
    const pipelinePressure =
      (stats.submitMs != null && stats.submitMs >= this.senderStressSubmitWarnMs) ||
      (stats.captureToRendererMs != null && stats.captureToRendererMs >= this.senderStressPipelineWarnMs) ||
      (stats.frameAgeMs != null && stats.frameAgeMs >= this.senderStressFrameAgeWarnMs) ||
      (this._producerStats.droppedFramesDelta >= this.senderStressDropWarnFrames) ||
      (this._producerStats.severeLagEventsDelta > 0);
    const balancedPreference = this.currentTier.label === 'FULL' || stats.degradationPreference === 'balanced';
    const severeSenderStress = headroomHealthy && severeEncodeStress && (severeSourceStress || pipelinePressure || bitrateDip);
    const senderStress = headroomHealthy && (
      balancedPreference
        ? ((encodeDip && sourceDip) || (encodeDip && (pipelinePressure || bitrateDip)) || (sourceDip && pipelinePressure))
        : ((severeEncodeStress || severeSourceStress) && (pipelinePressure || bitrateDip))
    );

    if (severeSenderStress || senderStress) {
      const nextStressSeconds = this._producerStats.stressSeconds + (severeSenderStress ? 2 : 1);
      this._producerStats.stressSeconds = Math.min(6, nextStressSeconds);
      this._producerStats.stressReason = [
        encodeDip ? 'encode-fps-dip' : null,
        sourceDip ? 'source-fps-dip' : null,
        bitrateDip ? 'bitrate-dip' : null,
        pipelinePressure ? 'pipeline-pressure' : null,
      ].filter(Boolean).join(',') || 'sender-stress';
      if (this._producerStats.stressSeconds >= 2 &&
          this._producerStats.lastLoggedStressSeconds !== this._producerStats.stressSeconds) {
        this._producerStats.lastLoggedStressSeconds = this._producerStats.stressSeconds;
        this._logSession('encoder-pressure', {
          stressSeconds: this._producerStats.stressSeconds,
          stressReason: this._producerStats.stressReason,
          bitrateMbps: Number((stats.bitrateMbps || 0).toFixed(2)),
          fps: stats.fps || 0,
          sourceFps: stats.sourceFps || 0,
          availableOutgoingBitrateMbps: availableOutgoingBitrateMbps ?? null,
          qualityLimitationReason: stats.qualityLimitationReason || null,
          droppedFramesDelta: this._producerStats.droppedFramesDelta,
          severeLagEventsDelta: this._producerStats.severeLagEventsDelta,
          tier: this.currentTier.label,
        });
      }
    } else {
      this._producerStats.stressSeconds = Math.max(0, this._producerStats.stressSeconds - 1);
      if (this._producerStats.stressSeconds === 0) {
        this._producerStats.stressReason = null;
        this._producerStats.lastLoggedStressSeconds = 0;
      }
    }
  }

  _logSession(type, payload) {
    if (window.electron?.sessionLog) {
      window.electron.sessionLog(type, payload);
    }
  }

  evaluate() {
    if (!this.enabled || this.viewerHealth.size === 0) return;

    const now = Date.now();
    const assessment = this._assessHealth();
    this._reportAssessment(assessment);

    if (!this._evalCounter) this._evalCounter = 0;
    this._evalCounter++;
    if (this._evalCounter % 3 === 0) {
      let diag = '[ABR:TICK] tier=' + this.currentTier.label + ' health=' + assessment.state;
      for (const [viewerId, health] of this.viewerHealth) {
        const recent = health.fpsSamples.slice(-3);
        const recentAvg = recent.length ? (recent.reduce((a, b) => a + b, 0) / recent.length).toFixed(1) : '?';
        const baseline = health.baselineSamples >= 3 ? health.baselineFps.toFixed(1) : '(learning)';
        const jRecent = health.jitterSamples.slice(-3);
        const jAvg = jRecent.length ? (jRecent.reduce((a, b) => a + b, 0) / jRecent.length).toFixed(1) : '?';
        const jbufRecent = health.jitterBufferSamples.slice(-3);
        const jbufAvg = jbufRecent.length ? (jbufRecent.reduce((a, b) => a + b, 0) / jbufRecent.length).toFixed(1) : '?';
        const jdeltaRecent = health.jitterBufferDeltaSamples.slice(-3);
        const jdeltaAvg = jdeltaRecent.length ? (jdeltaRecent.reduce((a, b) => a + b, 0) / jdeltaRecent.length).toFixed(2) : '?';
        const dropRecent = health.droppedFramesSamples.slice(-3);
        const dropAvg = dropRecent.length ? (dropRecent.reduce((a, b) => a + b, 0) / dropRecent.length).toFixed(1) : '0';
        diag += ' | v=' + viewerId.substring(0, 6) + ' fps=' + recentAvg + '/' + baseline + ' jitter=' + jAvg + 'ms jbuf=' + jbufAvg + 'ms jdelta=' + jdeltaAvg + 'ms loss=' + (health.lossRate * 100).toFixed(1) + '% drops=' + dropAvg;
      }
      if (this.goodHealthStart) {
        diag += ' | goodFor=' + ((now - this.goodHealthStart) / 1000).toFixed(1) + 's';
      }
      if (assessment.bottleneckViewerId) {
        diag += ' | bottleneck=' + assessment.bottleneckViewerId.substring(0, 6);
      }
      const bwe = this._serverBwe;
      const bweAge = now - this._serverBweTime;
      if (bwe && bweAge < 5000) {
        const agg = bwe.aggregate;
        diag += ' | BWE rtt=' + (agg.worstRttMs || '--') + 'ms nack=' + ((agg.worstNackRate || 0) * 100).toFixed(1) + '% score=' + (agg.minScore != null ? agg.minScore : '--') + ' avail=' + (agg.minAvailableMbps != null ? agg.minAvailableMbps.toFixed(1) : '--') + 'Mbps spread=' + (agg.viewerSpreadMbps != null ? agg.viewerSpreadMbps.toFixed(1) : '--') + 'Mbps';
      }
      logger.debug(diag);
    }

    const inStartupRamp = (now - this._streamStartTime) < this.startupRampMs;

    if (assessment.state === 'source-stall') {
      this.goodHealthStart = 0;
      return;
    }

    if (assessment.state === 'critical' || assessment.state === 'encoder-stall') {
      this._warningStreak = 0;
      this._isolatedStreak = 0;
      this.goodHealthStart = 0;
      if (now - this.lastDegradeTime >= this.degradeCooldownMs) {
        this._stepDown(assessment.state === 'critical' ? 2 : 1, assessment);
        this._stuckAtMinSince = 0;
      }
    } else if (assessment.state === 'warning') {
      this._warningStreak++;
      this._isolatedStreak = 0;
      this.goodHealthStart = 0;
      if (this._warningStreak >= 3 &&
          this._shouldDegradeOnWarning(assessment) &&
          now - this.lastDegradeTime >= this.warningDegradeCooldownMs) {
        this._stepDown(1, assessment);
        this._stuckAtMinSince = 0;
      }
    } else if (assessment.state === 'isolated-warning' || assessment.state === 'isolated-critical') {
      this._warningStreak = 0;
      this._isolatedStreak++;
      this.goodHealthStart = 0;
      const isolatedThreshold = assessment.state === 'isolated-critical' ? 2 : 4;
      if (this._isolatedStreak >= isolatedThreshold &&
          this._shouldDegradeOnWarning(assessment) &&
          now - this.lastDegradeTime >= this.warningDegradeCooldownMs) {
        this._stepDown(1, assessment);
        this._stuckAtMinSince = 0;
      }
    } else if (assessment.state === 'good') {
      this._warningStreak = 0;
      this._isolatedStreak = 0;
      if (this.tierIndex > 0) {
        if (!this.goodHealthStart) {
          this.goodHealthStart = now;
        } else if (now - this.goodHealthStart >= (inStartupRamp ? 1500 : this.recoverWaitMs) &&
                   now - this.lastRecoverTime >= this.recoverCooldownMs &&
                   this._canStepUp(now, assessment)) {
          this._stepUp(1, assessment);
        }
      } else {
        this.goodHealthStart = 0;
        this._stuckAtMinSince = 0;
      }
    }

    // Recovery probe: force a step-up if stuck at a degraded tier past the probe timeout.
    // Fires at LAST (always) or at any tier >1 below the startup tier (RESCUE and below),
    // using twice the normal probe interval so it only kicks in as a deadlock-breaker.
    const isStuckAtMin = this.tierIndex === this.tiers.length - 1;
    const isStuckDeep = this.tierIndex >= this.startupTierIndex + 3;
    if (isStuckAtMin || isStuckDeep) {
      if (!this._stuckAtMinSince) {
        this._stuckAtMinSince = now;
      } else {
        const probeMs = isStuckAtMin ? this.recoveryProbeMs : this.recoveryProbeMs * 2;
        if (now - this._stuckAtMinSince >= probeMs &&
            assessment.state !== 'critical' && assessment.state !== 'encoder-stall') {
          logger.info('[ABR] Recovery probe — stuck at ' + this.currentTier.label + ' for ' +
            ((now - this._stuckAtMinSince) / 1000).toFixed(0) + 's, trying step up');
          this._stepUp(1, assessment);
          this._stuckAtMinSince = now;
        }
      }
    } else {
      this._stuckAtMinSince = 0;
    }
  }

  _assessHealth() {
    const now = Date.now();
    let worstJitter = 0;
    let worstLoss = 0;
    let viewerCount = 0;
    let warningViewers = 0;
    let criticalViewers = 0;
    let allZeroViewers = true;
    let bottleneckViewerId = null;
    let worstViewerScore = -Infinity;
    let worstDecodeLatency = 0;
    let worstJitterBuffer = 0;
    let worstJitterBufferDelta = 0;
    let worstPlayoutDrift = 0;

    for (const [viewerId, health] of this.viewerHealth) {
      if (health.fpsSamples.length < 2) continue;
      viewerCount++;

      const recent = health.fpsSamples.slice(-3);
      const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const baseline = health.baselineSamples >= 3 ? health.baselineFps : recentAvg;
      const avgJitter = health.jitterSamples.slice(-3).reduce((a, b) => a + b, 0) / Math.min(health.jitterSamples.length, 3);
      const avgDrops = health.droppedFramesSamples.slice(-3).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(health.droppedFramesSamples.length, 3));
      const avgJitterBuffer = health.jitterBufferSamples.slice(-3).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(health.jitterBufferSamples.length, 3));
      const avgJitterBufferDelta = health.jitterBufferDeltaSamples.slice(-3).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(health.jitterBufferDeltaSamples.length, 3));
      const avgDecodeLatency = health.decodeLatencySamples.slice(-3).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(health.decodeLatencySamples.length, 3));
      const playoutRecent = health.videoCurrentTimeDeltaSamples.slice(-3);
      const avgVideoCurrentTimeDelta = playoutRecent.length
        ? (playoutRecent.reduce((a, b) => a + b, 0) / playoutRecent.length)
        : 1000;
      const playoutDrift = Math.abs(avgVideoCurrentTimeDelta - 1000);
      const inSettleGrace = now < (health.settleGraceUntil || 0);
      const sustainedBufferPressure = !inSettleGrace && avgJitterBuffer > this.sustainedJitterBufferWarnMs;
      const sustainedCriticalBufferPressure = !inSettleGrace && avgJitterBuffer > this.sustainedJitterBufferCriticalMs;
      const unstableBufferGrowth = !inSettleGrace && avgJitterBufferDelta > this.jitterBufferGrowthWarnMs;
      const unstableCriticalBufferGrowth = !inSettleGrace && avgJitterBufferDelta > this.jitterBufferGrowthCriticalMs;

      let score = 0;
      let viewerState = 'good';
      if (baseline > 5 && recentAvg < baseline * 0.45) {
        score += 4;
        viewerState = 'critical';
      } else if (baseline > 5 && recentAvg < baseline * 0.75) {
        score += 2;
        viewerState = 'warning';
      }
      if (avgJitter > this.jitterCriticalMs ||
          health.lossRate > this.lossCriticalRate ||
          avgDrops >= 6 ||
          avgDecodeLatency > this.decodeLatencyCriticalMs ||
          avgJitterBuffer > this.jitterBufferCriticalMs ||
          (sustainedCriticalBufferPressure && (unstableCriticalBufferGrowth || playoutDrift > this.playoutDeltaWarnToleranceMs || recentAvg < baseline * 0.75)) ||
          playoutDrift > this.playoutDeltaCriticalToleranceMs) {
        score += 3;
        viewerState = 'critical';
      } else if (avgJitter > this.jitterWarnMs ||
                 health.lossRate > this.lossWarnRate ||
                 avgDrops >= 2 ||
                 avgDecodeLatency > this.decodeLatencyWarnMs ||
                 avgJitterBuffer > this.jitterBufferWarnMs ||
                 (sustainedBufferPressure && (unstableBufferGrowth || playoutDrift > this.playoutDeltaWarnToleranceMs || recentAvg < baseline * 0.9)) ||
                 playoutDrift > this.playoutDeltaWarnToleranceMs) {
        score += 1;
        if (viewerState === 'good') viewerState = 'warning';
      }

      if (viewerState === 'critical') criticalViewers++;
      else if (viewerState === 'warning') warningViewers++;

      if (score > worstViewerScore) {
        worstViewerScore = score;
        bottleneckViewerId = viewerId;
      }

      worstJitter = Math.max(worstJitter, avgJitter);
      worstLoss = Math.max(worstLoss, health.lossRate);
      worstDecodeLatency = Math.max(worstDecodeLatency, avgDecodeLatency);
      worstJitterBuffer = Math.max(worstJitterBuffer, avgJitterBuffer);
      worstJitterBufferDelta = Math.max(worstJitterBufferDelta, avgJitterBufferDelta);
      worstPlayoutDrift = Math.max(worstPlayoutDrift, playoutDrift);
      if (recentAvg > 0 || health.bitrateMbps > 0.3) allZeroViewers = false;
    }

    if (viewerCount > 0 && allZeroViewers) {
      return {
        state: 'source-stall',
        reason: 'all-viewers-stalled',
        viewerCount,
        warningViewers,
        criticalViewers,
        bottleneckViewerId,
        worstJitterBuffer,
        worstJitterBufferDelta,
        worstPlayoutDrift,
      };
    }

    let bweWarn = false;
    let bweCritical = false;
    let isolatedTransport = false;
    let aggregate = null;
    const bwe = this._serverBwe;
    const bweAge = Date.now() - this._serverBweTime;
    if (bwe && bweAge < 5000) {
      aggregate = bwe.aggregate;
      if (aggregate.worstRttMs != null && aggregate.worstRttMs > 0 && aggregate.worstRttMs < 10000) {
        if (aggregate.worstRttMs > this.rttCriticalMs) bweCritical = true;
        else if (aggregate.worstRttMs > this.rttWarnMs) bweWarn = true;
      }
      if (aggregate.worstNackRate > this.nackRateCritical) bweCritical = true;
      else if (aggregate.worstNackRate > this.nackRateWarn) bweWarn = true;
      if (aggregate.minScore != null) {
        if (aggregate.minScore <= this.scoreCritical) bweCritical = true;
        else if (aggregate.minScore <= this.scoreWarn) bweWarn = true;
      }
      if (aggregate.bottleneckViewerId) bottleneckViewerId = aggregate.bottleneckViewerId;
      if (aggregate.lowHeadroomViewers === 1 && viewerCount > 1 && aggregate.viewerSpreadMbps >= 3) {
        isolatedTransport = true;
      }
    }

    const impactedThreshold = Math.max(1, Math.ceil(viewerCount / 2));
    let state = 'good';
    if (criticalViewers >= impactedThreshold || bweCritical) {
      state = 'critical';
    } else if (criticalViewers === 1 && viewerCount > 1 && !bweCritical) {
      state = isolatedTransport ? 'warning' : 'isolated-critical';
    } else if (warningViewers >= impactedThreshold || bweWarn) {
      state = 'warning';
    } else if (warningViewers === 1 && viewerCount > 1) {
      state = isolatedTransport ? 'warning' : 'isolated-warning';
    }

    if (this._producerStats.stallSeconds >= 2) {
      return {
        state: 'encoder-stall',
        reason: 'encoder-stall',
        viewerCount,
        warningViewers,
        criticalViewers,
        bottleneckViewerId,
        worstDecodeLatency,
        worstJitterBuffer,
        worstJitterBufferDelta,
        worstPlayoutDrift,
        producerFps: this._producerStats.fps || 0,
        producerSourceFps: this._producerStats.sourceFps || 0,
        producerStressSeconds: this._producerStats.stressSeconds || 0,
        producerStressReason: this._producerStats.stressReason || null,
        aggregate,
      };
    }

    return {
      state,
      reason: [
        criticalViewers ? ('critical-viewers=' + criticalViewers) : null,
        warningViewers ? ('warning-viewers=' + warningViewers) : null,
        bweCritical ? 'bwe-critical' : null,
        bweWarn ? 'bwe-warning' : null,
      ].filter(Boolean).join(','),
      viewerCount,
      warningViewers,
      criticalViewers,
      worstJitter,
      worstLoss,
      worstDecodeLatency,
      worstJitterBuffer,
      worstJitterBufferDelta,
      worstPlayoutDrift,
      producerFps: this._producerStats.fps || 0,
      producerSourceFps: this._producerStats.sourceFps || 0,
      producerStressSeconds: this._producerStats.stressSeconds || 0,
      producerStressReason: this._producerStats.stressReason || null,
      producerHeadroomHealthy: this._producerStats.headroomHealthy,
      bottleneckViewerId,
      aggregate,
    };
  }

  _reportAssessment(assessment) {
    if (assessment.state !== this._lastHealthState) {
      logger.info('[ABR] Health ' + this._lastHealthState + ' -> ' + assessment.state +
        (assessment.reason ? ' (' + assessment.reason + ')' : ''));
      this._logSession('network-health', {
        state: assessment.state,
        previousState: this._lastHealthState,
        reason: assessment.reason || null,
        tier: this.currentTier.label,
        viewerCount: assessment.viewerCount || 0,
        warningViewers: assessment.warningViewers || 0,
        criticalViewers: assessment.criticalViewers || 0,
        worstJitterBufferMs: assessment.worstJitterBuffer || 0,
        worstJitterBufferDeltaMs: assessment.worstJitterBufferDelta || 0,
        worstPlayoutDriftMs: assessment.worstPlayoutDrift || 0,
        producerFps: assessment.producerFps || 0,
        producerSourceFps: assessment.producerSourceFps || 0,
        producerStressSeconds: assessment.producerStressSeconds || 0,
        producerStressReason: assessment.producerStressReason || null,
        producerHeadroomHealthy: assessment.producerHeadroomHealthy || false,
        bottleneckViewerId: assessment.bottleneckViewerId || null,
      });
      this._lastHealthState = assessment.state;
    }
  }

  _canStepUp(now, assessment) {
    if (this.tierIndex === 0) return false;

    const nextTier = this.tiers[this.tierIndex - 1];
    const steppingToFull = this.tierIndex - 1 === 0;
    const neededMbps = (this.profileMaxBitrate * nextTier.bitratePct) / 1e6;
    const viewerMbps = this._getMinViewerBitrate();
    let currentMbps = viewerMbps;

    if ((assessment?.worstJitterBuffer || 0) > this.recoveryJitterBufferMaxMs) {
      if (this._evalCounter % 3 === 0) {
        logger.debug('[ABR] Recovery gated: jitterBuffer=' + assessment.worstJitterBuffer.toFixed(1) + 'ms');
      }
      return false;
    }

    if (steppingToFull) {
      if (now - this.lastDegradeTime < this.fullRecoveryHoldMs) {
        if (this._evalCounter % 3 === 0) {
          logger.debug('[ABR] Recovery gated: hold-before-FULL ' + ((this.fullRecoveryHoldMs - (now - this.lastDegradeTime)) / 1000).toFixed(1) + 's remaining');
        }
        return false;
      }
      if ((assessment?.worstJitterBuffer || 0) > this.fullRecoveryJitterBufferMaxMs) {
        if (this._evalCounter % 3 === 0) {
          logger.debug('[ABR] Recovery gated: FULL requires jitterBuffer<=' + this.fullRecoveryJitterBufferMaxMs + 'ms, actual=' + assessment.worstJitterBuffer.toFixed(1) + 'ms');
        }
        return false;
      }
      if ((assessment?.worstJitterBufferDelta || 0) > this.fullRecoveryJitterBufferDeltaMaxMs) {
        if (this._evalCounter % 3 === 0) {
          logger.debug('[ABR] Recovery gated: FULL requires draining/stable jitterBuffer, delta<=' + this.fullRecoveryJitterBufferDeltaMaxMs.toFixed(2) + 'ms, actual=' + assessment.worstJitterBufferDelta.toFixed(2) + 'ms');
        }
        return false;
      }
      if ((assessment?.worstPlayoutDrift || 0) > this.fullRecoveryPlayoutDeltaToleranceMs) {
        if (this._evalCounter % 3 === 0) {
          logger.debug('[ABR] Recovery gated: FULL requires playout drift<=' + this.fullRecoveryPlayoutDeltaToleranceMs + 'ms, actual=' + assessment.worstPlayoutDrift.toFixed(1) + 'ms');
        }
        return false;
      }
    }

    const bwe = this._serverBwe;
    const bweAge = now - this._serverBweTime;
    if (bwe && bweAge < 5000) {
      const agg = bwe.aggregate;
      currentMbps = Math.max(currentMbps, agg.medianDeliveryMbps || 0, agg.minAvailableMbps || 0);
      if ((agg.lowHeadroomViewers || 0) > 0 && (agg.bottleneckStreak || 0) >= 2) {
        // lowHeadroomViewers fires whenever delivery < 5 Mbps, which is always true
        // when at RESCUE/SHIELD tiers. Only block recovery when available bandwidth
        // is actually insufficient for the next tier — not just because the current
        // tier's delivery is below a fixed 5 Mbps floor.
        const availMbps = agg.minAvailableMbps || 0;
        if (!availMbps || availMbps < neededMbps * 1.3) {
          if (this._evalCounter % 3 === 0) {
            logger.debug('[ABR] Recovery gated: low-headroom streak=' + agg.bottleneckStreak +
              ' avail=' + availMbps.toFixed(1) + 'Mbps needed=' + neededMbps.toFixed(1) + 'Mbps');
          }
          return false;
        }
      }
    }

    const threshold = this.tierIndex === this.startupTierIndex ? 0.55 : 0.72;
    if (currentMbps < neededMbps * threshold) {
      if (this._evalCounter % 3 === 0) {
        logger.debug('[ABR] Recovery gated: need ' + neededMbps.toFixed(1) + 'Mbps, actual=' + currentMbps.toFixed(1) + 'Mbps');
      }
      return false;
    }

    return true;
  }

  _shouldDegradeOnWarning(assessment) {
    const aggregate = assessment.aggregate;
    const currentTargetMbps = this.effectiveBitrate / 1e6;
    const viewerDeliveryMbps = Math.max(this._getMinViewerBitrate(), aggregate?.minDeliveryMbps || 0);
    const availableMbps = aggregate?.minAvailableMbps || 0;
    const transportPressure =
      (aggregate?.worstRttMs || 0) > this.rttWarnMs ||
      (aggregate?.worstNackRate || 0) > this.nackRateWarn ||
      (aggregate?.minScore != null && aggregate.minScore <= this.scoreWarn);
    const headroomTight =
      (availableMbps > 0 && availableMbps < currentTargetMbps * 0.9) ||
      (viewerDeliveryMbps > 0 && viewerDeliveryMbps < currentTargetMbps * 0.72);
    const decodePressure = (assessment.worstDecodeLatency || 0) > this.decodeLatencyWarnMs;
    const latencyPressure = (assessment.worstJitterBuffer || 0) > this.recoveryJitterBufferMaxMs;
    const bufferGrowthPressure = (assessment.worstJitterBufferDelta || 0) > this.jitterBufferGrowthWarnMs;
    const playoutPressure = (assessment.worstPlayoutDrift || 0) > this.playoutDeltaWarnToleranceMs;
    const viewerPressure = (assessment.worstLoss || 0) > this.lossWarnRate;

    return transportPressure || headroomTight || decodePressure || (latencyPressure && (bufferGrowthPressure || playoutPressure)) || viewerPressure;
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
      const jitterBufferRecent = health.jitterBufferSamples.slice(-3);
      const jitterBufferAvg = jitterBufferRecent.reduce((a, b) => a + b, 0) / Math.max(1, jitterBufferRecent.length);
      const jitterBufferDeltaRecent = health.jitterBufferDeltaSamples.slice(-3);
      const jitterBufferDeltaAvg = jitterBufferDeltaRecent.reduce((a, b) => a + b, 0) / Math.max(1, jitterBufferDeltaRecent.length);
      const playoutRecent = health.videoCurrentTimeDeltaSamples.slice(-3);
      const playoutAvg = playoutRecent.length
        ? (playoutRecent.reduce((a, b) => a + b, 0) / playoutRecent.length)
        : 1000;
      const playoutDrift = Math.abs(playoutAvg - 1000);
      const drops = health.droppedFramesSamples.slice(-3).reduce((a, b) => a + b, 0);
      if (Date.now() < (health.settleGraceUntil || 0)) return false;
      if (baseline > 5 && recentAvg < baseline * 0.95) return false;
      if (jAvg > 25) return false;
      if (jitterBufferAvg > this.fullRecoveryJitterBufferMaxMs) return false;
      if (jitterBufferDeltaAvg > this.fullRecoveryJitterBufferDeltaMaxMs) return false;
      if (playoutDrift > this.fullRecoveryPlayoutDeltaToleranceMs) return false;
      if (health.lossRate > 0.01) return false;
      if (drops > 2) return false;
    }

    const bwe = this._serverBwe;
    const bweAge = Date.now() - this._serverBweTime;
    if (bwe && bweAge < 6000) {
      const agg = bwe.aggregate;
      if (agg.worstRttMs > 100) return false;
      if (agg.worstNackRate > 0.02) return false;
      if (agg.minScore != null && agg.minScore < 8) return false;
      if ((agg.lowHeadroomViewers || 0) > 0) return false;
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

  _stepDown(steps, assessment) {
    const prevTier = this.tierIndex;
    this.tierIndex = Math.min(this.tiers.length - 1, this.tierIndex + steps);
    this._producerStats.stressSeconds = 0;
    this._producerStats.stressReason = null;
    this._producerStats.lastLoggedStressSeconds = 0;
    if (this.tierIndex !== prevTier) {
      for (const [, health] of this.viewerHealth) {
        health.baselineSamples = 0;
        health.baselineFps = 0;
        health.settleGraceUntil = Date.now() + this.receiverSettleGraceMs;
      }
      this._applyTier();
      const t = this.currentTier;
      logger.warn('[ABR] DEGRADE tier ' + prevTier + '->' + this.tierIndex + ' (' + t.label + ') ' +
        (this.effectiveBitrate / 1e6).toFixed(1) + 'Mbps @' + this.effectiveFps + 'fps' +
        (t.scaleDown > 1 ? ' scale=' + t.scaleDown + 'x' : ''));
      this._logSession('abr-degrade', {
        from: prevTier,
        to: this.tierIndex,
        label: t.label,
        bitrateMbps: (this.effectiveBitrate / 1e6).toFixed(1),
        fps: this.effectiveFps,
        scaleDown: t.scaleDown,
        reason: assessment?.reason || null,
        health: assessment?.state || null,
        bottleneckViewerId: assessment?.bottleneckViewerId || null,
      });
      this._logSession('abr-decision', {
        action: 'degrade',
        from: prevTier,
        to: this.tierIndex,
        tier: t.label,
        health: assessment?.state || null,
        reason: assessment?.reason || null,
      });
    }
    this.lastDegradeTime = Date.now();
    this.goodHealthStart = 0;
  }

  _stepUp(steps, assessment) {
    const prevTier = this.tierIndex;
    this.tierIndex = Math.max(0, this.tierIndex - steps);
    this._producerStats.stressSeconds = 0;
    this._producerStats.stressReason = null;
    this._producerStats.lastLoggedStressSeconds = 0;
    if (this.tierIndex !== prevTier) {
      for (const [, health] of this.viewerHealth) {
        health.baselineSamples = 0;
        health.baselineFps = 0;
        health.settleGraceUntil = Date.now() + this.receiverSettleGraceMs;
      }
      this._applyTier();
      const t = this.currentTier;
      logger.info('[ABR] RECOVER tier ' + prevTier + '->' + this.tierIndex + ' (' + t.label + ') ' +
        (this.effectiveBitrate / 1e6).toFixed(1) + 'Mbps @' + this.effectiveFps + 'fps' +
        (t.scaleDown > 1 ? ' scale=' + t.scaleDown + 'x' : ''));
      this._logSession('abr-recover', {
        from: prevTier,
        to: this.tierIndex,
        label: t.label,
        bitrateMbps: (this.effectiveBitrate / 1e6).toFixed(1),
        fps: this.effectiveFps,
        scaleDown: t.scaleDown,
        health: assessment?.state || 'good',
      });
      this._logSession('abr-decision', {
        action: 'recover',
        from: prevTier,
        to: this.tierIndex,
        tier: t.label,
        health: assessment?.state || 'good',
        reason: assessment?.reason || 'good-health',
      });
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
    const desiredDegradationPreference = this.app._getDesiredVideoDegradationPreference?.() || null;
    const previousDegradationPreference = params.degradationPreference || null;
    params.encodings[0].maxBitrate = this.effectiveBitrate;
    params.encodings[0].maxFramerate = this.effectiveFps;
    params.encodings[0].scaleResolutionDownBy = tier.scaleDown;
    if (desiredDegradationPreference) {
      params.degradationPreference = desiredDegradationPreference;
    }

    sender.setParameters(params)
      .then(() => {
        if (desiredDegradationPreference) {
          this.app._noteVideoDegradationPreference(
            previousDegradationPreference,
            desiredDegradationPreference,
            'tier-apply'
          );
        }
      })
      .catch(err => {
        logger.warn('[ABR] setParameters failed: ' + err.message);
      });

    this._logSession('abr-tier-applied', {
      tier: tier.label,
      bitrateMbps: Number((this.effectiveBitrate / 1e6).toFixed(2)),
      fps: this.effectiveFps,
      scaleDown: tier.scaleDown,
      degradationPreference: desiredDegradationPreference || previousDegradationPreference || null,
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
// LUMINA APP (SFU MODE)
// ============================================
class LuminaApp {
  constructor() {
    try {
      this.socket = null;
      this.device = null;          // mediasoup Device
      this.sendTransport = null;   // mediasoup SendTransport
      this.videoProducer = null;   // mediasoup Producer (video)
      this.audioProducer = null;   // mediasoup Producer (audio)
      this.localStream = null;
      this.captureProfile = null;
      this.includeAudio = true;
      this.isBroadcasting = false;
      this.luminaName = '';
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
      this._captureDiagnosticsLogged = false;
      this._lastCaptureTelemetry = null;
      // Native DXGI video capture state
      this._nativeVideoCanvas = null;
      this._nativeVideoCtx = null;
      this._nativeVideoStream = null;
      this._nativeVideoActive = false;
      this._nativeVideoFrameCount = 0;
      this._nativeVideoGenerator = null;  // MediaStreamTrackGenerator if available
      this._nativeVideoWriter = null;
      this._nativeVideoLatestFrame = null;
      this._nativeVideoDeferredFrame = null;
      this._nativeVideoWriteInFlight = false;
      this._nativeVideoPumpScheduled = false;
      this._nativeVideoDelayedPumpTimer = null;
      this._nativeVideoDroppedFrames = 0;
      this._nativeVideoPacingDeferredDrops = 0;
      this._nativeVideoLastFrameAgeMs = null;
      this._nativeVideoMaxFrameAgeMs = 0;
      this._nativeVideoAgeSampleTotalMs = 0;
      this._nativeVideoAgeSampleCount = 0;
      this._nativeVideoLastCaptureEpochMs = null;
      this._nativePipelineTelemetry = null;
      this._lastNativePipelineLagLogAtMs = 0;
        this._lastNativeRendererBackpressureLogAtMs = 0;
      this._nativeVideoConfig = null;
      this._signalingSessionInfo = null;
      this._lastPipelineSnapshot = null;
      this._lastOutboundResolutionKey = null;
      this._lastVideoDegradationPreference = null;
      this._encoderResolutionDrift = null;
      this._viewerFrameSizeByViewer = new Map();
      this._currentCaptureMethod = null;
      this._resetEncoderResolutionDriftTelemetry();
      this.abr = new AdaptiveQualityController(this);

      logger.info('LuminaApp initializing (SFU mode)...');
      this.attachEventListeners();
      logger.info('Event listeners attached');
    } catch (err) {
      console.error('[APP] Constructor error:', err);
      logger.error('Init error: ' + err.message);
    }
  }

  _safeCloneMediaDict(dict) {
    if (!dict || typeof dict !== 'object') return null;
    const clone = {};
    for (const [key, value] of Object.entries(dict)) {
      if (value == null) continue;
      if (typeof value === 'number') {
        clone[key] = Number(value.toFixed ? value.toFixed(2) : value);
      } else if (typeof value === 'string' || typeof value === 'boolean') {
        clone[key] = value;
      } else if (Array.isArray(value)) {
        clone[key] = value.slice(0, 8);
      }
    }
    return Object.keys(clone).length ? clone : null;
  }

  _logSession(type, payload) {
    if (window.electron?.sessionLog) {
      window.electron.sessionLog(type, payload);
    }
  }

  _resetNativeFrameTelemetry() {
    this._nativeVideoLastFrameAgeMs = null;
    this._nativeVideoMaxFrameAgeMs = 0;
    this._nativeVideoAgeSampleTotalMs = 0;
    this._nativeVideoAgeSampleCount = 0;
    this._nativeVideoLastCaptureEpochMs = null;
    this._nativePipelineTelemetry = {
      captureToMainTotalMs: 0,
      captureToMainCount: 0,
      captureToMainMaxMs: 0,
      captureToMainLastMs: null,
      mainToRendererTotalMs: 0,
      mainToRendererCount: 0,
      mainToRendererMaxMs: 0,
      mainToRendererLastMs: null,
      captureToRendererTotalMs: 0,
      captureToRendererCount: 0,
      captureToRendererMaxMs: 0,
      captureToRendererLastMs: null,
      rendererQueueTotalMs: 0,
      rendererQueueCount: 0,
      rendererQueueMaxMs: 0,
      rendererQueueLastMs: null,
      submitTotalMs: 0,
      submitCount: 0,
      submitMaxMs: 0,
      submitLastMs: null,
      writeDurationTotalMs: 0,
      writeDurationCount: 0,
      writeDurationMaxMs: 0,
      writeDurationLastMs: null,
      severeLagEvents: 0,
    };
    this._lastNativePipelineLagLogAtMs = 0;
  }

  _recordNativePipelineMetric(metricName, valueMs) {
    if (!(typeof valueMs === 'number') || !Number.isFinite(valueMs) || valueMs < 0) return;
    if (!this._nativePipelineTelemetry) this._resetNativeFrameTelemetry();

    const totalKey = metricName + 'TotalMs';
    const countKey = metricName + 'Count';
    const maxKey = metricName + 'MaxMs';
    const lastKey = metricName + 'LastMs';

    this._nativePipelineTelemetry[totalKey] = (this._nativePipelineTelemetry[totalKey] || 0) + valueMs;
    this._nativePipelineTelemetry[countKey] = (this._nativePipelineTelemetry[countKey] || 0) + 1;
    this._nativePipelineTelemetry[maxKey] = Math.max(this._nativePipelineTelemetry[maxKey] || 0, valueMs);
    this._nativePipelineTelemetry[lastKey] = valueMs;
  }

  _getNativePipelineTelemetrySnapshot() {
    if (!this._nativePipelineTelemetry) return null;

    const summarize = (metricName) => {
      const count = this._nativePipelineTelemetry[metricName + 'Count'] || 0;
      if (!count) return null;
      return {
        lastMs: Number((this._nativePipelineTelemetry[metricName + 'LastMs'] || 0).toFixed(1)),
        avgMs: Number((this._nativePipelineTelemetry[metricName + 'TotalMs'] / count).toFixed(1)),
        maxMs: Number((this._nativePipelineTelemetry[metricName + 'MaxMs'] || 0).toFixed(1)),
      };
    };

    const snapshot = {
      captureToMainMs: summarize('captureToMain'),
      mainToRendererMs: summarize('mainToRenderer'),
      captureToRendererMs: summarize('captureToRenderer'),
      rendererQueueMs: summarize('rendererQueue'),
      submitMs: summarize('submit'),
      writeDurationMs: summarize('writeDuration'),
      severeLagEvents: this._nativePipelineTelemetry.severeLagEvents || 0,
    };

    return Object.values(snapshot).some(value => value != null && (!(typeof value === 'number') || value > 0))
      ? snapshot
      : null;
  }

  _maybeLogNativePipelineLag(details) {
    if (!details) return;

    const severe =
      (details.captureToRendererMs != null && details.captureToRendererMs >= 150) ||
      (details.rendererQueueMs != null && details.rendererQueueMs >= 50) ||
      (details.submitMs != null && details.submitMs >= 180) ||
      (details.writeDurationMs != null && details.writeDurationMs >= 16);
    if (!severe) return;

    const now = Date.now();
    if (now - (this._lastNativePipelineLagLogAtMs || 0) < 5000) return;
    this._lastNativePipelineLagLogAtMs = now;

    if (this._nativePipelineTelemetry) {
      this._nativePipelineTelemetry.severeLagEvents = (this._nativePipelineTelemetry.severeLagEvents || 0) + 1;
    }

    const payload = {
      captureToMainMs: details.captureToMainMs ?? null,
      mainToRendererMs: details.mainToRendererMs ?? null,
      captureToRendererMs: details.captureToRendererMs ?? null,
      rendererQueueMs: details.rendererQueueMs ?? null,
      submitMs: details.submitMs ?? null,
      writeDurationMs: details.writeDurationMs ?? null,
      width: details.width ?? null,
      height: details.height ?? null,
      captureMethod: this._currentCaptureMethod || null,
      signalingSessionId: this._getCurrentSignalingSessionId(),
      signalingSessionDirName: this._getCurrentSignalingSessionDirName(),
    };

    logger.warn('[NATIVE-PIPELINE] capToMain=' + (payload.captureToMainMs != null ? payload.captureToMainMs.toFixed(1) : '--') +
      'ms mainToRenderer=' + (payload.mainToRendererMs != null ? payload.mainToRendererMs.toFixed(1) : '--') +
      'ms capToRenderer=' + (payload.captureToRendererMs != null ? payload.captureToRendererMs.toFixed(1) : '--') +
      'ms queue=' + (payload.rendererQueueMs != null ? payload.rendererQueueMs.toFixed(1) : '--') +
      'ms submit=' + (payload.submitMs != null ? payload.submitMs.toFixed(1) : '--') +
      'ms write=' + (payload.writeDurationMs != null ? payload.writeDurationMs.toFixed(1) : '--') + 'ms');

    this._logSession('native-pipeline-lag', payload);
  }

  _maybeLogNativeRendererBackpressure(details = {}) {
    const droppedFrames = this._nativeVideoDroppedFrames || 0;
    if (!droppedFrames) return;

    const now = Date.now();
    if (now - (this._lastNativeRendererBackpressureLogAtMs || 0) < 5000) return;
    this._lastNativeRendererBackpressureLogAtMs = now;

    const payload = {
      droppedFrames,
      pacingDeferredDrops: this._nativeVideoPacingDeferredDrops || 0,
      mainToRendererMs: details.mainToRendererMs ?? null,
      captureToRendererMs: details.captureToRendererMs ?? null,
      frameWidth: details.width ?? null,
      frameHeight: details.height ?? null,
      reason: details.reason || 'latest-frame-overwritten',
      writeInFlight: !!this._nativeVideoWriteInFlight,
      captureMethod: this._currentCaptureMethod || null,
      signalingSessionId: this._getCurrentSignalingSessionId(),
      signalingSessionDirName: this._getCurrentSignalingSessionDirName(),
    };

    logger.warn('[NATIVE-VIDEO] Renderer backpressure dropping stale frames=' + droppedFrames +
      ' deferredDrops=' + (payload.pacingDeferredDrops || 0) +
      ' mainToRenderer=' + (payload.mainToRendererMs != null ? payload.mainToRendererMs.toFixed(1) : '--') +
      'ms capToRenderer=' + (payload.captureToRendererMs != null ? payload.captureToRendererMs.toFixed(1) : '--') + 'ms');

    this._logSession('native-renderer-backpressure', payload);
  }

  _recordNativeFrameTelemetry(meta) {
    const epochTimestampUs = meta?.epochTimestampUs;
    if (!epochTimestampUs) return null;

    const frameAgeMs = Math.max(0, Date.now() - (epochTimestampUs / 1000));
    this._nativeVideoLastFrameAgeMs = frameAgeMs;
    this._nativeVideoMaxFrameAgeMs = Math.max(this._nativeVideoMaxFrameAgeMs || 0, frameAgeMs);
    this._nativeVideoAgeSampleTotalMs = (this._nativeVideoAgeSampleTotalMs || 0) + frameAgeMs;
    this._nativeVideoAgeSampleCount = (this._nativeVideoAgeSampleCount || 0) + 1;
    this._nativeVideoLastCaptureEpochMs = epochTimestampUs / 1000;
    return frameAgeMs;
  }

  _getNativeFrameTelemetrySnapshot() {
    if (!(this._nativeVideoAgeSampleCount > 0)) return null;

    return {
      lastFrameAgeMs: Number((this._nativeVideoLastFrameAgeMs || 0).toFixed(1)),
      avgFrameAgeMs: Number((this._nativeVideoAgeSampleTotalMs / this._nativeVideoAgeSampleCount).toFixed(1)),
      maxFrameAgeMs: Number((this._nativeVideoMaxFrameAgeMs || 0).toFixed(1)),
      lastCaptureAtIso: this._nativeVideoLastCaptureEpochMs
        ? new Date(this._nativeVideoLastCaptureEpochMs).toISOString()
        : null,
    };
  }

  _getCurrentSignalingSessionId() {
    return this._signalingSessionInfo?.sessionId || null;
  }

  _getCurrentSignalingSessionDirName() {
    return this._signalingSessionInfo?.sessionDirName || null;
  }

  _resetEncoderResolutionDriftTelemetry() {
    this._encoderResolutionDrift = {
      activeSinceMs: 0,
      lastLoggedAtMs: 0,
      lastEnforceAtMs: 0,
      resolutionKey: null,
      qualityLimitationReason: null,
    };
  }

  _getDesiredVideoDegradationPreference() {
    if (!this._isGameCapture) return null;
    return this.abr?.currentTier?.label === 'FULL' ? 'balanced' : 'maintain-framerate';
  }

  _noteVideoDegradationPreference(previousPreference, nextPreference, reason = 'tier-apply') {
    if (!nextPreference) return;

    const priorPreference = previousPreference || this._lastVideoDegradationPreference || null;
    this._lastVideoDegradationPreference = nextPreference;
    if (priorPreference === nextPreference) return;

    logger.info('[ENCODER] degradationPreference ' + (priorPreference || '--') + ' -> ' + nextPreference +
      ' (' + reason + ')');
    this._logSession('encoder-degradation-preference', {
      previousPreference: priorPreference,
      nextPreference,
      reason,
      abrTier: this.abr.tierIndex,
      abrLabel: this.abr.currentTier?.label || null,
      signalingSessionId: this._getCurrentSignalingSessionId(),
      signalingSessionDirName: this._getCurrentSignalingSessionDirName(),
      captureMethod: this._currentCaptureMethod || null,
    });
  }

  _getExpectedOutboundSize(capture) {
    const sourceWidth = capture?.sourceWidth || this.captureProfile?.width || null;
    const sourceHeight = capture?.sourceHeight || this.captureProfile?.height || null;
    const scaleDown = this.abr?.currentTier?.scaleDown || 1;
    if (!sourceWidth || !sourceHeight || !scaleDown) {
      return { expectedOutboundWidth: null, expectedOutboundHeight: null };
    }

    return {
      expectedOutboundWidth: Math.max(1, Math.round(sourceWidth / scaleDown)),
      expectedOutboundHeight: Math.max(1, Math.round(sourceHeight / scaleDown)),
    };
  }

  _maybeTrackEncoderResolutionDrift(snapshot) {
    const capture = snapshot?.capture;
    if (!this._isGameCapture || !capture?.outboundWidth || !capture?.outboundHeight) return;

    const expected = this._getExpectedOutboundSize(capture);
    capture.expectedOutboundWidth = capture.expectedOutboundWidth ?? expected.expectedOutboundWidth;
    capture.expectedOutboundHeight = capture.expectedOutboundHeight ?? expected.expectedOutboundHeight;
    capture.degradationPreference = capture.degradationPreference ||
      this._lastVideoDegradationPreference ||
      this._getDesiredVideoDegradationPreference();

    if (!capture.expectedOutboundWidth || !capture.expectedOutboundHeight) {
      capture.encoderResolutionDrift = false;
      return;
    }

    const widthRatio = capture.outboundWidth / capture.expectedOutboundWidth;
    const heightRatio = capture.outboundHeight / capture.expectedOutboundHeight;
    const driftDetected = widthRatio < 0.92 || heightRatio < 0.92;
    capture.encoderResolutionDrift = driftDetected;

    if (!driftDetected) {
      this._resetEncoderResolutionDriftTelemetry();
      return;
    }

    if (!this._encoderResolutionDrift) {
      this._resetEncoderResolutionDriftTelemetry();
    }

    const now = Date.now();
    const resolutionKey = capture.outboundWidth + 'x' + capture.outboundHeight;
    const limitationReason = capture.qualityLimitationReason || 'unknown';
    if (this._encoderResolutionDrift.resolutionKey !== resolutionKey ||
        this._encoderResolutionDrift.qualityLimitationReason !== limitationReason) {
      this._encoderResolutionDrift.activeSinceMs = now;
      this._encoderResolutionDrift.resolutionKey = resolutionKey;
      this._encoderResolutionDrift.qualityLimitationReason = limitationReason;
    }

    const driftAgeMs = now - (this._encoderResolutionDrift.activeSinceMs || now);
    if (driftAgeMs < 4000) return;

    if (now - (this._encoderResolutionDrift.lastLoggedAtMs || 0) >= 5000) {
      this._encoderResolutionDrift.lastLoggedAtMs = now;
      logger.warn('[ENCODER] Resolution drift at ' + resolutionKey +
        ' expected=' + capture.expectedOutboundWidth + 'x' + capture.expectedOutboundHeight +
        ' qlim=' + limitationReason +
        ' pref=' + (capture.degradationPreference || '--') +
        ' tier=' + this.abr.getStatusText());
      this._logSession('encoder-resolution-drift', {
        actualFrameSize: resolutionKey,
        expectedFrameSize: capture.expectedOutboundWidth + 'x' + capture.expectedOutboundHeight,
        outboundWidth: capture.outboundWidth,
        outboundHeight: capture.outboundHeight,
        expectedOutboundWidth: capture.expectedOutboundWidth,
        expectedOutboundHeight: capture.expectedOutboundHeight,
        widthRatio: Number(widthRatio.toFixed(3)),
        heightRatio: Number(heightRatio.toFixed(3)),
        qualityLimitationReason: limitationReason,
        degradationPreference: capture.degradationPreference || null,
        availableOutgoingBitrateMbps: capture.availableOutgoingBitrateMbps ?? null,
        deliveryBitrateMbps: snapshot?.bwe?.deliveryMbps ?? null,
        abrTier: this.abr.tierIndex,
        abrLabel: this.abr.currentTier?.label || null,
        signalingSessionId: this._getCurrentSignalingSessionId(),
        signalingSessionDirName: this._getCurrentSignalingSessionDirName(),
        captureMethod: this._currentCaptureMethod || null,
      });
    }

    const effectiveBitrateMbps = Number((this.abr.effectiveBitrate / 1e6).toFixed(2));
    const availableOutgoingBitrateMbps = capture.availableOutgoingBitrateMbps;
    const hasHeadroom = availableOutgoingBitrateMbps == null ||
      availableOutgoingBitrateMbps + 0.25 >= effectiveBitrateMbps;
    if (this.abr.currentTier?.label === 'FULL' &&
        hasHeadroom &&
        now - (this._encoderResolutionDrift.lastEnforceAtMs || 0) >= 10000) {
      this._encoderResolutionDrift.lastEnforceAtMs = now;
      logger.warn('[ENCODER] FULL tier drift persists with headroom; reapplying sender params');
      this._logSession('encoder-resolution-enforce', {
        actualFrameSize: resolutionKey,
        expectedFrameSize: capture.expectedOutboundWidth + 'x' + capture.expectedOutboundHeight,
        qualityLimitationReason: limitationReason,
        degradationPreference: capture.degradationPreference || null,
        availableOutgoingBitrateMbps: availableOutgoingBitrateMbps ?? null,
        effectiveBitrateMbps,
        abrTier: this.abr.tierIndex,
        abrLabel: this.abr.currentTier?.label || null,
        signalingSessionId: this._getCurrentSignalingSessionId(),
        signalingSessionDirName: this._getCurrentSignalingSessionDirName(),
        captureMethod: this._currentCaptureMethod || null,
      });
      this.abr._applyTier();
    }
  }

  _logViewerFrameSizeChange(data) {
    if (!data?.viewerId || !data.frameWidth || !data.frameHeight) return;

    const nextFrameSize = data.frameWidth + 'x' + data.frameHeight;
    const previousFrameSize = this._viewerFrameSizeByViewer.get(data.viewerId) || null;
    if (previousFrameSize === nextFrameSize) return;

    this._viewerFrameSizeByViewer.set(data.viewerId, nextFrameSize);

    const viewer = this.viewers.get(data.viewerId);
    const capture = this._lastPipelineSnapshot?.capture || null;
    logger.info('[DIAG:VIEWER-SIZE] ' + (viewer?.name || data.viewerId) + ' ' +
      (previousFrameSize || '--') + ' -> ' + nextFrameSize +
      ' while outbound=' + (capture?.outboundWidth || '--') + 'x' + (capture?.outboundHeight || '--') +
      ' tier=' + this.abr.getStatusText());

    this._logSession('viewer-frame-size-change', {
      viewerId: data.viewerId,
      viewerName: viewer?.name || null,
      previousFrameSize,
      nextFrameSize,
      frameWidth: data.frameWidth,
      frameHeight: data.frameHeight,
      outboundWidth: capture?.outboundWidth ?? null,
      outboundHeight: capture?.outboundHeight ?? null,
      sourceWidth: capture?.sourceWidth ?? null,
      sourceHeight: capture?.sourceHeight ?? null,
      abrTier: this.abr.tierIndex,
      abrLabel: this.abr.currentTier?.label || null,
      signalingSessionId: data.signalingSessionId || this._getCurrentSignalingSessionId(),
      signalingSessionDirName: this._getCurrentSignalingSessionDirName(),
      captureMethod: this._currentCaptureMethod || null,
    });
  }

  _logOutboundResolutionChange(capture) {
    if (!capture?.outboundWidth || !capture?.outboundHeight) return;

    const expected = this._getExpectedOutboundSize(capture);
    const expectedOutboundWidth = capture.expectedOutboundWidth ?? expected.expectedOutboundWidth;
    const expectedOutboundHeight = capture.expectedOutboundHeight ?? expected.expectedOutboundHeight;
    const degradationPreference = capture.degradationPreference ||
      this._lastVideoDegradationPreference ||
      this._getDesiredVideoDegradationPreference();

    const nextKey = capture.outboundWidth + 'x' + capture.outboundHeight;
    if (this._lastOutboundResolutionKey === nextKey) return;

    const previousKey = this._lastOutboundResolutionKey;
    this._lastOutboundResolutionKey = nextKey;

    logger.info('[DIAG:OUTBOUND-SIZE] ' + (previousKey || '--') + ' -> ' + nextKey +
      ' source=' + (capture.sourceWidth || '--') + 'x' + (capture.sourceHeight || '--') +
      ' expected=' + (expectedOutboundWidth || '--') + 'x' + (expectedOutboundHeight || '--') +
      ' qlim=' + (capture.qualityLimitationReason || 'none') +
      ' pref=' + (degradationPreference || '--') +
      ' tier=' + this.abr.getStatusText());

    this._logSession('outbound-resolution-change', {
      previousFrameSize: previousKey,
      nextFrameSize: nextKey,
      outboundWidth: capture.outboundWidth,
      outboundHeight: capture.outboundHeight,
      expectedOutboundWidth,
      expectedOutboundHeight,
      sourceWidth: capture.sourceWidth ?? null,
      sourceHeight: capture.sourceHeight ?? null,
      sourceFps: capture.sourceFps ?? null,
      qualityLimitationReason: capture.qualityLimitationReason ?? null,
      degradationPreference: degradationPreference || null,
      encoderResolutionDrift: !!capture.encoderResolutionDrift,
      abrTier: this.abr.tierIndex,
      abrLabel: this.abr.currentTier?.label || null,
      signalingSessionId: this._getCurrentSignalingSessionId(),
      signalingSessionDirName: this._getCurrentSignalingSessionDirName(),
      captureMethod: this._currentCaptureMethod || null,
    });
  }

  _logCaptureTrackDiagnostics(track, context = {}) {
    if (!track || !window.electron?.sessionLog) return;

    const payload = {
      sourceId: context.sourceId || null,
      sourceName: context.sourceName || null,
      captureMethod: context.captureMethod || null,
      requested: this._safeCloneMediaDict(context.requested || null),
      settings: this._safeCloneMediaDict(track.getSettings?.() || null),
      constraints: this._safeCloneMediaDict(track.getConstraints?.() || null),
      capabilities: this._safeCloneMediaDict(track.getCapabilities?.() || null),
      label: track.label || null,
      readyState: track.readyState || null,
      contentHint: track.contentHint || null,
    };

    logger.info('[DIAG:CAPTURE-TRACK] requested=' + JSON.stringify(payload.requested) +
      ' settings=' + JSON.stringify(payload.settings) +
      ' constraints=' + JSON.stringify(payload.constraints) +
      (payload.capabilities ? ' capabilities=' + JSON.stringify(payload.capabilities) : ''));
    window.electron.sessionLog('capture-track-diagnostics', payload);
  }

  _extractVideoPipelineStats(stats) {
    const snapshot = {
      outbound: null,
      mediaSource: null,
      track: null,
      codec: null,
      candidatePair: null,
    };

    stats.forEach((report) => {
      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        snapshot.outbound = {
          framesEncoded: report.framesEncoded ?? null,
          frameWidth: report.frameWidth ?? null,
          frameHeight: report.frameHeight ?? null,
          qualityLimitationReason: report.qualityLimitationReason || null,
          qualityLimitationDurations: report.qualityLimitationDurations || null,
          qualityLimitationResolutionChanges: report.qualityLimitationResolutionChanges ?? null,
          hugeFramesSent: report.hugeFramesSent ?? null,
          pliCount: report.pliCount ?? null,
          firCount: report.firCount ?? null,
          nackCount: report.nackCount ?? null,
          totalEncodeTime: report.totalEncodeTime ?? null,
          totalPacketSendDelay: report.totalPacketSendDelay ?? null,
          encoderImplementation: report.encoderImplementation || null,
          powerEfficientEncoder: report.powerEfficientEncoder ?? null,
          codecId: report.codecId || null,
        };
      } else if ((report.type === 'media-source' || report.type === 'track') && report.kind === 'video') {
        const target = report.type === 'media-source' ? 'mediaSource' : 'track';
        snapshot[target] = {
          frames: report.frames ?? null,
          framesPerSecond: report.framesPerSecond ?? null,
          frameWidth: report.width ?? report.frameWidth ?? null,
          frameHeight: report.height ?? report.frameHeight ?? null,
        };
      } else if (report.type === 'codec' && snapshot.outbound?.codecId && report.id === snapshot.outbound.codecId) {
        snapshot.codec = {
          mimeType: report.mimeType || null,
          sdpFmtpLine: report.sdpFmtpLine || null,
        };
      } else if (report.type === 'candidate-pair' && report.nominated) {
        snapshot.candidatePair = {
          currentRoundTripTime: report.currentRoundTripTime ?? null,
          availableOutgoingBitrate: report.availableOutgoingBitrate ?? null,
        };
      }
    });

    return snapshot;
  }

  attachEventListeners() {
    const connectBtn = document.getElementById('connectBtn');
    const refreshBtn = document.getElementById('refreshSourcesBtn');
    const stopBtn = document.getElementById('stopStreamBtn');
    const clearLogsBtn = document.getElementById('toggleDebug');
    const includeAudio = document.getElementById('includeAudio');

    if (connectBtn) connectBtn.addEventListener('click', () => this.connect());
    if (refreshBtn) refreshBtn.addEventListener('click', () => this.loadCaptureSources());
    if (stopBtn) stopBtn.addEventListener('click', () => this.stopStreaming());
    if (clearLogsBtn) clearLogsBtn.addEventListener('click', () => logger.clear());

    this.refreshQualityProfileUi();

    if (includeAudio) {
      includeAudio.checked = this.includeAudio;
      includeAudio.addEventListener('change', () => {
        this.includeAudio = includeAudio.checked;
        logger.info('Source audio ' + (this.includeAudio ? 'enabled' : 'disabled'));
      });
    }
  }

  getActiveQualityProfile() {
    return SMOOTHNESS_PROFILE;
  }

  async updateProducerEncoding() {
    const profile = this.getActiveQualityProfile();
    this.abr.setProfile(profile.maxBitrate, profile.maxFrameRate, {
      startTierIndex: profile.startTierIndex,
      recoverWaitMs: profile.recoverWaitMs,
      recoverCooldownMs: profile.recoverCooldownMs,
      startupRampMs: profile.startupRampMs,
    });
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
    const streamNameInput = document.getElementById('streamName');

    if (!serverUrlInput || !streamNameInput) {
      logger.error('Input elements not found');
      return;
    }

    const serverUrl = serverUrlInput.value.trim();
    const streamName = streamNameInput.value.trim();
    this.luminaName = streamName;
    this.serverUrl = serverUrl;

    if (!serverUrl || !streamName) {
      logger.error('Missing server URL or stream name');
      alert('Please fill in all fields');
      return;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.setStatus('Connecting...', 'blue');
    logger.info('Connecting to ' + serverUrl + ' as "' + streamName + '"');

    this.socket = new SignalClient(serverUrl, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      reconnectionAttempts: 10
    });

    this.socket.on('connect', () => {
      logger.info('CONNECTED TO SERVER');
      this.setStatus('Connected', 'green');
      this.socket.emit('register-streamer', { name: streamName });
    });

    this.socket.on('registered', async (data) => {
      logger.info('Registered as Lumina host — setting up SFU transport');
      try {
        this._signalingSessionInfo = data.signalingSession || null;
        if (this._signalingSessionInfo) {
          if (window.electron?.bindSignalingSessionDir && this._signalingSessionInfo.sessionDirName) {
            try {
              await window.electron.bindSignalingSessionDir(this._signalingSessionInfo.sessionDirName);
            } catch (bindError) {
              logger.warn('[SESSION] Failed to rebind session dir: ' + bindError.message);
            }
          }
          logger.info('[SESSION] Bound to signaling session ' + this._signalingSessionInfo.sessionId +
            ' (' + this._signalingSessionInfo.sessionDirName + ')');
          this._logSession('signaling-session-bound', {
            signalingSessionId: this._signalingSessionInfo.sessionId,
            signalingSessionDirName: this._signalingSessionInfo.sessionDirName || null,
            signalingStartedAt: this._signalingSessionInfo.startedAt || null,
          });
        }
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
      this._viewerFrameSizeByViewer.delete(data.viewerId);
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
        droppedFramesDelta: data.droppedFramesDelta || 0,
        jitterBufferDelayMs: data.jitterBufferDelayMs || 0,
        jitterBufferDeltaMs: data.jitterBufferDeltaMs || 0,
        decodeLatencyMs: data.decodeLatencyMs || 0,
        renderedFramesDelta: data.renderedFramesDelta || 0,
        totalVideoFrames: data.totalVideoFrames || 0,
        videoCurrentTimeSec: data.videoCurrentTimeSec || 0,
        videoCurrentTimeDeltaMs: data.videoCurrentTimeDeltaMs || 0,
        videoPlaybackRate: data.videoPlaybackRate || 0,
        videoReadyState: data.videoReadyState || 0,
        receiverPlayoutDelayHintMs: data.receiverPlayoutDelayHintMs || 0,
      });

      this._logViewerFrameSizeChange(data);

      if (!this._qrLogCounter) this._qrLogCounter = 0;
      this._qrLogCounter++;
      if (this._qrLogCounter % 5 === 0) {
        const viewer = this.viewers.get(data.viewerId);
        const name = viewer ? viewer.name : data.viewerId;
        logger.debug('[DIAG:QR] ' + name + ' | fps=' + data.fps + ' bitrate=' + data.bitrateMbps + 'Mbps res=' + data.frameWidth + 'x' + data.frameHeight + ' jitter=' + (data.jitterMs != null ? data.jitterMs : '--') + 'ms jbuf=' + (data.jitterBufferDelayMs != null ? data.jitterBufferDelayMs : '--') + 'ms jdelta=' + (data.jitterBufferDeltaMs != null ? data.jitterBufferDeltaMs : '--') + 'ms play=' + (data.videoCurrentTimeDeltaMs != null ? data.videoCurrentTimeDeltaMs : '--') + 'ms/s render=' + (data.renderedFramesDelta != null ? data.renderedFramesDelta : '--') + ' ready=' + (data.videoReadyState != null ? data.videoReadyState : '--') + ' rate=' + (data.videoPlaybackRate != null ? data.videoPlaybackRate : '--') + ' hint=' + (data.receiverPlayoutDelayHintMs != null ? data.receiverPlayoutDelayHintMs : '--') + 'ms drops=' + (data.droppedFramesDelta || 0) + ' decode=' + (data.decodeLatencyMs != null ? data.decodeLatencyMs : '--') + 'ms [ABR:' + this.abr.getStatusText() + ']');
      }
    });

    this.socket.on('server-bwe', (data) => {
      this.abr.onServerBwe(data);

      // Log BWE data periodically (every other event ≈ every 4s)
      if (!this._bweLogCounter) this._bweLogCounter = 0;
      this._bweLogCounter++;
      if (this._bweLogCounter % 2 === 0) {
        const agg = data.aggregate;
        logger.debug('[BWE] rtt=' + (agg.worstRttMs || '--') + 'ms nack=' + ((agg.worstNackRate || 0) * 100).toFixed(1) + '% score=' + (agg.minScore != null ? agg.minScore : '--') + ' avail=' + (agg.minAvailableMbps != null ? agg.minAvailableMbps.toFixed(1) : '--') + 'Mbps del=' + (agg.minDeliveryMbps != null ? agg.minDeliveryMbps.toFixed(1) : '--') + 'Mbps spread=' + (agg.viewerSpreadMbps != null ? agg.viewerSpreadMbps.toFixed(1) : '--') + 'Mbps bottleneck=' + (agg.bottleneckViewerName || '--'));
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
          this.startStreaming(
            source.id,
            source.name,
            source.isGame,
            source.gameHwnd,
            source.gamePid,
            source.gameProcess,
            source.classificationReason
          );
        });
        grid.appendChild(sourceEl);
      });
    } catch (error) {
      logger.error('Failed to load sources: ' + error.message);
    }
  }

  async startStreaming(sourceId, sourceName, isGame = false, gameHwnd = null, gamePid = null, gameProcess = null, classificationReason = null) {
    try {
      const inferredKnownGame = !isGame ? inferKnownGameFromTitle(sourceName) : null;
      if (!isGame && inferredKnownGame) {
        isGame = true;
        gameProcess = gameProcess || inferredKnownGame.processName;
        classificationReason = classificationReason || 'runtime-known-game-title-match';
        logger.warn('[GAME] Promoting likely game window to GAME MODE via title heuristic: ' + sourceName);
      }

      logger.info('Starting stream: ' + sourceName + (isGame ? ' [GAME MODE]' : ''));

      this._isGameCapture = isGame;
      this._nativeGamePid = gamePid;
      const isWindowCapture = sourceId.startsWith('window:');

      // ── NATIVE DXGI CAPTURE (preferred for games) ────────────────
      // Bypasses Chromium's ~30 fps desktop capture bottleneck by using
      // DXGI Desktop Duplication directly from the native addon.
      let stream = null;
      let captureMethod = null;

      if (isGame) {
        const prof = this.getActiveQualityProfile();
        stream = await this._startNativeVideoCapture(prof);
        if (stream) {
          captureMethod = 'native-dxgi';
          logger.info('[GAME] Using native DXGI capture — bypassing Chromium getUserMedia');
        }
      }

      // ── FALLBACK: Chromium getUserMedia ──────────────────────────
      if (!stream) {
        // For games detected as window sources, switch to screen capture (DXGI via Chromium)
        if (isGame && isWindowCapture) {
          logger.info('[GAME] Window capture unreliable for DX/Vulkan games — switching to screen capture');
          const screenId = await this._findScreenSource();
          if (screenId) {
            sourceId = screenId;
            this._gameUsedScreenFallback = true;
          } else {
            logger.warn('[GAME] No screen source found, falling back to window capture');
          }
        }

        if (sourceId.startsWith('window:') && window.electron?.prepareForCapture) {
          logger.info('Minimizing streamer window before window capture');
          await window.electron.prepareForCapture();
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        stream = await this.captureSourceStream(sourceId);
        captureMethod = this._gameUsedScreenFallback ? 'screen-dxgi-chromium' : (sourceId.startsWith('window:') ? 'window-wgc' : 'screen-dxgi-chromium');
      }

      this._lastSourceId = sourceId;
      if (!this._gameUsedScreenFallback) this._gameUsedScreenFallback = false;

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.contentHint = 'motion';
        const settings = videoTrack.getSettings();
        const nativeConfig = this._nativeVideoConfig || null;
        this.captureProfile = {
          width: settings.width || nativeConfig?.width || 1280,
          height: settings.height || nativeConfig?.height || 720,
          frameRate: settings.frameRate || nativeConfig?.targetFps || 60
        };
        const prof = this.getActiveQualityProfile();
        this.abr.setProfile(prof.maxBitrate, prof.maxFrameRate, {
          startTierIndex: prof.startTierIndex,
          recoverWaitMs: prof.recoverWaitMs,
          recoverCooldownMs: prof.recoverCooldownMs,
          startupRampMs: prof.startupRampMs,
        });
        this._lastVideoDegradationPreference = null;
        this._resetEncoderResolutionDriftTelemetry();
        const initialBitrate = this.abr.effectiveBitrate;
        const initialFps = this.abr.effectiveFps;
        const initialScaleDown = this.abr.currentTier.scaleDown;
        this._currentCaptureMethod = captureMethod || 'unknown';
        logger.info(
          '[DIAG:CAPTURE] actual=' + settings.width + 'x' + settings.height + '@' + Math.round(settings.frameRate || 60) + 'fps' +
          ' | profile=' + prof.label + ' maxRes=' + prof.maxWidth + 'x' + prof.maxHeight +
          ' maxBitrate=' + (prof.maxBitrate / 1000000) + 'Mbps' +
          (isGame ? ' | GAME-OPTIMISED' : '')
        );
        logger.info('[ABR] Starting at ' + this.abr.getStatusText() + ' for conservative warm-up');

        // Produce video via SFU transport (single encoder for ALL viewers!)
        this.videoProducer = await this.sendTransport.produce({
          track: videoTrack,
          encodings: [{
            maxBitrate: initialBitrate,
            maxFramerate: initialFps,
            scaleResolutionDownBy: initialScaleDown,
          }],
          codecOptions: {
            videoGoogleStartBitrate: Math.round(Math.min(prof.startBitrate, initialBitrate) / 1000),
          },
        });

        this.abr._applyTier();

        logger.info('[SFU] Video producer created (id: ' + this.videoProducer.id + ')');

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
      } else if (this.includeAudio && isGame && gamePid) {
        // Kick off native process-loopback audio in the background so the video
        // stream is NOT blocked by the 5-second WASAPI activation timeout.
        // This captures ONLY the game's audio (via WASAPI process-loopback),
        // not system-wide desktop audio.
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
          sourceId, sourceName, isGame, gameHwnd, gamePid, gameProcess, classificationReason,
          profile: this.captureProfile,
          captureMethod: captureMethod || 'unknown',
          nativeVideoFrameCount: this._nativeVideoFrameCount || 0,
          signalingSessionId: this._getCurrentSignalingSessionId(),
          signalingSessionDirName: this._getCurrentSignalingSessionDirName(),
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
    const allowAudioCapture = this.includeAudio && !this._isGameCapture;
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
    const captureMethod = sourceId.startsWith('screen:') ? 'screen-dxgi' : 'window-wgc';

    if (!allowAudioCapture) {
      if (this.includeAudio && this._isGameCapture) {
        logger.info('[GAME] Desktop audio capture disabled — native process-loopback will provide game-only audio');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
      const track = stream.getVideoTracks()[0];
      if (track) {
        this._logCaptureTrackDiagnostics(track, {
          sourceId,
          sourceName: this._lastSelectedSourceName || null,
          captureMethod,
          requested: mandatory,
        });
      }
      return stream;
    }

    try {
      logger.info('Attempting audio + video capture');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
          }
        },
        video: videoConstraints
      });
      const track = stream.getVideoTracks()[0];
      if (track) {
        this._logCaptureTrackDiagnostics(track, {
          sourceId,
          sourceName: this._lastSelectedSourceName || null,
          captureMethod,
          requested: mandatory,
        });
      }
      return stream;
    } catch (error) {
      logger.warn('Audio capture failed, falling back to video-only: ' + error.message);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
      const track = stream.getVideoTracks()[0];
      if (track) {
        this._logCaptureTrackDiagnostics(track, {
          sourceId,
          sourceName: this._lastSelectedSourceName || null,
          captureMethod,
          requested: mandatory,
        });
      }
      return stream;
    }
  }

  // ─────────────── Native DXGI Video Capture ───────────────
  // Bypasses Chromium's getUserMedia desktop capture (which is limited to
  // ~30-35 fps on current Electron/Chromium builds) by using DXGI Desktop
  // Duplication directly from the native addon.  Frames are delivered via
  // IPC and assembled into a MediaStreamTrack for WebRTC.

  /**
   * Starts native DXGI capture and returns a MediaStream with a video track
   * driven by frame data from the native addon.  Returns null if native
   * capture is unavailable or fails to start.
   */
  async _startNativeVideoCapture(profile) {
    if (!window.electron?.isNativeVideoCaptureAvailable) {
      logger.warn('[NATIVE-VIDEO] API not exposed in preload');
      if (window.electron?.sessionLog) window.electron.sessionLog('native-capture-unavailable', { reason: 'api-not-exposed' });
      return null;
    }

    const available = await window.electron.isNativeVideoCaptureAvailable();
    if (!available) {
      logger.warn('[NATIVE-VIDEO] Native video capture not available (addon not built?)');
      if (window.electron?.sessionLog) window.electron.sessionLog('native-capture-unavailable', { reason: 'addon-not-built' });
      return null;
    }

    const targetFps = profile?.maxFrameRate || profile?.frameRate || 60;
    const maxWidth = profile?.nativeMaxWidth || profile?.maxWidth || profile?.width || 1920;
    const maxHeight = profile?.nativeMaxHeight || profile?.maxHeight || profile?.height || 1080;
    const result = await window.electron.startNativeVideoCapture({ fps: targetFps, maxWidth, maxHeight });
    if (!result || !result.success) {
      logger.warn('[NATIVE-VIDEO] Start failed: ' + (result?.reason || 'unknown'));
      if (window.electron?.sessionLog) window.electron.sessionLog('native-capture-unavailable', { reason: result?.reason || 'start-failed' });
      return null;
    }

    const { width, height } = result;
    const bridgeMode = result?.bridgeMode || 'preload-direct';
    this._nativeVideoConfig = { width, height, targetFps, maxWidth, maxHeight, bridgeMode };
    logger.info('[NATIVE-VIDEO] DXGI capture started: ' + width + 'x' + height + ' target=' + targetFps + 'fps bridge=' + bridgeMode);

    const maxNativeWritesPerTurn = 3;
    const nativePumpBudgetMs = 8;
    const nativeWriteYieldThresholdMs = 4;

    // ── Path A: VideoFrame + MediaStreamTrackGenerator (zero-copy BGRA) ──
    if (typeof MediaStreamTrackGenerator !== 'undefined') {
      try {
        const generator = new MediaStreamTrackGenerator({ kind: 'video' });
        const writer = generator.writable.getWriter();
        this._nativeVideoGenerator = generator;
        this._nativeVideoWriter = writer;
        this._nativeVideoActive = true;
        this._nativeVideoFrameCount = 0;
        this._nativeVideoLatestFrame = null;
        this._nativeVideoDeferredFrame = null;
        this._nativeVideoWriteInFlight = false;
        this._nativeVideoPumpScheduled = false;
        this._nativeVideoDelayedPumpTimer = null;
        this._nativeVideoDroppedFrames = 0;
        this._nativeVideoPacingDeferredDrops = 0;
        this._resetNativeFrameTelemetry();
        this._lastNativeRendererBackpressureLogAtMs = 0;

        // MessageChannel fires as a task-queue job, not tied to display vsync.
        // requestAnimationFrame caps the pump to the display refresh rate and
        // defers during renderer-thread pauses, causing bridge-to-renderer spikes.
        // The native bridge now feeds the renderer directly. We keep a paced
        // deferred slot plus a latest-arrival slot so timing jitter does not
        // overwrite the next frame we intentionally held for cadence.
        const { port1: _pumpPort1, port2: _pumpPort2 } = new MessageChannel();
        this._nativePumpPort1 = _pumpPort1;
        this._nativePumpPort2 = _pumpPort2;
        // Target frame interval and staleness threshold
        const _frameIntervalMs = 1000 / targetFps;      // e.g. 16.67ms at 60fps
        const _maxFrameAgeMs = _frameIntervalMs * 2.5;  // ~41ms at 60fps
        let _lastFrameWrittenAtMs = 0;

        const scheduleDelayedPump = (delayMs) => {
          if (this._nativeVideoDelayedPumpTimer || !this._nativeVideoActive) {
            return;
          }
          this._nativeVideoDelayedPumpTimer = setTimeout(() => {
            this._nativeVideoDelayedPumpTimer = null;
            schedulePump();
          }, Math.max(1, delayMs));
        };

        const schedulePump = () => {
          if (
            this._nativeVideoPumpScheduled ||
            this._nativeVideoWriteInFlight ||
            !this._nativeVideoActive ||
            (!this._nativeVideoDeferredFrame && !this._nativeVideoLatestFrame)
          ) {
            return;
          }
          this._nativeVideoPumpScheduled = true;
          _pumpPort2.postMessage('');
        };

        _pumpPort1.onmessage = () => {
          this._nativeVideoPumpScheduled = false;
          pumpFrames();
        };

        const pumpFrames = async () => {
          if (this._nativeVideoWriteInFlight || !this._nativeVideoActive) return;
          this._nativeVideoWriteInFlight = true;
          try {
            const turnStartedPerf = performance.now();
            let writesThisTurn = 0;

            while (this._nativeVideoActive) {
              const fromDeferred = !!this._nativeVideoDeferredFrame;
              const nextFrame = this._nativeVideoDeferredFrame || this._nativeVideoLatestFrame;
              if (!nextFrame) break;

              if (fromDeferred) this._nativeVideoDeferredFrame = null;
              else this._nativeVideoLatestFrame = null;

              // Drop stale frames: if this frame sat in the pipeline longer than
              // 2.5× the target interval the encoder would encode frozen content.
              // This keeps ABR and encoder health signals honest after a stall.
              const _frameAgeMs = Date.now() - (nextFrame.receivedAtEpochMs ?? Date.now());
              if (_frameAgeMs > _maxFrameAgeMs) {
                this._nativeVideoDroppedFrames++;
                continue;
              }

              // Pace output to targetFps: absorbs IPC jitter so bursts of compressed
              // frame arrivals don't hit the encoder together and cause stalls.
              const _sinceLast = performance.now() - _lastFrameWrittenAtMs;
              if (_lastFrameWrittenAtMs > 0 && _sinceLast < _frameIntervalMs * 0.8) {
                this._nativeVideoDeferredFrame = nextFrame;
                scheduleDelayedPump(Math.ceil(_frameIntervalMs * 0.8 - _sinceLast));
                break;
              }

              let frame = null;
              let writeDurationMs = null;
              try {
                this._recordNativeFrameTelemetry(nextFrame.meta);
                this._recordNativePipelineMetric('captureToMain', nextFrame.meta?.captureToMainMs);
                this._recordNativePipelineMetric('mainToRenderer', nextFrame.mainToRendererMs);
                this._recordNativePipelineMetric('captureToRenderer', nextFrame.captureToRendererMs);
                const writeStartedAtMs = Date.now();
                const rendererQueueMs = nextFrame.receivedAtEpochMs != null
                  ? Math.max(0, writeStartedAtMs - nextFrame.receivedAtEpochMs)
                  : null;
                this._recordNativePipelineMetric('rendererQueue', rendererQueueMs);
                frame = new VideoFrame(new Uint8Array(nextFrame.buffer), {
                  format: 'BGRA',
                  codedWidth: nextFrame.meta.width,
                  codedHeight: nextFrame.meta.height,
                  timestamp: Math.round(nextFrame.meta.timestamp),
                });
                const writeStartedPerf = performance.now();
                await writer.write(frame);
                writeDurationMs = Math.max(0, performance.now() - writeStartedPerf);
                _lastFrameWrittenAtMs = performance.now();
                const submitMs = nextFrame.meta?.epochTimestampUs
                  ? Math.max(0, Date.now() - (nextFrame.meta.epochTimestampUs / 1000))
                  : null;
                this._recordNativePipelineMetric('writeDuration', writeDurationMs);
                this._recordNativePipelineMetric('submit', submitMs);
                this._maybeLogNativePipelineLag({
                  captureToMainMs: nextFrame.meta?.captureToMainMs ?? null,
                  mainToRendererMs: nextFrame.mainToRendererMs,
                  captureToRendererMs: nextFrame.captureToRendererMs,
                  rendererQueueMs,
                  submitMs,
                  writeDurationMs,
                  width: nextFrame.meta?.width,
                  height: nextFrame.meta?.height,
                });
                this._nativeVideoFrameCount++;
                if (this._nativeVideoFrameCount === 1) {
                  logger.info('[NATIVE-VIDEO] First VideoFrame written: ' +
                    nextFrame.meta.width + 'x' + nextFrame.meta.height);
                }
              } catch (e) {
                logger.warn('[NATIVE-VIDEO] VideoFrame error: ' + e.message);
              } finally {
                if (frame) frame.close();
              }

              writesThisTurn++;
              if (!this._nativeVideoDeferredFrame && !this._nativeVideoLatestFrame) {
                break;
              }

              const turnElapsedMs = Math.max(0, performance.now() - turnStartedPerf);
              if (
                writesThisTurn >= maxNativeWritesPerTurn ||
                turnElapsedMs >= nativePumpBudgetMs ||
                (writeDurationMs != null && writeDurationMs >= nativeWriteYieldThresholdMs)
              ) {
                break;
              }
            }
          } finally {
            this._nativeVideoWriteInFlight = false;
            if (this._nativeVideoActive && (this._nativeVideoDeferredFrame || this._nativeVideoLatestFrame)) {
              schedulePump();
            }
          }
        };

        window.electron.onGameVideoFrame((buffer, meta) => {
          if (!this._nativeVideoActive) return;
          const receivedAtEpochMs = Date.now();
          const mainToRendererMs = meta?.mainForwardedAtEpochMs != null
            ? Math.max(0, receivedAtEpochMs - meta.mainForwardedAtEpochMs)
            : null;
          const captureToRendererMs = meta?.epochTimestampUs
            ? Math.max(0, receivedAtEpochMs - (meta.epochTimestampUs / 1000))
            : null;
          const incomingFrame = {
            buffer,
            meta,
            receivedAtEpochMs,
            mainToRendererMs,
            captureToRendererMs,
          };

          if (this._nativeVideoLatestFrame) {
            this._nativeVideoDroppedFrames++;
            this._maybeLogNativeRendererBackpressure({
              mainToRendererMs,
              captureToRendererMs,
              width: meta?.width,
              height: meta?.height,
              reason: this._nativeVideoDeferredFrame ? 'latest-overwritten-while-paced' : 'latest-overwritten-before-pump',
            });
            if (this._nativeVideoDeferredFrame) {
              this._nativeVideoPacingDeferredDrops++;
            }
          }
          this._nativeVideoLatestFrame = incomingFrame;

          if (!(this._nativeVideoDeferredFrame && this._nativeVideoDelayedPumpTimer)) {
            schedulePump();
          }
        });

        const stream = new MediaStream([generator]);
        this._nativeVideoStream = stream;

        if (window.electron?.sessionLog) {
          window.electron.sessionLog('native-video-started', {
            width, height, targetFps, maxWidth, maxHeight,
            method: 'MediaStreamTrackGenerator',
            bridgeMode,
          });
        }

        logger.info('[NATIVE-VIDEO] Using MediaStreamTrackGenerator pipeline');
        return stream;
      } catch (e) {
        logger.warn('[NATIVE-VIDEO] MediaStreamTrackGenerator failed, trying canvas fallback: ' + e.message);
        this._nativeVideoGenerator = null;
        this._nativeVideoWriter = null;
      }
    }

    // ── Path B: Canvas + captureStream (universal fallback) ──
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.style.display = 'none';
    document.body.appendChild(canvas);
    this._nativeVideoCanvas = canvas;

    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    this._nativeVideoCtx = ctx;
    this._nativeVideoActive = true;
    this._nativeVideoFrameCount = 0;
    this._nativeVideoDroppedFrames = 0;
    this._resetNativeFrameTelemetry();

    window.electron.onGameVideoFrame((buffer, meta) => {
      if (!this._nativeVideoActive || !this._nativeVideoCtx) return;
      try {
        const receivedAtEpochMs = Date.now();
        this._recordNativeFrameTelemetry(meta);
        this._recordNativePipelineMetric('captureToMain', meta?.captureToMainMs);
        const mainToRendererMs = meta?.mainForwardedAtEpochMs != null
          ? Math.max(0, receivedAtEpochMs - meta.mainForwardedAtEpochMs)
          : null;
        const captureToRendererMs = meta?.epochTimestampUs
          ? Math.max(0, receivedAtEpochMs - (meta.epochTimestampUs / 1000))
          : null;
        this._recordNativePipelineMetric('mainToRenderer', mainToRendererMs);
        this._recordNativePipelineMetric('captureToRenderer', captureToRendererMs);
        // BGRA → RGBA byte swap (DXGI delivers BGRA, ImageData expects RGBA)
        const paintStartedAtMs = Date.now();
        const u8 = new Uint8Array(buffer);
        const u32 = new Uint32Array(u8.buffer);
        for (let i = 0; i < u32.length; i++) {
          const v = u32[i];
          u32[i] = (v & 0xFF00FF00) | ((v & 0x000000FF) << 16) | ((v & 0x00FF0000) >>> 16);
        }
        const imageData = new ImageData(
          new Uint8ClampedArray(u8.buffer),
          meta.width,
          meta.height
        );
        this._nativeVideoCtx.putImageData(imageData, 0, 0);
        const submitMs = meta?.epochTimestampUs
          ? Math.max(0, Date.now() - (meta.epochTimestampUs / 1000))
          : null;
        const writeDurationMs = Math.max(0, Date.now() - paintStartedAtMs);
        this._recordNativePipelineMetric('submit', submitMs);
        this._recordNativePipelineMetric('writeDuration', writeDurationMs);
        this._maybeLogNativePipelineLag({
          captureToMainMs: meta?.captureToMainMs ?? null,
          mainToRendererMs,
          captureToRendererMs,
          rendererQueueMs: 0,
          submitMs,
          writeDurationMs,
          width: meta?.width,
          height: meta?.height,
        });
        this._nativeVideoFrameCount++;
        if (this._nativeVideoFrameCount === 1) {
          logger.info('[NATIVE-VIDEO] First canvas frame painted: ' +
            meta.width + 'x' + meta.height);
        }
      } catch (e) {
        if (this._nativeVideoFrameCount < 3) {
          logger.warn('[NATIVE-VIDEO] Canvas paint error: ' + e.message);
        }
      }
    });

    const stream = canvas.captureStream(targetFps);
    this._nativeVideoStream = stream;

    if (window.electron?.sessionLog) {
      window.electron.sessionLog('native-video-started', {
        width, height, targetFps, maxWidth, maxHeight, method: 'canvas-captureStream',
      });
    }

    logger.info('[NATIVE-VIDEO] Using canvas captureStream pipeline (' + width + 'x' + height + '@' + targetFps + ')');
    return stream;
  }

  /**
   * Tears down native video capture: stops the addon, removes listeners,
   * cleans up canvas/generator.
   */
  async _stopNativeVideoCapture() {
    this._nativeVideoActive = false;
    this._nativeVideoLatestFrame = null;
    this._nativeVideoDeferredFrame = null;
    this._nativeVideoWriteInFlight = false;
    if (this._nativeVideoDelayedPumpTimer) {
      clearTimeout(this._nativeVideoDelayedPumpTimer);
      this._nativeVideoDelayedPumpTimer = null;
    }

    if (window.electron?.removeGameVideoFrameListener) {
      window.electron.removeGameVideoFrameListener();
    }

    if (window.electron?.stopNativeVideoCapture) {
      try {
        await window.electron.stopNativeVideoCapture();
      } catch (e) {
        logger.warn('[NATIVE-VIDEO] Stop error: ' + e.message);
      }
    }

    if (this._nativeVideoWriter) {
      try { this._nativeVideoWriter.close(); } catch (_) {}
      this._nativeVideoWriter = null;
    }
    if (this._nativePumpPort1) {
      this._nativePumpPort1.close();
      this._nativePumpPort1 = null;
      this._nativePumpPort2 = null;
    }
    this._nativeVideoGenerator = null;
    this._nativeVideoConfig = null;

    if (this._nativeVideoStream) {
      this._nativeVideoStream.getTracks().forEach(t => t.stop());
      this._nativeVideoStream = null;
    }

    if (this._nativeVideoCanvas) {
      this._nativeVideoCanvas.remove();
      this._nativeVideoCanvas = null;
      this._nativeVideoCtx = null;
    }

    const frames = this._nativeVideoFrameCount;
    this._nativeVideoFrameCount = 0;

    if (frames > 0) {
      logger.info('[NATIVE-VIDEO] Stopped after ' + frames + ' frames');
      if (window.electron?.sessionLog) {
        window.electron.sessionLog('native-video-stopped', {
          framesDelivered: frames,
          framesDropped: this._nativeVideoDroppedFrames || 0,
          pacingDeferredDrops: this._nativeVideoPacingDeferredDrops || 0,
          frameAge: this._getNativeFrameTelemetrySnapshot(),
        });
      }
    }
    this._nativeVideoDroppedFrames = 0;
    this._nativeVideoPacingDeferredDrops = 0;
    this._resetNativeFrameTelemetry();
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
        this._lastSelectedSourceName = sourceName;
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
        const pipelineStats = this._extractVideoPipelineStats(stats);

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

        const nativeFrameAge = this._getNativeFrameTelemetrySnapshot();
        const nativePipeline = this._getNativePipelineTelemetrySnapshot();
        let captureSnapshot = this._lastPipelineSnapshot?.capture || null;
        if (pipelineStats.mediaSource || pipelineStats.track || pipelineStats.outbound) {
          captureSnapshot = {
            sourceFps: pipelineStats.mediaSource?.framesPerSecond ?? pipelineStats.track?.framesPerSecond ?? null,
            sourceWidth: pipelineStats.mediaSource?.frameWidth ?? pipelineStats.track?.frameWidth ?? null,
            sourceHeight: pipelineStats.mediaSource?.frameHeight ?? pipelineStats.track?.frameHeight ?? null,
            outboundWidth: pipelineStats.outbound?.frameWidth ?? null,
            outboundHeight: pipelineStats.outbound?.frameHeight ?? null,
            qualityLimitationReason: pipelineStats.outbound?.qualityLimitationReason ?? null,
            qualityLimitationResolutionChanges: pipelineStats.outbound?.qualityLimitationResolutionChanges ?? null,
            encoderImplementation: pipelineStats.outbound?.encoderImplementation ?? null,
            powerEfficientEncoder: pipelineStats.outbound?.powerEfficientEncoder ?? null,
            codec: pipelineStats.codec?.mimeType ?? null,
            availableOutgoingBitrateMbps: pipelineStats.candidatePair?.availableOutgoingBitrate != null
              ? +(pipelineStats.candidatePair.availableOutgoingBitrate / 1000000).toFixed(2)
              : null,
            degradationPreference: this._lastVideoDegradationPreference || this._getDesiredVideoDegradationPreference(),
            encoderResolutionDrift: false,
          };
          const expectedOutbound = this._getExpectedOutboundSize(captureSnapshot);
          captureSnapshot.expectedOutboundWidth = expectedOutbound.expectedOutboundWidth;
          captureSnapshot.expectedOutboundHeight = expectedOutbound.expectedOutboundHeight;
          this._lastPipelineSnapshot = {
            capture: captureSnapshot,
          };
          this._maybeTrackEncoderResolutionDrift(this._lastPipelineSnapshot);
          this._logOutboundResolutionChange(captureSnapshot);
        }

        this.updateStatsDisplay(bitrateMbps, fps);
        if (bitrateMbps !== null || fps !== null) {
          const bwe = this.abr._serverBwe;
          const bweAge = Date.now() - this.abr._serverBweTime;
          this.abr.updateProducerStats({
            bitrateMbps,
            fps,
            sourceFps: captureSnapshot?.sourceFps ?? null,
            availableOutgoingBitrateMbps: captureSnapshot?.availableOutgoingBitrateMbps ?? null,
            qualityLimitationReason: captureSnapshot?.qualityLimitationReason ?? null,
            degradationPreference: captureSnapshot?.degradationPreference ?? null,
            nativeDroppedFrames: this._nativeVideoDroppedFrames || 0,
            severeLagEvents: nativePipeline?.severeLagEvents ?? 0,
            submitMs: nativePipeline?.submitMs?.lastMs ?? null,
            captureToRendererMs: nativePipeline?.captureToRendererMs?.lastMs ?? null,
            frameAgeMs: nativeFrameAge?.lastFrameAgeMs ?? null,
            deliveryBitrateMbps: bwe && bweAge < 6000 ? bwe.aggregate.minDeliveryMbps ?? null : null,
          });
        }

        // Periodic stats snapshot (every 5s)
        if (bitrateMbps !== null && window.electron?.sessionLog) {
          this._statsTickCount = (this._statsTickCount || 0) + 1;
          if (this._statsTickCount % 5 === 0) {
            const snapshot = {
              bitrateMbps: +bitrateMbps.toFixed(2), fps,
              abrTier: this.abr.tierIndex,
              abrLabel: this.abr.tiers?.[this.abr.tierIndex]?.label,
              viewers: this.viewers.size,
            };
            if (this._lastPipelineSnapshot?.capture) {
              snapshot.capture = {
                ...this._lastPipelineSnapshot.capture,
                nativeDroppedFrames: this._nativeVideoDroppedFrames || 0,
                nativePacingDeferredDrops: this._nativeVideoPacingDeferredDrops || 0,
                nativeCapture: this._nativeVideoActive || false,
                nativeFrameCount: this._nativeVideoFrameCount || 0,
              };
              if (nativeFrameAge) {
                snapshot.capture.nativeFrameAge = nativeFrameAge;
              }
              if (nativePipeline) {
                snapshot.capture.nativePipeline = nativePipeline;
              }
            }
            // Include server BWE metrics if available
            const bwe = this.abr._serverBwe;
            const bweAge = Date.now() - this.abr._serverBweTime;
            if (bwe && bweAge < 6000) {
              snapshot.bwe = {
                rttMs: bwe.aggregate.worstRttMs || null,
                nackRate: bwe.aggregate.worstNackRate || 0,
                score: bwe.aggregate.minScore,
                availableMbps: bwe.aggregate.minAvailableMbps,
                deliveryMbps: bwe.aggregate.minDeliveryMbps,
                spreadMbps: bwe.aggregate.viewerSpreadMbps,
                bottleneckViewerId: bwe.aggregate.bottleneckViewerId,
              };
            }
            this._maybeTrackEncoderResolutionDrift(snapshot);
            snapshot.encoder = {
              stallSeconds: this.abr._producerStats.stallSeconds,
              stressSeconds: this.abr._producerStats.stressSeconds,
              stressReason: this.abr._producerStats.stressReason || null,
            };
            const captureSummary = snapshot.capture
              ? ' capture=' + (snapshot.capture.sourceWidth || '--') + 'x' + (snapshot.capture.sourceHeight || '--') +
                '@' + (snapshot.capture.sourceFps || '--') +
                ' out=' + (snapshot.capture.outboundWidth || '--') + 'x' + (snapshot.capture.outboundHeight || '--') +
                ' expected=' + (snapshot.capture.expectedOutboundWidth || '--') + 'x' + (snapshot.capture.expectedOutboundHeight || '--') +
                ' qlim=' + (snapshot.capture.qualityLimitationReason || 'none') +
                ' pref=' + (snapshot.capture.degradationPreference || '--') +
                (snapshot.capture.encoderResolutionDrift ? ' drift=yes' : '')
              : '';
            logger.info('[DIAG:PIPELINE] enc=' + fps + 'fps ' + bitrateMbps.toFixed(2) + 'Mbps' + captureSummary);
            window.electron.sessionLog('stats-snapshot', snapshot);
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
            this._sourceStallStartedAt = this._sourceStallStartedAt || Date.now();
            if (this._healthStalls === 2) {
              this.abr._logSession('source-stall-detected', {
                stallSeconds: this._healthStalls,
                tier: this.abr.currentTier.label,
              });
            }
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
      this._logCaptureTrackDiagnostics(newTrack, {
        sourceId,
        sourceName: this._lastSelectedSourceName || null,
        captureMethod: sourceId.startsWith('screen:') ? 'screen-dxgi' : 'window-wgc',
        requested: this.getActiveQualityProfile(),
      });

      logger.info('[HEALTH] Capture source re-acquired successfully');
      if (this._sourceStallStartedAt) {
        this.abr._logSession('source-stall-recovered', {
          recoveryMs: Date.now() - this._sourceStallStartedAt,
          sourceId,
        });
        this._sourceStallStartedAt = 0;
      }
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
      this._logCaptureTrackDiagnostics(newTrack, {
        sourceId: screenId,
        sourceName: this._lastSelectedSourceName || null,
        captureMethod: 'screen-dxgi',
        requested: this.getActiveQualityProfile(),
      });

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
    this._stopNativeVideoCapture();
    this._isGameCapture = false;
    this._nativeGamePid = null;
    this.abr.tierIndex = this.abr.startupTierIndex;
    this._lastPipelineSnapshot = null;
    this._lastOutboundResolutionKey = null;
    this._lastVideoDegradationPreference = null;
    this._resetEncoderResolutionDriftTelemetry();
    this._viewerFrameSizeByViewer.clear();
    this._currentCaptureMethod = null;
    this._resetNativeFrameTelemetry();

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
    window.app = new LuminaApp();
    logger.info('App ready (SFU mode)');
  } catch (err) {
    console.error('[INIT] Failed:', err);
    logger.error('Init failed: ' + err.message);
  }
});

if (document.readyState !== 'loading' && !window.app) {
  setTimeout(() => {
    if (!window.app) {
      window.app = new LuminaApp();
      logger.info('App created (late init)');
    }
  }, 100);
}

window.logger = logger;
