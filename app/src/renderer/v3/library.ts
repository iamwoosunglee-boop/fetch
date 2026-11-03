import { textMatch, tokenize, type SearchSound } from '../../core/search';
import { inCollection, type Collection } from '../../core/collections';
import { readUcsName } from '../../core/classify';
import type { PackDetails, PackFacts } from '../../core/packs';
import { fileName, packCode, packNameOf, shortPackNames } from './format';

export type LengthBucket = 'short' | 'mid' | 'long';
export type SortKey = 'pack' | 'name' | 'length' | 'recent';

export interface SecondsRange {
  min?: number;
  max?: number;
}

export interface Filters {
  packs: ReadonlySet<string>;
  kinds: ReadonlySet<string>;
  length?: LengthBucket;
  /** Typed seconds, kept exactly: the 10% margin belongs to the chat's conditions only. */
  range?: SecondsRange;
  favorites: boolean;
  query: string;
}

export interface PackInfo extends PackFacts {
  id: string;
  /** The short name every row shows. */
  name: string;
  /** The folder name as it is on disk. */
  full: string;
  code: string;
  tone: number;
  count: number;
  cover?: string;
  licenseFile?: boolean;
}

export const UNCLASSIFIED = '미분류';

export const lengthBuckets: { id: LengthBucket; label: string; test: (seconds: number) => boolean }[] = [
  { id: 'short', label: '0.5초 이하', test: (value) => value > 0 && value <= 0.5 },
  { id: 'mid', label: '0.5초에서 2초', test: (value) => value > 0.5 && value < 2 },
  { id: 'long', label: '2초 이상', test: (value) => value >= 2 },
];

export function rangeLabel({ min, max }: SecondsRange): string {
  if (min !== undefined && max !== undefined) return `${min}-${max}초`;
  return min !== undefined ? `${min}초 이상` : `${max}초 이하`;
}

export const sortLabels: Record<SortKey, string> = { pack: '팩순', name: '이름순', length: '길이순', recent: '최근 추가순' };

/** Identical files are one sound in the list; the first reachable path wins and every pack stays known. */
export function uniqueSounds(rows: readonly SearchSound[]): SearchSound[] {
  const kept = new Map<string, SearchSound>();
  for (const row of rows) {
    const key = row.fullHash ?? row.id;
    const existing = kept.get(key);
    kept.set(key, {
      ...(!existing || (existing.blockedReason && !row.blockedReason) ? row : existing),
      packIds: [...new Set([...(existing?.packIds ?? []), row.packId])],
      mergedIds: [...new Set([...(existing?.mergedIds ?? []), row.id])],
    });
  }
  return [...kept.values()];
}

/** Counts raw rows: a sound that lives in two packs counts in both, though the list shows it once. */
export function describePacks(rows: readonly SearchSound[], details: ReadonlyMap<string, PackDetails> = new Map()): Map<string, PackInfo> {
  const found = new Map<string, { full: string; content: Set<string> }>();
  for (const row of rows) {
    const entry = found.get(row.packId) ?? { full: packNameOf(row), content: new Set() };
    entry.content.add(row.fullHash ?? row.id);
    found.set(row.packId, entry);
  }
  const ordered = [...found.entries()].sort((a, b) => a[1].full.localeCompare(b[1].full));
  const names = shortPackNames(ordered.map(([id, { full }]) => ({ full, name: details.get(id)?.name })));
  return new Map(ordered.map(([id, { full, content }], index) => [id, {
    ...details.get(id), id, name: names[index], full, code: packCode(names[index]), tone: index % 8, count: content.size,
  }]));
}

export function categoryOf(sound: SearchSound, categories: ReadonlyMap<string, string>): string {
  return (sound.fullHash && categories.get(sound.fullHash)) || readUcsName(fileName(sound.relativePath)) || UNCLASSIFIED;
}

/** The search box: whole words, except the last one, which the person may still be typing. */
function typedMatch(relativePath: string, query: string): boolean {
  const words = tokenize(relativePath);
  const typed = tokenize(query);
  const last = typed.pop();
  return last !== undefined && typed.every((word) => words.includes(word)) && words.some((word) => word.startsWith(last));
}

export function applyFilters(
  sounds: readonly SearchSound[],
  filters: Filters,
  categories: ReadonlyMap<string, string>,
  favorites: ReadonlySet<string>,
  collection?: Collection,
): SearchSound[] {
  const query = filters.query.trim();
  const bucket = lengthBuckets.find((item) => item.id === filters.length);
  const quoted = /^"(.*)"$/.exec(query)?.[1];
  return sounds.filter((sound) =>
    (!collection || inCollection(collection, sound))
    && (!filters.packs.size || (sound.packIds ?? [sound.packId]).some((pack) => filters.packs.has(pack)))
    && (!filters.kinds.size || filters.kinds.has(categoryOf(sound, categories)))
    && (!bucket || bucket.test(sound.duration))
    && (!filters.range || sound.duration > 0)
    && (filters.range?.min === undefined || sound.duration >= filters.range.min)
    && (filters.range?.max === undefined || sound.duration <= filters.range.max)
    && (!filters.favorites || Boolean(sound.fullHash && favorites.has(sound.fullHash)))
    && (!query || (quoted === undefined ? typedMatch(sound.relativePath, query) : textMatch(sound.relativePath, quoted))));
}

const clock = (value: number) => (value >= 60 ? `${Math.floor(value / 60)}분 ${Math.round(value % 60)}초` : `${Math.round(value)}초`);

/** Only sounds with a known length count in the sum and the range; the count says how many that is. */
export function packSummary(sounds: readonly SearchSound[]): string {
  const lengths = sounds.map((sound) => sound.duration).filter((value) => value > 0);
  const count = `소리 ${sounds.length.toLocaleString('ko-KR')}개`;
  if (!lengths.length) return `${count}, 분석 중`;
  const known = lengths.length === sounds.length ? count : `${count} / 길이 확인 ${lengths.length.toLocaleString('ko-KR')}개`;
  const shortest = Math.min(...lengths).toFixed(2);
  const longest = Math.max(...lengths).toFixed(2);
  return `${known}, 합계 ${clock(lengths.reduce((sum, value) => sum + value, 0))}, ${lengths.length === 1 ? shortest : `${shortest}-${longest}`}초`;
}

export function topKinds(sounds: readonly SearchSound[], categories: ReadonlyMap<string, string>): [string, number][] {
  const counts = new Map<string, number>();
  for (const sound of sounds) {
    const category = categoryOf(sound, categories);
    if (category !== UNCLASSIFIED) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
}

export function sortSounds(sounds: SearchSound[], key: SortKey, packs: ReadonlyMap<string, PackInfo>): SearchSound[] {
  const name = (sound: SearchSound) => fileName(sound.relativePath);
  const compareName = (a: SearchSound, b: SearchSound) => name(a).localeCompare(name(b), undefined, { numeric: true });
  const sorters: Record<SortKey, (a: SearchSound, b: SearchSound) => number> = {
    pack: (a, b) => (packs.get(a.packId)?.full ?? '').localeCompare(packs.get(b.packId)?.full ?? '') || compareName(a, b),
    name: compareName,
    length: (a, b) => a.duration - b.duration || compareName(a, b),
    recent: (a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0) || compareName(a, b),
  };
  return sounds.sort(sorters[key]);
}
