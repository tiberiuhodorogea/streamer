import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { WebSocketServer } from 'ws';
import cors from 'cors';

const app = express();
const server = createServer(app);

// Socket.io server
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Raw WebSocket server on the same HTTP server
const wss = new WebSocketServer({ server, path: '/ws' });

const config = {
  PORT: process.env.PORT || 4000,
  HOST: process.env.HOST || '0.0.0.0'
};

// Track streamers and viewers
const streamers = new Map();
const viewers = new Map();
const rawWSClients = new Map(); // For raw WebSocket connections

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    streamers: streamers.size,
    viewers: viewers.size,
    wsClients: rawWSClients.size
  });
});

// Get available streamers
app.get('/streamers', (req, res) => {
  const list = Array.from(streamers.keys()).map(id => ({
    id,
    name: streamers.get(id).name || id,
    viewerCount: streamers.get(id).viewers.size
  }));
  res.json(list);
});

// ============================================
// RAW WEBSOCKET HANDLER
// ============================================
wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substr(2, 9);
  console.log(`[RAW WS] Client connected: ${clientId}`);
  rawWSClients.set(clientId, ws);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleRawWSMessage(clientId, msg, ws);
    } catch (err) {
      console.error(`[RAW WS] Parse error: ${err.message}`);
    }
  });

  ws.on('close', () => {
    console.log(`[RAW WS] Client disconnected: ${clientId}`);
    handleRawWSDisconnect(clientId);
    rawWSClients.delete(clientId);
  });

  ws.on('error', (err) => {
    console.error(`[RAW WS] Error: ${err.message}`);
  });
});

function handleRawWSMessage(clientId, msg, ws) {
  const [eventName, eventData] = msg;
  console.log(`[RAW WS] ${clientId} - ${eventName}`);

  if (eventName === 'register-streamer') {
    handleRawWSStreamerRegister(clientId, eventData, ws);
  } else if (eventName === 'join-streamer') {
    handleRawWSViewerJoin(clientId, eventData, ws);
  } else if (eventName === 'offer') {
    handleRawWSOffer(clientId, eventData);
  } else if (eventName === 'answer') {
    handleRawWSAnswer(clientId, eventData);
  } else if (eventName === 'ice-candidate') {
    handleRawWSIceCandidate(clientId, eventData);
  } else if (eventName === 'viewer-quality-report') {
    handleRawWSViewerQualityReport(clientId, eventData);
  }
}

function handleRawWSStreamerRegister(clientId, data, ws) {
  const { name } = data;
  console.log(`[RAW WS] Registering streamer: ${name}`);
  
  streamers.set(clientId, {
    ws,
    name,
    viewers: new Set(),
    type: 'raw-ws'
  });

  // Notify all clients
  broadcastToAll('streamer-joined', { streamerId: clientId, name });
}

function handleRawWSViewerJoin(clientId, data, ws) {
  const { streamerId, viewerName } = data;
  const streamer = streamers.get(streamerId);

  if (!streamer) {
    ws.send(JSON.stringify(['error', { message: 'Streamer not found' }]));
    return;
  }

  console.log(`[RAW WS] Viewer joining streamer ${streamerId}`);

  viewers.set(clientId, {
    ws,
    streamerId,
    name: viewerName,
    type: 'raw-ws'
  });

  streamer.viewers.add(clientId);

  // Notify streamer of new viewer
  const streamerWs = streamer.ws || streamer.socket;
  if (streamerWs && streamerWs.send) {
    streamerWs.send(JSON.stringify(['viewer-joined', { viewerId: clientId, viewerName }]));
  }

  // Send streamer info to viewer
  ws.send(JSON.stringify(['streamer-info', {
    streamerId,
    streams: [
      { id: 'desktop', name: 'Desktop' },
      { id: 'primary-app', name: 'Primary App' }
    ]
  }]));
}

function handleRawWSOffer(clientId, data) {
  const { viewerId, offer } = data;
  const viewer = viewers.get(viewerId);

  if (viewer) {
    console.log(`[Signaling] Forwarding offer to viewer ${viewerId}`);
    if (viewer.type === 'raw-ws' && viewer.ws && viewer.ws.send) {
      viewer.ws.send(JSON.stringify(['offer', { streamerId: clientId, offer }]));
    } else if (viewer.type === 'socket.io' && viewer.socket) {
      viewer.socket.emit('offer', { streamerId: clientId, offer });
    }
  }
}

function handleRawWSAnswer(clientId, data) {
  const { streamerId, answer } = data;
  const streamer = streamers.get(streamerId);

  if (streamer) {
    console.log(`[Signaling] Forwarding answer to streamer ${streamerId}`);
    if (streamer.type === 'raw-ws' && streamer.ws && streamer.ws.send) {
      streamer.ws.send(JSON.stringify(['answer', { viewerId: clientId, answer }]));
    } else if (streamer.type === 'socket.io' && streamer.socket) {
      streamer.socket.emit('answer', { viewerId: clientId, answer });
    }
  }
}

function handleRawWSIceCandidate(clientId, data) {
  const { targetId, candidate } = data;
  const target = streamers.get(targetId) || viewers.get(targetId);

  if (target) {
    if (target.type === 'raw-ws' && target.ws && target.ws.send) {
      target.ws.send(JSON.stringify(['ice-candidate', { from: clientId, candidate }]));
    } else if (target.type === 'socket.io' && target.socket) {
      target.socket.emit('ice-candidate', { from: clientId, candidate });
    }
  }
}

function handleRawWSViewerQualityReport(clientId, data) {
  const viewer = viewers.get(clientId);
  if (!viewer) {
    return;
  }

  const streamer = streamers.get(viewer.streamerId);
  if (!streamer) {
    return;
  }

  const payload = {
    viewerId: clientId,
    fps: data.fps,
    bitrateMbps: data.bitrateMbps,
    frameWidth: data.frameWidth,
    frameHeight: data.frameHeight,
    jitterMs: data.jitterMs
  };

  if (streamer.type === 'raw-ws' && streamer.ws && streamer.ws.send) {
    streamer.ws.send(JSON.stringify(['viewer-quality-report', payload]));
  } else if (streamer.type === 'socket.io' && streamer.socket) {
    streamer.socket.emit('viewer-quality-report', payload);
  }
}

function handleRawWSDisconnect(clientId) {
  // If streamer disconnected
  if (streamers.has(clientId)) {
    const { viewers: viewerSet } = streamers.get(clientId);
    viewerSet.forEach(viewerId => {
      const viewer = viewers.get(viewerId);
      if (viewer?.type === 'raw-ws' && viewer.ws && viewer.ws.send) {
        viewer.ws.send(JSON.stringify(['streamer-disconnected', {}]));
      } else if (viewer?.type === 'socket.io' && viewer.socket) {
        viewer.socket.emit('streamer-disconnected');
      }
      viewers.delete(viewerId);
    });
    streamers.delete(clientId);
    broadcastToAll('streamer-left', { streamerId: clientId });
  }

  // If viewer disconnected
  if (viewers.has(clientId)) {
    const { streamerId } = viewers.get(clientId);
    const streamer = streamers.get(streamerId);
    if (streamer?.type === 'raw-ws' && streamer.ws && streamer.ws.send) {
      streamer.ws.send(JSON.stringify(['viewer-left', { viewerId: clientId }]));
    } else if (streamer?.type === 'socket.io' && streamer.socket) {
      streamer.socket.emit('viewer-left', { viewerId: clientId });
    }
    viewers.delete(clientId);
  }
}

function broadcastToAll(eventName, data) {
  const msg = JSON.stringify([eventName, data]);
  rawWSClients.forEach(ws => {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

// ============================================
// SOCKET.IO HANDLER (for browser viewers)
// ============================================
io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  // Streamer registers
  socket.on('register-streamer', (data) => {
    const { name } = data;
    console.log(`[Socket.io] Registering as streamer: ${name}`);
    
    streamers.set(socket.id, {
      socket,
      name,
      viewers: new Set(),
      type: 'socket.io'
    });

    socket.broadcast.emit('streamer-joined', {
      streamerId: socket.id,
      name
    });
  });

  // Viewer wants to join a streamer
  socket.on('join-streamer', (data) => {
    const { streamerId, viewerName } = data;
    const streamer = streamers.get(streamerId);

    if (!streamer) {
      socket.emit('error', { message: 'Streamer not found' });
      return;
    }

    console.log(`[Socket.io] Viewer joining streamer ${streamerId}`);

    viewers.set(socket.id, {
      socket,
      streamerId,
      name: viewerName,
      type: 'socket.io'
    });

    streamer.viewers.add(socket.id);

    // Notify streamer of new viewer
    streamer.socket.emit('viewer-joined', {
      viewerId: socket.id,
      viewerName
    });

    // Send streamer info to viewer
    socket.emit('streamer-info', {
      streamerId,
      streams: [
        { id: 'desktop', name: 'Desktop' },
        { id: 'primary-app', name: 'Primary App' }
      ]
    });
  });

  // Handle WebRTC signaling - SDP offer from streamer
  socket.on('offer', (data) => {
    const { viewerId, offer } = data;
    const viewer = viewers.get(viewerId);

    if (viewer) {
      console.log(`[Signaling] Forwarding offer to viewer ${viewerId}`);
      viewer.socket.emit('offer', {
        streamerId: socket.id,
        offer
      });
    }
  });

  // Handle WebRTC signaling - SDP answer from viewer
  socket.on('answer', (data) => {
    const { streamerId, answer } = data;
    const streamer = streamers.get(streamerId);

    if (streamer) {
      console.log(`[Signaling] Forwarding answer to streamer ${streamerId}`);
      streamer.socket.emit('answer', {
        viewerId: socket.id,
        answer
      });
    }
  });

  // Handle ICE candidates
  socket.on('ice-candidate', (data) => {
    const { targetId, candidate } = data;
    const target = streamers.get(targetId) || viewers.get(targetId);

    if (target) {
      target.socket.emit('ice-candidate', {
        from: socket.id,
        candidate
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);

    // If streamer disconnected
    if (streamers.has(socket.id)) {
      const { viewers: viewerSet } = streamers.get(socket.id);
      viewerSet.forEach(viewerId => {
        const viewer = viewers.get(viewerId);
        if (viewer) {
          viewer.socket.emit('streamer-disconnected');
          viewers.delete(viewerId);
        }
      });
      streamers.delete(socket.id);
      io.emit('streamer-left', { streamerId: socket.id });
    }

    // If viewer disconnected
    if (viewers.has(socket.id)) {
      const { streamerId } = viewers.get(socket.id);
      const streamer = streamers.get(streamerId);
      if (streamer) {
        streamer.viewers.delete(socket.id);
        streamer.socket.emit('viewer-left', { viewerId: socket.id });
      }
      viewers.delete(socket.id);
    }
  });
});

server.listen(config.PORT, config.HOST, () => {
  console.log(`
╔════════════════════════════════════════╗
║   P2P Streaming Signaling Server       ║
║   Ready for connections                ║
╚════════════════════════════════════════╝

🔗 Socket.io: ws://${config.HOST}:${config.PORT}/socket.io/?EIO=4&transport=websocket
🔗 Raw WebSocket: ws://${config.HOST}:${config.PORT}/ws
📊 Health: http://${config.HOST}:${config.PORT}/health
📋 Streamers: http://${config.HOST}:${config.PORT}/streamers
  `);
});
