import type { ConnectionPlatform, LibraryConnection } from '../types';
import { detectPacks, type SearchSound } from '../../core/search';
import { embeddingEligible, isUnchanged, type ScannedFile } from '../../core/files';
import { DownloadTracker } from '../../model/download';
import type { ModelEvent } from '../../model/types';
import type { WebDb } from './db';
import type { Analysis } from './analysis';
import type { PackDetails } from '../../core/packs';
import { fingerprintFile, resolveFile, walkDirectory, type DirectoryHandle } from './fs';
import { readPackFiles } from './packs';

/** A sound row as IndexedDB keeps it; size lets a dropped File find its row without hashing. */
export interface StoredSound extends SearchSound {
  root: string;
  size: number;
  embedding?: number[];
  peaks?: number[];
}

type FolderView = Omit<LibraryConnection, 'download' | 'needsPermission'>;
interface FolderRecord {
  root: string;
  handle: DirectoryHandle;
  connectedAt: number;
  /** Fingerprints of the last scan; a file with the same path, size and mtime is not read again. */
  items: ScannedFile[];
  view: FolderView & { files?: string[] };
}
interface Live {
  record: FolderRecord;
  view: LibraryConnection;
}

export interface LibraryDeps {
  db: WebDb;
  loadAudioModel(): Promise<void>;
  onModelEvent(listener: (event: ModelEvent) => void): () => void;
  analyse(bytes: ArrayBuffer): Promise<Analysis>;
  /** Gives the page a turn between files. */
  pause(): Promise<void>;
  now(): number;
}

export interface WebLibrary {
  connections: ConnectionPlatform;
  /** Registers a directory handle (picker, drop or the test hook) and starts its scan. Resolves the root name. */
  connectHandle(handle: DirectoryHandle): Promise<string>;
  sounds(): Promise<StoredSound[]>;
  readFile(sound: SearchSound): Promise<File>;
  packs(): Promise<PackDetails[]>;
}

const permissionReason = '폴더 접근을 다시 허용해야 합니다. 다시 허용을 눌러 주세요.';
const offlineReason = '폴더를 읽을 수 없습니다. 폴더나 드라이브가 연결되어 있는지 확인해 주세요.';
const modelReason = 'AI 모델을 받지 못했습니다. 인터넷을 확인한 뒤 다시 시도해 주세요.';

export function createWebLibrary(deps: LibraryDeps): WebLibrary {
  const { db } = deps;
  const folders = new Map<string, Live>();
  const listeners = new Set<(folders: LibraryConnection[]) => void>();
  const pending = new Map<string, DirectoryHandle>();
  let queue: Promise<void> = Promise.resolve();
  const coverUrls = new Map<string, string>();

  const snapshot = (): LibraryConnection[] => [...folders.values()]
    .map(({ view }) => ({ ...view, download: view.download && { ...view.download } }));
  const notify = () => { const folders = snapshot(); for (const listener of listeners) listener(folders); };
  const save = async ({ record, view }: Live) => {
    const { download: _download, needsPermission: _needs, ...kept } = view;
    record.view = { ...kept };
    await db.put('folders', record.root, { ...record, items: [...record.items], view: record.view });
  };
  const rowsOf = async (root: string) => (await db.all<StoredSound>('sounds')).filter((row) => row.root === root);
  /** Rows saved by an older rule or a stored depth get the current pack before anything reads them (PRD 7.3). */
  const repack = async (root: string) => {
    const rows = await rowsOf(root);
    const packs = detectPacks([{ root, files: rows.map((row) => row.relativePath) }]);
    for (const [index, row] of rows.entries()) {
      const { packId, packName } = packs[index];
      if (row.packId !== packId || row.packName !== packName) await db.put('sounds', row.id, { ...row, packId, packName });
    }
  };

  const ready = (async () => {
    const records = (await db.all<FolderRecord>('folders')).sort((a, b) => a.connectedAt - b.connectedAt);
    for (const record of records) {
      await repack(record.root);
      const { files: _legacyFiles, ...view } = record.view;
      const live: Live = { record, view: { ...view, root: record.root, fileCount: record.items.length, current: false } };
      folders.set(record.root, live);
      let state: PermissionState = 'granted';
      try { state = await record.handle.queryPermission?.({ mode: 'read' }) ?? 'granted'; } catch { state = 'prompt'; }
      if (state === 'granted') {
        // Reopening the app rescans, as in the Mac app (PRD 7.5).
        void scan(record.root);
      } else {
        Object.assign(live.view, { status: 'stopped', needsPermission: true, reason: permissionReason });
      }
    }
  })();

  function scan(root: string): Promise<void> {
    const run = queue.then(() => runScan(root));
    queue = run.catch(() => {});
    return run;
  }

  async function runScan(root: string): Promise<void> {
    const live = folders.get(root);
    if (!live) return;
    const gone = () => folders.get(root) !== live;
    const set = (patch: Partial<LibraryConnection>) => { if (!gone()) { Object.assign(live.view, patch); notify(); } };
    set({ status: 'scanning', reason: undefined, failure: undefined, offline: undefined, needsPermission: undefined });
    let found: Awaited<ReturnType<typeof walkDirectory>>;
    try {
      found = await walkDirectory(live.record.handle);
    } catch (error) {
      const denied = (error as Error)?.name === 'NotAllowedError' || (error as Error)?.name === 'SecurityError';
      set(denied
        ? { status: 'stopped', needsPermission: true, reason: permissionReason }
        : { status: 'stopped', offline: true, failure: 'folder', reason: offlineReason });
      if (!gone()) await save(live);
      return;
    }
    let unreadable = found.unreadable;
    const previous = new Map(live.record.items.map((item) => [item.path, item]));
    const scanned: ScannedFile[] = [];
    const files = new Map<string, File>();
    for (const entry of found.files) {
      try {
        const file = await entry.handle.getFile();
        const metadata = { path: entry.path, size: file.size, mtimeMs: file.lastModified };
        const old = previous.get(entry.path);
        const print = old && isUnchanged(metadata, old) ? old : await fingerprintFile(file);
        scanned.push({ ...metadata, edgeSha256: print.edgeSha256, sha256: print.sha256 });
        files.set(entry.path, file);
      } catch {
        unreadable++;
      }
    }
    if (gone()) return;
    const packs = detectPacks([{ root, files: scanned.map((item) => item.path) }]);
    const all = await db.all<StoredSound>('sounds');
    // Whole-file identity: any analysed row with the same hash, in any folder, is reused instead of analysed again.
    const analysed = new Map(all.filter((row) => row.embedding && row.fullHash).map((row) => [row.fullHash!, row]));
    const firstSeen = new Map<string, number>();
    for (const row of all) {
      for (const key of [row.id, row.fullHash]) {
        if (key && row.addedAt !== undefined) firstSeen.set(key, Math.min(firstSeen.get(key) ?? Infinity, row.addedAt));
      }
    }
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    let modelLoaded = false;
    set({ status: 'indexing', fileCount: scanned.length, completed, failed, skipped, unreadable });
    const kept = new Set<string>();
    for (const [index, item] of scanned.entries()) {
      const id = `${root}/${item.path}`;
      const eligible = embeddingEligible(item.size);
      const base: StoredSound = {
        id, root, relativePath: item.path, packId: packs[index].packId, packName: packs[index].packName,
        size: item.size, duration: 0, fullHash: eligible ? item.sha256 : undefined,
        addedAt: firstSeen.get(id) ?? firstSeen.get(item.sha256) ?? deps.now(),
      };
      let row: StoredSound | undefined;
      const reuse = eligible ? analysed.get(item.sha256) : undefined;
      if (!eligible) {
        skipped++;
        row = base;
      } else if (reuse) {
        completed++;
        row = { ...base, duration: reuse.duration, embedding: reuse.embedding, peaks: reuse.peaks };
      } else {
        set({ current: true });
        if (!modelLoaded) {
          const tracker = new DownloadTracker();
          const unsubscribe = deps.onModelEvent((event) => {
            if (event.type === 'progress' && event.kind !== 'audio') return;
            set({ download: tracker.update(event) });
          });
          try {
            await deps.loadAudioModel();
            modelLoaded = true;
          } catch {
            set({ status: 'stopped', current: false, failure: 'model', reason: modelReason, completed, failed, skipped });
            if (!gone()) await save(live);
            return;
          } finally {
            unsubscribe();
            set({ download: undefined });
          }
        }
        try {
          const result = await deps.analyse(await files.get(item.path)!.arrayBuffer());
          completed++;
          row = { ...base, ...result };
          analysed.set(item.sha256, row);
        } catch {
          failed++;
        }
        set({ current: false });
        await deps.pause();
      }
      if (gone()) return;
      if (row) {
        await db.put('sounds', id, row);
        kept.add(id);
      }
      set({ completed, failed, skipped });
    }
    for (const row of await rowsOf(root)) if (!kept.has(row.id)) await db.delete('sounds', row.id);
    if (gone()) return;
    live.record.items = scanned;
    set({ status: 'completed' });
    await save(live);
  }

  async function nameFor(handle: DirectoryHandle): Promise<string> {
    for (const live of folders.values()) if (await live.record.handle.isSameEntry(handle)) return live.record.root;
    let root = handle.name;
    for (let n = 2; folders.has(root); n++) root = `${handle.name} (${n})`;
    return root;
  }

  async function connectHandle(handle: DirectoryHandle): Promise<string> {
    await ready;
    const root = await nameFor(handle);
    if (folders.has(root)) { void scan(root); return root; }
    const view: LibraryConnection = { root, fileCount: 0, status: 'scanning', completed: 0, failed: 0, skipped: 0 };
    const live: Live = { record: { root, handle, connectedAt: deps.now(), items: [], view }, view };
    folders.set(root, live);
    await save(live);
    notify();
    void scan(root);
    return root;
  }

  const connections: ConnectionPlatform = {
    async getFolders() { await ready; return snapshot(); },
    async chooseFolder() {
      const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: 'read' }) => Promise<DirectoryHandle> }).showDirectoryPicker;
      if (!picker) throw new Error('이 브라우저는 폴더 가져오기를 지원하지 않습니다.');
      let handle: DirectoryHandle;
      try { handle = await picker({ mode: 'read' }); } catch (error) {
        if ((error as Error)?.name === 'AbortError') return null;
        throw error;
      }
      await ready;
      const root = await nameFor(handle);
      pending.set(root, handle);
      return root;
    },
    async connectFolder(root) {
      await ready;
      const handle = pending.get(root);
      pending.delete(root);
      if (handle) { await connectHandle(handle); return; }
      if (!folders.has(root)) throw new Error('폴더를 다시 선택해 주세요.');
      void scan(root);
    },
    async removeFolder(root) {
      await ready;
      // Coordinates go; favorites, collections and other human decisions live in settings and stay.
      folders.delete(root);
      await db.delete('folders', root);
      for (const row of await rowsOf(root)) await db.delete('sounds', row.id);
      notify();
    },
    async rescanFolder(root) { await ready; await scan(root); },
    connectDrop(transfer) {
      // getAsFileSystemHandle only works during the drop event, so every call happens before the first await.
      const handles = Array.from({ length: transfer.items.length }, (_, index) => transfer.items[index]).filter((item) => item.kind === 'file').map((item) =>
        (item as DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.());
      return (async () => {
        for (const promise of handles) {
          const handle = await promise?.catch(() => null);
          if (handle?.kind === 'directory') {
            await connectHandle(handle as unknown as DirectoryHandle);
            return true;
          }
        }
        return false;
      })();
    },
    async reauthorize(root) {
      await ready;
      const live = folders.get(root);
      if (!live) throw new Error('연결된 폴더가 아닙니다.');
      const state = await live.record.handle.requestPermission?.({ mode: 'read' }) ?? 'granted';
      if (state !== 'granted') throw new Error('폴더 접근이 허용되지 않았습니다.');
      live.view.needsPermission = undefined;
      notify();
      await scan(root);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };

  return {
    connections,
    connectHandle,
    async sounds() {
      await ready;
      const rows = await db.all<StoredSound>('sounds');
      return rows.filter((row) => folders.has(row.root)).map((row) => {
        const view = folders.get(row.root)!.view;
        return view.needsPermission ? { ...row, blockedReason: permissionReason }
          : view.offline ? { ...row, blockedReason: offlineReason } : row;
      });
    },
    async readFile(sound) {
      await ready;
      const live = sound.root === undefined ? undefined : folders.get(sound.root);
      if (!live) throw new Error('연결된 폴더의 소리가 아닙니다.');
      if (live.view.needsPermission) throw new Error(permissionReason);
      try { return await resolveFile(live.record.handle, sound.relativePath); } catch { throw new Error(offlineReason); }
    },
    async packs() {
      await ready;
      const rows = await db.all<StoredSound>('sounds');
      const packs = new Map(rows.filter((row) => folders.has(row.root)).map((row) => [row.packId, row.root]));
      const details = await Promise.all([...packs].map(async ([id, root]): Promise<PackDetails> => {
        const { record, view } = folders.get(root)!;
        if (view.needsPermission || view.offline) return { id };
        const { cover, ...facts } = await readPackFiles(record.handle, id.slice(root.length + 1)).catch(() => ({ cover: undefined }));
        if (!cover) return { id, ...facts };
        let url = coverUrls.get(id);
        if (!url) { url = URL.createObjectURL(cover); coverUrls.set(id, url); }
        return { id, ...facts, cover: url };
      }));
      for (const [id, url] of coverUrls) if (!packs.has(id)) { URL.revokeObjectURL(url); coverUrls.delete(id); }
      return details;
    },
  };
}
