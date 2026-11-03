import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store, type StoreItem } from './store';

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const item: StoreItem = {
  id: 'sound-1',
  fullSha256: hash,
  paths: [{ folderId: 'library', path: '/library/sound.wav' }],
};
let directory: string;
let store: Store;

beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), 'proto1-store-'));
  store = new Store(directory);
});

afterEach(() => {
  store.flush();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('JSON storage', () => {
  it.each(['count', 'time', 'human'] as const)('persists pending analysis on %s without losing immediate reads', (trigger) => {
    vi.useFakeTimers();
    const entries = Array.from({ length: 50 }, (_, id) => ({ ...item, id: String(id) }));
    store.saveItems(entries);
    const vector = new Float32Array(512).fill(0.5);
    store.saveAnalysis({ ...entries[0], duration: 2 }, vector);
    expect(store.getEmbedding('0')).toEqual(vector);
    expect(new Store(directory).getEmbedding('0')).toBeUndefined();
    switch (trigger) {
      case 'count':
        for (const entry of entries.slice(1)) store.saveAnalysis({ ...entry, duration: 2 }, vector);
        break;
      case 'time': vi.advanceTimersByTime(5_000); break;
      case 'human': store.saveItems(store.loadItems().data.slice(0, 1)); break;
    }
    const reopened = new Store(directory);
    expect(reopened.getEmbedding('0')).toEqual(vector);
    expect(reopened.loadItems().data[0].duration).toBe(2);
  });

  it('recovers items from backup once and preserves that version through the next save', () => {
    store.saveItems([item]);
    store.saveItems([]);
    fs.writeFileSync(join(directory, 'items.json'), '{');
    const recovered = new Store(directory);
    expect(recovered.loadItems().data).toEqual([item]);
    expect(recovered.loadItems().warnings).toHaveLength(1);
    const read = vi.spyOn(fs, 'readFileSync');
    recovered.loadItems();
    expect(read).not.toHaveBeenCalled();
    recovered.saveItems([{ ...item, duration: 3 }]);
    expect(JSON.parse(fs.readFileSync(join(directory, 'items.json.bak'), 'utf8'))).toEqual([item]);
  });

  it('leaves durations committed when interrupted before vector append', () => {
    store.saveItems([item]);
    store.saveAnalysis({ ...item, duration: 2 }, new Float32Array(512).fill(0.5));
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('interrupted'); });
    expect(() => store.flush()).toThrow('interrupted');
    const reopened = new Store(directory);
    expect(reopened.loadItems().data[0].duration).toBe(2);
    expect(reopened.getEmbedding(item.id)).toBeUndefined();
    append.mockRestore();
  });

  it('flushes pending durations before removing a folder and restores them when reconnected', () => {
    store.saveItems([item]);
    store.saveAnalysis({ ...item, duration: 2 }, new Float32Array(512).fill(0.5));
    store.removeFolder('library');
    const reopened = new Store(directory);
    reopened.saveItems([item]);
    expect(reopened.loadItems().data[0].duration).toBe(2);
    expect(reopened.getEmbedding(item.id)).toEqual(new Float32Array(512).fill(0.5));
  });
  it('keeps waveform peaks and addedAt with the item', () => {
    store.saveItems([{ ...item, peaks: [0, 50, 100], addedAt: 1234 }]);
    expect(new Store(directory).loadItems().data[0]).toMatchObject({ peaks: [0, 50, 100], addedAt: 1234 });
  });

  it('saves favourites, still reads collections written before v3 and ignores an old used.json', () => {
    fs.writeFileSync(join(directory, 'used.json'), JSON.stringify([hash]));
    fs.writeFileSync(join(directory, 'collections.json'), JSON.stringify({ collections: [], searches: [] }));
    expect(store.loadCollections().data).toEqual({ collections: [], searches: [] });
    store.saveCollections({ collections: [], searches: [], favorites: [hash] });
    expect(new Store(directory).loadCollections().data.favorites).toEqual([hash]);
    expect(() => store.saveCollections({ collections: [], searches: [], favorites: [7 as never] })).toThrow();
  });

  it('round trips items and decisions without touching library paths', () => {
    const write = vi.spyOn(fs, 'writeFileSync');
    store.saveItems([item]);
    store.saveDecision(hash, { category: 'METAL', used: true });
    const reopened = new Store(directory);
    expect(reopened.loadItems()).toEqual({ data: [item], warnings: [] });
    expect(reopened.loadDecisions()).toEqual({
      data: { [hash]: { category: 'METAL', used: true } }, warnings: [],
    });
    expect(write.mock.calls.every(([path]) => String(path).startsWith(directory + '/'))).toBe(true);
  });

  it('keeps exactly the previous committed JSON version', () => {
    store.saveItems([item]);
    store.saveItems([]);
    store.saveItems([item]);
    expect(JSON.parse(fs.readFileSync(join(directory, 'items.json.bak'), 'utf8'))).toEqual([]);
    expect(fs.readdirSync(directory).sort()).toEqual(['items.json', 'items.json.bak']);
  });

  it('reads the committed version after interruption before replacement', () => {
    store.saveDecision(hash, 'METAL');
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === join(directory, 'decisions.json')) throw new Error('simulated termination');
      rename(from, to);
    });
    expect(() => store.saveDecision(hash, 'WOOD')).toThrow('simulated termination');
    expect(fs.existsSync(join(directory, 'decisions.json.tmp'))).toBe(true);
    expect(new Store(directory).loadDecisions().data).toEqual({ [hash]: 'METAL' });
  });

  it.each(['{broken', 'null'])('recovers a corrupt decision file (%s) and warns', (broken) => {
    store.saveDecision(hash, 'METAL');
    store.saveDecision(hash, 'WOOD');
    fs.writeFileSync(join(directory, 'decisions.json'), broken);
    const recovered = new Store(directory);
    expect(recovered.loadDecisions().data).toEqual({ [hash]: 'METAL' });
    expect(recovered.loadDecisions().warnings).toHaveLength(1);
    recovered.saveDecision(otherHash, 'WATER');
    fs.writeFileSync(join(directory, 'decisions.json'), broken);
    expect(new Store(directory).loadDecisions().data).toEqual({ [hash]: 'METAL' });
  });

  it('uses the previous items when the current file is missing', () => {
    store.saveItems([item]);
    store.saveItems([]);
    fs.unlinkSync(join(directory, 'items.json'));
    const loaded = new Store(directory).loadItems();
    expect(loaded.data).toEqual([item]);
    expect(loaded.warnings).toHaveLength(1);
  });

  it('does not silently erase decisions when both versions are broken', () => {
    store.saveDecision(hash, 'METAL');
    store.saveDecision(hash, 'WOOD');
    fs.writeFileSync(join(directory, 'decisions.json'), '{');
    fs.writeFileSync(join(directory, 'decisions.json.bak'), '{');
    expect(() => new Store(directory).loadDecisions()).toThrow();
    expect(() => store.saveDecision(otherHash, 'WATER')).toThrow();
  });

  it('removes only selected folder paths and preserves decisions by full hash', () => {
    store.saveItems([item, {
      ...item, id: 'sound-2', fullSha256: otherHash,
      paths: [...item.paths, { folderId: 'other', path: '/other/sound.wav' }],
    }]);
    store.saveDecision(hash, 'METAL');
    store.removeFolder('library');
    const reopened = new Store(directory);
    expect(reopened.loadItems().data).toEqual([{
      ...item, id: 'sound-2', fullSha256: otherHash,
      paths: [{ folderId: 'other', path: '/other/sound.wav' }],
    }]);
    expect(reopened.loadDecisions().data).toEqual({ [hash]: 'METAL' });
    reopened.saveItems([{ ...item, id: 'new-id' }]);
    expect(reopened.loadDecisions().data[hash]).toBe('METAL');
    expect(reopened.loadDecisions().data[otherHash]).toBeUndefined();
  });

  it('keeps collection references after the referenced item disappears', () => {
    const data = {
      collections: [{ id: '1', name: '카툰느낌', entries: [{ kind: 'sound' as const, hash, path: 'sound.wav' }] }],
      searches: [{ id: '2', name: '금속', query: '금속', sentences: ['metal'], names: [] }],
    };
    expect(store.loadCollections().data).toEqual({ collections: [], searches: [] });
    store.saveItems([item]);
    store.saveCollections(data);
    store.removeFolder('library');
    expect(new Store(directory).loadCollections().data).toEqual(data);
    expect(() => store.saveCollections({ collections: [{}], searches: [] } as never)).toThrow();
  });

  it('exports all decisions as escaped CSV inside app data', () => {
    store.saveDecision(hash, { category: '금속,"충돌"\n잔향' });
    store.saveDecision(otherHash, 'WOOD');
    const path = store.exportDecisionsCsv();
    const cell = JSON.stringify({ category: '금속,"충돌"\n잔향' }).replaceAll('"', '""');
    expect(path).toBe(join(directory, 'decisions.csv'));
    expect(fs.readFileSync(path, 'utf8')).toBe(
      `fullSha256,decision\r\n${hash},"${cell}"\r\n${otherHash},"""WOOD"""\r\n`,
    );
  });

  it('rejects a decision key that is not a full SHA-256', () => {
    expect(() => store.saveDecision('/library/sound.wav', 'METAL')).toThrow();
    expect(store.loadDecisions().data).toEqual({});
  });
});

describe('append-only coordinates', () => {
  it('appends 1000 vectors without rewriting and finds them by item ID after reopening', () => {
    const write = vi.spyOn(fs, 'writeFileSync');
    const append = vi.spyOn(fs, 'appendFileSync');
    for (let i = 0; i < 1000; i++) {
      store.appendEmbedding(`sound-${i}`, new Float32Array(512).fill(i / 1000));
    }
    // Node's appendFileSync delegates to writeFileSync with flag "a".
    expect(write.mock.calls.every(([, , options]) =>
      typeof options === 'object' && options !== null && options.flag === 'a')).toBe(true);
    expect(append).toHaveBeenCalledTimes(1000);
    expect(new Set(append.mock.calls.map(([path]) => path)).size).toBe(1);
    expect(append.mock.calls.every(([, data]) => String(data).trim().split('\n').length === 1)).toBe(true);
    expect(fs.statSync(join(directory, 'embeddings.jsonl')).size).toBe(
      append.mock.calls.reduce((total, [, data]) => total + Buffer.byteLength(String(data)), 0),
    );
    const reopened = new Store(directory);
    for (const i of [0, 499, 999]) {
      expect(reopened.getEmbedding(`sound-${i}`)).toEqual(new Float32Array(512).fill(i / 1000));
    }
    expect(reopened.getEmbedding('missing')).toBeUndefined();
  });

  it('keeps prior bytes and returns the latest vector for a repeated ID', () => {
    store.appendEmbedding('sound', new Float32Array(512).fill(1));
    const path = join(directory, 'embeddings.jsonl');
    const previous = fs.readFileSync(path);
    store.appendEmbedding('sound', new Float32Array(512).fill(2));
    expect(fs.readFileSync(path).subarray(0, previous.length)).toEqual(previous);
    expect(new Store(directory).getEmbedding('sound')).toEqual(new Float32Array(512).fill(2));
  });

  it('recovers complete records after an interrupted append and can append again', () => {
    store.appendEmbedding('first', new Float32Array(512).fill(1));
    fs.appendFileSync(join(directory, 'embeddings.jsonl'), '{"id":"unfinished"');
    const reopened = new Store(directory);
    expect(reopened.warnings).toHaveLength(1);
    expect(reopened.getEmbedding('first')).toEqual(new Float32Array(512).fill(1));
    reopened.appendEmbedding('last', new Float32Array(512).fill(2));
    expect(new Store(directory).getEmbedding('last')).toEqual(new Float32Array(512).fill(2));
  });

  it('rejects malformed vectors without writing a record', () => {
    expect(() => store.appendEmbedding('sound', new Float32Array(511))).toThrow();
    expect(() => store.appendEmbedding('sound', new Float32Array(512).fill(NaN))).toThrow();
    expect(fs.existsSync(join(directory, 'embeddings.jsonl'))).toBe(false);
  });
});
