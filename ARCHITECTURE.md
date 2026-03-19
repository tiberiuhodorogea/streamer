# P2P Streaming Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Your Windows PC (RTX 5090)                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Streamer App (Electron)                                 │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │  • Desktop Capture (1920×1080 @ 60fps)                   │  │
│  │  • H.264 Encoder (NVENC accelerated)                     │  │
│  │  • WebRTC Peer Connections                              │  │
│  │  • UI for selecting stream source                        │  │
│  └────────────────────────┬─────────────────────────────────┘  │
│                           │ (Local WebRTC)                       │
│  ┌────────────────────────▼─────────────────────────────────┐  │
│  │  Signaling Server (Node.js + Socket.io)                 │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │  • Port: ws://localhost:4000                             │  │
│  │  • Streamer registry                                     │  │
│  │  • Viewer discovery                                      │  │
│  │  • SDP/ICE candidate relay                               │  │
│  │  • Connection management                                 │  │
│  └────────┬──────────────────────────────┬───────────────┬─┘  │
│           │                              │               │       │
│           └──────────────────┬───────────┼─────────┬─────┘       │
│                              │           │         │             │
└──────────────────────────────┼───────────┼─────────┼─────────────┘
                               │           │         │
                    Friend 1   │  Friend 2 │         │ Friend 3
                    (Browser)  │ (Browser) │         │ (Browser)
                               ▼           ▼         ▼
                    ┌──────┐  ┌──────┐  ┌──────┐
                    │Video │  │Video │  │Video │
                    │Player│  │Player│  │Player│
                    │H.264 │  │H.264 │  │H.264 │
                    └──────┘  └──────┘  └──────┘
                   http://localhost:3000
```

## Communication Flow

### 1. **Initialization**

```
Streamer App
    ↓ (register-streamer)
Signaling Server → broadcasts (streamer-joined)
                   ↓
            Web Clients (on refresh)
```

### 2. **Viewer Joins**

```
Viewer joins
    ↓ (join-streamer)
Signaling Server
    ├→ notifies Streamer (viewer-joined)
    └→ sends Streamer list to Viewer (streamer-info)
```

### 3. **WebRTC Connection Establishment**

```
Streamer creates SDP Offer
    ↓ (offer event)
Signaling Server
    ↓ (relayed)
Viewer
    ↓ creates SDP Answer
Signaling Server
    ↓ (relayed back)
Streamer
    ↓ (uses to establish connection)
ICE candidates exchanged both ways
    ↓
Direct P2P connection established
    ↓
H.264 video stream flows directly
```

### 4. **Data Flow (Streaming)**

```
Desktop Screen Capture
    ↓
H.264 Encoder (NVENC on RTX 5090)
    ↓
WebRTC Video Track
    ↓
P2P Connection (UDP)
    ↓
Viewer's Browser (WebRTC decoder)
    ↓
HTML5 Video Element (VP9/H.264)
```

## Component Details

### Signaling Server (`signaling-server/`)

**Purpose**: Connect streamers and viewers, relay connection metadata

**Technology Stack**:
- Express.js (HTTP server)
- Socket.io (WebSocket for real-time bidirectional communication)
- Node.js runtime

**Key Features**:
- `register-streamer`: Streamer registers with server
- `join-streamer`: Viewer requests to join a stream
- `offer`: Streamer sends WebRTC offer to viewer
- `answer`: Viewer sends WebRTC answer back
- `ice-candidate`: Both sides exchange ICE candidates
- Connection monitoring and cleanup

**Endpoints**:
- `GET /health`: Server health check
- `GET /streamers`: List active streamers
- WebSocket: `ws://localhost:4000`

**Scalability**:
- Stateless (can be replicated)
- Memory-based storage (can switch to Redis)
- Supports 100s of concurrent connections on modest hardware

---

### Streamer App (`streamer-app/`)

**Purpose**: Capture screen and stream to multiple peers

**Technology Stack**:
- Electron (desktop application framework)
- Simple-peer (WebRTC wrapper)
- Socket.io-client (WebSocket communication)
- Native desktop APIs (screen capture, audio/video)

**Key Features**:
- Multiple capture source selection (desktop, individual windows)
- Full HD (1920×1080) @ 60fps capture
- NVENC hardware encoding support (auto-detected)
- H.264 codec (universal browser support)
- Multiple simultaneous peer connections
- Real-time stats (bitrate, FPS, viewer count)
- Connection quality indicators

**Performance**:
- CPU: ~5-15% (most work on GPU with NVENC)
- GPU: 5-20% NVENC utilization
- Memory: ~150-300 MB
- Network: 8-15 Mbps per viewer

**Architecture**:
```
main.js (Electron main process)
    ├─ IPC handlers for screen capture
    └─ Preload security layer
    
ui/
    ├─ index.html (UI layout)
    ├─ app.js (WebRTC + Socket.io logic)
    └─ style.css (UI styling)
```

---

### Web Client (`web-client/`)

**Purpose**: Simple browser interface for viewing streams

**Technology Stack**:
- Vanilla JavaScript (no frameworks for minimal dependencies)
- WebRTC API
- Socket.io-client
- HTML5 Video element
- CSS3 for responsive design

**Key Features**:
- Server connection management
- Browse available streams
- Real-time stream metrics (resolution, FPS, bitrate, latency)
- Automatic quality adaptation
- One-click stream selection
- Responsive design (desktop, tablet, mobile)

**Files**:
```
index.html  - UI markup with sections for setup, streams, player
app.js      - All application logic (signaling, WebRTC, stats)
style.css   - Responsive styling
```

**Performance**:
- CPU: ~10-20% (video decoding)
- Memory: ~50-100 MB per stream
- Network: Receives 8-15 Mbps stream data

---

### Shared Config (`shared/`)

**Purpose**: Centralized configuration for all components

**Exports**:
- ICE servers (STUN for NAT traversal)
- Video quality settings (resolution, FPS)
- Bitrate limits
- Maximum concurrent viewers

**Usage**:
```javascript
import config from './shared/config.js';

const { width, height, frameRate } = config.video;
const { host, port } = config.signaling;
```

---

## Data Structures

### Streamer Registration (Socket.io)

```javascript
// Streamer sends
{
  type: "register-streamer",
  data: {
    name: "Gaming Stream 1"
  }
}

// Server tracks
{
  streamerId: "socket-id-xyz",
  name: "Gaming Stream 1",
  viewers: Set([viewer-id-1, viewer-id-2])
}
```

### Viewer Join (Socket.io)

```javascript
{
  type: "join-streamer",
  data: {
    streamerId: "socket-id-xyz",
    viewerName: "Friend 1"
  }
}
```

### WebRTC Signaling

```javascript
// Offer (SDP)
{
  type: "offer",
  data: {
    viewerId: "viewer-socket-id",
    offer: {
      type: "offer",
      sdp: "v=0\n..." // Full SDP string
    }
  }
}

// Answer (SDP)
{
  type: "answer",
  data: {
    streamerId: "streamer-socket-id",
    answer: {
      type: "answer",
      sdp: "v=0\n..." // Full SDP string
    }
  }
}

// ICE Candidate
{
  type: "ice-candidate",
  data: {
    targetId: "recipient-socket-id",
    candidate: {
      candidate: "candidate:...",
      sdpMLineIndex: 0,
      sdpMid: "0"
    }
  }
}
```

---

## Network Requirements

### Local Network (Best)
- **Latency**: <20ms (usually <10ms)
- **Bandwidth**: 30+ Mbps (room for multiple viewers)
- **Traversal**: Direct connection
- **Quality**: Maximum (no compression artifacts)

### Remote (Internet)
- **Latency**: 20-150ms
- **Bandwidth**: 10+ Mbps upload (streamer), 10+ Mbps download (viewers)
- **Traversal**: STUN/TURN servers handle NAT
- **Quality**: Good (adaptive bitrate)

### Mobile/Cellular
- **Latency**: 30-200ms
- **Bandwidth**: 5+ Mbps (may trigger quality reduction)
- **Traversal**: STUN/TURN (if on different networks)
- **Quality**: Fair (may have buffering)

---

## Codec Details

### Video Codec: H.264

**Why H.264?**
- Universal browser support (Safari, Chrome, Firefox, Edge)
- Hardware encoding available (NVENC on NVIDIA)
- Lower latency than other codecs
- Patent-encumbered but widely licensed

**Quality Settings** (for Full HD 60fps):
- **High Quality**: 12-15 Mbps
- **Medium Quality**: 8-10 Mbps
- **Low Quality**: 4-6 Mbps
- **Minimal**: <2 Mbps (for weak connections)

### Hardware Encoding (NVENC)

With your RTX 5090:
- **Encoder**: NVIDIA H.264 (NVENCoder)
- **Offload**: ~95% of encoding work to GPU
- **CPU Impact**: <5%
- **Latency**: ~5-10ms added
- **Power**: Minimal (GPU always capable of much more)

Browser automatically selects hardware encoder if available via WebRTC API.

---

## Cloud Migration Paths

### Path 1: Signaling Server to Cloud (Easiest)

```
Before:
  Streamer ← localhost:4000 → Signaling
         ↑
      Viewers

After:
  Streamer ← AWS:4000 → Signaling (Cloud)
         ↑
      Viewers
```

**Steps**:
1. Deploy `signaling-server` to AWS EC2 (t3.small sufficient)
2. Update URL in Streamer app: `ws://your-aws-domain:4000`
3. Update URL in Web Client: point to same domain
4. Done! Streamers and viewers find each other via cloud

**Benefits**:
- Viewers accessible from anywhere
- Streamer can be anywhere
- Signaling server costs <$10/month
- No client code changes

---

### Path 2: Web Client to CDN

```
Signaling + Streamer local
         ↑
CDN (CloudFront)
         ↓
      Viewers
```

**Steps**:
1. Deploy `web-client/` folder to AWS S3
2. Enable CloudFront distribution
3. Share CloudFront URL: `https://your-cdn.cloudfront.net`
4. Viewers access from CDN instead of localhost

**Benefits**:
- No need to expose home IP
- Better performance for geographically distant viewers
- Still P2P for actual video stream

---

### Path 3: Full Cloud

```
All on AWS:
  - Signaling Server (hosted)
  - Web Client (CloudFront)
  - Streamer (local, but connects to cloud)
```

**This is enterprise-grade**. Overkill for 2-5 viewers but enables:
- Sharing with anyone in the world
- Automatic scaling
- Analytics and monitoring
- Backup and redundancy

---

## Performance Optimization

### On the Streamer App

1. **Use NVENC**: Automatic, just ensure GPU drivers updated
2. **Select specific app window**: Reduces CPU overhead vs full desktop
3. **Reduce capture resolution**: If network constrained (Settings)
4. **Close unnecessary apps**: Reduces interference with GPU

### On the Web Client

1. **Stable network**: WiFi near router, or wired connection
2. **Disable hardware acceleration**: If seeing artifacts (Settings → Advanced)
3. **Use modern browser**: Chrome/Edge for best WebRTC support
4. **Check stats panel**: Adjust based on jitter/bitrate

### On the Signaling Server

1. **Increase worker processes**: For many concurrent connections
2. **Use Redis**: For state management if load increases
3. **Add load balancer**: Connect multiple instances
4. **Monitor resources**: CPU, memory, bandwidth

---

## Troubleshooting Network Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No connection | Server not running | Start signaling server first |
| Viewers can't find streamer | Firewall blocking | Allow port 4000 in firewall |
| Stream buffering | Weak WiFi | Use wired connection or 5GHz WiFi |
| No video (just audio) | Codec mismatch | Update browser, or try Safari → Chrome |
| High latency | Geographic distance | Use local server for testing |
| P2P fails, relay fails | NAT too restrictive | Add TURN servers to config |

---

## Security Considerations

### Current Implementation (POC)
- No authentication (assumes trusted network)
- No encryption (uses WebRTC default encryption)
- No access control

### For Production

1. **Authentication**:
   - Add JWT tokens or API keys
   - Validate on server before allowing stream registration

2. **Encryption**:
   - Already done by WebRTC (DTLS-SRTP)
   - Enable HTTPS for web client

3. **Access Control**:
   - Whitelist viewers by email/phone
   - Generate unique share codes per stream
   - Track bandwidth per user

4. **Privacy**:
   - No recording by default
   - Clear user data on disconnect
   - Audit trail of connections

---

## Future Enhancements

### Planned Features
- [ ] Chat system (Socket.io events)
- [ ] Viewer controls (pause, seek - though live only?)
- [ ] Screen sharing (from viewers to streamer?)
- [ ] Recording (save stream to disk)
- [ ] Multiple streams per user
- [ ] Mobile app (React Native)
- [ ] Analytics dashboard
- [ ] Multi-bitrate adaptive streaming

### Advanced Features
- [ ] Simulcast (RTMP + WebRTC simultaneously)
- [ ] Interactive overlays (chat, donations, alerts)
- [ ] Viewer-to-viewer messaging
- [ ] Stream quality presets (auto-select)
- [ ] Bandwidth throttling simulation
- [ ] AI-powered auto-framing

---

## References

- **WebRTC**: https://webrtc.org/
- **Socket.io**: https://socket.io/
- **Electron**: https://electronjs.org/
- **NVIDIA NVENC**: https://developer.nvidia.com/nvidia-video-codec-sdk
- **H.264**: https://en.wikipedia.org/wiki/H.264/MPEG-4_AVC
- **Simple Peer**: https://github.com/feross/simple-peer

---

## License

MIT License - Feel free to use and modify!
