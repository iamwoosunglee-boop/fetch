import { describe, expect, it } from 'vitest';
import type { SearchSound } from '../search';
import {
  addEntry, folderEntry, inCollection, isCollectionData, removeEntry, resolveEntries, soundEntry,
  type Collection,
} from '.';

const sound = (relativePath: string, fullHash: string, root = '/lib'): SearchSound => ({
  id: fullHash, relativePath, fullHash, root, packId: root, duration: 1,
});
const whoosh = sound('Cartoon/Whoosh/a.wav', 'a');
const hit = sound('Cartoon/Hit/b.wav', 'b');
const other = sound('Cartoon/Hit/b.wav', 'c', '/other');

describe('collection entries', () => {
  it('matches a sound by hash after it moves, and a folder by root and whole path segments', () => {
    const collection: Collection = { id: '1', name: '카툰느낌', entries: [
      soundEntry(whoosh)!, folderEntry(hit)!,
    ] };
    expect(inCollection(collection, sound('Moved/renamed.wav', 'a'))).toBe(true);
    expect(inCollection(collection, hit)).toBe(true);
    expect(inCollection(collection, sound('Cartoon/Hit/deep/d.wav', 'd'))).toBe(true);
    expect(inCollection(collection, sound('Cartoon/Hitter/d.wav', 'd'))).toBe(false);
    expect(inCollection(collection, other)).toBe(false);
  });

  it('treats a file directly below the connected folder as the whole connected folder', () => {
    const entry = folderEntry(sound('top.wav', 't'))!;
    expect(entry).toEqual({ kind: 'folder', root: '/lib', path: '' });
    expect(inCollection({ id: '1', name: '전체', entries: [entry] }, hit)).toBe(true);
  });

  it('does not duplicate an entry and removes only the chosen one', () => {
    const first = soundEntry(whoosh)!;
    const second = folderEntry(hit)!;
    const entries = addEntry(addEntry([first], first), second);
    expect(entries).toEqual([first, second]);
    expect(removeEntry(entries, first)).toEqual([second]);
  });

  it('keeps missing targets with their last path and shows the current path of moved sounds', () => {
    const collection: Collection = { id: '1', name: '모음', entries: [
      soundEntry(whoosh)!, soundEntry(hit)!, folderEntry(sound('Gone/x.wav', 'x'))!,
    ] };
    expect(resolveEntries(collection, [sound('Moved/a.wav', 'a')])).toEqual([
      { entry: collection.entries[0], path: 'Moved/a.wav', available: true, soundCount: 1 },
      { entry: collection.entries[1], path: 'Cartoon/Hit/b.wav', available: false, soundCount: 0 },
      { entry: collection.entries[2], path: 'Gone', available: false, soundCount: 0 },
    ]);
  });
});

describe('saved data shape', () => {
  it('accepts references and conditions, and rejects malformed entries', () => {
    const valid = { collections: [{ id: '1', name: '모음', entries: [soundEntry(whoosh)] }], searches: [{
      id: '2', name: '금속', query: '금속', sentences: ['metal'], names: [], length: { max: 1 },
      reference: { name: 'a.wav', duration: 1, embedding: [1, 0] }, collectionId: '1',
    }] };
    expect(isCollectionData(valid)).toBe(true);
    expect(isCollectionData({ collections: [{ id: '1', name: 'x', entries: [{ kind: 'tag' }] }], searches: [] })).toBe(false);
    expect(isCollectionData({ ...valid, searches: [{ ...valid.searches[0], length: { max: 'x' } }] })).toBe(false);
    expect(isCollectionData({ collections: [] })).toBe(false);
    expect(isCollectionData({ ...valid, favorites: ['a'.repeat(64)] })).toBe(true);
    expect(isCollectionData({ ...valid, favorites: 'a' })).toBe(false);
    expect(isCollectionData({ ...valid, favorites: [1] })).toBe(false);
    expect(isCollectionData({ ...valid, favorites: [''] })).toBe(false);
  });
});
