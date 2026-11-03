/** Full-length, interleaved 16-bit PCM; no normalization or gain adjustment. */
export function encodeWav(audio: Pick<AudioBuffer, 'numberOfChannels' | 'sampleRate' | 'length' | 'getChannelData'>): Uint8Array {
  const channels = audio.numberOfChannels;
  const size = audio.length * channels * 2;
  const bytes = new Uint8Array(44 + size);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF'); view.setUint32(4, 36 + size, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, size, true);
  for (let channel = 0; channel < channels; channel++) {
    const samples = audio.getChannelData(channel);
    for (let i = 0; i < audio.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + (i * channels + channel) * 2,
        Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
  }
  return bytes;
}
