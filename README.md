# P2P Streaming App

Low-latency peer-to-peer streaming stack for sharing games, apps, browser windows, or the entire desktop with friends.

## What It Does

- Windows streamer app built with Electron
- Browser-based viewer client for desktop and mobile
- WebRTC peer-to-peer video delivery
- Signaling server for discovery, offers, answers, and ICE relay
- Capture source selection:
	- entire screen
	- individual windows/apps
- Streaming quality profiles:
	- Smooth FPS
	- Balanced
	- High Quality
	- Ultra
- Real-time streamer stats:
	- viewer count
	- bitrate
	- FPS
- Viewer controls:
	- mute/unmute
	- fullscreen
	- native playback controls
- LAN viewing support and browser viewing from other devices
- Best-effort source audio capture with fallback to video-only when the source cannot provide audio

## Current Architecture

```
streamer/
├── signaling-server/    # Node.js signaling service
├── streamer-app/        # Electron streamer app (Windows)
├── web-client/          # Browser viewer
├── shared/              # Shared package/config
├── ARCHITECTURE.md
├── QUICKSTART.md
└── package.json
```

## How It Works

1. The streamer app connects to the signaling server and registers a stream.
2. A viewer opens the web client and discovers active streams.
3. The signaling server relays WebRTC offers, answers, and ICE candidates.
4. Video and optional source audio flow directly over WebRTC between streamer and viewer.

## Components

### `signaling-server`

- Node.js server
- HTTP endpoints for health and stream discovery
- Raw WebSocket signaling path used by the current app flow
- Listens on port `4000`

### `streamer-app`

- Electron desktop app for Windows
- Lets you:
	- connect to signaling
	- pick a streaming profile
	- choose whether to include source audio
	- select a capture source
	- stream to multiple viewers

### `web-client`

- Browser viewer
- Works on desktop and mobile browsers
- Lets a viewer:
	- connect to the signaling server
	- choose a live stream
	- watch video in fullscreen
	- mute/unmute locally

## Requirements

- Node.js 18+
- Windows for the Electron streamer app
- A modern Chromium-based browser is recommended for viewers

## Install

From the project root:

```bash
npm install
```

If needed, install workspace dependencies explicitly:

```bash
npm install --workspaces
```

## Run

### Terminal 1: signaling server

```bash
npm run start:signaling
```

### Terminal 2: streamer app

```bash
npm run start:streamer
```

### Terminal 3: viewer web app

```bash
npm run start:web
```

Open:

- local viewer: `http://localhost:3000`
- phone/LAN viewer: `http://YOUR_LAN_IP:3000`

Use signaling URLs:

- local: `ws://localhost:4000`
- LAN/mobile: `ws://YOUR_LAN_IP:4000`

## Typical Usage

### Streamer

1. Launch the signaling server.
2. Launch the Electron streamer app.
3. Enter the signaling URL.
4. Enter a stream name.
5. Pick a streaming profile.
6. Enable or disable source audio.
7. Connect.
8. Select a source and start streaming.

### Viewer

1. Open the web client.
2. Enter the signaling URL.
3. Connect.
4. Choose a stream.
5. Use fullscreen or mute if needed.

## Streaming Profiles

The streamer app includes four presets.

- `Smooth FPS`
	- prioritizes responsiveness and lower decode cost
- `Balanced`
	- default profile for general use
- `High Quality`
	- pushes quality harder on strong links
- `Ultra`
	- highest quality target for excellent hardware/network conditions

## Audio Notes

- Source audio is best-effort.
- Some sources can provide audio cleanly.
- Some window capture paths may expose video but not audio.
- When source audio is unavailable, the app falls back to video-only.
- To avoid feedback loops, keep local viewers muted if they are playing the same stream near the source machine.

## Remote Access

For internet access beyond LAN, you will typically need:

- a publicly reachable signaling server
- firewall rules for port `4000`
- static hosting or forwarding for the viewer app on port `3000`
- NAT traversal considerations for WebRTC peers

The current build is good for local and controlled remote testing, but production-grade internet delivery will still need harder NAT and reliability work.

## Known Limitations

- A/V sync under long-running load may still need more adaptive latency work
- Source audio availability depends on the capture target and platform/browser behavior
- Individual app/window capture support varies by Windows and Chromium capture capabilities
- Electron may log GPU warnings that do not always indicate functional failure

## Scripts

Top-level scripts:

```bash
npm run start:signaling
npm run start:streamer
npm run start:web
```

## Additional Docs

- `ARCHITECTURE.md`
- `QUICKSTART.md`
- `TECH-STACK.md`
- `INDEX.md`

## License

MIT
