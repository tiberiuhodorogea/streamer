import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import mediasoup from 'mediasoup';
import os from 'os';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

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
      'profile-level-id': '42e01f',
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

app.get('/streamers', (req, res) => {
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
      return handleStreamerRegister(clientId, eventData, ws);
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
// STREAMER HANDLERS
// ============================================

async function handleStreamerRegister(clientId, data, ws) {
  const name = String(data?.name || clientId).substring(0, 64);
  console.log('[SFU] Registering streamer: ' + name);

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
    client.role = 'streamer';
    client.roomId = clientId;

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
    send(ws, 'error', { message: 'Streamer not found' });
    return;
  }

  console.log('[SFU] Viewer "' + viewerName + '" joining streamer ' + room.streamer.name);

  const client = clients.get(clientId);
  client.role = 'viewer';
  client.roomId = streamerId;

  room.viewers.set(clientId, {
    id: clientId,
    ws,
    name: viewerName,
    consumerTransport: null,
    consumers: new Map(),
  });

  send(room.streamer.ws, 'viewer-joined', { viewerId: clientId, viewerName });

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

      consumerDataList.push({
        id: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });

      console.log('[SFU] Consumer created: ' + kind + ' for viewer ' + viewer.name);
    }

    respond(clientId, data._reqId, { consumers: consumerDataList });
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
// QUALITY REPORTS
// ============================================

function handleViewerQualityReport(clientId, data) {
  const client = clients.get(clientId);
  const room = rooms.get(client?.roomId);
  if (!room) return;

  console.log(
    '[DIAG:QR] viewer=' + clientId +
    ' fps=' + data.fps +
    ' bitrate=' + data.bitrateMbps + 'Mbps' +
    ' res=' + data.frameWidth + 'x' + data.frameHeight +
    ' jitter=' + (data.jitterMs != null ? data.jitterMs : '--') + 'ms' +
    ' loss=' + (data.lossRate != null ? (data.lossRate * 100).toFixed(1) + '%' : '--')
  );

  send(room.streamer.ws, 'viewer-quality-report', {
    viewerId: clientId,
    fps: data.fps,
    bitrateMbps: data.bitrateMbps,
    frameWidth: data.frameWidth,
    frameHeight: data.frameHeight,
    jitterMs: data.jitterMs,
    lossRate: data.lossRate,
  });
}

// ============================================
// DISCONNECT
// ============================================

function handleDisconnect(clientId) {
  const client = clients.get(clientId);
  if (!client) return;

  if (client.role === 'streamer') {
    const room = rooms.get(clientId);
    if (room) {
      for (const [viewerId, viewer] of room.viewers) {
        send(viewer.ws, 'streamer-disconnected', {});
        if (viewer.consumerTransport) viewer.consumerTransport.close();
      }
      room.router.close();
      rooms.delete(clientId);
      console.log('[SFU] Room closed for streamer ' + room.streamer.name);
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
  clearInterval(heartbeatTimer);
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
    console.log('  P2P Streaming SFU Server (mediasoup)');
    console.log('  Ready for connections');
    console.log('');
    console.log('  WebSocket:    ws://' + config.HOST + ':' + config.PORT + '/ws');
    console.log('  Health:       http://' + config.HOST + ':' + config.PORT + '/health');
    console.log('  Streamers:    http://' + config.HOST + ':' + config.PORT + '/streamers');
    console.log('  Announced IP: ' + announcedIp);
    console.log('  RTP ports:    ' + config.RTC_MIN_PORT + '-' + config.RTC_MAX_PORT);
    console.log('');
  });
}

start().catch((error) => {
  console.error('[Server] Failed to start:', error);
  process.exit(1);
});
