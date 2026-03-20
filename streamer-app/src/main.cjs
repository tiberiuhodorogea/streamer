const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const { execFileSync } = require('child_process');
const path = require('path');

let mainWindow;
const APP_CAPTURE_NAMES = new Set(['Streamer Studio', 'P2P Stream - Streamer']);
const SHOULD_OPEN_DEVTOOLS = process.env.STREAMER_DEVTOOLS === '1';

// ========== NATIVE ADDON (optional) ==========
let nativeCapture = null;
try {
  nativeCapture = require(path.join(__dirname, '..', 'native'));
  console.log('[NATIVE] Game capture addon loaded — WGC capture available');
} catch (_) {
  console.log('[NATIVE] Native addon not available — using PowerShell game detection + optimised screen capture');
}

// ========== GAME DETECTION ==========
// Processes that load d3d11/d3d12/vulkan but are NOT games
const WELL_KNOWN_NON_GAMES = [
  'chrome', 'msedge', 'firefox', 'opera', 'brave',
  'electron', 'code', 'explorer',
  'slack', 'discord', 'teams', 'spotify', 'zoom',
  'snippingtool', 'obs64', 'obs32', 'sharex',
  'nvidia overlay', 'nvidia share', 'nvidia app', 'nvcontainer', 'overlay',
  'steamwebhelper', 'gamebar', 'gamemode', 'radeonsoftware',
  'devenv', 'winstore.app', 'mspaint', 'notepad',
  'powershell', 'pwsh', 'cmd', 'conhost', 'windowsterminal', 'wt',
  'dwm', 'csrss', 'svchost', 'taskhostw', 'searchhost',
  'applicationframehost', 'shellexperiencehost', 'lockapp',
  'textinputhost', 'systemsettings', 'startmenuexperiencehost',
  'runtimebroker', 'sihost', 'widgets', 'phonelinkserver',
];

/**
 * Detects windows belonging to game processes by checking loaded DirectX/Vulkan modules.
 * Returns Map<hwndString, processName>.
 */
function detectGameHwnds() {
  // If native addon is available, use it (faster, no PowerShell startup)
  if (nativeCapture && typeof nativeCapture.enumGameWindows === 'function') {
    try {
      const results = nativeCapture.enumGameWindows();
      const map = new Map();
      for (const item of results) {
        if (!item || item.hwnd == null) continue;
        // Apply JS-level exclusion list (catches anything the native list missed)
        const nameLower = (item.name || '').toLowerCase().replace(/\.exe$/i, '');
        if (WELL_KNOWN_NON_GAMES.includes(nameLower)) continue;
        map.set(String(item.hwnd), item.name);
      }
      return map;
    } catch (e) {
      console.warn('[NATIVE] enumGameWindows failed, falling back to PowerShell:', e.message);
    }
  }

  // Fallback: PowerShell detection
  try {
    const skipList = WELL_KNOWN_NON_GAMES.map(n => "'" + n + "'").join(',');
    const script = [
      '$skip=@(' + skipList + ')',
      '$r=@()',
      'Get-Process|?{$_.MainWindowHandle -ne [IntPtr]::Zero}|%{',
      '  if($skip -contains $_.ProcessName.ToLower()){return}',
      '  try{foreach($m in $_.Modules){',
      '    if($m.ModuleName -match "^(d3d1[12]|vulkan-1)\\.dll$"){',
      '      $r+=@{h=$_.MainWindowHandle.ToInt64();n=$_.ProcessName}',
      '      break',
      '    }',
      '  }}catch{}',
      '}',
      'if($r.Count -eq 0){"[]"}else{$r|ConvertTo-Json -Compress}',
    ].join('\n');

    const output = execFileSync('powershell.exe',
      ['-NoProfile', '-NoLogo', '-Command', script],
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    );

    const trimmed = (output || '').trim();
    if (!trimmed || trimmed === '[]') return new Map();
    const data = JSON.parse(trimmed);
    const arr = Array.isArray(data) ? data : [data];
    const map = new Map();
    for (const item of arr) {
      if (item && item.h != null) map.set(String(item.h), item.n);
    }
    return map;
  } catch (err) {
    console.error('[GAME-DETECT] PowerShell error:', err.message);
    return new Map();
  }
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      sandbox: false // Disable sandbox to allow screen capture
    }
  });

  mainWindow.setContentProtection(true);

  // Auto-approve screen capture requests
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'display-capture' || permission === 'media') {
      console.log(`[PERMISSION] Approving ${permission} request`);
      callback(true);
    } else {
      callback(false);
    }
  });

  const htmlPath = path.join(__dirname, 'ui', 'index.html');
  mainWindow.loadFile(htmlPath);
  if (SHOULD_OPEN_DEVTOOLS) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
};

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handler: Get available screens and windows for capture
ipcMain.handle('get-capture-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });

    // Detect game windows
    let gameHwnds = new Map();
    try {
      gameHwnds = detectGameHwnds();
      if (gameHwnds.size > 0) {
        console.log('[GAME-DETECT] Found ' + gameHwnds.size + ' game window(s): ' +
          [...gameHwnds.values()].join(', '));
      }
    } catch (e) {
      console.warn('[GAME-DETECT] Detection skipped:', e.message);
    }

    return sources
      .filter(source => !APP_CAPTURE_NAMES.has(source.name))
      .map(source => {
        const hwndMatch = source.id.match(/^window:(\d+):/);
        const hwnd = hwndMatch ? hwndMatch[1] : null;
        const gameProcess = hwnd ? (gameHwnds.get(hwnd) || null) : null;

        return {
          id: source.id,
          name: source.name,
          kind: source.id.startsWith('window:') ? 'window' : 'screen',
          thumbnail: source.thumbnail.toDataURL(),
          isGame: !!gameProcess,
          gameProcess,
        };
      });
  } catch (error) {
    console.error('Error getting capture sources:', error);
    return [];
  }
});

// IPC Handler: Check if native game capture is available
ipcMain.handle('native-capture-available', () => {
  return !!(nativeCapture && typeof nativeCapture.startCapture === 'function');
});

// IPC Handler: Start native game capture
ipcMain.handle('start-native-capture', async (_event, { hwnd, width, height, fps }) => {
  if (!nativeCapture || typeof nativeCapture.startCapture !== 'function') {
    return { success: false, reason: 'not-available' };
  }
  try {
    nativeCapture.startCapture(parseInt(hwnd), width, height, fps || 60);
    console.log('[NATIVE] Capture started for HWND ' + hwnd + ' (' + width + 'x' + height + '@' + (fps || 60) + ')');
    return { success: true };
  } catch (err) {
    console.error('[NATIVE] Start failed:', err.message);
    return { success: false, reason: err.message };
  }
});

// IPC Handler: Stop native game capture
ipcMain.handle('stop-native-capture', async () => {
  if (!nativeCapture) return { success: false };
  try {
    if (typeof nativeCapture.stopCapture === 'function') nativeCapture.stopCapture();
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
});

ipcMain.handle('prepare-for-capture', async () => {
  if (!mainWindow) return { success: false, reason: 'no-window' };

  mainWindow.minimize();
  return { success: true };
});

ipcMain.handle('restore-after-capture', async () => {
  if (!mainWindow) return { success: false, reason: 'no-window' };

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  return { success: true };
});


