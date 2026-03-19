@echo off
REM P2P Streaming - Quick Start All Components
REM Opens 3 separate terminal windows and starts all services

echo.
echo ╔════════════════════════════════════════════════════════╗
echo ║  P2P Streaming - Starting All Components               ║
echo ╚════════════════════════════════════════════════════════╝
echo.

REM Start Signaling Server in new window
echo Starting Signaling Server on ws://localhost:4000...
start "Signaling Server" cmd /k "cd signaling-server && npm start"
timeout /t 2 /nobreak

REM Start Streamer App in new window
echo Starting Electron Streamer App...
start "Streamer App" cmd /k "cd streamer-app && npm start"
timeout /t 2 /nobreak

REM Start Web Client in new window
echo Starting Web Client on http://localhost:3000...
start "Web Client" cmd /k "cd web-client && npm start"

echo.
echo ✓ All components started in separate windows!
echo All three windows should appear momentarily...
echo.
pause
