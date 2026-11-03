import type { ConnectionPlatform, Platform, SearchPlatform } from './types';
import { embedAudio, embedText, loadModel, onModelEvent } from '../model';
import { DownloadTracker } from '../model/download';
import { encodeWav } from './audio';
import { createPlayback } from './playback';
import type { ElectronBridge } from './library';

const bridge = () => window.fetchApp as ElectronBridge | undefined;
const native = () => bridge()!.nativeAudio;
const decode = (bytes: ArrayBuffer) => new OfflineAudioContext(1, 1, 48_000).decodeAudioData(bytes);
const sha256 = async (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
const playback = createPlayback(async (sound) => new Uint8Array(await native().read(sound.id)).buffer);
const preparing = new Map<string, Promise<void>>();

export const electronSearch: SearchPlatform = {
  log: (entry) => native().log(entry),
  loadSounds: () => native().sounds(),
  async phrase(facts, signal) {
    signal.throwIfAborted();
    const message = await native().phrase(facts);
    signal.throwIfAborted();
    return message;
  },
  async plan(request, signal) {
    signal.throwIfAborted();
    const previous = request.previous;
    try {
      const result = await native().plan({
        text: request.text, has_reference: request.hasReference,
        reference_duration_seconds: request.referenceDuration ?? null,
        previous_plan: previous ? {
          english_queries: previous.sentences, name_keywords: previous.names,
          min_duration_seconds: previous.length?.min ?? null,
          max_duration_seconds: previous.length?.max ?? null, explanation: previous.message,
        } : null,
      });
      signal.throwIfAborted();
      return {
        sentences: result.english_queries, names: result.name_keywords, message: result.explanation,
        fileWords: result.file_words ?? [], typicalMaxSeconds: result.typical_max_seconds ?? null,
        length: result.min_duration_seconds === null && result.max_duration_seconds === null ? undefined : {
          min: result.min_duration_seconds ?? undefined, max: result.max_duration_seconds ?? undefined,
        },
        relative: /더\s*짧게|shorter/i.test(request.text) ? 'shorter'
          : /더\s*길게|longer/i.test(request.text) ? 'longer' : undefined,
        // The main process already checked result_count (1 to 10) with parsePlan.
        ...(result.result_count === undefined ? {} : { count: result.result_count }),
      };
    } catch (error) {
      signal.throwIfAborted();
      const message = String(error);
      const code = /TIMEOUT/.test(message) ? 'timeout' : /INVALID_PLAN/.test(message) ? 'format'
        : /DAILY_LIMIT/.test(message) ? 'dailyLimit' : /RATE_LIMITED/.test(message) ? 'limit'
          // A refused relay connection also lands here; only the browser knows the network is down.
          : /OFFLINE/.test(message) && navigator.onLine === false ? 'offline' : 'server';
      throw Object.assign(new Error(message), { code });
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
  prepareDrag(sound) {
    const existing = preparing.get(sound.id);
    if (existing) return existing;
    const work = (async () => {
      if (await native().copyReady(sound.id)) return;
      const bytes = new Uint8Array(await native().read(sound.id)).buffer;
      let decoded: AudioBuffer;
      try { decoded = await decode(bytes); }
      catch { throw new Error('소리 파일을 읽지 못했습니다.'); }
      await native().saveCopy(sound.id, encodeWav(decoded));
    })().finally(() => preparing.delete(sound.id));
    preparing.set(sound.id, work);
    return work;
  },
  drag: (sound, icon) => native().drag(sound.id, icon),
  reveal: (sound) => native().reveal(sound.id),
  async soundIdForFile(file) {
    const path = bridge()!.pathForFile(file);
    const known = path ? await native().idForPath(path) : null;
    return known ?? (await native().idForHash(await sha256(await file.arrayBuffer()))) ?? undefined;
  },
};

/** Paths are read synchronously: the dropped files are gone once the drop event returns. */
function connectDrop(transfer: DataTransfer): Promise<boolean> {
  const proto1 = bridge()!;
  const paths = Array.from(transfer.files, (file) => proto1.pathForFile(file)).filter(Boolean);
  return (async () => {
    for (const path of paths) if (await proto1.connections.connectPath(path)) return true;
    return false;
  })();
}

let connections: { source: ConnectionPlatform; platform: ConnectionPlatform } | undefined;

export const electronPlatform: Platform = {
  kind: 'electron', search: electronSearch,
  get classify() { return window.fetchApp?.classify; },
  get collections() { return window.fetchApp?.collections; },
  get packs() { return window.fetchApp?.packs; },
  get library() { return window.fetchApp?.library; },
  get connections() {
    const source = window.fetchApp?.connections;
    if (!source) return undefined;
    if (connections?.source !== source) connections = { source, platform: { ...source, connectDrop } };
    return connections.platform;
  },
};
