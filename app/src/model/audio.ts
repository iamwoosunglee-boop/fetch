export const SAMPLE_RATE = 48_000;
export const MAX_SAMPLES = SAMPLE_RATE * 10;

// Web Audio resamples during decoding. Average all channels, then retain the first ten seconds.
export async function decodeAudio(bytes: ArrayBuffer): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, MAX_SAMPLES, SAMPLE_RATE);
  const decoded = await context.decodeAudioData(bytes.slice(0));
  const samples = new Float32Array(Math.min(decoded.length, MAX_SAMPLES));
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const source = decoded.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) samples[i] += source[i] / decoded.numberOfChannels;
  }
  if (!samples.length) throw new Error('소리 파일에 샘플이 없습니다.');
  return samples;
}
