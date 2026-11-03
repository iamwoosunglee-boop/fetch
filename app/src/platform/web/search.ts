import type { SearchPlatform } from '../types';
import { parsePlan } from '../../core/plan';
import { requestPhrase } from '../../core/phrase';
import { embeddingEligible } from '../../core/files';
import { embedAudio, embedText, loadModel, onModelEvent } from '../../model';
import { DownloadTracker } from '../../model/download';
import { createPlayback } from '../playback';
import { sha256 } from './fs';
import type { WebLibrary } from './library';

const decode = (bytes: ArrayBuffer) => new OfflineAudioContext(1, 1, 48_000).decodeAudioData(bytes);

/** The relay may add result_count (1 to 10) for "5개 찾아줘"; anything else means not asked. */
function resultCount(value: unknown): number | undefined {
  const count = (value as { result_count?: unknown } | null)?.result_count;
  return typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= 10 ? count : undefined;
}

export function createWebSearch(library: WebLibrary): SearchPlatform {
  const playback = createPlayback(async (sound) => (await library.readFile(sound)).arrayBuffer());
  return {
    loadSounds: () => library.sounds(),
    phrase: (facts, signal) => requestPhrase('/phrase', facts, signal),
    async plan(request, signal) {
      signal.throwIfAborted();
      const previous = request.previous;
      try {
        const response = await fetch('/plan', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]),
          body: JSON.stringify({
            text: request.text, has_reference: request.hasReference,
            reference_duration_seconds: request.referenceDuration ?? null,
            previous_plan: previous ? {
              english_queries: previous.sentences, name_keywords: previous.names,
              min_duration_seconds: previous.length?.min ?? null,
              max_duration_seconds: previous.length?.max ?? null, explanation: previous.message,
            } : null,
          }),
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value?.error);
        const result = parsePlan(value);
        const count = resultCount(value);
        return {
          sentences: result.english_queries, names: result.name_keywords, message: result.explanation,
          fileWords: result.file_words ?? [], typicalMaxSeconds: result.typical_max_seconds ?? null,
          length: result.min_duration_seconds === null && result.max_duration_seconds === null ? undefined : {
            min: result.min_duration_seconds ?? undefined, max: result.max_duration_seconds ?? undefined,
          },
          relative: /더\s*짧게|shorter/i.test(request.text) ? 'shorter'
            : /더\s*길게|longer/i.test(request.text) ? 'longer' : undefined,
          ...(count === undefined ? {} : { count }),
        };
      } catch (error) {
        signal.throwIfAborted();
        const reason = String(error);
        const code = /TimeoutError|TIMEOUT/.test(reason) ? 'timeout' : /INVALID_PLAN/.test(reason) ? 'format'
          : /DAILY_LIMIT/.test(reason) ? 'dailyLimit' : /RATE_LIMITED|BUSY/.test(reason) ? 'limit'
            : navigator.onLine === false ? 'offline' : 'server';
        throw Object.assign(new Error('요청을 해석하지 못했습니다.'), { code });
      }
    },
    async embedText(sentences, signal) {
      signal.throwIfAborted();
      const vectors = await embedText([...sentences]);
      signal.throwIfAborted();
      return vectors;
    },
    async importReference(file) {
      const bytes = await file.arrayBuffer();
      const fullHash = await sha256(bytes);
      // The file is judged first, so only a readable file can be held back by the model.
      const duration = (await decode(bytes.slice(0))).duration;
      await loadModel('audio').catch(() => { throw { code: 'model' }; });
      return { name: file.name, duration, fullHash, embedding: await embedAudio(bytes) };
    },
    play: playback.play,
    stop: playback.stop,
    position: playback.position,
    duration: playback.duration,
    setGain: playback.setGain,
    onDownload(listener) {
      const tracker = new DownloadTracker();
      return onModelEvent((event) => listener(tracker.update(event)));
    },
    async download(sound) {
      // The original bytes under the original name; the web makes no WAV copies (PRD 7.6).
      const file = await library.readFile(sound);
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      // Revoking at once can cancel the download before the browser reads the blob.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    async soundIdForFile(file) {
      // Name and size narrow the candidates; the whole-file hash confirms, so a namesake from elsewhere is not taken.
      const rows = (await library.sounds()).filter((row) => row.size === file.size);
      const named = rows.filter((row) => row.relativePath.split('/').pop() === file.name);
      if (!embeddingEligible(file.size)) return named[0]?.id;
      if (!rows.some((row) => row.fullHash)) return undefined;
      const hash = await sha256(await file.arrayBuffer());
      return [...named, ...rows].find((row) => row.fullHash === hash)?.id;
    },
  };
}
