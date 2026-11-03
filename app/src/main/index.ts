import { app, BrowserWindow, ipcMain, net, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerLibrary } from './library';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const hidden = process.env.PROTO1_HIDDEN === '1';
if (hidden) app.dock?.hide();

app.whenReady().then(async () => {
  const rendererRoot = path.resolve(__dirname, '../../renderer');
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const file = path.resolve(rendererRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (url.host !== 'bundle' || !file.startsWith(`${rendererRoot}${path.sep}`)) {
      return new Response(null, { status: 403 });
    }
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    return new Response(response.body, { status: response.status, headers });
  });

  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 480,
    minHeight: 480,
    show: false,
    backgroundColor: '#111214',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 15 } } : {}),
    title: 'fetch',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (!hidden) window.once('ready-to-show', () => window.show());
  const library = registerLibrary(window);
  const metadata = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
  const searchLog = app.isPackaged && !hidden
    ? metadata.fetchSearchLog === true : process.env.PROTO1_SEARCH_LOG === '1';
  ipcMain.on('search:log', (event, entry: Record<string, unknown>) => {
    if (!searchLog || event.sender !== window.webContents) return;
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'search-log.jsonl'), `${JSON.stringify(entry)}\n`);
    } catch (error) {
      console.warn('찾기 기록을 저장하지 못했습니다.', error instanceof Error ? error.message : String(error));
    }
  });
  app.on('before-quit', () => library.close());
  window.on('closed', () => { library.close(); app.quit(); });
  await window.loadURL(process.env.PROTO1_DEV_URL || 'app://bundle/');
  library.resume();
});

app.on('window-all-closed', () => app.quit());
