import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rankResults } from '../core/search';
import { registerLibrary } from './library';

const mock = vi.hoisted(() => ({
  directory: '', handlers: new Map<string, (...args: any[]) => any>(), audio: vi.fn(),
  send: vi.fn(), resolveIdle: undefined as undefined | (() => void),
}));
vi.mock('electron', () => ({
  app: { getPath: () => mock.directory, isPackaged: false },
  dialog: {}, shell: {}, nativeImage: {},
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mock.handlers.set(name, handler) },
}));
vi.mock('./indexing-window', () => ({ IndexingWindow: class { audio = mock.audio; peaks = async () => ({ peaks: [] }); close() {} } }));

let temporary: string;
let library: ReturnType<typeof registerLibrary>;
const window = { isDestroyed: () => false, webContents: { send: mock.send } };
const invoke = (name: string, ...args: unknown[]) => mock.handlers.get(name)!({ sender: window.webContents }, ...args);

/** Subscribes to the folder event before the action, so no timing is assumed. */
async function finished(action: () => unknown, count: number) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Folder event deadline')), 2000);
      mock.send.mockImplementation((channel, folders) => {
        if (channel === 'connections:change' && folders.reduce((sum: number, folder: any) => sum + folder.completed, 0) === count
          && folders.every((folder: any) => folder.status === 'completed')) resolve();
      });
      Promise.resolve(action()).catch(reject);
    });
  } finally {
    clearTimeout(timer!);
    mock.send.mockReset();
  }
}
const lengths = async () => (await invoke('audio:sounds')).map((sound: any) => sound.duration);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('PROTO1_HIDDEN', '1');
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'proto1-duration-test-'));
  mock.directory = path.join(temporary, 'profile');
  mock.handlers.clear();
  mock.audio.mockResolvedValue({ vector: new Float32Array(512).fill(0.1), duration: 1.5 });
  library = registerLibrary(window as never);
});
afterEach(() => {
  library.close();
  fs.rmSync(temporary, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function folder(name: string, ...files: string[]) {
  const root = path.join(temporary, name);
  fs.mkdirSync(root, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(root, file), `sound ${file}`);
  return root;
}

it('keeps the length when a folder is reconnected', async () => {
  const root = folder('a', 'one.wav', 'two.wav');
  await finished(() => invoke('library:connect', root), 2);
  invoke('connections:remove', root);
  await finished(() => invoke('library:connect', root), 2);
  expect(await lengths()).toEqual([1.5, 1.5]);
  expect(mock.audio).toHaveBeenCalledTimes(2);
  const sounds = await invoke('audio:sounds');
  expect(rankResults(sounds, { length: { min: 1 } }).results).toHaveLength(2);
  expect(rankResults(sounds, { length: { max: 1 } }).results).toHaveLength(0);
});

it('keeps the length when a file is restored', async () => {
  const root = folder('a', 'one.wav');
  await finished(() => invoke('library:connect', root), 1);
  const file = path.join(root, 'one.wav');
  fs.renameSync(file, path.join(temporary, 'aside.wav'));
  await invoke('library:rescan', root);
  fs.renameSync(path.join(temporary, 'aside.wav'), file);
  await finished(() => invoke('library:rescan', root), 1);
  expect(await lengths()).toEqual([1.5]);
});

it('keeps the length when a file moves between connected folders', async () => {
  const first = folder('a', 'one.wav');
  const second = folder('b');
  await finished(() => invoke('library:connect', first), 1);
  await finished(() => invoke('library:connect', second), 1);
  fs.renameSync(path.join(first, 'one.wav'), path.join(second, 'one.wav'));
  await invoke('library:rescan', first);
  await finished(() => invoke('library:rescan', second), 1);
  expect(await lengths()).toEqual([1.5]);
  expect(mock.audio).toHaveBeenCalledTimes(1);
});
