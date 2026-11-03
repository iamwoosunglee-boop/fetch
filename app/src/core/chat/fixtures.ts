import { vi } from 'vitest';
import { createChatStore } from './index';
import type { ChatAnswer, ChatStore } from './types';
import type { SearchPlan, SearchPlanRequest, SearchPlatform } from '../../platform/types';
import type { DownloadState } from '../../model/download';
import { SEARCH_TUNING, type SearchSound, type Vector } from '../search';
import type { SearchTuning } from '../search/scoring';
import type { PhraseFacts } from '../phrase';
import type { ChatStoreOptions } from './types';

// 24 sounds in 4 packs; a lower index scores higher against [1, 0].
export const library: SearchSound[] = Array.from({ length: 24 }, (_, i) => ({
  id: `s${i}`,
  relativePath: `pack${Math.floor(i / 6)}/${i % 6 === 0 ? 'laser_shot' : 'effect'}${i}.wav`,
  packId: `pack${Math.floor(i / 6)}`,
  duration: (i % 6) + 1,
  fullHash: `h${i}`,
  embedding: [24 - i, i],
}));

type PlanReply = Partial<SearchPlan> | { code: string };

/** Fixed here so a change of the app's cuts never moves a test. */
export const testTuning: SearchTuning = { ...SEARCH_TUNING, thresholds: { text: 0.5, reference: null, both: 0.5 } };

export function setup(options: {
  sounds?: SearchSound[];
  plan?: (request: SearchPlanRequest) => PlanReply | Promise<PlanReply>;
  phrase?: SearchPlatform['phrase'];
  embed?: (s: readonly string[]) => Vector[];
  analysing?: () => boolean;
  tuning?: SearchTuning;
  reducedMotion?: ChatStoreOptions['reducedMotion'];
} = {}) {
  const requests: SearchPlanRequest[] = [];
  const embedded: string[][] = [];
  const logs: Record<string, unknown>[] = [];
  let downloadListener: ((state: DownloadState | undefined) => void) | undefined;
  let sounds = options.sounds ?? library;
  const platform: SearchPlatform = {
    position: () => undefined,
    duration: () => undefined,
    setGain() {},
    loadSounds: async () => sounds,
    phrase: options.phrase,
    log: (entry) => { logs.push(entry); },
    async plan(request) {
      requests.push(structuredClone(request));
      const reply = await options.plan?.(request) ?? {};
      if ('code' in reply) throw reply;
      return { sentences: ['a laser'], names: [], message: '레이저 소리를 찾았어요.', ...reply };
    },
    async embedText(list) {
      embedded.push([...list]);
      return options.embed ? options.embed(list) : list.map(() => [1, 0]);
    },
    importReference: vi.fn(),
    play: vi.fn(),
    stop: vi.fn(),
    onDownload(listener) {
      downloadListener = listener;
      return () => { downloadListener = undefined; };
    },
  };
  let id = 0;
  const store = createChatStore({ platform, sounds: () => sounds, analysing: options.analysing, reducedMotion: options.reducedMotion, tuning: options.tuning ?? testTuning, newId: () => `id${++id}` });
  return {
    store, requests, embedded, logs,
    setSounds(next: SearchSound[]) { sounds = next; },
    download(state: DownloadState | undefined) { downloadListener?.(state); },
  };
}

export const answers = (store: ChatStore): ChatAnswer[] => store.getState().tabs
  .find((tab) => tab.id === store.getState().activeTabId)!.messages
  .filter((message): message is ChatAnswer => message.kind === 'answer');
export const last = (store: ChatStore) => answers(store).at(-1)!;
export const ids = (answer: ChatAnswer) => answer.results.map(({ sound }) => sound.id);
export const allShown = (store: ChatStore) => answers(store).flatMap(ids);

export const facts: PhraseFacts = {
  count: 3, requested_count: 3, packs: [{ name: 'pack0', count: 3 }], main_pack: null,
  length_range: '1.00-3.00초', length_condition: null, first_file: 'laser_shot0.wav',
  is_low_score: false, has_reference: false, reference_pack_avoided: false,
  is_refinement: false, changed: null, more_available: true, is_short: false,
  already_shown_excluded: false, removed_by_length: 0,
};
