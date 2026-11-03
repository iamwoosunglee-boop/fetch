import { afterEach, expect, it, vi } from 'vitest';
import { decodeAudio, MAX_SAMPLES, SAMPLE_RATE } from './audio';

afterEach(() => vi.unstubAllGlobals());

it('asks Web Audio for 48 kHz and averages channels for only the first ten seconds', async () => {
  const left = new Float32Array(MAX_SAMPLES + 10).fill(0.8);
  const right = new Float32Array(MAX_SAMPLES + 10).fill(0.2);
  let received: ArrayBuffer | undefined;
  class Context {
    constructor(channels: number, length: number, rate: number) {
      expect([channels, length, rate]).toEqual([1, MAX_SAMPLES, SAMPLE_RATE]);
    }
    async decodeAudioData(bytes: ArrayBuffer) {
      received = bytes;
      return { length: left.length, numberOfChannels: 2, getChannelData: (c: number) => [left, right][c] };
    }
  }
  vi.stubGlobal('OfflineAudioContext', Context);
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const samples = await decodeAudio(bytes);
  expect(received).not.toBe(bytes);
  expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
  expect(samples.length).toBe(MAX_SAMPLES);
  expect(samples[0]).toBeCloseTo(0.5);
  expect(samples[MAX_SAMPLES - 1]).toBeCloseTo(0.5);
});

it('propagates corrupt decoding without poisoning the next file', async () => {
  const decode = vi.fn()
    .mockRejectedValueOnce(new Error('corrupt'))
    .mockResolvedValueOnce({ length: 1, numberOfChannels: 1, getChannelData: () => new Float32Array([0.25]) });
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  await expect(decodeAudio(new ArrayBuffer(4))).rejects.toThrow('corrupt');
  await expect(decodeAudio(new ArrayBuffer(4))).resolves.toEqual(new Float32Array([0.25]));
});
