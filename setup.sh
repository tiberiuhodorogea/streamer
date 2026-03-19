#!/bin/bash
# P2P Streaming - Multi-Component Setup Script
# This script installs dependencies for all components

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║  P2P Streaming Application - Setup                     ║"
echo "║  Installing dependencies for all components             ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed or not in PATH"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

echo "✓ npm found: $(npm -v)"
echo ""

# Install root dependencies
echo "Installing root dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "❌ Failed to install root dependencies"
    exit 1
fi

echo "✓ Root dependencies installed"
echo ""

# Install workspace dependencies
echo "Installing workspace dependencies..."
npm install --workspaces
if [ $? -ne 0 ]; then
    echo "❌ Failed to install workspace dependencies"
    exit 1
fi

echo "✓ All dependencies installed successfully!"
echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║  Setup Complete!                                        ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "Next Steps:"
echo ""
echo "1. Open 3 Terminal Windows"
echo ""
echo "2. Terminal 1 - Start Signaling Server:"
echo "   cd signaling-server"
echo "   npm start"
echo ""
echo "3. Terminal 2 - Start Electron Streamer App:"
echo "   cd streamer-app"
echo "   npm start"
echo ""
echo "4. Terminal 3 - Start Web Viewer:"
echo "   cd web-client"
echo "   npm start"
echo "   Opens http://localhost:3000 in your browser"
echo ""
echo "Once all are running, friends can visit:"
echo "  http://localhost:3000"
echo "  (or http://YOUR_IP:3000 for remote access)"
echo ""
