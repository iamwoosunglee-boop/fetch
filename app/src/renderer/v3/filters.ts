import type { SearchSound } from '../../core/search';
import { KOREAN_NAMES } from '../../core/classify/labels';
import { h, imeKey } from './dom';
import { icon } from './icons';
import { applyFilters, categoryOf, lengthBuckets, rangeLabel, sortLabels, UNCLASSIFIED, type Filters, type SortKey } from './library';
import { closeMenu, menuItem, popover } from './menus';
import { navigate, releaseChips } from './navigation';
import { app, favorites, sortKey, state } from './state';

const check = () => h('span', { class: 'ck' }, icon('check', 16));
const count = (value: number) => h('span', { class: 'num c', text: value.toLocaleString('ko-KR') });

export const routeCollection = () => {
  const { route } = state;
  return route.view === 'collection' ? state.collections.collections.find((item) => item.id === route.id) : undefined;
};

function routeFilters(): Pick<Filters, 'packs' | 'favorites'> {
  const { route } = state;
  return {
    packs: route.view === 'pack' ? new Set([route.id]) : new Set<string>(),
    favorites: route.view === 'favorites',
  };
}

const applied = (): Filters => {
  const route = routeFilters();
  return { ...state.filters, packs: route.packs.size ? route.packs : state.filters.packs, favorites: route.favorites || state.filters.favorites };
};

const sounds = (filters: Filters) => applyFilters(state.sounds, filters, state.categories, favorites(), routeCollection());

export const filteredSounds = (): SearchSound[] => sounds(applied());
export const scopeSounds = (): SearchSound[] => sounds({ ...routeFilters(), kinds: new Set(), query: '' });
/** The search alone finds something here, whatever the filter chips then leave of it. */
export const searchFinds = () => sounds({ ...routeFilters(), kinds: new Set(), query: state.filters.query }).length > 0;

export const anyFilter = () => {
  const { filters } = state;
  return Boolean(filters.packs.size || filters.kinds.size || filters.length || filters.range || filters.favorites);
};
export const narrowed = () => anyFilter() || Boolean(state.filters.query.trim());

/** Result and whole-scope counts in the words of the head: the two numbers stay apart so a check can read each. */
export function countLabel(results: number): HTMLElement {
  const whole = scopeSounds().length.toLocaleString('ko-KR');
  if (!narrowed()) return h('span', { class: 'count' }, '소리 ', h('span', { class: 'num total', text: whole }), '개');
  return h('span', { class: 'count' }, '결과 ', h('span', { class: 'num result', text: results.toLocaleString('ko-KR') }), '개 / 전체 ', h('span', { class: 'num total', text: whole }), '개');
}

const kindName = (category: string) => category === UNCLASSIFIED ? UNCLASSIFIED : `${KOREAN_NAMES[category] ?? category} ${category}`;

const chipOff = (label: string, open: (event: MouseEvent) => void) =>
  h('button', { class: 'chip', type: 'button', on: { click: open } }, label, icon('chev', 14));

const chipOn = (label: string, open: (event: MouseEvent) => void, release: () => void) => h('span', { class: 'chip on' },
  h('button', { class: 'chip-b', type: 'button', text: label, on: { click: open } }),
  h('button', { class: 'chip-x', type: 'button', attrs: { 'aria-label': `${label} 필터 해제` }, on: { click: () => navigate(release) } }, icon('x', 13)));

const opener = (show: (anchor: HTMLElement) => void) => (event: MouseEvent) => {
  const target = event.currentTarget as HTMLElement;
  show(target.closest<HTMLElement>('.chip') ?? target);
};

function lengthLabel(): string {
  const { length, range } = state.filters;
  return range ? rangeLabel(range) : lengthBuckets.find((bucket) => bucket.id === length)?.label ?? '길이';
}

/** Without a count there is no library yet: nothing to count and nothing to filter. */
export function filterBar(results?: number): HTMLElement {
  const { filters, route } = state;
  const packLabel = filters.packs.size === 1 ? state.packs.get([...filters.packs][0])?.name ?? '팩' : `팩 ${filters.packs.size}개`;
  const kindLabel = filters.kinds.size === 1 ? kindName([...filters.kinds][0]) : `종류 ${filters.kinds.size}개`;
  const hasLength = Boolean(filters.length || filters.range);
  const packChip = filters.packs.size ? chipOn(packLabel, opener(openPackMenu), () => filters.packs.clear()) : chipOff('팩', opener(openPackMenu));
  const kindChip = filters.kinds.size ? chipOn(kindLabel, opener(openKindMenu), () => filters.kinds.clear()) : chipOff('종류', opener(openKindMenu));
  const lengthChip = hasLength
    ? chipOn(lengthLabel(), opener(openLengthMenu), () => { filters.length = undefined; filters.range = undefined; })
    : chipOff('길이', opener(openLengthMenu));
  const favoriteChip = h('button', {
    class: `chip plain${filters.favorites ? ' on' : ''}`, type: 'button', text: '즐겨찾기', attrs: { 'aria-pressed': String(filters.favorites) },
    on: { click: () => navigate(() => { filters.favorites = !filters.favorites; }) },
  });
  const sort = h('button', { class: 'sort', type: 'button', on: { click: (event) => openSortMenu(event.currentTarget as HTMLElement) } }, icon('sort', 14), h('span', { text: sortLabels[sortKey()] }));
  const clearAll = anyFilter() && results ? h('button', { class: 'clear-all', type: 'button', on: { click: () => navigate(releaseChips) } }, '모두 해제', icon('x', 13)) : null;
  return h('div', { class: `filters${results === undefined ? ' dim' : ''}`, attrs: { inert: results === undefined } },
    route.view === 'pack' ? null : packChip, kindChip, lengthChip, favoriteChip, clearAll, sort);
}

function openPackMenu(anchor: HTMLElement): void {
  const inOthers = sounds({ ...applied(), packs: new Set() });
  const packs = [...state.packs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const within = (id: string) => inOthers.filter((sound) => (sound.packIds ?? [sound.packId]).includes(id)).length;
  popover(anchor, 'pop', packs.map((pack) => menuItem(pack.name, () => navigate(() => {
    if (state.filters.packs.has(pack.id)) state.filters.packs.delete(pack.id); else state.filters.packs.add(pack.id);
  }), count(within(pack.id)), state.filters.packs.has(pack.id) ? check() : undefined, pack.full)));
}

function openKindMenu(anchor: HTMLElement): void {
  const counts = new Map<string, number>();
  for (const sound of sounds({ ...applied(), kinds: new Set() })) {
    const category = categoryOf(sound, state.categories);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const row = (category: string, amount: number) => menuItem(
    h('span', {}, h('span', { text: category === UNCLASSIFIED ? UNCLASSIFIED : `${KOREAN_NAMES[category] ?? category} ` }), category === UNCLASSIFIED ? '' : h('span', { class: 'c', text: category })),
    () => navigate(() => { if (state.filters.kinds.has(category)) state.filters.kinds.delete(category); else state.filters.kinds.add(category); }),
    count(amount), state.filters.kinds.has(category) ? check() : undefined);
  const named = [...counts].filter(([category]) => category !== UNCLASSIFIED).sort((a, b) => b[1] - a[1]);
  const unclassified = counts.get(UNCLASSIFIED);
  // First, where a large library's largest group is still in reach without scrolling.
  const items: HTMLElement[] = unclassified === undefined ? [] : [row(UNCLASSIFIED, unclassified), ...(named.length ? [h('hr')] : [])];
  items.push(...named.map(([category, amount]) => row(category, amount)));
  popover(anchor, 'pop', items.length ? items : [h('p', { class: 'c', text: '소리가 없습니다.' })]);
}

function typedSeconds(input: HTMLInputElement): number | undefined {
  const typed = input.value.trim().replace(',', '.');
  return typed ? Number(typed) : undefined;
}

function openLengthMenu(anchor: HTMLElement): void {
  const { filters } = state;
  const inOthers = sounds({ ...applied(), length: undefined, range: undefined });
  const secondsInput = (label: string, value?: number) => {
    const input = h('input', { attrs: { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': label } });
    input.value = value === undefined ? '' : String(value);
    return { input, field: h('label', {}, label, input) };
  };
  const min = secondsInput('최소(초)', filters.range?.min);
  const max = secondsInput('최대(초)', filters.range?.max);
  // While lengths are unknown a 0 would say there are none.
  const unknown = inOthers.some((sound) => !sound.duration);
  const amount = (bucket: (typeof lengthBuckets)[number]) => {
    const found = inOthers.filter((sound) => bucket.test(sound.duration)).length;
    return found || !unknown ? count(found) : undefined;
  };
  const apply = (event: SubmitEvent) => {
    event.preventDefault();
    const low = typedSeconds(min.input);
    const high = typedSeconds(max.input);
    const bad = (value?: number) => value !== undefined && !(value >= 0);
    const crossed = low !== undefined && high !== undefined && low > high;
    min.input.toggleAttribute('aria-invalid', bad(low) || crossed);
    max.input.toggleAttribute('aria-invalid', bad(high) || crossed);
    if (bad(low) || bad(high) || crossed) return;
    closeMenu();
    app.focusList();
    navigate(() => {
      filters.length = undefined;
      filters.range = low === undefined && high === undefined ? undefined : { min: low, max: high };
    });
  };
  const form = h('form', { class: 'len', on: { submit: apply, keydown: (event) => { if (imeKey(event) && event.key === 'Enter') event.preventDefault(); } } },
    min.field, max.field, h('button', { class: 'primary sm', type: 'submit', text: '적용' }));
  popover(anchor, 'pop', [...lengthBuckets.map((bucket) => menuItem(bucket.label, () => navigate(() => {
    filters.length = filters.length === bucket.id ? undefined : bucket.id;
    filters.range = undefined;
  }), amount(bucket), filters.length === bucket.id ? check() : undefined)), h('hr'), form]);
}

function openSortMenu(anchor: HTMLElement): void {
  const inPack = state.route.view === 'pack';
  const keys = (Object.keys(sortLabels) as SortKey[]).filter((key) => !inPack || key !== 'pack');
  popover(anchor, 'pop', keys.map((key) => menuItem(sortLabels[key], () => navigate(() => {
    if (inPack) state.packSort = key; else state.sort = key;
  }), undefined, sortKey() === key ? check() : undefined)));
}
