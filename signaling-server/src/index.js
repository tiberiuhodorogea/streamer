import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';

const app = express();
const server = createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

const config = {
  PORT: process.env.PORT || 4000,
  HOST: process.env.HOST || '0.0.0.0',
  HEARTBEAT_INTERVAL_MS: 15000,
  CLIENT_TIMEOUT_MS: 30000
};

// Track streamers and viewers
const streamers = new Map();
const viewers = new Map();
const clients = new Map();

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    streamers: streamers.size,
    viewers: viewers.size,
    clients: clients.size
  });
});

// Get available streamers
app.get('/streamers', (req, res) => {
  const list = Array.from(streamers.entries()).map(([id, s]) => ({
    id,
    name: s.name || id,
    viewerCount: s.viewers.size
  }));
  res.json(list);
});

// ============================================
// HEARTBEAT - detect dead connections
// ============================================
const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const [clientId, client] of clients) {
    if (now - client.lastPong > config.CLIENT_TIMEOUT_MS) {
      console.log('[WS] Client ' + clientId + ' timed out - terminating');
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
  clients.set(clientId, { ws, lastPong: Date.now() });

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

function send(ws, eventName, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify([eventName, data]));
  }
}

function handleMessage(clientId, msg, ws) {
  const [eventName, eventData] = msg;

  switch (eventName) {
    case 'register-streamer':
      return handleStreamerRegister(clientId, eventData, ws);
    case 'join-streamer':
      return handleViewerJoin(clientId, eventData, ws);
    case 'offer':
      return handleOffer(clientId, eventData);
    case 'answer':
      return handleAnswer(clientId, eventData);
    case 'ice-candidate':
      return handleIceCandidate(clientId, eventData);
    case 'viewer-quality-report':
      return handleViewerQualityReport(clientId, eventData);
    default:
      console.log('[WS] Unknown event from ' + clientId + ': ' + eventName);
  }
}

function handleStreamerRegister(clientId, data, ws) {
  const name = String(data && data.name || clientId).substring(0, 64);
  console.log('[WS] Registering streamer: ' + name);

  streamers.set(clientId, { ws, name, viewers: new Set() });

  // Notify all OTHER clients
  for (const [cid, client] of clients) {
    if (cid !== clientId) {
      send(client.ws, 'streamer-joined', { streamerId: clientId, name });
    }
  }
}

function handleViewerJoin(clientId, data, ws) {
  const streamerId = data && data.streamerId;
  const viewerName = String(data && data.viewerName || clientId).substring(0, 64);
  const streamer = streamers.get(streamerId);

  if (!streamer) {
    send(ws, 'error', { message: 'Streamer not found' });
    return;
  }

  console.log('[WS] Viewer "' + viewerName + '" joining streamer ' + streamerId);

  viewers.set(clientId, { ws, streamerId, name: viewerName });
  streamer.viewers.add(clientId);

  send(streamer.ws, 'viewer-joined', { viewerId: clientId, viewerName });
  send(ws, 'streamer-info', { streamerId });
}

function handleOffer(clientId, data) {
  const { viewerId, offer } = data;
  const viewer = viewers.get(viewerId);
  if (viewer) {
    send(viewer.ws, 'offer', { streamerId: clientId, offer });
  }
}

function handleAnswer(clientId, data) {
  const { streamerId, answer } = data;
  const streamer = streamers.get(streamerId);
  if (streamer) {
    send(streamer.ws, 'answer', { viewerId: clientId, answer });
  }
}

function handleIceCandidate(clientId, data) {
  const { targetId, candidate } = data;
  const target = streamers.get(targetId) || viewers.get(targetId);
  if (target) {
    send(target.ws, 'ice-candidate', { from: clientId, candidate });
  }
}

function handleViewerQualityReport(clientId, data) {
  const viewer = viewers.get(clientId);
  if (!viewer) return;

  const streamer = streamers.get(viewer.streamerId);
  if (!streamer) return;

  // Log every quality report for diagnostics
  console.log(
    '[DIAG:QR] viewer=' + clientId +
    ' fps=' + data.fps +
    ' bitrate=' + data.bitrateMbps + 'Mbps' +
    ' res=' + data.frameWidth + 'x' + data.frameHeight +
    ' jitter=' + (data.jitterMs != null ? data.jitterMs : '--') + 'ms'
  );

  send(streamer.ws, 'viewer-quality-report', {
    viewerId: clientId,
    fps: data.fps,
    bitrateMbps: data.bitrateMbps,
    frameWidth: data.frameWidth,
    frameHeight: data.frameHeight,
    jitterMs: data.jitterMs
  });
}

function handleDisconnect(clientId) {
  // If a streamer disconnected
  if (streamers.has(clientId)) {
    const streamer = streamers.get(clientId);
    for (const viewerId of streamer.viewers) {
      const viewer = viewers.get(viewerId);
      if (viewer) {
        send(viewer.ws, 'streamer-disconnected', {});
      }
      viewers.delete(viewerId);
    }
    streamers.delete(clientId);

    // Notify remaining clients
    for (const [cid, client] of clients) {
      if (cid !== clientId) {
        send(client.ws, 'streamer-left', { streamerId: clientId });
      }
    }
  }

  // If a viewer disconnected
  if (viewers.has(clientId)) {
    const { streamerId } = viewers.get(clientId);
    const streamer = streamers.get(streamerId);
    if (streamer) {
      streamer.viewers.delete(clientId);
      send(streamer.ws, 'viewer-left', { viewerId: clientId });
    }
    viewers.delete(clientId);
  }
}

// Graceful shutdown
function shutdown() {
  console.log('\n[Server] Shutting down gracefully...');
  clearInterval(heartbeatTimer);
  wss.clients.forEach((ws) => ws.terminate());
  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(config.PORT, config.HOST, () => {
  console.log('');
  console.log('  P2P Streaming Signaling Server');
  console.log('  Ready for connections');
  console.log('');
  console.log('  WebSocket: ws://' + config.HOST + ':' + config.PORT + '/ws');
  console.log('  Health:    http://' + config.HOST + ':' + config.PORT + '/health');
  console.log('  Streamers: http://' + config.HOST + ':' + config.PORT + '/streamers');
  console.log('');
});
