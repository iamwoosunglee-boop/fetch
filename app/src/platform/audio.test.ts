import { describe, expect, it } from 'vitest';
import { encodeWav } from './audio';

describe('WAV export', () => {
  it('preserves full length, stereo order and amplitude without normalization', () => {
    const left = new Float32Array([-1, -0.25, 0, 0.25, 1]);
    const right = new Float32Array([1, 0.25, 0, -0.25, -1]);
    const result = encodeWav({
      numberOfChannels: 2, sampleRate: 44_100, length: 5,
      getChannelData: (channel) => channel === 0 ? left : right,
    });
    const view = new DataView(result.buffer);
    expect(new TextDecoder().decode(result.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(20);
    expect(Array.from({ length: 10 }, (_, i) => view.getInt16(44 + i * 2, true)))
      .toEqual([-32768, 32767, -8192, 8192, 0, 0, 8192, -8192, 32767, -32768]);
  });
});
