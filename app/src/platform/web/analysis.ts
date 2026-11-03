import { embedAudio } from '../../model';

export interface Analysis {
  duration: number;
  peaks: number[];
  embedding: number[];
}

/** Row waveform: the loudest absolute sample of each of `count` equal slices, across channels, clipped to 0..1. */
export function computePeaks(channels: readonly ArrayLike<number>[], count = 48): number[] {
  const length = channels[0]?.length ?? 0;
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * length / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * length / count));
    let peak = 0;
    for (const samples of channels) {
      for (let i = start; i < Math.min(end, length); i++) peak = Math.max(peak, Math.abs(samples[i]));
    }
    return Math.min(1, peak);
  });
}

/**
 * Decodes the whole file once for duration and peaks. embedAudio decodes the first ten seconds again inside
 * src/model, whose API takes bytes only. decodeAudioData runs off the main thread; only the peak loop runs here.
 */
export async function analyseAudio(bytes: ArrayBuffer): Promise<Analysis> {
  const decoded = await new OfflineAudioContext(1, 1, 48_000).decodeAudioData(bytes.slice(0));
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
  const peaks = computePeaks(channels);
  const embedding = Array.from(await embedAudio(bytes));
  return { duration: decoded.duration, peaks, embedding };
}
