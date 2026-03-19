const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');

let mainWindow;

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
  mainWindow.webContents.openDevTools();
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
      thumbnailSize: { width: 150, height: 150 }
    });

    return sources.map(source => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL()
    }));
  } catch (error) {
    console.error('Error getting capture sources:', error);
    return [];
  }
});


