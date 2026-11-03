import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryConnection } from './types';
import { memoryDb, type WebDb } from './web/db';
import type { DirectoryHandle, FileHandle } from './web/fs';
import { computePeaks } from './web/analysis';
import { supportedWebEnvironment } from './web/support';

vi.mock('../model', () => ({
  loadModel: vi.fn(async () => {}), embedText: vi.fn(), embedAudio: vi.fn(), onModelEvent: vi.fn(() => () => {}),
}));
const { createWebPlatform } = await import('./web');

type Tree = { [name: string]: Tree | { bytes: Uint8Array; mtime: number } };
interface FakeState { permission: PermissionState; granted: PermissionState; missing: boolean }

function directory(name: string, tree: Tree, state: FakeState): DirectoryHandle {
  const handle: DirectoryHandle = {
    kind: 'directory', name,
    async *values() {
      if (state.missing) throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
      for (const [child, value] of Object.entries(tree)) {
        yield 'bytes' in value ? file(child, value as { bytes: Uint8Array; mtime: number }) : directory(child, value as Tree, state);
      }
    },
    async getDirectoryHandle(child) { return directory(child, tree[child] as Tree, state); },
    async getFileHandle(child) { return file(child, tree[child] as { bytes: Uint8Array; mtime: number }); },
    async isSameEntry(other) { return other === handle || other.name === name; },
    async queryPermission() { return state.permission; },
    async requestPermission() { state.permission = state.granted; return state.granted; },
  };
  return handle;
}
function file(name: string, value: { bytes: Uint8Array; mtime: number }): FileHandle {
  return { kind: 'file', name, getFile: async () => new File([value.bytes as BlobPart], name, { lastModified: value.mtime }) };
}
const bytes = (seed: number, size = 100) => Uint8Array.from({ length: size }, (_, i) => (i * seed) % 251);

let db: WebDb;
let analyse: ReturnType<typeof vi.fn>;
let tree: Tree;
let state: FakeState;
const make = () => createWebPlatform({
  db, analyse, pause: async () => {}, now: () => 1_000, loadAudioModel: async () => {}, onModelEvent: () => () => {},
});
function finished(connections: NonNullable<ReturnType<typeof make>['platform']['connections']>, root: string,
  done: (folder: LibraryConnection) => boolean = (folder) => folder.status === 'completed') {
  // Subscribed before the action that triggers the scan.
  return new Promise<LibraryConnection>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('scan did not finish')), 2_000);
    const stop = connections.onChange((folders) => {
      const folder = folders.find((item) => item.root === root);
      if (folder && done(folder)) { clearTimeout(timer); stop(); resolve(folder); }
    });
  });
}
async function connect(web = make()) {
  const done = finished(web.platform.connections!, 'Library');
  await web.library.connectHandle(directory('Library', tree, state));
  await done;
  return web;
}

beforeEach(() => {
  db = memoryDb();
  analyse = vi.fn(async (buffer: ArrayBuffer) => ({
    duration: buffer.byteLength / 100, peaks: Array(48).fill(0.5), embedding: [new Uint8Array(buffer)[1], 1],
  }));
  state = { permission: 'granted', granted: 'granted', missing: false };
  tree = {
    Impacts: { 'hit.wav': { bytes: bytes(3), mtime: 1 }, 'same.wav': { bytes: bytes(3), mtime: 1 } },
    UI: { 'click.ogg': { bytes: bytes(5), mtime: 1 }, 'notes.txt': { bytes: bytes(9), mtime: 1 } },
  };
});
afterEach(() => vi.restoreAllMocks());

describe('web platform', () => {
  it('accepts desktop Chrome and Edge, but not narrow, mobile or other browsers', () => {
    expect(supportedWebEnvironment('Chrome/140.0', 1440)).toBe(true);
    expect(supportedWebEnvironment('Chrome/140.0 Edg/140.0', 1440)).toBe(true);
    expect(supportedWebEnvironment('Chrome/140.0', 390)).toBe(false);
    expect(supportedWebEnvironment('Chrome/140.0 Mobile', 1440)).toBe(false);
    expect(supportedWebEnvironment('Firefox/140.0', 1440)).toBe(false);
  });

  it('reads covers and pack.json through the folder handle, ignores bad ones, and keeps one cover URL per pack', async () => {
    const png = new Uint8Array(40);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 16, 0, 0, 0, 16]);
    const text = (value: string) => ({ bytes: new TextEncoder().encode(value), mtime: 1 });
    Object.assign(tree.Impacts, { 'cover.png': { bytes: png, mtime: 1 }, 'pack.json': text('{"name":"Hits","creator":"Kenney"}'), 'License.txt': text('CC0') });
    Object.assign(tree.UI, { 'cover.png': text('no image here, only text that is long enough'), 'pack.json': text('{ nope') });
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const web = await connect();
    const load = async () => Object.fromEntries((await web.platform.packs!.load()).map((pack) => [pack.id, pack]));
    const first = await load();
    expect(first['Library/Impacts']).toMatchObject({ name: 'Hits', creator: 'Kenney', licenseFile: true });
    expect(first['Library/Impacts'].cover).toMatch(/^blob:/);
    expect(first['Library/UI']).toEqual({ id: 'Library/UI' });
    const second = await load();
    expect(revoke).not.toHaveBeenCalled();
    expect(second['Library/Impacts'].cover).toBe(first['Library/Impacts'].cover);
  });

  it('leaves the cover of a folder that needs permission unread', async () => {
    const web = await connect();
    state.permission = 'prompt';
    const reopened = make();
    await reopened.platform.connections!.getFolders();
    expect(await reopened.platform.packs!.load()).toEqual([{ id: 'Library/Impacts' }, { id: 'Library/UI' }]);
    expect(web.platform.packs).toBeDefined();
  });

  it('computes 48 peaks between 0 and 1', () => {
    const peaks = computePeaks([Float32Array.from({ length: 480 }, (_, i) => (i < 240 ? -2 : 0.25))]);
    expect(peaks).toHaveLength(48);
    expect(peaks[0]).toBe(1);
    expect(peaks[47]).toBe(0.25);
  });

  it('analyses supported files once per content and persists folders and sounds', async () => {
    const web = await connect();
    expect(analyse).toHaveBeenCalledTimes(2);
    const [folder] = await web.platform.connections!.getFolders();
    expect(folder).toMatchObject({ root: 'Library', status: 'completed', completed: 3, failed: 0, skipped: 0 });
    expect(folder.fileCount).toBe(3);
    expect(folder).not.toHaveProperty('files');
    const reopened = make();
    const sounds = await reopened.platform.search!.loadSounds();
    expect(sounds.map((sound) => [sound.id, sound.packName])).toEqual([
      ['Library/Impacts/hit.wav', 'Impacts'], ['Library/Impacts/same.wav', 'Impacts'], ['Library/UI/click.ogg', 'UI'],
    ]);
    expect(sounds[0]).toMatchObject({ root: 'Library', duration: 1, addedAt: 1_000, peaks: Array(48).fill(0.5) });
    expect(sounds[0].fullHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sounds[0].fullHash).toBe(sounds[1].fullHash);
    expect((await reopened.platform.connections!.getFolders())[0].root).toBe('Library');
  });

  it('rescans without reading unchanged files and reuses analyses of moved or touched files', async () => {
    const web = await connect();
    analyse.mockClear();
    const reads = vi.spyOn(Blob.prototype, 'arrayBuffer');
    await web.platform.connections!.rescanFolder('Library');
    expect(reads).not.toHaveBeenCalled();
    expect(analyse).not.toHaveBeenCalled();
    (tree.UI as Tree)['click.ogg'] = { bytes: bytes(5), mtime: 2 };
    (tree.Impacts as Tree)['renamed.wav'] = (tree.Impacts as Tree)['hit.wav'];
    delete (tree.Impacts as Tree)['hit.wav'];
    await web.platform.connections!.rescanFolder('Library');
    expect(reads).toHaveBeenCalled();
    expect(analyse).not.toHaveBeenCalled();
    (tree.UI as Tree)['click.ogg'] = { bytes: bytes(7), mtime: 3 };
    await web.platform.connections!.rescanFolder('Library');
    expect(analyse).toHaveBeenCalledOnce();
    const ids = (await web.platform.search!.loadSounds()).map((sound) => sound.id);
    expect(ids).toEqual(['Library/Impacts/renamed.wav', 'Library/Impacts/same.wav', 'Library/UI/click.ogg']);
  });

  it('recomputes stored pack assignments on opening and ignores a stored depth', async () => {
    await connect();
    for (const row of await db.all<{ id: string }>('sounds')) await db.put('sounds', row.id, { ...row, packId: 'stale', packName: 'stale' });
    const record = await db.get<{ view: object }>('folders', 'Library');
    await db.put('folders', 'Library', { ...record, view: { ...record!.view, packDepth: 0 } });
    // Without permission no rescan runs, so only the recomputation can repair the rows.
    state.permission = 'prompt';
    const sounds = await make().platform.search!.loadSounds();
    expect(sounds.map((sound) => sound.packName)).toEqual(['Impacts', 'Impacts', 'UI']);
  });

  it('downloads the classify decisions as the CSV of the Mac app', async () => {
    const web = await connect();
    const [sound] = (await web.platform.classify!.overview()).sounds;
    await web.platform.classify!.decide([sound.fullHash], { category: 'METAL' });
    const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('document', { createElement: () => link, body: { append: vi.fn() } });
    const created = vi.spyOn(URL, 'createObjectURL');
    await expect(web.platform.classify!.exportCsv()).resolves.toBe('decisions.csv');
    vi.unstubAllGlobals();
    expect(link.download).toBe('decisions.csv');
    expect(link.click).toHaveBeenCalledOnce();
    const blob = created.mock.calls[0][0] as Blob;
    expect(await blob.text()).toBe(`fullSha256,decision\r\n${sound.fullHash},"{""category"":""METAL""}"\r\n`);
  });

  it('maps a permission the browser must ask again to needsPermission, and reauthorizes', async () => {
    await connect();
    state.permission = 'prompt';
    const web = make();
    const [folder] = await web.platform.connections!.getFolders();
    expect(folder).toMatchObject({ status: 'stopped', needsPermission: true });
    const sounds = await web.platform.search!.loadSounds();
    expect(sounds).toHaveLength(3);
    expect(sounds.every((sound) => sound.blockedReason)).toBe(true);
    await expect(web.platform.search!.play(sounds[0], new AbortController().signal)).rejects.toThrow();
    const done = finished(web.platform.connections!, 'Library');
    await web.platform.connections!.reauthorize!('Library');
    expect(await done).not.toHaveProperty('needsPermission', true);
    expect((await web.platform.search!.loadSounds()).some((sound) => sound.blockedReason)).toBe(false);
  });

  it('keeps a refused folder waiting for permission', async () => {
    await connect();
    state.permission = 'prompt';
    state.granted = 'denied';
    const web = make();
    await expect(web.platform.connections!.reauthorize!('Library')).rejects.toThrow();
    expect((await web.platform.connections!.getFolders())[0].needsPermission).toBe(true);
  });

  it('keeps sounds listed but blocked when the folder cannot be read', async () => {
    const web = await connect();
    state.missing = true;
    await web.platform.connections!.rescanFolder('Library');
    expect((await web.platform.connections!.getFolders())[0]).toMatchObject({ status: 'stopped', offline: true, failure: 'folder' });
    const sounds = await web.platform.search!.loadSounds();
    expect(sounds).toHaveLength(3);
    expect(sounds.every((sound) => sound.blockedReason)).toBe(true);
  });

  it('maps a dropped file to its library sound by name and size, then by hash', async () => {
    const web = await connect();
    const search = web.platform.search!;
    expect(await search.soundIdForFile!(new File([bytes(5) as BlobPart], 'click.ogg'))).toBe('Library/UI/click.ogg');
    expect(await search.soundIdForFile!(new File([bytes(5) as BlobPart], 'click copy.ogg'))).toBe('Library/UI/click.ogg');
    expect(await search.soundIdForFile!(new File([bytes(11) as BlobPart], 'click.ogg'))).toBeUndefined();
  });

  it('keeps favorites and collections when a folder is removed', async () => {
    const web = await connect();
    const collections = web.platform.collections!;
    expect(await collections.load()).toEqual({ collections: [], searches: [], favorites: [] });
    const [sound] = await web.platform.search!.loadSounds();
    const data = {
      collections: [{ id: 'c', name: '타격', entries: [{ kind: 'sound' as const, hash: sound.fullHash!, path: sound.relativePath }] }],
      searches: [], favorites: [sound.fullHash!],
    };
    await collections.save(data);
    await web.platform.connections!.removeFolder('Library');
    expect(await web.platform.search!.loadSounds()).toEqual([]);
    expect(await web.platform.connections!.getFolders()).toEqual([]);
    expect(await make().platform.collections!.load()).toEqual(data);
  });

  it('keeps classify decisions in browser storage and never replaces a chosen category', async () => {
    const web = await connect();
    const [sound] = (await web.platform.classify!.overview()).sounds;
    await web.platform.classify!.decide([sound.fullHash], { category: 'METAL' });
    await web.platform.classify!.decide([sound.fullHash], { category: 'WOOD' });
    const reopened = await make().platform.classify!.overview();
    expect(reopened.sounds.find((item) => item.id === sound.id)).toMatchObject({ state: 'human', category: 'METAL' });
  });

  it('posts the relay contract to the same origin and passes result_count through', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      english_queries: ['A metal impact.'], name_keywords: [], min_duration_seconds: null,
      max_duration_seconds: 2, explanation: '짧은 충돌 소리를 찾습니다.', result_count: 5,
    })));
    vi.stubGlobal('fetch', fetch);
    const result = await make().platform.search!.plan({ text: '짧은 충돌 5개', hasReference: true, referenceDuration: 3 }, new AbortController().signal);
    vi.unstubAllGlobals();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/plan');
    expect(JSON.parse(init.body as string)).toEqual({
      text: '짧은 충돌 5개', has_reference: true, reference_duration_seconds: 3, previous_plan: null,
    });
    expect(result).toMatchObject({ length: { max: 2 }, count: 5, message: '짧은 충돌 소리를 찾습니다.' });
  });
});
