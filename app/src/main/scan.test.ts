import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintFile, scanLibrary } from './scan';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), readdir: vi.fn(actual.readdir) };
});

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), 'proto1-scan-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function snapshot(directory: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = path.join(directory, entry.name);
    const stat = await fs.lstat(filePath);
    result.push([filePath, stat.size, stat.mtimeMs]);
    if (entry.isDirectory()) result.push(...await snapshot(filePath));
  }
  return result;
}

describe('read-only library scanning', () => {
  it('scans five supported files recursively, preserving identities after moves and renames', async () => {
    await fs.mkdir(path.join(root, 'pack'));
    for (const [index, extension] of ['wav', 'MP3', 'ogg', 'flac', 'WAV'].entries()) {
      await fs.writeFile(path.join(root, `sound${index}.${extension}`), `sound ${index}`);
    }
    await fs.writeFile(path.join(root, 'ignored.txt'), 'not audio');
    const before = await snapshot(root);
    const first = await scanLibrary(root);
    expect(first.status).toBe('completed');
    expect(first.items).toHaveLength(5);
    expect(await snapshot(root)).toEqual(before);
    await fs.rename(path.join(root, 'sound0.wav'), path.join(root, 'pack', 'renamed.wav'));
    const moved = await snapshot(root);
    const second = await scanLibrary(root, first.items);
    expect(second.status).toBe('completed');
    expect(second.items.map((item) => item.id).sort()).toEqual(first.items.map((item) => item.id).sort());
    expect(second.items).toHaveLength(5);
    expect(second.items.flatMap((item) => item.paths).some((entry) => entry.path.endsWith('/pack/renamed.wav'))).toBe(true);
    expect(await snapshot(root)).toEqual(moved);
  });

  it('hashes the first and last 64 KiB and the entire file', async () => {
    const bytes = Buffer.alloc(200_000, 7);
    bytes[80_000] = 3;
    const filePath = path.join(root, 'a.wav');
    await fs.writeFile(filePath, bytes);
    expect(await fingerprintFile(filePath)).toEqual({
      edgeSha256: sha(Buffer.concat([bytes.subarray(0, 65_536), bytes.subarray(-65_536)])),
      sha256: sha(bytes),
    });
  });

  it('hashes short and empty files without padding', async () => {
    for (const bytes of [Buffer.from('abc'), Buffer.alloc(0)]) {
      const filePath = path.join(root, 'short.wav');
      await fs.writeFile(filePath, bytes);
      expect(await fingerprintFile(filePath)).toEqual({
        edgeSha256: sha(Buffer.concat([bytes, bytes])), sha256: sha(bytes),
      });
    }
  });

  it('does not open unchanged files for content reads', async () => {
    await fs.writeFile(path.join(root, 'a.wav'), 'abc');
    const first = await scanLibrary(root);
    const open = vi.mocked(fs.open);
    open.mockClear();
    const second = await scanLibrary(root, first.items);
    expect(second.items).toEqual(first.items);
    expect(open).not.toHaveBeenCalled();
  });

  it('does not merge equal-size files whose middle alone changed', async () => {
    const filePath = path.join(root, 'a.wav');
    const bytes = Buffer.alloc(200_000, 1);
    await fs.writeFile(filePath, bytes);
    const first = await scanLibrary(root);
    bytes[90_000] = 2;
    await fs.writeFile(filePath, bytes);
    await fs.utimes(filePath, new Date(1000), new Date(2000));
    const second = await scanLibrary(root, first.items);
    expect(second.items[0].edgeSha256).toBe(first.items[0].edgeSha256);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(second.items[0].sha256).toBe(sha(bytes));
  });

  it('retains all paths of identical copies', async () => {
    await fs.writeFile(path.join(root, 'a.wav'), 'same');
    await fs.writeFile(path.join(root, 'b.flac'), 'same');
    const result = await scanLibrary(root);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].paths).toHaveLength(2);
    expect(result.fileCount).toBe(2);
  });

  it('stops and preserves existing items when the connected directory disappears', async () => {
    await fs.writeFile(path.join(root, 'a.wav'), 'abc');
    const first = await scanLibrary(root);
    await fs.rm(root, { recursive: true });
    const second = await scanLibrary(root, first.items);
    expect(second.status).toBe('stopped');
    expect(second.items).toBe(first.items);
    expect(second.missing).toEqual([]);
    expect(second.reason).toBeTruthy();
  });

  describe('unreadable entries below the connected folder', () => {
    const locked: string[] = [];
    const lock = async (target: string) => { await fs.chmod(target, 0o000); locked.push(target); };
    afterEach(async () => {
      await Promise.all(locked.splice(0).map((target) => fs.chmod(target, 0o700)));
    });

    it('skips and counts a locked subfolder, and finishes the rest', async () => {
      await fs.mkdir(path.join(root, 'locked'));
      await fs.writeFile(path.join(root, 'locked', 'hidden.wav'), 'hidden');
      await fs.writeFile(path.join(root, 'a.wav'), 'abc');
      await lock(path.join(root, 'locked'));
      const result = await scanLibrary(root);
      expect(result.status).toBe('completed');
      expect(result.items).toHaveLength(1);
      expect(result.unreadableCount).toBe(1);
    });

    it('does not enter hidden system folders or count them', async () => {
      await fs.mkdir(path.join(root, '.Spotlight-V100'));
      await lock(path.join(root, '.Spotlight-V100'));
      await fs.mkdir(path.join(root, '.Trashes'));
      await fs.writeFile(path.join(root, '.Trashes', 'thrown.wav'), 'thrown');
      await fs.writeFile(path.join(root, 'a.wav'), 'abc');
      const result = await scanLibrary(root);
      expect(result.status).toBe('completed');
      expect(result.items.flatMap((item) => item.paths).map((entry) => path.basename(entry.path))).toEqual(['a.wav']);
      expect(result.unreadableCount).toBe(0);
    });

    it('keeps saved entries of a folder that cannot be read this time', async () => {
      await fs.mkdir(path.join(root, 'locked'));
      await fs.writeFile(path.join(root, 'locked', 'kept.wav'), 'kept');
      await fs.writeFile(path.join(root, 'a.wav'), 'abc');
      const first = await scanLibrary(root);
      await lock(path.join(root, 'locked'));
      await fs.rm(path.join(root, 'a.wav'));
      const second = await scanLibrary(root, first.items);
      expect(second.status).toBe('completed');
      const kept = first.items.find((item) => item.paths[0].path.endsWith('kept.wav'))!;
      expect(second.items).toEqual([kept]);
      expect(second.missing.map((item) => item.paths[0].path)).toEqual([path.join(root, 'a.wav')]);
      expect(second.fileCount).toBe(1);
    });

    it('keeps a saved file whose content cannot be read, and skips a new one', async () => {
      await fs.writeFile(path.join(root, 'kept.wav'), 'kept');
      const first = await scanLibrary(root);
      await fs.writeFile(path.join(root, 'kept.wav'), 'edited but unreadable');
      await fs.writeFile(path.join(root, 'new.wav'), 'new');
      await lock(path.join(root, 'kept.wav'));
      await lock(path.join(root, 'new.wav'));
      const second = await scanLibrary(root, first.items);
      expect(second.status).toBe('completed');
      expect(second.items).toEqual(first.items);
      expect(second.missing).toEqual([]);
      expect(second.unreadableCount).toBe(2);
    });

    it('still stops when the connected folder goes away during the walk', async () => {
      await fs.mkdir(path.join(root, 'sub'));
      await fs.writeFile(path.join(root, 'sub', 'a.wav'), 'abc');
      const first = await scanLibrary(root);
      const readdir = vi.mocked(fs.readdir);
      const actual = readdir.getMockImplementation()!;
      const lost = Object.assign(new Error('gone'), { code: 'EIO' });
      readdir.mockImplementation((async (folder: string, options: never) => {
        if (folder !== root || readdir.mock.calls.filter(([entry]) => entry === root).length > 1) throw lost;
        return actual(folder, options);
      }) as never);
      const second = await scanLibrary(root, first.items);
      readdir.mockImplementation(actual);
      expect(second.status).toBe('stopped');
      expect(second.items).toBe(first.items);
      expect(second.missing).toEqual([]);
    });
  });

  it('does not treat AppleDouble files as sounds', async () => {
    await fs.writeFile(path.join(root, 'kick.wav'), 'abc');
    await fs.writeFile(path.join(root, '._kick.wav'), 'resource fork');
    const result = await scanLibrary(root);
    expect(result.fileCount).toBe(1);
    expect(result.items[0].paths[0].path).toBe(path.join(root, 'kick.wav'));
  });

  it('keeps oversized files listed and counted without making them embedding candidates', async () => {
    const filePath = path.join(root, 'large.wav');
    await fs.writeFile(filePath, '');
    await fs.truncate(filePath, 100_000_001);
    const result = await scanLibrary(root);
    expect(result.status).toBe('completed');
    expect(result.fileCount).toBe(1);
    expect(result.oversizedCount).toBe(1);
    expect(result.items[0].embeddingEligible).toBe(false);
  });
});
