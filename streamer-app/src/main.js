import { app, BrowserWindow, Menu, ipcMain, desktopCapturer } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow;
let streamerSocket = null;
const SHOULD_OPEN_DEVTOOLS = process.env.STREAMER_DEVTOOLS === '1';

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(join(__dirname, 'ui', 'index.html'));
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

// IPC Handler: Start capture stream
ipcMain.handle('start-capture', async (event, sourceId) => {
  try {
    const stream = await mainWindow.webContents.executeJavaScript(
      `navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: '${sourceId}'
          }
        }
      })`
    );
    return { success: true, streamId: stream.id };
  } catch (error) {
    console.error('Error starting capture:', error);
    return { success: false, error: error.message };
  }
});
