import { describe, expect, it } from 'vitest';
import type { SearchSound } from '../../core/search';
import { applyFilters, describePacks, packSummary, topKinds, uniqueSounds } from './library';
import { folderInPack, seconds, shortPackNames, tenths } from './format';

const row = (id: string, packId: string, extra: Partial<SearchSound> = {}): SearchSound =>
  ({ id, relativePath: `${id}.wav`, packId, duration: 1, fullHash: 'same', ...extra });

it('merges identical files into one sound that keeps every pack and row id', () => {
  const merged = uniqueSounds([row('a', 'one'), row('b', 'two'), row('c', 'one')]);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ id: 'a', packId: 'one', packIds: ['one', 'two'], mergedIds: ['a', 'b', 'c'] });
});

it('prefers a reachable path over a blocked one', () => {
  const merged = uniqueSounds([row('a', 'one', { blockedReason: 'offline' }), row('b', 'two')]);
  expect(merged[0]).toMatchObject({ id: 'b', packIds: ['one', 'two'] });
  expect(merged[0].blockedReason).toBeUndefined();
});

it('keeps sounds with different content apart', () => {
  expect(uniqueSounds([row('a', 'one', { fullHash: 'x' }), row('b', 'one', { fullHash: undefined })])).toHaveLength(2);
});

it('counts a sound that lives in two packs in both, and the same content once inside one pack', () => {
  const rows = [row('a', 'one'), row('b', 'two'), row('c', 'one')];
  const packs = describePacks(rows);
  expect([...packs.values()].map((pack) => [pack.id, pack.count])).toEqual([['one', 1], ['two', 1]]);
});

it('finds a merged sound under every pack that holds it', () => {
  const [merged] = uniqueSounds([row('a', 'one'), row('b', 'two')]);
  const filters = { kinds: new Set<string>(), favorites: false, query: '' };
  expect(applyFilters([merged], { ...filters, packs: new Set(['two']) }, new Map(), new Set())).toHaveLength(1);
  expect(applyFilters([merged], { ...filters, packs: new Set(['three']) }, new Map(), new Set())).toHaveLength(0);
});

it('takes the pack.json name, keeps the folder name and leaves the row itself alone', () => {
  const rows = [row('a', 'one', { packName: 'kenney-rpg-audio' })];
  const packs = describePacks(rows, new Map([['one', { id: 'one', name: 'RPG', cover: 'data:x' }]]));
  expect(packs.get('one')).toMatchObject({ name: 'RPG', full: 'kenney-rpg-audio', code: 'RP', cover: 'data:x' });
  expect(rows[0].packName).toBe('kenney-rpg-audio');
});

describe('shortPackNames', () => {
  const short = (...names: string[]) => shortPackNames(names.map((full) => ({ full })));

  it('drops a first word at least half of the packs share, and trailing filler, and nothing translated', () => {
    expect(short('kenney-rpg-audio', 'kenney-impact-sounds', 'meta-oculus-audio-pack', 'Sci-Fi Sounds'))
      .toEqual(['rpg', 'impact', 'meta-oculus', 'Sci-Fi']);
  });

  it('keeps a first word fewer than half of the packs share, and every number', () => {
    const names = ['Lenno & Leevi Nu-Disco Yacht Rock', 'Lenno Nu Disco 2', 'Serum 2 Minimal Deep Tech House',
      'Serum 2 Melodic House Essentials Volume 5', 'Night Rider 2', 'Essential Techno Vol. 2', 'Advanced UI'];
    expect(short(...names)).toEqual(names);
  });

  it('keeps a word that is all a name has', () => {
    expect(short('audio', 'pack-2')).toEqual(['audio', 'pack-2']);
  });

  it('keeps what tells two packs apart', () => {
    expect(short('kenney-rpg-sounds', 'kenney-rpg-sounds-2')).toEqual(['rpg', 'rpg-sounds-2']);
    expect(short('drums-audio', 'drums-sfx')).toEqual(['drums-audio', 'drums-sfx']);
  });

  it('falls back to the folder name when no word tells them apart', () => {
    expect(short('kenney-ui', 'kenney_ui')).toEqual(['kenney-ui', 'kenney_ui']);
  });

  it('never shortens a pack.json name', () => {
    expect(shortPackNames([{ full: 'kenney-rpg-audio', name: 'RPG Sounds' }])).toEqual(['RPG Sounds']);
  });

  it('falls back to the full name when two packs would read the same, pack.json names included', () => {
    expect(shortPackNames([{ full: 'kenney-rpg-audio', name: 'RPG' }, { full: 'old-rpg-pack', name: 'RPG' }])).toEqual(['kenney-rpg-audio', 'old-rpg-pack']);
    expect(shortPackNames([{ full: 'kenney-rpg-audio', name: 'RPG' }, { full: 'rpg' }])).toEqual(['kenney-rpg-audio', 'rpg']);
  });
});

describe('applyFilters', () => {
  const filters = { packs: new Set<string>(), kinds: new Set<string>(), favorites: false, query: '' };
  const named = (relativePath: string, duration = 1) => row(relativePath, 'one', { relativePath, duration, fullHash: relativePath });

  it('matches the last word by its start and the others whole; quotes keep whole words', () => {
    const sounds = [named('footstep_snow_000.ogg'), named('snowball.ogg')];
    const found = (query: string) => applyFilters(sounds, { ...filters, query }, new Map(), new Set()).map((sound) => sound.relativePath);
    expect(found('foot')).toEqual(['footstep_snow_000.ogg']);
    expect(found('footstep sno')).toEqual(['footstep_snow_000.ogg']);
    expect(found('foot snow')).toEqual([]);
    expect(found('"foot"')).toEqual([]);
    expect(found('"footstep"')).toEqual(['footstep_snow_000.ogg']);
  });

  it('leaves a sound of unknown length out of every length filter', () => {
    const sounds = [named('known.wav', 0.4), named('unknown.wav', 0)];
    const found = (extra: Partial<Parameters<typeof applyFilters>[1]>) => applyFilters(sounds, { ...filters, ...extra }, new Map(), new Set()).map((sound) => sound.relativePath);
    expect(found({ length: 'short' })).toEqual(['known.wav']);
    expect(found({ range: { max: 1 } })).toEqual(['known.wav']);
    expect(found({ range: { min: 0 } })).toEqual(['known.wav']);
  });
});

it('finds the folders between a sound and its pack, and none for a file directly in it', () => {
  const sound = (relativePath: string, packId = '/lib/Pack') => row('a', packId, { root: '/lib', relativePath });
  expect(folderInPack(sound('Pack/WAV/Ambience/a.wav'))).toBe('WAV/Ambience');
  expect(folderInPack(sound('Pack/a.wav'))).toBe('');
  expect(folderInPack(sound('WAV/a.wav', '/lib'))).toBe('WAV');
});

it('writes lengths with two decimals up to a minute, and the player clock in tenths', () => {
  expect([seconds(1.36), seconds(59.5), seconds(72.4), seconds(1800)]).toEqual(['1.36초', '59.50초', '1:12', '30:00']);
  expect([tenths(1.36), tenths(2), tenths(0.04)]).toEqual(['1.4', '2', '0']);
});

describe('packSummary', () => {
  const lengths = (...values: number[]) => values.map((duration, index) => row(`s${index}`, 'one', { duration }));

  it('gives the count, the sum and the range', () => {
    expect(packSummary(lengths(1.5, 0.25))).toBe('소리 2개, 합계 2초, 0.25-1.50초');
    expect(packSummary(lengths(50, 36))).toBe('소리 2개, 합계 1분 26초, 36.00-50.00초');
  });

  it('counts sounds without a known length apart and leaves them out of the sum', () => {
    expect(packSummary(lengths(1, 2, 0))).toBe('소리 3개 / 길이 확인 2개, 합계 3초, 1.00-2.00초');
  });

  it('gives the one length for one sound, and says so when no length is known', () => {
    expect(packSummary(lengths(1.2))).toBe('소리 1개, 합계 1초, 1.20초');
    expect(packSummary(lengths(0, 0))).toBe('소리 2개, 분석 중');
  });
});

it('ranks the three largest kinds and leaves unclassified sounds out', () => {
  const sounds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => row(id, 'one', { fullHash: id }));
  const categories = new Map([['a', 'LASERS'], ['b', 'LASERS'], ['c', 'LASERS'], ['d', 'DOORS'], ['e', 'DOORS'], ['f', 'WOOD'], ['g', 'GLASS']]);
  expect(topKinds(sounds, categories).map(([kind]) => kind).slice(0, 2)).toEqual(['LASERS', 'DOORS']);
  expect(topKinds(sounds, categories)).toHaveLength(3);
  expect(topKinds([row('z', 'one', { fullHash: 'z' })], new Map())).toEqual([]);
});
