# 📚 Documentation Index

## Quick Start (Start Here!)
- **[QUICKSTART.md](./QUICKSTART.md)** - Setup instructions, running all components, basic usage

## Understanding the System
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - System design, component details, communication flow, cloud migration
- **[TECH-STACK.md](./TECH-STACK.md)** - Library choices, dependencies, API details

## Running the Project

### Automated Setup
```bash
# Windows
./setup.bat          # Install all dependencies
./start-all.bat      # Start all 3 components

# Linux/Mac
chmod +x setup.sh && ./setup.sh
chmod +x start-all.sh && ./start-all.sh
```

### Manual Setup
```bash
# Install dependencies
npm install
npm install --workspaces

# Terminal 1: Signaling Server (ws://localhost:4000)
cd signaling-server && npm start

# Terminal 2: Streamer App (Electron, Windows only)
cd streamer-app && npm start

# Terminal 3: Web Viewer (http://localhost:3000)
cd web-client && npm start
```

---

## Project Structure

```
.
├─ signaling-server/      WebRTC signaling + connection management (Node.js)
│  ├─ src/index.js        Main server
│  └─ package.json
│
├─ streamer-app/          Desktop streamer app (Electron)
│  ├─ src/main.js         Electron main process
│  ├─ src/preload.js      Security layer
│  ├─ src/ui/
│  │  ├─ index.html       UI markup
│  │  ├─ app.js           WebRTC + Socket.io logic
│  │  └─ style.css        Styling
│  └─ package.json
│
├─ web-client/            Browser-based viewer (Vanilla JS)
│  ├─ index.html          UI markup
│  ├─ app.js              WebRTC + Socket.io logic
│  ├─ style.css           Styling
│  └─ package.json
│
├─ shared/                Shared config and utilities
│  ├─ config.js           Server URLs, video quality settings
│  └─ package.json
│
├─ README.md              Project overview
├─ QUICKSTART.md          Getting started guide (READ THIS FIRST!)
├─ ARCHITECTURE.md        Deep dive into system design
├─ TECH-STACK.md          Technology choices and dependencies
├─ package.json           Root package.json (npm workspaces)
├─ setup.bat / setup.sh   Installation script
├─ start-all.bat / .sh    Start all components
└─ .gitignore             Git ignore rules
```

---

## Common Workflows

### I want to modify the video quality
1. Edit `shared/config.js`
2. Adjust `video.width`, `video.height`, `video.frameRate`
3. Restart streamer app

### I want to stream to friends on the internet
1. Deploy `signaling-server` to AWS EC2 / DigitalOcean / Heroku
2. Update server URL in both `streamer-app` and `web-client`
3. Give friends the web client URL
4. See [ARCHITECTURE.md](./ARCHITECTURE.md) → Cloud Migration Paths

### I want to add authentication
1. Modify `signaling-server/src/index.js`
2. Add JWT validation on `register-streamer` and `join-streamer` events
3. Generate tokens in your auth service
4. Pass token in connection query: `io(url, { query: { token: '...' } })`

### I want to add chat
1. Add new Socket.io event: `socket.on('chat-message', ...)`
2. Relay to other connected sockets
3. Add chat UI to `web-client/index.html`
4. Handle incoming chat in `web-client/app.js`

### I want to record streams
1. Use Electron's `desktopCapturer` with WritableStream
2. Pipe to FFmpeg or MediaRecorder
3. Save to disk or upload to cloud storage

---

## Commonly Asked Questions

### Q: Why P2P instead of server relay?
**A**: 
- Lower latency (direct connection, 50-200ms vs 500ms+)
- Better for 2-5 viewers (each connects independently)
- Scales with your uplink without server load

### Q: Can my friends watch without installing anything?
**A**: Yes! They just open `http://localhost:3000` in any modern browser (Chrome, Firefox, Safari, Edge).

### Q: Does it work on mobile?
**A**: Yes! Web viewers work on mobile browsers. Streamer (Electron) is Windows-only for this POC.

### Q: How do I increase video quality?
**A**: Edit `shared/config.js` - increase `bitrate` and `frameRate`. Your RTX 5090 can easily handle 1080p@60fps with NVENC.

### Q: What if I get "Connection refused"?
**A**: Make sure the signaling server started: `cd signaling-server && npm start` in a separate terminal.

### Q: How do I run this on my network?
**A**: 
1. Find your local IP: `ipconfig /all` (Windows) or `ifconfig` (Linux/Mac)
2. Share with friends: `http://YOUR_IP:3000`
3. Update streamer to connect to `ws://YOUR_IP:4000`

### Q: Can I use this at LAN parties / on my home network?
**A**: Absolutely! That's the use case this is optimized for. Local network gives you best latency (<20ms).

---

## Troubleshooting

### "Connection refused" error
**Cause**: Signaling server not running
**Fix**: Start it: `cd signaling-server && npm start`

### "ERR_MODULE_NOT_FOUND" error
**Cause**: Dependencies not installed
**Fix**: Run `npm install --workspaces`

### Black screen on web viewer
**Cause**: WebRTC connection not established
**Check**:
- Streamer app is connected and streaming
- Browser developer console (F12) for errors
- Network tab to see if WebSocket connects

### Streams not appearing in viewer
**Cause**: Streamer hasn't connected yet
**Fix**: Make sure streamer app says "Connected" (green badge)

### Viewers can't join from different WiFi
**Cause**: NAT/Firewall blocking P2P connections
**Fix**: See cloud migration guide to use cloud signaling server

### Video choppy / buffering
**Causes**: 
- Weak WiFi signal (use 5GHz or wired)
- Other network activity (pause uploads/downloads)
- CPU overloaded (check Task Manager)
**Fix**: Reduce video quality or close other apps

---

## Development Tips

### Enable debug logging
```bash
# Terminal
DEBUG=* npm start  # Shows all Socket.io events

# Browser console (F12)
// Shows all events sent/received
```

### Monitor network traffic
- Open browser DevTools (F12) → Network tab
- See what data is being sent/received
- Check WebRTC stats in the app

### Test with multiple viewers
- Open multiple browser windows
- Connect same viewer name to same streamer
- Watch latency/quality with multiple (5) connections

### Profile performance
- Electron: Built-in DevTools (Ctrl+Shift+I)
- Browser: DevTools Performance tab
- Node.js: Use `node --prof` and analyze

---

## Performance Expectations

### Your Hardware (RTX 5090)
- **Encoding**: 1080p@60fps with NVENC = <5% CPU, <20% GPU
- **Viewers**: Can support 10+ simultaneous with this GPU
- **Bottleneck**: Your uplink (depends on ISP)

### Typical Network (100 Mbps LAN)
- 1-2 viewers @ full quality: No problem
- 3-5 viewers @ full quality: Easy
- 10+ viewers: May need bitrate reduction

### Cloud Deployment
- Signaling server: Can handle 1000s of connections (stateless)
- Bandwidth: 10+ Mbps upload recommended for multiple viewers

---

## File Reference

### Config Files
- `.env.example` - Environment variables template
- `shared/config.js` - Application configuration

### Entry Points
- `signaling-server/src/index.js` - Start server here
- `streamer-app/src/main.js` - Start app here
- `web-client/index.html` - Open in browser

### UI Files
- `streamer-app/src/ui/` - Electron UI components
- `web-client/` - Web viewer UI

---

## Next Steps

1. **First time?** → Read [QUICKSTART.md](./QUICKSTART.md)
2. **Want to understand system?** → Read [ARCHITECTURE.md](./ARCHITECTURE.md)
3. **Curious about code?** → Read [TECH-STACK.md](./TECH-STACK.md)
4. **Ready to run?** → Execute `./setup.bat` then `./start-all.bat`
5. **Deploy?** → Follow cloud migration in [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## License & Credits

**MIT License** - Use freely for any purpose

Built with:
- **WebRTC** - Peer-to-peer streaming standard
- **Electron** - Desktop applications
- **Node.js** - Server runtime
- **Socket.io** - Real-time communication

---

**Questions?** Check troubleshooting section above, or search the code!

Good luck with your streaming setup! 🚀 DM me if you hit issues!
