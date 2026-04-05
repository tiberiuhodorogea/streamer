# Lumina Architecture

## Overview

Lumina currently consists of one streamer, one viewer surface, and one backend service:

```text
Lumina Streamer (Electron on Windows)
  -> WebSocket control plane to signaling-server
  -> mediasoup producer transport for audio/video

Lumina Viewer (browser)
  -> WebSocket control plane to signaling-server
  -> mediasoup consumer transport for playback

signaling-server (Node.js + Express + ws + mediasoup)
  -> room registry
  -> transport and producer/consumer lifecycle
  -> health endpoint and stream listing
  -> session logging
```

The important correction is that this is not a Socket.io or simple-peer stack anymore. The current code uses raw WebSocket messages over `ws` and mediasoup for media routing.

## Components

### signaling-server

Entry point: `signaling-server/src/index.js`

Responsibilities:

- creates the mediasoup worker and per-streamer routers
- exposes `GET /health`
- exposes `GET /lumina` for active streamer discovery
- accepts WebSocket clients on `/ws`
- tracks clients, rooms, viewers, transports, producers, and consumers
- polls server-side transport stats and forwards bandwidth-quality signals
- writes session logs under `logs/sessions/`

Core message types:

- `register-streamer`
- `create-producer-transport`
- `connect-producer-transport`
- `produce`
- `join-streamer`
- `create-consumer-transport`
- `connect-consumer-transport`
- `consume`
- `consumer-resume`
- `viewer-quality-report`

### lumina-app

Entry points:

- `lumina-app/src/main.cjs`
- `lumina-app/src/preload.cjs`
- `lumina-app/src/ui/index.html`
- `lumina-app/src/ui/app.js`

Responsibilities:

- starts the Electron window
- enumerates screen and window capture sources
- filters out its own app window from capture targets
- optionally loads the native addon from `lumina-app/native/`
- registers the stream with the backend
- creates producer transports and sends encoded media
- applies adaptive quality changes based on viewer and server telemetry
- writes local session events into the shared session directory

Notable implementation details:

- CommonJS entrypoints are the active ones; the old ESM duplicates were removed.
- Window capture is pushed toward Windows Graphics Capture through Chromium feature flags.
- Process-audio capture is optional and depends on the native module being available.

### web-client

Entry points:

- `web-client/index.html`
- `web-client/app.js`

Responsibilities:

- opens a raw WebSocket connection to the backend
- lists available streams
- joins one streamer at a time
- creates a mediasoup receive transport
- consumes audio/video tracks
- reports playback quality back to the backend
- exposes a small viewer UI for mute, fullscreen, playback, and stats

### shared

Entry point: `shared/config.js`

This file holds shared defaults for signaling host/port, video defaults, bitrate limits, and STUN servers.

## Runtime Flow

### 1. Streamer registration

1. Lumina Streamer connects to `ws://host:4000/ws`.
2. It sends `register-streamer` with a stream name.
3. The server creates a mediasoup router and stores a room keyed by the streamer client id.
4. The server notifies connected viewers that a streamer joined.

### 2. Producer setup

1. The streamer requests `create-producer-transport`.
2. The server returns ICE and DTLS parameters for a mediasoup WebRTC transport.
3. The streamer connects that transport and sends `produce` for audio and video.

### 3. Viewer join

1. The viewer loads the active stream list.
2. It sends `join-streamer` for a selected host.
3. The server attaches the viewer to the room and returns router RTP capabilities.
4. The viewer requests a consumer transport and then consumes the available producers.

### 4. Adaptive quality loop

1. The viewer gathers playback stats such as bitrate, FPS, jitter, loss, dropped-frame deltas, and decode or jitter-buffer delay.
2. The server polls mediasoup stats like RTT, NACK rate, score, delivery bitrate, and per-viewer bottleneck spread.
3. The streamer runs a single smoothness-first controller that aims for 1080p60 when healthy, degrades bitrate and resolution before frame rate, and weighs multi-viewer fairness before reacting to one weak viewer.

## Logging

Runtime artifacts are stored under `logs/`.

- `logs/sessions/`: per-run JSON and JSONL outputs from signaling and streamer processes
- `logs/baselines/`: analysis snapshots used for comparison work

The current retained comparison point is `logs/baselines/2026-04-05-active-baseline-summary.json`, sourced from session `2026-04-05T06-20-16-832Z-d08f5dd`.

Streaming changes are expected to preserve and extend telemetry. The current tuning workflow relies on raw JSONL events, session summaries, bottleneck-viewer transitions, encoder or source-stall events, and ABR decision logs to validate any change in adaptation behavior.

These logs are operational artifacts. They are useful during tuning but not part of the minimum code surface needed to understand or run the project.

## Current Naming Decisions

- “Lumina Streamer” is the Windows Electron app.
- “Lumina Viewer” is the browser client.
- `lumina-app/` and `web-client/` remain as directory names for now to avoid a larger workspace rename.

## Cleanup Notes

The following items were intentionally removed because they were redundant or stale:

- duplicate ESM entrypoints that were not used
- setup and start wrapper scripts that duplicated plain npm commands
- extra markdown files that repeated or contradicted the code
- the unused `serve-web.cjs` helper server
