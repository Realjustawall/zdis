const { app, BrowserWindow, session } = require('electron');
const { serverUrl, serverId } = require('./server.json');
const origin = new URL(serverUrl);
if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('An HTTPS server URL is required.');
app.setName(`ZDis-${serverId}`);
app.setPath('userData', require('node:path').join(app.getPath('appData'), `ZDis-${serverId}`));
app.whenReady().then(() => {
  const trusted = value => { try { return new URL(value).origin === origin.origin; } catch { return false; } };
  const allowed = new Set(['media', 'notifications', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(trusted(details.requestingUrl || contents.getURL()) && allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => trusted(requestingOrigin) && allowed.has(permission));
  const window = new BrowserWindow({ width: 1280, height: 820, minWidth: 420, minHeight: 600,
    backgroundColor: '#1e1f22', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  void window.loadURL(origin.href);
});
app.on('window-all-closed', () => app.quit());
