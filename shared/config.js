/**
 * Shared Configuration
 * This module contains configuration that can be used across all components
 */

export const config = {
  // Server
  signaling: {
    host: process.env.SIGNALING_HOST || 'localhost',
    port: process.env.SIGNALING_PORT || 4000,
    getUrl: function() {
      return `ws://${this.host}:${this.port}`;
    },
    getHttpUrl: function() {
      return `http://${this.host}:${this.port}`;
    }
  },

  // Video Quality
  video: {
    width: 1920,
    height: 1080,
    frameRate: 60,
    // Hardware encoding: requires NVIDIA GPU with NVENC
    // Fallback: Browser will use H.264 via WebRTC
  },

  // Performance
  maxViewersPerHost: 10,
  maxBitrate: 15000000, // 15 Mbps
  minBitrate: 2000000,  // 2 Mbps

  // WebRTC
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
    { urls: ['stun:stun2.l.google.com:19302'] },
  ]
};

export default config;
