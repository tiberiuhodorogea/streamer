# P2P Streaming Application - Quick Start Guide

## Project Structure

```
streamer/
├── signaling-server/    # WebRTC signaling server (Node.js + Socket.io)
├── streamer-app/        # Electron app (Windows) - screen capture & streaming
├── web-client/          # Web viewer (vanilla JS + WebRTC)
└── shared/              # Shared config and utilities
```

---

## Prerequisites

- **Node.js 18+**: [Download](https://nodejs.org/)
- **Windows 11**: For the Electron streamer app
- **NVIDIA GPU**: Optional but recommended for hardware encoding (5090 RTX in your case)
- **Browser**: Modern Chrome/Edge/Firefox for viewing

---

## Installation

### Option 1: Automated Setup (Windows)
```bash
./setup.bat
```

### Option 2: Automated Setup (Linux/Mac)
```bash
chmod +x setup.sh
./setup.sh
```

### Option 3: Manual Setup
```bash
# Install all dependencies
npm install

# Install workspace dependencies
npm install --workspaces
```

---

## Running the Application

### Method 1: Quick Start All (Windows)
```bash
./start-all.bat
```
This opens 3 separate terminal windows automatically.

### Method 2: Quick Start All (Linux/Mac)
```bash
chmod +x start-all.sh
./start-all.sh
```

### Method 3: Manual - Start Each Component Separately

**Terminal 1 - Signaling Server:**
```bash
cd signaling-server
npm start
```
✓ Server runs on `ws://localhost:4000`

**Terminal 2 - Streamer App (Windows only):**
```bash
cd streamer-app
npm start
```
✓ Electron window opens. Connect to server and select screen to stream.

**Terminal 3 - Web Client:**
```bash
cd web-client
npm start
```
✓ Opens `http://localhost:3000` in your browser. Friends can visit this URL.

---

## How It Works

### 1. **Signaling Server** (Port 4000)
   - Manages streamer registration
   - Helps viewers discover available streams
   - Relays WebRTC connection details (SDP, ICE candidates)
   - Written in: Node.js + Express + Socket.io

### 2. **Streamer App** (Electron)
   - Runs on your Windows machine
   - Captures screen/window content
   - Encodes with H.264 (NVENC-accelerated on your RTX 5090)
   - Streams via WebRTC P2P to connected viewers
   - Features:
     - Select from multiple capture sources (desktop, specific apps)
     - Real-time viewer count and stats
     - Low-latency streaming

### 3. **Web Client** (Browser)
   - Friends open `http://localhost:3000` (or your IP)
   - Connect to signaling server
   - Browse available streams
   - Watch in HTML5 video player
   - Displays stream quality metrics
   - Written in: Vanilla JavaScript + WebRTC

---

## Usage Flow

1. **Start all three components** (see "Running the Application")

2. **On Streamer App (Windows):**
   - Enter server URL: `ws://localhost:4000`
   - Enter streamer name (e.g., "Gaming Stream")
   - Click "Connect to Server"
   - Select what to stream (desktop, specific app game, etc.)
   - Click "Stream This"

3. **On Web Client (Browser):**
   - Enter server URL: `ws://localhost:4000`
   - Enter your name (e.g., "Friend 1")
   - Click "Connect to Server"
   - Wait for available streams to load
   - Click "Watch Stream" on any available stream
   - Watch in the video player!

---

## Accessing Remotely

To let friends from outside your network join:

1. **Find your IP address:**
   ```bash
   # Windows
   ipconfig /all  # Look for IPv4 Address
   
   # Linux/Mac
   ifconfig  # Look for inet address
   ```

2. **Share this URL with friends:**
   ```
   http://YOUR_IP:3000
   ```

3. **Update streamer connection (if needed):**
   If you want to run signaling server on a different machine:
   - Edit the server URL in both apps
   - Make sure port 4000 is open/forwarded

---

## Performance Tuning

### Quality Targets (Full HD 60fps)
- Resolution: 1920 × 1080
- Frame Rate: 60 FPS
- Bitrate: 8-15 Mbps (adjusts automatically)

### NVIDIA GPU Acceleration
Your RTX 5090 supports NVENC hardware encoding. Browser's WebRTC stack auto-selects available encoders.

### Recommended Network
- **Local Network**: 100+ Mbps
- **Remote (over internet)**: 10+ Mbps upload for streamer

---

## Configuration

Edit configuration in `shared/config.js`:

```javascript
video: {
  width: 1920,    // Resolution width
  height: 1080,   // Resolution height
  frameRate: 60,  // Target FPS
}
```

---

## Troubleshooting

### "Connection refused" / Server won't start
- Make sure port 4000 is not in use
- Check firewall settings
- Try: `netstat -ano | findstr :4000` (Windows)

### Screen capture not working
- Run Electron app as Administrator (Windows)
- Check Display Capture permissions
- Try refreshing capture sources

### Viewers can't see stream
- Check WebRTC connection in browser console
- Confirm all 3 components are running
- Try disabling firewall temporarily (test only)
- Check NAT/port forwarding if remote

### Poor video quality / lag
- Reduce resolution/FPS in config
- Check CPU/GPU usage (Task Manager)
- Ensure stable internet connection
- Move streamer/viewer closer to WiFi router

### Electron app won't start
- Run as Administrator
- Check Windows Defender isn't blocking it
- Try: `npm start -- --verbose` for debug output

---

## Architecture for Cloud Migration

Each component is designed to be independently operated:

### Cloud Deployment Option 1: Signaling Server
```
Streamer App (Windows, local) 
    ↓
    Signaling Server (AWS EC2 / DigitalOcean)
    ↑
Web Client (Browser, shared URL)
```

**Steps:**
1. Deploy `signaling-server` to VPS
2. Update URL in Streamer App and Web Client to point to remote server
3. No other changes needed!

### Cloud Deployment Option 2: Web Client
```
Streamer App (Windows, local)
    ↓
    Signaling Server (AWS EC2)
    ↑
Web Client (CloudFront / S3 static hosting)
```

**Steps:**
1. Deploy signaling server to cloud
2. Deploy `web-client/` to S3/CloudFront or similar
3. Configure CORS in signaling server
4. Share CloudFront URL with friends

---

## Development

### Adding Features

**Example: Add chat functionality**
1. Update signaling server to relay chat messages via Socket.io
2. Add chat UI to web-client
3. Trigger chat events from streamer-app

**Example: Add multiple streams**
1. Modify signaling server to support stream IDs
2. Update Streamer App to handle multiple streams
3. Update Web Client to display stream thumbnails

### Debugging

- **Signaling Server**: Check console output
- **Streamer App**: Open DevTools with `Ctrl+Shift+I`
- **Web Client**: Open browser DevTools with `F12`

---

## Performance Notes

### Why P2P?
- **Lower Latency**: Direct peer-to-peer (50-200ms vs 500ms+ for server relay)
- **Better Scalability**: Each viewer connects independently
- **Bandwidth Efficient**: Your uplink isn't bottleneck with multiple viewers

### WebRTC Quality
- Auto-adjusts bitrate based on network
- H.264 encoding (wide browser support)
- Adaptive frame rate and resolution

### Limits
- Small viewer count (2-5) recommended for low-power streamers
- Each peer connection consumes bandwidth
- Signaling server is lightweight

---

## Next Steps

- [ ] Run the setup script
- [ ] Start all components
- [ ] Test streaming to one viewer
- [ ] Share with friends!
- [ ] Consider cloud migration
- [ ] Add chat/additional features

---

## Support

For issues:
1. Check console output in each component
2. Review troubleshooting section
3. Check network connectivity
4. Try restarting all components

Happy streaming! 🎮
