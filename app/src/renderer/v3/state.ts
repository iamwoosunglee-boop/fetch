import { electronPlatform } from '../../platform/electron';
import { webPlatform } from '../../platform/web';
import type { FileTrackingView, LibraryConnection, Platform } from '../../platform/types';
import type { SearchSound } from '../../core/search';
import type { CollectionData } from '../../core/collections';
import type { DownloadState } from '../../model/download';
import type { ChatHandle } from './chat';
import { seconds } from './format';
import type { Filters, PackInfo, SortKey } from './library';

export const platform: Platform = window.fetchApp?.kind === 'electron' ? electronPlatform : webPlatform;
export const web = platform.kind === 'web';
const AUTOPLAY_KEY = 'autoplay';

export type Route = { view: 'all' } | { view: 'favorites' } | { view: 'collection'; id: string } | { view: 'packs' } | { view: 'pack'; id: string } | { view: 'settings' };

export const state = {
  sounds: [] as SearchSound[],
  folders: [] as LibraryConnection[],
  loaded: false,
  collections: { collections: [], searches: [] } as CollectionData,
  categories: new Map<string, string>(),
  packs: new Map<string, PackInfo>(),
  route: { view: 'all' } as Route,
  filters: { packs: new Set<string>(), kinds: new Set<string>(), favorites: false, query: '' } as Filters & { packs: Set<string>; kinds: Set<string> },
  sort: 'pack' as SortKey,
  packSort: 'name' as SortKey,
  visible: [] as SearchSound[],
  selectedId: undefined as string | undefined,
  tracking: undefined as FileTrackingView | undefined,
  navOpen: false,
  chatOpen: false,
  narrow: false,
  cover: false,
  autoplay: localStorage.getItem(AUTOPLAY_KEY) !== 'off',
  models: 'idle' as 'idle' | 'loading' | 'failed',
  download: undefined as DownloadState | undefined,
  error: '',
};

export const sortKey = () => state.route.view === 'pack' ? state.packSort : state.sort;

export function saveAutoplay(): void {
  localStorage.setItem(AUTOPLAY_KEY, state.autoplay ? 'on' : 'off');
}

export const favorites = () => new Set(state.collections.favorites ?? []);
export const analysing = () => state.folders.some((folder) => folder.status === 'scanning' || folder.status === 'indexing');
export const soundById = (id: string) => state.sounds.find((sound) => sound.id === id || sound.mergedIds?.includes(id));

/** The length column. Only a finished folder knows that a sound without a length could not be read. */
export function lengthText(sound: SearchSound): string {
  if (sound.duration) return seconds(sound.duration);
  const folder = state.folders.find(({ root }) => root === sound.root);
  return folder?.status === 'completed' && folder.failed ? '읽지 못함' : '';
}

/** A line in the local search log, tied to the answer that showed the sound. */
export function logSound(event: 'play' | 'drag' | 'collection', sound: SearchSound): void {
  platform.search?.log?.({
    event, answerId: app.chat?.answerOf(sound) ?? null, timestamp: new Date().toISOString(),
    path: sound.root ? `${sound.root}/${sound.relativePath}` : sound.relativePath,
  });
}

/** What the parts of the screen ask of each other; main.ts fills these in, so the parts never import it. */
export const app = {
  render(_place?: { scrollTop: number }): void {},
  refreshList(): void {},
  reveal(_sound: SearchSound): void {},
  focusList(): void {},
  nameCollection(_sound?: SearchSound): void {},
  showError(_message: string): void {},
  chat: undefined as ChatHandle | undefined,
};
