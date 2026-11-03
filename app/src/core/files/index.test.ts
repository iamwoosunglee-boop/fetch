import { describe, expect, it } from 'vitest';
import {
  computePeaks, describeDecision, detectChanges, embeddingEligible, isSupportedAudio, isUnchanged,
  reconcileFiles, updateTracking, type FileItem, type FileTracking, type ScannedFile,
} from './index';

const file: ScannedFile = {
  path: '/library/a.wav', size: 12, mtimeMs: 10,
  edgeSha256: 'edges', sha256: 'whole',
};

describe('file decisions', () => {
  it('supports only WAV, MP3, OGG and FLAC, case-insensitively', () => {
    for (const extension of ['wav', 'MP3', 'Ogg', 'FLAC']) {
      expect(isSupportedAudio(`/library/a.${extension}`)).toBe(true);
    }
    for (const path of ['a.aiff', 'a.wav.txt', 'wav', '/a.wav/no-extension', '._kick.wav', '/library/._kick.WAV']) {
      expect(isSupportedAudio(path)).toBe(false);
    }
  });

  it('skips content reads only when path, size and modification time all match', () => {
    expect(isUnchanged(file, file)).toBe(true);
    expect(isUnchanged({ ...file, path: '/b.wav' }, file)).toBe(false);
    expect(isUnchanged({ ...file, size: 13 }, file)).toBe(false);
    expect(isUnchanged({ ...file, mtimeMs: 11 }, file)).toBe(false);
  });

  it('does not take a size and edge hash match as identity', () => {
    const previous = reconcileFiles([file]).items;
    const result = reconcileFiles([{ ...file, sha256: 'different' }], previous);
    expect(result.items[0].id).not.toBe(previous[0].id);
    expect(result.missing).toEqual(previous);
  });

  it('keeps identity on moves and groups only fully identical copies', () => {
    const previous = reconcileFiles([file]).items;
    const result = reconcileFiles([
      { ...file, path: '/library/moved.wav' },
      { ...file, path: '/library/copy.wav' },
    ], previous);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(previous[0].id);
    expect(result.items[0].paths.map((entry) => entry.path)).toEqual(['/library/moved.wav', '/library/copy.wav']);
    expect(result.missing).toEqual([]);
    expect(previous[0].paths[0].path).toBe(file.path);
  });

  it('allows exactly 100 MB and excludes larger files from embeddings only', () => {
    expect(embeddingEligible(100_000_000)).toBe(true);
    expect(embeddingEligible(100_000_001)).toBe(false);
    const result = reconcileFiles([{ ...file, size: 100_000_001 }]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].embeddingEligible).toBe(false);
  });
});

const sound = (sha256: string, ...paths: string[]): FileItem => ({
  id: sha256, sha256, edgeSha256: 'edge', size: 1, embeddingEligible: true,
  paths: paths.map((path) => ({ path, size: 1, mtimeMs: 1 })),
});
const empty: FileTracking = { moved: [], missing: [], changed: [] };
const update = (tracking: FileTracking, previous: FileItem[], items: FileItem[], decided: string[] = []) => {
  const { missing } = reconcileFiles(
    items.flatMap((item) => item.paths.map((entry) => ({ ...entry, edgeSha256: 'edge', sha256: item.sha256 }))), previous);
  return updateTracking(tracking, {
    root: '/lib', previous, items, missing,
    live: new Set(items.map((item) => item.sha256)),
    hasDecision: (hash) => decided.includes(hash),
  });
};

describe('file tracking', () => {
  it('reports a moved path without a content question', () => {
    expect(detectChanges([sound('a', '/lib/a.wav')], [sound('a', '/lib/sub/a.wav')])).toEqual({
      moved: [{ from: '/lib/a.wav', to: '/lib/sub/a.wav' }], changed: [],
    });
  });

  it('asks about a same-path edit, including one duplicate of a kept sound', () => {
    expect(detectChanges([sound('a', '/lib/a.wav', '/lib/b.wav')], [sound('a', '/lib/a.wav'), sound('n', '/lib/b.wav')]).changed)
      .toEqual([{ path: '/lib/b.wav', fromSha256: 'a', toSha256: 'n' }]);
  });

  it('does not treat a swap or a new file at a moved path as an edit', () => {
    expect(detectChanges(
      [sound('a', '/lib/1.wav'), sound('b', '/lib/2.wav')],
      [sound('a', '/lib/2.wav'), sound('b', '/lib/1.wav')],
    ).changed).toEqual([]);
    expect(detectChanges([sound('a', '/lib/1.wav')], [sound('a', '/lib/2.wav'), sound('n', '/lib/1.wav')]).changed).toEqual([]);
  });

  it('keeps a missing record until the content returns, then reports the new path', () => {
    const gone = update(empty, [sound('a', '/lib/a.wav')], [], ['a']);
    expect(gone.missing).toEqual([{ fullSha256: 'a', paths: [{ folderId: '/lib', path: '/lib/a.wav' }] }]);
    const again = update(gone, [], []);
    expect(again.missing).toEqual(gone.missing);
    const back = update(again, [], [sound('a', '/lib/new/a.wav')]);
    expect(back.missing).toEqual([]);
    expect(back.moved).toEqual([{ folderId: '/lib', from: '/lib/a.wav', to: '/lib/new/a.wav' }]);
  });

  it('opens a question only when the old content has a decision', () => {
    const decided = update(empty, [sound('a', '/lib/a.wav')], [sound('n', '/lib/a.wav')], ['a']);
    expect(decided.changed).toEqual([{ folderId: '/lib', path: '/lib/a.wav', fromSha256: 'a', toSha256: 'n' }]);
    expect(decided.missing.map((record) => record.fullSha256)).toEqual(['a']);
    expect(update(empty, [sound('a', '/lib/a.wav')], [sound('n', '/lib/a.wav')])).toEqual(empty);
  });

  it('retargets an open question to the latest content and closes it when the file is restored', () => {
    const open = update(empty, [sound('a', '/lib/a.wav')], [sound('n', '/lib/a.wav')], ['a']);
    const later = update(open, [sound('n', '/lib/a.wav')], [sound('m', '/lib/a.wav')], ['a']);
    expect(later.changed[0].toSha256).toBe('m');
    expect(update(later, [sound('m', '/lib/a.wav')], [sound('a', '/lib/a.wav')], ['a']).changed).toEqual([]);
  });

  it('describes the two decisions the app stores in plain Korean', () => {
    expect(describeDecision({ category: 'METAL' })).toBe('금속 METAL');
    expect(describeDecision({ excluded: true })).toBe('묶음에서 뺌');
  });
});

describe('computePeaks', () => {
  it('keeps the loudest absolute sample of each slice across channels, scaled to 0-100', () => {
    const left = new Float32Array(96);
    const right = new Float32Array(96);
    left[0] = -0.5; right[1] = 0.25; left[95] = 0.25; right[50] = -0.125;
    const peaks = computePeaks([left, right]);
    expect(peaks).toHaveLength(48);
    expect(peaks[0]).toBe(100);
    expect(peaks[47]).toBe(50);
    expect(peaks[25]).toBe(25);
    expect(peaks.filter((peak) => peak > 0)).toHaveLength(3);
    expect(peaks.every(Number.isInteger)).toBe(true);
  });

  it('returns zeros for silence and for audio shorter than the slice count', () => {
    expect(computePeaks([new Float32Array(1000)])).toEqual(new Array(48).fill(0));
    expect(computePeaks([new Float32Array([0.5])])).toEqual([...new Array(47).fill(0), 100]);
    expect(computePeaks([])).toEqual(new Array(48).fill(0));
  });
});
