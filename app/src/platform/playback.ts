import type { SearchSound } from '../core/search';
import type { PlayOptions } from './types';

/** Web Audio playback for both platforms; they differ only in how a sound's bytes are read. */
export function createPlayback(read: (sound: SearchSound) => Promise<ArrayBuffer>) {
  let context: AudioContext | undefined;
  let gain: GainNode | undefined;
  let level = 1;
  let playing: { source: AudioBufferSourceNode; offset: number; startedAt: number } | undefined;
  /** The last decoded sound, so a seek starts a new source without reading the file again. */
  let held: { id: string; buffer: AudioBuffer } | undefined;

  function stop(): void {
    playing?.source.stop();
    playing?.source.disconnect();
    playing = undefined;
  }

  async function decoded(sound: SearchSound, audio: AudioContext, signal: AbortSignal, source?: () => Promise<ArrayBuffer>): Promise<AudioBuffer> {
    if (held?.id === sound.id) return held.buffer;
    const bytes = await (source ? source() : read(sound));
    signal.throwIfAborted();
    const buffer = await audio.decodeAudioData(bytes);
    signal.throwIfAborted();
    held = { id: sound.id, buffer };
    return buffer;
  }

  return {
    stop,
    async play(sound: SearchSound, signal: AbortSignal, { offset = 0, ended, bytes }: PlayOptions = {}): Promise<void> {
      stop();
      signal.throwIfAborted();
      const audio = context ??= new AudioContext();
      const buffer = await decoded(sound, audio, signal, bytes);
      await audio.resume();
      signal.throwIfAborted();
      if (!gain) {
        gain = audio.createGain();
        gain.gain.value = level;
        gain.connect(audio.destination);
      }
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      const abort = () => { source.stop(); source.disconnect(); };
      signal.addEventListener('abort', abort, { once: true });
      source.onended = () => {
        signal.removeEventListener('abort', abort);
        source.disconnect();
        if (playing?.source === source) playing = undefined;
        if (!signal.aborted) ended?.();
      };
      const start = Math.min(offset, buffer.duration);
      playing = { source, offset: start, startedAt: audio.currentTime };
      source.start(0, start);
    },
    position(): number | undefined {
      return playing && context ? playing.offset + context.currentTime - playing.startedAt : undefined;
    },
    duration(): number | undefined {
      return held?.buffer.duration;
    },
    setGain(value: number): void {
      level = value;
      if (gain) gain.gain.value = value;
    },
  };
}
