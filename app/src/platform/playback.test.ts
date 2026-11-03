import { beforeEach, expect, it, vi } from 'vitest';
import { electronSearch } from './electron';
import type { SearchSound } from '../core/search';

vi.mock('../model', () => ({ embedText: vi.fn(), embedAudio: vi.fn() }));
const sound: SearchSound = { id: 'one', relativePath: 'one.wav', packId: 'pack', duration: 2 };
const source = { buffer: undefined, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), onended: undefined };
const destination = {};
const gain = { gain: { value: 1 }, connect: vi.fn() };
const decoded = { duration: 2 };
const read = vi.fn();
beforeEach(() => {
  electronSearch.stop();
  vi.clearAllMocks();
  read.mockResolvedValue(new Uint8Array([1, 2]));
  vi.stubGlobal('window', { fetchApp: { nativeAudio: { read } } });
  vi.stubGlobal('AudioContext', class {
    destination = destination;
    decodeAudioData = vi.fn(async () => decoded);
    resume = vi.fn(async () => {});
    createBufferSource = () => source;
    createGain = () => gain;
    currentTime = 10;
  });
});

it('sends decoded audio through the gain to the output and stops the previous sound', async () => {
  const first = new AbortController();
  await electronSearch.play(sound, first.signal);
  expect(source.buffer).toBe(decoded);
  expect(source.connect).toHaveBeenCalledWith(gain);
  expect(gain.connect).toHaveBeenCalledWith(destination);
  expect(source.start).toHaveBeenCalledOnce();
  await electronSearch.play(sound, new AbortController().signal);
  expect(source.stop).toHaveBeenCalledOnce();
  expect(source.start).toHaveBeenCalledTimes(2);
  electronSearch.stop();
});

it('plays a file from outside the library from its own bytes', async () => {
  const bytes = vi.fn(async () => new ArrayBuffer(2));
  await electronSearch.play({ ...sound, id: 'outside' }, new AbortController().signal, { bytes });
  expect(bytes).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  expect(source.start).toHaveBeenCalledOnce();
  electronSearch.stop();
});

it('starts at the offset, past the end means the end, and a seek reads nothing again', async () => {
  await electronSearch.play({ ...sound, id: 'seek' }, new AbortController().signal, { offset: 0.5 });
  expect(source.start).toHaveBeenLastCalledWith(0, 0.5);
  expect(electronSearch.position()).toBe(0.5);
  await electronSearch.play({ ...sound, id: 'seek' }, new AbortController().signal, { offset: 9 });
  expect(source.start).toHaveBeenLastCalledWith(0, 2);
  expect(read).toHaveBeenCalledOnce();
  expect(electronSearch.duration()).toBe(2);
  electronSearch.stop();
  expect(electronSearch.position()).toBeUndefined();
});

it('keeps the gain for every sound, set before the first one too', async () => {
  electronSearch.setGain(0.25);
  await electronSearch.play(sound, new AbortController().signal);
  expect(gain.gain.value).toBe(0.25);
  electronSearch.setGain(0);
  expect(gain.gain.value).toBe(0);
  electronSearch.setGain(1);
  electronSearch.stop();
});

it('reports the end of a sound only when nobody stopped it', async () => {
  const ended = vi.fn();
  const abort = new AbortController();
  await electronSearch.play(sound, abort.signal, { ended });
  abort.abort();
  (source.onended as unknown as () => void)();
  expect(ended).not.toHaveBeenCalled();
  await electronSearch.play(sound, new AbortController().signal, { ended });
  (source.onended as unknown as () => void)();
  expect(ended).toHaveBeenCalledOnce();
});

it('does not start a sound whose pending read was aborted', async () => {
  let complete!: (value: Uint8Array) => void;
  read.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const abort = new AbortController();
  const playback = electronSearch.play({ ...sound, id: 'pending' }, abort.signal);
  abort.abort();
  complete(new Uint8Array([1, 2]));
  await expect(playback).rejects.toThrow();
  expect(source.start).not.toHaveBeenCalled();
});
