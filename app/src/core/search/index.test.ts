import { describe, expect, it } from 'vitest';
import {
  combineScores, cosineSimilarity, detectPacks, lengthFilter, rankResults,
  relativeLength, textMatch, tokenize, SEARCH_TUNING,
  type SearchSound,
} from './index';

describe('Unicode forms in file names', () => {
  const nfc = '칼소리';
  const nfd = nfc.normalize('NFD');
  const sound = { id: 'a', relativePath: `팩/${nfc}_01.wav`.normalize('NFD'), packId: 'p', duration: 1 };

  it('matches a name in either form', () => {
    expect(nfd).not.toBe(nfc);
    expect(textMatch(`${nfd}_01.wav`, nfc)).toBe(true);
    expect(textMatch(`${nfc}_01.wav`, nfd)).toBe(true);
  });

  it('finds an NFD name by quoted search and by name keyword', () => {
    expect(rankResults([sound], { query: `"${nfc}"` }).results.map((item) => item.sound.id)).toEqual(['a']);
    expect(rankResults([sound], { query: '다른 말', names: [nfc] }).results[0].textMatched).toBe(true);
  });
});

describe('word matching', () => {
  it('splits separators, camel case, letters and numbers and ignores case', () => {
    expect(tokenize('highDown_METAL-hit 12Door/소리3.wav'))
      .toEqual(['high', 'down', 'metal', 'hit', '12', 'door', '소리', '3', 'wav']);
  });

  it('requires every typed word and matches complete tokens only', () => {
    expect(textMatch('sounds/hit.wav', 'door sound')).toBe(false);
    expect(textMatch('sounds/door.wav', 'door sound')).toBe(false);
    expect(textMatch('sound/doorClose.wav', 'DOOR sound')).toBe(true);
    expect(textMatch('highDown.wav', 'high')).toBe(true);
    expect(textMatch('door.wav', '')).toBe(false);
  });

  it('accepts any name search term, with all words within that term', () => {
    expect(textMatch('heroes/ironMan.wav', '금속 영웅', ['Thor', 'Iron Man'])).toBe(true);
    expect(textMatch('heroes/iron.wav', '', ['Iron Man'])).toBe(false);
    expect(textMatch('heroes/Thor.wav', 'missing', ['Thor'])).toBe(true);
  });
});

describe('length rules', () => {
  it('allows ten percent of each bound, inclusively', () => {
    expect(lengthFilter(0.22, { max: 0.2 })).toBe(true);
    expect(lengthFilter(0.221, { max: 0.2 })).toBe(false);
    expect(lengthFilter(0.18, { min: 0.2 })).toBe(true);
    expect(lengthFilter(0.179, { min: 0.2 })).toBe(false);
    expect(lengthFilter(3, { min: 2, max: 2 })).toBe(false);
    expect(lengthFilter(0, { max: 0 })).toBe(true);
    expect(lengthFilter(100)).toBe(true);
  });

  it('includes an exact sample at the upper margin but excludes the next sample', () => {
    expect(lengthFilter(15840 / 48000, { max: 0.3 })).toBe(true);
    expect(lengthFilter(15841 / 48000, { max: 0.3 })).toBe(false);
  });

  it('includes an exact sample at the lower margin but excludes the previous sample', () => {
    expect(lengthFilter(432 / 48000, { min: 0.01 })).toBe(true);
    expect(lengthFilter(431 / 48000, { min: 0.01 })).toBe(false);
  });

  it('includes the shorter relative margin without admitting the next sample', () => {
    const condition = relativeLength('shorter', 7200 / 48000);
    expect(condition?.max).toBeCloseTo(5040 / 48000, 15);
    expect(lengthFilter(5544 / 48000, condition)).toBe(true);
    expect(lengthFilter(5545 / 48000, condition)).toBe(false);
  });

  it('includes the longer relative margin without admitting the previous sample', () => {
    const condition = relativeLength('longer', 16800 / 48000);
    expect(condition?.min).toBeCloseTo(21840 / 48000, 15);
    expect(lengthFilter(19656 / 48000, condition)).toBe(true);
    expect(lengthFilter(19655 / 48000, condition)).toBe(false);
  });

  it('uses the reference first and otherwise the median without mutating results', () => {
    const previous = [8, 2, 4, 6];
    expect(relativeLength('shorter', 10, previous)).toEqual({ max: 7 });
    expect(relativeLength('longer', 10, previous)).toEqual({ min: 13 });
    expect(relativeLength('shorter', undefined, previous)).toEqual({ max: 3.5 });
    expect(relativeLength('longer', undefined, [9, 1, 5])).toEqual({ min: 6.5 });
    expect(relativeLength('shorter', undefined, [])).toBeUndefined();
    expect(previous).toEqual([8, 2, 4, 6]);
  });

  it('recomputes repeated refinements from the latest results', () => {
    expect(relativeLength('shorter', 10, [2, 4], true)).toEqual({ max: 2.1 });
    expect(relativeLength('shorter', 0, [])).toEqual({ max: 0 });
  });
});

describe('scores', () => {
  it('uses cosine, the maximum sentence score, and the unweighted mean', () => {
    expect(cosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(combineScores([-0.8, -0.2])).toBe(-0.2);
    expect(combineScores([], 0.6)).toBe(0.6);
    expect(combineScores([0.2, 0.8], 0.4)).toBeCloseTo(0.6);
    expect(combineScores([])).toBe(0);
  });
});

describe('pack detection', () => {
  it('descends the single trunk to the CORE vendor level and keeps loose files at root', () => {
    const root = 'F:\\CORE 3 Complete';
    const result = detectPacks([{ root, files: [
      'readme.wav', 'Master Library/loose.wav',
      'Master Library/Blastdrive 3.0 - Hybrid Library/Impacts/hit.wav',
      'Master Library/Other Vendor/Whoosh/swipe.wav',
    ] }]);
    expect(result.map((file) => file.packName)).toEqual([
      'CORE 3 Complete', 'CORE 3 Complete',
      'Blastdrive 3.0 - Hybrid Library', 'Other Vendor',
    ]);
  });

  it('isolates connected roots and handles unbranched folders', () => {
    const result = detectPacks([
      { root: '/one', files: ['Vendor/A/a.wav', 'Vendor/B/b.wav'] },
      { root: '/two', files: ['Vendor/A/a.wav'] },
      { root: '/single', files: ['nested/a.wav'] },
    ]);
    expect(result.map((file) => file.packName)).toEqual(['A', 'B', 'two', 'single']);
    expect(detectPacks([{ root: '/empty', files: [] }])).toEqual([]);
  });

  it('makes one pack of a folder whose top names are sound types, as in the Gamemaster structure', () => {
    const types = ['Animals', 'Cartoon', 'Creatures', 'Doors', 'Explosions', 'Fire', 'Foley', 'Footsteps', 'Guns',
      'Human', 'Magic_Spells', 'Mechanical', 'Robots', 'Swooshes', 'Vehicles', 'Voices', 'Water'];
    const others = ['Ambiences', 'Battle', 'Beam', 'Coins', 'Dark', 'Hits', 'Impacts', 'Jingles', 'Menu', 'Nature', 'Pickup', 'Powerups', 'Sci_Fi', 'Stingers'];
    const result = detectPacks([{ root: '/Pro Collection', files: [...types, ...others].map((name) => `${name}/a.wav`) }]);
    expect(new Set(result.map((file) => file.packName))).toEqual(new Set(['Pro Collection']));
    expect(new Set(result.map((file) => file.packId))).toEqual(new Set(['/Pro Collection']));
  });

  it('keeps packs while fewer than half of the names carry a category word', () => {
    const result = detectPacks([{ root: '/lib', files: ['Metal Hits/a.wav', 'Kenney/b.wav', 'Sonniss/c.wav'] }]);
    expect(result.map((file) => file.packName)).toEqual(['Metal Hits', 'Kenney', 'Sonniss']);
  });

  it('counts exactly half as sound types and goes one level up below a trunk', () => {
    const result = detectPacks([{ root: '/lib', files: ['loose.wav', 'Vendor/Footsteps/a.wav', 'Vendor/Kits/b.wav'] }]);
    expect(result.map((file) => [file.packName, file.packId])).toEqual([['lib', '/lib'], ['Vendor', '/lib/Vendor'], ['Vendor', '/lib/Vendor']]);
  });

  it('matches whole words only, including each word of a paired category', () => {
    const packs = (names: string[]) => detectPacks([{ root: '/lib', files: names.map((name) => `${name}/a.wav`) }]).map((file) => file.packName);
    expect(packs(['food_stuff', 'SAND kit'])).toEqual(['lib', 'lib']);
    expect(packs(['Firefly', 'Icebox'])).toEqual(['Firefly', 'Icebox']);
  });
});

const sounds: SearchSound[] = Array.from({ length: 30 }, (_, i) => ({
  id: String(i),
  relativePath: `effect${i}.wav`,
  packId: `pack${Math.floor(i / 6)}`,
  duration: i + 1,
  fullHash: `hash${i}`,
  embedding: [30 - i, i],
}));
const reference = { embedding: [1, 0], packIds: ['pack0'], fullHash: 'hash0' };
const ids = (result: { results: { sound: SearchSound }[] }) => result.results.map((item) => item.sound.id);

describe('ranking', () => {
  it('retains the exact upper-margin sample in search results', () => {
    const result = rankResults([
      { ...sounds[0], duration: 15840 / 48000 },
      { ...sounds[1], duration: 15841 / 48000 },
    ], { length: { max: 0.3 } });
    expect(ids(result)).toEqual(['0']);
    expect(result.lengthRemoved).toBe(1);
  });

  it('returns score order within other packs before the reference pack', () => {
    const result = rankResults(sounds, { reference });
    expect(ids(result)).toEqual(['6', '7', '8']);
    expect(result.hasMore).toBe(true);
    const next = rankResults(sounds, { reference, exclude: new Set(ids(result)) });
    expect(ids(next)).toEqual(['9', '10', '11']);
  });

  it('fills from the reference pack only after other packs are exhausted', () => {
    const two = sounds.filter((sound) => ['pack0', 'pack1'].includes(sound.packId));
    expect(ids(rankResults(two, { reference }))).toEqual(['6', '7', '8']);
    expect(ids(rankResults(two, { reference, count: 7 }))).toEqual(['6', '7', '8', '9', '10', '11', '1']);
  });

  it('keeps repeated packs in score order for a given count', () => {
    const result = rankResults(sounds, { reference, count: 7 });
    expect(ids(result)).toEqual(['6', '7', '8', '9', '10', '11', '12']);
  });

  it('uses score order for external references without a known pack', () => {
    expect(ids(rankResults(sounds, { reference: { embedding: [1, 0] } }))).toEqual(['0', '1', '2']);
    expect(ids(rankResults(sounds, { textEmbeddings: [[1, 0]], count: 5 }))).toEqual(['0', '1', '2', '3', '4']);
  });

  it('never returns excluded ids or identical files of excluded hashes', () => {
    const copy = { ...sounds[1], id: 'copy' };
    const result = rankResults([sounds[0], sounds[1], copy, sounds[2]], { textEmbeddings: [[1, 0]], exclude: new Set(['0', 'hash1']) });
    expect(ids(result)).toEqual(['2']);
    expect(result.hasMore).toBe(false);
  });

  it('filters length before promoting text matches, even from the same pack', () => {
    const items = sounds.map((sound, i) => ({ ...sound, relativePath: [2, 3, 20].includes(i) ? 'door.wav' : sound.relativePath }));
    const result = rankResults(items, { reference, query: 'door', length: { max: 20 }, count: 5 });
    expect(result.results.slice(0, 3).every((item) => item.textMatched)).toBe(true);
    expect(result.results.slice(0, 3).map((item) => item.sound.id).sort()).toEqual(['2', '20', '3']);
    expect(rankResults(items, { query: 'door', length: { max: 1 } }).results.some((item) => item.textMatched)).toBe(false);
  });

  it('matches any typed word without Hangul in chat mode, every word otherwise', () => {
    const items = [{ ...sounds[0], relativePath: 'laser_shot.wav' }, { ...sounds[1], relativePath: 'blast.wav' }];
    expect(rankResults(items, { query: '레이저 laser zap', textMode: 'any' }).results[0].textMatched).toBe(true);
    expect(rankResults(items, { query: 'laser zap' }).results.some((item) => item.textMatched)).toBe(false);
    expect(textMatch('laser.wav', '레이저laser', [], 'any')).toBe(false);
    expect(rankResults(items, { query: '"laser zap"', textMode: 'any' }).results).toEqual([]);
  });

  it('removes all full-hash copies of the reference but never treats absent hashes as equal', () => {
    const copy = { ...sounds[1], fullHash: 'hash0' };
    expect(ids(rankResults([sounds[0], copy, sounds[2]], { reference }))).toEqual(['2']);
    expect(rankResults([{ ...sounds[0], fullHash: undefined }], { reference: { embedding: [1, 0] } }).results).toHaveLength(1);
  });

  it('keeps text-only matches without vectors and excludes nonmatches for quoted input', () => {
    const result = rankResults([
      { ...sounds[0], relativePath: 'doorSound.wav', embedding: undefined },
      { ...sounds[1], relativePath: 'noise.wav' },
    ], { query: '"door sound"' });
    expect(ids(result)).toEqual(['0']);
  });

  it('returns an empty result and the removed count instead of silently relaxing conditions', () => {
    const result = rankResults(sounds, { reference, length: { max: 0.1 } });
    expect(result.results).toEqual([]);
    expect(result.lengthRemoved).toBe(29);
  });

  it('reads a null cut as unsure for text and both and as no decision for a reference', () => {
    const weak = [{ ...sounds[0], embedding: [0.3, Math.sqrt(1 - 0.3 ** 2)] }];
    const tuning = { ...SEARCH_TUNING, thresholds: { text: null, reference: null, both: null } };
    expect(rankResults(weak, { textEmbeddings: [[1, 0]], tuning }).uncertain).toBe(true);
    expect(rankResults(weak, { textEmbeddings: [[1, 0]], reference: { embedding: [0, 1] }, tuning }).uncertain).toBe(true);
    expect(rankResults(weak, { reference: { embedding: [1, 0] }, tuning }).uncertain).toBe(false);
  });

  it('compares the raw score with the cut of its branch, whatever the name bonus adds', () => {
    const weak = [{ ...sounds[0], embedding: [0.3, Math.sqrt(1 - 0.3 ** 2)] }];
    const tuning = { ...SEARCH_TUNING, beta: 10, thresholds: { text: 0.4, reference: 0.4, both: 0.4 } };
    expect(rankResults(weak, { textEmbeddings: [[1, 0]], tuning, fileWords: ['effect'] }).uncertain).toBe(true);
    expect(rankResults(weak, { reference: { embedding: [1, 0] }, tuning }).uncertain).toBe(true);
    expect(rankResults(weak, { textEmbeddings: [[1, 0]], reference: { embedding: [1, 0] }, tuning }).uncertain).toBe(true);
    expect(rankResults(sounds, { textEmbeddings: [[1, 0]], tuning }).uncertain).toBe(false);
  });

  it('counts a score exactly at the cut as unsure', () => {
    const exact = [{ ...sounds[0], embedding: [3, 4] }];
    const cut = (text: number) => ({ ...SEARCH_TUNING, thresholds: { text, reference: null, both: null } });
    expect(rankResults(exact, { textEmbeddings: [[1, 0]], tuning: cut(0.6) }).uncertain).toBe(true);
    expect(rankResults(exact, { textEmbeddings: [[1, 0]], tuning: cut(0.59) }).uncertain).toBe(false);
  });

  it('does not mutate the input or vectors', () => {
    const before = structuredClone(sounds);
    rankResults(sounds, { reference, textEmbeddings: [[0, 1]], query: 'effect 20' });
    expect(sounds).toEqual(before);
  });

  it('makes no decision when a file name leads the answer or the search is quoted', () => {
    // Given a weak file-name match under a cut it cannot clear.
    const items = [{ ...sounds[0], relativePath: 'target.wav', embedding: [0, 1] }, sounds[1]];
    const tuning = { ...SEARCH_TUNING, thresholds: { text: 0.1, reference: null, both: null } };
    // When the name match leads the answer.
    const named = rankResults(items, { query: 'target', textEmbeddings: [[1, 0]], tuning });
    const quoted = rankResults(items, { query: '"target"', reference: { embedding: [0, 1] }, tuning });
    // Then the score says nothing about it.
    expect(named.results[0].sound.id).toBe('0');
    expect(named.uncertain).toBe(false);
    expect(quoted.results[0].sound.id).toBe('0');
    expect(quoted.uncertain).toBe(false);
  });

  it('decides on the best raw score of all sounds that passed the length, shown or not', () => {
    // Given a strong sound already shown and weak ones left.
    const items = [{ ...sounds[0], embedding: [1, 0], duration: 1 }, { ...sounds[1], embedding: [3, 4], duration: 1 }, { ...sounds[2], embedding: [3, 4], duration: 9 }];
    const tuning = { ...SEARCH_TUNING, thresholds: { text: 0.7, reference: null, both: null } };
    // When the shown sound is left out of the results.
    const next = rankResults(items, { textEmbeddings: [[1, 0]], tuning, exclude: new Set(['0']) });
    // Then it still counts, and a sound the length removed never does.
    expect(ids(next)).toEqual(['1', '2']);
    expect(next.uncertain).toBe(false);
    expect(rankResults(items, { textEmbeddings: [[1, 0]], tuning, length: { min: 5 } }).uncertain).toBe(true);
  });

  it('has no decision to make without results or without a score', () => {
    const tuning = { ...SEARCH_TUNING, thresholds: { text: null, reference: null, both: null } };
    expect(rankResults([], { textEmbeddings: [[1, 0]], tuning }).uncertain).toBe(false);
    expect(rankResults(sounds, { tuning }).uncertain).toBe(false);
  });
});


it('shows identical files as one sound and prefers the path that matched the text', () => {
  const sound = (relativePath: string, id: string, fullHash: string) => ({ id, relativePath, packId: 'p', duration: 1, fullHash });
  const { results, hasMore } = rankResults([
    sound('a.wav', 'x', 'h1'), sound('copy/target.wav', 'x', 'h1'), sound('b.wav', 'y', 'h2'),
  ], { query: 'target' });
  expect(results.map((item) => item.sound.relativePath)).toEqual(['copy/target.wav', 'b.wav']);
  expect(hasMore).toBe(false);
});
