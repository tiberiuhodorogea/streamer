#!/bin/bash
# P2P Streaming - Quick Start All Components
# Opens terminals and starts all services

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║  P2P Streaming - Starting All Components               ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# Start Signaling Server
echo "Starting Signaling Server on ws://localhost:4000..."
gnome-terminal -- bash -c "cd signaling-server && npm start; bash" 2>/dev/null || \
xterm -e "cd signaling-server && npm start" 2>/dev/null || \
(cd signaling-server && npm start) &
SIGNAL_PID=$!
sleep 2

# Start Streamer App
echo "Starting Electron Streamer App..."
gnome-terminal -- bash -c "cd streamer-app && npm start; bash" 2>/dev/null || \
xterm -e "cd streamer-app && npm start" 2>/dev/null || \
(cd streamer-app && npm start) &
STREAMER_PID=$!
sleep 2

# Start Web Client
echo "Starting Web Client on http://localhost:3000..."
gnome-terminal -- bash -c "cd web-client && npm start; bash" 2>/dev/null || \
xterm -e "cd web-client && npm start" 2>/dev/null || \
(cd web-client && npm start) &
WEB_PID=$!

echo ""
echo "✓ All components started!"
echo ""
echo "Components running:"
echo "  • Signaling Server: ws://localhost:4000"
echo "  • Streamer App: Electron window"
echo "  • Web Client: http://localhost:3000"
echo ""
