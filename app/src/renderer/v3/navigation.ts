import { h, iconButton, imeKey } from './dom';
import { createHistory, searchBatch } from './history';
import { icon } from './icons';
import type { Filters, SortKey } from './library';
import { app, soundById, state, type Route } from './state';

interface Place {
  route: Route;
  query: string;
  packs: string[];
  kinds: string[];
  favorites: boolean;
  length: Filters['length'];
  range: Filters['range'];
  sort: SortKey;
  packSort: SortKey;
  selectedId?: string;
  scrollTop: number;
}

const place = (scrollTop = 0): Place => ({
  route: state.route, query: state.filters.query, packs: [...state.filters.packs], kinds: [...state.filters.kinds],
  favorites: state.filters.favorites, length: state.filters.length, range: state.filters.range,
  sort: state.sort, packSort: state.packSort, selectedId: state.selectedId, scrollTop,
});

const view = ({ selectedId: _selected, scrollTop: _scroll, ...rest }: Place) => JSON.stringify(rest);
const history = createHistory<Place>(place(), (a, b) => view(a) === view(b));

function usable({ route }: Place): boolean {
  if (route.view === 'collection') return state.collections.collections.some((collection) => collection.id === route.id);
  return route.view !== 'pack' || state.packs.has(route.id);
}

const scroller = () => document.querySelector<HTMLElement>('.library .list, .library .packs, .library .set');

function keepPlace(): void {
  // A word typed on a screen without a list left that step behind, and its place was kept as it left.
  if (history.current().route !== state.route) return;
  history.replace({ ...history.current(), selectedId: state.selectedId, scrollTop: scroller()?.scrollTop ?? 0 });
}

export const searchInput = h('input', { class: 'search-input', attrs: { type: 'search', placeholder: '파일 이름 검색', 'aria-label': '파일 이름 검색', spellcheck: 'false' } });
export const searchBox = h('label', { class: 'search' }, icon('search', 15), searchInput);

const batch = searchBatch(() => {
  keepPlace();
  history.push(place());
  syncHistory();
});

searchInput.addEventListener('input', () => {
  if (searchInput.value.trim() && ['packs', 'settings'].includes(state.route.view)) {
    keepPlace();
    state.route = { view: 'all' };
  }
  state.filters.query = searchInput.value;
  batch.typed();
  app.render();
  searchInput.focus();
});
searchInput.addEventListener('compositionstart', batch.compositionStart);
searchInput.addEventListener('compositionend', batch.compositionEnd);
searchInput.addEventListener('blur', batch.blur);
searchInput.addEventListener('keydown', (event) => {
  if (!imeKey(event) && event.key === 'Enter') batch.settle();
});

/** One step back in time starts here: whatever is typed settles first, and where the person was stays with the old step. */
export function navigate(change: () => void): void {
  batch.settle();
  keepPlace();
  change();
  history.push(place());
  app.render({ scrollTop: 0 });
}

export function releaseChips(): void {
  state.filters.packs.clear();
  state.filters.kinds.clear();
  state.filters.length = undefined;
  state.filters.range = undefined;
  state.filters.favorites = false;
}

export function releaseFilters(): void {
  releaseChips();
  state.filters.query = '';
  searchInput.value = '';
}

export function openPack(id: string): void {
  navigate(() => {
    releaseFilters();
    state.route = { view: 'pack', id };
    if (state.cover) {
      state.navOpen = false;
      state.chatOpen = false;
    }
  });
}

function travel(step: -1 | 1): void {
  batch.settle();
  keepPlace();
  const entry = history.go(step, usable);
  if (!entry) return;
  state.route = entry.route;
  state.filters.query = entry.query;
  searchInput.value = entry.query;
  state.filters.packs = new Set(entry.packs.filter((id) => state.packs.has(id)));
  state.filters.kinds = new Set(entry.kinds);
  state.filters.favorites = entry.favorites;
  state.filters.length = entry.length;
  state.filters.range = entry.range;
  state.sort = entry.sort;
  state.packSort = entry.packSort;
  state.selectedId = entry.selectedId && soundById(entry.selectedId) ? entry.selectedId : undefined;
  app.render({ scrollTop: entry.scrollTop });
}

export const backButton = iconButton(icon('chevL', 18), '뒤로', () => travel(-1));
export const forwardButton = iconButton(icon('chevR', 18), '앞으로', () => travel(1));

export function syncHistory(): void {
  backButton.disabled = !history.canGo(-1, usable);
  forwardButton.disabled = !history.canGo(1, usable);
}
