import { app, ipcMain, nativeImage, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { detectPacks } from '../core/search';
import { DRAG_ICON } from './drag-icon';
import { findLicense, readPackDetails } from './packs';
import { requestPlan, parsePlanRequest } from '../core/plan';
import { requestPhrase, parsePhraseFacts } from '../core/phrase';
import type { Store } from './store';

const blockedReason = '파일이나 드라이브에 접근할 수 없습니다. 연결을 확인해 주세요.';
const ICON_LIMIT = 128 * 1024;
const ICON_SIDE = 128;

/** A picture from the screen is only ever a small PNG; anything else gets the plain badge. */
function dragIcon(value: unknown) {
  const icon = typeof value === 'string' && value.startsWith('data:image/png;base64,') && value.length <= ICON_LIMIT * 4 / 3
    ? nativeImage.createFromDataURL(value) : undefined;
  const { width = 0, height = 0 } = icon?.getSize() ?? {};
  return icon && !icon.isEmpty() && width <= ICON_SIDE && height <= ICON_SIDE ? icon : nativeImage.createFromDataURL(DRAG_ICON);
}

export function registerAudio(window: BrowserWindow, store: Store): void {
  const directory = path.join(app.getPath('userData'), 'wav-copies');
  const itemFor = (id: unknown) => {
    const item = store.loadItems().data.find((item) => item.id === id);
    if (!item) throw new Error('목록에서 소리를 찾을 수 없습니다.');
    return item;
  };
  const sourceFor = async (id: unknown) => {
    const item = itemFor(id);
    for (const entry of item.paths) {
      try { await fs.access(entry.folderId); await fs.access(entry.path); return { item, source: entry.path }; }
      catch { /* A duplicate may still be readable on another drive. */ }
    }
    throw new Error(blockedReason);
  };
  /** New copies keep the sound's name, which becomes the DAW region name; hash-named ones stay valid. */
  const copyFor = (id: unknown) => {
    const item = itemFor(id);
    return path.join(directory, item.fullSha256, `${path.parse(item.paths[0].path).name}.wav`);
  };
  const readyCopy = async (id: unknown) => {
    for (const file of [copyFor(id), path.join(directory, `${itemFor(id).fullSha256}.wav`)]) {
      try { await fs.access(file); return file; } catch { /* Try the older name. */ }
    }
    return undefined;
  };
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== window.webContents) throw new Error('허용되지 않은 요청입니다.');
      return fn(...args);
    });
  const detect = () => {
    const items = store.loadItems().data;
    return detectPacks(store.loadFolders().data.map((folder) => ({
      root: folder.root,
      files: items.flatMap((item) => item.paths.filter((p) => p.folderId === folder.root)
        .map((p) => path.relative(folder.root, p.path))),
    })));
  };
  const packFolders = () => new Map(detect().map((pack) => [pack.packId, pack.root]));
  handle('audio:sounds', async () => {
    const items = store.loadItems().data;
    const online = new Set<string>();
    for (const folder of store.loadFolders().data) {
      try { await fs.access(folder.root); online.add(folder.root); } catch { /* Reported per sound below. */ }
    }
    const packFor = new Map(detect().map((pack) => [`${pack.root}\0${pack.relativePath}`, pack]));
    return items.flatMap((item) => item.paths.map((entry) => {
      const relativePath = path.relative(entry.folderId, entry.path);
      const pack = packFor.get(`${entry.folderId}\0${relativePath}`)!;
      return {
        id: item.id, root: entry.folderId, relativePath, fullHash: item.fullSha256, duration: item.duration ?? 0,
        embedding: store.getEmbedding(item.id),
        ...(item.paths.some((path) => online.has(path.folderId)) ? {} : { blockedReason }),
        packId: pack.packId, packName: pack.packName,
        ...(item.peaks?.length ? { peaks: item.peaks.map((peak) => peak / 100) } : {}),
        addedAt: item.addedAt ?? item.mtimeMs ?? 0,
      };
    }));
  });
  handle('packs:load', () => Promise.all([...packFolders()].map(([id, root]) => readPackDetails(root, id))));
  handle('packs:reveal-license', async (id) => {
    const root = packFolders().get(id);
    const file = root && await findLicense(root, id);
    if (!file) throw new Error('라이선스 파일을 찾을 수 없습니다.');
    if (process.env.PROTO1_TEST_DRAG === '1') {
      await fs.appendFile(path.join(app.getPath('userData'), 'drag-test.jsonl'), `${JSON.stringify({ reveal: file })}\n`);
      return;
    }
    shell.showItemInFolder(file);
  });
  // Maps a dropped file back to its sound: any remembered path, or the WAV copy made for dragging.
  handle('audio:id-for-path', (file: unknown) => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('파일의 절대 경로가 필요합니다.');
    const target = path.resolve(file);
    const items = store.loadItems().data;
    const stored = items.find((item) => item.paths.some((entry) => path.resolve(entry.path) === target));
    if (stored) return stored.id;
    const named = path.dirname(path.dirname(target)) === directory ? path.basename(path.dirname(target)) : undefined;
    const hash = named ?? (path.dirname(target) === directory ? path.basename(target, '.wav') : undefined);
    return hash && /^[a-f0-9]{64}$/.test(hash) ? items.find((item) => item.fullSha256 === hash)?.id ?? null : null;
  });
  // A file outside the library is the library sound with the same whole-file hash (PRD 7.3).
  handle('audio:id-for-hash', (hash: unknown) => {
    if (typeof hash !== 'string') throw new Error('파일 전체 SHA-256이 필요합니다.');
    return store.loadItems().data.find((item) => item.fullSha256 === hash)?.id ?? null;
  });
  handle('audio:read', async (id) => fs.readFile((await sourceFor(id)).source));
  handle('audio:plan', (request) => requestPlan(
    new URL('/plan', app.isPackaged
      ? require(path.join(app.getAppPath(), 'package.json')).fetchRelayUrl
      : process.env.PROTO1_RELAY_URL || 'http://127.0.0.1:8787').href,
    parsePlanRequest(request)));
  handle('audio:phrase', (facts: unknown) => requestPhrase(
    new URL('/phrase', app.isPackaged
      ? require(path.join(app.getAppPath(), 'package.json')).fetchRelayUrl
      : process.env.PROTO1_RELAY_URL || 'http://127.0.0.1:8787').href,
    parsePhraseFacts(facts)));
  handle('audio:copy-ready', async (id) => {
    const { source } = await sourceFor(id);
    if (path.extname(source).toLowerCase() === '.wav') return true;
    return Boolean(await readyCopy(id));
  });
  handle('audio:save-copy', async (id, bytes: Uint8Array) => {
    await sourceFor(id);
    const data = Buffer.from(bytes);
    if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE' ||
        data.readUInt16LE(20) !== 1 || data.readUInt16LE(34) !== 16) {
      throw new Error('16비트 PCM WAV 사본이 필요합니다.');
    }
    await fs.mkdir(path.dirname(copyFor(id)), { recursive: true });
    try { await fs.writeFile(copyFor(id), data, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  });
  handle('audio:reveal', async (id) => shell.showItemInFolder((await sourceFor(id)).source));
  handle('audio:drag', async (id, picture) => {
    const { source } = await sourceFor(id);
    const file = path.extname(source).toLowerCase() === '.wav' ? source : await readyCopy(id);
    if (!file) throw new Error('WAV 사본이 아직 준비되지 않았습니다. 소리에 커서를 올려 준비해 주세요.');
    const icon = dragIcon(picture);
    // A real OS drag would take over the tester's screen, so automated runs only record what it would carry.
    if (process.env.PROTO1_TEST_DRAG === '1') {
      await fs.appendFile(path.join(app.getPath('userData'), 'drag-test.jsonl'), `${JSON.stringify({ id, file, icon: { ...icon.getSize(), png: icon.toDataURL() } })}\n`);
      return;
    }
    window.webContents.startDrag({ file, icon });
  });
}
