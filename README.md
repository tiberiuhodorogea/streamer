# Lumina

Lumina is a low-latency desktop streaming stack made of three runnable pieces:

- a Windows Electron streamer app
- a browser viewer
- a Node.js signaling and SFU service

The current implementation is not pure peer-to-peer. The server uses mediasoup, so signaling and media routing both live in the backend while viewers receive media through consumer transports.

## What Stays In This Repo

- `signaling-server/`: WebSocket signaling, mediasoup worker, room state, session logs
- `lumina-app/`: Windows streamer UI, capture source selection, media production, optional native helpers
- `web-client/`: Browser viewer UI and mediasoup consumer logic
- `shared/`: shared runtime configuration
- `ARCHITECTURE.md`: implementation-focused system notes

The older duplicate docs, helper wrappers, and unused legacy entrypoints were removed to keep the repo surface smaller and more accurate.

## Requirements

- Node.js 18+
- Windows for the streamer app
- A modern browser for the viewer

## Install

From the repository root:

```bash
npm install
```

## Run

Use three terminals from the repository root:

```bash
npm run start:signaling
npm run start:streamer
npm run start:viewer
```

Viewer URL:

- local: `http://localhost:3000`
- LAN: `http://YOUR_LAN_IP:3000`

Signaling URL:

- local: `ws://localhost:4000`
- LAN: `ws://YOUR_LAN_IP:4000`

## Basic Flow

1. Start the signaling service.
2. Start Lumina Streamer on Windows.
3. Connect the streamer to the signaling URL and start a source.
4. Open Lumina Viewer in a browser.
5. Connect to the same signaling URL and join the live stream.

## Repository Layout

```text
.
├─ signaling-server/
│  └─ src/index.js
├─ lumina-app/
│  ├─ src/main.cjs
│  ├─ src/preload.cjs
│  ├─ src/ui/
│  └─ native/
├─ web-client/
│  ├─ index.html
│  └─ app.js
├─ shared/
│  └─ config.js
├─ ARCHITECTURE.md
└─ package.json
```

## Notes

- The streamer supports screen and window capture, with optional process-audio support through the native addon.
- The viewer and streamer both use a bundled `mediasoup-client` browser build.
- Session logs are written under `logs/sessions/`.
- The active comparison baseline lives in `logs/baselines/2026-04-05-active-baseline-summary.json` and is sourced from the retained session `2026-04-05T06-20-16-832Z-d08f5dd`.

## License

MIT
