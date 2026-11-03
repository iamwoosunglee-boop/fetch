import { beforeEach, describe, expect, it, vi } from 'vitest';
import { electronSearch } from './electron';
import { embedAudio, embedText, loadModel } from '../model';

vi.mock('../model', () => ({ embedText: vi.fn(async () => [new Float32Array(512)]), embedAudio: vi.fn(), loadModel: vi.fn(async () => {}) }));
const plan = vi.fn();
beforeEach(() => {
  vi.stubGlobal('window', { fetchApp: { nativeAudio: { plan } } });
  vi.clearAllMocks();
});

it('adapts the relay contract and preserves prior conditions', async () => {
  plan.mockResolvedValue({
    english_queries: [], name_keywords: [], min_duration_seconds: null,
    max_duration_seconds: null, explanation: '길이를 줄입니다.', file_words: ['metal'], typical_max_seconds: 1,
  });
  const result = await electronSearch.plan({
    text: '더 짧게', hasReference: true, referenceDuration: 2,
    previous: { sentences: ['metal hit'], names: [], length: { max: 4 }, message: '금속 소리',
      fileWords: ['old'], typicalMaxSeconds: 5 },
  }, new AbortController().signal);
  expect(plan.mock.calls[0][0]).toEqual({
    text: '더 짧게', has_reference: true, reference_duration_seconds: 2,
    previous_plan: {
      english_queries: ['metal hit'], name_keywords: [], min_duration_seconds: null,
      max_duration_seconds: 4, explanation: '금속 소리',
    },
  });
  expect(result.relative).toBe('shorter');
  expect(result.sentences).toEqual([]);
  expect(result.count).toBeUndefined();
  expect(result.fileWords).toEqual(['metal']);
  expect(result.typicalMaxSeconds).toBe(1);
});

it('passes the relay result_count on as the answer size', async () => {
  plan.mockResolvedValue({
    english_queries: ['a click'], name_keywords: [], min_duration_seconds: null,
    max_duration_seconds: null, explanation: '클릭 소리 5개를 찾았어요.', result_count: 5,
  });
  const result = await electronSearch.plan({ text: '클릭 소리 5개 찾아줘', hasReference: false }, new AbortController().signal);
  expect(result.count).toBe(5);
});

it.each([
  ['TIMEOUT', 'timeout'], ['INVALID_PLAN', 'format'], ['RATE_LIMITED', 'limit'],
  ['DAILY_LIMIT', 'dailyLimit'], ['UPSTREAM_ERROR', 'server'],
])('maps %s to the screen failure code', async (message, code) => {
  plan.mockRejectedValue(new Error(message));
  await expect(electronSearch.plan({ text: '금속', hasReference: false }, new AbortController().signal))
    .rejects.toMatchObject({ code });
});

it.each([[false, 'offline'], [true, 'server']])('with onLine %s, a failed relay connection maps to %s', async (onLine, code) => {
  vi.stubGlobal('navigator', { onLine });
  plan.mockRejectedValue(new Error('OFFLINE'));
  await expect(electronSearch.plan({ text: '금속', hasReference: false }, new AbortController().signal))
    .rejects.toMatchObject({ code });
});

describe('importReference', () => {
  const decoder = (decodeAudioData: () => Promise<{ duration: number }>) => vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decodeAudioData; });
  const file = new File(['audio'], 'a.wav');

  it('reports a model failure as a model failure', async () => {
    decoder(async () => ({ duration: 1 }));
    vi.mocked(loadModel).mockRejectedValueOnce(new Error('network'));
    await expect(electronSearch.importReference(file)).rejects.toMatchObject({ code: 'model' });
    expect(embedAudio).not.toHaveBeenCalled();
  });

  it('reports an unreadable file as a file failure before touching the model', async () => {
    decoder(async () => { throw new Error('decode'); });
    const failure = await electronSearch.importReference(file).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('code');
    expect(loadModel).not.toHaveBeenCalled();
  });

  it('reads a good file once the model is ready', async () => {
    decoder(async () => ({ duration: 2 }));
    vi.mocked(embedAudio).mockResolvedValueOnce(new Float32Array(512));
    await expect(electronSearch.importReference(file)).resolves.toMatchObject({ name: 'a.wav', duration: 2 });
  });
});

describe('soundIdForFile', () => {
  const pathForFile = vi.fn();
  const idForPath = vi.fn();
  const idForHash = vi.fn();
  const file = new File(['audio'], 'copy.wav');
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('window', { fetchApp: { pathForFile, nativeAudio: { idForPath, idForHash } } });
    pathForFile.mockReturnValue('/outside/copy.wav');
  });

  it('finds a stored path or a WAV copy without hashing', async () => {
    idForPath.mockResolvedValue('known');
    await expect(electronSearch.soundIdForFile!(file)).resolves.toBe('known');
    expect(idForHash).not.toHaveBeenCalled();
  });

  it('finds a file outside the library by its whole content', async () => {
    idForPath.mockResolvedValue(null);
    idForHash.mockResolvedValue('same-content');
    await expect(electronSearch.soundIdForFile!(file)).resolves.toBe('same-content');
    const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), (n) => n.toString(16).padStart(2, '0')).join('');
    expect(idForHash).toHaveBeenCalledWith(expected);
  });

  it('leaves a new file outside the library', async () => {
    pathForFile.mockReturnValue('');
    idForHash.mockResolvedValue(null);
    await expect(electronSearch.soundIdForFile!(file)).resolves.toBeUndefined();
    expect(idForPath).not.toHaveBeenCalled();
  });
});

it('does not begin text inference for an aborted request', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(electronSearch.embedText(['metal'], abort.signal)).rejects.toThrow();
  expect(embedText).not.toHaveBeenCalled();
});
