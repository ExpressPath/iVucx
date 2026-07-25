const { app, BrowserWindow, Menu, session, shell } = require('electron');
const path = require('node:path');

const PRODUCTION_URL = 'https://ivucx.vercel.app/Vucks.html';
const requestedUrl = String(process.env.IVUCX_DESKTOP_URL || PRODUCTION_URL).trim();

function isAllowedDesktopUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'ivucx.vercel.app') return true;
    return process.env.IVUCX_ALLOW_LOCAL === 'true'
      && ['http:', 'https:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

if (!isAllowedDesktopUrl(requestedUrl)) {
  throw new Error('IVUCX_DESKTOP_URL must be the production iVucx URL, or an explicitly enabled local URL.');
}

function isTrustedNavigation(value) {
  try {
    const url = new URL(value);
    if (isAllowedDesktopUrl(url.href)) return true;
    return url.protocol === 'https:' && [
      'accounts.google.com',
      'myaccount.google.com',
      'accounts.youtube.com',
      'checkout.stripe.com',
      'billing.stripe.com',
      'link.com'
    ].includes(url.hostname);
  } catch {
    return false;
  }
}

function openSafeExternalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    void shell.openExternal(url.href).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true
    }
  });

  window.once('ready-to-show', () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    openSafeExternalUrl(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedNavigation(url)) return;
    event.preventDefault();
    openSafeExternalUrl(url);
  });

  window.loadURL(requestedUrl);
  return window;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
