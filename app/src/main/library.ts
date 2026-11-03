import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CollectionData } from '../core/collections';
import { describeDecision, updateTracking, type FileItem } from '../core/files';
import { DownloadTracker } from '../model/download';
import type { FileTrackingView, LibraryConnection } from '../platform/types';
import { IndexingQueue } from './indexing';
import { IndexingWindow } from './indexing-window';
import { scanLibrary } from './scan';
import { Store, type StoreItem } from './store';
import { registerAudio } from './audio';
import { registerClassify } from './classify';

export function registerLibrary(window: BrowserWindow): { resume(): void; close(): void } {
  const store = new Store(app.getPath('userData'));
  registerAudio(window, store);
  registerClassify(window, store);
  const scanning = new Set<string>();
  const scanTokens = new Map<string, object>();
  const scanErrors = new Map<string, string>();
  const unreadable = new Map<string, number>();
  const approvedFolders = new Set<string>();
  let closed = false;
  const folders = (): LibraryConnection[] => {
    const items = store.loadItems().data;
    const progress = queue.progress();
    return store.loadFolders().data.map((folder) => {
      const entries = items.flatMap((item) => item.paths
        .filter((entry) => entry.folderId === folder.root).map((entry) => ({ item, path: entry.path })));
      const completed = entries.filter(({ item }) => store.getEmbedding(item.id)).length;
      const failed = entries.filter(({ item }) => item.embeddingError && !store.getEmbedding(item.id)).length;
      const skipped = entries.filter(({ item }) => (item.size ?? 0) > 100_000_000).length;
      const pending = entries.length - completed - failed - skipped;
      const reason = scanErrors.get(folder.root) ?? (pending ? progress.reason : undefined);
      return {
        ...folder, fileCount: entries.length, current: queue.currentFolder === folder.root,
        completed, failed, skipped, reason, offline: scanErrors.has(folder.root),
        failure: scanErrors.has(folder.root) ? 'folder' : pending ? progress.failure : undefined,
        download: pending ? downloads.state : undefined,
        unreadable: unreadable.get(folder.root),
        status: scanning.has(folder.root) ? 'scanning' : reason ? 'stopped' : pending ? 'indexing' : 'completed',
      };
    });
  };
  const tracking = (): FileTrackingView => {
    const { moved, missing, changed } = store.loadTracking().data;
    const decisions = store.loadDecisions().data;
    const open = changed.filter((entry) =>
      decisions[entry.fromSha256] !== undefined && decisions[entry.toSha256] === undefined);
    const asked = new Set(open.map((entry) => entry.fromSha256));
    return {
      moved: moved.map(({ from, to }) => ({ from, to })),
      duplicates: store.loadItems().data.filter((item) => item.paths.length > 1)
        .map((item) => item.paths.map((entry) => entry.path)),
      missing: missing.filter((record) => !asked.has(record.fullSha256)).map((record) => {
        const decision = decisions[record.fullSha256];
        return {
          paths: record.paths.map((entry) => entry.path),
          ...(decision === undefined ? {} : { decision: describeDecision(decision) }),
        };
      }),
      questions: open.map((entry) => ({ path: entry.path, decision: describeDecision(decisions[entry.fromSha256]) })),
    };
  };
  const publishFolders = () => {
    if (!window.isDestroyed()) window.webContents.send('connections:change', folders());
  };
  const publish = (progress: ReturnType<IndexingQueue['progress']>) => {
    if (!window.isDestroyed()) window.webContents.send('library:progress', progress);
    publishFolders();
  };
  const downloads = new DownloadTracker();
  const worker = new IndexingWindow((model) => {
    downloads.update(model);
    publish({ ...queue.progress(), model });
  });
  const queue = new IndexingQueue(store, (bytes) => worker.audio(bytes), publish, (bytes) => worker.peaks(bytes));
  const handle = (channel: string, listener: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (event.sender !== window.webContents) throw new Error('허용되지 않은 요청입니다.');
      return listener(...args);
    });
  };
  handle('library:choose-folder', async () => {
    // Automated tests must never open a native picker.
    if (process.env.PROTO1_HIDDEN === '1') return null;
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
    const chosen = result.canceled ? undefined : result.filePaths[0];
    if (!chosen) return null;
    const root = path.resolve(chosen);
    approvedFolders.add(root);
    return root;
  });
  const scan = async (root: string) => {
    const token = {};
    scanTokens.set(root, token);
    const connected = store.loadFolders().data;
    if (!connected.some((entry) => entry.root === root)) store.saveFolders([...connected, { root }]);
    scanning.add(root);
    scanErrors.delete(root);
    publishFolders();
    const previous: FileItem[] = store.loadItems().data
      .filter((item) => item.paths.some((entry) => entry.folderId === root))
      .map((item) => ({
        id: item.id, sha256: item.fullSha256, edgeSha256: item.edgeSha256 ?? '',
        size: item.size ?? 0, embeddingEligible: (item.size ?? 0) <= 100_000_000,
        paths: item.paths.filter((entry) => entry.folderId === root).map((entry) => ({
          path: entry.path, size: item.size ?? 0, mtimeMs: item.mtimeMs ?? 0,
        })),
      }));
    const scanned = await scanLibrary(root, previous);
    if (closed || scanTokens.get(root) !== token) return queue.progress();
    scanTokens.delete(root);
    scanning.delete(root);
    if (scanned.status === 'stopped') {
      scanErrors.set(root, scanned.reason!);
      publishFolders();
      throw new Error(scanned.reason);
    }
    if (scanned.unreadableCount) unreadable.set(root, scanned.unreadableCount);
    else unreadable.delete(root);
    const existing = store.loadItems().data;
    const merged = new Map<string, StoreItem>(existing.map((item) => [
      item.id, { ...item, paths: item.paths.filter((entry) => entry.folderId !== root) },
    ]));
    for (const item of scanned.items) {
      const saved = merged.get(item.id);
      merged.set(item.id, {
        // Items saved before v3 have no addedAt; the sound list falls back to the file time for them.
        ...(saved ? {} : { addedAt: Date.now() }),
        ...saved, id: item.id, fullSha256: item.sha256, edgeSha256: item.edgeSha256,
        size: item.size, mtimeMs: item.paths[0].mtimeMs,
        paths: [...(saved?.paths ?? []), ...item.paths.map((entry) => ({ folderId: root, path: entry.path }))],
      });
    }
    const saved = [...merged.values()].filter((item) => item.paths.length);
    store.saveItems(saved);
    const decisions = store.loadDecisions().data;
    store.saveTracking(updateTracking(store.loadTracking().data, {
      root, previous, items: scanned.items, missing: scanned.missing,
      live: new Set(saved.map((item) => item.fullSha256)),
      hasDecision: (hash) => decisions[hash] !== undefined,
    }));
    void queue.run();
    return queue.progress();
  };
  handle('library:connect', async (folder: unknown) => {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('폴더의 절대 경로가 필요합니다.');
    const root = path.resolve(folder);
    if (process.env.PROTO1_HIDDEN !== '1' && !approvedFolders.has(root)) {
      throw new Error('폴더 선택기에서 고른 폴더만 연결할 수 있습니다.');
    }
    approvedFolders.delete(root);
    return scan(root);
  });
  // A folder dropped on the window: the drop itself is the person's choice, like the picker.
  handle('library:connect-drop', async (folder: unknown) => {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('폴더의 절대 경로가 필요합니다.');
    const root = path.resolve(folder);
    try { if (!(await fs.stat(root)).isDirectory()) return false; } catch { return false; }
    await scan(root);
    return true;
  });
  handle('library:rescan', async (folder: unknown) => {
    if (typeof folder !== 'string' || !store.loadFolders().data.some((entry) => entry.root === path.resolve(folder))) {
      throw new Error('연결한 폴더만 다시 읽을 수 있습니다.');
    }
    // The folder section already shows the stopped reason; a second error would repeat it.
    return scan(path.resolve(folder)).catch(() => queue.progress());
  });
  handle('library:items', () => queue.items());
  handle('library:progress', () => queue.progress());
  handle('library:resume', () => { void queue.run(); return queue.progress(); });
  handle('library:stop', () => queue.stop());
  handle('collections:load', () => store.loadCollections().data);
  handle('collections:save', (data: unknown) => store.saveCollections(data as CollectionData));
  handle('connections:folders', folders);
  handle('connections:tracking', tracking);
  handle('connections:answer-change', (file: unknown, inherit: unknown) => {
    const current = store.loadTracking().data;
    const entry = current.changed.find((candidate) => candidate.path === file);
    if (!entry || typeof inherit !== 'boolean') throw new Error('내용이 바뀐 파일의 질문을 찾을 수 없습니다.');
    if (inherit) {
      const decisions = store.loadDecisions().data;
      const decision = decisions[entry.fromSha256];
      if (decision === undefined || decisions[entry.toSha256] !== undefined) {
        throw new Error('이어받을 결정이 없거나 새 파일에 이미 결정이 있습니다.');
      }
      store.saveDecision(entry.toSha256, decision);
    }
    store.saveTracking({
      ...current,
      changed: current.changed.filter((candidate) => candidate !== entry),
      // Inherited: the path now holds the sound that carries this decision, so it is no longer missing.
      missing: inherit ? current.missing.filter((record) => record.fullSha256 !== entry.fromSha256) : current.missing,
    });
    publishFolders();
  });
  handle('connections:remove', (root: unknown) => {
    if (typeof root !== 'string') throw new Error('폴더 경로가 필요합니다.');
    scanTokens.delete(root);
    scanning.delete(root);
    scanErrors.delete(root);
    unreadable.delete(root);
    store.removeFolder(root);
    const decisions = store.loadDecisions().data;
    const current = store.loadTracking().data;
    store.saveTracking({
      moved: current.moved.filter((entry) => entry.folderId !== root),
      changed: current.changed.filter((entry) => entry.folderId !== root),
      // A record with a decision outlives its folder; the decision itself is never touched here.
      missing: current.missing.filter((record) =>
        record.paths[0].folderId !== root || decisions[record.fullSha256] !== undefined),
    });
    store.saveFolders(store.loadFolders().data.filter((folder) => folder.root !== root));
    publish(queue.progress());
  });
  return {
    resume: () => {
      void (async () => {
        for (const folder of store.loadFolders().data) {
          if (closed) return;
          try {
            await scan(folder.root);
          } catch {
            // The scan publishes the inaccessible notice and keeps saved entries.
          }
        }
      })();
    },
    close: () => { closed = true; queue.close(); worker.close(); },
  };
}
