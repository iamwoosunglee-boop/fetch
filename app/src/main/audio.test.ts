import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAudio } from './audio';
import { Store } from './store';

const mock = vi.hoisted(() => ({
  directory: '', handlers: new Map<string, (...args: any[]) => any>(),
  image: (url: string) => ({ url, isEmpty: () => url.endsWith('empty'), getSize: () => ({ width: url.endsWith('huge') ? 512 : 64, height: 64 }), toDataURL: () => url }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => mock.directory, isPackaged: false },
  shell: {}, nativeImage: { createFromDataURL: mock.image },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mock.handlers.set(name, handler) },
}));

const window = { webContents: { startDrag: vi.fn() } };
const invoke = (name: string, ...args: unknown[]) => mock.handlers.get(name)!({ sender: window.webContents }, ...args);
const hash = (n: number) => String(n).repeat(64);
let temporary: string;
let root: string;
let store: Store;

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'proto1-audio-test-'));
  mock.directory = path.join(temporary, 'profile');
  mock.handlers.clear();
  root = path.join(temporary, 'Library');
  fs.mkdirSync(path.join(root, 'Cartoon'), { recursive: true });
  store = new Store(mock.directory);
  store.saveFolders([{ root }]);
  store.saveItems([
    {
      id: 'one', fullSha256: hash(1), mtimeMs: 5, addedAt: 1000, peaks: [0, 50, 100],
      paths: [{ folderId: root, path: path.join(root, 'Cartoon', 'a.wav') }, { folderId: root, path: path.join(root, 'b.wav') }],
    },
    { id: 'two', fullSha256: hash(2), mtimeMs: 7, paths: [{ folderId: root, path: path.join(root, 'Cartoon', 'c.wav') }] },
  ]);
  registerAudio(window as never, store);
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

describe('audio:sounds', () => {
  it('gives each row its pack name, 0-1 peaks and addedAt, falling back to the file time, without used', async () => {
    const rows = await invoke('audio:sounds');
    expect(rows).toHaveLength(3);
    const [a, b, c] = rows;
    expect(a).toMatchObject({ id: 'one', packName: 'Library', peaks: [0, 0.5, 1], addedAt: 1000 });
    expect(b).toMatchObject({ id: 'one', packName: 'Library', addedAt: 1000 });
    expect(c).toMatchObject({ id: 'two', packName: 'Library', addedAt: 7 });
    expect(c.peaks).toBeUndefined();
    expect(rows.every((row: object) => !('used' in row))).toBe(true);
  });

  it('ignores a pack depth saved by an older version', async () => {
    store.saveFolders([{ root, packDepth: 1 } as never]);
    expect((await invoke('audio:sounds')).map((row: { packName: string }) => row.packName)).toEqual(['Library', 'Library', 'Library']);
  });
});

describe('audio:drag', () => {
  const wav = () => path.join(root, 'Cartoon', 'c.wav');
  const dragged = () => window.webContents.startDrag.mock.lastCall![0];
  beforeEach(() => {
    window.webContents.startDrag.mockClear();
    fs.writeFileSync(wav(), 'x');
  });

  it('hands over the original WAV with the picture from the screen', async () => {
    await invoke('audio:drag', 'two', 'data:image/png;base64,AAAA');
    expect(dragged().file).toBe(wav());
    expect(dragged().icon.url).toBe('data:image/png;base64,AAAA');
  });

  it.each([
    ['nothing', undefined], ['another type', 'data:image/svg+xml;base64,AAAA'], ['a path', '/etc/passwd'],
    ['a picture that does not decode', 'data:image/png;base64,empty'], ['a picture too large', 'data:image/png;base64,huge'],
    ['too many bytes', `data:image/png;base64,${'A'.repeat(200_000)}`],
  ])('falls back to the plain badge for %s', async (_case, picture) => {
    await invoke('audio:drag', 'two', picture);
    expect(dragged().file).toBe(wav());
    expect(dragged().icon.url).toMatch(/^data:image\/png;base64,iVBOR/);
  });
});

describe('packs', () => {
  const pack = () => path.join(root, 'Alpha');
  beforeEach(() => {
    fs.mkdirSync(pack());
    store.saveItems([
      { id: 'one', fullSha256: hash(1), paths: [{ folderId: root, path: path.join(pack(), 'a.wav') }] },
      { id: 'two', fullSha256: hash(2), paths: [{ folderId: root, path: path.join(root, 'Beta', 'b.wav') }] },
    ]);
  });

  it('reads every pack the sounds fall into, by id and nothing else', async () => {
    fs.writeFileSync(path.join(pack(), 'pack.json'), '{"name":"Toons"}');
    const details = await invoke('packs:load');
    expect(details).toEqual([{ id: pack(), name: 'Toons' }, { id: path.join(root, 'Beta') }]);
  });

  it('shows a license only for a known pack that has one', async () => {
    await expect(invoke('packs:reveal-license', '/etc')).rejects.toThrow();
    await expect(invoke('packs:reveal-license', pack())).rejects.toThrow();
  });
});

describe('audio:id-for-hash', () => {
  it('finds a sound by its whole content and nothing else', () => {
    expect(invoke('audio:id-for-hash', hash(2))).toBe('two');
    expect(invoke('audio:id-for-hash', hash(9))).toBeNull();
    expect(() => invoke('audio:id-for-hash', 42)).toThrow();
  });
});

describe('audio:id-for-path', () => {
  it('finds an item by any of its stored paths', async () => {
    expect(await invoke('audio:id-for-path', path.join(root, 'Cartoon', 'a.wav'))).toBe('one');
    expect(await invoke('audio:id-for-path', path.join(root, 'b.wav'))).toBe('one');
    expect(await invoke('audio:id-for-path', path.join(root, 'Cartoon', 'c.wav'))).toBe('two');
  });

  it('finds an item by the WAV copy made for dragging', async () => {
    expect(await invoke('audio:id-for-path', path.join(mock.directory, 'wav-copies', `${hash(2)}.wav`))).toBe('two');
  });

  it('finds a named copy and keeps using an older hash-named copy', async () => {
    const named = path.join(mock.directory, 'wav-copies', hash(2), 'c.wav');
    expect(await invoke('audio:id-for-path', named)).toBe('two');
    fs.mkdirSync(path.join(mock.directory, 'wav-copies'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Cartoon', 'c.ogg'), 'x');
    store.saveItems([{ id: 'two', fullSha256: hash(2), paths: [{ folderId: root, path: path.join(root, 'Cartoon', 'c.ogg') }] }]);
    expect(await invoke('audio:copy-ready', 'two')).toBe(false);
    fs.writeFileSync(path.join(mock.directory, 'wav-copies', `${hash(2)}.wav`), 'old');
    expect(await invoke('audio:copy-ready', 'two')).toBe(true);
  });

  it('returns null for unknown paths, including a copy name outside the copy folder', async () => {
    expect(await invoke('audio:id-for-path', path.join(root, 'missing.wav'))).toBeNull();
    expect(await invoke('audio:id-for-path', path.join(mock.directory, 'wav-copies', `${hash(9)}.wav`))).toBeNull();
    expect(await invoke('audio:id-for-path', path.join(temporary, `${hash(2)}.wav`))).toBeNull();
  });

  it('rejects anything but an absolute path', async () => {
    expect(() => invoke('audio:id-for-path', 'b.wav')).toThrow();
    expect(() => invoke('audio:id-for-path', 42)).toThrow();
  });
});
