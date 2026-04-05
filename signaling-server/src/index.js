import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import mediasoup from 'mediasoup';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

// ============================================
// SESSION LOGGING
// All session data goes to logs/sessions/<sessionId>/
// Each session gets: session.meta.json, signaling.jsonl, summary on close
// ============================================
const sessionStartedAt = new Date();
const sessionId = sessionStartedAt.toISOString().replace(/[:.]/g, '-');
let gitCommit = 'unknown';
try {
  gitCommit = execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
} catch {}

const sessionDir = path.join(repoRoot, 'logs', 'sessions', `${sessionId}-${gitCommit}`);
fs.mkdirSync(sessionDir, { recursive: true });

const sessionLogPath = path.join(sessionDir, 'signaling.jsonl');
const sessionMetaPath = path.join(sessionDir, 'session.meta.json');

// Session-level aggregated stats for comparison
const sessionStats = {
  totalViewerJoins: 0,
  totalViewerLeaves: 0,
  totalQualityReports: 0,
  totalLuminaRegistrations: 0,
  peakViewerCount: 0,
  qualityReportSamples: [],   // last N for summary
  bweSamples: [],
  abrEvents: [],               // ABR tier changes
  bottleneckChanges: 0,
  transportIssues: [],          // DTLS failures, transport errors
  startedAt: sessionStartedAt.toISOString(),
  endedAt: null,
};

fs.writeFileSync(sessionMetaPath, JSON.stringify({
  sessionId,
  gitCommit,
  startedAt: sessionStartedAt.toISOString(),
  server: 'signaling-server',
  announcedIp: process.env.ANNOUNCED_IP || null,
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  sessionDir,
}, null, 2));

function appendSessionLog(type, payload) {
  fs.appendFileSync(sessionLogPath, JSON.stringify({
    ts: new Date().toISOString(),
    type,
    payload,
  }) + '\n');
}

function writeSessionSummary() {
  sessionStats.endedAt = new Date().toISOString();
  const durationMs = Date.now() - sessionStartedAt.getTime();
  sessionStats.durationSec = Math.round(durationMs / 1000);

  // Compute quality report aggregates
  if (sessionStats.qualityReportSamples.length > 0) {
    const samples = sessionStats.qualityReportSamples;
    const avgFps = samples.reduce((a, b) => a + (b.fps || 0), 0) / samples.length;
    const avgBitrate = samples.reduce((a, b) => a + (b.bitrateMbps || 0), 0) / samples.length;
    const avgJitter = samples.filter(s => s.jitterMs != null).reduce((a, b) => a + b.jitterMs, 0) / Math.max(1, samples.filter(s => s.jitterMs != null).length);
    const avgLoss = samples.filter(s => s.lossRate != null).reduce((a, b) => a + b.lossRate, 0) / Math.max(1, samples.filter(s => s.lossRate != null).length);
    const minFps = Math.min(...samples.map(s => s.fps || 0));
    const maxFps = Math.max(...samples.map(s => s.fps || 0));
    const p95Jitter = samples.filter(s => s.jitterMs != null).map(s => s.jitterMs).sort((a, b) => a - b)[Math.floor(samples.filter(s => s.jitterMs != null).length * 0.95)] || 0;

    sessionStats.qualityAggregate = {
      sampleCount: samples.length,
      avgFps: Number(avgFps.toFixed(1)),
      minFps,
      maxFps,
      avgBitrateMbps: Number(avgBitrate.toFixed(2)),
      avgJitterMs: Number(avgJitter.toFixed(1)),
      p95JitterMs: Number(p95Jitter.toFixed(1)),
      avgLossRate: Number(avgLoss.toFixed(4)),
    };
  }

  if (sessionStats.bweSamples.length > 0) {
    const samples = sessionStats.bweSamples;
    const avgWorstRttMs = samples.reduce((a, b) => a + (b.worstRttMs || 0), 0) / samples.length;
    const avgWorstNackRate = samples.reduce((a, b) => a + (b.worstNackRate || 0), 0) / samples.length;
    const avgMedianDeliveryMbps = samples.reduce((a, b) => a + (b.medianDeliveryMbps || 0), 0) / samples.length;
    const avgViewerSpreadMbps = samples.reduce((a, b) => a + (b.viewerSpreadMbps || 0), 0) / samples.length;
    sessionStats.bweAggregate = {
      sampleCount: samples.length,
      avgWorstRttMs: Number(avgWorstRttMs.toFixed(1)),
      avgWorstNackRate: Number(avgWorstNackRate.toFixed(4)),
      avgMedianDeliveryMbps: Number(avgMedianDeliveryMbps.toFixed(2)),
      avgViewerSpreadMbps: Number(avgViewerSpreadMbps.toFixed(2)),
      bottleneckChanges: sessionStats.bottleneckChanges,
    };
  }

  // Don't write the raw samples array to the summary (too large)
  const summary = { ...sessionStats };
  delete summary.qualityReportSamples;
  delete summary.bweSamples;

  const summaryPath = path.join(sessionDir, 'session.summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log('[SESSION] Summary written to ' + summaryPath);
}

console.log('[SESSION] Logging to ' + sessionDir);

// ============================================
// CONFIGURATION
// ============================================

const config = {
  PORT: process.env.PORT || 4000,
  HOST: process.env.HOST || '0.0.0.0',
  ANNOUNCED_IP: process.env.ANNOUNCED_IP || null,
  HEARTBEAT_INTERVAL_MS: 15000,
  CLIENT_TIMEOUT_MS: 30000,
  RTC_MIN_PORT: 40000,
  RTC_MAX_PORT: 49999,
};

// Server-side BWE polling interval (ms)
const BWE_POLL_INTERVAL_MS = 1000;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function extractTransportMetrics(stats) {
  let rttMs = null;
  let availableBitrateMbps = null;

  stats.forEach((report) => {
    if (report.type === 'webrtc-transport' || report.type === 'transport') {
      const rawRtt = report.iceSelectedTuple?.rtt ?? report.roundTripTime ?? null;
      if (rawRtt != null) {
        const candidateRttMs = rawRtt > 100 ? rawRtt : rawRtt * 1000;
        if (Number.isFinite(candidateRttMs)) {
          rttMs = Number(candidateRttMs.toFixed(1));
        }
      }

      const rawBitrate = report.availableOutgoingBitrate ?? report.currentAvailableOutgoingBitrate ?? null;
      if (rawBitrate != null && Number.isFinite(rawBitrate)) {
        availableBitrateMbps = Number((rawBitrate / 1_000_000).toFixed(2));
      }
    }

    if (report.type === 'candidate-pair' && (report.nominated || report.selected) && report.state === 'succeeded') {
      if (report.currentRoundTripTime != null) {
        const candidateRttMs = report.currentRoundTripTime > 100 ? report.currentRoundTripTime : report.currentRoundTripTime * 1000;
        if (Number.isFinite(candidateRttMs)) {
          rttMs = Number(candidateRttMs.toFixed(1));
        }
      }
      const rawBitrate = report.availableOutgoingBitrate ?? report.currentAvailableOutgoingBitrate ?? null;
      if (rawBitrate != null && Number.isFinite(rawBitrate)) {
        availableBitrateMbps = Number((rawBitrate / 1_000_000).toFixed(2));
      }
    }
  });

  if (rttMs != null && rttMs > 10000) rttMs = null;

  return { rttMs, availableBitrateMbps };
}

const MEDIA_CODECS = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {},
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '640032',
      'level-asymmetry-allowed': 1,
    },
  },
];

// ============================================
// HELPERS
// ============================================

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function send(ws, eventName, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify([eventName, data]));
  }
}

function respond(clientId, reqId, data = {}) {
  const client = clients.get(clientId);
  if (client) {
    send(client.ws, 'response', { _reqId: reqId, ...data });
  }
}

// ============================================
// STATE
// ============================================

let worker = null;
const rooms = new Map();
const clients = new Map();
const bweIntervals = new Map();  // roomId → interval handle

// ============================================
// MEDIASOUP WORKER
// ============================================

async function createWorker() {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    rtcMinPort: config.RTC_MIN_PORT,
    rtcMaxPort: config.RTC_MAX_PORT,
  });

  worker.on('died', (error) => {
    console.error('[mediasoup] Worker died:', error);
    setTimeout(async () => {
      try { await createWorker(); }
      catch (e) { console.error('[mediasoup] Failed to recreate worker:', e); }
    }, 2000);
  });

  console.log('[mediasoup] Worker created (pid: ' + worker.pid + ')');
  appendSessionLog('worker-created', { pid: worker.pid });
  return worker;
}

async function createWebRtcTransport(router) {
  const announcedIp = config.ANNOUNCED_IP || getLocalIp();

  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
  });

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
  };
}

// ============================================
// HTTP ROUTES
// ============================================

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    workerPid: worker?.pid || null,
    rooms: rooms.size,
    clients: clients.size,
  });
});

app.get('/lumina', (req, res) => {
  const list = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    name: room.streamer.name || id,
    viewerCount: room.viewers.size,
  }));
  res.json(list);
});

// ============================================
// HEARTBEAT
// ============================================

const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const [clientId, client] of clients) {
    if (now - client.lastPong > config.CLIENT_TIMEOUT_MS) {
      console.log('[WS] Client ' + clientId + ' timed out');
      client.ws.terminate();
      continue;
    }
    if (client.ws.readyState === 1) {
      client.ws.ping();
    }
  }
}, config.HEARTBEAT_INTERVAL_MS);

// ============================================
// WEBSOCKET HANDLER
// ============================================

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substr(2, 9);
  console.log('[WS] Client connected: ' + clientId);
  clients.set(clientId, { ws, lastPong: Date.now(), role: null, roomId: null });

  ws.on('pong', () => {
    const client = clients.get(clientId);
    if (client) client.lastPong = Date.now();
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (!Array.isArray(msg) || msg.length < 2) return;
      handleMessage(clientId, msg, ws);
    } catch (err) {
      console.error('[WS] Parse error from ' + clientId + ': ' + err.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected: ' + clientId);
    handleDisconnect(clientId);
    clients.delete(clientId);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error from ' + clientId + ': ' + err.message);
  });
});

// ============================================
// MESSAGE ROUTER
// ============================================

function handleMessage(clientId, msg, ws) {
  const [eventName, eventData] = msg;

  switch (eventName) {
    case 'register-streamer':
      return handleLuminaRegister(clientId, eventData, ws);
    case 'create-producer-transport':
      return handleCreateProducerTransport(clientId, eventData);
    case 'connect-producer-transport':
      return handleConnectProducerTransport(clientId, eventData);
    case 'produce':
      return handleProduce(clientId, eventData);
    case 'join-streamer':
      return handleViewerJoin(clientId, eventData, ws);
    case 'create-consumer-transport':
      return handleCreateConsumerTransport(clientId, eventData);
    case 'connect-consumer-transport':
      return handleConnectConsumerTransport(clientId, eventData);
    case 'consume':
      return handleConsume(clientId, eventData);
    case 'consumer-resume':
      return handleConsumerResume(clientId, eventData);
    case 'viewer-quality-report':
      return handleViewerQualityReport(clientId, eventData);
    default:
      console.log('[WS] Unknown event from ' + clientId + ': ' + eventName);
  }
}

// ============================================
// LUMINA HANDLERS
// ============================================

async function handleLuminaRegister(clientId, data, ws) {
  const name = String(data?.name || clientId).substring(0, 64);
  console.log('[SFU] Registering Lumina host: ' + name);

  try {
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });

    rooms.set(clientId, {
      router,
      streamer: {
        id: clientId,
        ws,
        name,
        producerTransport: null,
        producers: new Map(),
      },
      viewers: new Map(),
    });

    const client = clients.get(clientId);
    client.role = 'lumina';
    client.roomId = clientId;

    sessionStats.totalLuminaRegistrations++;
    appendSessionLog('lumina-registered', { clientId, name });

    send(ws, 'registered', {
      routerRtpCapabilities: router.rtpCapabilities,
    });

    for (const [cid, c] of clients) {
      if (cid !== clientId) {
        send(c.ws, 'streamer-joined', { streamerId: clientId, name });
      }
    }

    console.log('[SFU] Router created for streamer ' + name);
  } catch (error) {
    console.error('[SFU] Failed to create router: ' + error.message);
    send(ws, 'error', { message: 'Failed to register: ' + error.message });
  }
}

async function handleCreateProducerTransport(clientId, data) {
  const room = rooms.get(clientId);
  if (!room) return respond(clientId, data._reqId, { error: 'Not registered as streamer' });

  try {
    const { transport, params } = await createWebRtcTransport(room.router);
    room.streamer.producerTransport = transport;

    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed') {
        console.log('[SFU] Producer transport DTLS closed for ' + room.streamer.name);
      }
    });

    console.log('[SFU] Producer transport created: ' + transport.id);
    respond(clientId, data._reqId, params);
  } catch (error) {
    console.error('[SFU] Failed to create producer transport: ' + error.message);
    respond(clientId, data._reqId, { error: error.message });
  }
}

async function handleConnectProducerTransport(clientId, data) {
  const room = rooms.get(clientId);
  if (!room?.streamer?.producerTransport) {
    return respond(clientId, data._reqId, { error: 'No producer transport' });
  }

  try {
    await room.streamer.producerTransport.connect({ dtlsParameters: data.dtlsParameters });
    console.log('[SFU] Producer transport connected for ' + room.streamer.name);
    respond(clientId, data._reqId, {});
  } catch (error) {
    console.error('[SFU] Producer transport connect failed: ' + error.message);
    respond(clientId, data._reqId, { error: error.message });
  }
}

async function handleProduce(clientId, data) {
  const room = rooms.get(clientId);
  if (!room?.streamer?.producerTransport) {
    return respond(clientId, data._reqId, { error: 'No producer transport' });
  }

  try {
    // Close old producer of same kind first (if any) so consumers get
    // 'producerclose' → viewer removes the dead track before the new one arrives.
    const oldProducer = room.streamer.producers.get(data.kind);
    if (oldProducer) {
      console.log('[SFU] Closing previous ' + data.kind + ' producer ' + oldProducer.id);
      oldProducer.close();
      room.streamer.producers.delete(data.kind);
    }

    const producer = await room.streamer.producerTransport.produce({
      kind: data.kind,
      rtpParameters: data.rtpParameters,
    });

    room.streamer.producers.set(data.kind, producer);

    producer.on('transportclose', () => {
      console.log('[SFU] Producer transportclose: ' + data.kind);
      room.streamer.producers.delete(data.kind);
    });

    console.log('[SFU] Producer created: ' + data.kind + ' (id: ' + producer.id + ')');
    respond(clientId, data._reqId, { producerId: producer.id });

    // Notify existing viewers about new producer
    for (const [viewerId, viewer] of room.viewers) {
      send(viewer.ws, 'new-producer', { kind: data.kind, producerId: producer.id });
    }
  } catch (error) {
    console.error('[SFU] Produce failed: ' + error.message);
    respond(clientId, data._reqId, { error: error.message });
  }
}

// ============================================
// VIEWER HANDLERS
// ============================================

async function handleViewerJoin(clientId, data, ws) {
  const streamerId = data?.streamerId;
  const viewerName = String(data?.viewerName || clientId).substring(0, 64);
  const room = rooms.get(streamerId);

  if (!room) {
    send(ws, 'error', { message: 'Host not found' });
    return;
  }

  console.log('[SFU] Viewer "' + viewerName + '" joining streamer ' + room.streamer.name);

  const client = clients.get(clientId);

  // Clean up any previous viewer state before rejoining or switching rooms.
  if (client.role === 'viewer' && client.roomId) {
    const previousRoom = rooms.get(client.roomId);
    const previousViewer = previousRoom?.viewers.get(clientId);
    if (previousViewer) {
      for (const [, consumer] of previousViewer.consumers) {
        try { consumer.close(); } catch {}
      }
      if (previousViewer.consumerTransport) {
        try { previousViewer.consumerTransport.close(); } catch {}
      }
      previousRoom.viewers.delete(clientId);
      send(previousRoom.streamer.ws, 'viewer-left', { viewerId: clientId });
    }
  }

  client.role = 'viewer';
  client.roomId = streamerId;
  client._zeroFpsCount = 0;

  room.viewers.set(clientId, {
    id: clientId,
    ws,
    name: viewerName,
    consumerTransport: null,
    consumers: new Map(),
    latestQualityReport: null,
  });

  send(room.streamer.ws, 'viewer-joined', { viewerId: clientId, viewerName });

  sessionStats.totalViewerJoins++;
  const currentViewerCount = room.viewers.size;
  if (currentViewerCount > sessionStats.peakViewerCount) {
    sessionStats.peakViewerCount = currentViewerCount;
  }
  appendSessionLog('viewer-joined', { clientId, viewerName, streamerId, currentViewerCount });

  send(ws, 'joined', {
    routerRtpCapabilities: room.router.rtpCapabilities,
    streamerId,
  });
}

async function handleCreateConsumerTransport(clientId, data) {
  const client = clients.get(clientId);
  const room = rooms.get(client?.roomId);
  const viewer = room?.viewers.get(clientId);

  if (!room || !viewer) {
    return respond(clientId, data._reqId, { error: 'Not in a room' });
  }

  try {
    const { transport, params } = await createWebRtcTransport(room.router);
    viewer.consumerTransport = transport;

    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed') {
        console.log('[SFU] Consumer transport DTLS closed for viewer ' + viewer.name);
      }
    });

    console.log('[SFU] Consumer transport created for viewer ' + viewer.name + ': ' + transport.id);
    respond(clientId, data._reqId, params);
  } catch (error) {
    console.error('[SFU] Failed to create consumer transport: ' + error.message);
    respond(clientId, data._reqId, { error: error.message });
  }
}

async function handleConnectConsumerTransport(clientId, data) {
  const client = clients.get(clientId);
  const room = rooms.get(client?.roomId);
  const viewer = room?.viewers.get(clientId);

  if (!viewer?.consumerTransport) {
    return respond(clientId, data._reqId, { error: 'No consumer transport' });
  }

  try {
    await viewer.consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
    console.log('[SFU] Consumer transport connected for ' + viewer.name);
    respond(clientId, data._reqId, {});
  } catch (error) {
    console.error('[SFU] Consumer transport connect failed: ' + error.message);
    respond(clientId, data._reqId, { error: error.message });
  }
}

async function handleConsume(clientId, data) {
  const client = clients.get(clientId);
  const room = rooms.get(client?.roomId);
  const viewer = room?.viewers.get(clientId);

  if (!viewer?.consumerTransport || !room) {
    return respond(clientId, data._reqId, { error: 'Not ready to consume' });
  }

  try {
    const consumerDataList = [];

    for (const [kind, producer] of room.streamer.producers) {
      let existingConsumer = null;
      for (const [, consumer] of viewer.consumers) {
        if (consumer.producerId === producer.id) {
          existingConsumer = consumer;
          break;
        }
      }
      if (existingConsumer) {
        continue;
      }

      if (!room.router.canConsume({ producerId: producer.id, rtpCapabilities: data.rtpCapabilities })) {
        console.log('[SFU] Cannot consume ' + kind + ' for viewer ' + viewer.name);
        continue;
      }

      const consumer = await viewer.consumerTransport.consume({
        producerId: producer.id,
        rtpCapabilities: data.rtpCapabilities,
        paused: true,
      });

      viewer.consumers.set(consumer.id, consumer);

      consumer.on('transportclose', () => {
        viewer.consumers.delete(consumer.id);
      });

      consumer.on('producerclose', () => {
        send(viewer.ws, 'consumer-closed', { consumerId: consumer.id });
        viewer.consumers.delete(consumer.id);
      });

      // Track mediasoup quality score (0-10) per consumer
      consumer.on('score', (score) => {
        if (!viewer._bweScores) viewer._bweScores = {};
        viewer._bweScores[consumer.kind] = score;
      });

      consumerDataList.push({
        id: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });

      console.log('[SFU] Consumer created: ' + kind + ' for viewer ' + viewer.name);
    }

    respond(clientId, data._reqId, { consumers: consumerDataList });

    // Start BWE polling for this room if not already running
    const roomId = client.roomId;
    if (roomId && !bweIntervals.has(roomId)) {
      startBwePolling(roomId);
    }
  } catch (error) {
    console.error('[SFU] Consume failed: ' + error.message);
    respond(clientId, data._reqId, { error: error.message });
  }
}

async function handleConsumerResume(clientId, data) {
  const client = clients.get(clientId);
  const room = rooms.get(client?.roomId);
  const viewer = room?.viewers.get(clientId);
  if (!viewer) return;

  const consumer = viewer.consumers.get(data.consumerId);
  if (consumer) {
    await consumer.resume();
    console.log('[SFU] Consumer resumed: ' + consumer.kind + ' for viewer ' + viewer.name);
  }
}

// ============================================
// SERVER-SIDE BANDWIDTH ESTIMATION (BWE)
// Polls consumer.getStats() every 2s to extract RTCP-derived
// metrics: delivery bitrate, NACK rate, PLI/FIR counts, RTT, score.
// Sends aggregated 'server-bwe' event to the streamer.
// ============================================

function startBwePolling(roomId) {
  if (bweIntervals.has(roomId)) return;

  // Per-viewer state for delta calculations
  const viewerPrev = new Map();
  let lastBottleneckViewerId = null;
  let bottleneckStreak = 0;

  const interval = setInterval(async () => {
    const room = rooms.get(roomId);
    if (!room || room.viewers.size === 0) return;

    const viewerBwe = {};
    let hasData = false;

    for (const [viewerId, viewer] of room.viewers) {
      // Find the video consumer for this viewer
      let videoConsumer = null;
      for (const [, consumer] of viewer.consumers) {
        if (consumer.kind === 'video' && !consumer.closed) {
          videoConsumer = consumer;
          break;
        }
      }
      if (!videoConsumer) continue;

      try {
        const stats = await videoConsumer.getStats();
        let outbound = null;
        let remoteInbound = null;

        stats.forEach(report => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            outbound = report;
          }
          if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
            remoteInbound = report;
          }
        });

        if (!outbound) continue;

        const prev = viewerPrev.get(viewerId) || {};
        const now = outbound.timestamp || Date.now();
        const elapsed = prev.timestamp ? (now - prev.timestamp) / 1000 : 0;

        let deliveryMbps = 0;
        let nackRate = 0;

        if (elapsed > 0) {
          const bytesDelta = (outbound.bytesSent || 0) - (prev.bytesSent || 0);
          deliveryMbps = (bytesDelta * 8) / elapsed / 1_000_000;

          const nackDelta = (outbound.nackCount || remoteInbound?.nackCount || 0) - (prev.nackCount || 0);
          const packetsDelta = (outbound.packetsSent || 0) - (prev.packetsSent || 0);
          nackRate = packetsDelta > 0 ? nackDelta / packetsDelta : 0;
        }

        const latestQualityReport = viewer.latestQualityReport || null;
        const reportIsFresh = latestQualityReport && (Date.now() - latestQualityReport.at) <= (BWE_POLL_INTERVAL_MS * 3);
        if ((deliveryMbps <= 0 || !Number.isFinite(deliveryMbps)) && reportIsFresh && latestQualityReport.bitrateMbps > 0) {
          deliveryMbps = latestQualityReport.bitrateMbps;
        }

        // Save for next delta
        viewerPrev.set(viewerId, {
          timestamp: now,
          bytesSent: outbound.bytesSent || 0,
          nackCount: outbound.nackCount || remoteInbound?.nackCount || 0,
          packetsSent: outbound.packetsSent || 0,
          pliCount: outbound.pliCount || 0,
          firCount: outbound.firCount || 0,
        });

        // mediasoup consumer score (set by 'score' event listener)
        const scoreData = viewer._bweScores?.video;
        const score = scoreData?.score ?? null;
        const producerScore = scoreData?.producerScore ?? null;

        // Transport-level stats: RTT (from DTLS/ICE) and available bitrate
        // NOTE: consumer outbound-rtp stats do NOT have roundTripTime in mediasoup.
        // RTT must come from the transport's own stats.
        let rttMs = remoteInbound?.roundTripTime != null
          ? Number(((remoteInbound.roundTripTime > 100 ? remoteInbound.roundTripTime : remoteInbound.roundTripTime * 1000)).toFixed(1))
          : null;
        let availableBitrateMbps = null;
        if (viewer.consumerTransport) {
          try {
            const tStats = await viewer.consumerTransport.getStats();
            const transportMetrics = extractTransportMetrics(tStats);
            rttMs = rttMs ?? transportMetrics.rttMs;
            availableBitrateMbps = transportMetrics.availableBitrateMbps;
          } catch {}
        }

        viewerBwe[viewerId] = {
          deliveryMbps: Number(deliveryMbps.toFixed(2)),
          rttMs,
          nackRate: Number(nackRate.toFixed(4)),
          pliCount: outbound.pliCount || remoteInbound?.pliCount || 0,
          firCount: outbound.firCount || remoteInbound?.firCount || 0,
          score,
          producerScore,
          availableBitrateMbps,
          viewerName: viewer.name,
          latestQualityReport,
        };
        hasData = true;

      } catch (err) {
        // Consumer may have closed between check and getStats
      }
    }

    if (!hasData) return;

    // Compute aggregate worst-case metrics
    let worstRtt = 0;
    let worstNackRate = 0;
    let minScore = 10;
    let minAvailableMbps = Infinity;
    let minDeliveryMbps = Infinity;
    let maxDeliveryMbps = 0;
    let bottleneckScore = Infinity;
    let bottleneckViewerId = null;
    let lowHeadroomViewers = 0;
    const deliverySamples = [];

    for (const vId of Object.keys(viewerBwe)) {
      const v = viewerBwe[vId];
      if (v.rttMs != null && v.rttMs > worstRtt) worstRtt = v.rttMs;
      if (v.nackRate > worstNackRate) worstNackRate = v.nackRate;
      if (v.score != null && v.score < minScore) minScore = v.score;
      if (v.availableBitrateMbps != null && v.availableBitrateMbps < minAvailableMbps) {
        minAvailableMbps = v.availableBitrateMbps;
      }
      if (v.deliveryMbps < minDeliveryMbps) minDeliveryMbps = v.deliveryMbps;
      if (v.deliveryMbps > maxDeliveryMbps) maxDeliveryMbps = v.deliveryMbps;
      deliverySamples.push(v.deliveryMbps);

      const quality = v.latestQualityReport || {};
      const healthScore =
        (quality.fps || 0) -
        ((quality.jitterMs || 0) / 20) -
        ((quality.lossRate || 0) * 140) -
        (v.nackRate * 100) -
        ((v.rttMs || 0) / 60) +
        (v.deliveryMbps * 2);

      if ((v.availableBitrateMbps != null && v.availableBitrateMbps < 8) || v.deliveryMbps < 5) {
        lowHeadroomViewers++;
      }

      if (healthScore < bottleneckScore) {
        bottleneckScore = healthScore;
        bottleneckViewerId = vId;
      }
    }

    if (bottleneckViewerId) {
      if (bottleneckViewerId === lastBottleneckViewerId) {
        bottleneckStreak++;
      } else {
        if (lastBottleneckViewerId) {
          sessionStats.bottleneckChanges++;
          appendSessionLog('bwe-bottleneck', {
            roomId,
            previousViewerId: lastBottleneckViewerId,
            viewerId: bottleneckViewerId,
            viewerName: viewerBwe[bottleneckViewerId]?.viewerName || null,
          });
        }
        bottleneckStreak = 1;
        lastBottleneckViewerId = bottleneckViewerId;
      }
    }

    const bweEvent = {
      viewers: viewerBwe,
      aggregate: {
        worstRttMs: worstRtt,
        worstNackRate: Number(worstNackRate.toFixed(4)),
        minScore: minScore === 10 ? null : minScore,
        minAvailableMbps: minAvailableMbps === Infinity ? null : minAvailableMbps,
        minDeliveryMbps: minDeliveryMbps === Infinity ? null : minDeliveryMbps,
        medianDeliveryMbps: deliverySamples.length ? Number(median(deliverySamples).toFixed(2)) : null,
        maxDeliveryMbps: Number(maxDeliveryMbps.toFixed(2)),
        viewerSpreadMbps: deliverySamples.length ? Number((maxDeliveryMbps - minDeliveryMbps).toFixed(2)) : null,
        lowHeadroomViewers,
        bottleneckViewerId,
        bottleneckViewerName: bottleneckViewerId ? (viewerBwe[bottleneckViewerId]?.viewerName || null) : null,
        bottleneckStreak,
        bottleneckScore: bottleneckScore === Infinity ? null : Number(bottleneckScore.toFixed(2)),
      },
    };

    // Send to streamer
    send(room.streamer.ws, 'server-bwe', bweEvent);

    // Log BWE snapshot
    appendSessionLog('server-bwe', bweEvent);
    sessionStats.bweSamples.push(bweEvent.aggregate);
    if (sessionStats.bweSamples.length > 10000) {
      sessionStats.bweSamples.splice(0, sessionStats.bweSamples.length - 10000);
    }
  }, BWE_POLL_INTERVAL_MS);

  bweIntervals.set(roomId, interval);
  console.log('[BWE] Started polling for room ' + roomId);
  appendSessionLog('bwe-started', { roomId });
}

function stopBwePolling(roomId) {
  const interval = bweIntervals.get(roomId);
  if (interval) {
    clearInterval(interval);
    bweIntervals.delete(roomId);
    console.log('[BWE] Stopped polling for room ' + roomId);
  }
}

// ============================================
// QUALITY REPORTS
// ============================================

function handleViewerQualityReport(clientId, data) {
  const client = clients.get(clientId);
  const room = rooms.get(client?.roomId);
  if (!room) return;
  const viewer = room.viewers.get(clientId);

  // Drop stale reports (fps=0 means stream ended for this viewer)
  if (data.fps === 0) {
    if (!client._zeroFpsCount) client._zeroFpsCount = 0;
    client._zeroFpsCount++;
    if (client._zeroFpsCount >= 3) return; // silently discard
  } else {
    client._zeroFpsCount = 0;
  }

  console.log(
    '[DIAG:QR] viewer=' + clientId +
    ' fps=' + data.fps +
    ' bitrate=' + data.bitrateMbps + 'Mbps' +
    ' res=' + data.frameWidth + 'x' + data.frameHeight +
    ' jitter=' + (data.jitterMs != null ? data.jitterMs : '--') + 'ms' +
    ' loss=' + (data.lossRate != null ? (data.lossRate * 100).toFixed(1) + '%' : '--')
  );

  appendSessionLog('viewer-quality-report', {
    clientId,
    streamerId: room.streamer?.id || null,
    fps: data.fps,
    bitrateMbps: data.bitrateMbps,
    frameWidth: data.frameWidth,
    frameHeight: data.frameHeight,
    jitterMs: data.jitterMs,
    lossRate: data.lossRate,
    droppedFramesDelta: data.droppedFramesDelta,
    jitterBufferDelayMs: data.jitterBufferDelayMs,
    decodeLatencyMs: data.decodeLatencyMs,
  });

  if (viewer) {
    viewer.latestQualityReport = {
      fps: data.fps,
      bitrateMbps: data.bitrateMbps,
      jitterMs: data.jitterMs,
      lossRate: data.lossRate,
      droppedFramesDelta: data.droppedFramesDelta || 0,
      jitterBufferDelayMs: data.jitterBufferDelayMs || null,
      decodeLatencyMs: data.decodeLatencyMs || null,
      at: Date.now(),
    };
  }

  // Track for session summary
  sessionStats.totalQualityReports++;
  sessionStats.qualityReportSamples.push({
    fps: data.fps,
    bitrateMbps: data.bitrateMbps,
    frameWidth: data.frameWidth,
    frameHeight: data.frameHeight,
    jitterMs: data.jitterMs,
    lossRate: data.lossRate,
    droppedFramesDelta: data.droppedFramesDelta,
    jitterBufferDelayMs: data.jitterBufferDelayMs,
    decodeLatencyMs: data.decodeLatencyMs,
  });
  // Keep last 10000 samples max
  if (sessionStats.qualityReportSamples.length > 10000) {
    sessionStats.qualityReportSamples.splice(0, sessionStats.qualityReportSamples.length - 10000);
  }

  send(room.streamer.ws, 'viewer-quality-report', {
    viewerId: clientId,
    fps: data.fps,
    bitrateMbps: data.bitrateMbps,
    frameWidth: data.frameWidth,
    frameHeight: data.frameHeight,
    jitterMs: data.jitterMs,
    lossRate: data.lossRate,
    droppedFramesDelta: data.droppedFramesDelta,
    jitterBufferDelayMs: data.jitterBufferDelayMs,
    decodeLatencyMs: data.decodeLatencyMs,
  });
}

// ============================================
// DISCONNECT
// ============================================

function handleDisconnect(clientId) {
  const client = clients.get(clientId);
  if (!client) return;

  if (client.role === 'lumina') {
    const room = rooms.get(clientId);
    if (room) {
      stopBwePolling(clientId);
      appendSessionLog('lumina-disconnected', { clientId, name: room.streamer.name });
      for (const [viewerId, viewer] of room.viewers) {
        send(viewer.ws, 'streamer-disconnected', {});
        if (viewer.consumerTransport) viewer.consumerTransport.close();
      }
      room.router.close();
      rooms.delete(clientId);
      console.log('[SFU] Room closed for Lumina host ' + room.streamer.name);
    }

    for (const [cid, c] of clients) {
      if (cid !== clientId) {
        send(c.ws, 'streamer-left', { streamerId: clientId });
      }
    }
  }

  if (client.role === 'viewer' && client.roomId) {
    const room = rooms.get(client.roomId);
    if (room) {
      const viewer = room.viewers.get(clientId);
      if (viewer) {
        if (viewer.consumerTransport) viewer.consumerTransport.close();
        room.viewers.delete(clientId);
        send(room.streamer.ws, 'viewer-left', { viewerId: clientId });
        sessionStats.totalViewerLeaves++;
        appendSessionLog('viewer-left', { clientId, viewerName: viewer.name });
        console.log('[SFU] Viewer ' + viewer.name + ' removed from room');
      }
    }
  }
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

function shutdown() {
  console.log('\n[Server] Shutting down gracefully...');
  writeSessionSummary();
  clearInterval(heartbeatTimer);
  for (const roomId of bweIntervals.keys()) stopBwePolling(roomId);
  wss.clients.forEach((ws) => ws.terminate());
  if (worker) worker.close();
  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ============================================
// STARTUP
// ============================================

async function start() {
  await createWorker();
  const announcedIp = config.ANNOUNCED_IP || getLocalIp();

  server.listen(config.PORT, config.HOST, () => {
    console.log('');
    console.log('  Lumina SFU Server (mediasoup)');
    console.log('  Ready for connections');
    console.log('');
    console.log('  WebSocket:    ws://' + config.HOST + ':' + config.PORT + '/ws');
    console.log('  Health:       http://' + config.HOST + ':' + config.PORT + '/health');
    console.log('  Hosts:        http://' + config.HOST + ':' + config.PORT + '/lumina');
    console.log('  Announced IP: ' + announcedIp);
    console.log('  RTP ports:    ' + config.RTC_MIN_PORT + '-' + config.RTC_MAX_PORT);
    console.log('');
  });
}

start().catch((error) => {
  console.error('[Server] Failed to start:', error);
  process.exit(1);
});
