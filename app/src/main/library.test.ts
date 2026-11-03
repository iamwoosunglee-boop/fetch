import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store, type StoreItem } from './store';
import { registerLibrary } from './library';
import { scanLibrary } from './scan';

const mock = vi.hoisted(() => ({
  directory: '', handlers: new Map<string, (...args: any[]) => any>(),
  picker: vi.fn(), send: vi.fn(), audio: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => mock.directory },
  dialog: { showOpenDialog: mock.picker },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mock.handlers.set(name, handler) },
}));
vi.mock('./audio', () => ({ registerAudio: vi.fn() }));
vi.mock('./indexing-window', () => ({
  IndexingWindow: class {
    audio = mock.audio;
    peaks = async () => ({ peaks: [] });
    close() {}
  },
}));
vi.mock('./scan', async (original) => {
  const actual = await original<typeof import('./scan')>();
  return { ...actual, scanLibrary: vi.fn(actual.scanLibrary) };
});

const approved = { category: 'METAL' };
let temporary: string;
let library: ReturnType<typeof registerLibrary>;
let store: Store;
const window = { isDestroyed: () => false, webContents: { send: mock.send } };
const invoke = (name: string, ...args: unknown[]) =>
  mock.handlers.get(name)!({ sender: window.webContents }, ...args);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('PROTO1_HIDDEN', undefined);
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'proto1-library-test-'));
  mock.directory = path.join(temporary, 'profile');
  mock.handlers.clear();
  mock.audio.mockResolvedValue({ vector: new Float32Array(512).fill(0.1), duration: 1 });
  store = new Store(mock.directory);
  library = registerLibrary(window as never);
});

async function seedFinishedFolder() {
  const root = path.join(temporary, 'sounds');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'first.wav'), 'first sound');
  const scanned = await scanLibrary(root);
  const item = scanned.items[0];
  store.saveFolders([{ root }]);
  store.saveItems([{
    id: item.id, fullSha256: item.sha256, edgeSha256: item.edgeSha256,
    size: item.size, mtimeMs: item.paths[0].mtimeMs, duration: 1,
    paths: [{ folderId: root, path: item.paths[0].path }],
  }]);
  store.appendEmbedding(item.id, new Float32Array(512).fill(0.2));
  store.saveDecision(item.sha256, approved);
  library.close();
  library = registerLibrary(window as never);
  vi.mocked(scanLibrary).mockClear();
  return { root, item };
}

async function observeFolders(trigger: () => void, done: (folders: any[]) => boolean) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Folder event deadline')), 2000);
      mock.send.mockImplementation((channel, folders) => {
        if (channel === 'connections:change' && done(folders)) resolve();
      });
      trigger();
    });
  } finally {
    clearTimeout(timer!);
    mock.send.mockReset();
  }
}

describe('startup rescan', () => {
  it('discovers added files and queues only new coordinates while keeping decisions', async () => {
    const { root, item } = await seedFinishedFolder();
    fs.writeFileSync(path.join(root, 'second.wav'), 'second sound');
    await observeFolders(() => library.resume(),
      (folders) => folders[0]?.completed === 2 && folders[0]?.status === 'completed');
    expect(scanLibrary).toHaveBeenCalledWith(root, expect.arrayContaining([expect.objectContaining({ id: item.id })]));
    expect(mock.audio).toHaveBeenCalledOnce();
    expect(invoke('library:items')).toHaveLength(2);
    expect(invoke('library:items').find((entry: any) => entry.id === item.id).vector)
      .toEqual(Array.from(new Float32Array(512).fill(0.2)));
    expect(store.loadDecisions().data[item.sha256]).toEqual(approved);
    const saved: StoreItem[] = invoke('library:items');
    expect(saved.find((entry) => entry.id === item.id)!.addedAt).toBeUndefined();
    const added = saved.find((entry) => entry.id !== item.id)!.addedAt!;
    expect(Math.abs(Date.now() - added)).toBeLessThan(60_000);
    await observeFolders(() => invoke('library:rescan', root), (folders) => folders[0]?.status === 'completed');
    expect(invoke('library:items').find((entry: { id: string }) => entry.id !== item.id)!.addedAt).toBe(added);
  });

  it('connects a dropped directory and declines a dropped file or bad input', async () => {
    const root = path.join(temporary, 'dropped');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'a.wav'), 'dropped sound');
    expect(await invoke('library:connect-drop', path.join(root, 'a.wav'))).toBe(false);
    expect(await invoke('library:connect-drop', path.join(temporary, 'nowhere'))).toBe(false);
    await expect(invoke('library:connect-drop', 'relative')).rejects.toThrow();
    await observeFolders(async () => expect(await invoke('library:connect-drop', root)).toBe(true),
      (folders) => folders[0]?.root === root && folders[0]?.status === 'completed');
    expect(store.loadFolders().data).toEqual([{ root }]);
  });

  it('publishes an inaccessible notice without deleting entries or decisions', async () => {
    const { root, item } = await seedFinishedFolder();
    const entries = store.loadItems().data;
    fs.renameSync(root, `${root}-offline`);
    await observeFolders(() => library.resume(),
      (folders) => folders[0]?.status === 'stopped' && Boolean(folders[0]?.reason));
    expect(store.loadItems().data).toEqual(entries);
    expect(store.loadDecisions().data[item.sha256]).toEqual(approved);
    expect(mock.audio).not.toHaveBeenCalled();
  });

  it('returns before scanning completes and does not restart work after close', async () => {
    await seedFinishedFolder();
    let finish!: (result: Awaited<ReturnType<typeof scanLibrary>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof scanLibrary>>>((resolve) => { finish = resolve; });
    vi.mocked(scanLibrary).mockReturnValueOnce(pending);
    expect(library.resume()).toBeUndefined();
    expect(scanLibrary).toHaveBeenCalledOnce();
    library.close();
    finish({ status: 'completed', items: [], missing: [], fileCount: 0, oversizedCount: 0 });
    await pending;
    expect(store.loadItems().data).toHaveLength(1);
    expect(mock.audio).not.toHaveBeenCalled();
  });
});
afterEach(() => {
  library.close();
  fs.rmSync(temporary, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('file tracking', () => {
  it('updates moved paths, groups duplicates and keeps a deleted file with its decision', async () => {
    const { root, item } = await seedFinishedFolder();
    fs.mkdirSync(path.join(root, 'moved'));
    fs.renameSync(path.join(root, 'first.wav'), path.join(root, 'moved', 'first.wav'));
    fs.writeFileSync(path.join(root, 'twin-a.wav'), 'twin');
    fs.writeFileSync(path.join(root, 'twin-b.wav'), 'twin');
    await invoke('library:rescan', root);
    let view = invoke('connections:tracking');
    expect(view.moved).toEqual([{ from: path.join(root, 'first.wav'), to: path.join(root, 'moved', 'first.wav') }]);
    expect(view.duplicates).toEqual([[path.join(root, 'twin-a.wav'), path.join(root, 'twin-b.wav')]]);
    expect(view.missing).toEqual([]);
    expect(store.loadDecisions().data[item.sha256]).toEqual(approved);

    fs.rmSync(path.join(root, 'moved', 'first.wav'));
    await invoke('library:rescan', root);
    view = invoke('connections:tracking');
    expect(view.missing).toEqual([{ paths: [path.join(root, 'moved', 'first.wav')], decision: '금속 METAL' }]);
    expect(store.loadDecisions().data[item.sha256]).toEqual(approved);
    await invoke('connections:remove', root);
    expect(invoke('connections:tracking').missing).toHaveLength(1);
    expect(store.loadDecisions().data[item.sha256]).toEqual(approved);
  });

  it('copies a decision to changed content only after a person answers yes', async () => {
    const { root, item } = await seedFinishedFolder();
    const file = path.join(root, 'first.wav');
    fs.writeFileSync(file, 'edited sound');
    await invoke('library:rescan', root);
    const edited = invoke('library:items')[0].fullSha256;
    expect(edited).not.toBe(item.sha256);
    expect(invoke('connections:tracking').questions).toEqual([{ path: file, decision: '금속 METAL' }]);
    expect(invoke('connections:tracking').missing).toEqual([]);
    expect(store.loadDecisions().data[edited]).toBeUndefined();

    invoke('connections:answer-change', file, true);
    expect(store.loadDecisions().data).toEqual({ [item.sha256]: approved, [edited]: approved });
    expect(invoke('connections:tracking').questions).toEqual([]);
    expect(invoke('connections:tracking').missing).toEqual([]);
    expect(() => invoke('connections:answer-change', file, true)).toThrow();
  });

  it('leaves the new content undecided when a person declines', async () => {
    const { root, item } = await seedFinishedFolder();
    const file = path.join(root, 'first.wav');
    fs.writeFileSync(file, 'edited sound');
    await invoke('library:rescan', root);
    invoke('connections:answer-change', file, false);
    expect(store.loadDecisions().data).toEqual({ [item.sha256]: approved });
    expect(invoke('connections:tracking').questions).toEqual([]);
    expect(invoke('connections:tracking').missing).toEqual([{ paths: [file], decision: '금속 METAL' }]);
  });

  it('does not report an offline folder as missing', async () => {
    const { root } = await seedFinishedFolder();
    fs.renameSync(root, `${root}-offline`);
    await invoke('library:rescan', root);
    expect(invoke('connections:tracking').missing).toEqual([]);
    expect(invoke('connections:folders')[0].offline).toBe(true);
  });
});

describe('unreadable subfolders', () => {
  it('keeps entries, coordinates and decisions, reports nothing missing, and shows the count', async () => {
    const { root, item } = await seedFinishedFolder();
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.renameSync(path.join(root, 'first.wav'), path.join(locked, 'first.wav'));
    fs.writeFileSync(path.join(root, 'second.wav'), 'second sound');
    await invoke('library:rescan', root);
    const before = invoke('library:items').find((entry: { id: string }) => entry.id === item.id);
    fs.chmodSync(locked, 0o000);
    try {
      await invoke('library:rescan', root);
      const [folder] = invoke('connections:folders');
      expect(folder.status).not.toBe('stopped');
      expect(folder.offline).toBe(false);
      expect(folder.unreadable).toBe(1);
      expect(invoke('library:items').find((entry: { id: string }) => entry.id === item.id)).toEqual(before);
      expect(store.getEmbedding(item.id)).toBeDefined();
      expect(store.loadDecisions().data[item.sha256]).toEqual(approved);
      expect(invoke('connections:tracking').missing).toEqual([]);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
    await invoke('library:rescan', root);
    expect(invoke('connections:folders')[0].unreadable).toBeUndefined();
  });
});

describe('removing a folder during analysis', () => {
  it('drops the running item and leaves the folder gone', async () => {
    vi.stubEnv('PROTO1_HIDDEN', '1');
    const root = path.join(temporary, 'sounds');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'one.wav'), 'one');
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    mock.audio.mockImplementationOnce(() => { started(); return new Promise((resolve) => { finish = resolve; }); });
    await invoke('library:connect', root);
    await running;
    await invoke('connections:remove', root);
    finish({ vector: new Float32Array(512).fill(0.1), duration: 1 });
    await observeFolders(() => { void invoke('library:resume'); }, (folders) => folders.length === 0);
    expect(store.loadItems().data).toEqual([]);
    expect(store.loadFolders().data).toEqual([]);
  });
});

describe('folder approval', () => {
  it('rejects a renderer path without calling the picker or scanner', async () => {
    await expect(invoke('library:connect', temporary)).rejects.toThrow();
    expect(mock.picker).not.toHaveBeenCalled();
    expect(scanLibrary).not.toHaveBeenCalled();
    expect(store.loadFolders().data).toEqual([]);
  });

  it('accepts only the main picker result and consumes approval', async () => {
    const chosen = path.join(temporary, 'chosen');
    fs.mkdirSync(chosen);
    mock.picker.mockResolvedValue({ canceled: false, filePaths: [chosen] });
    expect(await invoke('library:choose-folder')).toBe(chosen);
    await expect(invoke('library:connect', path.join(temporary, 'other'))).rejects.toThrow();
    await invoke('library:connect', chosen);
    expect(store.loadFolders().data).toEqual([{ root: chosen }]);
    await invoke('connections:remove', chosen);
    await expect(invoke('library:connect', chosen)).rejects.toThrow();
  });

  it('restricts rescan to connected roots even in hidden mode', async () => {
    vi.stubEnv('PROTO1_HIDDEN', '1');
    await expect(invoke('library:rescan', temporary)).rejects.toThrow();
    await invoke('library:connect', temporary);
    await invoke('library:rescan', temporary);
    expect(scanLibrary).toHaveBeenCalledTimes(2);
    expect(await invoke('library:choose-folder')).toBeNull();
    expect(mock.picker).not.toHaveBeenCalled();
  });
});
